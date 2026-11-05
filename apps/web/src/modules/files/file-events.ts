// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * LIVE FILE SHELVES.
 *
 * The server queues a `kernel:file` event whenever a file lands on, or leaves,
 * a record: an upload confirmed through the files API, a file an agent copied
 * onto a ticket (`attach.ts`), a delete. Nothing on the client listened, so a
 * ticket's Files panel kept saying "No files yet" until the page was reloaded,
 * while the agent had just attached the very file the viewer was waiting for.
 *
 * The event only says WHICH parent changed. A shelf showing that parent
 * refetches its own list through the files API, under the viewer's own RLS,
 * so nothing the event carries is ever rendered as-is.
 */
import { createStore, reconcile } from "solid-js/store"
import { resyncVersion } from "~/framework/resync"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { type FileParent, parentKeyOf } from "~/modules/files/file-service"

const [versions, setVersions] = createStore<Record<string, number>>({})

/**
 * This parent's live revision: it moves on every file event for the parent,
 * and on every WebSocket resync (a reconnect may have missed some). A shelf
 * keys its fetch on it.
 */
export function fileParentRevision(parent: FileParent): string {
  return `${resyncVersion()}.${versions[parentKeyOf(parent)] ?? 0}`
}

/** The `kernel:file` WebSocket frame: bump the parent the file belongs to. */
export function handleFileEvent(_action: string, data: unknown): void {
  if (!data || typeof data !== "object") return
  const { app, entityType, entityId } = data as Record<string, unknown>
  if (typeof app !== "string" || typeof entityType !== "string" || typeof entityId !== "string") {
    return
  }
  const key = parentKeyOf({ app, entityType, entityId })
  setVersions(key, (v) => (v ?? 0) + 1)
}

/** Forget every parent's version: the next session starts from none. */
export function resetFileEvents(): void {
  setVersions(reconcile({}))
}

onSessionTeardown(resetFileEvents)
