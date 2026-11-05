// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { AppEvent } from "~/infra/events/event-bus"
import { processTranslationEvent } from "~/modules/attention/translator"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-0000-0000-0000006a0001"
const ADMIN_1 = "00000000-0000-0000-0000-0000006a0011"
const ADMIN_2 = "00000000-0000-0000-0000-0000006a0012"
const USER_X = "00000000-0000-0000-0000-0000006a0013" // requester, NOT an admin
const ADMIN_3 = "00000000-0000-0000-0000-0000006a0014" // admin via ROLE grant (viaRoles arm)
const ROLE_ID = "00000000-0000-0000-0000-0000006a00a1"
const REQ_ID = "00000000-0000-0000-0000-0000006a00f1"

describe("scope_request attention notifications", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES
      (${ORG}, 'ScopeNotifyOrg', 'scope-notify-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status) VALUES
      (${ADMIN_1}, ${ORG}, 'notify-a1@test.com', 'Admin One', 'x', 'active'),
      (${ADMIN_2}, ${ORG}, 'notify-a2@test.com', 'Admin Two', 'x', 'active'),
      (${ADMIN_3}, ${ORG}, 'notify-a3@test.com', 'Admin Three', 'x', 'active'),
      (${USER_X}, ${ORG}, 'notify-x@test.com', 'User X', 'x', 'active') ON CONFLICT DO NOTHING`

    // ADMIN_1/2 hold kernel:scope_requests:admin via a direct user grant.
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES
      (${ADMIN_1}, ${ORG}, 'kernel:scope_requests:admin'),
      (${ADMIN_2}, ${ORG}, 'kernel:scope_requests:admin') ON CONFLICT DO NOTHING`

    // ADMIN_3 holds it via a ROLE grant — exercises the viaRoles arm of
    // defaultLoadScopeHolders (the direct grants above only cover viaDirect).
    await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES
      (${ROLE_ID}, ${ORG}, 'scope-approver') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES
      (${ROLE_ID}, 'kernel:scope_requests:admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES
      (${ADMIN_3}, ${ROLE_ID}, ${ORG}) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.attention_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE_ID}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("scope_request:create notifies all kernel:scope_requests:admin holders, not others", async () => {
    const event: AppEvent = {
      app: "kernel",
      entity: "scope_request",
      action: "create",
      orgId: ORG,
      actorId: USER_X,
      actorType: "user",
      entityId: REQ_ID,
      timestamp: new Date().toISOString(),
      data: { title: "Requesting 1 scope", lines: ["kernel:contacts:write"], status: "pending" },
      metadata: { actorName: "User X" },
    }
    await processTranslationEvent(event)

    const rows =
      await sql`SELECT user_id FROM kernel.attention_events WHERE org_id = ${ORG} AND entity_id = ${REQ_ID} AND kind = 'scope_request'`
    const ids = rows.map((r) => r.user_id as string)
    expect(ids).toContain(ADMIN_1) // direct grant
    expect(ids).toContain(ADMIN_2) // direct grant
    expect(ids).toContain(ADMIN_3) // role grant (viaRoles arm)
    expect(ids).not.toContain(USER_X)
  })

  it("scope_request:update (decided) notifies the requester", async () => {
    const event: AppEvent = {
      app: "kernel",
      entity: "scope_request",
      action: "update",
      orgId: ORG,
      actorId: ADMIN_1,
      actorType: "user",
      entityId: REQ_ID,
      timestamp: new Date().toISOString(),
      data: {
        title: "Requesting 1 scope",
        lines: ["kernel:contacts:write"],
        status: "approved",
        requestedBy: USER_X,
        decidedBy: ADMIN_1,
      },
      metadata: { actorName: "Admin One" },
    }
    await processTranslationEvent(event)

    const rows =
      await sql`SELECT user_id FROM kernel.attention_events WHERE org_id = ${ORG} AND entity_id = ${REQ_ID} AND kind = 'scope_request_decided'`
    const ids = rows.map((r) => r.user_id as string)
    expect(ids).toContain(USER_X)
    expect(ids).not.toContain(ADMIN_2)
  })

  // Deciding used to leave every decider's "X requested access" item unread:
  // the only translation on scope_request:update notified the requester, and
  // nothing resolved the ask, so the feed kept demanding an action already
  // taken and the only way out was to mark it read by hand.
  it("scope_request:update (decided) resolves every decider's ask, and leaves the requester's news", async () => {
    const reqId = "00000000-0000-0000-0000-0000006a00f2"
    const base = {
      app: "kernel",
      entity: "scope_request",
      orgId: ORG,
      actorType: "user" as const,
      entityId: reqId,
    }
    await processTranslationEvent({
      ...base,
      action: "create",
      actorId: USER_X,
      timestamp: new Date().toISOString(),
      data: { title: "kernel:contacts:write", lines: ["kernel:contacts:write"], status: "pending" },
      metadata: { actorName: "User X" },
    })
    const before = await sql<{ read_at: string | null }[]>`
      SELECT read_at FROM kernel.attention_events
      WHERE org_id = ${ORG} AND entity_id = ${reqId} AND kind = 'scope_request'`
    expect(before.length).toBeGreaterThanOrEqual(3)
    expect(before.every((r) => r.read_at === null)).toBe(true)

    await processTranslationEvent({
      ...base,
      action: "update",
      actorId: ADMIN_1,
      timestamp: new Date().toISOString(),
      data: {
        title: "kernel:contacts:write",
        lines: ["kernel:contacts:write"],
        status: "denied",
        requestedBy: USER_X,
        decidedBy: ADMIN_1,
      },
      metadata: { actorName: "Admin One" },
    })

    const asks = await sql<{ user_id: string; read_at: string | null }[]>`
      SELECT user_id, read_at FROM kernel.attention_events
      WHERE org_id = ${ORG} AND entity_id = ${reqId} AND kind = 'scope_request'`
    expect(asks.length).toBe(before.length) // resolved in place, not re-created
    expect(asks.every((r) => r.read_at !== null)).toBe(true) // every decider, not only ADMIN_1
    const [news] = await sql<{ read_at: string | null }[]>`
      SELECT read_at FROM kernel.attention_events
      WHERE org_id = ${ORG} AND entity_id = ${reqId} AND kind = 'scope_request_decided'
        AND user_id = ${USER_X}`
    expect(news).toBeDefined()
    expect(news.read_at).toBeNull()
  })
})
