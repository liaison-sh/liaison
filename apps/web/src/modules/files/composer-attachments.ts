// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE MESSAGE COMPOSER'S FILES, ONE IMPLEMENTATION. Picking, dropping and
 * pasting a file all stage it into one lazily created upload session (the
 * server reparents the session's files onto the message at send), the staged
 * strip and its errors read from here, and the send is held while a picked
 * file is still uploading (`createUploadHold`). The thread composer
 * (ComposeBar) and the task page's comment box (TaskDiscussion) both draw
 * their attachments from this, so a comment's file goes through exactly the
 * upload, size/type/quota checks, sealed handling and direct-or-relay
 * delivery of a thread message's.
 *
 * Must be created under a reactive owner (a component body): the upload hold
 * fires a queued send from an effect.
 */
import { type Accessor, createSignal } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import {
  createUploadHold,
  createUploadSession,
  type FileParent,
  type FileRow,
  isUploadCancelled,
  type UploadHold,
  type UploadSession,
  uploadFile,
} from "~/modules/files/file-service"
import { attachmentErrorMessage } from "~/modules/files/StagedAttachmentChips"

export interface ComposerAttachments {
  session: Accessor<UploadSession | null>
  setSession: (s: UploadSession | null) => void
  pendingFiles: Accessor<FileRow[]>
  setPendingFiles: (next: FileRow[] | ((prev: FileRow[]) => FileRow[])) => void
  attachError: Accessor<string | null>
  setAttachError: (msg: string | null) => void
  /** `kernel:file_upload_session:<id>` of the session, for the staged strip's
   *  in-flight tiles and the upload hold. Null before the first file. */
  sessionParentKey: Accessor<string | null>
  uploadHold: UploadHold
  /** The upload session, created on first use. */
  ensureSession: () => Promise<UploadSession>
  /** The lazy staging parent for AttachmentUploadButton (or any picker). */
  uploadParent: () => Promise<FileParent>
  /** A finished upload joins the staged strip. */
  addStaged: (row: FileRow) => void
  /** An upload error, said under the staged strip. */
  reportError: (err: unknown) => void
  /** Upload a dropped or pasted file into the session and stage it. */
  stageFile: (file: File) => Promise<void>
  dragOver: Accessor<boolean>
  onDragOver: (e: DragEvent) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent) => void
  /** The session id to send with the message, when files are staged. */
  sendSessionId: () => string | undefined
  /** Empty the strip after a send (the session goes with the message). */
  reset: () => void
}

export function createComposerAttachments(opts: {
  api: ApiClient
  disabled?: () => boolean | undefined
}): ComposerAttachments {
  const disabled = () => opts.disabled?.() === true
  const [session, setSession] = createSignal<UploadSession | null>(null)
  const [pendingFiles, setPendingFiles] = createSignal<FileRow[]>([])
  const [attachError, setAttachError] = createSignal<string | null>(null)
  const [dragOver, setDragOver] = createSignal(false)

  // An upload that finished after the send used to land in the emptied
  // composer (or be dropped) instead of travelling with the message. The send
  // is now held, Enter and button alike, until every picked file is staged, so
  // a file always finishes into the session it was picked for.
  const sessionParentKey = (): string | null => {
    const s = session()
    return s ? `kernel:file_upload_session:${s.id}` : null
  }
  const uploadHold = createUploadHold(sessionParentKey)

  function addStaged(row: FileRow): void {
    setAttachError(null)
    setPendingFiles((p) => [...p, row])
  }

  function reportError(err: unknown): void {
    setAttachError(attachmentErrorMessage(err))
  }

  function ensureSession(): Promise<UploadSession> {
    return uploadHold.track(async () => {
      const existing = session()
      if (existing) return existing
      const s = await createUploadSession(opts.api, {
        targetApp: "kernel",
        targetEntityType: "message",
      })
      setSession(s)
      return s
    })
  }

  const uploadParent = async (): Promise<FileParent> => ({
    app: "kernel",
    entityType: "file_upload_session",
    entityId: (await ensureSession()).id,
  })

  // Stage a file dropped/pasted into the composer through the same upload
  // session the picker button uses, so send-time reparenting is identical.
  async function stageFile(file: File): Promise<void> {
    try {
      const s = await ensureSession()
      const row = await uploadFile(opts.api, file, {
        app: "kernel",
        entityType: "file_upload_session",
        entityId: s.id,
      })
      addStaged(row)
    } catch (err) {
      // Removed from the strip while it uploaded: nothing to say.
      if (isUploadCancelled(err)) return
      reportError(err)
    }
  }

  function onDragOver(e: DragEvent): void {
    if (disabled()) return
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault()
      setDragOver(true)
    }
  }

  function onDrop(e: DragEvent): void {
    if (disabled()) return
    setDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length === 0) return
    e.preventDefault()
    for (const f of files) void stageFile(f)
  }

  return {
    session,
    setSession,
    pendingFiles,
    setPendingFiles,
    attachError,
    setAttachError,
    sessionParentKey,
    uploadHold,
    ensureSession,
    uploadParent,
    addStaged,
    reportError,
    stageFile,
    dragOver,
    onDragOver,
    onDragLeave: () => setDragOver(false),
    onDrop,
    sendSessionId: () => {
      const s = session()
      return pendingFiles().length > 0 && s ? s.id : undefined
    },
    reset: () => {
      setPendingFiles([])
      setSession(null)
      setAttachError(null)
    },
  }
}

/**
 * The files a paste carries. Pasted screenshots arrive as clipboard FILE items
 * with no useful text/plain twin; a paste that only inserts text silently
 * drops them.
 */
export function pastedFiles(e: ClipboardEvent): File[] {
  const items = e.clipboardData?.items
  if (!items) return []
  const files: File[] = []
  for (const item of items) {
    if (item.kind !== "file") continue
    const f = item.getAsFile()
    if (f) {
      // Clipboard images are often generically named "image.png" — stamp a
      // timestamped name so several pastes don't collide visually.
      const named =
        f.name && f.name !== "image.png"
          ? f
          : new File([f], `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.png`, {
              type: f.type || "image/png",
            })
      files.push(named)
    }
  }
  return files
}
