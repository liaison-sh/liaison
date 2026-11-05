// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2b-T25: thread messages are indexed into MeiliSearch with their
// `requiredScopes` as a filterable array attribute (spec-security.md, D16).
//
// The search index is a PUBLIC surface: whatever a document holds is readable
// by anything that can query the index, with no per-document ACL of its own.
// So these tests pin exactly what a message document may carry (its content,
// and `required_scopes` when non-empty) and what it must never carry (the
// disclosure list, the author, the mentions, the metadata). The query-side
// filter is P2b-T26's; here the invariant is only that the index holds the
// scope set the DB holds, and nothing more.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import * as privilegedModule from "~/db/privileged"
import {
  DurableConsumersTestAccess,
  durableConsumerCount,
  runDurableConsumers,
} from "~/infra/events/durable-consumers"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import * as liveIndexModule from "~/modules/search/live-index-queue"

const ORG = "2b250000-0000-4000-8000-000000000001"
const MESSAGE_ID = "2b250000-0000-4000-8000-000000000002"
const THREAD_ID = "2b250000-0000-4000-8000-000000000003"
const AUTHOR_ID = "2b250000-0000-4000-8000-000000000004"
const OTHER_MESSAGE_ID = "2b250000-0000-4000-8000-000000000006"

const SCOPE = "crm:deals:read"
const SECOND_SCOPE = "finance:payouts:read"
const UNRELATED_SCOPE = "support:tickets:read"
const CONTENT = "the payout ledger reconciles at 12480 euros"

function messageRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MESSAGE_ID,
    thread_id: THREAD_ID,
    org_id: ORG,
    author_id: AUTHOR_ID,
    author_type: "user",
    content: CONTENT,
    mentions: null,
    metadata: null,
    edited_at: null,
    deleted_at: null,
    created_at: new Date("2026-09-12T10:00:00.000Z"),
    required_scopes: [SCOPE],
    disclosure_list: null,
    ...over,
  }
}

async function loadMessageIndexer() {
  return await import("./message-indexer")
}

describe("message indexer: registration, events and document shape", () => {
  const spies: Array<{ mockRestore: () => void }> = []
  let currentRow: Record<string, unknown> | null = messageRow()

  const enqueued: Array<{
    appName: string
    jobName: string
    payload: any
    opts?: { jobId?: string }
  }> = []
  const enqueueAppJobMock = mock<
    (appName: string, jobName: string, payload: any, opts?: any) => Promise<string>
  >(async (appName, jobName, payload, opts) => {
    enqueued.push({ appName, jobName, payload, opts })
    return opts?.jobId ?? `${appName}:${jobName}:auto`
  })
  const registerJobWorkerMock = mock<(...args: any[]) => void>(() => {})
  const recorded: liveIndexModule.LiveIndexItem[] = []
  const recordLiveIndexMock = mock(async (items: liveIndexModule.LiveIndexItem[]) => {
    recorded.push(...items)
  })

  const meiliAddDocuments = mock<(docs: any[]) => Promise<{ taskUid: number }>>(async () => ({
    taskUid: 1,
  }))
  const meiliDeleteDocument = mock<(id: string) => Promise<{ taskUid: number }>>(async () => ({
    taskUid: 2,
  }))

  const withPrivilegedDbMock = mock(async (_org: string, _purpose: string, fn: any) =>
    fn({ execute: async () => ({ rows: currentRow ? [currentRow] : [] }) }),
  )

  beforeEach(() => {
    enqueued.length = 0
    recorded.length = 0
    recordLiveIndexMock.mockClear()
    enqueueAppJobMock.mockClear()
    registerJobWorkerMock.mockClear()
    meiliAddDocuments.mockClear()
    meiliDeleteDocument.mockClear()
    withPrivilegedDbMock.mockClear()
    DurableConsumersTestAccess.reset()
    currentRow = messageRow()

    spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation(enqueueAppJobMock))
    spies.push(spyOn(jobsModule, "registerJobWorker").mockImplementation(registerJobWorkerMock))
    spies.push(spyOn(liveIndexModule, "recordLiveIndex").mockImplementation(recordLiveIndexMock))
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue("test_msg_idx"))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue({
        index: () => ({
          addDocuments: meiliAddDocuments,
          deleteDocument: meiliDeleteDocument,
        }),
      } as any),
    )
    spies.push(spyOn(privilegedModule, "withPrivilegedDb").mockImplementation(withPrivilegedDbMock))
  })

  afterEach(() => {
    for (const s of spies) s.mockRestore()
    spies.length = 0
    DurableConsumersTestAccess.reset()
  })

  it("registerMessageIndexerConsumer adds a durable consumer and both job workers", async () => {
    const indexer = await loadMessageIndexer()
    expect(durableConsumerCount()).toBe(0)
    indexer.registerMessageIndexerConsumer()
    expect(durableConsumerCount()).toBe(1)
    const jobNames = registerJobWorkerMock.mock.calls.map((c) => `${c[0]}:${c[1]}`)
    expect(jobNames).toContain("kernel:search-message-index-upsert")
    expect(jobNames).toContain("kernel:search-message-index-delete")
  })

  it("registerMessageIndexerJobWorkers registers the handlers without a second event consumer", async () => {
    const indexer = await loadMessageIndexer()
    indexer.registerMessageIndexerJobWorkers()
    expect(durableConsumerCount()).toBe(0)
    const jobNames = registerJobWorkerMock.mock.calls.map((c) => `${c[0]}:${c[1]}`)
    expect(jobNames).toContain("kernel:search-message-index-upsert")
  })

  it("required_scopes is filterable in the index settings every caller applies", async () => {
    // The message document is written into the SHARED unified-search index,
    // whose settings drift detector rewrites filterableAttributes to exactly
    // what expectedSettings returns. An attribute applied out of band would be
    // stripped on the next boot and T26's filter would start erroring, so the
    // attribute has to arrive through this one definition.
    const { expectedSettings } = await import("./drift")
    const settings = expectedSettings({
      registeredReadScopes: ["kernel:threads:read"],
      dimensionFields: [],
    })
    expect(settings.filterableAttributes).toContain("required_scopes")
  })

  it("a kernel message create event records an upsert keyed by the message document id", async () => {
    const indexer = await loadMessageIndexer()
    indexer.registerMessageIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-m1",
      event: {
        app: "kernel",
        entity: "message",
        action: "create",
        orgId: ORG,
        entityId: MESSAGE_ID,
        data: { id: MESSAGE_ID, threadId: THREAD_ID, requiredScopes: [SCOPE] },
      } as any,
    })
    // No app-kernel job: the change goes to the coalescing queue.
    expect(enqueueAppJobMock).not.toHaveBeenCalled()
    expect(recorded).toEqual([
      {
        t: "message",
        key: `${ORG}_kernel_message_${MESSAGE_ID}`,
        payload: { action: "upsert", orgId: ORG, messageId: MESSAGE_ID },
      },
    ])
  })

  it("a kernel message update event records an upsert", async () => {
    const indexer = await loadMessageIndexer()
    indexer.registerMessageIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-m2",
      event: {
        app: "kernel",
        entity: "message",
        action: "update",
        orgId: ORG,
        entityId: MESSAGE_ID,
        data: { id: MESSAGE_ID },
      } as any,
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.payload.action).toBe("upsert")
  })

  it("a kernel message delete event records a delete", async () => {
    const indexer = await loadMessageIndexer()
    indexer.registerMessageIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-m3",
      event: {
        app: "kernel",
        entity: "message",
        action: "delete",
        orgId: ORG,
        entityId: MESSAGE_ID,
        data: { id: MESSAGE_ID },
      } as any,
    })
    expect(recorded).toHaveLength(1)
    expect(recorded[0]!.payload.action).toBe("delete")
  })

  it("an ephemeral message event is skipped", async () => {
    const indexer = await loadMessageIndexer()
    indexer.registerMessageIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-m4",
      event: {
        app: "kernel",
        entity: "message",
        action: "create",
        orgId: ORG,
        entityId: MESSAGE_ID,
        ephemeral: true,
        data: { id: MESSAGE_ID },
      } as any,
    })
    expect(recorded).toEqual([])
  })

  it("a tickets message event is left to the ticket indexer", async () => {
    const indexer = await loadMessageIndexer()
    indexer.registerMessageIndexerConsumer()
    await runDurableConsumers({
      eventId: "evt-m5",
      event: {
        app: "tickets",
        entity: "message",
        action: "create",
        orgId: ORG,
        entityId: MESSAGE_ID,
        data: { ticketId: THREAD_ID },
      } as any,
    })
    expect(recorded).toEqual([])
  })

  it("an indexer failure never breaks sending a message", async () => {
    // The consumer runs post-commit, off the outbox. If it threw, the outbox
    // row would stay unprocessed and every durable consumer for that event
    // (attention, websocket bookkeeping) would be re-run forever behind a
    // search outage. Indexing is best effort: it logs and yields.
    recordLiveIndexMock.mockImplementationOnce(async () => {
      throw new Error("redis is down")
    })
    const indexer = await loadMessageIndexer()
    indexer.registerMessageIndexerConsumer()
    await expect(
      runDurableConsumers({
        eventId: "evt-m7",
        event: {
          app: "kernel",
          entity: "message",
          action: "create",
          orgId: ORG,
          entityId: MESSAGE_ID,
          data: { id: MESSAGE_ID },
        } as any,
      }),
    ).resolves.toBeUndefined()
  })

  it("a legacy message job already queued only records its request, and never calls Meili", async () => {
    const indexer = await loadMessageIndexer()
    indexer.registerMessageIndexerJobWorkers()
    const upsert = registerJobWorkerMock.mock.calls.find(
      (c) => c[1] === "search-message-index-upsert",
    )?.[2] as (p: unknown) => Promise<void>
    const brief = registerJobWorkerMock.mock.calls.find(
      (c) => c[1] === "search-brief-index-upsert",
    )?.[2] as (p: unknown) => Promise<void>
    await upsert({ orgId: ORG, messageId: MESSAGE_ID })
    await brief({ orgId: ORG, kind: "episode", id: OTHER_MESSAGE_ID })
    expect(meiliAddDocuments).not.toHaveBeenCalled()
    expect(recorded.map((r) => [r.t, r.key, r.payload.action])).toEqual([
      ["message", `${ORG}_kernel_message_${MESSAGE_ID}`, "upsert"],
      ["brief", `${ORG}_kernel_episode_${OTHER_MESSAGE_ID}`, "upsert"],
    ])
  })
})

// ---------------------------------------------------------------------------
// Real rows, real index.
//
// Every case below writes REAL rows into Postgres and indexes them with the
// REAL indexer into a private Meili index, so what is pinned is what the
// indexer actually reads and writes, not what a mock happened to return.
// ---------------------------------------------------------------------------

const R_ORG = crypto.randomUUID()
const R_USER = crypto.randomUUID()
const R_THREAD = crypto.randomUUID()
const R_INDEX = `test_msgidx_${R_ORG.slice(0, 8)}`
const realMeili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

/** A message id whose anchor status is the one asked for (anchors are a function of the id). */
async function idWith(anchor: boolean): Promise<string> {
  const { isWindowAnchor } = await loadMessageIndexer()
  for (;;) {
    const id = crypto.randomUUID()
    if (isWindowAnchor(id) === anchor) return id
  }
}

let clock = Date.UTC(2026, 8, 12, 10, 0, 0)

async function insertRow(
  threadId: string,
  content: string,
  over: {
    id?: string
    scopes?: string[]
    disclosure?: string[] | null
    metadata?: unknown
    authorType?: string
  } = {},
): Promise<string> {
  const id = over.id ?? crypto.randomUUID()
  clock += 1000
  await sql`INSERT INTO kernel.messages
      (id, thread_id, org_id, author_id, author_type, content, metadata, required_scopes,
       disclosure_list, created_at)
    VALUES (${id}, ${threadId}, ${R_ORG}, ${R_USER}, ${over.authorType ?? "user"}, ${content},
      ${over.metadata ? JSON.stringify(over.metadata) : null}::jsonb,
      ${over.scopes ?? []}::text[], ${over.disclosure ?? null}::uuid[],
      ${new Date(clock).toISOString()}::timestamptz)`
  return id
}

async function newThread(): Promise<string> {
  const id = crypto.randomUUID()
  await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
    VALUES (${id}, ${R_ORG}, ${`msgidx-${id.slice(0, 8)}`}, ${R_USER})`
  return id
}

async function docsWhere(filter: string): Promise<Array<Record<string, unknown>>> {
  const page = await realMeili
    .index(R_INDEX)
    .getDocuments({ filter: `org_id = "${R_ORG}" AND ${filter}`, limit: 1000 })
  return page.results as Array<Record<string, unknown>>
}

async function windowsOf(threadId: string): Promise<Array<Record<string, unknown>>> {
  const docs = await docsWhere(`entity_type = "message_window" AND thread_id = "${threadId}"`)
  return docs.sort((a, b) => Number(a.created_at) - Number(b.created_at))
}

/** Flush the live queue once and wait for every task it sent. */
async function flushAndSettle(): Promise<void> {
  await liveIndexModule.flushLiveIndexOnce()
  const ledger = await liveIndexModule.LiveIndexTestAccess.ledger()
  for (const uid of Object.keys(ledger)) await realMeili.tasks.waitForTask(Number(uid))
}

describe("message documents built from the real rows", () => {
  const spies: Array<{ mockRestore: () => void }> = []
  let savedGoogleKey: string | undefined

  beforeAll(async () => {
    savedGoogleKey = process.env.GOOGLE_API_KEY
    process.env.GOOGLE_API_KEY = ""
    ;(await loadMessageIndexer()).MessageIndexerTestAccess.resetEmbedderCache()
    const { expectedSettings } = await import("./drift")
    const created = await realMeili.createIndex(R_INDEX, { primaryKey: "id" })
    await realMeili.tasks.waitForTask(created.taskUid)
    const applied = await realMeili
      .index(R_INDEX)
      .updateSettings(
        expectedSettings({ registeredReadScopes: ["kernel:threads:read"], dimensionFields: [] }),
      )
    await realMeili.tasks.waitForTask(applied.taskUid)
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${R_ORG}, 'MsgIdxOrg', ${`msgidx-${R_ORG.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${R_USER}, ${R_ORG}, ${`msgidx-${R_ORG.slice(0, 8)}@test.com`}, 'Idx', 'x')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${R_THREAD}, ${R_ORG}, ${`msgidx-${R_ORG.slice(0, 8)}`}, ${R_USER})`
  })

  afterAll(async () => {
    process.env.GOOGLE_API_KEY = savedGoogleKey
    ;(await loadMessageIndexer()).MessageIndexerTestAccess.resetEmbedderCache()
    await sql`DELETE FROM kernel.messages WHERE org_id = ${R_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${R_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${R_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${R_ORG}`
    const deleted = await realMeili.deleteIndex(R_INDEX)
    await realMeili.tasks.waitForTask(deleted.taskUid)
  })

  beforeEach(async () => {
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(R_INDEX))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        realMeili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    // No flush job host in a test: the queue is drained by hand.
    spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never))
    await liveIndexModule.LiveIndexTestAccess.clear()
  })

  afterEach(async () => {
    for (const s of spies) s.mockRestore()
    spies.length = 0
    await liveIndexModule.LiveIndexTestAccess.clear()
  })

  async function index(messageId: string, action: "upsert" | "delete" = "upsert") {
    const indexer = await loadMessageIndexer()
    await indexer.processMessageIndexerJob({ action, orgId: R_ORG, messageId })
  }

  it("a message document publishes its content, scopes and thread, and nothing else", async () => {
    const DISCLOSED = crypto.randomUUID()
    const id = await insertRow(R_THREAD, CONTENT, { scopes: [SCOPE], disclosure: [DISCLOSED] })
    await index(id)
    const [doc] = await docsWhere(`entity_type = "message" AND thread_id = "${R_THREAD}"`)
    expect(doc?.entity_id).toBe(id)
    expect(doc?.required_scopes).toEqual([SCOPE])
    // The disclosure branch stays a DB post-filter: who a message was
    // disclosed to is never published into the index.
    expect(JSON.stringify(doc)).not.toContain(DISCLOSED)
    // The whole public surface of a message document, pinned. `dedupe_key`
    // (self-valued, one unique facet value per document), `author_agent_id`
    // and `participant_agent_ids` (filtered on by nothing) are gone.
    // `_vectors` is Meili's reserved vector slot (null here), returned as a
    // plain field by a Meili whose vector store is off, so it is left out.
    expect(
      Object.keys(doc ?? {})
        .filter((k) => k !== "_vectors")
        .sort(),
    ).toEqual([
      "app",
      "created_at",
      "entity_id",
      "entity_type",
      "id",
      "is_mentionable",
      "org_id",
      "read_scope",
      "required_scopes",
      "thread_id",
      "title",
      "updated_at",
    ])
  })

  it("a message with no required scopes omits the attribute, so NOT EXISTS admits it", async () => {
    const id = await insertRow(R_THREAD, "an unscoped line about pallets")
    await index(id)
    const [doc] = await docsWhere(
      `entity_type = "message" AND entity_id = "${id}"`.replace(
        `entity_id = "${id}"`,
        `NOT required_scopes EXISTS AND thread_id = "${R_THREAD}"`,
      ),
    )
    expect(doc).toBeDefined()
    expect(doc?.required_scopes).toBeUndefined()
  })

  it("an edit that widens the scopes re-indexes the message with the scopes of the ROW", async () => {
    const id = await insertRow(R_THREAD, "the rebate ledger reconciles", { scopes: [SCOPE] })
    await index(id)
    await sql`UPDATE kernel.messages SET required_scopes = ${[SCOPE, SECOND_SCOPE]}::text[]
      WHERE id = ${id}`
    await index(id)
    const found = await realMeili.index(R_INDEX).search("rebate", {
      filter: `org_id = "${R_ORG}" AND entity_type = "message"`,
    })
    expect(found.hits.find((h) => h.entity_id === id)?.required_scopes).toEqual(
      [SCOPE, SECOND_SCOPE].sort(),
    )
  })

  it("a soft-deleted, vanished or deleted-by-job message leaves no document", async () => {
    const soft = await insertRow(R_THREAD, "soft deleted quinoa line")
    const byJob = await insertRow(R_THREAD, "job deleted quinoa line")
    await index(soft)
    await index(byJob)
    await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${soft}`
    await index(soft)
    await index(byJob, "delete")
    await index(crypto.randomUUID())
    const hits = await realMeili.index(R_INDEX).search("quinoa", {
      filter: `org_id = "${R_ORG}" AND entity_type = "message"`,
    })
    expect(hits.hits).toEqual([])
  })

  it("A50: a memory_search-only turn is not indexed; text beside it is, without the tool part", async () => {
    const recalledOnly = await insertRow(R_THREAD, "", {
      metadata: {
        toolCalls: [{ toolCallId: "a", toolName: "memory_search", result: "recalled 4711 zebra" }],
      },
    })
    const withText = await insertRow(R_THREAD, "the zebra crossing permit arrived", {
      metadata: {
        toolCalls: [{ toolCallId: "b", toolName: "memory_search", result: "recalled something" }],
      },
    })
    await index(recalledOnly)
    await index(withText)
    const hits = await realMeili.index(R_INDEX).search("zebra", {
      filter: `org_id = "${R_ORG}" AND entity_type = "message"`,
    })
    expect(hits.hits.map((h) => h.entity_id)).toEqual([withText])
    expect(JSON.stringify(hits.hits[0])).not.toContain("recalled something")
  })

  it("a scope filter with IN[...] returns the message to a holder and hides it from everyone else", async () => {
    const scoped = await insertRow(R_THREAD, "the payout ledger reconciles again", {
      scopes: [SCOPE],
    })
    const open = await insertRow(R_THREAD, "the payout ledger is open")
    await index(scoped)
    await index(open)
    const base = `org_id = "${R_ORG}" AND entity_type = "message"`
    const holder = await realMeili.index(R_INDEX).search("payout", {
      filter: `${base} AND (NOT required_scopes EXISTS OR required_scopes IN ["${SCOPE}"])`,
    })
    expect(holder.hits.map((h) => h.entity_id)).toContain(scoped)
    const lacker = await realMeili.index(R_INDEX).search("payout", {
      filter: `${base} AND (NOT required_scopes EXISTS OR required_scopes IN ["${UNRELATED_SCOPE}"])`,
    })
    expect(lacker.hits.map((h) => h.entity_id)).toContain(open)
    expect(lacker.hits.map((h) => h.entity_id)).not.toContain(scoped)
  })

  it("a Meili failure fails a direct index call rather than being swallowed", async () => {
    const id = await insertRow(R_THREAD, "a line Meili refuses")
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue({
        index: () => ({
          addDocuments: async () => {
            throw new Error("meili unavailable")
          },
          deleteDocuments: async () => ({ taskUid: 1 }),
        }),
      } as never),
    )
    await expect(index(id)).rejects.toThrow("meili unavailable")
  })
})

// ---------------------------------------------------------------------------
// Windows: anchored by id, built from bounded reads (finding 4).
// ---------------------------------------------------------------------------

describe("window documents: anchored by id, bounded reads", () => {
  const spies: Array<{ mockRestore: () => void }> = []

  beforeAll(async () => {
    process.env.GOOGLE_API_KEY = ""
    ;(await loadMessageIndexer()).MessageIndexerTestAccess.resetEmbedderCache()
  })

  beforeEach(async () => {
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(R_INDEX))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        realMeili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never))
    await liveIndexModule.LiveIndexTestAccess.clear()
    // The describe above owns the index and the org; recreate what it dropped.
    try {
      await realMeili.getIndex(R_INDEX)
    } catch {
      const { expectedSettings } = await import("./drift")
      const created = await realMeili.createIndex(R_INDEX, { primaryKey: "id" })
      await realMeili.tasks.waitForTask(created.taskUid)
      const applied = await realMeili
        .index(R_INDEX)
        .updateSettings(
          expectedSettings({ registeredReadScopes: ["kernel:threads:read"], dimensionFields: [] }),
        )
      await realMeili.tasks.waitForTask(applied.taskUid)
    }
    const [org] = await sql`SELECT id FROM kernel.organizations WHERE id = ${R_ORG}`
    if (!org) {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${R_ORG}, 'MsgIdxOrg', ${`msgidx-${R_ORG.slice(0, 8)}`})`
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${R_USER}, ${R_ORG}, ${`msgidx-${R_ORG.slice(0, 8)}@test.com`}, 'Idx', 'x')`
    }
  })

  afterEach(async () => {
    for (const s of spies) s.mockRestore()
    spies.length = 0
    await liveIndexModule.LiveIndexTestAccess.clear()
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.messages WHERE org_id = ${R_ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${R_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${R_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${R_ORG}`
    try {
      const deleted = await realMeili.deleteIndex(R_INDEX)
      await realMeili.tasks.waitForTask(deleted.taskUid)
    } catch {
      /* already gone */
    }
  })

  /** n n A n n n A n A n: anchors at 2, 6 and 8. Only message 7 carries a scope. */
  async function seedThread(): Promise<{ threadId: string; ids: string[] }> {
    const threadId = await newThread()
    const pattern = [false, false, true, false, false, false, true, false, true, false]
    const ids: string[] = []
    for (const [i, anchor] of pattern.entries()) {
      ids.push(
        await insertRow(threadId, `turn ${i} about the DHL account`, {
          id: await idWith(anchor),
          scopes: i === 7 ? [T_SCOPE_A] : [],
        }),
      )
    }
    const indexer = await loadMessageIndexer()
    for (const id of ids) {
      await indexer.processMessageIndexerJob({ action: "upsert", orgId: R_ORG, messageId: id })
    }
    return { threadId, ids }
  }

  it("a window sits on each anchor and covers back to the previous anchor", async () => {
    const { threadId, ids } = await seedThread()
    const windows = await windowsOf(threadId)
    expect(windows.map((w) => w.entity_id)).toEqual([2, 6, 8].map((i) => `${threadId}:${ids[i]}`))
    // Anchor 2 has no anchor before it: the thread from its start.
    expect(windows[0]?.title).toBe(
      [0, 1, 2].map((i) => `turn ${i} about the DHL account`).join("\n"),
    )
    // Anchor 6 reaches back to anchor 2 inclusive (the one-message overlap).
    expect(windows[1]?.title).toBe(
      [2, 3, 4, 5, 6].map((i) => `turn ${i} about the DHL account`).join("\n"),
    )
    // W2 review finding 6: a window quotes only messages exactly as visible as
    // its anchor, because memory search re-checks the anchor alone. Anchor 8's
    // span is 6 to 8, but message 7 carries a scope anchor 8 does not.
    expect(windows[2]?.title).toBe([6, 8].map((i) => `turn ${i} about the DHL account`).join("\n"))
    expect(windows[2]?.required_scopes).toBeUndefined()
    expect(windows[1]?.required_scopes).toBeUndefined()
    // The last message after anchor 8 is in no window until the next anchor.
    expect(String(windows[2]?.title)).not.toContain("turn 9")
  })

  it("indexing a message in a 3,000 message thread reads a bounded number of rows", async () => {
    const threadId = await newThread()
    // 3,000 rows of 1 KB, inserted in one statement.
    await sql`INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, required_scopes, created_at)
      SELECT ${threadId}, ${R_ORG}, ${R_USER}, 'user', repeat('x', 1000) || ' ' || g,
        '{}'::text[], ${new Date(clock).toISOString()}::timestamptz + (g || ' milliseconds')::interval
      FROM generate_series(1, 3000) AS g`
    clock += 10_000
    const newest = await insertRow(threadId, "the newest line, an anchor", {
      id: await idWith(true),
    })
    const [middle] = await sql<{ id: string }[]>`SELECT id FROM kernel.messages
      WHERE thread_id = ${threadId} ORDER BY created_at OFFSET 1500 LIMIT 1`

    // Count every row the indexer's queries return.
    let rowsRead = 0
    const real = privilegedModule.withPrivilegedDb
    spies.push(
      spyOn(privilegedModule, "withPrivilegedDb").mockImplementation((async (
        org: string,
        purpose: string,
        fn: (tx: unknown) => Promise<unknown>,
      ) =>
        real(org, purpose, (tx) =>
          fn(
            new Proxy(tx as object, {
              get(target, prop) {
                const value = (target as Record<string | symbol, unknown>)[prop]
                if (prop !== "execute" || typeof value !== "function") return value
                return async (q: unknown) => {
                  const r = await (value as (q: unknown) => Promise<unknown>).call(target, q)
                  rowsRead += ((r as { rows?: unknown[] }).rows ?? (r as unknown[])).length
                  return r
                }
              },
            }),
          ),
        )) as never),
    )
    const indexer = await loadMessageIndexer()
    await indexer.processMessageIndexerJob({ action: "upsert", orgId: R_ORG, messageId: newest })
    // The row, at most MAX - 1 ids after it, at most MAX rows of its window.
    // The ordinal scheme read all 3,001 rows (3 MB) here.
    expect(rowsRead).toBeLessThanOrEqual(2 * indexer.MESSAGE_WINDOW_MAX)
    rowsRead = 0
    await indexer.processMessageIndexerJob({
      action: "upsert",
      orgId: R_ORG,
      messageId: String(middle?.id),
    })
    expect(rowsRead).toBeLessThanOrEqual(3 * indexer.MESSAGE_WINDOW_MAX)
    const newestWindow = (await windowsOf(threadId)).find((w) =>
      String(w.entity_id).endsWith(newest),
    )
    expect(newestWindow).toBeDefined()
    expect(String(newestWindow?.title).split("\n").length).toBeLessThanOrEqual(
      indexer.MESSAGE_WINDOW_MAX,
    )
  })

  it("an edit rebuilds the one window quoting the message, with the new text", async () => {
    const { threadId, ids } = await seedThread()
    await sql`UPDATE kernel.messages SET content = 'turn 4 renamed the carrier to Geodis'
      WHERE id = ${ids[4]}`
    const indexer = await loadMessageIndexer()
    await indexer.processMessageIndexerJob({ action: "upsert", orgId: R_ORG, messageId: ids[4] })
    const windows = await windowsOf(threadId)
    const covering = windows.find((w) => String(w.entity_id).endsWith(String(ids[6])))
    expect(covering?.title).toContain("Geodis")
    expect(covering?.title).not.toContain("turn 4 about the DHL account")
  })

  it("a human delete removes the message and the windows quoting it at once; the delete event rebuilds the survivor", async () => {
    const { threadId, ids } = await seedThread()
    const indexer = await loadMessageIndexer()
    // Message 4 sits in the window of anchor 6 only.
    const anchors = await indexer.deleteMessageAndWindowDocuments(R_ORG, threadId, String(ids[4]))
    expect(anchors).toEqual([String(ids[6])])
    await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${ids[4]}`
    await flushAndSettle()
    expect(await docsWhere(`entity_type = "message" AND thread_id = "${threadId}"`)).toHaveLength(9)
    expect((await windowsOf(threadId)).map((w) => w.entity_id)).toEqual(
      [2, 8].map((i) => `${threadId}:${ids[i]}`),
    )
    // The post-commit delete event: the window comes back without the text.
    await indexer.processMessageIndexerJob({ action: "delete", orgId: R_ORG, messageId: ids[4] })
    const rebuilt = (await windowsOf(threadId)).find((w) =>
      String(w.entity_id).endsWith(String(ids[6])),
    )
    expect(rebuilt?.title).toBe(
      [2, 3, 5, 6].map((i) => `turn ${i} about the DHL account`).join("\n"),
    )
  })

  it("deleting an anchor drops its window and the next window reaches back past it", async () => {
    const { threadId, ids } = await seedThread()
    const indexer = await loadMessageIndexer()
    await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${ids[6]}`
    await indexer.processMessageIndexerJob({ action: "delete", orgId: R_ORG, messageId: ids[6] })
    const windows = await windowsOf(threadId)
    expect(windows.map((w) => w.entity_id)).toEqual([2, 8].map((i) => `${threadId}:${ids[i]}`))
    expect(windows[1]?.title).toBe(
      [2, 3, 4, 5, 8].map((i) => `turn ${i} about the DHL account`).join("\n"),
    )
  })

  it("the bulk stream writes exactly the documents the per message path writes", async () => {
    const { threadId } = await seedThread()
    const perMessage = await docsWhere(`thread_id = "${threadId}"`)
    const task = await realMeili
      .index(R_INDEX)
      .deleteDocuments({ filter: `thread_id = "${threadId}"` })
    await realMeili.tasks.waitForTask(task.taskUid)
    const indexer = await loadMessageIndexer()
    const counts = await indexer.indexThreadMessagesBulk(R_ORG, threadId, { pageSize: 3 })
    expect(counts).toEqual({ messages: 10, windows: 3 })
    const bulk = await docsWhere(`thread_id = "${threadId}"`)
    const byId = (docs: Array<Record<string, unknown>>) =>
      Object.fromEntries(docs.map((d) => [String(d.id), d]))
    expect(byId(bulk)).toEqual(byId(perMessage))
  })

  it("indexMessagesBulk indexes a known set and skips deleted rows", async () => {
    const threadId = await newThread()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await insertRow(threadId, `bulk line ${i} walrus`))
    await sql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${ids[1]}`
    const indexer = await loadMessageIndexer()
    const result = await indexer.indexMessagesBulk(R_ORG, ids, { batchSize: 2 })
    expect(result.failures).toEqual([])
    const docs = await docsWhere(`entity_type = "message" AND thread_id = "${threadId}"`)
    expect(docs.map((d) => d.entity_id).sort()).toEqual(ids.filter((_, i) => i !== 1).sort())
  })
})

const T_SCOPE_A = "crm:deals:read"
