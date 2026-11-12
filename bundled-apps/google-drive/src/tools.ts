// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's Drive tools: search, read (a file's text), import (a file as an
// attachable kernel file), upload (a NEW file into the app-owned reports
// folder), and the export slot. Every Drive call goes through `driveClient`
// (drive.ts), which enforces the account's read scope.

import type { DriveCtx } from "./ctx"
import {
  type DriveClient,
  type DriveFile,
  DriveHttpError,
  driveClient,
  scopeRefusal,
} from "./drive"
import {
  accessOf,
  driveModeOf,
  GOOGLE_SHORTCUT_MIME,
  googleExportMimeFor,
  isTextMime,
  mergePickedItems,
  type PickedItem,
  personAccount,
  pickedItemsOf,
  sanitizeDriveQuery,
  XLSX_MIME,
} from "./model"

export type ToolError = { error: { code: string; message: string } }

export const NOT_CONNECTED: ToolError = {
  error: { code: "not_connected", message: "No Google Drive connection for this organization." },
}

export const DRIVE_SEARCH_EMPTY_HINT =
  "No file matched. Before saying the file does not exist, call google-drive__drive_picker: if this Drive is connected in picked mode, Liaison sees only the files the person picked, and it shows the card where they pick this one."
export const DRIVE_PICKED_HINT =
  "This Drive is in picked mode: Liaison sees only the files the person picked (pickedFiles, listed whatever the query) and the files inside picked folders. When the person means a picked file, read it now with google-drive__read and its driveFileId; do not search again with other words. When the file they mean is not picked, call google-drive__drive_picker to show the card where they pick it."
export const DRIVE_PICKED_NONE_HINT =
  "This Drive is in picked mode and the person has picked no file yet, so Liaison sees none of their files. Call google-drive__drive_picker to show the card where they pick the files."

/** The picked items listed in one search result, at most. */
const PICKED_LISTED_MAX = 50
/** contentBase64 decodes to at most this many bytes. */
export const UPLOAD_BASE64_CAP_BYTES = 5 * 1024 * 1024
export const REPORTS_FOLDER_NAME = "Liaison Reports"
/** appProperties tag marking the folder as app-created: a same-named folder of the user's is never used. */
export const REPORTS_FOLDER_TAG_KEY = "liaisonReports"

function invalid(message: string): ToolError {
  return { error: { code: "invalid_params", message } }
}

/** The client of the account a person's call goes through, or null when none is connected. */
async function personClient(ctx: DriveCtx): Promise<DriveClient | null> {
  const account = await personAccount(ctx)
  return account ? driveClient(ctx, accessOf(account)) : null
}

/** A refusal by scope as the named error the agent relays; any other error rethrown. */
async function scoped<T>(run: () => Promise<T>): Promise<T | ToolError> {
  try {
    return await run()
  } catch (err) {
    const refused = scopeRefusal(err)
    if (refused) return refused
    throw err
  }
}

export interface SearchHit {
  driveFileId: string
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
}

const hitOf = (
  f: Pick<DriveFile, "id" | "name" | "mimeType" | "modifiedTime" | "webViewLink">,
): SearchHit => ({
  driveFileId: f.id,
  name: f.name,
  mimeType: f.mimeType,
  ...(f.modifiedTime ? { modifiedTime: f.modifiedTime } : {}),
  ...(f.webViewLink ? { webViewLink: f.webViewLink } : {}),
})

async function searchDrive(
  client: DriveClient,
  safeQuery: string,
  limit: number | undefined,
): Promise<SearchHit[]> {
  // Name as well as content: Drive's fullText does not match folders, and a
  // folder the person names must be findable (to add it to Knowledge).
  const res = await client.list({
    q: `(fullText contains '${safeQuery}' or name contains '${safeQuery}') and trashed = false`,
    pageSize: Math.min(Math.max(Math.trunc(limit ?? 25), 1), 100),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  })
  return res.files.map(hitOf)
}

/** The picked items of the person's accounts in picked mode (theirs and the org's). */
export async function pickedForPerson(
  ctx: DriveCtx,
): Promise<{ picked: boolean; items: PickedItem[] }> {
  const accounts = (await ctx.accounts.list("drive")).filter(
    (a) => driveModeOf(a.metadata) === "picked",
  )
  return {
    picked: accounts.length > 0,
    items: mergePickedItems(
      [],
      accounts.flatMap((a) => pickedItemsOf(a.metadata)),
      [],
    ),
  }
}

/** `search`: files in the connected Drive whose name or content matches. */
export async function driveSearch(
  params: { query?: string; limit?: number },
  ctx: DriveCtx,
): Promise<unknown> {
  const client = await personClient(ctx)
  if (!client) return NOT_CONNECTED
  const safeQuery = sanitizeDriveQuery(params.query ?? "")
  const mode = await pickedForPerson(ctx)
  if (mode.picked) {
    // Picked mode: the picked items answer whatever words the agent tried.
    const words = safeQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== "" && w !== "*")
    const named =
      words.length === 0
        ? mode.items
        : mode.items.filter((i) => words.some((w) => i.name.toLowerCase().includes(w)))
    const files: SearchHit[] = named.map((i) =>
      hitOf({ id: i.id, name: i.name, mimeType: i.mimeType }),
    )
    let searchError: string | undefined
    if (words.length > 0) {
      try {
        for (const f of await searchDrive(client, safeQuery, params.limit)) {
          if (!files.some((x) => x.driveFileId === f.driveFileId)) files.push(f)
        }
      } catch (err) {
        // The picked list still answers; the failure is said, not swallowed.
        ctx.logger.warn("drive search failed in picked mode", { error: String(err) })
        searchError = err instanceof Error ? err.message : String(err)
      }
    }
    return {
      mode: "picked",
      files,
      ...(words.length > 0
        ? { pickedFiles: mode.items.slice(0, PICKED_LISTED_MAX).map((i) => hitOf({ ...i })) }
        : {}),
      hint:
        mode.items.length === 0
          ? DRIVE_PICKED_NONE_HINT
          : `${DRIVE_PICKED_HINT}${searchError ? ` Drive's own search failed: ${searchError}` : ""}`,
    }
  }
  if (!safeQuery) return { files: [] }
  const found = await scoped(() => searchDrive(client, safeQuery, params.limit))
  if ("error" in found) return found
  return found.length > 0 ? { files: found } : { files: found, hint: DRIVE_SEARCH_EMPTY_HINT }
}

/** A shortcut stands for its target: read the target. */
async function resolved(client: DriveClient, id: string): Promise<DriveFile> {
  const meta = await client.metadata(id)
  const target = meta.mimeType === GOOGLE_SHORTCUT_MIME ? meta.shortcutDetails?.targetId : undefined
  return target ? client.metadata(target) : meta
}

function tooLarge(err: unknown): boolean {
  return err instanceof Error && /exceeds \d+ bytes/.test(err.message)
}

/** `read`: a file's TEXT (a Sheet or a workbook as CSV, a Doc or Slides as text, a text file as is). */
export async function driveRead(params: { driveFileId?: string }, ctx: DriveCtx): Promise<unknown> {
  if (!params.driveFileId) return invalid("driveFileId is required.")
  const client = await personClient(ctx)
  if (!client) return NOT_CONNECTED
  return scoped(async () => {
    const meta = await resolved(client, params.driveFileId as string)
    const mimeType = meta.mimeType ?? ""
    const base = {
      driveFileId: meta.id,
      name: meta.name ?? "drive-file",
      mimeType,
      ...(meta.webViewLink ? { webViewLink: meta.webViewLink } : {}),
      ...(meta.modifiedTime ? { modifiedTime: meta.modifiedTime } : {}),
    }
    const exportMime = googleExportMimeFor(mimeType)
    if (mimeType.startsWith("application/vnd.google-apps.") && !exportMime) {
      return {
        error: {
          code: "not_readable_as_text",
          message: `This Google file type (${mimeType}) cannot be read as text. Drawings and other non-document types have no text export.`,
        },
      }
    }
    const isXlsx = mimeType === XLSX_MIME
    if (!exportMime && !isXlsx && !isTextMime(mimeType) && mimeType !== "application/csv") {
      return {
        error: {
          code: "not_readable_as_text",
          message: `File type ${mimeType || "unknown"} is not text: use import to pull it in as a binary attachment instead of reading it as text.`,
        },
      }
    }
    if (!exportMime && meta.capabilities?.canDownload === false) {
      return {
        error: { code: "not_downloadable", message: `File "${meta.name}" cannot be downloaded.` },
      }
    }
    try {
      if (isXlsx)
        return { ...base, content: await client.workbookText(meta), contentMimeType: "text/csv" }
      return {
        ...base,
        content: await client.text(meta, exportMime),
        contentMimeType: exportMime ?? mimeType,
      }
    } catch (err) {
      if (err instanceof DriveHttpError || !(err as { code?: string })?.code) {
        if (tooLarge(err)) {
          return {
            error: {
              code: "file_too_large",
              message: `"${meta.name}" is too large to read as text (over 1 MB).`,
            },
          }
        }
        throw err
      }
      if ((err as { code?: string }).code === "not_a_workbook") {
        return {
          error: {
            code: "not_readable_as_text",
            message: `"${meta.name}" could not be read as a workbook: ${(err as Error).message}`,
          },
        }
      }
      throw err
    }
  })
}

/** `import`: download a Drive file into Liaison as an attachable file (only its id comes back). */
export async function driveImport(
  params: { driveFileId?: string },
  ctx: DriveCtx,
): Promise<unknown> {
  if (!params.driveFileId) return invalid("driveFileId is required.")
  const client = await personClient(ctx)
  if (!client) return NOT_CONNECTED
  if (!ctx.files_importFromUrl) {
    return { error: { code: "unsupported", message: "This server cannot import files for apps." } }
  }
  const importFromUrl = ctx.files_importFromUrl
  return scoped(async () => {
    const meta = await resolved(client, params.driveFileId as string)
    if ((meta.mimeType ?? "").startsWith("application/vnd.google-apps.")) {
      return {
        error: {
          code: "not_downloadable",
          message:
            "Google Docs, Sheets, and Slides have no binary form and cannot be imported as a file attachment.",
        },
      }
    }
    if (meta.capabilities?.canDownload === false) {
      return {
        error: { code: "not_downloadable", message: `File "${meta.name}" cannot be downloaded.` },
      }
    }
    const filename = meta.name || "drive-file"
    // The file's parent: a row of the person's own (personal rows: only they see it).
    const row = await ctx.db.insert("imports", {
      owner_type: "user",
      owner_id: await ctx.getUserId(),
      drive_file_id: meta.id,
      filename,
    })
    let stored: { id: string; filename?: string; mimeType?: string; sizeBytes?: number }
    try {
      stored = JSON.parse(
        await importFromUrl(
          JSON.stringify({
            targetApp: "google-drive",
            targetEntityType: "import",
            targetEntityId: row.id,
            url: client.mediaUrl(meta),
            filename,
            mimeType: meta.mimeType,
            headers: client.mediaHeaders(meta),
            auth: { connection: "drive", account: client.access.accountId, scheme: "bearer" },
            disposition: "attachment",
          }),
        ),
      )
    } catch (err) {
      await ctx.db.delete("imports", row.id)
      const message = err instanceof Error ? err.message : String(err)
      const code = /file_too_large|exceeds/.test(message)
        ? "file_too_large"
        : /quota/i.test(message)
          ? "storage_quota_exceeded"
          : /blocked|not allowed|unsafe/i.test(message)
            ? "unsafe_file_type"
            : null
      if (code) return { error: { code, message } }
      throw err
    }
    return {
      fileId: stored.id,
      filename: stored.filename ?? filename,
      mimeType: stored.mimeType ?? meta.mimeType,
      sizeBytes: stored.sizeBytes ?? 0,
      nextStep:
        `Imported "${filename}" as kernel fileId ${stored.id}. To actually attach it, pass this ` +
        `fileId in the send tool's "attachments" array (e.g. mail__compose attachments:["${stored.id}"] ` +
        `or tickets__reply attachments:["${stored.id}"]). The file is NOT attached until you do this: ` +
        `do not claim it is attached unless this fileId is in the send call's attachments.`,
    }
  })
}

const SCOPE_MISSING: ToolError = {
  error: {
    code: "drive_scope_missing",
    message:
      "Google Drive refused the write (insufficient OAuth scope). The connected Google account has not granted the drive.file scope: reconnect Google Drive (the connection requests https://www.googleapis.com/auth/drive.file) and retry the upload.",
  },
}
const SCOPE_REASONS = new Set(["insufficientScopes", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"])
const RATE_REASONS = new Set(["userRateLimitExceeded", "rateLimitExceeded"])

/** A Drive 403 as a NAMED tool error, from Google's reason. */
export function mapDrive403(err: DriveHttpError): ToolError {
  const reason = err.reason ?? ""
  if (reason === "storageQuotaExceeded") {
    return {
      error: {
        code: "drive_storage_full",
        message:
          "The connected Google account's Drive storage is full: free up space (or upgrade the account's storage) and retry. Reconnecting Drive will NOT fix this.",
      },
    }
  }
  if (RATE_REASONS.has(reason)) {
    return {
      error: {
        code: "drive_rate_limited",
        message: `Google Drive rate limit hit (${reason}): wait a minute and retry the upload.`,
      },
    }
  }
  if (SCOPE_REASONS.has(reason) || /scope/i.test(err.message) || !reason) return SCOPE_MISSING
  return {
    error: {
      code: "drive_permission_denied",
      message: `Google Drive refused the write (403, reason: ${reason}). ${err.message}`,
    },
  }
}

/** `upload`: a NEW file into the app-owned reports folder (bytes from a kernel file or base64). */
export async function driveUpload(
  params: { name?: string; mimeType?: string; contentBase64?: string; sourceFileId?: string },
  ctx: DriveCtx,
): Promise<unknown> {
  if (!params.name || (!params.contentBase64 && !params.sourceFileId)) {
    return invalid("name and one of sourceFileId / contentBase64 are required.")
  }
  if (params.contentBase64 && params.sourceFileId) {
    return invalid(
      "Pass sourceFileId OR contentBase64, not both: two sources of truth for the same bytes is a silent way to upload the wrong file.",
    )
  }
  let media: { fileId: string } | { base64: string }
  if (params.sourceFileId) {
    media = { fileId: params.sourceFileId }
  } else {
    const compact = (params.contentBase64 as string).replace(/\s+/g, "")
    if (compact.length > Math.ceil((UPLOAD_BASE64_CAP_BYTES * 4) / 3) + 4) {
      return {
        error: {
          code: "file_too_large",
          message: "contentBase64 decodes to more than the 5 MB cap: pass sourceFileId instead.",
        },
      }
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
      return invalid("contentBase64 is not valid base64.")
    }
    media = { base64: compact }
  }
  const client = await personClient(ctx)
  if (!client) return NOT_CONNECTED
  const mimeType = params.mimeType || "application/octet-stream"
  const name = params.name
  const mintFolder = () =>
    client.createFolder(REPORTS_FOLDER_NAME, { [REPORTS_FOLDER_TAG_KEY]: "1" })
  try {
    let folderId = (await client.findTaggedFolder(REPORTS_FOLDER_TAG_KEY)) ?? (await mintFolder())
    let created: { id: string; webViewLink?: string }
    try {
      created = await client.upload({ name, mimeType, parentId: folderId, media })
    } catch (err) {
      // The folder was deleted or is no longer ours: make it again, once.
      if (!(err instanceof DriveHttpError) || (err.status !== 404 && err.status !== 403)) throw err
      folderId = await mintFolder()
      created = await client.upload({ name, mimeType, parentId: folderId, media })
    }
    return {
      fileId: created.id,
      name,
      ...(created.webViewLink ? { webViewLink: created.webViewLink } : {}),
      folderId,
    }
  } catch (err) {
    const refused = scopeRefusal(err)
    if (refused) return refused
    if (err instanceof DriveHttpError && err.status === 403) {
      const mapped = mapDrive403(err)
      ctx.logger.error("drive upload refused with 403", {
        reason: err.reason,
        code: mapped.error.code,
      })
      return mapped
    }
    const message = err instanceof Error ? err.message : String(err)
    if (/not visible|not found|forbidden/i.test(message) && params.sourceFileId) {
      return {
        error: {
          code: "source_not_found",
          message: `No file ${params.sourceFileId} is visible to you. Stage the file first (POST /api/files/upload-url, PUT the bytes, POST /api/files/confirm) and pass the id it returns.`,
        },
      }
    }
    if (/request_too_large|exceeds/.test(message)) {
      return {
        error: {
          code: "file_too_large",
          message: `The file is larger than the upload cap (25 MB). ${message}`,
        },
      }
    }
    throw err
  }
}

/** The manifest `export` slot: the Drive accounts the caller can see (no secrets). */
export async function exportGoogleDrive(
  params: { format?: string; dateRange?: { from?: string; to?: string } },
  ctx: DriveCtx,
): Promise<unknown> {
  const from = params.dateRange?.from
  const to = params.dateRange?.to
  const rows = (await ctx.accounts.list("drive", { includeInactive: true }))
    .filter((a) => (!from || a.createdAt >= from) && (!to || a.createdAt <= to))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
    .map((a) => ({
      id: a.id,
      connectionName: "drive",
      identifier: a.identifier,
      displayName: a.displayName ?? "",
      status: a.status,
      createdAt: a.createdAt,
    }))
  if (params.format !== "csv") return rows
  const cell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const columns = [
    "id",
    "connectionName",
    "identifier",
    "displayName",
    "status",
    "createdAt",
  ] as const
  const lines = [
    columns.join(","),
    ...rows.map((r) => columns.map((c) => cell(String(r[c]))).join(",")),
  ]
  return `${lines.join("\n")}\n`
}
