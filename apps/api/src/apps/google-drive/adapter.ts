// SPDX-License-Identifier: FSL-1.1-ALv2

import { DRIVE_FOLDER_MIME, PICKED_ROOT_REF, type PickedItem } from "~/apps/google-drive/drive-mode"
import {
  driveHasText,
  googleExportMimeFor,
  XLSX_MIME,
  xlsxToText,
} from "~/apps/google-drive/drive-text"
import type { KnowledgeActor } from "~/apps/knowledge/service"
import type {
  KnowledgeFolderItem,
  KnowledgeFolderListInput,
  KnowledgeFolderListResult,
  KnowledgeSearchHit,
  KnowledgeSourceAdapter,
  KnowledgeSourceSearchResult,
} from "~/apps/knowledge/source-protocol"

const GOOGLE_EXPORTABLE_MIME_TYPES = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
])

interface DriveFile {
  id: string
  name: string
  mimeType: string
  webViewLink?: string
  modifiedTime?: string
  owners?: Array<{ displayName: string }>
  capabilities?: { canDownload?: boolean }
  shortcutDetails?: { targetId?: string }
  resourceKey?: string
  trashed?: boolean
}

interface DriveListResponse {
  files?: DriveFile[]
  incompleteSearch?: boolean
  nextPageToken?: string
}

interface DrivePolicy {
  connectionMode?: string
  broadSearchEnabled?: boolean
}

export interface RemoteContentResult {
  status: string
  text?: string
  url?: string
  title?: string
  modifiedAt?: string
}

/** Picks Drive no longer shows: deleted (404), no longer shared (403 that is no rate limit). */
function pickGone(error: unknown): boolean {
  const err = error as { status?: unknown; reason?: unknown }
  if (err.status === 404) return true
  return err.status === 403 && !/rate.?limit/i.test(String(err.reason ?? ""))
}

/**
 * The picked items as Drive has them now (files.get each): a file deleted,
 * trashed or no longer shared drops out, so the reconciler archives it like a
 * file gone from a folder; names and types are Drive's, not the browser's.
 * Any other failure (revoked token, rate limit) throws: the sync fails rather
 * than emptying the source. Without a metadata fetcher (the creation precheck)
 * the stored list is used as is.
 */
async function livePickedItems(
  stored: PickedItem[],
  getMetadata: GoogleDriveAdapterDeps["getMetadata"],
): Promise<PickedItem[]> {
  if (!getMetadata) return stored
  const live: PickedItem[] = []
  const CONCURRENCY = 8
  for (let i = 0; i < stored.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      stored.slice(i, i + CONCURRENCY).map(async (p) => {
        try {
          const meta = await getMetadata({ id: p.id })
          if (meta.trashed) return null
          return { id: p.id, name: meta.name || p.name, mimeType: meta.mimeType || p.mimeType }
        } catch (err) {
          if (pickGone(err)) return null
          throw err
        }
      }),
    )
    for (const item of batch) if (item) live.push(item)
  }
  return live
}

export interface GoogleDriveAdapterDeps {
  getToken(): Promise<string>
  fetchDrive(params: Record<string, unknown>): Promise<DriveListResponse>
  getMetadata?(input: { id: string }): Promise<DriveFile>
  download?(input: { id: string; resourceKey?: string }): Promise<{ text: string }>
  exportGoogleDoc?(input: { id: string; mimeType: string }): Promise<{ text: string }>
  /** A file's raw bytes (an Excel workbook, turned into text here). */
  downloadBytes?(input: {
    id: string
    resourceKey?: string
    mimeType?: string
  }): Promise<{ bytes: Uint8Array }>
  getPolicy?(): Promise<DrivePolicy>
  /** The items picked on the source's Drive account (drive-mode.ts), for the
   *  picked-items root (`PICKED_ROOT_REF`). */
  getPickedItems?(): Promise<PickedItem[]>
}

function isOAuthRevoked(error: unknown): boolean {
  const err = error as { code?: unknown; status?: unknown }
  return err.code === "OAUTH_REVOKED" || err.code === "OAUTH_ERROR" || err.status === 401
}

function isRateLimit(error: unknown): boolean {
  const err = error as { code?: unknown; status?: unknown }
  return err.code === "RATE_LIMITED" || err.status === 429
}

/**
 * Reduce a user query to a substring safe to interpolate into the Drive
 * `q` parameter. Drops single quotes (would escape into the operator stream),
 * backslashes (escape-of-escape ambiguity), and control characters. Operators
 * like `and`/`or` survive as plain words inside the `fullText contains '...'`
 * literal — Drive treats them as content because they're inside the quotes.
 */
// Strip C0 + DEL controls before passing to Drive's `fullText contains '…'`
// literal so a malicious query can't break out of the quoted string.
export function sanitizeDriveQuery(query: string): string {
  return (
    query
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char strip; see function comment
      .replace(/[\\'\x00-\x1f\x7f]/g, "")
      .trim()
      .slice(0, 1000)
  )
}

function skippedStatus(message: string): KnowledgeSourceSearchResult {
  return {
    hits: [],
    status: {
      source: "google-drive",
      state: "skipped",
      retryable: false,
      message,
      hitCount: 0,
    },
  }
}

function canFetchFile(file: DriveFile): boolean {
  if (GOOGLE_EXPORTABLE_MIME_TYPES.has(file.mimeType)) return true
  return file.capabilities?.canDownload === true
}

function mapDriveFile(file: DriveFile): KnowledgeSearchHit {
  const duplicateKeys: string[] = [`gdrive:${file.id}`]
  if (file.shortcutDetails?.targetId) duplicateKeys.push(`gdrive:${file.shortcutDetails.targetId}`)
  if (file.webViewLink) duplicateKeys.push(`url:${file.webViewLink}`)

  return {
    source: "google-drive",
    sourceEntityId: file.id,
    title: file.name,
    url: file.webViewLink,
    type: GOOGLE_EXPORTABLE_MIME_TYPES.has(file.mimeType) ? "google_doc" : "file",
    modifiedAt: file.modifiedTime,
    canFetchContent: canFetchFile(file),
    status: "available",
    duplicateKeys,
  }
}

export function createGoogleDriveAdapter(deps: GoogleDriveAdapterDeps): KnowledgeSourceAdapter & {
  fetchRemoteContent(
    input: { sourceEntityId: string },
    actor: KnowledgeActor,
    purpose?: string,
  ): Promise<RemoteContentResult>
} {
  return {
    source: "google-drive",

    async searchRemote(input, _actor): Promise<KnowledgeSourceSearchResult> {
      // Spec §161-162: broad Drive search is an explicit opt-in. We fail closed:
      // - no policy resolver at all → skipped (no opt-in present)
      // - resolver throws → error (operator-visible misconfiguration)
      // - resolver returns falsy broadSearchEnabled → skipped (explicit opt-out)
      if (!deps.getPolicy) {
        return skippedStatus("Drive policy not configured")
      }
      let policy: DrivePolicy
      try {
        policy = await deps.getPolicy()
      } catch (error) {
        const durationMs = 0
        return {
          hits: [],
          status: {
            source: "google-drive",
            state: "error",
            retryable: true,
            message: error instanceof Error ? error.message : "Drive policy lookup failed",
            durationMs,
            hitCount: 0,
          },
        }
      }
      if (!policy.broadSearchEnabled) {
        return skippedStatus("Drive broad search is not enabled for this connection")
      }

      const start = Date.now()
      try {
        const pageToken = input.cursors?.["google-drive"]
        // Spec §169: Drive `q` parameter only accepts a constrained character
        // set; we strip everything that isn't safe for `fullText contains '...'`
        // rather than escape — escaping single quotes is brittle when callers
        // can pass operator keywords (`and`, `or`, `=`, parentheses).
        const safeQuery = sanitizeDriveQuery(input.query)
        if (!safeQuery) {
          return {
            hits: [],
            status: {
              source: "google-drive",
              state: "complete",
              retryable: false,
              durationMs: 0,
              hitCount: 0,
            },
          }
        }
        const response = await deps.fetchDrive({
          q: `fullText contains '${safeQuery}'`,
          pageSize: input.limit,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          fields:
            "files(id,name,mimeType,webViewLink,modifiedTime,owners,capabilities,shortcutDetails,resourceKey),incompleteSearch,nextPageToken",
          ...(pageToken ? { pageToken } : {}),
        })

        const files = response.files ?? []
        const hits = files.map(mapDriveFile)
        const durationMs = Date.now() - start
        const cursor = response.nextPageToken

        return {
          hits,
          status: {
            source: "google-drive",
            state: response.incompleteSearch ? "partial" : "complete",
            retryable: false,
            cursor,
            durationMs,
            hitCount: hits.length,
          },
        }
      } catch (error) {
        const durationMs = Date.now() - start
        if (isOAuthRevoked(error)) {
          return {
            hits: [],
            status: {
              source: "google-drive",
              state: "unauthorized",
              retryable: false,
              message: "Google Drive access revoked. Please reconnect your account.",
              durationMs,
              hitCount: 0,
            },
          }
        }
        if (isRateLimit(error)) {
          return {
            hits: [],
            status: {
              source: "google-drive",
              state: "rate-limited",
              retryable: true,
              message: "Google Drive rate limit reached. Try again shortly.",
              durationMs,
              hitCount: 0,
            },
          }
        }
        return {
          hits: [],
          status: {
            source: "google-drive",
            state: "error",
            retryable: true,
            message: error instanceof Error ? error.message : "Drive search failed",
            durationMs,
            hitCount: 0,
          },
        }
      }
    },

    /**
     * Direct files.get probe used by `linkRemoteDocument` to confirm visibility
     * before persisting a source-link. Avoids relying on `searchRemote` (which
     * depends on broadSearchEnabled + matching fullText against the title) for
     * a check that should only require read access to the specific file.
     */
    async getRemoteMetadata(
      input: { sourceEntityId: string },
      _actor: KnowledgeActor,
    ): Promise<{ url?: string; title?: string; modifiedAt?: string } | null> {
      if (!deps.getMetadata) return null
      try {
        const metadata = await deps.getMetadata({ id: input.sourceEntityId })
        return {
          url: metadata.webViewLink,
          title: metadata.name,
          modifiedAt: metadata.modifiedTime,
        }
      } catch (err) {
        // Keep the probe failure observable so callers can distinguish "file
        // not visible" (legit 403) from "adapter wired wrong" (silent null).
        console.warn("[google-drive] getRemoteMetadata failed", {
          sourceEntityId: input.sourceEntityId,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    },

    async fetchRemoteContent(input, _actor, _purpose): Promise<RemoteContentResult> {
      if (!deps.getMetadata) {
        return { status: "unsupported" }
      }

      let metadata: DriveFile
      try {
        metadata = await deps.getMetadata({ id: input.sourceEntityId })
      } catch {
        return { status: "unavailable" }
      }

      if (!canFetchFile(metadata)) {
        return { status: "unsupported" }
      }

      const exportMime = googleExportMimeFor(metadata.mimeType)
      if (exportMime && deps.exportGoogleDoc) {
        try {
          // A Sheet exports as CSV (Drive refuses text/plain for one), a Doc or
          // Slides as plain text (drive-text.ts).
          const content = await deps.exportGoogleDoc({ id: metadata.id, mimeType: exportMime })
          return {
            status: "available",
            text: content.text,
            url: metadata.webViewLink,
            title: metadata.name,
            modifiedAt: metadata.modifiedTime,
          }
        } catch {
          return { status: "unavailable" }
        }
      }
      if (GOOGLE_EXPORTABLE_MIME_TYPES.has(metadata.mimeType)) return { status: "unsupported" }

      // An Excel workbook: its bytes, turned into CSV sheet by sheet.
      if (metadata.mimeType === XLSX_MIME) {
        if (!metadata.capabilities?.canDownload || !deps.downloadBytes) {
          return { status: "unsupported" }
        }
        try {
          const { bytes } = await deps.downloadBytes({
            id: metadata.id,
            resourceKey: metadata.resourceKey,
            mimeType: metadata.mimeType,
          })
          return {
            status: "available",
            text: await xlsxToText(bytes, metadata.name),
            url: metadata.webViewLink,
            title: metadata.name,
            modifiedAt: metadata.modifiedTime,
          }
        } catch {
          return { status: "unavailable" }
        }
      }

      if (metadata.capabilities?.canDownload && deps.download) {
        try {
          const content = await deps.download({
            id: metadata.id,
            resourceKey: metadata.resourceKey,
          })
          return {
            status: "available",
            text: content.text,
            url: metadata.webViewLink,
            title: metadata.name,
            modifiedAt: metadata.modifiedTime,
          }
        } catch {
          return { status: "unavailable" }
        }
      }

      return { status: "unsupported" }
    },

    /**
     * Enumerate the direct children of a Drive folder (M-2 protocol extension).
     * Reuses `deps.fetchDrive` — the same shim `searchRemote` uses — with a
     * `q: "'<folderRef>' in parents and trashed = false"` filter. The
     * reconciler recurses by calling `listFolder` again with the externalId
     * of any returned `kind: "folder"` item.
     */
    async listFolder(
      input: KnowledgeFolderListInput,
      _actor: KnowledgeActor,
    ): Promise<KnowledgeFolderListResult> {
      const { folderRef, cursor } = input
      // The picked-items root: what the person chose in the Google Picker
      // (drive.file). A picked folder is walked like any folder below; under
      // drive.file Drive lists only the children the app may see.
      if (folderRef === PICKED_ROOT_REF) {
        const stored = deps.getPickedItems ? await deps.getPickedItems() : []
        const picked = await livePickedItems(stored, deps.getMetadata)
        return {
          items: picked.map((p) =>
            p.mimeType === DRIVE_FOLDER_MIME
              ? { kind: "folder", externalId: p.id, name: p.name, parentExternalId: folderRef }
              : {
                  kind: "file",
                  externalId: p.id,
                  name: p.name,
                  parentExternalId: folderRef,
                  mimeType: p.mimeType,
                },
          ),
        }
      }
      // C3 defense-in-depth: `folderRef` is interpolated into Drive's `q:`
      // filter. The route layer (`syncedSourceCreateSchema`) restricts it to
      // the Drive file-id charset, but adapters can also be called from tests
      // or future code paths. Re-check here so injection is impossible even if
      // a caller forgets validation.
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(folderRef)) {
        throw new Error(`Invalid Drive folderRef: ${JSON.stringify(folderRef)}`)
      }
      const response = await deps.fetchDrive({
        q: `'${folderRef}' in parents and trashed = false`,
        pageSize: 200,
        fields: "files(id,name,mimeType,modifiedTime),nextPageToken",
        ...(cursor ? { pageToken: cursor } : {}),
      })
      const items: KnowledgeFolderItem[] = (response.files ?? []).map((f) => {
        const isFolder = f.mimeType === "application/vnd.google-apps.folder"
        const item: KnowledgeFolderItem = {
          kind: isFolder ? "folder" : "file",
          externalId: f.id,
          name: f.name,
          parentExternalId: folderRef,
        }
        if (!isFolder) {
          if (f.mimeType) item.mimeType = f.mimeType
          if (f.modifiedTime) item.modifiedAt = f.modifiedTime
        }
        return item
      })
      const result: KnowledgeFolderListResult = { items }
      if (response.nextPageToken) result.nextCursor = response.nextPageToken
      if (response.incompleteSearch) result.incompleteSearch = true
      return result
    },
    hasText: driveHasText,
    // NOTE: pickFolder is intentionally NOT declared in v1.
    // The Knowledge UI branches on `typeof adapter.pickFolder === "function"`;
    // when absent, the add-source wizard falls back to a manual folder-ID input.
  }
}
