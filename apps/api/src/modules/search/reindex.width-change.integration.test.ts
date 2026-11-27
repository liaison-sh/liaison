// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EMBEDDING_DIMENSIONS changed on an instance whose index already holds
// vectors at the old width. The declaration never changes the width in place:
// it asks for a rebuild at the new width, and until that rebuild swaps in,
// documents are written keyword only and noted. The rebuild carries no vector
// of the wrong length, notes every document that had one, and the re-embed
// step gives exactly those (and the noted live writes) a vector at the new
// width, from Postgres, without touching a document that never had one.
// Search answers the whole time.
//
// THE MUTATIONS THAT PROVE THESE BITE
//  * Patch the embedder in place on a width mismatch: the settings read 8
//    before any rebuild, or Meili fails the task.
//  * Carry vectors across the width change: the shadow's settings task fails.
//  * Skip noting in the rebuild: the vectored message stays without a vector.
//  * Re-embed before the new width is live: the step embeds into the old index.
//  * Note every transcript document: the never-vectored message gets a vector.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { Meilisearch } from "meilisearch"
import { sql } from "~/db"
import { processReembedStep } from "~/infra/jobs/embedding-backfill"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { redis } from "~/lib/redis"
import { IndexWriterTestAccess } from "~/modules/search/index-writer"
import {
  type Embedder,
  ensureMemoryEmbedderSettings,
  isWindowAnchor,
  MemoryEmbedderWidthPendingError,
  MessageIndexerTestAccess,
  memoryEmbedderDeclared,
  processMessageIndexerJob,
} from "~/modules/search/message-indexer"
import { orgsAwaitingReembed, reembedRemaining } from "~/modules/search/reembed-queue"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { seedMessageRow, seedThreadRow } from "~/seed/factories/threads/rows"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const LIVE = `test_width_${tag}`

const meili = new Meilisearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

function fake(width: number): Embedder {
  return {
    modelId: `fake-${width}`,
    dimensions: width,
    async embed(texts: string[]) {
      return {
        vectors: texts.map(() => Array.from({ length: width }, (_, i) => (i === 0 ? 1 : 0))),
        tokens: texts.length,
      }
    },
  }
}

/** A message id that anchors no window, so its own document is the only one it writes. */
function nonAnchorId(): string {
  for (;;) {
    const id = crypto.randomUUID()
    if (!isWindowAnchor(id)) return id
  }
}

const VECTORED = [nonAnchorId(), nonAnchorId()]
const KEYWORD_ONLY = nonAnchorId()
const LIVE_DURING = nonAnchorId()
const docId = (id: string) => `${ORG}_kernel_message_${id}`

const spies: Array<{ mockRestore: () => void }> = []
const enqueued: string[] = []

async function insert(id: string, content: string, at: number): Promise<void> {
  await seedMessageRow({
    id,
    threadId: THREAD,
    orgId: ORG,
    authorId: USER,
    content,
    requiredScopes: [],
    createdAt: new Date(Date.UTC(2026, 2, 10, 9, at)),
  })
}

async function vectorOf(id: string): Promise<number[] | null> {
  const doc = (await meili.index(LIVE).getDocument(docId(id), {
    retrieveVectors: true,
  } as never)) as Record<string, unknown>
  const memory = (doc._vectors as Record<string, { embeddings?: number[][] }> | undefined)?.memory
  return memory?.embeddings?.[0] ?? null
}

beforeAll(async () => {
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(LIVE))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue(
      meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
    ),
  )
  spies.push(
    spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (_app: string, name: string) => {
      enqueued.push(name)
      return "job"
    }) as never),
  )
  await redis.del(
    "search:rebuild:lock",
    "search:rebuild:touched",
    "search:rebuild:shadow",
    "search:rebuild:embedder-dims",
  )
  IndexWriterTestAccess.resetRebuildCache()
  IndexWriterTestAccess.setRebuildStateCacheMs(100)

  await seedOrgRow({ id: ORG, name: "WidthOrg", slug: `width-${tag}` })
  await seedUserRow({
    id: USER,
    orgId: ORG,
    email: `width-${tag}@test.com`,
    name: "Widther",
    passwordHash: "x",
  })
  await seedThreadRow({
    id: THREAD,
    orgId: ORG,
    handle: `width-${tag}`,
    title: "The okapi channel",
    createdBy: USER,
  })
  await insert(String(VECTORED[0]), "okapi line zero", 0)
  await insert(String(VECTORED[1]), "okapi line one", 1)
  await insert(KEYWORD_ONLY, "okapi line keyword only", 2)
  await insert(LIVE_DURING, "okapi line written during the change", 3)

  // The live index as the old width left it: the expected settings, the
  // embedder at 4, two messages with a vector and one written keyword only.
  const created = await meili.createIndex(LIVE, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const { expectedSettings } = await import("~/modules/search/drift")
  const applied = await meili
    .index(LIVE)
    .updateSettings(
      expectedSettings({ registeredReadScopes: ["kernel:threads:read"], dimensionFields: [] }),
    )
  await meili.tasks.waitForTask(applied.taskUid)
  MessageIndexerTestAccess.setEmbedderFactory(async () => null)
  await processMessageIndexerJob({ action: "upsert", orgId: ORG, messageId: KEYWORD_ONLY })
  MessageIndexerTestAccess.setEmbedderFactory(async () => fake(4))
  for (const id of VECTORED) {
    await processMessageIndexerJob({ action: "upsert", orgId: ORG, messageId: String(id) })
  }
  expect(await vectorOf(String(VECTORED[0]))).toHaveLength(4)
}, 120_000)

afterAll(async () => {
  IndexWriterTestAccess.setRebuildStateCacheMs()
  for (const s of spies) s.mockRestore()
  MessageIndexerTestAccess.setEmbedderFactory(null)
  await redis.del(`search:reembed:org:${ORG}`, `search:reembed:lock:${ORG}`)
  await redis.srem("search:reembed:orgs", ORG)
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  for (const name of [LIVE, `${LIVE}__rebuild`]) {
    try {
      const t = await meili.deleteIndex(name)
      await meili.tasks.waitForTask(t.taskUid)
    } catch {
      /* gone */
    }
  }
})

describe("embedding width change on an index that holds vectors", () => {
  it("asks for a rebuild instead of changing the width in place, and notes live writes", async () => {
    MessageIndexerTestAccess.setEmbedderFactory(async () => fake(8))
    await expect(ensureMemoryEmbedderSettings(8)).rejects.toBeInstanceOf(
      MemoryEmbedderWidthPendingError,
    )
    const settings = await meili.index(LIVE).getSettings()
    expect(settings.embedders?.memory).toMatchObject({ dimensions: 4 })
    expect(enqueued).toContain("search-reindex-full")
    expect(await redis.get("search:rebuild:embedder-dims")).toBe("8")
    // Search at the new width is keyword only until the rebuild swaps in.
    expect(await memoryEmbedderDeclared(8)).toBe(false)

    // A message written meanwhile: indexed keyword only, and noted.
    await processMessageIndexerJob({ action: "upsert", orgId: ORG, messageId: LIVE_DURING })
    expect(await vectorOf(LIVE_DURING)).toBeNull()
    expect(await reembedRemaining(ORG)).toBe(1)
    // The old vectors are untouched, and the re-embed waits for the new width.
    expect(await vectorOf(String(VECTORED[0]))).toHaveLength(4)
    expect((await processReembedStep(ORG)).status).toBe("waiting_for_index")
    expect(await reembedRemaining(ORG)).toBe(1)
  })

  it("rebuilds at the new width, carrying nothing and noting what had a vector", async () => {
    const { runReindex } = await import("./reindex")
    const result = await runReindex()
    expect(result.swapped).toBe(true)
    expect(result.vectorsCarried).toBe(0)
    expect(result.vectorsToReembed).toBe(VECTORED.length)
    const settings = await meili.index(LIVE).getSettings()
    expect(settings.embedders?.memory).toMatchObject({ source: "userProvided", dimensions: 8 })
    expect(await vectorOf(String(VECTORED[0]))).toBeNull()
    // Keyword search over the swapped-in index answers at once.
    const hits = await meili
      .index(LIVE)
      .search("okapi", { filter: `org_id = "${ORG}" AND entity_type = "message"` })
    expect(hits.hits).toHaveLength(4)
    expect(await reembedRemaining(ORG)).toBe(VECTORED.length + 1)
    expect(enqueued).toContain("search-embedding-reembed")
  }, 180_000)

  it("re-embeds exactly the noted documents at the new width", async () => {
    MessageIndexerTestAccess.resetEmbedderCache()
    MessageIndexerTestAccess.setEmbedderFactory(async () => fake(8))
    const step = await processReembedStep(ORG)
    expect(step).toEqual({ status: "embedded", embedded: VECTORED.length + 1, left: 0 })
    for (const id of [...VECTORED.map(String), LIVE_DURING]) {
      const v = await vectorOf(id)
      expect(v).toHaveLength(8)
    }
    expect(await vectorOf(KEYWORD_ONLY)).toBeNull()
    expect(await orgsAwaitingReembed()).not.toContain(ORG)
    // Idempotent: the declaration now matches and nothing is left to do.
    await ensureMemoryEmbedderSettings(8)
    expect((await processReembedStep(ORG)).status).toBe("done")
  })
})
