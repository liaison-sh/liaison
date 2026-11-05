// SPDX-License-Identifier: FSL-1.1-ALv2
// P4m-T21: memory_search, three legs fused by reciprocal rank fusion, with the
// DATABASE visibility re-check as the backstop behind Meili's filter.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import * as searchClientModule from "~/infra/search/client"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"

const ORG_ID = crypto.randomUUID()
const USER_A = crypto.randomUUID()
const AGENT_A = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const WINDOW_THREAD_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const THREADS_READ = "kernel:threads:read"
const SCOPE = "crm:deals:read"
const INDEX_NAME = `test_p4mt21_${crypto.randomUUID().slice(0, 8)}`

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

function realClient() {
  return meili as unknown as ReturnType<typeof searchClientModule.getMeili>
}

const spies: Array<{ mockRestore: () => void }> = []

const actorA: UserContext = {
  actorType: "user",
  userId: USER_A,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

/** The turn's own floor, which is NOT the RLS actor's grants: the backstop. */
function ctxFor(tx: unknown, scopes: string[] = []) {
  return { userId: USER_A, orgId: ORG_ID, db: tx, scopes } as never
}

let staleMessageId = ""

describe("memory search", () => {
  // The org has no Google key: the lexical and transcript legs, no embedding
  // call. The test preload's placeholder key would send every index and query
  // embedding to Google.
  let savedGoogleKey: string | undefined

  beforeAll(async () => {
    savedGoogleKey = process.env.GOOGLE_API_KEY
    process.env.GOOGLE_API_KEY = ""
    ExternalSearchHandlersTestAccess.reset()
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
    spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(realClient()))

    const { expectedSettings } = await import("~/modules/search/drift")
    const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
    await meili.tasks.waitForTask(created.taskUid)
    const applied = await meili
      .index(INDEX_NAME)
      .updateSettings(
        expectedSettings({ registeredReadScopes: [THREADS_READ], dimensionFields: [] }),
      )
    await meili.tasks.waitForTask(applied.taskUid)

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'MemSearchOrg', ${`mem-search-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, ${`mem-search-${tag}@test.com`}, 'Mem A', 'x')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id)
      VALUES (${AGENT_A}, ${ORG_ID}, 'personal', ${`memsearch${tag}`}, 'Liaison', ${USER_A})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`memsearchthread${tag}`}, ${USER_A})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${USER_A}, ${ORG_ID})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${WINDOW_THREAD_ID}, ${ORG_ID}, ${`memwindow${tag}`}, ${USER_A})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${WINDOW_THREAD_ID}, ${USER_A}, ${ORG_ID})`

    // The STALE document: indexed while the row carried no scopes, then the row
    // was narrowed. Meili's fast path still admits it; only the database
    // predicate knows the truth.
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_A}, 'the kryptonite carrier account number is 55123', '{}'::text[])
      RETURNING id`
    staleMessageId = row.id
    const { processMessageIndexerJob } = await import("~/modules/search/message-indexer")
    await processMessageIndexerJob({ action: "upsert", orgId: ORG_ID, messageId: staleMessageId })
    await sql`UPDATE kernel.messages SET required_scopes = ${[SCOPE]}::text[] WHERE id = ${staleMessageId}`
  })

  afterAll(async () => {
    process.env.GOOGLE_API_KEY = savedGoogleKey
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    const deleted = await meili.deleteIndex(INDEX_NAME)
    await meili.tasks.waitForTask(deleted.taskUid)
    for (const s of spies) s.mockRestore()
  })

  it("three legs are fused by reciprocal rank fusion with k 60", async () => {
    const { fuseLegs, RRF_K } = await import("./memory-search")
    expect(RRF_K).toBe(60)
    const shared = { key: "shared", requiredScopes: [] as string[] }
    const fused = fuseLegs([
      [shared, { key: "a2", requiredScopes: [] }],
      [{ key: "b1", requiredScopes: [] }, { key: "b2", requiredScopes: [] }, shared],
    ])
    const hit = fused.find((h) => h.key === "shared")
    expect(hit).toBeDefined()
    // Rank 1 in the first leg, rank 3 in the second.
    expect(hit?.fusedScore).toBeCloseTo(1 / 61 + 1 / 63, 6)
    // And it outranks anything that appeared in one leg only.
    expect(fused[0].key).toBe("shared")
  })

  // THE AGENT'S OWN MEMBERSHIP (spec-memory.md: "an agent that joins a channel
  // late has no checkpoint before its join point and the transcript index
  // returns nothing before it", and the charter's "the verbatim messages you
  // were allowed to read"). The re-check joined thread_participants on the
  // REQUESTING HUMAN alone, so a recall in a brand new room returned verbatim
  // messages out of a room the agent was never seated in: another thread's
  // conversation, in this turn's prompt, wearing a citation.
  it("a recall returns nothing verbatim from a room the agent was never seated in", async () => {
    const OTHER_THREAD = crypto.randomUUID()
    const OTHER_AGENT = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${OTHER_AGENT}, ${ORG_ID}, 'role', ${`memother${tag}`}, 'Other Desk', '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${OTHER_THREAD}, ${ORG_ID}, ${`memotherthread${tag}`}, ${USER_A})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${OTHER_THREAD}, ${USER_A}, ${ORG_ID})`
    // The room has an agent seat, and it is NOT the recalling agent's.
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${OTHER_THREAD}, ${OTHER_AGENT}, ${ORG_ID}, 'agent')`
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${OTHER_THREAD}, ${ORG_ID}, ${USER_A}, 'zylophone ledger reconciliation is on Thursday', '{}'::text[])
      RETURNING id`
    const { processMessageIndexerJob } = await import("~/modules/search/message-indexer")
    await processMessageIndexerJob({ action: "upsert", orgId: ORG_ID, messageId: row.id })

    const { memorySearch } = await import("./memory-search")
    // The human is in that room and finds it: the message is genuinely indexed
    // and genuinely visible, so the drop below is the agent predicate.
    const asHuman = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "zylophone ledger reconciliation" }, ctxFor(tx, [THREADS_READ])),
    )
    expect(asHuman.hits.some((h) => h.messageId === row.id)).toBe(true)

    const asAgent = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "zylophone ledger reconciliation" }, {
        ...(ctxFor(tx, [THREADS_READ]) as Record<string, unknown>),
        recallAgentId: AGENT_A,
      } as never),
    )
    expect(asAgent.hits.some((h) => h.messageId === row.id)).toBe(false)

    await sql`DELETE FROM kernel.messages WHERE thread_id = ${OTHER_THREAD}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${OTHER_THREAD}`
    await sql`DELETE FROM kernel.threads WHERE id = ${OTHER_THREAD}`
    await sql`DELETE FROM kernel.agents WHERE id = ${OTHER_AGENT}`
  })

  // Invariant I5 for the brief's own rows. The brief row and episode documents
  // used to carry the agents seated by their anchor (`participant_agent_ids`),
  // but no query filtered on it, and the database re-check joined the human
  // alone: an agent seated late recalled a decision drawn from before its seat.
  it("a brief row from before the recalling agent's seat is not recalled by it", async () => {
    const ROOM = crypto.randomUUID()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${ROOM}, ${ORG_ID}, ${`memlate${tag}`}, ${USER_A})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${ROOM}, ${USER_A}, ${ORG_ID})`
    const [early] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes, created_at)
      VALUES (${ROOM}, ${ORG_ID}, ${USER_A}, 'we pick the quokka courier', '{}'::text[],
        now() - interval '1 hour')
      RETURNING id`
    // The agent takes its seat AFTER that message.
    await sql`INSERT INTO kernel.thread_participants (thread_id, agent_id, org_id, participant_type)
      VALUES (${ROOM}, ${AGENT_A}, ${ORG_ID}, 'agent')`
    const [brief] = await sql<{ id: string }[]>`
      INSERT INTO kernel.thread_briefs (org_id, thread_id, kind, key, value, message_ids, first_message_id)
      VALUES (${ORG_ID}, ${ROOM}, 'decision', 'quokka courier', 'chosen for October',
        ${[early.id]}::uuid[], ${early.id})
      RETURNING id`
    const { processBriefIndexerJob } = await import("~/modules/search/message-indexer")
    await processBriefIndexerJob({
      action: "upsert",
      kind: "brief_row",
      orgId: ORG_ID,
      id: brief.id,
    })

    const { memorySearch } = await import("./memory-search")
    const asHuman = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "quokka courier" }, ctxFor(tx, [THREADS_READ])),
    )
    expect(asHuman.hits.some((h) => h.key === `brief_row:${brief.id}`)).toBe(true)
    const asAgent = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "quokka courier" }, {
        ...(ctxFor(tx, [THREADS_READ]) as Record<string, unknown>),
        recallAgentId: AGENT_A,
      } as never),
    )
    expect(asAgent.hits.some((h) => h.key === `brief_row:${brief.id}`)).toBe(false)

    await sql`DELETE FROM kernel.thread_briefs WHERE thread_id = ${ROOM}`
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${ROOM}`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id = ${ROOM}`
    await sql`DELETE FROM kernel.threads WHERE id = ${ROOM}`
  })

  it("a transcript hit that passes the Meili filter but fails the database predicate is dropped", async () => {
    const { memorySearch } = await import("./memory-search")
    const res = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "kryptonite carrier account" }, ctxFor(tx, [])),
    )
    expect(res.hits.filter((h) => h.kind === "transcript").length).toBe(0)
    // The very same query, run by a caller that holds the scope, finds it: the
    // drop above is the predicate, not a broken query.
    const held = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "kryptonite carrier account" }, ctxFor(tx, [SCOPE, THREADS_READ])),
    )
    expect(held.hits.some((h) => h.messageId === staleMessageId)).toBe(true)
  })

  // FX3-2. THE RECALL QUERY IS A QUESTION, NOT A KEYWORD LINE. Auto recall
  // searches with the incoming message verbatim, and Meili's default matching
  // strategy ("last") drops terms from the END, so every leading word of the
  // query is effectively required: "What is the kryptonite carrier account
  // number?" matched NOTHING, while the same question shorn of its opening
  // words matched. Every natural language question a human actually asks
  // starts with words the answer does not contain, so the transcript leg was
  // dead on the path that needs it most.
  it("a natural language question finds the message that answers it", async () => {
    const { memorySearch } = await import("./memory-search")
    const keywords = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "kryptonite carrier account" }, ctxFor(tx, [SCOPE, THREADS_READ])),
    )
    expect(keywords.hits.some((h) => h.messageId === staleMessageId)).toBe(true)
    const question = await withRlsContext(actorA, (tx) =>
      memorySearch(
        { query: "What is the kryptonite carrier account number we agreed?" },
        ctxFor(tx, [SCOPE, THREADS_READ]),
      ),
    )
    expect(question.hits.some((h) => h.messageId === staleMessageId)).toBe(true)
  })

  it("the result payload is capped at 1000 tokens", async () => {
    const { memorySearch, MEMORY_SEARCH_PAYLOAD_TOKEN_CAP } = await import("./memory-search")
    const { estimateTokens } = await import("~/modules/agent/context/compaction")
    const body = `zeppelin ${"lorem ipsum dolor sit amet consectetur ".repeat(40)}`
    for (let i = 0; i < 50; i++) {
      await sql`INSERT INTO kernel.agent_memory
        (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
        VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'project', ${`zeppelin-${i}`},
          ${`zeppelin note ${i}`}, ${body}, ${`project/zeppelin-${i}.md`}, '{}'::text[])`
    }
    const res = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "zeppelin", limit: 20 }, ctxFor(tx, [])),
    )
    expect(res.hits.length).toBeGreaterThanOrEqual(1)
    expect(estimateTokens(JSON.stringify(res.hits))).toBeLessThanOrEqual(
      MEMORY_SEARCH_PAYLOAD_TOKEN_CAP,
    )
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  it("a superseded file is absent unless includeSuperseded is set", async () => {
    const { memorySearch } = await import("./memory-search")
    await sql`INSERT INTO kernel.agent_memory
      (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes, superseded_at)
      VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'project', 'sturgeon', 'the sturgeon quota',
        'The sturgeon quota was 40.', 'project/sturgeon.md', '{}'::text[], now())`
    const without = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "sturgeon quota" }, ctxFor(tx, [])),
    )
    expect(without.hits.filter((h) => h.path === "project/sturgeon.md").length).toBe(0)
    const withSuperseded = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "sturgeon quota", includeSuperseded: true }, ctxFor(tx, [])),
    )
    expect(withSuperseded.hits.filter((h) => h.path === "project/sturgeon.md").length).toBe(1)
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  it("a checkpoint file is never returned", async () => {
    const { memorySearch } = await import("./memory-search")
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, summary, required_scopes, token_estimate, version)
      VALUES (${ORG_ID}, ${AGENT_A}, ${THREAD_ID}, 'The narwhal contract was signed.', '{}'::text[], 8, 1)`
    const res = await withRlsContext(actorA, (tx) =>
      memorySearch({ query: "narwhal contract" }, ctxFor(tx, [])),
    )
    expect(res.hits.filter((h) => (h.path ?? "").startsWith("checkpoints/")).length).toBe(0)
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
  })

  // --- P4m-T22: memory_open, the verbatim window --------------------------

  it("a ROLE agent's turn recalls the agent's own files, never the human's", async () => {
    const roleAgent = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${roleAgent}, ${ORG_ID}, 'role', ${`memrole${tag}`}, 'Logistics')`
    await sql`INSERT INTO kernel.agent_memory
      (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
      VALUES (${ORG_ID}, NULL, ${roleAgent}, 'project', 'rolefile', 'The role agent note',
        'The pangolin route is booked.', 'project/rolefile.md', '{}'::text[])`
    await sql`INSERT INTO kernel.agent_memory
      (org_id, user_id, owner_agent_id, type, name, description, content, path, required_scopes)
      VALUES (${ORG_ID}, ${USER_A}, ${AGENT_A}, 'project', 'humanfile', 'The human note',
        'The pangolin route is a secret.', 'project/humanfile.md', '{}'::text[])`
    try {
      const { memorySearch } = await import("./memory-search")
      const res = await withRlsContext(actorA, (tx) =>
        memorySearch({ query: "pangolin route" }, {
          userId: USER_A,
          orgId: ORG_ID,
          db: tx,
          scopes: ["*"],
          recallAgentId: roleAgent,
          recallThreadId: THREAD_ID,
        } as never),
      )
      const paths = res.hits.map((h) => h.path)
      expect(paths).toContain("project/rolefile.md")
      expect(paths).not.toContain("project/humanfile.md")
    } finally {
      await sql`DELETE FROM kernel.agent_memory WHERE owner_agent_id IN (${roleAgent}, ${AGENT_A})`
      await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.agents WHERE id = ${roleAgent}`
    }
  })

  it("memory_open returns at most 40 messages", async () => {
    const { memoryOpen, MEMORY_OPEN_MAX_MESSAGES } = await import("./memory-search")
    expect(MEMORY_OPEN_MAX_MESSAGES).toBe(40)
    const ids: string[] = []
    for (let i = 0; i < 60; i++) {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
        VALUES (${WINDOW_THREAD_ID}, ${ORG_ID}, ${USER_A}, ${`window line ${i}`}, '{}'::text[])
        RETURNING id`
      ids.push(row.id)
    }
    const res = await withRlsContext(actorA, (tx) =>
      memoryOpen({ messageId: ids[30], before: 100, after: 100 }, ctxFor(tx, [])),
    )
    expect(res.messages.length).toBe(40)
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${WINDOW_THREAD_ID}`
  })

  it("memory_open drops a message the caller may not see", async () => {
    const { memoryOpen } = await import("./memory-search")
    const ids: string[] = []
    for (let i = 0; i < 10; i++) {
      const scopes = i === 2 || i === 5 || i === 8 ? [SCOPE] : []
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
        VALUES (${WINDOW_THREAD_ID}, ${ORG_ID}, ${USER_A}, ${`scoped line ${i}`}, ${scopes}::text[])
        RETURNING id`
      ids.push(row.id)
    }
    const res = await withRlsContext(actorA, (tx) =>
      memoryOpen({ messageId: ids[0], before: 0, after: 9 }, ctxFor(tx, [])),
    )
    expect(res.messages.length).toBe(7)
    expect(res.messages.some((m) => m.content === "scoped line 2")).toBe(false)
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${WINDOW_THREAD_ID}`
  })

  it("memory_open on an invisible anchor message returns nothing", async () => {
    const { memoryOpen } = await import("./memory-search")
    const [anchor] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
      VALUES (${WINDOW_THREAD_ID}, ${ORG_ID}, ${USER_A}, 'the hidden anchor', ${[SCOPE]}::text[])
      RETURNING id`
    for (let i = 0; i < 4; i++) {
      await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, content, required_scopes)
        VALUES (${WINDOW_THREAD_ID}, ${ORG_ID}, ${USER_A}, ${`around ${i}`}, '{}'::text[])`
    }
    const res = await withRlsContext(actorA, (tx) =>
      memoryOpen({ messageId: anchor.id, before: 5, after: 5 }, ctxFor(tx, [])),
    )
    expect(res.messages.length).toBe(0)
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${WINDOW_THREAD_ID}`
  })
})
