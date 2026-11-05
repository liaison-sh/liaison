// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { createScopeRequest } from "~/modules/scope-requests/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-0000-0000-0000005d0001"
const USER = "00000000-0000-0000-0000-0000005d0011" // requester (self-targeted)

function userCtx() {
  return {
    actorType: "user" as const,
    userId: USER,
    orgId: ORG,
    // The actor only needs to be able to file their own request — the INSERT
    // policy is self-targeted and scope-agnostic. Give a harmless read scope.
    scopes: ["kernel:threads:read"],
    dimensionGrants: {},
  }
}

/** Count this actor's PENDING scope-request rows, read with full visibility. */
async function countPending(): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM kernel.scope_requests
    WHERE org_id = ${ORG} AND requested_by = ${USER} AND status = 'pending'`
  return Number(rows[0].count)
}

describe("createScopeRequest concurrency dedup", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES
      (${ORG}, 'ScopeReqSvcOrg', 'scope-req-svc-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash) VALUES
      (${USER}, ${ORG}, 'sr-svc@test.com', 'SR Svc User', 'x') ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    // Each test starts from a clean slate of pending rows + their outbox events.
    await sql`DELETE FROM kernel.scope_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.scope_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("two concurrent identical create calls yield exactly ONE pending row", async () => {
    const scopes = ["kernel:contacts:write", "kernel:threads:read"]

    // Each withRlsContext opens its own transaction on its own connection, so the
    // two calls genuinely race at the DB level: both run the select-then-insert dedup
    // and both can miss the select, hitting the partial unique index on insert.
    const [a, b] = await Promise.all([
      withRlsContext(userCtx(), (tx) =>
        createScopeRequest(tx, {
          orgId: ORG,
          requestedBy: USER,
          requestedByType: "user",
          requestedScopes: scopes,
        }),
      ),
      withRlsContext(userCtx(), (tx) =>
        createScopeRequest(tx, {
          orgId: ORG,
          requestedBy: USER,
          requestedByType: "user",
          requestedScopes: scopes,
        }),
      ),
    ])

    // Both callers get a row, and it's the SAME row (the single winner).
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a.id).toBe(b.id)

    // The bug being fixed: this must be 1, not 2.
    expect(await countPending()).toBe(1)
  })

  it("set-equal requests in different input order still collide on one row", async () => {
    // Same scope set, opposite order — canonicalization (sort) must make them match
    // the same partial-unique-index key, so concurrency still produces one row.
    const forward = ["kernel:a:read", "kernel:b:write"]
    const reversed = ["kernel:b:write", "kernel:a:read"]

    const [a, b] = await Promise.all([
      withRlsContext(userCtx(), (tx) =>
        createScopeRequest(tx, {
          orgId: ORG,
          requestedBy: USER,
          requestedByType: "user",
          requestedScopes: forward,
        }),
      ),
      withRlsContext(userCtx(), (tx) =>
        createScopeRequest(tx, {
          orgId: ORG,
          requestedBy: USER,
          requestedByType: "user",
          requestedScopes: reversed,
        }),
      ),
    ])

    expect(a.id).toBe(b.id)
    expect(await countPending()).toBe(1)
  })

  it("a sequential second identical request returns the existing pending row", async () => {
    // Sanity: the non-racing covering path is unchanged — second call dedupes, no
    // duplicate, no second event queued.
    const scopes = ["kernel:contacts:write"]
    const first = await withRlsContext(userCtx(), (tx) =>
      createScopeRequest(tx, {
        orgId: ORG,
        requestedBy: USER,
        requestedByType: "user",
        requestedScopes: scopes,
      }),
    )
    const second = await withRlsContext(userCtx(), (tx) =>
      createScopeRequest(tx, {
        orgId: ORG,
        requestedBy: USER,
        requestedByType: "user",
        requestedScopes: scopes,
      }),
    )

    expect(second.id).toBe(first.id)
    expect(await countPending()).toBe(1)
  })
})

// A scope request filed from an agent turn recorded only the human whose turn
// it was, so the admin row credited the person, named no agent, and read
// "Someone requested access: Requesting 1 scope": nothing an admin could
// decide on.
describe("a scope request an agent filed", () => {
  const AGENT = "00000000-0000-0000-0000-0000005d0021"

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES
      (${ORG}, 'ScopeReqSvcOrg', 'scope-req-svc-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash) VALUES
      (${USER}, ${ORG}, 'sr-svc@test.com', 'SR Svc User', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', '@sr-support', 'Support Desk', '[]'::jsonb)
      ON CONFLICT DO NOTHING`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.scope_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.scope_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("records the acting agent on the row", async () => {
    const row = await withRlsContext(userCtx(), (tx) =>
      createScopeRequest(tx, {
        orgId: ORG,
        requestedBy: USER,
        requestedByType: "agent",
        agentId: AGENT,
        requestedScopes: ["ads:insights:read"],
      }),
    )
    expect(row.agentId).toBe(AGENT)
    const [stored] = await sql<{ agent_id: string | null }[]>`
      SELECT agent_id FROM kernel.scope_requests WHERE id = ${row.id}`
    expect(stored.agent_id).toBe(AGENT)
  })

  // Approval widens the ceiling of the agent the row names (0168): a second
  // agent of the same person asking for the same scope must get its own row,
  // or the admin's approval widens the first agent and the asker stays locked.
  it("another agent asking for the same scopes gets its own pending row", async () => {
    const OTHER = "00000000-0000-0000-0000-0000005d0022"
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${OTHER}, ${ORG}, 'role', '@sr-other', 'Other Desk', '[]'::jsonb)
      ON CONFLICT DO NOTHING`
    const file = (agentId: string) =>
      withRlsContext(userCtx(), (tx) =>
        createScopeRequest(tx, {
          orgId: ORG,
          requestedBy: USER,
          requestedByType: "agent",
          agentId,
          requestedScopes: ["tickets:tickets:write"],
        }),
      )
    const first = await file(AGENT)
    const second = await file(OTHER)
    expect(second.id).not.toBe(first.id)
    expect(second.agentId).toBe(OTHER)
    // The same agent asking again still gets its own row back.
    expect((await file(AGENT)).id).toBe(first.id)
  })

  it("names the agent and the scopes on the admin event", async () => {
    await withRlsContext(userCtx(), (tx) =>
      createScopeRequest(tx, {
        orgId: ORG,
        requestedBy: USER,
        requestedByType: "agent",
        agentId: AGENT,
        requestedScopes: ["ads:insights:read"],
        reason: "To read last week's ad spend.",
      }),
    )
    const [event] = await sql<{ data: Record<string, unknown> }[]>`
      SELECT payload->'data' AS data FROM kernel.pending_events
      WHERE org_id = ${ORG}
        AND payload->>'entity' = 'scope_request' AND payload->>'action' = 'create'`
    expect(event.data.requesterLabel).toBe("Support Desk")
    // Why it was asked: the admin's Approvals row says it.
    expect(event.data.reason).toBe("To read last week's ad spend.")
    expect(event.data.agentName).toBe("Support Desk")
    expect(event.data.agentId).toBe(AGENT)
    // The title is what the attention row prints beside the asker: the
    // capabilities themselves, not a count of them.
    expect(event.data.title).toBe("ads:insights:read")
  })

  it("falls back to the person's own name when no agent asked", async () => {
    await withRlsContext(userCtx(), (tx) =>
      createScopeRequest(tx, {
        orgId: ORG,
        requestedBy: USER,
        requestedByType: "user",
        requestedScopes: ["ads:insights:read"],
      }),
    )
    const [event] = await sql<{ data: Record<string, unknown> }[]>`
      SELECT payload->'data' AS data FROM kernel.pending_events
      WHERE org_id = ${ORG}
        AND payload->>'entity' = 'scope_request' AND payload->>'action' = 'create'`
    expect(event.data.requesterLabel).toBe("SR Svc User")
    expect(event.data.agentName).toBe(null)
  })
})
