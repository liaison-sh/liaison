// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { listApprovals } from "~/modules/approvals/list"
import { manifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { registerBulkAgentTools } from "~/modules/apps/bulk-agent-tools"
import { type BulkDispatchDeps, runBulkDispatch } from "~/modules/apps/bulk-dispatch"
import type { ExecuteToolCoreOptions, ExecuteToolEnvelope } from "~/modules/apps/execute-tool"
import { executeTool } from "~/modules/apps/execute-tool"
import { clearRedisPatterns } from "~/tests/route-test-setup"

const ORG = "00000000-0000-0000-0000-0000000bd001"
const USER = "00000000-0000-0000-0000-0000000bd002"
const APP = "bulk_test"
const ACTION_PER = "assign"
const ACTION_AGG = "merge"
const ACTION_PER_GATED = "close"
const TOOL_ASSIGN = "assign"
const TOOL_MERGE = "merge"
const TOOL_CLOSE = "close"
const AGENT_TOOL_BULK_CLOSE = "bulkCloseItems"

// Counts real invocations of the gated TOOL_CLOSE handler. Only the
// executeToolCore-backed tests below (real dispatch, not mockDispatch)
// ever exercise this — it is the "no outbound send occurred" proxy.
let closeHandlerCalls = 0

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: [`${APP}:items:write`, `${APP}:items:close`],
  dimensionGrants: {},
}

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, "0")
  return `00000000-0000-4000-8000-${hex}`
}

function setBulkManifest() {
  manifestRegistry.set([ORG, APP], {
    name: APP,
    bulk: {
      [ACTION_PER]: {
        label: "Assign",
        underlyingTool: TOOL_ASSIGN,
        dispatchMode: "perItem",
        perItemParam: "itemId",
        sharedFields: ["assignedTo"],
      },
      [ACTION_AGG]: {
        label: "Merge",
        underlyingTool: TOOL_MERGE,
        dispatchMode: "aggregate",
        selectionParam: "sourceIds",
        sharedFields: ["targetId"],
      },
      [ACTION_PER_GATED]: {
        label: "Close",
        underlyingTool: TOOL_CLOSE,
        dispatchMode: "perItem",
        perItemParam: "itemId",
        sharedFields: ["closedReason"],
        agentTool: AGENT_TOOL_BULK_CLOSE,
      },
    },
    uiBundleUrl: null,
  })
}

function setTools() {
  toolRegistry.set([ORG, APP, TOOL_ASSIGN], {
    appName: APP,
    name: TOOL_ASSIGN,
    description: "assign",
    requiredScopes: [`${APP}:items:write`],
    gated: false,
    handler: async () => ({}),
  })
  toolRegistry.set([ORG, APP, TOOL_MERGE], {
    appName: APP,
    name: TOOL_MERGE,
    description: "merge",
    requiredScopes: [`${APP}:items:write`],
    gated: false,
    handler: async () => ({}),
  })
  toolRegistry.set([ORG, APP, TOOL_CLOSE], {
    appName: APP,
    name: TOOL_CLOSE,
    description: "close",
    requiredScopes: [`${APP}:items:close`],
    gated: true,
    handler: async () => {
      closeHandlerCalls += 1
      return {}
    },
  })
}

// Registers the real agent-visible bulkMeta tool (AGENT_TOOL_BULK_CLOSE) the
// same way a bundled app's manifest does, so the regression test below goes
// through the real executeToolCore -> bulkMeta -> runBulkDispatch ->
// dispatchOne path instead of a mocked dispatch.
function setBulkAgentTool() {
  registerBulkAgentTools({
    orgId: ORG,
    appName: APP,
    bulk: { [ACTION_PER_GATED]: manifestRegistry.get([ORG, APP])!.bulk![ACTION_PER_GATED] as any },
    tools: {
      [TOOL_CLOSE]: {
        requiredScopes: [`${APP}:items:close`],
        params: { properties: { closedReason: { type: "string" } } },
      },
    },
  })
}

// The ids here are FIXED, so the per-item tool calls' idempotency records
// (`app_idem:`, kept 24 h) must go too: left behind, the next run replays the
// cached envelope instead of calling the tool, and the gate tests below read a
// stale "succeeded" or an approval id whose row was already deleted.
async function clearRedis() {
  await clearRedisPatterns([`bulk:${ORG}:*`, `app_idem:${ORG}:*`])
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Bulk Dispatch Org', 'bulk-dispatch-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'bulk@test.com', 'Bulk User') ON CONFLICT DO NOTHING`
  setBulkManifest()
  setTools()
  setBulkAgentTool()
})

afterEach(async () => {
  closeHandlerCalls = 0
  await clearRedis()
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
  await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
})

afterAll(async () => {
  toolRegistry.deleteByPrefix([ORG, APP])
  manifestRegistry.delete([ORG, APP])
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.user_thread_state WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
  await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (SELECT id FROM kernel.threads WHERE org_id = ${ORG})`
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await clearRedis()
})

function mockDispatch(
  impl: (opts: ExecuteToolCoreOptions) => ExecuteToolEnvelope | Promise<ExecuteToolEnvelope>,
): { dispatch: BulkDispatchDeps["dispatch"]; calls: ExecuteToolCoreOptions[] } {
  const calls: ExecuteToolCoreOptions[] = []
  const dispatch: BulkDispatchDeps["dispatch"] = async (opts) => {
    calls.push(opts)
    return await impl(opts)
  }
  return { dispatch, calls }
}

const noopOriginThread = async () => undefined

describe("runBulkDispatch — perItem", () => {
  it("invokes dispatch N times with {perItemParam: id, ...shared}", async () => {
    const ids = [uuid(1), uuid(2), uuid(3)]
    const { dispatch, calls } = mockDispatch(() => ({ data: { ok: true } }))
    const res = await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER,
        ids,
        params: { assignedTo: USER },
        idempotencyKey: uuid(10),
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    expect(res.total).toBe(3)
    expect(res.succeeded).toBe(3)
    expect(res.failed).toBe(0)
    expect(res.errors).toEqual([])
    expect(calls.map((c) => c.params)).toEqual([
      { itemId: ids[0], assignedTo: USER },
      { itemId: ids[1], assignedTo: USER },
      { itemId: ids[2], assignedTo: USER },
    ])
  })

  it("derives per-item idempotency key as bulkRequestId:id", async () => {
    const ids = [uuid(4), uuid(5)]
    const bulkKey = uuid(11)
    const captured: string[] = []
    const { dispatch } = mockDispatch((opts) => {
      captured.push(opts.internalCall!.idempotencyKey!)
      return { data: {} }
    })
    await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER,
        ids,
        params: { assignedTo: USER },
        idempotencyKey: bulkKey,
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    expect(captured).toEqual([`${bulkKey}:${ids[0]}`, `${bulkKey}:${ids[1]}`])
  })

  it("error envelopes accumulate, batch continues", async () => {
    const ids = [uuid(20), uuid(21), uuid(22)]
    let i = 0
    const { dispatch } = mockDispatch(() => {
      i++
      return i === 2
        ? { error: { code: "NOT_FOUND", message: "gone", retryable: false } }
        : { data: { ok: true } }
    })
    const res = await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER,
        ids,
        params: { assignedTo: USER },
        idempotencyKey: uuid(12),
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    expect(res.succeeded).toBe(2)
    expect(res.failed).toBe(1)
    expect(res.errors[0]).toMatchObject({ id: ids[1], code: "NOT_FOUND" })
  })

  it("normalizes thrown executor failures to per-item errors and continues", async () => {
    const ids = [uuid(30), uuid(31), uuid(32)]
    const { dispatch } = mockDispatch((opts) => {
      const params = opts.params as Record<string, unknown>
      if (params.itemId === ids[1]) {
        throw Object.assign(new Error("timeout"), { code: "TIMEOUT" })
      }
      return { data: {} }
    })
    const res = await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER,
        ids,
        params: { assignedTo: USER },
        idempotencyKey: uuid(13),
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    expect(res.succeeded).toBe(2)
    expect(res.errors[0]).toMatchObject({ id: ids[1], code: "TIMEOUT" })
  })

  it("gated tool returns approvalRequestId per item, no errors", async () => {
    const ids = [uuid(40), uuid(41)]
    const { dispatch } = mockDispatch((opts) => {
      const params = opts.params as Record<string, unknown>
      return {
        blocked: {
          reason: "gated",
          approvalRequestId: `appr-${String(params.itemId)}`,
          requesterCanApprove: false,
        },
      }
    })
    const res = await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER_GATED,
        ids,
        params: { closedReason: "resolved" },
        idempotencyKey: uuid(14),
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    expect(res.approvalsCreated).toBe(2)
    expect(res.items.map((i) => i.approvalRequestId)).toEqual([`appr-${ids[0]}`, `appr-${ids[1]}`])
    expect(res.items.every((i) => i.status === "pending_approval")).toBe(true)
    expect(res.failed).toBe(0)
  })

  it("writes metadata.bulkRequestId on each approval", async () => {
    const ids = [uuid(50), uuid(51)]
    const approvalId1 = uuid(60)
    const approvalId2 = uuid(61)
    const thread = uuid(70)
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${thread}, ${ORG}, 'bulk-meta-thread-1', 'thread', ${USER})`
    for (const [aid, itemId] of [
      [approvalId1, ids[0]],
      [approvalId2, ids[1]],
    ] as const) {
      await sql`INSERT INTO kernel.approval_requests
        (id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params, current_payload, expires_at, requested_by, status, metadata)
        VALUES (${aid}, ${ORG}, ${`req-${itemId.slice(-4)}`}, ${thread}, ${thread}, ${`${APP}:${TOOL_CLOSE}`}, '{}'::jsonb, '{}'::jsonb, now() + interval '7 days', ${USER}, 'pending', '{}'::jsonb)`
    }
    const { dispatch } = mockDispatch((opts) => {
      const params = opts.params as Record<string, unknown>
      const m: Record<string, string> = { [ids[0]]: approvalId1, [ids[1]]: approvalId2 }
      return {
        blocked: {
          reason: "gated",
          approvalRequestId: m[String(params.itemId)],
          requesterCanApprove: false,
        },
      }
    })
    await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER_GATED,
        ids,
        params: { closedReason: "resolved" },
        idempotencyKey: uuid(15),
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    const rows = await sql<
      { id: string; metadata: Record<string, unknown> }[]
    >`SELECT id, metadata FROM kernel.approval_requests WHERE id IN (${approvalId1}, ${approvalId2}) ORDER BY id`
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.metadata.bulkRequestId).toBe(uuid(15))
      expect(row.metadata.bulkAction).toBe(`${APP}.${ACTION_PER_GATED}`)
      expect(typeof row.metadata.bulkItemId).toBe("string")
    }
    await sql`DELETE FROM kernel.approval_requests WHERE id IN (${approvalId1}, ${approvalId2})`
    await sql`DELETE FROM kernel.threads WHERE id = ${thread}`
  })
})

describe("runBulkDispatch — origin thread", () => {
  // A person's own bulk click never parks an approval, so the hidden thread an
  // approval anchors to is not created for it, even when every item is refused.
  it("a person's gated bulk whose items are all refused creates no origin thread", async () => {
    const ids = [uuid(80), uuid(81)]
    let threadAsks = 0
    const { dispatch, calls } = mockDispatch(() => ({
      error: { code: "forbidden", message: "needs the approve scope", retryable: false },
    }))
    const res = await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER_GATED,
        ids,
        params: { closedReason: "resolved" },
        idempotencyKey: uuid(16),
        actor,
        origin: "human-ui",
      },
      {
        dispatch,
        ensureOriginThread: async () => {
          threadAsks++
          return uuid(90)
        },
      },
    )
    expect(threadAsks).toBe(0)
    expect(calls.every((c) => c.threadId === undefined)).toBe(true)
    expect(res.failed).toBe(2)
    expect(res.approvalsCreated).toBe(0)
  })

  it("an agent's gated bulk still anchors its approvals to one origin thread", async () => {
    const ids = [uuid(82), uuid(83)]
    let threadAsks = 0
    const { dispatch, calls } = mockDispatch((opts) => ({
      blocked: {
        reason: "gated",
        approvalRequestId: `appr-${String((opts.params as Record<string, unknown>).itemId)}`,
        requesterCanApprove: false,
      },
    }))
    await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER_GATED,
        ids,
        params: { closedReason: "resolved" },
        idempotencyKey: uuid(17),
        actor,
        origin: "in-app-agent",
      },
      {
        dispatch,
        ensureOriginThread: async () => {
          threadAsks++
          return uuid(91)
        },
      },
    )
    expect(threadAsks).toBe(1)
    expect(calls.every((c) => c.threadId === uuid(91))).toBe(true)
  })
})

describe("runBulkDispatch — aggregate", () => {
  it("invokes underlying tool once with {selectionParam: ids, ...shared}", async () => {
    const ids = [uuid(80), uuid(81), uuid(82)]
    const { dispatch, calls } = mockDispatch(() => ({ data: { merged: 3 } }))
    const res = await runBulkDispatch(
      {
        app: APP,
        action: ACTION_AGG,
        ids,
        params: { targetId: uuid(83) },
        idempotencyKey: uuid(16),
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    expect(calls.length).toBe(1)
    expect(calls[0].params).toEqual({ sourceIds: ids, targetId: uuid(83) })
    expect(res.items.length).toBe(3)
    expect(res.succeeded).toBe(3)
  })

  it("aggregate single error fans to every source id", async () => {
    const ids = [uuid(90), uuid(91)]
    const { dispatch } = mockDispatch(() => ({
      error: { code: "VALIDATION", message: "bad target", retryable: false },
    }))
    const res = await runBulkDispatch(
      {
        app: APP,
        action: ACTION_AGG,
        ids,
        params: { targetId: uuid(92) },
        idempotencyKey: uuid(17),
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    expect(res.failed).toBe(2)
    expect(res.errors.length).toBe(2)
    expect(res.errors[0].code).toBe("VALIDATION")
  })
})

describe("runBulkDispatch — idempotency", () => {
  it("caches response by bulkRequestId; second call returns cached without dispatch", async () => {
    const ids = [uuid(100), uuid(101)]
    let n = 0
    const { dispatch } = mockDispatch(() => {
      n++
      return { data: {} }
    })
    const key = uuid(18)
    await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER,
        ids,
        params: { assignedTo: USER },
        idempotencyKey: key,
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER,
        ids,
        params: { assignedTo: USER },
        idempotencyKey: key,
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )
    expect(n).toBe(2) // only the first batch dispatched
  })

  it("concurrent duplicate idempotencyKey returns same result without double dispatch", async () => {
    const ids = [uuid(110), uuid(111)]
    let n = 0
    const { dispatch } = mockDispatch(async () => {
      n++
      await new Promise((r) => setTimeout(r, 30))
      return { data: {} }
    })
    const key = uuid(19)
    const args = {
      app: APP,
      action: ACTION_PER,
      ids,
      params: { assignedTo: USER },
      idempotencyKey: key,
      actor,
      origin: "human-ui" as const,
    }
    const [a, b] = await Promise.allSettled([
      runBulkDispatch(args, { dispatch, ensureOriginThread: noopOriginThread }),
      runBulkDispatch(args, { dispatch, ensureOriginThread: noopOriginThread }),
    ])
    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"])
    expect(n).toBe(2) // only one batch (per-item count, not 4)
  })

  it("rejects conflicting idempotencyKey reuse without dispatching", async () => {
    const ids = [uuid(112), uuid(113)]
    let n = 0
    const { dispatch } = mockDispatch(() => {
      n++
      return { data: {} }
    })
    const key = uuid(114)
    await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER,
        ids,
        params: { assignedTo: USER },
        idempotencyKey: key,
        actor,
        origin: "human-ui",
      },
      { dispatch, ensureOriginThread: noopOriginThread },
    )

    await expect(
      runBulkDispatch(
        {
          app: APP,
          action: ACTION_PER,
          ids,
          params: { assignedTo: uuid(115) },
          idempotencyKey: key,
          actor,
          origin: "human-ui",
        },
        { dispatch, ensureOriginThread: noopOriginThread },
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 })
    expect(n).toBe(2)
  })

  it("rejects duplicate ids before dispatch", async () => {
    let n = 0
    const { dispatch } = mockDispatch(() => {
      n++
      return { data: {} }
    })
    const dup = uuid(120)
    await expect(
      runBulkDispatch(
        {
          app: APP,
          action: ACTION_PER,
          ids: [dup, dup],
          params: { assignedTo: USER },
          idempotencyKey: uuid(121),
          actor,
          origin: "human-ui",
        },
        { dispatch, ensureOriginThread: noopOriginThread },
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_IDS" })
    expect(n).toBe(0)
  })
})

describe("runBulkDispatch — bulk origin thread", () => {
  it("creates bulk origin thread once for an agent's gated perItem dispatch", async () => {
    // An agent's bulk: a person's own bulk never parks, so it gets no thread (above).
    const ids = [uuid(130), uuid(131)]
    const { dispatch } = mockDispatch(() => ({ data: { ok: true } }))
    const bulkKey = uuid(132)
    await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER_GATED,
        ids,
        params: { closedReason: "resolved" },
        idempotencyKey: bulkKey,
        actor,
        origin: "in-app-agent",
      },
      { dispatch },
    )
    await clearRedis()
    await runBulkDispatch(
      {
        app: APP,
        action: ACTION_PER_GATED,
        ids,
        params: { closedReason: "resolved" },
        idempotencyKey: bulkKey,
        actor,
        origin: "in-app-agent",
      },
      { dispatch },
    )
    const rows = await sql<
      {
        id: string
        created_from: { app: string; entityType: string; entityId: string; actorId: string } | null
        hidden_from_list: boolean
        title: string | null
      }[]
    >`SELECT id, created_from, hidden_from_list, title FROM kernel.threads WHERE org_id = ${ORG} AND created_from->>'entityType' = 'bulk_request' AND created_from->>'entityId' = ${bulkKey}`
    expect(rows.length).toBe(1)
    expect(rows[0].created_from?.actorId).toBe(USER)
    expect(rows[0].hidden_from_list).toBe(true)
    expect(rows[0].title).toBe("Bulk Close — 2 items")
  })
})

describe("bulkMeta dispatch: origin propagation through the real gate (regression)", () => {
  // Holds the underlying tool's scope AND the approve scope: this exact
  // combination is what previously made a bulk item look like a direct
  // human UI click (isDirectHumanCall) and skip the approval gate.
  const approveHolderActor: UserContext = {
    ...actor,
    scopes: [...actor.scopes, `${APP}:approve`],
  }

  it("agent bulkClose call, gated underlying tool: handler does not run, a pending approval is created and is visible to the requester via listApprovals", async () => {
    const ids = [uuid(301)]
    const idempotencyKey = uuid(302)
    const result = await executeTool({
      toolName: `${APP}:${AGENT_TOOL_BULK_CLOSE}`,
      orgId: ORG,
      actor: approveHolderActor,
      params: { ids, closedReason: "resolved", idempotencyKey },
      origin: "in-app-agent",
    })
    const data = result.data as { approvalsCreated: number; items: Array<{ status: string }> }

    // (a) the gated underlying tool's handler DID NOT RUN.
    expect(closeHandlerCalls).toBe(0)
    expect(data.approvalsCreated).toBe(1)
    expect(data.items[0].status).toBe("pending_approval")

    // (b) an approval row exists, pending, requested by the invoking user.
    const rows = await sql<{ id: string; status: string; requested_by: string }[]>`
      SELECT id, status, requested_by FROM kernel.approval_requests
      WHERE org_id = ${ORG} AND tool_name = ${`${APP}:${TOOL_CLOSE}`}
    `
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe("pending")
    expect(rows[0].requested_by).toBe(USER)

    // (c) visible to the invoking user via the real list path, not just a
    // privileged direct table query.
    const visible = await withRlsContext(approveHolderActor, (tx) =>
      listApprovals(tx, { orgId: ORG, userId: USER, scopes: approveHolderActor.scopes }),
    )
    expect(visible.some((a) => a.id === rows[0].id)).toBe(true)
  })

  it("direct human UI bulkClose call (origin human-ui), approve-holder: the intended UI bypass still auto-executes", async () => {
    const ids = [uuid(303)]
    const idempotencyKey = uuid(304)
    const result = await executeTool({
      toolName: `${APP}:${AGENT_TOOL_BULK_CLOSE}`,
      orgId: ORG,
      actor: approveHolderActor,
      params: { ids, closedReason: "resolved", idempotencyKey },
      // origin:"human-ui" -> direct human UI call; the click IS the approval.
      origin: "human-ui",
    })
    const data = result.data as { approvalsCreated: number; succeeded: number }

    expect(closeHandlerCalls).toBe(1)
    expect(data.approvalsCreated).toBe(0)
    expect(data.succeeded).toBe(1)

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM kernel.approval_requests
      WHERE org_id = ${ORG} AND tool_name = ${`${APP}:${TOOL_CLOSE}`}
    `
    expect(rows.length).toBe(0)
  })

  it("a bulkClose call that omits origin is gated even though the actor holds approve scope", async () => {
    // Regression test for the discriminator bug: absence of origin must never
    // be read as proof of a human clicked the approve button. Same actor and
    // tool as the human-ui test above (which DOES bypass); omitting origin
    // entirely must still gate each item instead of defaulting to a bypass.
    const ids = [uuid(305)]
    const idempotencyKey = uuid(306)
    const result = await executeTool({
      toolName: `${APP}:${AGENT_TOOL_BULK_CLOSE}`,
      orgId: ORG,
      actor: approveHolderActor,
      params: { ids, closedReason: "resolved", idempotencyKey },
      // origin intentionally omitted
    })
    const data = result.data as { approvalsCreated: number; succeeded: number }

    expect(closeHandlerCalls).toBe(0)
    expect(data.approvalsCreated).toBe(1)
    expect(data.succeeded).toBe(0)

    const rows = await sql<{ id: string }[]>`
      SELECT id FROM kernel.approval_requests
      WHERE org_id = ${ORG} AND tool_name = ${`${APP}:${TOOL_CLOSE}`}
    `
    expect(rows.length).toBe(1)
  })
})
