// SPDX-License-Identifier: FSL-1.1-ALv2
import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { apiBase } from "~/lib/env"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface FileParent {
  app: string
  entityType: string
  entityId: string
}

export interface FileRow {
  id: string
  filename: string
  sizeBytes: number
  mimeType: string
  thumbnailKey: string | null
  thumbnailUrl?: string | null
  downloadUrl?: string | null
  app?: string
  entityType?: string
  entityId?: string
  disposition?: "inline" | "attachment"
  contentId?: string | null
  originalContentId?: string | null
  ordinal?: number
  createdAt?: string
  /** Who added the file (the list route returns it). */
  uploadedBy?: string | null
  /** CLIENT ONLY, never sent or persisted: an object URL of the picked bytes,
   *  set by {@link uploadFile} for an image so a composer can show the real
   *  picture at once. The server's thumbnail is rendered asynchronously, so a
   *  freshly confirmed row has none and the staged tile used to be a blank
   *  "PNG" badge. */
  localPreviewUrl?: string | null
}

/** A file still travelling to storage, shown in its composer's strip with a
 *  spinner until {@link uploadFile} confirms it (or fails and drops it). */
export interface InFlightUpload {
  key: string
  /** `app:entityType:entityId` of the staging parent: a composer shows only
   *  its own uploads, since every open tab keeps its composer mounted. */
  parentKey: string
  filename: string
  mimeType: string
  sizeBytes: number
  previewUrl: string | null
}

const [inFlightState, setInFlightState] = createStore<{ list: InFlightUpload[] }>({ list: [] })

export function parentKeyOf(parent: FileParent): string {
  return `${parent.app}:${parent.entityType}:${parent.entityId}`
}

/** Uploads in progress for one staging parent, in the order they started. */
export function inFlightUploadsFor(parentKey: string | null | undefined): InFlightUpload[] {
  if (!parentKey) return []
  return inFlightState.list.filter((u) => u.parentKey === parentKey)
}

/** Uploads in progress anywhere in the page (a reload would drop them). */
export function inFlightUploadCount(): number {
  return inFlightState.list.length
}

// The last upload failure per staging parent, as a global sequence number: a
// send queued behind uploads must not go out without a file the person picked
// (see createUploadHold). A sequence, not a count, so "failed since the press"
// holds even when the parent only gets its key after the press.
let uploadFailureSeq = 0
const [lastUploadFailure, setLastUploadFailure] = createStore<Record<string, number>>({})

function lastUploadFailureFor(parentKey: string | null): number {
  return parentKey ? (lastUploadFailure[parentKey] ?? 0) : 0
}

export interface UploadHold {
  /** A pick is resolving its staging parent or a file is still uploading. */
  held: () => boolean
  /** A send is waiting for the uploads to finish. */
  queued: () => boolean
  /** Wrap the lazy staging parent resolver (upload session, mail draft). */
  track: <T>(resolve: () => Promise<T>) => Promise<T>
  /**
   * Enter or Send pressed. While held, the press is taken: the first queues
   * `send`, a second one cancels the queue (a toggle), and `true` tells the
   * caller not to send now. When nothing is held it returns `false` and the
   * caller sends as usual.
   */
  press: (send: () => void) => boolean
  /** Drop a queued send (the person edited the text or removed a file). */
  cancel: () => void
}

/**
 * A composer's send hold, and the send queued behind it.
 *
 * A file still uploading is not on the composer's staging parent yet, so a
 * send now goes out WITHOUT it and the file lands afterwards, orphaned.
 * `held()` is true from the moment a pick starts resolving its staging parent
 * (the upload session or mail draft is created lazily, one request that
 * registers no upload yet) until every upload into that parent has settled.
 * Wrap the lazy parent resolver in `track`.
 *
 * Pressing send while held QUEUES the send instead of ignoring the press: the
 * message goes out by itself, with its files, once every upload of this
 * composer has settled. The rule, kept minimal:
 * - picking another file while queued just extends the wait;
 * - pressing send again, editing the text or removing a staged file cancels
 *   the queue (the composer calls `cancel`), since the message is no longer
 *   the one the person asked to send;
 * - removing a file STILL UPLOADING does not: that upload is cancelled
 *   (`cancelUpload`), which is not a failure, so the queue keeps waiting for
 *   the other uploads and goes out without that file, at once if it was the
 *   last one. A message left with no text and no file sends nothing (the
 *   composer's own empty check);
 * - an upload (or its staging parent) that fails cancels it too, and the
 *   composer shows its usual upload error: the person decides whether to send
 *   without that file.
 *
 * Must be created under a reactive owner (a component body): the queued send
 * fires from an effect.
 */
export function createUploadHold(parentKey: () => string | null): UploadHold {
  const [resolving, setResolving] = createSignal(0)
  const [resolveFailures, setResolveFailures] = createSignal(0)
  const [queued, setQueued] = createSignal(false)
  let queuedSend: (() => void) | null = null
  // Only a failure AFTER the press cancels it.
  let queuedAt = { uploadSeq: 0, resolves: 0 }

  const held = () => resolving() > 0 || inFlightUploadsFor(parentKey()).length > 0
  const failedSinceQueue = () =>
    lastUploadFailureFor(parentKey()) > queuedAt.uploadSeq || resolveFailures() > queuedAt.resolves
  const cancel = () => {
    queuedSend = null
    setQueued(false)
  }

  // The last upload settles BEFORE its row reaches the composer: uploadFile
  // leaves the in-flight list, then returns, and only then does the caller
  // stage the row (onUploaded, stageFile). A send fired in the same turn went
  // out without that file, so it fires on the next task, once more checked.
  let fireTimer: ReturnType<typeof setTimeout> | undefined
  const ready = () => queued() && !held() && !failedSinceQueue()
  createEffect(() => {
    if (!queued()) return
    if (failedSinceQueue()) {
      cancel()
      return
    }
    if (held() || fireTimer !== undefined) return
    fireTimer = setTimeout(() => {
      fireTimer = undefined
      if (!untrack(ready)) return
      const send = queuedSend
      cancel()
      send?.()
    }, 0)
  })
  onCleanup(() => clearTimeout(fireTimer))

  return {
    held,
    queued,
    cancel,
    press(send) {
      if (!held()) {
        cancel()
        return false
      }
      if (queued()) {
        cancel()
        return true
      }
      queuedAt = { uploadSeq: uploadFailureSeq, resolves: resolveFailures() }
      queuedSend = send
      setQueued(true)
      return true
    },
    async track(resolve) {
      setResolving((n) => n + 1)
      try {
        return await resolve()
      } catch (err) {
        setResolveFailures((n) => n + 1)
        throw err
      } finally {
        // The upload registers itself in the same turn the resolver returns
        // to (AttachmentUploadButton, stageFile), before any event can run.
        setResolving((n) => n - 1)
      }
    },
  }
}

let inFlightSeq = 0

/** Each in-flight upload's abort switch, by key (kept out of the store: an
 *  AbortController is not state to render). */
const inFlightAborts = new Map<string, () => void>()

/** True for the rejection of an upload the person removed while it ran:
 *  callers drop it silently, it is not an upload error. */
export function isUploadCancelled(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError"
}

/**
 * The person removed a tile that is still uploading. The upload is aborted and
 * leaves the in-flight list AT ONCE (the tile goes, its local preview is
 * freed); {@link uploadFile} then rejects with an AbortError
 * ({@link isUploadCancelled}) and its caller stages nothing.
 *
 * Nothing is left behind: the storage PUT is aborted, the confirm step (which
 * creates the file row) is not sent once aborted, and a confirm already on
 * its way is followed by a delete of the row it created.
 *
 * A removal is not a failure, so it does not cancel a send queued behind the
 * uploads (see {@link createUploadHold}): the queue waits for the uploads
 * still running and goes out without the removed file, or at once when it
 * was the last one. The person pressed send, then took one file off.
 */
export function cancelUpload(key: string): void {
  inFlightAborts.get(key)?.()
}

function createLocalPreviewUrl(file: File): string | null {
  const type = (file.type || "").toLowerCase()
  // SVG is excluded for the same reason the inline route force-downloads it.
  if (!type.startsWith("image/") || type.startsWith("image/svg")) return null
  try {
    return URL.createObjectURL(file)
  } catch {
    return null
  }
}

export interface UploadSession {
  id: string
  targetApp: string
  targetEntityType: string
  targetEntityId: string | null
}

/**
 * How the bytes travel, decided by the server (infra/storage/delivery.ts):
 * "direct" PUTs to the presigned object-store url, "relay" PUTs through the
 * API. A server that predates the field relays.
 */
export type StorageDelivery = "direct" | "relay"

export interface UploadUrlResponse {
  uploadUrl: string
  uploadMode?: StorageDelivery
  fileToken: string
  storageKey: string
}

export class FileStorageUnavailableError extends Error {
  constructor() {
    super("File storage is unavailable")
    this.name = "FileStorageUnavailableError"
  }
}

export class FileQuotaExceededError extends Error {
  constructor(
    message = "File quota exceeded",
    /** The server's refusal code: the org's storage cap, or this file's size limit. */
    readonly code?: string,
  ) {
    super(message)
    this.name = "FileQuotaExceededError"
  }
}

export interface UploadOptions {
  signal?: AbortSignal
  onProgress?: (loaded: number, total: number) => void
  /** Attachment metadata persisted on `kernel.files` via `/files/confirm`. */
  disposition?: "inline" | "attachment"
  contentId?: string | null
  ordinal?: number
}

export async function uploadFile(
  api: ApiClient,
  file: File,
  parent: FileParent,
  options: UploadOptions = {},
): Promise<FileRow> {
  const previewUrl = createLocalPreviewUrl(file)
  const key = `upload-${++inFlightSeq}`
  setInFlightState(
    produce((st) => {
      st.list.push({
        key,
        parentKey: parentKeyOf(parent),
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        previewUrl,
      })
    }),
  )
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    inFlightAborts.delete(key)
    setInFlightState(
      produce((st) => {
        st.list = st.list.filter((u) => u.key !== key)
      }),
    )
  }
  let previewReleased = false
  const releasePreview = () => {
    if (previewReleased || !previewUrl) return
    previewReleased = true
    URL.revokeObjectURL(previewUrl)
  }
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true })
  // Rejects the moment the upload is aborted, whatever step it is on: the
  // confirm request is not abortable (see uploadFileBytes).
  const aborted = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new DOMException("Upload cancelled", "AbortError"))
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener("abort", onAbort, { once: true })
  })
  aborted.catch(() => {}) // an abort after the upload landed rejects it unheard
  inFlightAborts.set(key, () => {
    controller.abort()
    // The tile goes now, not when the aborted request unwinds.
    settle()
    releasePreview()
  })
  const bytes = uploadFileBytes(api, file, parent, { ...options, signal: controller.signal })
  // A confirm that was already on its way when the upload was cancelled has
  // created a row nobody will stage: delete it.
  void bytes.then(
    (row) => {
      if (controller.signal.aborted) void deleteFile(api, row.id).catch(() => {})
    },
    () => {},
  )
  try {
    const row = await Promise.race([bytes, aborted])
    settle()
    return previewUrl ? { ...row, localPreviewUrl: previewUrl } : row
  } catch (err) {
    const cancelled = controller.signal.aborted
    if (!cancelled) setLastUploadFailure(parentKeyOf(parent), ++uploadFailureSeq)
    settle()
    releasePreview()
    throw cancelled ? new DOMException("Upload cancelled", "AbortError") : err
  } finally {
    options.signal?.removeEventListener("abort", abortFromCaller)
  }
}

async function uploadFileBytes(
  api: ApiClient,
  file: File,
  parent: FileParent,
  options: UploadOptions,
): Promise<FileRow> {
  let presign: UploadUrlResponse
  try {
    presign = await api.post<UploadUrlResponse>("/files/upload-url", {
      ...parent,
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    })
  } catch (err) {
    if (err instanceof ApiError && (err.status === 413 || err.code === "STORAGE_QUOTA_EXCEEDED")) {
      throw new FileQuotaExceededError(err.message, err.code)
    }
    if (err instanceof ApiError && err.status === 503) {
      throw new FileStorageUnavailableError()
    }
    throw err
  }

  // The server says where the bytes go. "direct": a plain PUT to the
  // presigned url, whose signature pins this exact Content-Type and length
  // (the browser sets Content-Length from the body). Anything else, and a
  // direct PUT that fails (a bucket CORS rule missing, the store down), goes
  // through the token-authenticated API relay, which writes the same key.
  const contentType = file.type || "application/octet-stream"
  let stored = false
  if (presign.uploadMode === "direct") {
    try {
      const put = await fetch(presign.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: file,
        credentials: "omit",
        signal: options.signal,
      })
      stored = put.ok
      if (!put.ok) console.warn(`direct upload refused (${put.status}); relaying`)
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err
      console.warn("direct upload unreachable; relaying", err)
    }
  }
  if (!stored) {
    // THE SERVER'S base, never the page's: under the desktop shell the page
    // is served from its own origin, where a relative `/api/file-relay/...`
    // is answered by the asset protocol with index.html and a 200. The
    // relay "succeeded", nothing was stored, and confirm failed with "Object
    // not found in storage" (first Windows walk: the presigned host was the
    // box's internal object store, so every attachment took this path).
    const relay = await fetch(`${apiBase()}/file-relay/${encodeURIComponent(presign.fileToken)}`, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: file,
      signal: options.signal,
    })
    if (!relay.ok) throw new Error(`Upload failed (relay ${relay.status})`)
  }

  // The confirm creates the file row. Not sent once the upload is cancelled;
  // one already sent is cleaned up by uploadFile.
  if (options.signal?.aborted) throw new DOMException("Upload cancelled", "AbortError")
  const confirmed = await api.post<FileRow>("/files/confirm", {
    fileToken: presign.fileToken,
    disposition: options.disposition,
    contentId: options.contentId ?? null,
    ordinal: options.ordinal,
  })
  return confirmed
}

/**
 * Create a staging upload session bound to the eventual target parent.
 * Files uploaded against the returned `{ id }` are parented to
 * `(kernel, file_upload_session, id)` until they are reparented via
 * `moveFilesToParent` after the message is created.
 */
export async function createUploadSession(
  api: ApiClient,
  target: { targetApp: string; targetEntityType: string; targetEntityId?: string | null },
): Promise<UploadSession> {
  return api.post<UploadSession>("/files/upload-sessions", target)
}

/**
 * Reparent files staged on an upload session to the final entity.
 * Server validates session ownership, target match, scope, and file membership.
 */
export async function moveFilesToParent(
  api: ApiClient,
  input: {
    sourceSessionId: string
    target: { app: string; entityType: string; entityId: string }
    fileIds: string[]
  },
): Promise<{ moved: number }> {
  return api.post<{ moved: number }>("/files/move-to-parent", input)
}

export async function listFiles(
  api: ApiClient,
  parent: FileParent,
  opts?: { signal?: AbortSignal },
): Promise<FileRow[]> {
  const params = new URLSearchParams({
    app: parent.app,
    entityType: parent.entityType,
    entityId: parent.entityId,
  })
  // Every caller shows its own state for a list it could not read (a viewer
  // without the parent's file scope gets a 403): no global toast.
  const env = await api.getEnvelope<FileRow[]>(`/files?${params.toString()}`, {
    ...opts,
    suppressGlobalError: true,
  })
  return env.data ?? []
}

export interface DownloadUrlResponse {
  downloadUrl: string
  /** Absent on a server that predates it: its url is then not fetched. */
  delivery?: StorageDelivery
  thumbnailUrl?: string
}

export async function getDownloadUrl(api: ApiClient, fileId: string): Promise<string> {
  const res = await api.get<DownloadUrlResponse>(`/files/${fileId}/download-url`)
  return res.downloadUrl
}

/**
 * A file's bytes, from wherever the server says they are. "direct": a plain
 * fetch of the presigned GET (no cookie, no bearer: the signature is the
 * credential), so the bytes never cross the API. Otherwise, or when that fetch
 * fails, the authenticated API streaming route, which works on every
 * deployment topology. Never for a sealed attachment: the server always
 * answers "relay" for one, and its readers go through the crypto worker.
 */
export async function fetchFileBytes(
  api: Pick<ApiClient, "get" | "rawGet">,
  fileId: string,
): Promise<Response> {
  if ((await storageDeliveryOf(api)) === "direct") {
    try {
      // The fallback below reports a real failure; this lookup stays quiet.
      const link = await api.get<DownloadUrlResponse>(`/files/${fileId}/download-url`, {
        suppressGlobalError: true,
      })
      // Per file: a sealed attachment answers "relay" even on a direct store.
      if (link?.delivery === "direct") {
        const res = await fetch(link.downloadUrl, { credentials: "omit" })
        if (res.ok) return res
        console.warn(`direct download refused (${res.status}); relaying`)
      }
    } catch (err) {
      console.warn("direct download unavailable; relaying", err)
    }
  }
  return await api.rawGet(`/files/${fileId}/inline?download=1`)
}

// The deployment's delivery, asked once per server per session
// (`GET /files/delivery`), so a relayed download goes straight to the API
// route without a lookup per file. A failed ask (a server that predates the
// endpoint, a network error) means relay, the path that always works, and is
// asked again after DELIVERY_RETRY_MS rather than pinned for the session.
const DELIVERY_RETRY_MS = 60_000
const deliveryByServer = new Map<string, { asked: Promise<StorageDelivery>; retryAt: number }>()

export function storageDeliveryOf(api: Pick<ApiClient, "get">): Promise<StorageDelivery> {
  const server = apiBase()
  const known = deliveryByServer.get(server)
  if (known && Date.now() < known.retryAt) return known.asked
  const entry = {
    asked: Promise.resolve<StorageDelivery>("relay"),
    retryAt: Number.POSITIVE_INFINITY,
  }
  entry.asked = (async (): Promise<StorageDelivery> => {
    try {
      const r = await api.get<{ delivery?: StorageDelivery }>("/files/delivery", {
        suppressGlobalError: true,
      })
      return r?.delivery === "direct" ? "direct" : "relay"
    } catch {
      entry.retryAt = Date.now() + DELIVERY_RETRY_MS
      return "relay"
    }
  })()
  deliveryByServer.set(server, entry)
  return entry.asked
}

/** Test access: forget what each server said. */
export function resetStorageDeliveryCache(): void {
  deliveryByServer.clear()
}

/**
 * Download a file and hand it to the browser as a save-as (fetchFileBytes
 * picks the path).
 */
export async function downloadFile(
  api: ApiClient,
  file: { id: string; filename: string },
): Promise<void> {
  const res = await fetchFileBytes(api, file.id)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement("a")
    a.href = url
    a.download = file.filename
    a.rel = "noopener"
    a.click()
  } finally {
    // Delay revocation so the click's navigation has started.
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  }
}

/**
 * Fetch an image attachment's preview bytes (thumbnail when one exists, full
 * image otherwise) via the authenticated inline route. Returns an object URL
 * the caller must revoke.
 */
export async function fetchPreviewObjectUrl(api: ApiClient, fileId: string): Promise<string> {
  // A preview is decoration: every caller falls back to the filetype card when
  // it cannot be produced, so a missing object or a storage hiccup must stay
  // silent rather than popping the global error toast over a view the user
  // only opened to read.
  const res = await api.rawGet(`/files/${fileId}/inline?variant=thumb`, {
    suppressGlobalError: true,
  })
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

/**
 * Fetch an image attachment's FULL-resolution bytes via the authenticated
 * inline route (no `thumb` variant). Returns an object URL the caller owns and
 * must revoke. Used to back click-to-expand fullscreen previews — a native
 * `<img src="/api/files/:id/inline">` cannot carry the Bearer header the route
 * requires, so previews must stream through the authed client into a blob.
 */
export async function fetchInlineObjectUrl(api: ApiClient, fileId: string): Promise<string> {
  const res = await api.rawGet(`/files/${fileId}/inline`)
  if (!res.ok) throw new Error(`inline fetch failed: ${res.status}`)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

// --- Preview object-URL cache ---
// Virtualized message lists mount/unmount AttachmentCards constantly during
// scrollback. Fetching (and revoking) a blob URL per mount makes every
// scroll-up flash icon→image and re-downloads the same thumbnail dozens of
// times. The cache owns the object URLs for the session: concurrent requests
// dedupe on the in-flight promise, failures back off instead of hammering,
// and the oldest entries are revoked once the cache exceeds its cap.

const PREVIEW_CACHE_MAX = 300
const PREVIEW_FAILURE_RETRY_MS = 60_000

const previewCache = new Map<string, Promise<string | null>>()
const previewFailedAt = new Map<string, number>()

/**
 * Cached variant of {@link fetchPreviewObjectUrl}. Returns null when the
 * preview is unavailable (missing thumbnail, server error) — callers render
 * their filetype-icon fallback. Do NOT revoke the returned URL; the cache
 * owns its lifetime.
 */
export function getCachedPreviewObjectUrl(api: ApiClient, fileId: string): Promise<string | null> {
  const cached = previewCache.get(fileId)
  if (cached) return cached

  const failedAt = previewFailedAt.get(fileId)
  if (failedAt !== undefined && Date.now() - failedAt < PREVIEW_FAILURE_RETRY_MS) {
    return Promise.resolve(null)
  }

  const promise = fetchPreviewObjectUrl(api, fileId).then(
    (url) => {
      previewFailedAt.delete(fileId)
      return url
    },
    () => {
      // Failed previews fall back to the icon; allow a retry after a cooldown
      // rather than refetching on every remount.
      previewFailedAt.set(fileId, Date.now())
      previewCache.delete(fileId)
      return null
    },
  )
  previewCache.set(fileId, promise)

  if (previewCache.size > PREVIEW_CACHE_MAX) {
    // Maps iterate in insertion order — evict (and revoke) the oldest entry.
    const oldestKey = previewCache.keys().next().value
    if (oldestKey !== undefined) {
      const evicted = previewCache.get(oldestKey)
      previewCache.delete(oldestKey)
      void evicted?.then((url) => {
        if (url) URL.revokeObjectURL(url)
      })
    }
  }
  return promise
}

/** Revoke every cached preview URL — called on logout/session teardown. */
export function resetPreviewCache(): void {
  for (const promise of previewCache.values()) {
    void promise.then((url) => {
      if (url) URL.revokeObjectURL(url)
    })
  }
  previewCache.clear()
  previewFailedAt.clear()
}
onSessionTeardown(resetPreviewCache)

export async function deleteFile(api: ApiClient, fileId: string): Promise<void> {
  await api.delete(`/files/${fileId}`)
}

/** The send control's accessible name while a hold is up: what a press will
 *  do (queue), or that a send is already queued. Undefined with no hold. */
export function uploadHoldLabel(t: (key: string) => string, hold: UploadHold): string | undefined {
  if (hold.queued()) return t("kernel.filesUi.sendQueuedUntilUploaded")
  if (hold.held()) return t("kernel.filesUi.sendWhenUploaded")
  return undefined
}
