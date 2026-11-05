// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  type DurableEventContext,
  registerDurableEventConsumer,
} from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import { enqueueAppJob, registerJobWorker } from "~/infra/jobs/jobs"
import { deleteObjects as defaultDeleteObjects } from "~/infra/storage/object-storage"
import { filesLogger as log } from "~/lib/logger"
import type { withStorageKeyLock } from "~/modules/files/service"

export interface DeleteObjectJobPayload {
  orgId: string
  storageKey: string
  thumbnailKey: string | null
}

export interface DeleteObjectDeps {
  deleteObjects?: typeof defaultDeleteObjects
  /** Test seam: defaults to the files service's per-object lock. */
  withKeyLock?: typeof withStorageKeyLock
}

function isMissingObjectError(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
  if (e?.name === "NoSuchKey" || e?.Code === "NoSuchKey") return true
  if (e?.$metadata?.httpStatusCode === 404) return true
  return false
}

export async function processDeleteObjectJob(
  payload: DeleteObjectJobPayload,
  deps: DeleteObjectDeps = {},
): Promise<void> {
  const del = deps.deleteObjects ?? defaultDeleteObjects
  // Loaded on use: the files service pulls in the database and env, which this
  // worker module otherwise does not need at import time.
  const withKeyLock =
    deps.withKeyLock ?? (await import("~/modules/files/service")).withStorageKeyLock
  const keys = [payload.storageKey]
  if (payload.thumbnailKey) keys.push(payload.thumbnailKey)
  // Under the key lock the confirm takes: if a live row owns the key again
  // (a confirm retried with the same file token after the delete), the object
  // is that row's now and stays.
  await withKeyLock(payload.orgId, payload.storageKey, async (referenced) => {
    if (referenced) {
      log.info(
        { orgId: payload.orgId, key: payload.storageKey },
        "delete-object: key owned by a live row again, kept",
      )
      return
    }
    try {
      await del(keys)
    } catch (err) {
      if (isMissingObjectError(err)) {
        log.info({ orgId: payload.orgId, keys }, "delete-object: keys already missing")
        return
      }
      throw err
    }
  })
}

export function registerDeleteObjectWorker(): void {
  registerJobWorker("kernel", "files-delete-object", async (payload) => {
    await processDeleteObjectJob(payload as DeleteObjectJobPayload)
  })
}

/**
 * A file row's object is deleted only once the row's deletion has committed:
 * every file deletion queues a `kernel.file.delete` event in its own
 * transaction, and this consumer turns each committed event into one
 * `files-delete-object` job. A rolled-back deletion never reaches it, so no
 * object is ever deleted under a row that still exists. The job id dedupes an
 * outbox replay; the job itself treats an already-missing key as done.
 */
export async function enqueueObjectDeleteForEvent(
  event: Pick<AppEvent, "app" | "entity" | "action" | "orgId" | "data">,
  enqueue: typeof enqueueAppJob = enqueueAppJob,
): Promise<void> {
  if (event.app !== "kernel" || event.entity !== "file" || event.action !== "delete") return
  const data = (event.data ?? {}) as {
    id?: string
    storageKey?: string
    thumbnailKey?: string | null
  }
  if (!data.id || !data.storageKey) return
  const payload: DeleteObjectJobPayload = {
    orgId: event.orgId,
    storageKey: data.storageKey,
    thumbnailKey: data.thumbnailKey ?? null,
  }
  await enqueue("kernel", "files-delete-object", payload, {
    jobId: `files-delete-object:${data.id}`,
  })
}

export function registerDeleteObjectDurableConsumer(): void {
  registerDurableEventConsumer("files-delete-object", async (ctx: DurableEventContext) => {
    if (ctx.event.ephemeral) return
    await enqueueObjectDeleteForEvent(ctx.event)
  })
}
