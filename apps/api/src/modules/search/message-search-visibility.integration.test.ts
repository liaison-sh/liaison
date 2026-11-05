// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2b-T26: a search never returns a message the searcher cannot see
// (spec-security.md D16, the mandatory regression test).
//
// Two layers, both real here:
//   1. the Meili filter narrows with `required_scopes IN [...]` (P2b-T25 made
//      the attribute filterable),
//   2. a DB post-filter re-reads every message hit and answers with
//      `isMessageVisible` (P2b-T10) AND thread membership, because the indexed
//      document carries neither the disclosure list nor the room.
//
// Neither layer alone is the gate: the disclosure branch only exists in the
// database, and membership is not in the document at all. So every case below
// runs against a REAL Meili index holding documents written by the REAL
// indexer, over REAL rows in Postgres.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import * as privilegedModule from "~/db/privileged"
import * as searchClientModule from "~/infra/search/client"
import { ExternalSearchHandlersTestAccess } from "~/modules/search/external-handlers"
import { collectSearchableRegistrations } from "~/modules/search/searchable-entities"

const ORG_ID = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const HOLDER = crypto.randomUUID() // member, holds the scope
const LACKER = crypto.randomUUID() // member, lacks the scope, not disclosed to
const DISCLOSED = crypto.randomUUID() // member, lacks the scope, on the disclosure list
const OUTSIDER = crypto.randomUUID() // same org, holds the scope, NOT in the room
const tag = ORG_ID.slice(0, 8)

const THREADS_READ = "kernel:threads:read"
const SCOPE = "crm:deals:read"
const UNRELATED_SCOPE = "support:tickets:read"
const QUERY = "pennylane"
const SCOPED_CONTENT = "the pennylane payout ledger reconciles at 12480 euros"
const DISCLOSED_CONTENT = "the pennylane payout ledger was shared anyway once"
const OPEN_CONTENT = "the pennylane payout ledger is open to the whole room"
const GHOST_CONTENT = "the pennylane payout ledger row vanished after indexing"

const INDEX_NAME = `test_p2bt26_${crypto.randomUUID().slice(0, 8)}`
const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

/** Every Meili search the service issues, so the engine layer is inspectable. */
const searches: Array<{ q: string; filter?: string }> = []

function recordingClient() {
  return {
    index: (name: string) => {
      const real = meili.index(name)
      return {
        search: async (q: string, opts: Record<string, unknown>) => {
          searches.push({ q, filter: opts?.filter as string | undefined })
          return await real.search(q, opts)
        },
        addDocuments: (docs: unknown[]) => real.addDocuments(docs as never),
        deleteDocument: (id: string) => real.deleteDocument(id),
        getDocuments: (args: unknown) => real.getDocuments(args as never),
        deleteDocuments: (ids: unknown) => real.deleteDocuments(ids as never),
        updateSettings: (s: unknown) => real.updateSettings(s as never),
      }
    },
    tasks: meili.tasks,
    // A recording stand-in for the Meili client: every method the search path
    // and the indexer touch, delegating to the real index.
  } as unknown as ReturnType<typeof searchClientModule.getMeili>
}

const spies: Array<{ mockRestore: () => void }> = []

let scopedId = ""
let disclosedId = ""
let openId = ""
let ghostId = ""

async function importService() {
  return await import("./service")
}

async function insertMessage(
  content: string,
  requiredScopes: string[],
  disclosureList: string[] | null,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO kernel.messages
      (thread_id, org_id, author_id, content, required_scopes, disclosure_list)
    VALUES (${THREAD_ID}, ${ORG_ID}, ${HOLDER}, ${content},
      ${requiredScopes}::text[], ${disclosureList}::uuid[])
    RETURNING id`
  return row?.id ?? ""
}

async function pageFor(userId: string, grants: string[], q: string = QUERY) {
  const { pageSearch } = await importService()
  return await pageSearch({
    orgId: ORG_ID,
    userId,
    scopes: grants,
    q,
    limit: 20,
    offset: 0,
    filters: {},
  })
}

async function messageHitIds(
  userId: string,
  grants: string[],
  q: string = QUERY,
): Promise<string[]> {
  const res = await pageFor(userId, grants, q)
  return res.hits.filter((h) => h.entity_type === "message").map((h) => String(h.entity_id ?? h.id))
}

beforeAll(async () => {
  ExternalSearchHandlersTestAccess.reset()
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
  spies.push(spyOn(searchClientModule, "getMeili").mockReturnValue(recordingClient()))

  const { expectedSettings } = await import("./drift")
  const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const applied = await meili.index(INDEX_NAME).updateSettings(
    expectedSettings({
      registeredReadScopes: [THREADS_READ],
      dimensionFields: [],
      aclFieldNames: collectSearchableRegistrations(ORG_ID).aclFieldNames,
    }),
  )
  await meili.tasks.waitForTask(applied.taskUid)

  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG_ID}, 'MsgSearchVisOrg', ${`msg-search-vis-${tag}`})`
  for (const [id, name] of [
    [HOLDER, "holder"],
    [LACKER, "lacker"],
    [DISCLOSED, "disclosed"],
    [OUTSIDER, "outsider"],
  ] as const) {
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${id}, ${ORG_ID}, ${`msg-search-${name}-${tag}@test.com`}, ${name}, 'x')`
  }
  await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
    VALUES (${THREAD_ID}, ${ORG_ID}, ${`msg-search-vis-${tag}`}, ${HOLDER})`
  for (const userId of [HOLDER, LACKER, DISCLOSED]) {
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${userId}, ${ORG_ID})`
  }

  scopedId = await insertMessage(SCOPED_CONTENT, [SCOPE], null)
  disclosedId = await insertMessage(DISCLOSED_CONTENT, [SCOPE], [DISCLOSED])
  openId = await insertMessage(OPEN_CONTENT, [], null)
  ghostId = await insertMessage(GHOST_CONTENT, [], null)

  // Index through the REAL indexer, reading the REAL rows.
  const { processMessageIndexerJob } = await import("./message-indexer")
  for (const messageId of [scopedId, disclosedId, openId, ghostId]) {
    await processMessageIndexerJob({ action: "upsert", orgId: ORG_ID, messageId })
  }

  // The ghost: its document stays, its row does not. A hit whose visibility
  // cannot be determined must be dropped, never surfaced.
  await sql`DELETE FROM kernel.messages WHERE id = ${ghostId}`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  const deleted = await meili.deleteIndex(INDEX_NAME)
  await meili.tasks.waitForTask(deleted.taskUid)
  for (const s of spies) s.mockRestore()
  spies.length = 0
})

describe("message search visibility: the searcher never sees what they cannot read", () => {
  it("a search result set includes a message once the searcher gains its required scope", async () => {
    const withScope = await messageHitIds(HOLDER, [THREADS_READ, SCOPE])
    expect(withScope).toContain(scopedId)

    // The same searcher, same query, without the grant: gone.
    const withoutScope = await messageHitIds(HOLDER, [THREADS_READ, UNRELATED_SCOPE])
    expect(withoutScope).not.toContain(scopedId)
  })

  it("a search result set never includes a message the searcher lacks requiredScopes or disclosure for, even when the query matches its content exactly", async () => {
    const byContent = await messageHitIds(LACKER, [THREADS_READ, UNRELATED_SCOPE], SCOPED_CONTENT)
    expect(byContent).not.toContain(scopedId)
    expect(byContent).not.toContain(disclosedId)

    const byKeyword = await messageHitIds(LACKER, [THREADS_READ, UNRELATED_SCOPE])
    expect(byKeyword).not.toContain(scopedId)
    expect(byKeyword).not.toContain(disclosedId)

    const { globalSearch } = await importService()
    const global = await globalSearch({
      orgId: ORG_ID,
      userId: LACKER,
      scopes: [THREADS_READ, UNRELATED_SCOPE],
      q: SCOPED_CONTENT,
      limit: 20,
    })
    expect(global.entities.map((e) => e.id)).not.toContain(scopedId)
  })

  it("the engine layer already narrows: the filter carries the scope clause and Meili itself withholds the message", async () => {
    searches.length = 0
    await messageHitIds(LACKER, [THREADS_READ, UNRELATED_SCOPE], SCOPED_CONTENT)
    const filter = searches.at(-1)?.filter ?? ""
    expect(filter).toContain("NOT required_scopes EXISTS")
    expect(filter).toContain(`required_scopes IN ["${THREADS_READ}","${UNRELATED_SCOPE}"]`)

    // Replay the exact filter the service sent: the scoped document never even
    // reaches the post-filter, so the narrowing is real and not a mirage of
    // the DB pass.
    const raw = await meili.index(INDEX_NAME).search(SCOPED_CONTENT, { filter })
    expect(raw.hits.map((h) => h.entity_id)).not.toContain(scopedId)
  })

  it("the post-filter is the backstop: a disclosure-listed searcher finds the message although they lack its scope", async () => {
    const ids = await messageHitIds(DISCLOSED, [THREADS_READ])
    expect(ids).toContain(disclosedId)
    // Disclosure is per message: the other scoped message stays hidden.
    expect(ids).not.toContain(scopedId)
  })

  it("an untagged message behaves as before for every member", async () => {
    expect(await messageHitIds(HOLDER, [THREADS_READ, SCOPE])).toContain(openId)
    expect(await messageHitIds(LACKER, [THREADS_READ, UNRELATED_SCOPE])).toContain(openId)
    expect(await messageHitIds(DISCLOSED, [THREADS_READ])).toContain(openId)
  })

  it("a non-member finds nothing, even holding the scope", async () => {
    const ids = await messageHitIds(OUTSIDER, [THREADS_READ, SCOPE])
    expect(ids).toEqual([])
    const exact = await messageHitIds(OUTSIDER, [THREADS_READ, SCOPE], SCOPED_CONTENT)
    expect(exact).toEqual([])
  })

  it("the reported total never counts a message the searcher cannot see", async () => {
    // The content-presence oracle. A message document carries no
    // participant_ids, so the permission filter admits it for every member
    // holding kernel:threads:read, and `NOT required_scopes EXISTS` admits
    // every untagged one. Membership is re-established only in the DB
    // post-filter, so a count taken before that filter answers "there is
    // something here you may not read" to a searcher who is in no such room.
    const res = await pageFor(OUTSIDER, [THREADS_READ, SCOPE])
    expect(res.hits).toEqual([])
    expect(res.total).toBe(0)
  })

  it("the reported total drops a scoped hit the engine clause could not narrow", async () => {
    // A grant carrying `*` covers scope strings the IN list cannot enumerate,
    // so the engine clause is skipped entirely and every message document
    // reaches the post-filter. The count must follow the post-filter, not the
    // engine: this member may read only the untagged message.
    const res = await pageFor(LACKER, [THREADS_READ, "support:*"])
    const ids = res.hits.map((h) => String(h.entity_id ?? h.id))
    expect(ids).not.toContain(scopedId)
    expect(ids).not.toContain(disclosedId)
    expect(ids).toContain(openId)
    // Every match fits on this page, so the corrected count is exact here.
    expect(res.total).toBe(res.hits.length)
  })

  it("a hit whose visibility cannot be determined is dropped", async () => {
    // The row is gone; only the document survives.
    const ids = await messageHitIds(HOLDER, [THREADS_READ, SCOPE], GHOST_CONTENT)
    expect(ids).not.toContain(ghostId)
    // It really is still in the index: the drop is the post-filter's doing.
    const raw = await meili.index(INDEX_NAME).search(GHOST_CONTENT, {
      filter: `org_id = "${ORG_ID}" AND entity_type = "message"`,
    })
    expect(raw.hits.map((h) => h.entity_id)).toContain(ghostId)
  })

  it("a visibility read that fails drops every message hit rather than passing it through", async () => {
    const boom = spyOn(privilegedModule, "withPrivilegedDb").mockImplementation(async () => {
      throw new Error("visibility read unavailable")
    })
    try {
      expect(await messageHitIds(HOLDER, [THREADS_READ, SCOPE])).toEqual([])
    } finally {
      boom.mockRestore()
    }
  })

  it("a covering wildcard grant still finds the message the literal filter could not name", async () => {
    // `crm:*` covers `crm:deals:read` for hasScope but not for Meili's IN[...],
    // so the engine clause is skipped and the post-filter decides alone.
    const ids = await messageHitIds(HOLDER, [THREADS_READ, "crm:*"])
    expect(ids).toContain(scopedId)
    // Still a gate, not a hole: the same wildcard shape gives a non-member nothing.
    expect(await messageHitIds(OUTSIDER, [THREADS_READ, "crm:*"])).toEqual([])
  })

  it("the ids projection can never resolve a message id", async () => {
    searches.length = 0
    const { resolveTicketMatches } = await importService()
    const { SearchDriftTestAccess } = await import("./drift")
    SearchDriftTestAccess.setSearchReady(true)
    try {
      const ids = await resolveTicketMatches({
        orgId: ORG_ID,
        userId: HOLDER,
        scopes: [THREADS_READ, SCOPE],
        q: QUERY,
      })
      expect(ids).not.toContain(scopedId)
      expect(ids).not.toContain(openId)
    } finally {
      SearchDriftTestAccess.resetSearchReady()
    }
    // Every kernel transcript kind is excluded at the query (a mail message
    // fragment, app "mail", resolves to its conversation instead).
    expect(searches.at(-1)?.filter ?? "").toContain(
      `NOT (app = "kernel" AND entity_type IN ["message", "message_window", "brief_row", "episode"])`,
    )
  })

  it("messages stay out of the searchable registrations, so a full reindex never rewrites them untagged", async () => {
    // reindex.ts walks collectSearchableRegistrations and builds documents with
    // the shared doc builder, which knows nothing about required_scopes. A
    // message registered there would come back from the next full reindex with
    // no scope tag at all, and this whole gate would open.
    const { collectSearchableRegistrations } = await import("./searchable-entities")
    const regs = collectSearchableRegistrations(ORG_ID)
    expect(regs.entities.map((e) => e.entityType)).not.toContain("message")
  })
})

describe("buildMessageVisibilityFilterClause", () => {
  it("names the searcher's own grants and admits untagged documents", async () => {
    const { buildMessageVisibilityFilterClause } = await importService()
    expect(buildMessageVisibilityFilterClause([THREADS_READ, SCOPE], [])).toBe(
      `(NOT required_scopes EXISTS OR required_scopes IN ["${THREADS_READ}","${SCOPE}"])`,
    )
  })

  it("admits the THREADS of the searcher's disclosed messages, which the index cannot express", async () => {
    const { buildMessageVisibilityFilterClause } = await importService()
    const clause = buildMessageVisibilityFilterClause([SCOPE], ["t1", "t2"])
    // By thread, not by message id: `entity_id` is no longer filterable (one
    // unique facet value per document). The thread is a superset, and the
    // database re-check decides each message of it.
    expect(clause).toContain(`thread_id IN ["t1","t2"]`)
    expect(clause).not.toContain("entity_id")
    expect(clause?.startsWith("(NOT required_scopes EXISTS OR")).toBe(true)
  })

  it("emits no clause when a grant can cover scopes it does not name", async () => {
    const { buildMessageVisibilityFilterClause } = await importService()
    // A wildcard or a parent grant covers scope strings the IN list cannot
    // enumerate; narrowing on the literal list would hide readable messages.
    expect(buildMessageVisibilityFilterClause(["*"], [])).toBeNull()
    expect(buildMessageVisibilityFilterClause(["crm:*"], [])).toBeNull()
    expect(buildMessageVisibilityFilterClause(["crm:deals"], [])).toBeNull()
  })

  it("emits no clause when the disclosure read could not answer", async () => {
    const { buildMessageVisibilityFilterClause } = await importService()
    expect(buildMessageVisibilityFilterClause([SCOPE], null)).toBeNull()
  })

  it("a searcher with no grants at all keeps only untagged documents", async () => {
    const { buildMessageVisibilityFilterClause } = await importService()
    expect(buildMessageVisibilityFilterClause([], [])).toBe("(NOT required_scopes EXISTS)")
  })
})
