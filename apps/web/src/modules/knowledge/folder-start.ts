// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE FIRST TEXT OF A FOLDER'S PAGE, before the page exists. What is typed in an
// empty folder is unsaved text like any page's: it is kept in this person's local
// draft (the folder's id stands for the page's, one per tab), the sign-out guard
// asks for it, and a draft left by a closed tab comes back when the folder opens.
// "Saving" it is making the page: `start` asks the server once; a failure is said
// and waits for the person (Try again), never one request per key.

import {
  newSessionId,
  type PageSaver,
  type SavedRow,
  type SaverStatus,
  trackSaver,
} from "./autosave"
import { type DraftStore, deadDrafts, draftKey, type Liveness, type PageDraft } from "./drafts"

export interface FolderStartOptions {
  userId: string
  folderId: string
  /** Shown as the draft's title (the sign-out list names it by the folder). */
  folderName: () => string
  /** The text in the start editor now. */
  read: () => string
  /** Make the folder's page from the text now; true once it is made. */
  start: () => Promise<boolean>
  drafts: DraftStore
  onStatus?: (status: SaverStatus) => void
  sessionId?: string
}

export interface FolderStartSaver extends PageSaver {
  /** The page exists and holds this text: the draft goes, nothing is asked any more. */
  handedOver(): Promise<void>
}

/** How long typing waits before the local draft is written again. */
const DRAFT_DEBOUNCE_MS = 300

export function createFolderStartSaver(opts: FolderStartOptions): FolderStartSaver {
  const sessionId = opts.sessionId ?? newSessionId()
  const key = draftKey({ userId: opts.userId, docId: opts.folderId, sessionId })
  let dirty = false
  let destroyed = false
  let status: SaverStatus = { state: "idle" }
  let timer: ReturnType<typeof setTimeout> | undefined
  let draftOps: Promise<void> = Promise.resolve()

  const setStatus = (next: SaverStatus) => {
    status = next
    opts.onStatus?.(next)
  }
  const draft = (): PageDraft => {
    const now = Date.now()
    return {
      userId: opts.userId,
      docId: opts.folderId,
      sessionId,
      title: opts.folderName(),
      body: opts.read(),
      baseRevision: 0,
      baseHash: "",
      at: now,
      beat: now,
    }
  }
  const put = () => {
    draftOps = draftOps.then(() => opts.drafts.put(draft()).catch(() => {}))
    return draftOps
  }
  const remove = () => {
    draftOps = draftOps.then(() => opts.drafts.remove(key).catch(() => {}))
    return draftOps
  }
  const hasText = () => opts.read().trim() !== ""
  let untrack = () => {}

  const saver: FolderStartSaver = {
    sessionId,
    userId: opts.userId,
    docId: opts.folderId,
    key,
    status: () => status,
    revision: () => 0,
    edit() {
      if (destroyed) return
      dirty = true
      if (status.state === "idle" || status.state === "saved") setStatus({ state: "dirty" })
      clearTimeout(timer)
      timer = setTimeout(() => void put(), DRAFT_DEBOUNCE_MS)
    },
    hasUnsaved: () => !destroyed && dirty && hasText(),
    async flush() {
      if (destroyed || !dirty || !hasText()) return status
      setStatus({ state: "saving" })
      const made = await opts.start().catch(() => false)
      if (!made) {
        setStatus({ state: "error" })
        await put()
      }
      return status
    },
    async persistDraft() {
      if (destroyed) return
      clearTimeout(timer)
      await put()
    },
    // The page does not exist yet: there is no text of someone else to choose from.
    keepMine: async () => status,
    takeTheirs: async (_theirs: SavedRow) => false,
    postUnapplied: async () => false,
    adoptRemote: (_row: SavedRow) => false,
    markConflict: (_theirs: SavedRow) => {},
    async handedOver() {
      dirty = false
      clearTimeout(timer)
      setStatus({ state: "saved" })
      await remove()
      await saver.destroy({ discard: true })
    },
    async destroy(destroyOpts) {
      if (destroyed) return
      clearTimeout(timer)
      if (destroyOpts?.discard) await remove()
      else if (dirty && hasText()) await put()
      destroyed = true
      untrack()
      await draftOps
    },
  }
  untrack = trackSaver(saver)
  return saver
}

/**
 * Text typed in this folder by this person in a tab that is gone, newest first: the
 * start editor opens on the newest, and the others are dropped once it is kept.
 */
export async function leftFolderDrafts(
  drafts: DraftStore,
  liveness: Liveness | null,
  userId: string,
  folderId: string,
): Promise<PageDraft[]> {
  return (await deadDrafts(drafts, liveness, userId, folderId)).filter((d) => d.body.trim())
}
