// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one write path into the unified search index.
//
// WHY ONE PATH
// ------------
// Every document write has to keep three invariants, and each of them was
// broken at some point by a writer that went around a shared helper:
//
//   1. `_vectors.memory` is ALWAYS present, as a real vector or an explicit
//      null. Once the `userProvided` embedder is declared, Meili fails the whole
//      task (and every task batched with it) for a single document without it:
//      production, 2026-09-29, 42 failed tasks, one message document each time.
//   2. `has_vector: true` marks exactly the documents that carry a vector, and
//      is omitted otherwise. It is what lets a rebuild copy the vectors that
//      exist without downloading every document of the index (reindex.ts).
//   3. While a rebuild is filling its shadow index, every write is also NOTED
//      for replay: the rebuild streams Postgres page by page, so a change made
//      after a page was read would otherwise be overwritten in the shadow by the
//      older copy, or lost at the swap (reindex.ts, "Replay").
//
// Writes never wait here. A caller that needs the document searchable before
// it answers (a CLI, a test) waits for the returned task uids explicitly.

import { effectiveIndexName, getMeili } from "~/infra/search/client"
import { searchLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import type { LiveIndexItem } from "~/modules/search/live-index-queue"
import { waitForMeiliTask } from "~/modules/search/meili-task"
import { MEMORY_EMBEDDER_NAME } from "~/modules/search/vector-opt-out"

/** Upper bound on one addDocuments payload (vectors make documents large). */
const MAX_TASK_PAYLOAD_BYTES = 20 * 1024 * 1024
/** Upper bound on the ids one deleteDocuments call carries. */
const MAX_DELETE_IDS = 10_000

export interface IndexWrite {
  /** Complete documents to add or replace. */
  docs?: Record<string, unknown>[]
  /** Document ids to delete. */
  deleteIds?: string[]
  /** Meili filter expressions whose matching documents are deleted. */
  deleteFilters?: string[]
}

/**
 * Invariants 1 and 2, in place: every document gets `_vectors.memory` (a vector
 * or null) and `has_vector` exactly when it carries a vector.
 */
export function finalizeDocuments<T extends Record<string, unknown>>(docs: T[]): T[] {
  for (const doc of docs) {
    const d = doc as Record<string, unknown>
    const vectors = d._vectors as Record<string, unknown> | undefined | null
    const vector = vectors?.[MEMORY_EMBEDDER_NAME]
    if (vectors === undefined || vectors === null || !(MEMORY_EMBEDDER_NAME in vectors)) {
      d._vectors = { ...(vectors ?? {}), [MEMORY_EMBEDDER_NAME]: null }
    }
    if (Array.isArray(vector) && vector.length > 0) d.has_vector = true
    else delete d.has_vector
  }
  return docs
}

/** Split documents so one task body stays under MAX_TASK_PAYLOAD_BYTES. */
export function chunkBySize(docs: Record<string, unknown>[]): Record<string, unknown>[][] {
  const chunks: Record<string, unknown>[][] = []
  let cur: Record<string, unknown>[] = []
  let bytes = 0
  for (const d of docs) {
    const size = JSON.stringify(d).length
    if (cur.length > 0 && bytes + size > MAX_TASK_PAYLOAD_BYTES) {
      chunks.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(d)
    bytes += size
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

function taskUidOf(task: unknown): number | null {
  const uid = (task as { taskUid?: unknown } | null)?.taskUid
  return typeof uid === "number" ? uid : null
}

/**
 * Send one write to the index and return the Meili task uids, without waiting.
 * Deletes go first, so an id both deleted and re-added in one write ends up
 * added. `replay` names the requests this write came from; while a rebuild is
 * running they are noted so the rebuild can re-apply them to its shadow.
 *
 * `indexName` defaults to the live index. A rebuild writing its own shadow
 * passes the shadow's name, and its writes are not noted (they ARE the rebuild).
 */
export async function sendIndexWrite(
  write: IndexWrite,
  opts: { indexName?: string; replay?: LiveIndexItem[] } = {},
): Promise<number[]> {
  const indexName = opts.indexName ?? effectiveIndexName()
  if (!opts.indexName && opts.replay && opts.replay.length > 0) {
    await noteIndexWrites(opts.replay)
  }
  const index = getMeili().index(indexName)
  const uids: number[] = []
  const ids = [...new Set(write.deleteIds ?? [])]
  for (let i = 0; i < ids.length; i += MAX_DELETE_IDS) {
    const uid = taskUidOf(await index.deleteDocuments(ids.slice(i, i + MAX_DELETE_IDS)))
    if (uid !== null) uids.push(uid)
  }
  for (const filter of write.deleteFilters ?? []) {
    const uid = taskUidOf(await index.deleteDocuments({ filter }))
    if (uid !== null) uids.push(uid)
  }
  const docs = finalizeDocuments(write.docs ?? [])
  for (const chunk of chunkBySize(docs)) {
    const uid = taskUidOf(await index.addDocuments(chunk))
    if (uid !== null) uids.push(uid)
  }
  return uids
}

/** Wait for every task of a write; throws on the first task Meili failed. */
export async function waitForIndexTasks(uids: number[]): Promise<void> {
  const meili = getMeili()
  for (const uid of uids) await waitForMeiliTask(meili, uid)
}

/** `sendIndexWrite` then wait: the direct paths (CLIs, tests, backfills). */
export async function writeIndexAndWait(
  write: IndexWrite,
  opts: { indexName?: string; replay?: LiveIndexItem[] } = {},
): Promise<void> {
  await waitForIndexTasks(await sendIndexWrite(write, opts))
}

/**
 * A request that already names what to delete: document ids (`ids`) or one
 * filter (`filter`). For deletes whose documents cannot be recomputed later
 * (the row is about to be erased, or its children are already gone), so they
 * are decided when the request is made; the live queue's "raw" resolver
 * carries them out, and a rebuild's replay re-applies them.
 */
export function rawDeleteItem(
  orgId: string,
  key: string,
  target: { ids: string[] } | { filter: string },
): LiveIndexItem {
  return { t: "raw", key, payload: { orgId, action: "delete", ...target } }
}

/**
 * Delete documents from the live index NOW (no wait), for the security paths
 * that must not leave content behind (a mailbox purge, a mailbox reset). The
 * delete is also noted for a running rebuild, whose shadow may hold the same
 * documents from a page it streamed before the purge.
 */
export async function deleteSearchDocumentsNow(orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await sendIndexWrite(
    { deleteIds: ids },
    { replay: [rawDeleteItem(orgId, `delete:${ids[0]}:${ids.length}`, { ids })] },
  )
}

/* -------------------------------------------------------------------------- */
/* Rebuild coordination (invariant 3)                                         */
/* -------------------------------------------------------------------------- */

export const REBUILD_KEYS = {
  /** Held (SET NX, with a TTL the rebuild keeps extending) while a rebuild runs. */
  lock: "search:rebuild:lock",
  /** Requests written to the live index while the rebuild runs, by document key. */
  touched: "search:rebuild:touched",
}

/**
 * How long a writer trusts its last answer to "is a rebuild running". The
 * rebuild waits twice this long after taking its lock before it reads the first
 * page, so no writer can still believe no rebuild runs once reading starts.
 */
export const REBUILD_STATE_CACHE_MS = 1_000

// The window in force: REBUILD_STATE_CACHE_MS, shortened only by tests (through
// IndexWriterTestAccess) so a rebuild does not spend seconds waiting it out.
// The writers and the rebuild read the same value, so the invariant holds.
let rebuildStateCacheMs = REBUILD_STATE_CACHE_MS

/** The cache window currently in force (see REBUILD_STATE_CACHE_MS). */
export function rebuildStateCacheWindowMs(): number {
  return rebuildStateCacheMs
}

let cachedActive: { value: boolean; at: number } | null = null

async function rebuildActive(): Promise<boolean> {
  const now = Date.now()
  if (cachedActive && now - cachedActive.at < rebuildStateCacheMs) return cachedActive.value
  const value = (await redis.exists(REBUILD_KEYS.lock)) === 1
  cachedActive = { value, at: now }
  return value
}

/**
 * Note requests for the running rebuild's replay. A no-op when none runs.
 *
 * A DELETE that cannot be noted fails the write (the caller retries it: the
 * flusher requeues, a purge stays unstamped and re-runs): a lost delete note
 * is a document the rebuild streamed before the delete coming back at the
 * swap, and for a purge or an erasure that is content that must stay gone. A
 * lost UPSERT note is only a stale copy the next write of the document fixes,
 * so it is logged and the write goes ahead.
 */
export async function noteIndexWrites(items: LiveIndexItem[]): Promise<void> {
  if (items.length === 0) return
  try {
    if (!(await rebuildActive())) return
    const tx = redis.multi()
    for (const it of items) tx.hset(REBUILD_KEYS.touched, it.key, JSON.stringify(it))
    const results = await tx.exec()
    const failed = results?.find(([err]) => err)
    if (failed) throw failed[0]
  } catch (err) {
    if (items.some((i) => i.payload.action === "delete")) throw err
    log.warn({ err, count: items.length }, "Could not note search writes for the running rebuild")
  }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const IndexWriterTestAccess = {
  resetRebuildCache(): void {
    cachedActive = null
  },
  /** Shorten the rebuild-state cache window; pass nothing to restore it. */
  setRebuildStateCacheMs(ms?: number): void {
    rebuildStateCacheMs = ms ?? REBUILD_STATE_CACHE_MS
    cachedActive = null
  },
}
