// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The full rebuild (design audit finding 5): into a shadow index, swapped in
// atomically, with search serving the whole time, on real rows and a real
// Meili. Pinned:
//
//   - the live index answers every search while the rebuild runs, and is never
//     restructured in place;
//   - the swapped-in index has the expected settings and the shape fingerprint,
//     every document kind (messages and windows included, which the old full
//     reindex never rebuilt), and no ghost of a row that is gone;
//   - vectors are CARRIED from the live index, not re-embedded;
//   - a live change and a purge made DURING the build are in the result;
//   - one rebuild at a time.

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { MeiliSearch } from "meilisearch"
import { sql } from "~/db"
import * as jobsModule from "~/infra/jobs/jobs"
import * as searchClientModule from "~/infra/search/client"
import { JobRetryLaterError } from "~/lib/failure-severity"
import { redis } from "~/lib/redis"
import { deleteOrgSearchDocuments } from "~/modules/org/purge/external"
import { registerIndexSource } from "~/modules/search/index-sources"
import { deleteSearchDocumentsNow, IndexWriterTestAccess } from "~/modules/search/index-writer"
import {
  type Embedder,
  MessageIndexerTestAccess,
  processMessageIndexerJob,
} from "~/modules/search/message-indexer"

const ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const tag = ORG.slice(0, 8)
const LIVE = `test_rebuild_${tag}`
const DIMS = 4

const meili = new MeiliSearch({
  host: process.env.MEILISEARCH_HOST || "http://localhost:7700",
  apiKey: process.env.MEILISEARCH_API_KEY || "dev-master-key",
})

const fakeEmbedder: Embedder = {
  modelId: "fake-4",
  dimensions: DIMS,
  async embed(texts: string[]) {
    return { vectors: texts.map(() => [0, 0, 1, 0]), tokens: texts.length }
  },
}

const spies: Array<{ mockRestore: () => void }> = []
const ids: string[] = []
let midBuild: (() => Promise<void>) | null = null

async function insert(content: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`INSERT INTO kernel.messages
      (thread_id, org_id, author_id, content, required_scopes)
    VALUES (${THREAD}, ${ORG}, ${USER}, ${content}, '{}'::text[]) RETURNING id`
  return String(row?.id)
}

const docId = (id: string) => `${ORG}_kernel_message_${id}`

beforeAll(async () => {
  spies.push(spyOn(searchClientModule, "effectiveIndexName").mockReturnValue(LIVE))
  spies.push(
    spyOn(searchClientModule, "getMeili").mockReturnValue(
      meili as unknown as ReturnType<typeof searchClientModule.getMeili>,
    ),
  )
  spies.push(spyOn(jobsModule, "enqueueAppJob").mockImplementation((async () => "job") as never))
  await redis.del("search:rebuild:lock", "search:rebuild:touched", "search:rebuild:embedder-dims")
  IndexWriterTestAccess.resetRebuildCache()
  // Writers trust "is a rebuild running" for this long, and every rebuild waits
  // twice the window before reading and before dropping the old index. 100 ms
  // instead of 1 s keeps that ordering while sparing ~4 s per rebuild.
  IndexWriterTestAccess.setRebuildStateCacheMs(100)

  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'RebuildOrg', ${`rebuild-${tag}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
    VALUES (${USER}, ${ORG}, ${`rebuild-${tag}@test.com`}, 'Rebuilder', 'x')`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
    VALUES (${THREAD}, ${ORG}, ${`rebuild-${tag}`}, 'The capybara channel', ${USER})`
  for (let i = 0; i < 40; i++) ids.push(await insert(`capybara line ${i}`))

  // The LIVE index as older code left it: the old filterable set (entity_id
  // unique per document, no has_vector), every document written, one of them
  // with a vector, plus a ghost whose row is gone.
  const created = await meili.createIndex(LIVE, { primaryKey: "id" })
  await meili.tasks.waitForTask(created.taskUid)
  const old = await meili.index(LIVE).updateSettings({
    filterableAttributes: [
      "org_id",
      "app",
      "entity_type",
      "entity_id",
      "read_scope",
      "participant_ids",
      "is_mentionable",
      "dedupe_key",
      "required_scopes",
      "thread_id",
      "created_at",
    ],
    sortableAttributes: ["created_at", "updated_at"],
  })
  await meili.tasks.waitForTask(old.taskUid)
  process.env.GOOGLE_API_KEY = ""
  MessageIndexerTestAccess.resetEmbedderCache()
  for (const id of ids.slice(1)) {
    await processMessageIndexerJob({ action: "upsert", orgId: ORG, messageId: id })
  }
  MessageIndexerTestAccess.setEmbedderFactory(async () => fakeEmbedder)
  await processMessageIndexerJob({ action: "upsert", orgId: ORG, messageId: String(ids[0]) })
  MessageIndexerTestAccess.setEmbedderFactory(null)
  const ghost = await meili.index(LIVE).addDocuments([
    {
      id: docId(crypto.randomUUID()),
      org_id: ORG,
      app: "kernel",
      entity_type: "message",
      read_scope: "kernel:threads:read",
      title: "capybara ghost",
      _vectors: { memory: null },
    },
  ])
  await meili.tasks.waitForTask(ghost.taskUid)

  // A change and a purge that land WHILE the shadow is being built, after the
  // transcript source streamed the thread.
  registerIndexSource("zz-test-mid-build", async (orgId) => {
    if (orgId === ORG && midBuild) {
      const run = midBuild
      midBuild = null
      await run()
    }
  })
}, 120_000)

afterAll(async () => {
  IndexWriterTestAccess.setRebuildStateCacheMs()
  registerIndexSource("zz-test-mid-build", async () => {})
  for (const s of spies) s.mockRestore()
  MessageIndexerTestAccess.resetEmbedderCache()
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

describe("full rebuild: shadow index, atomic swap", () => {
  it("rebuilds everything into a shadow, swaps it in, and never stops serving", async () => {
    midBuild = async () => {
      // A live edit: the stream already read the old text. Far from message 0
      // (more than a window away), so no window it rewrites is the vectored one.
      await sql`UPDATE kernel.messages SET content = 'capybara line 35 now says tapir'
        WHERE id = ${ids[35]}`
      await processMessageIndexerJob({ action: "upsert", orgId: ORG, messageId: String(ids[35]) })
      // A purge: the stream already wrote this document into the shadow.
      await deleteSearchDocumentsNow(ORG, [docId(String(ids[36]))])
    }

    // Search the live name continuously for the whole run.
    let searching = true
    let searchesRun = 0
    let searchErrors = 0
    let emptyAnswers = 0
    const searcher = (async () => {
      while (searching) {
        try {
          const r = await meili.index(LIVE).search("capybara", {
            filter: `org_id = "${ORG}" AND entity_type = "message"`,
          })
          searchesRun += 1
          if (r.hits.length === 0) emptyAnswers += 1
        } catch {
          searchErrors += 1
        }
        await new Promise((r) => setTimeout(r, 20))
      }
    })()

    // How many documents carry a vector before (the message embedded with the
    // fake embedder, and any window its flush wrote).
    const before = await meili.index(LIVE).getDocuments({
      limit: 1000,
      retrieveVectors: true,
    } as never)
    const vectoredBefore = (before.results as Array<Record<string, unknown>>).filter((d) => {
      const m = (d._vectors as Record<string, { embeddings?: number[][] }> | undefined)?.memory
      return (m?.embeddings?.length ?? 0) > 0
    }).length
    expect(vectoredBefore).toBeGreaterThanOrEqual(1)

    const { runReindex } = await import("./reindex")
    const result = await runReindex()
    searching = false
    await searcher

    expect(result.swapped).toBe(true)
    expect(result.vectorsCarried).toBe(vectoredBefore)
    expect(searchErrors).toBe(0)
    expect(emptyAnswers).toBe(0)
    expect(searchesRun).toBeGreaterThan(5)

    const live = meili.index(LIVE)
    const settings = await live.getSettings()
    expect(settings.filterableAttributes).not.toContain("entity_id")
    expect(settings.filterableAttributes).toContain("has_vector")
    expect(settings.embedders?.memory).toMatchObject({ source: "userProvided", dimensions: DIMS })

    // The meta document carries the shape fingerprint boot compares.
    const meta = (await live.getDocument("__liaison_index_meta__")) as { shape?: string }
    const { catalogSearchInputs, currentCatalog } = await import(
      "~/modules/apps/catalog-derivations"
    )
    expect(meta.shape).toBe(catalogSearchInputs(await currentCatalog()).fingerprint)

    const messages = await live.getDocuments({
      filter: `org_id = "${ORG}" AND entity_type = "message"`,
      limit: 1000,
    })
    const byId = new Map(messages.results.map((d) => [String(d.id), d as Record<string, unknown>]))
    // Every live row, the ghost gone, the purged one gone, the edit applied.
    expect(byId.size).toBe(39)
    expect(byId.has(docId(String(ids[36])))).toBe(false)
    expect(byId.get(docId(String(ids[35])))?.title).toBe("capybara line 35 now says tapir")
    // Windows came back too: the old full reindex never rebuilt them at all.
    const windows = await live.getDocuments({
      filter: `org_id = "${ORG}" AND entity_type = "message_window"`,
      limit: 100,
    })
    expect(windows.results.length).toBeGreaterThan(0)
    // The vector was carried over, not recomputed (the embedder is gone now).
    const vectored = (await live.getDocument(docId(String(ids[0])), {
      retrieveVectors: true,
    } as never)) as Record<string, unknown>
    expect(vectored.has_vector).toBe(true)
    const memory = (vectored._vectors as Record<string, { embeddings?: number[][] }>).memory
    expect(memory?.embeddings?.[0]).toEqual([0, 0, 1, 0])

    // The old index is dropped once no writer can still target it: runReindex
    // waits out the writers' cache window and the delete task before returning.
    await expect(meili.getIndex(`${LIVE}__rebuild`)).rejects.toThrow()
  }, 180_000)

  it("runs one rebuild at a time", async () => {
    const { runReindex } = await import("./reindex")
    await redis.set("search:rebuild:lock", "someone-else", "PX", 5_000)
    try {
      const r = await runReindex()
      expect(r.swapped).toBe(false)
    } finally {
      await redis.del("search:rebuild:lock")
    }
  })

  it("boot finds nothing to do after a rebuild", async () => {
    const enqueued: string[] = []
    const spy = spyOn(jobsModule, "enqueueAppJob").mockImplementation((async (
      _a: string,
      job: string,
    ) => {
      enqueued.push(job)
      return "job"
    }) as never)
    try {
      const { detectDrift } = await import("./drift")
      const { catalogSearchInputs, currentCatalog } = await import(
        "~/modules/apps/catalog-derivations"
      )
      const catalog = catalogSearchInputs(await currentCatalog())
      await detectDrift({ ...catalog.settings, fingerprint: catalog.fingerprint })
      expect(enqueued).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

// W2 review findings 3 and 4.
describe("full rebuild: nothing noted is lost, the lock outlives a long org", () => {
  it("a replay that fails after the swap hands its requests to the live queue; a purge still lands", async () => {
    const { runReindex } = await import("./reindex")
    const liveQueue = await import("./live-index-queue")
    await liveQueue.LiveIndexTestAccess.clear()
    const purged = String(ids[20])
    const edited = String(ids[21])
    const realSwap = meili.swapIndexes.bind(meili)
    const swapSpy = spyOn(meili, "swapIndexes").mockImplementation((async (args: never) => {
      // Both land in the OLD live index and are only noted for replay.
      await deleteSearchDocumentsNow(ORG, [docId(purged)])
      await sql`UPDATE kernel.messages SET content = 'capybara line 21 says wombat' WHERE id = ${edited}`
      await processMessageIndexerJob({ action: "upsert", orgId: ORG, messageId: edited })
      return await realSwap(args)
    }) as never)
    const resolveSpy = spyOn(liveQueue, "resolveLiveIndexItems").mockImplementation((async () => {
      throw new Error("transient hiccup during the replay")
    }) as never)
    let result: Awaited<ReturnType<typeof runReindex>>
    try {
      result = await runReindex()
    } finally {
      swapSpy.mockRestore()
      resolveSpy.mockRestore()
    }
    // The swap happened: the rebuild reports it, it does not throw.
    expect(result.swapped).toBe(true)
    // The purge was applied directly, needing no resolution.
    await expect(meili.index(LIVE).getDocument(docId(purged))).rejects.toThrow()
    // The edit was handed to the live queue rather than dropped...
    const pending = await liveQueue.LiveIndexTestAccess.pendingItems()
    expect(pending.map((p) => p.key)).toContain(docId(edited))
    expect(await redis.hlen("search:rebuild:touched")).toBe(0)
    // ...whose flusher applies it.
    while ((await liveQueue.flushLiveIndexOnce()) > 0) {}
    for (const uid of Object.keys(await liveQueue.LiveIndexTestAccess.ledger())) {
      await meili.tasks.waitForTask(Number(uid))
    }
    const doc = (await meili.index(LIVE).getDocument(docId(edited))) as { title?: string }
    expect(doc.title).toBe("capybara line 21 says wombat")
    await liveQueue.LiveIndexTestAccess.clear()
  }, 180_000)

  // The org purge deletes an org's documents with ONE filter (org_id), noted
  // for the running rebuild: the shadow already holds the org's documents from
  // the pages it streamed, and without the replay the swap would bring them back.
  it("an org purge's filter delete during a rebuild is replayed on the shadow", async () => {
    const { runReindex } = await import("./reindex")
    const org2 = crypto.randomUUID()
    const user2 = crypto.randomUUID()
    const thread2 = crypto.randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${org2}, 'PurgedOrg', ${`rebuild-purged-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${user2}, ${org2}, ${`rebuild-purged-${tag}@test.com`}, 'Purged', 'x')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
      VALUES (${thread2}, ${org2}, ${`rebuild-purged-${tag}`}, 'The okapi channel', ${user2})`
    for (let i = 0; i < 3; i++) {
      const [row] = await sql<{ id: string }[]>`INSERT INTO kernel.messages
          (thread_id, org_id, author_id, content, required_scopes)
        VALUES (${thread2}, ${org2}, ${user2}, ${`okapi line ${i}`}, '{}'::text[]) RETURNING id`
      await processMessageIndexerJob({ action: "upsert", orgId: org2, messageId: String(row?.id) })
    }
    const count = async (index = LIVE) =>
      Number(
        (
          await meili
            .index(index)
            .getDocuments({ filter: `org_id = "${org2}"`, limit: 1, fields: ["id"] })
        ).total,
      )
    expect(await count()).toBeGreaterThan(0)
    let inShadow = -1
    const realSwap = meili.swapIndexes.bind(meili)
    const swapSpy = spyOn(meili, "swapIndexes").mockImplementation((async (args: never) => {
      // The shadow streamed org2 already. The purge removes its rows, then its
      // documents from the (old) live index, noting the filter for the replay.
      inShadow = await count(`${LIVE}__rebuild`)
      await sql`DELETE FROM kernel.messages WHERE org_id = ${org2}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${org2}`
      await sql`DELETE FROM kernel.users WHERE org_id = ${org2}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${org2}`
      // The purge's delete lands on the OLD live index before the swap: only the
      // replay can carry it to the shadow.
      for (const uid of await deleteOrgSearchDocuments(org2)) await meili.tasks.waitForTask(uid)
      expect(await count()).toBe(0)
      return await realSwap(args)
    }) as never)
    let result: Awaited<ReturnType<typeof runReindex>>
    try {
      result = await runReindex()
    } finally {
      swapSpy.mockRestore()
    }
    expect(result.swapped).toBe(true)
    expect(inShadow).toBeGreaterThan(0)
    expect(await count()).toBe(0)
    // The live org's documents are still there.
    const kept = await meili
      .index(LIVE)
      .getDocuments({ filter: `org_id = "${ORG}"`, limit: 1, fields: ["id"] })
    expect(Number(kept.total)).toBeGreaterThan(0)
  }, 180_000)

  it("keeps its lock alive through a stretch longer than the lock's TTL", async () => {
    const { runReindex, ReindexTestAccess } = await import("./reindex")
    ReindexTestAccess.setLockTiming(300, 60)
    midBuild = async () => {
      // One org taking longer than the TTL (2.5x): the lock must not expire under it.
      await new Promise((r) => setTimeout(r, 750))
      // Another rebuild trying now finds it held.
      expect(await redis.set("search:rebuild:lock", "intruder", "PX", 5_000, "NX")).toBeNull()
    }
    try {
      const r = await runReindex()
      expect(r.swapped).toBe(true)
    } finally {
      ReindexTestAccess.setLockTiming(3 * 60_000, 30_000)
    }
  }, 180_000)

  // The queues are force-closed on shutdown, so a deploy that interrupts a
  // rebuild used to leave its lock behind: the next boot's rebuild then failed
  // on it until the TTL ran out, plus the retry backoff (minutes of a missing
  // index after the restart).
  it("a shutdown mid-rebuild hands the lock back and the interrupted run stops before the swap", async () => {
    const { runReindex, releaseRebuildLockForShutdown } = await import("./reindex")
    midBuild = async () => {
      expect(await redis.get("search:rebuild:lock")).not.toBeNull()
      await releaseRebuildLockForShutdown()
      // Free at once: the next boot's rebuild can take it.
      expect(await redis.get("search:rebuild:lock")).toBeNull()
    }
    await expect(runReindex()).rejects.toThrow(/lost its lock/)
    midBuild = null
    expect(await redis.get("search:rebuild:lock")).toBeNull()
    // Nothing left held, so a second call is a no-op.
    await releaseRebuildLockForShutdown()
  }, 180_000)

  it("a rebuild job that finds the lock held fails and is retried, never completes as done", async () => {
    let handler: (() => Promise<void>) | null = null
    const reg = spyOn(jobsModule, "registerJobWorker").mockImplementation(((
      _a: string,
      name: string,
      h: () => Promise<void>,
    ) => {
      if (name === "search-reindex-full") handler = h
    }) as never)
    const { registerReindexWorker, SearchDriftTestAccess } = await import("./drift")
    SearchDriftTestAccess.resetReindexRegistration()
    registerReindexWorker()
    reg.mockRestore()
    SearchDriftTestAccess.resetReindexRegistration()
    await redis.set("search:rebuild:lock", "a-crashed-rebuild", "PX", 5_000)
    try {
      const rejection = (handler as unknown as () => Promise<void>)()
      await expect(rejection).rejects.toThrow(/lock is held/)
      // An expected wait: the job worker logs it at warn, not as a handler error.
      await expect(rejection).rejects.toBeInstanceOf(JobRetryLaterError)
    } finally {
      await redis.del("search:rebuild:lock")
    }
    const { REBUILD_JOB_OPTIONS } = await import("./reindex")
    expect(REBUILD_JOB_OPTIONS.attempts).toBeGreaterThan(2)
    expect(REBUILD_JOB_OPTIONS.backoff.delay).toBeGreaterThanOrEqual(60_000)
  })
})
