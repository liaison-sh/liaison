// SPDX-License-Identifier: FSL-1.1-ALv2
// P4c-T48: the backfill is killed by a deploy like anything else, so the thing
// that matters about it is what a rerun does.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import {
  clearBackfillCursor,
  processEmbeddingBackfillJob,
  readBackfillCursor,
} from "~/infra/jobs/embedding-backfill"
import * as searchClientModule from "~/infra/search/client"
import {
  type Embedder,
  isWindowAnchor,
  MessageIndexerTestAccess,
} from "~/modules/search/message-indexer"

const ORG_ID = crypto.randomUUID()
const USER_ID = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)
const INDEX_NAME = `test_p4ct48bf_${crypto.randomUUID().slice(0, 8)}`
const THREADS_READ = "kernel:threads:read"

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

/**
 * The thread's first message never anchors a window: an anchor's window runs
 * back to the previous anchor, so a first message that anchors one gets a
 * window of itself alone, whose text is its own, and `embeddedMessages` would
 * count it twice (one fixture in four, the anchor test being a pure function of
 * the random id). Every later anchor's window spans two messages or more.
 */
function nonAnchorId(): string {
  for (;;) {
    const id = crypto.randomUUID()
    if (!isWindowAnchor(id)) return id
  }
}

/** Every message this fixture holds, in the order the cursor walks them. */
const MESSAGES = Array.from({ length: 5 }, (_, i) => ({
  id: i === 0 ? nonAnchorId() : crypto.randomUUID(),
  content: `Backfill message number ${i}.`,
  createdAt: new Date(Date.UTC(2026, 2, 10 + i, 9, 0, 0)).toISOString(),
}))

/** Which texts the embedder was actually asked about. */
const embeddedTexts: string[] = []

/**
 * The per-message texts only. The indexer also emits a sliding window document
 * every third message, and that document carries a vector too: it is real work
 * the backfill does, but it is not what "which messages were embedded" means.
 */
function embeddedMessages(): string[] {
  return embeddedTexts.filter((t) => !t.includes("\n"))
}

const fakeEmbedder: Embedder = {
  modelId: "fake-embedding-001",
  dimensions: 4,
  async embed(texts: string[]) {
    embeddedTexts.push(...texts)
    return { vectors: texts.map((_, i) => [1, 0, 0, i / 100]), tokens: texts.length }
  },
}

const spies: Array<{ mockRestore: () => void }> = []

describe("embedding backfill", () => {
  beforeAll(async () => {
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    MessageIndexerTestAccess.setEmbedderFactory(async () => fakeEmbedder)

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
      VALUES (${ORG_ID}, 'BackfillOrg', ${`backfill-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_ID}, ${ORG_ID}, ${`backfill-${tag}@test.com`}, 'Backfill', 'x')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`backfill${tag}`}, ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    for (const m of MESSAGES) {
      await sql`INSERT INTO kernel.messages (id, org_id, thread_id, author_id, author_type, content, required_scopes, created_at)
        VALUES (${m.id}, ${ORG_ID}, ${THREAD_ID}, ${USER_ID}, 'user', ${m.content}, '{}'::text[], ${m.createdAt})`
    }
    await clearBackfillCursor(ORG_ID)
  })

  afterAll(async () => {
    await clearBackfillCursor(ORG_ID)
    MessageIndexerTestAccess.setEmbedderFactory(null)
    MessageIndexerTestAccess.resetEmbedderCache()
    for (const s of spies) s.mockRestore()
    try {
      await meili.deleteIndex(INDEX_NAME)
    } catch {
      /* the index is a test artifact */
    }
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("the backfill resumes after a kill", async () => {
    // One batch lands, and the cursor names where it got to.
    const first = await processEmbeddingBackfillJob({ orgId: ORG_ID, batchSize: 2 })
    expect(first.embedded).toBe(2)
    expect(first.done).toBe(false)
    expect(await readBackfillCursor(ORG_ID)).toBe(first.cursor as string)
    expect(first.cursor).toContain(MESSAGES[1]?.id as string)

    // THE KILL: nothing else happens. The next run is a fresh call with no
    // memory of the first beyond the persisted cursor.
    const seenAfterFirstBatch = embeddedMessages()
    expect(seenAfterFirstBatch).toEqual([MESSAGES[0]?.content, MESSAGES[1]?.content] as string[])

    embeddedTexts.length = 0
    const second = await processEmbeddingBackfillJob({ orgId: ORG_ID, batchSize: 2 })
    expect(second.embedded).toBe(2)
    // NO DOUBLE WORK: the first batch's messages are not embedded again.
    expect(embeddedMessages()).toEqual([MESSAGES[2]?.content, MESSAGES[3]?.content] as string[])
    expect(second.cursor).toContain(MESSAGES[3]?.id as string)

    // The last partial batch ends the run.
    embeddedTexts.length = 0
    const third = await processEmbeddingBackfillJob({ orgId: ORG_ID, batchSize: 2 })
    expect(third.embedded).toBe(1)
    expect(third.done).toBe(true)
    expect(embeddedMessages()).toEqual([MESSAGES[4]?.content] as string[])

    // And a run past the end embeds nothing at all.
    embeddedTexts.length = 0
    const fourth = await processEmbeddingBackfillJob({ orgId: ORG_ID, batchSize: 2 })
    expect(fourth.embedded).toBe(0)
    expect(fourth.done).toBe(true)
    expect(embeddedMessages()).toEqual([])
  })

  it("a backfilled document carries its vector in the index", async () => {
    const docs = await meili.index(INDEX_NAME).search("Backfill message", {
      filter: `org_id = "${ORG_ID}" AND entity_type = "message"`,
      retrieveVectors: true,
      limit: 10,
    })
    expect(docs.hits.length).toBeGreaterThan(0)
    for (const hit of docs.hits) {
      const stored = (hit as { _vectors?: Record<string, unknown> })._vectors?.memory
      expect(stored).toBeDefined()
    }
  })
})
