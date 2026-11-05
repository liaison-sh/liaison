// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Force-on-open: opening a synced knowledge document whose last sync is older
// than 30 seconds queues an immediate sync of its source.
//
// THE READ NEVER WAITS FOR IT. The GET always returns the cached body; when the
// sync lands and the body changed, the reconciler emits a
// knowledge:document:update WS event the open tab consumes. The enqueue itself
// is one Redis round trip, but the BullMQ connection retries forever
// (`maxRetriesPerRequest: null`), so during a Redis outage it would hang the
// read. The wait is therefore capped at ENQUEUE_WAIT_MS. A refused, failed or
// timed-out enqueue is logged as an error and reported as `deferred` (the route
// surfaces it as `meta.syncDeferred`); the minute `synced-sources-tick` still
// syncs the source, so nothing is dropped.
import { enqueueAppJob } from "~/infra/jobs/jobs"
import { rootLogger } from "~/lib/logger"

export const ENQUEUE_WAIT_MS = 500
const STALE_AFTER_MS = 30_000

export interface ForceOnOpenDeps {
  enqueue: typeof enqueueAppJob
  waitMs: number
}

const defaultDeps: ForceOnOpenDeps = { enqueue: enqueueAppJob, waitMs: ENQUEUE_WAIT_MS }

/** Queue the sync when the document is stale. Resolves within `waitMs`. */
export async function requestForceOnOpenSync(
  doc: { syncedSourceId?: string | null; lastSyncedAt?: string | null },
  userId: string,
  deps: ForceOnOpenDeps = defaultDeps,
): Promise<{ deferred: boolean }> {
  const sourceId = doc.syncedSourceId
  if (!sourceId) return { deferred: false }
  const lastSynced = doc.lastSyncedAt ? Date.parse(doc.lastSyncedAt) : 0
  if (lastSynced && Date.now() - lastSynced <= STALE_AFTER_MS) return { deferred: false }

  const enqueue = deps.enqueue(
    "knowledge",
    "sync-source",
    { sourceId, trigger: "force-on-open", enqueuedBy: userId },
    { jobId: `sync:${sourceId}` },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.waitMs)
  })
  try {
    const outcome = await Promise.race([enqueue.then(() => "queued" as const), timedOut])
    if (outcome === "timeout") {
      // Let the pending call settle on its own; its failure is logged, never thrown.
      enqueue.catch((err) =>
        rootLogger.error({ err, sourceId }, "force-on-open enqueue failed after its wait"),
      )
      rootLogger.error(
        { sourceId, waitMs: deps.waitMs },
        "force-on-open sync not queued within its wait; the minute tick will sync it",
      )
      return { deferred: true }
    }
    return { deferred: false }
  } catch (err) {
    rootLogger.error(
      { err, sourceId },
      "force-on-open sync could not be queued; the minute tick will sync it",
    )
    return { deferred: true }
  } finally {
    clearTimeout(timer)
  }
}
