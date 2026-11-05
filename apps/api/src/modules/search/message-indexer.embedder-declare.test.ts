// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An index holding a document written before every writer opted out of vectors
// cannot take the `memory` embedder: Meili accepts the settings call and FAILS
// the task. The declaration used to heal that by paging the WHOLE index with
// its vectors (tens of GB of JSON on production's 764k documents). It now asks
// for a rebuild instead: the shadow index is created with the embedder
// declared, every document written into it carries `_vectors`, and the swap
// brings it live. Until then memory search is keyword only.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { Index, MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { redis } from "~/lib/redis"
import { memorySearch } from "~/modules/agent/memory/memory-search"
import { IndexWriterTestAccess } from "~/modules/search/index-writer"
import {
  type Embedder,
  ensureMemoryEmbedderSettings,
  MessageIndexerTestAccess,
  memoryEmbedderDeclared,
} from "~/modules/search/message-indexer"

const ORG_ID = crypto.randomUUID()
const USER_ID = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)
const INDEX_NAME = `test_embdecl_${tag}`
const DIMENSIONS = 4

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

let embedCalls = 0
const fakeEmbedder: Embedder = {
  modelId: "fake-embedding-001",
  dimensions: DIMENSIONS,
  async embed(texts: string[]) {
    embedCalls += texts.length
    return { vectors: texts.map(() => [1, 0, 0, 0]), tokens: texts.length }
  },
}

const actor: UserContext = {
  actorType: "user",
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

const spies: Array<{ mockRestore: () => void }> = []

describe("memory embedder on an index with a pre opt-out document", () => {
  beforeAll(async () => {
    // A rebuild waits out twice the writers' "is a rebuild running" cache window
    // before reading and before dropping the old index; 100 ms instead of 1 s.
    IndexWriterTestAccess.setRebuildStateCacheMs(100)
    spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(INDEX_NAME))
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue(
        meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
      ),
    )
    MessageIndexerTestAccess.setEmbedderFactory(async () => fakeEmbedder)

    const created = await meili.createIndex(INDEX_NAME, { primaryKey: "id" })
    await meili.tasks.waitForTask(created.taskUid, { timeout: 120_000 })
    const { expectedSettings } = await import("~/modules/search/drift")
    const applied = await meili
      .index(INDEX_NAME)
      .updateSettings(
        expectedSettings({ registeredReadScopes: ["kernel:threads:read"], dimensionFields: [] }),
      )
    await meili.tasks.waitForTask(applied.taskUid, { timeout: 120_000 })
    // The legacy document: no `_vectors` at all.
    const added = await meili
      .index(INDEX_NAME)
      .addDocuments([{ id: `${ORG_ID}_legacy_1`, orgId: ORG_ID, title: "legacy" }])
    await meili.tasks.waitForTask(added.taskUid, { timeout: 120_000 })
    // A document that already carries a real vector: the sweep must not null it.
    const vectored = await meili.index(INDEX_NAME).addDocuments([
      {
        id: `${ORG_ID}_vectored_1`,
        orgId: ORG_ID,
        title: "vectored",
        _vectors: { memory: [0, 1, 0, 0] },
      },
    ])
    await meili.tasks.waitForTask(vectored.taskUid, { timeout: 120_000 })

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'EmbDeclOrg', ${`embdecl-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_ID}, ${ORG_ID}, ${`embdecl-${tag}@test.com`}, 'Emb Decl', 'x')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`embdecl${tag}`}, ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
  })

  afterAll(async () => {
    IndexWriterTestAccess.setRebuildStateCacheMs()
    MessageIndexerTestAccess.setEmbedderFactory(null)
    MessageIndexerTestAccess.resetEmbedderCache()
    for (const s of spies) s.mockRestore()
    try {
      await meili.deleteIndex(INDEX_NAME)
      await meili.deleteIndex(`${INDEX_NAME}__rebuild`)
    } catch {
      /* a test artifact */
    }
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("memory search skips the vector leg while the embedder is undeclared", async () => {
    expect(await memoryEmbedderDeclared(DIMENSIONS)).toBe(false)
    embedCalls = 0
    const res = await withRlsContext(actor, (tx) =>
      memorySearch({ query: "courier reference" }, {
        userId: USER_ID,
        orgId: ORG_ID,
        db: tx,
        scopes: [],
      } as never),
    )
    expect(Array.isArray(res.hits)).toBe(true)
    // The query is embedded only for a vector leg that will run.
    expect(embedCalls).toBe(0)
  })

  it("a declaration blocked by a legacy document asks for a rebuild, never sweeping the index", async () => {
    const enqueued: string[] = []
    spies.push(
      spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (_a: string, job: string) => {
        enqueued.push(job)
        return "job"
      }) as never),
    )
    const pagesRead = spyOn(Index.prototype, "getDocuments")
    spies.push(pagesRead)
    await redis.del("search:rebuild:embedder-dims")

    await expect(ensureMemoryEmbedderSettings(DIMENSIONS)).rejects.toThrow()
    // No page of the index was downloaded to find the legacy documents.
    expect(pagesRead).not.toHaveBeenCalled()
    expect(enqueued).toContain("search-reindex-full")
    expect(await redis.get("search:rebuild:embedder-dims")).toBe(String(DIMENSIONS))

    // The rebuild declares the embedder on the index it swaps in.
    const { runReindex } = await import("~/modules/search/reindex")
    const result = await runReindex()
    expect(result.swapped).toBe(true)
    const settings = (await meili.index(INDEX_NAME).getSettings()) as {
      embedders?: Record<string, { source?: string; dimensions?: number }> | null
    }
    expect(settings.embedders?.memory?.source).toBe("userProvided")
    expect(settings.embedders?.memory?.dimensions).toBe(DIMENSIONS)
    MessageIndexerTestAccess.resetEmbedderCache()
    expect(await memoryEmbedderDeclared(DIMENSIONS)).toBe(true)

    // A plain document write lands instead of failing with the settings task.
    const added = await meili
      .index(INDEX_NAME)
      .addDocuments([{ id: `${ORG_ID}_after_1`, title: "after", _vectors: { memory: null } }])
    const done = await meili.tasks.waitForTask(added.taskUid, { timeout: 120_000 })
    expect(done.status).toBe("succeeded")
    expect(await redis.get("search:rebuild:embedder-dims")).toBeNull()
  }, 180_000)
})
