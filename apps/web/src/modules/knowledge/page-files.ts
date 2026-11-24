// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Knowledge page's files, as the page draws and adds them. Every read goes through
// the files API under the reader's own rights: a file's description from
// `/files/:id/metadata`, a picture's bytes from the authenticated `/files/:id/inline`
// route into a `blob:` URL. Nothing is ever fetched from an address a page's text holds.
// Uploads go through the files service with the page as the parent.
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import {
  type FileViewDeps,
  isFileId,
  isInlineImage,
  type PageFileInfo,
} from "~/modules/editor/file-view"
import {
  downloadFile,
  FileQuotaExceededError,
  type FileRow,
  FileStorageUnavailableError,
  uploadFile,
} from "~/modules/files/file-service"
import type { Translate } from "~/modules/i18n/i18n-context"
import { capLimitMessage } from "~/modules/settings/cap-limit-message"

type Api = Pick<ApiClient, "get" | "rawGet">

const INFO_CACHE_MAX = 500
const IMAGE_CACHE_MAX = 100
const infoCache = new Map<string, Promise<PageFileInfo | null>>()
const imageCache = new Map<string, Promise<string | null>>()

function trim<T>(cache: Map<string, Promise<T>>, max: number, release?: (value: T) => void) {
  while (cache.size > max) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) return
    const evicted = cache.get(oldest)
    cache.delete(oldest)
    if (release) void evicted?.then(release)
  }
}

/** A file as the reader may read it, or null (no access, gone, not a file id). */
export function resolvePageFile(api: Api, id: string): Promise<PageFileInfo | null> {
  if (!isFileId(id)) return Promise.resolve(null)
  const key = id.toLowerCase()
  const known = infoCache.get(key)
  if (known) return known
  const asked = api
    .get<{ id: string; filename: string; mimeType: string; sizeBytes: number }>(
      `/files/${key}/metadata`,
      { suppressGlobalError: true },
    )
    .then(
      (row): PageFileInfo | null =>
        row && typeof row.filename === "string"
          ? {
              id: row.id,
              filename: row.filename,
              mimeType: String(row.mimeType ?? ""),
              sizeBytes: Number(row.sizeBytes ?? 0),
            }
          : null,
      (err) => {
        // Not readable is an answer; any other failure is asked again next time.
        if (!(err instanceof ApiError && (err.status === 404 || err.status === 403))) {
          infoCache.delete(key)
        }
        return null
      },
    )
  infoCache.set(key, asked)
  trim(infoCache, INFO_CACHE_MAX)
  return asked
}

/** A file just stored: its description is known without asking. */
export function primePageFile(row: Pick<FileRow, "id" | "filename" | "mimeType" | "sizeBytes">) {
  infoCache.set(
    row.id.toLowerCase(),
    Promise.resolve({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
    }),
  )
  trim(infoCache, INFO_CACHE_MAX)
}

/** An object URL of a raster picture, read through the authenticated inline route. */
export function pageImageUrl(api: Api, id: string): Promise<string | null> {
  if (!isFileId(id)) return Promise.resolve(null)
  const key = id.toLowerCase()
  const known = imageCache.get(key)
  if (known) return known
  const asked = api
    .rawGet(`/files/${key}/inline`, { suppressGlobalError: true })
    .then(async (res) => {
      if (!res.ok) return null
      const blob = await res.blob()
      // Only a raster picture is drawn; anything else stays a card.
      return isInlineImage(blob.type || res.headers.get("content-type") || "")
        ? URL.createObjectURL(blob)
        : null
    })
    .catch(() => null)
    .then((url) => {
      if (!url) imageCache.delete(key)
      return url
    })
  imageCache.set(key, asked)
  trim(imageCache, IMAGE_CACHE_MAX, (url) => {
    if (url) URL.revokeObjectURL(url)
  })
  return asked
}

/** Forget what was read (sign-out, another person). */
export function resetPageFiles(): void {
  for (const asked of imageCache.values()) {
    void asked.then((url) => {
      if (url) URL.revokeObjectURL(url)
    })
  }
  imageCache.clear()
  infoCache.clear()
}
onSessionTeardown(resetPageFiles)

/** What the page's editor and reader need to draw its files. */
export function pageFileView(api: ApiClient, t: Translate): FileViewDeps {
  return {
    resolve: (id) => resolvePageFile(api, id),
    imageUrl: (id) => pageImageUrl(api, id),
    open: (file) => void downloadFile(api, { id: file.id, filename: file.filename }),
    labels: {
      unavailable: t("knowledge.files.unavailable"),
      loading: t("knowledge.files.loading"),
      download: (name) => t("knowledge.files.download", { name }),
    },
  }
}

/** Store `file` on the page; the row the files service confirmed. */
export async function uploadPageFile(api: ApiClient, docId: string, file: File): Promise<FileRow> {
  const row = await uploadFile(api, file, {
    app: "knowledge",
    entityType: "document",
    entityId: docId,
  })
  primePageFile(row)
  return row
}

/** Why `file` was not added, in the writer's language. */
export function uploadRefusal(t: Translate, err: unknown, name: string): string {
  if (err instanceof FileQuotaExceededError) {
    if (err.code === "FILE_TOO_LARGE") {
      const limit = /(\d+(?:\.\d+)?)\s*MB/i.exec(err.message)?.[1]
      return limit
        ? t("knowledge.files.tooLargeLimit", { name, limit })
        : t("knowledge.files.tooLarge", { name })
    }
    return capLimitMessage(t, err.code) ?? t("knowledge.files.storageFull", { name })
  }
  if (err instanceof FileStorageUnavailableError) return t("knowledge.files.storageDown", { name })
  if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
    return t("knowledge.files.notAllowed", { name })
  }
  return t("knowledge.files.failed", { name })
}
