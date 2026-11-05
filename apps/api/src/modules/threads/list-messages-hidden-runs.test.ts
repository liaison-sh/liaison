// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2b-T14: `listMessages` post-filters what the database returned and reports
// where the viewer's hidden messages sit.
//
// Two layers, in this order:
//   1. RLS (P2b-T08) is the PRIMARY gate. Every read on the direct participant
//      path below goes through `withRlsContext`, i.e. the `liaison_rls` role
//      with the real GUCs, so a scoped row the viewer cannot see never leaves
//      Postgres.
//   2. The app mirror (`isMessageVisible`, P2b-T10) is the SECOND layer. On the
//      participant path it is assertion-only and must never fire; on the sub-run
//      drill-down (a privileged, BYPASSRLS read) it is the real filter, exactly
//      as FX1 left it.
//
// The hidden-run data (P2b-T12) cannot come from the RLS read: RLS already
// removed those rows, so the positions have to be recovered from a privileged
// read of the SAME page window. Nothing about a hidden message escapes: a run
// is a count plus the id of a message the viewer can already see.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { listMessages } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SECRET = "lhr:deals:read"
const ORG = crypto.randomUUID()
const HOLDER = crypto.randomUUID()
const LACKER = crypto.randomUUID()
const DISCLOSED = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let threadId: string
// m1 open, m2 scoped, m3 open, m4 scoped + disclosed to DISCLOSED, m5 open,
// m6 scoped, m7 scoped, m8 open. Ids in thread order.
const ids: string[] = []
const m = (n: number) => ids[n - 1]

const ctx = (userId: string, scopes: string[]): UserContext => ({
  actorType: "user",
  userId,
  orgId: ORG,
  scopes,
  dimensionGrants: {},
})

async function list(userId: string, scopes: string[], limit = 50) {
  return withRlsContext(ctx(userId, scopes), (tx) =>
    listMessages(tx, { orgId: ORG, userId, threadId, limit }),
  )
}

/** Insert one message with a deterministic created_at so thread order is stable. */
async function plant(seq: number, content: string, scopes: string[], disclosed: string[] | null) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, author_type, content, required_scopes, disclosure_list, created_at)
    VALUES (
      ${threadId}, ${ORG}, ${HOLDER}, 'user', ${content},
      ${scopes}::text[],
      ${disclosed === null ? null : disclosed}::uuid[],
      ${`2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`}::timestamptz
    )
    RETURNING id`
  ids.push(row.id)
}

describe("listMessages hidden runs and the app level visibility mirror (T14)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'LHR Org', ${`lhr-${tag}`})`
    for (const [id, name] of [
      [HOLDER, "holder"],
      [LACKER, "lacker"],
      [DISCLOSED, "disclosed"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${ORG}, ${`lhr-${name}-${tag}@test.com`}, ${name}, 'x')`
    }
    const [t] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, created_by)
      VALUES (${ORG}, ${`lhr-${tag}`}, 'Hidden runs', ${HOLDER}) RETURNING id`
    threadId = t.id
    for (const userId of [HOLDER, LACKER, DISCLOSED]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${userId}, ${ORG})`
    }

    await plant(1, "kickoff", [], null)
    await plant(2, "deal 42 closes friday", [SECRET], null)
    await plant(3, "thanks", [], null)
    await plant(4, "deal 42 margin is thin", [SECRET], [DISCLOSED])
    await plant(5, "noted", [], null)
    await plant(6, "deal 42 discount approved", [SECRET], null)
    await plant(7, "deal 42 paperwork sent", [SECRET], null)
    await plant(8, "wrapping up", [], null)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("a member lacking the scope gets neither the row nor its content, and sees a hidden run in its place", async () => {
    const result = await list(LACKER, ["kernel:threads:read"])
    expect(result).not.toBeNull()
    expect(result!.messages.map((x: { content: string | null }) => x.content)).toEqual([
      "wrapping up",
      "noted",
      "thanks",
      "kickoff",
    ])
    expect(JSON.stringify(result)).not.toContain("deal 42")
    // Thread order: m2 alone after m1, m4 alone after m3, then m6 and m7 merged after m5.
    expect(result!.hiddenRuns).toEqual([
      { afterMessageId: m(1), count: 1 },
      { afterMessageId: m(3), count: 1 },
      { afterMessageId: m(5), count: 2 },
    ])
  })

  it("a member holding the scope sees every message and no hidden run", async () => {
    const result = await list(HOLDER, ["kernel:threads:read", SECRET])
    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(8)
    expect(result!.messages.map((x: { content: string | null }) => x.content)).toContain(
      "deal 42 closes friday",
    )
    expect(result!.hiddenRuns).toEqual([])
  })

  it("a disclosure listed member sees the message disclosed to them, and only the rest is hidden", async () => {
    const result = await list(DISCLOSED, ["kernel:threads:read"])
    expect(result).not.toBeNull()
    const contents = result!.messages.map((x: { content: string | null }) => x.content)
    expect(contents).toContain("deal 42 margin is thin")
    expect(contents).not.toContain("deal 42 closes friday")
    expect(result!.hiddenRuns).toEqual([
      { afterMessageId: m(1), count: 1 },
      { afterMessageId: m(5), count: 2 },
    ])
  })

  it("a hidden run never carries a hidden message id, its scopes or its content", async () => {
    const serialised = JSON.stringify((await list(LACKER, ["kernel:threads:read"]))!.hiddenRuns)
    for (const hidden of [m(2), m(4), m(6), m(7)]) expect(serialised).not.toContain(hidden)
    expect(serialised).not.toContain(SECRET)
    expect(serialised).not.toContain("deal 42")
  })

  it("a short page from hidden rows still reports hasMore, and runs cover only that page", async () => {
    // Newest first, the viewer's visible rows are m8, m5, m3, m1. A limit of 3
    // returns three of them with hasMore true: the caller must not read the
    // short page as the end of the thread.
    const page = await list(LACKER, ["kernel:threads:read"], 3)
    expect(page).not.toBeNull()
    expect(page!.messages.map((x: { id: string }) => x.id)).toEqual([m(8), m(5), m(3)])
    expect(page!.hasMore).toBe(true)
    expect(page!.cursor).toBe(m(3))
    // The page spans m3..m8, so it reports the gaps inside it and nothing older.
    expect(page!.hiddenRuns).toEqual([
      { afterMessageId: m(3), count: 1 },
      { afterMessageId: m(5), count: 2 },
    ])
  })
})

// The sub-run drill-down reads through the privileged pool, where the mirror is
// the only filter. FX1 made that read per viewer; T14 must not double filter it
// or change what it returns, and the hidden runs must be reported there too.
describe("listMessages sub-run drill-down keeps FX1 behaviour and reports its runs", () => {
  const SORG = crypto.randomUUID()
  const SHOLDER = crypto.randomUUID()
  const SLACKER = crypto.randomUUID()
  const SAGENT = crypto.randomUUID()
  const stag = crypto.randomUUID().slice(0, 8)
  let rootThreadId: string
  let subrunThreadId: string
  const subIds: string[] = []

  async function drillDown(userId: string, scopes: string[]) {
    return withRlsContext(
      { actorType: "user", userId, orgId: SORG, scopes, dimensionGrants: {} },
      (tx) => listMessages(tx, { orgId: SORG, userId, threadId: subrunThreadId, limit: 50 }),
    )
  }

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${SORG}, 'LHR Sub', ${`lhrs-${stag}`})`
    for (const [id, name] of [
      [SHOLDER, "sholder"],
      [SLACKER, "slacker"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${SORG}, ${`lhrs-${name}-${stag}@test.com`}, ${name}, 'x')`
    }
    // The speaking agent: an agent-authored row names it (0080).
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${SAGENT}, ${SORG}, 'personal', ${`@lhrs-${stag}`}, 'Holder agent', ${SHOLDER})`
    // The drill-down resolves the viewer's grants from the database, not the GUC.
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${SHOLDER}, ${SORG}, ${SECRET})`

    const [rootT] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, type, created_by)
      VALUES (${SORG}, ${`lhrs-root-${stag}`}, 'Root', 'thread', ${SHOLDER}) RETURNING id`
    rootThreadId = rootT.id
    for (const userId of [SHOLDER, SLACKER]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${rootThreadId}, ${userId}, ${SORG})`
    }
    const [subT] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, title, type, hidden_from_list, created_by)
      VALUES (${SORG}, ${`lhrs-sub-${stag}`}, 'Sub-Run', 'subrun', true, ${SHOLDER}) RETURNING id`
    subrunThreadId = subT.id

    const rootRunId = crypto.randomUUID()
    const childRunId = crypto.randomUUID()
    const actorJson = JSON.stringify({
      actorType: "user",
      userId: SHOLDER,
      orgId: SORG,
      scopes: [],
      dimensionGrants: {},
    })
    await sql`INSERT INTO kernel.agent_runs (
      id, org_id, parent_run_id, root_run_id, thread_id, subagent_type, actor,
      effective_scopes, status, prompt, max_steps, timeout_ms, schema_retry_budget, nesting_depth
    ) VALUES (
      ${rootRunId}, ${SORG}, NULL, ${rootRunId}, ${rootThreadId}, NULL, ${actorJson}::jsonb,
      ARRAY[]::text[], 'running', '', 10, 60000, 3, 0)`
    await sql`INSERT INTO kernel.agent_runs (
      id, org_id, parent_run_id, root_run_id, thread_id, subagent_type, actor,
      effective_scopes, status, prompt, max_steps, timeout_ms, schema_retry_budget, nesting_depth
    ) VALUES (
      ${childRunId}, ${SORG}, ${rootRunId}, ${rootRunId}, ${subrunThreadId}, 'investigator',
      ${actorJson}::jsonb, ARRAY[]::text[], 'running', '', 10, 60000, 3, 1)`

    for (const [seq, content, scopes] of [
      [1, "look into the pipeline", [] as string[]],
      [2, "deal 42 closes friday at 1.2M", [SECRET]],
      [3, "done", [] as string[]],
    ] as const) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages
          (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes,
           created_at)
        VALUES (${subrunThreadId}, ${SORG}, ${SHOLDER}, 'agent', ${SAGENT}, ${content}, ${scopes}::text[],
          ${`2026-02-01T00:00:0${seq}Z`}::timestamptz)
        RETURNING id`
      subIds.push(row.id)
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${SORG}`
    await sql`DELETE FROM kernel.agent_runs WHERE org_id = ${SORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${SORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${SORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${SORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${SORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${SORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${SORG}`
    await releaseTestLock()
  })

  it("a root participant lacking the scope still gets the untagged rows only, now with the run", async () => {
    const result = await drillDown(SLACKER, ["kernel:threads:read"])
    expect(result).not.toBeNull()
    expect(result!.messages.map((x: { content: string | null }) => x.content)).toEqual([
      "done",
      "look into the pipeline",
    ])
    expect(JSON.stringify(result)).not.toContain("1.2M")
    expect(result!.hiddenRuns).toEqual([{ afterMessageId: subIds[0], count: 1 }])
  })

  it("a root participant holding the scope gets every row and no run", async () => {
    const result = await drillDown(SHOLDER, ["kernel:threads:read", SECRET])
    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(3)
    expect(result!.hiddenRuns).toEqual([])
  })
})

// The run at the EDGE of the thread. The window the runs are recovered from was
// clamped to the page's oldest and newest VISIBLE rows, which silently dropped
// every hidden message sitting past them. That is not a rare shape: an agent's
// scoped answer is the newest row in the thread, so the everyday case (a DM
// whose last turn the viewer may not read) reported `hiddenRuns: []` and the
// "{n} messages hidden" marker (spec-security.md, "Hidden-message marker")
// could never render. A page that reaches an end of the thread has no further
// page to report that run, so the window has to be open at that end.
describe("listMessages reports a hidden run at either end of the thread", () => {
  const EORG = crypto.randomUUID()
  const EHOLDER = crypto.randomUUID()
  const ELACKER = crypto.randomUUID()
  const etag = crypto.randomUUID().slice(0, 8)
  let tailThreadId: string
  let headThreadId: string
  const tailIds: string[] = []
  const headIds: string[] = []

  const read = (threadId: string, limit = 50) =>
    withRlsContext(
      {
        actorType: "user",
        userId: ELACKER,
        orgId: EORG,
        scopes: ["kernel:threads:read"],
        dimensionGrants: {},
      },
      (tx) => listMessages(tx, { orgId: EORG, userId: ELACKER, threadId, limit }),
    )

  async function plantIn(threadId: string, into: string[], seq: number, scopes: string[]) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, required_scopes, created_at)
      VALUES (${threadId}, ${EORG}, ${EHOLDER}, 'user', ${`msg ${seq}`}, ${scopes}::text[],
        ${`2026-03-01T00:00:${String(seq).padStart(2, "0")}Z`}::timestamptz)
      RETURNING id`
    into.push(row.id)
  }

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${EORG}, 'LHR Edge', ${`lhre-${etag}`})`
    for (const [id, name] of [
      [EHOLDER, "eholder"],
      [ELACKER, "elacker"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${id}, ${EORG}, ${`lhre-${name}-${etag}@test.com`}, ${name}, 'x')`
    }
    for (const [handle, title, ref] of [
      [`lhre-tail-${etag}`, "Tail", "tail"],
      [`lhre-head-${etag}`, "Head", "head"],
    ] as const) {
      const [t] = await sql<{ id: string }[]>`
        INSERT INTO kernel.threads (org_id, handle, title, created_by)
        VALUES (${EORG}, ${handle}, ${title}, ${EHOLDER}) RETURNING id`
      if (ref === "tail") tailThreadId = t.id
      else headThreadId = t.id
      for (const userId of [EHOLDER, ELACKER]) {
        await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
          VALUES (${t.id}, ${userId}, ${EORG})`
      }
    }
    // Tail thread: one open message, then two consecutive scoped ones (the agent
    // answering with scoped data as the last thing said).
    await plantIn(tailThreadId, tailIds, 1, [])
    await plantIn(tailThreadId, tailIds, 2, [SECRET])
    await plantIn(tailThreadId, tailIds, 3, [SECRET])
    // Head thread: two consecutive scoped messages at the very top, then three open ones.
    await plantIn(headThreadId, headIds, 1, [SECRET])
    await plantIn(headThreadId, headIds, 2, [SECRET])
    await plantIn(headThreadId, headIds, 3, [])
    await plantIn(headThreadId, headIds, 4, [])
    await plantIn(headThreadId, headIds, 5, [])
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${EORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${EORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${EORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${EORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${EORG}`
    await releaseTestLock()
  })

  it("two consecutive withheld messages at the NEWEST end are one run of 2", async () => {
    const result = await read(tailThreadId)
    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(1)
    expect(result!.hiddenRuns).toEqual([{ afterMessageId: tailIds[0], count: 2 }])
    // Still nothing about the hidden rows themselves.
    const serialised = JSON.stringify(result!.hiddenRuns)
    expect(serialised).not.toContain(tailIds[1])
    expect(serialised).not.toContain(tailIds[2])
    expect(serialised).not.toContain(SECRET)
  })

  it("two consecutive withheld messages at the OLDEST end are one run of 2 anchored at the top", async () => {
    const result = await read(headThreadId)
    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(3)
    expect(result!.hiddenRuns).toEqual([{ afterMessageId: null, count: 2 }])
  })

  it("a page that does NOT reach the oldest end still reports only what it covers", async () => {
    // Two of the three visible rows, so `hasMore` is true: older messages remain
    // and the leading run belongs to the page that reaches them, not to this one.
    const page = await read(headThreadId, 2)
    expect(page).not.toBeNull()
    expect(page!.hasMore).toBe(true)
    expect(page!.hiddenRuns).toEqual([])
  })
})
