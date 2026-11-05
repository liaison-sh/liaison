// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { type RlsClient, sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { WebSocketManager } from "~/infra/websocket"
import { setUserScopes } from "~/modules/permissions/app-grants"
import * as grantInvalidation from "~/services/security/grant-invalidation"
import { resolveGrantInvalidations } from "~/services/security/grant-invalidation"

// `setUserScopes` must run inside a REAL transaction: `__privileged_db__` is a
// raw pool handle that does not carry `queueEvent`, while every production
// caller (withRlsContext / withPrivilegedDb / withSystemDb) does.
async function setUserScopesInTx(args: Parameters<typeof setUserScopes>[1]): Promise<void> {
  await withSystemDb("grant-invalidation-test-set-scopes", async (tx) => {
    await setUserScopes(tx as unknown as RlsClient, args)
  })
}

const ORG = "00000000-0000-0000-0000-0000000021d1"
const USER_U = "00000000-0000-0000-0000-0000000021d2"
const USER_V = "00000000-0000-0000-0000-0000000021d3"
const USER_EMPTY = "00000000-0000-0000-0000-0000000021d4"
const THREAD_SHARED = "00000000-0000-0000-0000-0000000021a1"
const THREAD_U_ONLY = "00000000-0000-0000-0000-0000000021a2"
const THREAD_V_ONLY = "00000000-0000-0000-0000-0000000021a3"

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'GrantInvalidationOrg', 'grant-invalidation-org') ON CONFLICT DO NOTHING`
  for (const [id, email] of [
    [USER_U, "gi-u@t.com"],
    [USER_V, "gi-v@t.com"],
    [USER_EMPTY, "gi-empty@t.com"],
  ]) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG}, ${email}, ${email}) ON CONFLICT DO NOTHING`
  }
  for (const [id, handle] of [
    [THREAD_SHARED, "gi-shared"],
    [THREAD_U_ONLY, "gi-u-only"],
    [THREAD_V_ONLY, "gi-v-only"],
  ]) {
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by) VALUES (${id}, ${ORG}, ${handle}, ${USER_U}) ON CONFLICT DO NOTHING`
  }
  for (const [threadId, userId] of [
    [THREAD_SHARED, USER_U],
    [THREAD_SHARED, USER_V],
    [THREAD_U_ONLY, USER_U],
    [THREAD_V_ONLY, USER_V],
  ]) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${threadId}, ${userId}, ${ORG}) ON CONFLICT DO NOTHING`
  }
})

afterAll(async () => {
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.app_scope_grant_audit WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

// The delivery side takes its targets from the event and reads the rest from
// the database, for the users the CALLING process has connected. It keeps
// nothing between calls, so these are pure functions of (event, connected set).
describe("resolveGrantInvalidations", () => {
  it("resolves a per user event to that user's own participated thread ids", async () => {
    expect(
      await resolveGrantInvalidations(
        { entity: "user_scope", orgId: ORG, data: { targetUserId: USER_U } },
        [USER_U, USER_V],
      ),
    ).toEqual([{ userId: USER_U, threadIds: [THREAD_SHARED, THREAD_U_ONLY] }])
  })

  it("resolves nothing for a user this process has not connected", async () => {
    expect(
      await resolveGrantInvalidations(
        { entity: "user_scope", orgId: ORG, data: { targetUserId: USER_U } },
        [USER_V],
      ),
    ).toEqual([])
  })

  it("a user with no participated threads resolves to an empty id list", async () => {
    expect(
      await resolveGrantInvalidations(
        { entity: "user_scope", orgId: ORG, data: { targetUserId: USER_EMPTY } },
        [USER_EMPTY],
      ),
    ).toEqual([{ userId: USER_EMPTY, threadIds: [] }])
  })

  it("fails closed on a permission event that names neither a user nor a role", async () => {
    expect(
      await resolveGrantInvalidations({ entity: "user_scope", orgId: ORG, data: {} }, [
        USER_U,
        USER_V,
      ]),
    ).toEqual([])
  })
})

// Delivery depends only on the queued kernel permission event: it carries the
// target (`data.targetUserId`), and `resolveGrantInvalidations` resolves the
// rest from the database at delivery time. `setUserScopes` therefore must
// carry its own event, exactly like the role and user grant paths in
// roles.ts, or the invalidation never reaches the target user.
describe("setUserScopes carries its own permission event for the outbox drain", () => {
  const APP = "gifx5"

  interface FakeWs {
    sent: string[]
    send: (data: string) => void
    close: () => void
    readyState: number
  }

  function openWs(): FakeWs {
    const sent: string[] = []
    return {
      sent,
      send: (data: string) => {
        sent.push(data)
      },
      close: () => {},
      readyState: 1,
    }
  }

  function invalidatesOf(ws: FakeWs): Array<Record<string, unknown>> {
    return ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === "visibility:invalidate")
  }

  // Only the handful of commands bufferAndBroadcast touches; the in-memory
  // connection backend keeps the sockets themselves local to the manager.
  const fakeRedis = {
    zadd: async () => 0,
    // The replay buffer append (websocket-replay-buffer.ts) is one Lua script.
    eval: async () => 0,
    zrangebyscore: async () => [] as string[],
    expire: async () => 1,
    incr: async () => 1,
    exists: async () => 1,
    get: async () => null,
    set: async () => "OK",
    del: async () => 0,
  }

  async function queuedPermissionEvents(userId: string): Promise<Array<Record<string, any>>> {
    const rows = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${ORG}
        AND payload->>'app' = 'kernel'
        AND payload->>'entity' = 'user_scope'
        AND payload->'data'->>'targetUserId' = ${userId}
      ORDER BY created_at`
    return rows.map((r: any) => r.payload)
  }

  beforeEach(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  })

  it("queues a kernel user_scope event naming the target user when the grant set changes", async () => {
    await setUserScopesInTx({
      orgId: ORG,
      callingApp: APP,
      userId: USER_U,
      scopes: [`${APP}:items:read`],
    })
    const events = await queuedPermissionEvents(USER_U)
    expect(events).toHaveLength(1)
    expect(events[0].app).toBe("kernel")
    expect(events[0].entity).toBe("user_scope")
    expect(events[0].orgId).toBe(ORG)
    expect(events[0].data.targetUserId).toBe(USER_U)
  })

  it("queues no event for a no op call that changes nothing", async () => {
    const args = {
      orgId: ORG,
      callingApp: APP,
      userId: USER_U,
      scopes: [`${APP}:items:read`],
    }
    await setUserScopesInTx(args)
    await setUserScopesInTx(args)
    expect(await queuedPermissionEvents(USER_U)).toHaveLength(1)
  })

  it("queues a revoke event naming the target user when the grant set shrinks to empty", async () => {
    await setUserScopesInTx({
      orgId: ORG,
      callingApp: APP,
      userId: USER_U,
      scopes: [`${APP}:items:read`],
    })
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await setUserScopesInTx({ orgId: ORG, callingApp: APP, userId: USER_U, scopes: [] })
    const events = await queuedPermissionEvents(USER_U)
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe("revoke")
    expect(events[0].data.targetUserId).toBe(USER_U)
  })

  it("the drain delivers the invalidate to that user's own sockets only", async () => {
    const vm = new WebSocketManager(fakeRedis as any)
    const own1 = openWs()
    const own2 = openWs()
    const other = openWs()
    vm.addConnection(USER_U, own1 as any, ["kernel"], ORG)
    vm.addConnection(USER_U, own2 as any, ["kernel"], ORG)
    vm.addConnection(USER_V, other as any, ["kernel"], ORG)

    await setUserScopesInTx({
      orgId: ORG,
      callingApp: APP,
      userId: USER_U,
      scopes: [`${APP}:items:read`],
    })

    const [payload] = await queuedPermissionEvents(USER_U)
    expect(payload).toBeDefined()
    await vm.bufferAndBroadcast(payload as any)

    // That user's own threads, on that user's own sockets, and nowhere else.
    expect(invalidatesOf(own1)).toEqual([
      { type: "visibility:invalidate", threadIds: [THREAD_SHARED, THREAD_U_ONLY] },
    ])
    expect(invalidatesOf(own2)).toHaveLength(1)
    expect(invalidatesOf(other)).toHaveLength(0)
  })

  it("the event is not visible outside the grant transaction until it commits", async () => {
    let midTx: unknown[] = []
    await withSystemDb("fx5-post-commit", async (tx) => {
      await setUserScopes(tx as unknown as RlsClient, {
        orgId: ORG,
        callingApp: APP,
        userId: USER_U,
        scopes: [`${APP}:items:read`],
      })
      // A SEPARATE connection cannot see the outbox row while the grant
      // transaction is still open: that is what makes the drain post-commit.
      midTx = await queuedPermissionEvents(USER_U)
    })
    expect(midTx).toHaveLength(0)
    expect(await queuedPermissionEvents(USER_U)).toHaveLength(1)
  })
})

// The delivery path must hold NO state between calls. Everything it needs is on
// the queued permission event (`data.targetUserId` for a per-user grant,
// `data.roleId` for a role-level one) plus the database, so ANY process can
// serve the event for the users IT has connected. This block uses its own org,
// users and role precisely so that nothing another test in this file emitted
// can be sitting in a process-local store and make the delivery look correct.
describe("a permission event is delivered by any process, with no retained state", () => {
  const FX8_ORG = "00000000-0000-0000-0000-00000000f800"
  const FX8_U = "00000000-0000-0000-0000-00000000f801"
  const FX8_V = "00000000-0000-0000-0000-00000000f802"
  const FX8_W = "00000000-0000-0000-0000-00000000f803"
  const FX8_ROLE = "00000000-0000-0000-0000-00000000f8b1"
  const FX8_SHARED = "00000000-0000-0000-0000-00000000f8a1"
  const FX8_U_ONLY = "00000000-0000-0000-0000-00000000f8a2"
  const FX8_V_ONLY = "00000000-0000-0000-0000-00000000f8a3"
  const INVALIDATE = "visibility:invalidate"

  interface FakeWs {
    sent: string[]
    send: (data: string) => void
    close: () => void
    readyState: number
  }

  function openWs(): FakeWs {
    const sent: string[] = []
    return {
      sent,
      send: (data: string) => {
        sent.push(data)
      },
      close: () => {},
      readyState: 1,
    }
  }

  function invalidatesOf(ws: FakeWs): Array<Record<string, unknown>> {
    return ws.sent
      .map((raw) => JSON.parse(raw) as Record<string, unknown>)
      .filter((frame) => frame.type === INVALIDATE)
  }

  const fakeRedis = {
    zadd: async () => 0,
    // The replay buffer append (websocket-replay-buffer.ts) is one Lua script.
    eval: async () => 0,
    zrangebyscore: async () => [] as string[],
    expire: async () => 1,
    incr: async () => 1,
    exists: async () => 1,
    get: async () => null,
    set: async () => "OK",
    del: async () => 0,
  }

  /**
   * The shape a permission event has when it reaches THIS process from another
   * one: the origin process's outbox published it, the Redis subscriber handed
   * it over, and `event-subscribers.ts` calls `bufferAndBroadcast` with
   * `shouldBuffer` false because the origin owns the replay buffer. Nothing in
   * this process ever recorded the grant, so a delivery that depends on
   * in-process state from the grant call finds nothing here.
   */
  async function deliverFromAnotherProcess(
    vm: WebSocketManager,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await vm.bufferAndBroadcast(payload as any, undefined, false)
  }

  function userScopeEvent(targetUserId: string): Record<string, unknown> {
    return {
      app: "kernel",
      entity: "user_scope",
      action: "grant",
      entityId: targetUserId,
      orgId: FX8_ORG,
      data: { targetUserId, scope: "gifx8:items:read" },
    }
  }

  function roleScopeEvent(): Record<string, unknown> {
    return {
      app: "kernel",
      entity: "role_scope",
      action: "grant",
      entityId: FX8_ROLE,
      orgId: FX8_ORG,
      data: { roleId: FX8_ROLE, scope: "gifx8:items:read" },
    }
  }

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${FX8_ORG}, 'Fx8Org', 'fx8-org') ON CONFLICT (id) DO NOTHING`
    for (const [id, email] of [
      [FX8_U, "fx8-u@t.com"],
      [FX8_V, "fx8-v@t.com"],
      [FX8_W, "fx8-w@t.com"],
    ]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name)
        VALUES (${id}, ${FX8_ORG}, ${email}, ${email}) ON CONFLICT DO NOTHING`
    }
    for (const [id, handle] of [
      [FX8_SHARED, "fx8-shared"],
      [FX8_U_ONLY, "fx8-u-only"],
      [FX8_V_ONLY, "fx8-v-only"],
    ]) {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
        VALUES (${id}, ${FX8_ORG}, ${handle}, ${FX8_U}) ON CONFLICT DO NOTHING`
    }
    for (const [threadId, userId] of [
      [FX8_SHARED, FX8_U],
      [FX8_SHARED, FX8_V],
      [FX8_U_ONLY, FX8_U],
      [FX8_V_ONLY, FX8_V],
    ]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${userId}, ${FX8_ORG}) ON CONFLICT DO NOTHING`
    }
    // The role carries U and V. W is connected but holds no role, so a
    // role-level event must not reach W.
    await sql`INSERT INTO kernel.roles (id, org_id, name)
      VALUES (${FX8_ROLE}, ${FX8_ORG}, 'Fx8 Role') ON CONFLICT (id) DO NOTHING`
    for (const userId of [FX8_U, FX8_V]) {
      await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
        VALUES (${userId}, ${FX8_ROLE}, ${FX8_ORG}) ON CONFLICT DO NOTHING`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${FX8_ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${FX8_ORG}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${FX8_ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${FX8_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${FX8_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${FX8_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${FX8_ORG}`
  })

  it("a grant made on another process invalidates that user's sockets here", async () => {
    const vm = new WebSocketManager(fakeRedis as any)
    const own = openWs()
    vm.addConnection(FX8_U, own as any, ["kernel"], FX8_ORG)

    await deliverFromAnotherProcess(vm, userScopeEvent(FX8_U))

    expect(invalidatesOf(own)).toEqual([{ type: INVALIDATE, threadIds: [FX8_SHARED, FX8_U_ONLY] }])
  })

  it("a role level event invalidates every connected member of that role, each with their own thread ids only", async () => {
    const vm = new WebSocketManager(fakeRedis as any)
    const u = openWs()
    const v = openWs()
    const w = openWs()
    vm.addConnection(FX8_U, u as any, ["kernel"], FX8_ORG)
    vm.addConnection(FX8_V, v as any, ["kernel"], FX8_ORG)
    vm.addConnection(FX8_W, w as any, ["kernel"], FX8_ORG)

    await deliverFromAnotherProcess(vm, roleScopeEvent())

    // Each member gets their OWN participated threads and nothing of the other's.
    expect(invalidatesOf(u)).toEqual([{ type: INVALIDATE, threadIds: [FX8_SHARED, FX8_U_ONLY] }])
    expect(invalidatesOf(v)).toEqual([{ type: INVALIDATE, threadIds: [FX8_SHARED, FX8_V_ONLY] }])
    // A connected user who does not hold the role is untouched.
    expect(invalidatesOf(w)).toHaveLength(0)
  })

  it("never crosses users: a per user event reaches only the named user", async () => {
    const vm = new WebSocketManager(fakeRedis as any)
    const u = openWs()
    const v = openWs()
    vm.addConnection(FX8_U, u as any, ["kernel"], FX8_ORG)
    vm.addConnection(FX8_V, v as any, ["kernel"], FX8_ORG)

    await deliverFromAnotherProcess(vm, userScopeEvent(FX8_V))

    expect(invalidatesOf(v)).toEqual([{ type: INVALIDATE, threadIds: [FX8_SHARED, FX8_V_ONLY] }])
    expect(invalidatesOf(u)).toHaveLength(0)
  })

  it("a user with no connection is a no op and leaves nothing behind", async () => {
    const vm = new WebSocketManager(fakeRedis as any)
    // Nobody is connected: the event names FX8_U, who has no socket here.
    await deliverFromAnotherProcess(vm, userScopeEvent(FX8_U))

    // Nothing was retained by that no op: a later, unrelated event for a
    // DIFFERENT user delivers that user's own ids and never the earlier
    // target's, and FX8_U's own later connection gets no stale frame.
    const v = openWs()
    const u = openWs()
    vm.addConnection(FX8_V, v as any, ["kernel"], FX8_ORG)
    vm.addConnection(FX8_U, u as any, ["kernel"], FX8_ORG)
    await deliverFromAnotherProcess(vm, userScopeEvent(FX8_V))

    expect(invalidatesOf(v)).toEqual([{ type: INVALIDATE, threadIds: [FX8_SHARED, FX8_V_ONLY] }])
    expect(invalidatesOf(u)).toHaveLength(0)

    // And there is no cross-call store to grow: the module exposes no
    // take/settle surface, nor the recorder that used to feed one, so
    // unbounded growth cannot come back.
    const mod = grantInvalidation as unknown as Record<string, unknown>
    expect(mod.takeScopeGrantChange).toBeUndefined()
    expect(mod.settleScopeGrantChanges).toBeUndefined()
    expect(mod.emitScopeGrantChange).toBeUndefined()
  })

  it("delivers once per change: one frame per socket, not one per connection of the org", async () => {
    const vm = new WebSocketManager(fakeRedis as any)
    const own1 = openWs()
    const own2 = openWs()
    const other = openWs()
    vm.addConnection(FX8_U, own1 as any, ["kernel"], FX8_ORG)
    vm.addConnection(FX8_U, own2 as any, ["kernel"], FX8_ORG)
    vm.addConnection(FX8_V, other as any, ["kernel"], FX8_ORG)

    await deliverFromAnotherProcess(vm, userScopeEvent(FX8_U))

    expect(invalidatesOf(own1)).toHaveLength(1)
    expect(invalidatesOf(own2)).toHaveLength(1)
    expect(invalidatesOf(other)).toHaveLength(0)
  })

  it("an event that is not a permission change delivers nothing", async () => {
    const vm = new WebSocketManager(fakeRedis as any)
    const u = openWs()
    vm.addConnection(FX8_U, u as any, ["kernel"], FX8_ORG)

    await deliverFromAnotherProcess(vm, {
      app: "kernel",
      entity: "message",
      action: "create",
      entityId: "m1",
      orgId: FX8_ORG,
      data: { threadId: FX8_SHARED },
    })

    expect(invalidatesOf(u)).toHaveLength(0)
  })

  it("stays post commit: the drain runs on the event the grant transaction queued, which is invisible until it commits", async () => {
    let midTxCount = -1
    await withSystemDb("fx8-post-commit", async (tx) => {
      await setUserScopes(tx as unknown as RlsClient, {
        orgId: FX8_ORG,
        callingApp: "gifx8",
        userId: FX8_U,
        scopes: ["gifx8:items:read"],
      })
      // A SEPARATE connection cannot see the outbox row while the grant
      // transaction is still open: that is what makes the drain post-commit.
      const midTx = await sql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${FX8_ORG} AND payload->>'entity' = 'user_scope'`
      midTxCount = midTx.length
    })
    expect(midTxCount).toBe(0)

    const rows = await sql`
      SELECT payload FROM kernel.pending_events
      WHERE org_id = ${FX8_ORG} AND payload->>'entity' = 'user_scope'`
    expect(rows).toHaveLength(1)

    // That committed event, drained by a process that never recorded anything.
    const vm = new WebSocketManager(fakeRedis as any)
    const own = openWs()
    vm.addConnection(FX8_U, own as any, ["kernel"], FX8_ORG)
    await deliverFromAnotherProcess(vm, (rows[0] as any).payload)
    expect(invalidatesOf(own)).toEqual([{ type: INVALIDATE, threadIds: [FX8_SHARED, FX8_U_ONLY] }])
  })
})
