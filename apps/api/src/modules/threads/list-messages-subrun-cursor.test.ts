// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2b-FX10b defect 5: a returned cursor is always a row the viewer can see.
//
// On the sub-run drill-down the page is read through the BYPASSRLS pool and
// the app-level predicate is the REAL gate (FX1). The cursor, though, was
// taken from the row set BEFORE that filter, so when the oldest row of a page
// was hidden the client was handed a hidden message's id.
//
// T14's pagination rule is unchanged and pinned below: `hasMore` still comes
// from the PRE-filter rows, so a page shortened by hidden rows is never read
// as the end of the thread. Only the id handed back moves to the filtered set.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { listMessages } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SECRET = "lsc:deals:read"
const ORG = crypto.randomUUID()
const HOLDER = crypto.randomUUID()
const LACKER = crypto.randomUUID()
// The speaking agent: an agent-authored row names it (0080).
const AGENT = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let rootThreadId: string
let subrunThreadId: string
// s1 open, s2 scoped, s3 scoped, s4 open. Ids in thread order.
const ids: string[] = []
const s = (n: number) => ids[n - 1]

const ctx = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes,
  dimensionGrants: {},
})

async function drillDown(userId: string, scopes: string[], limit: number, before?: string) {
  return withRlsContext(ctx(userId, scopes), (tx) =>
    listMessages(tx, { orgId: ORG, userId, threadId: subrunThreadId, limit, before }),
  )
}

describe("listMessages sub-run drill-down never returns a hidden message as the cursor (FX10b)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'LSC Org', ${`lsc-${tag}`})`
    for (const [id, name] of [
      [HOLDER, "holder"],
      [LACKER, "lacker"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`lsc-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT}, ${ORG}, 'personal', ${`@lsc-${tag}`}, 'Holder agent', ${HOLDER})`
    // The drill-down resolves the viewer's grants from the database.
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${HOLDER}, ${ORG}, ${SECRET})`

    const [rootT] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
      VALUES (${ORG}, ${`lsc-root-${tag}`}, 'Root', 'thread', ${HOLDER}) RETURNING id`
    rootThreadId = rootT.id
    for (const userId of [HOLDER, LACKER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${rootThreadId}, ${userId}, ${ORG})`
    }
    const [subT] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, type, hidden_from_list, created_by)
      VALUES (${ORG}, ${`lsc-sub-${tag}`}, 'Sub-Run', 'subrun', true, ${HOLDER}) RETURNING id`
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

    for (const [seq, content, scopes] of [
      [1, "look into the pipeline", [] as string[]],
      [2, "deal 42 closes friday at 1.2M", [SECRET]],
      [3, "deal 42 paperwork sent", [SECRET]],
      [4, "done", [] as string[]],
    ] as const) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages
          (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes,
           created_at)
        VALUES (${subrunThreadId}, ${ORG}, ${HOLDER}, 'agent', ${AGENT}, ${content}, ${scopes}::text[],
          ${`2026-04-01T00:00:0${seq}Z`}::timestamptz)
        RETURNING id`
      ids.push(row.id)
    }
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

  it("the cursor of a page whose oldest rows are hidden is a visible message id", async () => {
    // Newest first the page is s4, s3, s2 with s1 left over, so hasMore is
    // true and the pre-filter continuation point is s2, which this viewer
    // cannot see. The viewer's own rows are s4 only.
    const page = await drillDown(LACKER, ["kernel:threads:read"], 3)
    expect(page).not.toBeNull()
    expect(page!.messages.map((x: { id: string }) => x.id)).toEqual([s(4)])
    expect(page!.cursor).toBe(s(4))
    for (const hidden of [s(2), s(3)]) expect(page!.cursor).not.toBe(hidden)
    expect(JSON.stringify(page)).not.toContain(s(2))
    expect(JSON.stringify(page)).not.toContain(s(3))
    expect(JSON.stringify(page)).not.toContain("deal 42")
  })

  it("hasMore still comes from the pre-filter rows, so the short page is not the end", async () => {
    // T14's rule: three rows came back for a limit of 3 plus one more, so the
    // thread continues even though the viewer was shown a single message.
    const page = await drillDown(LACKER, ["kernel:threads:read"], 3)
    expect(page!.hasMore).toBe(true)
    expect(page!.hiddenRuns).toEqual([{ afterMessageId: null, count: 2 }])
  })

  it("paging on from that cursor reaches the rest of the thread", async () => {
    const first = await drillDown(LACKER, ["kernel:threads:read"], 3)
    const second = await drillDown(LACKER, ["kernel:threads:read"], 3, first!.cursor as string)
    expect(second).not.toBeNull()
    expect(second!.messages.map((x: { id: string }) => x.id)).toEqual([s(1)])
    expect(second!.hasMore).toBe(false)
    expect(second!.cursor).toBeNull()
  })

  it("a viewer who sees every row still gets the pre-filter continuation point", async () => {
    // Nothing changes for a viewer with the scope: the last row of the page is
    // visible to them, so it is still the cursor.
    const page = await drillDown(HOLDER, ["kernel:threads:read", SECRET], 3)
    expect(page!.messages.map((x: { id: string }) => x.id)).toEqual([s(4), s(3), s(2)])
    expect(page!.cursor).toBe(s(2))
    expect(page!.hasMore).toBe(true)
  })
})
