// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The full rebuild of the unified search index, and the per-org resync.
//
// SHADOW, THEN SWAP
// -----------------
// A rebuild never touches the live index's structure and never makes search
// unavailable. It builds a complete new index beside the live one, then swaps
// the two atomically (Meili `swapIndexes`): every search before the swap is
// answered by the old index, every search after it by the new one.
//
//   1. Take the rebuild lock (Redis). From then on every write to the live
//      index is also NOTED (index-writer.ts). Wait out the writers' cache.
//   2. Create `<live>__rebuild` with the expected settings, and the live
//      index's embedder (or the one a caller asked for), so every document
//      written into it may carry a vector from the start.
//   3. Stream every org from Postgres with KEYSET pagination: the registered
//      entities, then every registered source (index-sources.ts: messages and
//      windows, brief rows, episodes, mail fragments). Batches are pipelined:
//      at most MAX_IN_FLIGHT Meili tasks queued, none awaited one by one.
//      An org's entities come from its registered apps, so an org is set up
//      in this process just before its stream, and one the rebuild alone set
//      up is released right after it (rebuildOrgRuntime): a rebuild holds one
//      org's runtime at a time, not every org of the instance at once.
//   4. Carry the vectors over from the live index: only documents with
//      `has_vector = true` are read with their vectors (every document on the
//      first rebuild of an index that predates the flag), and only into ids
//      this build wrote, as a partial update. Nothing is re-embedded.
//   5. Replay what was written live while 1 to 4 ran (the noted requests,
//      re-resolved from Postgres now), write the meta document with the shape
//      fingerprint, and wait for every task.
//   6. Swap. Replay again whatever was noted between step 5 and the swap, this
//      time into the new live index. Past the swap nothing fails the rebuild:
//      a replay that cannot finish hands its requests to the live index queue,
//      whose flusher retries them. Release the lock, delete the old index.
//
// The lock is renewed on a timer (a single org can take longer than any fixed
// TTL), so a crashed rebuild frees it within LOCK_TTL_MS. A job that finds it
// held FAILS and is retried with a growing delay (REBUILD_JOB_OPTIONS), rather
// than completing as though it had rebuilt.
//
// ERASED TEXT stays out: the transcript source skips messages whose author is
// an erased user (message-indexer.ts, QUOTABLE), since erasure keeps the rows
// of shared threads and only removed their documents.
//
// Why the replay: a page is built from Postgres at one instant and reaches
// Meili later; a live change in between would otherwise be overwritten in the
// shadow by the older copy, and a change after the page (or a delete, such as a
// mailbox purge) would be lost at the swap. Replaying re-reads the rows, so the
// shadow ends up with each touched document as it stands. Deletes that name
// their documents are applied as they are, re-reading nothing, and a noted
// request is removed only once it has been applied (replayTouched).
//
// COST. Measured locally (Meili 1.10.3, 200k messages in 20 threads): 250k
// documents built from Postgres and indexed into the shadow in 33 s, about
// 7.5k documents a second. Production's ~720k documents are therefore minutes,
// not hours; the first rebuild also reads every transcript document once for
// its vector (the live index predates `has_vector`), later ones only the
// vectored few. Searches are unaffected throughout. Meili runs one task queue
// for all indexes, so live writes wait behind a shadow batch (seconds) while
// the rebuild runs.

import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { effectiveIndexName, ensureMeiliVectorStore, getMeili } from "~/infra/search/client"
import { searchLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { quoteIdent } from "~/lib/sql-utils"
import {
  initializedOrgRuntimes,
  orgRuntimeInitPromises,
  orgRuntimeLastTouch,
} from "~/modules/apps/app-registries"
import { catalogSearchInputs, currentCatalog } from "~/modules/apps/catalog-derivations"
import { awaitOrgApps } from "~/modules/apps/init"
import { buildSearchDocument } from "~/modules/search/doc-builder"
import { expectedSettings, indexMetaDocument, settingsMatch } from "~/modules/search/index-shape"
import { indexSources } from "~/modules/search/index-sources"
import {
  finalizeDocuments,
  noteIndexWrites,
  REBUILD_KEYS,
  rebuildStateCacheWindowMs,
  sendIndexWrite,
  waitForIndexTasks,
  writeIndexAndWait,
} from "~/modules/search/index-writer"
import {
  type LiveIndexItem,
  rawDeleteItem,
  recordLiveIndex,
  resolveLiveIndexItems,
} from "~/modules/search/live-index-queue"
import { waitForMeiliTask } from "~/modules/search/meili-task"
import {
  collectSearchableRegistrations,
  rowPassesIndexFilter,
  type SearchableEntityRegistration,
} from "~/modules/search/searchable-entities"
import { MEMORY_EMBEDDER_NAME } from "~/modules/search/vector-opt-out"

/** The job name the rebuild runs under (registered by drift.ts). */
export const REBUILD_JOB = "search-reindex-full"

/**
 * How every requester enqueues it: one job id, so a rebuild already waiting
 * serves them all; and retried with a growing delay, because a run that finds
 * the lock held (another rebuild, or a crashed one's lock not yet expired)
 * FAILS rather than completing as if it had rebuilt (drift.ts).
 */
export const REBUILD_JOB_OPTIONS = {
  jobId: REBUILD_JOB,
  attempts: 10,
  backoff: { type: "exponential", delay: 60_000 },
}

const PAGE_SIZE = 1000
/** Meili tasks a rebuild keeps queued before waiting for the oldest. */
const MAX_IN_FLIGHT = 4
/** The lock outlives a crashed rebuild by at most this long... */
let LOCK_TTL_MS = 3 * 60_000
/** ...and a live rebuild renews it this often. */
let LOCK_HEARTBEAT_MS = 30_000
/** A rebuild asked to declare the embedder remembers the width here. */
const EMBEDDER_REQUEST_KEY = "search:rebuild:embedder-dims"
const VECTOR_COPY_PAGE = 500
const TRANSCRIPT_TYPES = ["message", "message_window", "brief_row", "episode"]

type Meili = ReturnType<typeof getMeili>
type Index = ReturnType<Meili["index"]>
type Doc = Record<string, unknown>

// Meili filter-string escaping, as permission-filter.ts does it.
function meiliEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function qualifiedTable(reg: SearchableEntityRegistration): string | null {
  if (!reg.tableName) return null
  const schemaName =
    reg.app === "kernel"
      ? "kernel"
      : ((reg as { schemaName?: string }).schemaName ?? `app_${reg.app}`)
  return `${quoteIdent(schemaRef(schemaName))}.${quoteIdent(reg.tableName)}`
}

/**
 * Stream one registered entity of one org, KEYSET-paged by id, building each
 * page's documents with the shared doc builder. Returns the rows read.
 */
async function streamEntity(
  reg: SearchableEntityRegistration,
  orgId: string,
  onBatch: (docs: Doc[]) => Promise<void>,
  onLiveIds?: (ids: string[]) => void,
): Promise<number> {
  const qualified = qualifiedTable(reg)
  if (!qualified) {
    log.warn({ app: reg.app, entityType: reg.entityType }, "Reindex: no table name configured")
    return 0
  }
  const table = sql.raw(qualified)
  let total = 0
  let after: string | null = null
  for (;;) {
    const cursor: string | null = after
    const rows: Doc[] = await withPrivilegedDb(
      orgId,
      `reindex:${reg.app}:${reg.entityType}`,
      async (tx) => {
        // Scoped to the loop's org explicitly: this runs under BYPASSRLS, and an
        // unfiltered SELECT would tag every org's rows with this org's id.
        const res: unknown = await tx.execute(
          sql`SELECT * FROM ${table} WHERE org_id = ${orgId}
            ${cursor ? sql`AND id > ${cursor}` : sql``}
            ORDER BY id ASC LIMIT ${PAGE_SIZE}`,
        )
        return ((res as { rows?: Doc[] }).rows ?? (res as Doc[]) ?? []) as Doc[]
      },
    )
    if (rows.length === 0) break
    after = String(rows[rows.length - 1]?.id)
    // Enrichment reads (tickets' contact and message lookups) run per row, so
    // pages build sequentially rather than as a burst of concurrent queries.
    const docs: Doc[] = []
    for (const row of rows) {
      // Ineligible rows (e.g. deactivated users) are skipped; the prune sweep
      // removes any stale document for them.
      if (!rowPassesIndexFilter(reg, row)) continue
      docs.push(await buildSearchDocument(reg, orgId, row))
    }
    onLiveIds?.(docs.map((d) => d.id as string))
    if (docs.length > 0) await onBatch(docs)
    total += rows.length
    if (rows.length < PAGE_SIZE) break
  }
  return total
}

/**
 * Deletes the documents of one (org, app, entityType) that no longer have a
 * backing row: the safety net for hard deletes that emit no event (a cascade
 * from a deleted `synced_sources` row). Diffs the index's ids against the ids
 * the stream just built.
 */
export async function pruneGhostDocuments(
  index: Index,
  meili: Meili,
  orgId: string,
  reg: SearchableEntityRegistration,
  liveIds: Set<string>,
): Promise<number> {
  const filter = `org_id = "${meiliEscape(orgId)}" AND app = "${meiliEscape(reg.app)}" AND entity_type = "${meiliEscape(reg.entityType)}"`
  const ghostIds: string[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await index.getDocuments({ filter, fields: ["id"], limit: PAGE_SIZE, offset })
    const results = (page as { results?: Array<{ id: string }> }).results ?? []
    for (const doc of results) if (!liveIds.has(doc.id)) ghostIds.push(doc.id)
    if (results.length < PAGE_SIZE) break
  }
  if (ghostIds.length === 0) return 0
  // A ghost removed while a rebuild runs must not come back at its swap.
  await noteIndexWrites([
    rawDeleteItem(orgId, `prune:${ghostIds[0]}:${ghostIds.length}`, { ids: ghostIds }),
  ])
  const task = await index.deleteDocuments(ghostIds)
  await waitForMeiliTask(meili, (task as { taskUid?: number }).taskUid)
  log.info(
    { orgId, app: reg.app, entityType: reg.entityType, count: ghostIds.length },
    "Reindex: pruned ghost documents with no backing row",
  )
  return ghostIds.length
}

async function listOrgIds(): Promise<string[]> {
  return await withPrivilegedDb("__reindex__", "reindex:list-orgs", async (tx) => {
    const res = await tx.execute(sql.raw(`SELECT id FROM ${schemaRef("kernel")}.organizations`))
    const rows = ((res as { rows?: Doc[] }).rows ?? (res as Doc[])) as Array<{ id: string }>
    return rows.map((r) => r.id)
  })
}

/**
 * Set `orgId` up in this process for the rebuild's stream of it. Returns the
 * step that undoes it: an org the rebuild alone set up (not set up, nor being
 * set up, before; nothing touched it while it streamed) is released again
 * (org-runtime-release.ts), so the rebuild does not leave the runtime of every
 * org of the instance behind in the leader. An org other work set up stays.
 */
export async function rebuildOrgRuntime(orgId: string): Promise<() => Promise<void>> {
  const wasSetUp = initializedOrgRuntimes.has(orgId) || orgRuntimeInitPromises.has(orgId)
  await awaitOrgApps(orgId)
  if (wasSetUp || !initializedOrgRuntimes.has(orgId)) return async () => {}
  const touchedAt = orgRuntimeLastTouch.get(orgId)
  return async () => {
    if (!initializedOrgRuntimes.has(orgId)) return
    if (orgRuntimeLastTouch.get(orgId) !== touchedAt) return
    const { releaseOrgRuntimes } = await import("~/modules/apps/org-runtime-release")
    await releaseOrgRuntimes([orgId], { gone: false, reason: "search-rebuild" })
  }
}

/** Set up the orgs of noted live writes, so their documents resolve (replayTouched). */
async function setUpOrgsOf(items: LiveIndexItem[]): Promise<void> {
  const orgIds = new Set<string>()
  for (const i of items) {
    const orgId = (i.payload as { orgId?: unknown }).orgId
    if (typeof orgId === "string" && orgId !== "") orgIds.add(orgId)
  }
  for (const orgId of orgIds) await awaitOrgApps(orgId)
}

/**
 * What {@link reindexOrg} reaches outside itself, as a seam: the defaults are
 * the real Meili index and the real Postgres read, and a test passes fakes.
 */
export interface ReindexOrgDeps {
  meili: Meili
  index: Index
  registrations: SearchableEntityRegistration[]
  stream: typeof streamEntity
}

/**
 * Rebuild ONE org's registered entity documents IN PLACE and sweep the ghosts.
 *
 * For a bulk delete that goes around the entity events: the demo content reset
 * clears an org with plain DELETEs and seeds it again under new ids, and
 * without the sweep every seeded result showed up once per night.
 */
export async function reindexOrg(
  orgId: string,
  deps: Partial<ReindexOrgDeps> = {},
): Promise<{ docs: number; pruned: number }> {
  const meili = deps.meili ?? getMeili()
  const index = deps.index ?? meili.index(effectiveIndexName())
  const registrations = deps.registrations ?? collectSearchableRegistrations(orgId).entities
  const stream = deps.stream ?? streamEntity
  let docs = 0
  let pruned = 0
  for (const reg of registrations) {
    if (!reg.permissionFields || !reg.tableName) continue
    const liveIds = new Set<string>()
    docs += await stream(
      reg,
      orgId,
      async (batch) => {
        // Noted for a running rebuild (its shadow may hold these rows as they
        // were), then written and waited: a caller that searches right after
        // (the chaos harness's post-seed resync) must find the documents.
        await noteIndexWrites(
          batch.map((d) => ({
            t: "entity",
            key: String(d.id),
            payload: {
              action: "upsert" as const,
              orgId,
              app: reg.app,
              entityType: reg.entityType,
              entityId: String(d.entity_id),
            },
          })),
        )
        const task = await index.addDocuments(finalizeDocuments(batch))
        await waitForMeiliTask(meili, (task as { taskUid?: number }).taskUid)
      },
      (ids) => {
        for (const id of ids) liveIds.add(id)
      },
    )
    pruned += await pruneGhostDocuments(index, meili, orgId, reg, liveIds)
  }
  return { docs, pruned }
}

/* -------------------------------------------------------------------------- */
/* The full rebuild                                                           */
/* -------------------------------------------------------------------------- */

/** Bounded pipeline of Meili tasks: queue, and wait for the oldest past the cap. */
class TaskPipeline {
  private queued: number[] = []
  async add(uids: number[]): Promise<void> {
    this.queued.push(...uids)
    while (this.queued.length > MAX_IN_FLIGHT) await waitForIndexTasks([this.queued.shift()!])
  }
  async drain(): Promise<void> {
    await waitForIndexTasks(this.queued.splice(0))
  }
}

const EXTEND_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`

/**
 * Keeps the rebuild lock alive while the rebuild runs: a timer, not a check
 * between orgs (production is ONE org of ~565k documents, longer than any
 * fixed TTL). The TTL stays short so a crashed rebuild frees the lock within
 * minutes. `assertHeld` is called before anything irreversible.
 */
class RebuildLock {
  /** The lock this process holds, if any: what a shutdown hands back. */
  static held: RebuildLock | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lost = false

  constructor(private readonly token: string) {}

  static async acquire(): Promise<RebuildLock | null> {
    const token = `${process.pid}:${Math.random().toString(36).slice(2)}`
    const got = await redis.set(REBUILD_KEYS.lock, token, "PX", LOCK_TTL_MS, "NX")
    if (got !== "OK") return null
    const lock = new RebuildLock(token)
    lock.timer = setInterval(() => void lock.extend(), LOCK_HEARTBEAT_MS)
    RebuildLock.held = lock
    return lock
  }

  private async extend(): Promise<void> {
    try {
      const ok = await redis.eval(EXTEND_LOCK_LUA, 1, REBUILD_KEYS.lock, this.token, LOCK_TTL_MS)
      if (ok !== 1) this.lost = true
    } catch (err) {
      log.warn({ err }, "Could not extend the search rebuild lock")
    }
  }

  async assertHeld(): Promise<void> {
    await this.extend()
    if (this.lost) throw new Error("search rebuild lost its lock; aborting before the swap")
  }

  async release(opts: { keepTouched: boolean }): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (RebuildLock.held === this) RebuildLock.held = null
    const held = await redis.get(REBUILD_KEYS.lock).catch(() => null)
    if (held !== this.token) return
    const keys = opts.keepTouched ? [REBUILD_KEYS.lock] : [REBUILD_KEYS.lock, REBUILD_KEYS.touched]
    await redis.del(...keys).catch(() => 0)
  }
}

async function deleteIndexIfExists(meili: Meili, name: string): Promise<void> {
  try {
    const task = await meili.deleteIndex(name)
    await waitForMeiliTask(meili, (task as { taskUid?: number }).taskUid)
  } catch {
    // Absent is what we wanted.
  }
}

/**
 * Replay the noted requests into `indexName`; returns how many were replayed.
 *
 * The noted requests are moved to a snapshot key atomically (requests noted
 * from then on land in a fresh hash) and the snapshot is deleted only once
 * every request in it is applied. Deletes that name their documents (a purge,
 * an erasure) are applied first and directly, without re-reading anything, so
 * a Postgres hiccup can never hold one back. On any failure the snapshot is
 * merged back into the noted requests (never over a newer note of the same
 * document) and the error is thrown: nothing noted is ever dropped.
 */
async function replayTouched(indexName: string): Promise<number> {
  const snapshot = `${REBUILD_KEYS.touched}:replaying`
  const moved = await redis.renamenx(REBUILD_KEYS.touched, snapshot).catch(() => 0)
  if (moved !== 1) return 0
  const raw = await redis.hgetall(snapshot)
  const items: LiveIndexItem[] = []
  for (const v of Object.values(raw)) {
    try {
      items.push(JSON.parse(v) as LiveIndexItem)
    } catch {
      /* unreadable, dropped: the live index still has the write */
    }
  }
  try {
    const direct = items.filter((i) => i.t === "raw")
    const deleteIds = direct.flatMap((i) =>
      Array.isArray(i.payload.ids) ? (i.payload.ids as unknown[]).map(String) : [],
    )
    const deleteFilters = direct
      .map((i) => i.payload.filter)
      .filter((f): f is string => typeof f === "string" && f.length > 0)
    if (deleteIds.length > 0 || deleteFilters.length > 0) {
      await writeIndexAndWait({ deleteIds, deleteFilters }, { indexName })
    }
    const rest = items.filter((i) => i.t !== "raw")
    // The rebuild released the orgs it set up only for their stream: the ones
    // written meanwhile are set up again before their documents are built.
    await setUpOrgsOf(rest)
    for (let i = 0; i < rest.length; i += PAGE_SIZE) {
      const resolved = await resolveLiveIndexItems(rest.slice(i, i + PAGE_SIZE))
      if (resolved.failed.length > 0) throw new Error("search replay could not build documents")
      await writeIndexAndWait(resolved, { indexName })
    }
  } catch (err) {
    const tx = redis.multi()
    for (const [key, value] of Object.entries(raw)) tx.hsetnx(REBUILD_KEYS.touched, key, value)
    tx.del(snapshot)
    await tx.exec().catch(() => undefined)
    throw err
  }
  await redis.del(snapshot)
  return items.length
}

/**
 * After the swap, the replay has nowhere to retreat to: the new index is live.
 * A replay that fails hands every noted request to the live index queue, whose
 * flusher applies them to the (now live) index and retries until they land.
 * Returns true when nothing noted is left behind.
 */
async function replayAfterSwap(indexName: string): Promise<{ replayed: number; clean: boolean }> {
  try {
    return { replayed: await replayTouched(indexName), clean: true }
  } catch (err) {
    log.error({ err }, "Search rebuild: replay after the swap failed; handing it to the live queue")
    try {
      const values = await redis.hvals(REBUILD_KEYS.touched)
      const items = values.map((v) => JSON.parse(v) as LiveIndexItem)
      await recordLiveIndex(items)
      await redis.del(REBUILD_KEYS.touched)
      return { replayed: 0, clean: true }
    } catch (handOff) {
      log.error(
        { err: handOff },
        "Search rebuild: could not hand the replay to the live queue; the noted requests stay in Redis",
      )
      return { replayed: 0, clean: false }
    }
  }
}

/** Copy vectors from `live` into `shadow` for the transcript ids this build wrote. */
async function carryVectors(
  live: Index,
  shadow: Index,
  written: Set<string>,
  liveHasFlag: boolean,
): Promise<number> {
  const filter = liveHasFlag
    ? "has_vector = true"
    : `app = "kernel" AND entity_type IN [${TRANSCRIPT_TYPES.map((t) => `"${t}"`).join(", ")}]`
  const pipeline = new TaskPipeline()
  let copied = 0
  await ensureMeiliVectorStore()
  for (let offset = 0; ; offset += VECTOR_COPY_PAGE) {
    const page = (await live.getDocuments({
      filter,
      fields: ["id"],
      limit: VECTOR_COPY_PAGE,
      offset,
      retrieveVectors: true,
    } as never)) as { results?: Doc[] }
    const results = page.results ?? []
    const updates: Doc[] = []
    for (const doc of results) {
      const id = String(doc.id)
      if (!written.has(id)) continue
      const raw = (doc._vectors as Record<string, unknown> | undefined)?.memory
      const embeddings = Array.isArray(raw)
        ? raw
        : ((raw as { embeddings?: unknown } | undefined)?.embeddings ?? null)
      const vector = Array.isArray(embeddings)
        ? ((Array.isArray(embeddings[0]) ? embeddings[0] : embeddings) as number[])
        : null
      if (!vector || vector.length === 0) continue
      updates.push({ id, _vectors: { memory: vector }, has_vector: true })
    }
    if (updates.length > 0) {
      // A PARTIAL update, into ids this build wrote: it can never create a
      // stub document for an id the shadow does not hold.
      const task = await shadow.updateDocuments(updates)
      await pipeline.add([(task as { taskUid: number }).taskUid])
      copied += updates.length
    }
    if (results.length < VECTOR_COPY_PAGE) break
  }
  await pipeline.drain()
  return copied
}

export interface RebuildResult {
  orgs: number
  docs: number
  vectorsCarried: number
  replayed: number
  swapped: boolean
  /** Set when nothing ran because another rebuild holds the lock. */
  skipped?: "locked"
}

/**
 * Rebuild the whole index into a shadow and swap it in (see the header).
 * Returns `swapped: false` without doing anything when another rebuild holds
 * the lock.
 */
export async function runReindex(): Promise<RebuildResult & { pruned: number }> {
  const lock = await RebuildLock.acquire()
  if (!lock) {
    log.info("A search index rebuild holds the lock; this one did nothing")
    return {
      orgs: 0,
      docs: 0,
      pruned: 0,
      vectorsCarried: 0,
      replayed: 0,
      swapped: false,
      skipped: "locked",
    }
  }
  let keepTouched = false
  const started = Date.now()
  const meili = getMeili()
  const liveName = effectiveIndexName()
  const shadowName = `${liveName}__rebuild`
  const live = meili.index(liveName)
  const shadow = meili.index(shadowName)
  try {
    await redis.del(REBUILD_KEYS.touched)
    // No writer may still believe no rebuild runs once the first page is read.
    await new Promise((r) => setTimeout(r, 2 * rebuildStateCacheWindowMs() + 100))

    const orgIds = await listOrgIds()
    // The settings and shape come from the installed catalog, the same for
    // every org (catalog-derivations.ts).
    const catalog = catalogSearchInputs(await currentCatalog())
    const union = catalog.settings
    const fingerprint = catalog.fingerprint

    // The live index's embedder (and flag), or the width a caller asked for.
    let liveSettings: {
      embedders?: Record<string, unknown> | null
      filterableAttributes?: string[]
    } = {}
    let liveExists = true
    try {
      liveSettings = (await live.getSettings()) as typeof liveSettings
    } catch {
      liveExists = false
    }
    const requestedDims = Number(await redis.get(EMBEDDER_REQUEST_KEY).catch(() => null))
    const embedders: Record<string, unknown> = { ...(liveSettings.embedders ?? {}) }
    if (Number.isFinite(requestedDims) && requestedDims > 0) {
      embedders.memory = { source: "userProvided", dimensions: requestedDims }
    }

    await deleteIndexIfExists(meili, shadowName)
    const created = await meili.createIndex(shadowName, { primaryKey: "id" })
    await waitForMeiliTask(meili, (created as { taskUid?: number }).taskUid)
    if (Object.keys(embedders).length > 0) {
      await ensureMeiliVectorStore().catch(() => undefined)
    }
    const settingsTask = await shadow.updateSettings({
      ...expectedSettings(union),
      ...(Object.keys(embedders).length > 0 ? { embedders } : {}),
    } as never)
    await waitForMeiliTask(meili, (settingsTask as { taskUid?: number }).taskUid)

    // Stream everything into the shadow.
    const pipeline = new TaskPipeline()
    const transcriptIds = new Set<string>()
    let docs = 0
    const sink = async (batch: Doc[], opts: { transcript?: boolean } = {}) => {
      if (batch.length === 0) return
      if (opts.transcript) for (const d of batch) transcriptIds.add(String(d.id))
      docs += batch.length
      await pipeline.add(await sendIndexWrite({ docs: batch }, { indexName: shadowName }))
    }
    for (const orgId of orgIds) {
      // Each org's searchable entities come from its registered apps: the org
      // is set up first (one still registering after a restart is awaited),
      // and released after its stream when only the rebuild needed it.
      const releaseOrg = await rebuildOrgRuntime(orgId)
      try {
        for (const reg of collectSearchableRegistrations(orgId).entities) {
          if (!reg.permissionFields || !reg.tableName) continue
          await streamEntity(reg, orgId, (batch) => sink(batch))
        }
        for (const [name, source] of indexSources()) {
          try {
            await source(orgId, sink)
          } catch (err) {
            // A source that cannot stream fails the rebuild: swapping in an index
            // missing a whole kind of document would be worse than keeping the
            // live one.
            log.error({ err, orgId, source: name }, "Search rebuild source failed")
            throw err
          }
        }
        // The org's batches are queued, not yet written: the documents are
        // already built, so its registrations are no longer read.
      } finally {
        await releaseOrg()
      }
    }
    await pipeline.drain()

    // Only an index with the memory embedder can hold vectors, and on Meili
    // 1.10 reading them from one without it is refused (the vector store is an
    // experimental feature a keyword-only deployment never turned on).
    const vectorsCarried =
      liveExists && liveSettings.embedders?.[MEMORY_EMBEDDER_NAME]
        ? await carryVectors(
            live,
            shadow,
            transcriptIds,
            (liveSettings.filterableAttributes ?? []).includes("has_vector"),
          )
        : 0
    transcriptIds.clear()

    await lock.assertHeld()
    let replayed = await replayTouched(shadowName)
    await writeIndexAndWait(
      { docs: [indexMetaDocument(fingerprint, catalog.versions)] },
      { indexName: shadowName },
    )

    // The swap. A live index that does not exist (first build) is created
    // empty first: Meili swaps two existing indexes.
    await lock.assertHeld()
    if (!liveExists) {
      const t = await meili.createIndex(liveName, { primaryKey: "id" })
      await waitForMeiliTask(meili, (t as { taskUid?: number }).taskUid)
    }
    const swap = await meili.swapIndexes([{ indexes: [liveName, shadowName] }])
    await waitForMeiliTask(meili, (swap as { taskUid?: number }).taskUid)
    // Whatever was written to the old live index between the first replay and
    // the swap is now missing from the new live index: replay it there. From
    // here on nothing may fail the rebuild: the swap has happened.
    const after = await replayAfterSwap(liveName)
    replayed += after.replayed
    keepTouched = !after.clean
    // An app registered at runtime while the shadow was built widened the OLD
    // index's filterable attributes (drift.ensureSearchSettingsCover); carry
    // that over, or a search filtering on its field fails until the next boot.
    try {
      const nowExpected = expectedSettings(catalogSearchInputs(await currentCatalog()).settings)
      if (!settingsMatch(await live.getSettings(), nowExpected)) {
        await live.updateSettings(nowExpected)
      }
    } catch (err) {
      log.warn({ err }, "Search rebuild: could not carry runtime settings over; next boot will")
    }
    await redis.del(EMBEDDER_REQUEST_KEY).catch(() => undefined)

    const result = { orgs: orgIds.length, docs, pruned: 0, vectorsCarried, replayed, swapped: true }
    log.info(
      { ...result, ms: Date.now() - started, fingerprint },
      "Search index rebuilt and swapped",
    )
    return result
  } finally {
    await lock.release({ keepTouched })
    // The old index (now under the shadow name) or a failed build's leftovers,
    // awaited so a CLI that exits right after does not leave a full copy of
    // the index on disk. After the writers' cache window, so no writer still
    // targets it by name.
    await new Promise((r) => setTimeout(r, 2 * rebuildStateCacheWindowMs() + 100))
    await deleteIndexIfExists(meili, shadowName)
  }
}

/**
 * Shutdown: hand back the rebuild lock this process holds. The job queues are
 * force-closed on shutdown (jobs.ts closeAllQueues), so a rebuild still running
 * is abandoned; its lock would otherwise block the next boot's rebuild until
 * the TTL ran out, and the job's retry backoff on top (minutes with the index
 * missing or stale after every deploy that interrupted one). The abandoned run
 * sees the lock gone at its next `assertHeld` and stops before the swap. The
 * noted writes are kept: the next rebuild starts by clearing them anyway, and
 * a rebuild past its swap still replays them. Never throws.
 */
export async function releaseRebuildLockForShutdown(): Promise<void> {
  const lock = RebuildLock.held
  if (!lock) return
  try {
    await lock.release({ keepTouched: true })
    log.info("Released the search rebuild lock for shutdown")
  } catch (err) {
    log.warn({ err }, "Could not release the search rebuild lock at shutdown")
  }
}

/**
 * Ask for a rebuild in the background (the job drift.ts registers). With
 * `embedderDimensions`, the rebuilt index declares the memory embedder at that
 * width. Best effort: a process with no job worker logs and moves on.
 */
export async function requestIndexRebuild(
  reason: string,
  opts: { embedderDimensions?: number } = {},
): Promise<void> {
  try {
    if (opts.embedderDimensions) {
      await redis.set(EMBEDDER_REQUEST_KEY, String(opts.embedderDimensions))
    }
    await enqueueAppJob("kernel", REBUILD_JOB, { reason }, REBUILD_JOB_OPTIONS)
    log.info({ reason }, "Search index rebuild requested")
  } catch (err) {
    log.warn({ err, reason }, "Could not request a search index rebuild")
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ReindexTestAccess = {
  setLockTiming(ttlMs: number, heartbeatMs: number): void {
    LOCK_TTL_MS = ttlMs
    LOCK_HEARTBEAT_MS = heartbeatMs
  },
}
