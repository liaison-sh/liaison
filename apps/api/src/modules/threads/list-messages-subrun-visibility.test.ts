// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sub-run drill-down reads a hidden transcript through the privileged pool
// (a hidden thread has no participant rows, so RLS would return nothing). That
// read must still apply the messages visibility predicate per viewer: a root
// participant whose grants do not cover a transcript row's requiredScopes gets
// no content from it, while a participant holding them does.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { listMessages } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SECRET = "lmv:deals:read"
const ORG = crypto.randomUUID()
const HOLDER = crypto.randomUUID()
const LACKER = crypto.randomUUID()
// The speaking agent: an agent-authored row names it (0080).
const AGENT = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let rootThreadId: string
let subrunThreadId: string

const ctx = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes,
  dimensionGrants: {},
})

async function drillDown(userId: string, scopes: string[]) {
  return withRlsContext(ctx(userId, scopes), (tx) =>
    listMessages(tx, { orgId: ORG, userId, threadId: subrunThreadId, limit: 50 }),
  )
}

describe("listMessages sub-run drill-down applies the visibility predicate per viewer", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'LMV Org', ${`lmv-${tag}`})`
    for (const [id, name] of [
      [HOLDER, "holder"],
      [LACKER, "lacker"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`lmv-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT}, ${ORG}, 'personal', ${`@lmv-${tag}`}, 'Holder agent', ${HOLDER})`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${HOLDER}, ${ORG}, ${SECRET})`

    const [rootT] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
      VALUES (${ORG}, ${`lmv-root-${tag}`}, 'Root', 'thread', ${HOLDER}) RETURNING id`
    rootThreadId = rootT.id
    for (const userId of [HOLDER, LACKER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${rootThreadId}, ${userId}, ${ORG})`
    }
    const [subT] = await sql`
      INSERT INTO kernel.threads (org_id, handle, title, type, hidden_from_list, created_by)
      VALUES (${ORG}, ${`lmv-sub-${tag}`}, 'Sub-Run', 'subrun', true, ${HOLDER}) RETURNING id`
    subrunThreadId = subT.id

    const rootRunId = crypto.randomUUID()
    const childRunId = crypto.randomUUID()
    const actorJson = JSON.stringify({
      actorType: "user",
      userId: HOLDER,
      orgId: ORG,
      scopes: [],
      dimensionGrants: {},
    })
    await sql`INSERT INTO kernel.agent_runs (
      id, org_id, parent_run_id, root_run_id, thread_id, subagent_type, actor,
      effective_scopes, status, prompt, max_steps, timeout_ms, schema_retry_budget, nesting_depth
    ) VALUES (
      ${rootRunId}, ${ORG}, NULL, ${rootRunId}, ${rootThreadId}, NULL, ${actorJson}::jsonb,
      ARRAY[]::text[], 'running', '', 10, 60000, 3, 0)`
    await sql`INSERT INTO kernel.agent_runs (
      id, org_id, parent_run_id, root_run_id, thread_id, subagent_type, actor,
      effective_scopes, status, prompt, max_steps, timeout_ms, schema_retry_budget, nesting_depth
    ) VALUES (
      ${childRunId}, ${ORG}, ${rootRunId}, ${rootRunId}, ${subrunThreadId}, 'investigator',
      ${actorJson}::jsonb, ARRAY[]::text[], 'running', '', 10, 60000, 3, 1)`

    await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
      VALUES (${subrunThreadId}, ${ORG}, ${HOLDER}, 'user', 'Look into the pipeline', ARRAY[]::text[])`
    await sql`INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
      VALUES (${subrunThreadId}, ${ORG}, ${HOLDER}, 'agent', ${AGENT}, 'Deal 42 closes Friday at 1.2M',
        ARRAY[${SECRET}]::text[])`
    // Scoped AND disclosed to the lacker: they read it without holding the
    // scope, which is exactly the viewer the scope NAME must never reach.
    await sql`INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes, disclosure_list)
      VALUES (${subrunThreadId}, ${ORG}, ${HOLDER}, 'agent', ${AGENT}, 'Shared on request',
        ARRAY[${SECRET}]::text[], ARRAY[${LACKER}]::uuid[])`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agent_runs WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("a root participant lacking the scope gets the untagged rows only, no tagged content", async () => {
    const result = await drillDown(LACKER, ["kernel:threads:read"])
    expect(result).not.toBeNull()
    expect(result!.messages.map((m) => m.content).sort()).toEqual(
      ["Look into the pipeline", "Shared on request"].sort(),
    )
    expect(JSON.stringify(result)).not.toContain("Deal 42")
  })

  // WHY A REPLY IS HIDDEN TO THE REST OF THE ROOM (surface 19). The row's scope
  // tag reached nobody, so the one member who can act on it had no way to see
  // what the turn was tagged with. It is projected to a viewer who holds every
  // scope on the row, and to nobody else: a DISCLOSED viewer reads the row
  // without holding its scopes, and a scope name there is enumeration.
  describe("requiredScopes projection", () => {
    it("gives the scope tag to a viewer who holds every scope on the row", async () => {
      const result = await drillDown(HOLDER, ["kernel:threads:read", SECRET])
      const tagged = result!.messages.find((m) => m.content === "Deal 42 closes Friday at 1.2M")
      expect((tagged as { requiredScopes?: string[] }).requiredScopes).toEqual([SECRET])
      // An untagged row says so positively: it carries the empty set.
      const plain = result!.messages.find((m) => m.content === "Look into the pipeline")
      expect((plain as { requiredScopes?: string[] }).requiredScopes).toEqual([])
    })

    it("never gives it to a viewer who lacks one, even when the row is disclosed to them", async () => {
      const result = await drillDown(LACKER, ["kernel:threads:read"])
      const disclosed = result!.messages.find((m) => m.content === "Shared on request")
      expect(disclosed).toBeDefined()
      expect(disclosed).not.toHaveProperty("requiredScopes")
      expect(JSON.stringify(result)).not.toContain(SECRET)
    })
  })

  // A restricted (device-flow) session: the holder's STORED grants cover the
  // row, but the session was capped below it. The drill-down reads with the
  // live grants narrowed by the session's scopes, never the stored ones alone.
  it("a holder whose session does not carry the scope gets no tagged content", async () => {
    const result = await drillDown(HOLDER, ["kernel:threads:read"])
    expect(result).not.toBeNull()
    expect(JSON.stringify(result)).not.toContain("Deal 42")
  })

  it("a root participant holding the scope gets every row", async () => {
    const result = await drillDown(HOLDER, ["kernel:threads:read", SECRET])
    expect(result).not.toBeNull()
    expect(result!.messages.map((m) => m.content).sort()).toEqual(
      ["Deal 42 closes Friday at 1.2M", "Look into the pipeline", "Shared on request"].sort(),
    )
  })
})
