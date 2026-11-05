// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Host-side agent-tool logic for the Google Drive connector.
 *
 * Drive is the reference **headless app** — a backend-only connector with no
 * frontend. Its agent tools follow the same three-layer shape every manifest
 * app uses for host-side work:
 *
 *   sandboxed handler (handlers.ts) → rpc-bridge method (drive_*) → this module
 *
 * `driveSearch` finds Drive files; `driveImport` downloads a Drive file's bytes
 * and materialises them into a `kernel.files` row anchored to a per-user
 * `file_upload_session` — the kernel's existing staging primitive for a file
 * not yet attached to any entity. The returned file id is an ordinary
 * `kernel.files` id the agent feeds straight into any send tool's `attachments`
 * parameter; `attachFileToParent` then copies it onto the destination exactly
 * like a native file.
 */
import { csvCell } from "@liaison/shared"
import { sql } from "drizzle-orm"
import { sanitizeDriveQuery } from "~/apps/google-drive/adapter"
import { DriveHttpError, DriveScopeError, makeDriveFetchers } from "~/apps/google-drive/drive-rest"
import type { DriveAccess } from "~/apps/google-drive/drive-scope"
import { googleExportMimeFor, XLSX_MIME, xlsxToText } from "~/apps/google-drive/drive-text"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel/files"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer, putObject } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { isBlockedFileType } from "~/modules/files/attach"
import { buildStorageKey, loadOrgSettings, wouldExceedOrgQuota } from "~/modules/files/service"

const log = rootLogger.child({ module: "google-drive-tools" })
const K = sql.raw(schemaRef("kernel"))

/**
 * Context for a Drive tool call. `drive` (the token and the connection's read
 * scope, drive-scope.ts) is resolved by the rpc-bridge (drive-access.ts) and
 * injected here — keeping these functions free of connection-lookup plumbing and
 * trivially testable. Every Drive read below goes through `makeDriveFetchers`,
 * which enforces the scope.
 */
export interface DriveToolCtx {
  tx: RlsClient
  orgId: string
  userId: string
  /** The caller's Drive connection, or null when no connection exists. */
  drive: DriveAccess | null
}

export type DriveToolError = { error: { code: string; message: string } }
export type DriveToolResult<T> = T | DriveToolError

/**
 * A read the connection's scope refused, as the named tool error the agent
 * relays: `shared_drives_not_chosen` (an organization's Drive connection whose
 * admin has not picked its shared drives yet) or `outside_shared_drives` (a
 * file in someone's My Drive, or in a shared drive nobody chose), or
 * `org_drive_upload_unsupported` (an upload through an organization connection).
 */
export function driveScopeToolError(err: unknown): DriveToolError | null {
  if (!(err instanceof DriveScopeError)) return null
  return {
    error: {
      code:
        err.code === "SHARED_DRIVES_NOT_CHOSEN"
          ? "shared_drives_not_chosen"
          : err.code === "ORG_UPLOAD_UNSUPPORTED"
            ? "org_drive_upload_unsupported"
            : "outside_shared_drives",
      message: err.message,
    },
  }
}

async function refusingOutOfScope<T>(run: Promise<T>): Promise<T | DriveToolError> {
  try {
    return await run
  } catch (err) {
    const refused = driveScopeToolError(err)
    if (refused) return refused
    throw err
  }
}

const NOT_CONNECTED: DriveToolError = {
  error: {
    code: "not_connected",
    message: "No Google Drive connection for this organization.",
  },
}

/** Typed materialisation failure — mapped to a tool error code by `driveImport`. */
class DriveImportError extends Error {
  constructor(
    readonly code: "storage_quota_exceeded" | "file_too_large",
    message: string,
  ) {
    super(message)
  }
}

export interface DriveSearchHit {
  driveFileId: string
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
}

/**
 * The Drive mode the search runs in, read by the bridge from the person's
 * Drive accounts (picker.ts `pickedFilesForUser`). Absent: full mode.
 */
export interface DriveSearchPicked {
  items: ReadonlyArray<{ id: string; name: string; mimeType: string }>
}

/** The picked items listed in one search result, at most. */
const PICKED_LISTED_MAX = 50

/** Search the connected Drive for files whose content/name matches `query`. */
export async function driveSearch(
  ctx: DriveToolCtx & { picked?: DriveSearchPicked },
  params: { query: string; limit?: number },
): Promise<
  DriveToolResult<{
    files: DriveSearchHit[]
    hint?: string
    mode?: "picked"
    pickedFiles?: DriveSearchHit[]
  }>
> {
  const drive = ctx.drive
  if (!drive) return NOT_CONNECTED
  const safeQuery = sanitizeDriveQuery(params.query ?? "")
  if (ctx.picked) return pickedSearch(drive, ctx.picked, safeQuery, params.limit)
  if (!safeQuery) return { files: [] }
  const found = await refusingOutOfScope(searchDrive(drive, safeQuery, params.limit))
  if ("error" in found) return found
  const files = found
  // A Drive connected in picked mode sees only the files the person picked, so
  // "nothing found" may mean "not picked yet": the picker tool says which mode
  // the Drive is in and, in picked mode, shows the card to pick the file.
  return files.length > 0 ? { files } : { files, hint: DRIVE_SEARCH_EMPTY_HINT }
}

async function searchDrive(
  drive: DriveAccess,
  safeQuery: string,
  limit: number | undefined,
): Promise<DriveSearchHit[]> {
  const fetchers = makeDriveFetchers(async () => drive)
  // Match on NAME as well as full-text content so a search for a FOLDER (e.g.
  // "Kestrel 6 Launch Messaging" before a folder-harvest) surfaces it — Drive's
  // `fullText contains` does not match folders, and a folder/file the user names
  // must be findable to act on it. `name contains` returns folders too, so the
  // hit carries the folder id + its `mimeType` (vnd.google-apps.folder) for the
  // agent to feed into add_folder_source.
  const res = await fetchers.fetchDrive({
    q: `(fullText contains '${safeQuery}' or name contains '${safeQuery}') and trashed = false`,
    pageSize: Math.min(Math.max(Math.trunc(limit ?? 25), 1), 100),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
  })
  return (res.files ?? []).map((f) => ({
    driveFileId: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    webViewLink: f.webViewLink,
  }))
}

/**
 * Picked mode: the picked items are what Liaison sees, so they answer the
 * search whatever words the agent tried. The ones whose name holds a word of
 * the query come first in `files` (an empty query lists them all); Drive's own
 * search adds what drive.file shows beyond them (a picked folder's files, the
 * files Liaison made). Every result lists the picked items, so a model that
 * guessed the wrong words still sees the file in one call.
 */
async function pickedSearch(
  drive: DriveAccess,
  picked: DriveSearchPicked,
  safeQuery: string,
  limit: number | undefined,
) {
  const hit = (i: { id: string; name: string; mimeType: string }): DriveSearchHit => ({
    driveFileId: i.id,
    name: i.name,
    mimeType: i.mimeType,
  })
  const words = safeQuery
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== "" && w !== "*")
  const named =
    words.length === 0
      ? picked.items
      : picked.items.filter((i) => words.some((w) => i.name.toLowerCase().includes(w)))
  const files = named.map(hit)
  let searchError: string | undefined
  if (safeQuery && words.length > 0) {
    try {
      for (const f of await searchDrive(drive, safeQuery, limit)) {
        if (!files.some((x) => x.driveFileId === f.driveFileId)) files.push(f)
      }
    } catch (err) {
      // The picked list still answers; the failure is said, not swallowed.
      log.warn({ err }, "drive_search: Drive search failed in picked mode")
      searchError = err instanceof Error ? err.message : String(err)
    }
  }
  const hint =
    picked.items.length === 0
      ? DRIVE_PICKED_NONE_HINT
      : `${DRIVE_PICKED_HINT}${searchError ? ` Drive's own search failed: ${searchError}` : ""}`
  return {
    mode: "picked" as const,
    files,
    // Listed only when the query narrowed `files`: an empty query already lists them.
    ...(words.length > 0 ? { pickedFiles: picked.items.slice(0, PICKED_LISTED_MAX).map(hit) } : {}),
    hint,
  }
}

export const DRIVE_SEARCH_EMPTY_HINT =
  "No file matched. Before saying the file does not exist, call kernel__drive_picker: if this Drive is connected in picked mode, Liaison sees only the files the person picked, and it shows the card where they pick this one."

export const DRIVE_PICKED_HINT =
  "This Drive is in picked mode: Liaison sees only the files the person picked (pickedFiles, listed whatever the query) and the files inside picked folders. When the person means a picked file, read it now with google-drive__read and its driveFileId; do not search again with other words. When the file they mean is not picked, call kernel__drive_picker to show the card where they pick it."

export const DRIVE_PICKED_NONE_HINT =
  "This Drive is in picked mode and the person has picked no file yet, so Liaison sees none of their files. Call kernel__drive_picker to show the card where they pick the files."

export interface DriveImportResult {
  fileId: string
  filename: string
  mimeType: string
  sizeBytes: number
  /**
   * An instructive next-step the weak agent reads off the tool output: the import
   * is NOT the deliverable — the materialized `fileId` must be passed into the send
   * tool's `attachments` array to actually attach the file. Without this nudge a
   * weak model imports the file, gets the id, then calls mail:compose / tickets:reply
   * with NO `attachments` and fabricates "attached" in chat (the gated approval
   * summary then shows no attachment → the rubric's attachment clause fails). See
   * compose-dealer-email-with-drive-spec-attachment.
   */
  nextStep: string
}

/**
 * Download a Drive file and materialise it into `kernel.files` as an
 * attachable file. Returns a `kernel.files` id usable as a send-tool attachment.
 */
async function driveImportInScope(
  ctx: DriveToolCtx,
  params: { driveFileId: string },
): Promise<DriveToolResult<DriveImportResult>> {
  if (!params.driveFileId) {
    return { error: { code: "invalid_params", message: "driveFileId is required." } }
  }
  const drive = ctx.drive
  if (!drive) return NOT_CONNECTED
  const fetchers = makeDriveFetchers(async () => drive)

  const meta = await fetchers.getMetadata({ id: params.driveFileId })
  if ((meta.mimeType ?? "").startsWith("application/vnd.google-apps.")) {
    return {
      error: {
        code: "not_downloadable",
        message:
          "Google Docs, Sheets, and Slides have no binary form and cannot be imported as a file attachment.",
      },
    }
  }
  if (isBlockedFileType(meta.name ?? "", meta.mimeType ?? "")) {
    return {
      error: { code: "unsafe_file_type", message: `File type not allowed: ${meta.name}` },
    }
  }

  const { bytes, mimeType } = await fetchers.downloadBytes({
    id: params.driveFileId,
    resourceKey: meta.resourceKey,
    mimeType: meta.mimeType,
  })

  try {
    return await withPrivilegedDb(ctx.orgId, "drive:import", async (tx) => {
      // An imported file counts against the org's storage quota and per-file
      // size limit, exactly like a human upload.
      const settings = await loadOrgSettings(tx, ctx.orgId)
      if (bytes.byteLength > settings.fileSizeLimitMb * 1024 * 1024) {
        throw new DriveImportError(
          "file_too_large",
          `File exceeds the ${settings.fileSizeLimitMb} MB limit.`,
        )
      }
      if (await wouldExceedOrgQuota(tx, ctx.orgId, settings, bytes.byteLength)) {
        throw new DriveImportError("storage_quota_exceeded", "Org storage quota exceeded.")
      }

      // Anchor the imported file to a per-user `file_upload_session` — the
      // kernel's staging primitive for a file not yet attached to any entity.
      // RLS makes it visible to the importing user (the session owner), who
      // then attaches it onward via any send tool.
      const sessionRows = (await tx.execute(
        sql`INSERT INTO ${K}.file_upload_sessions
              (org_id, created_by, target_app, target_entity_type, target_entity_id)
            VALUES (${ctx.orgId}, ${ctx.userId}, 'google-drive', 'import', NULL)
            RETURNING id::text AS id`,
      )) as unknown as Array<{ id: string }>
      const sessionId = sessionRows[0].id

      const filename = meta.name ?? "drive-file"
      const storageKey = buildStorageKey({
        orgId: ctx.orgId,
        app: "kernel",
        entityType: "file_upload_session",
        entityId: sessionId,
        filename,
      })
      await putObject({ key: storageKey, body: bytes, contentType: mimeType })

      const inserted = await tx
        .insert(files)
        .values({
          orgId: ctx.orgId,
          app: "kernel",
          entityType: "file_upload_session",
          entityId: sessionId,
          filename,
          mimeType,
          sizeBytes: bytes.byteLength,
          storageKey,
          uploadedBy: ctx.userId,
          disposition: "attachment",
        })
        .returning()
      const row = inserted[0]

      await tx.queueEvent({
        app: "kernel",
        entity: "file",
        action: "create",
        entityId: row.id,
        orgId: ctx.orgId,
        actorId: ctx.userId,
        data: {
          id: row.id,
          app: "kernel",
          entityType: "file_upload_session",
          entityId: sessionId,
          filename: row.filename,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
          storageKey: row.storageKey,
          sourceApp: "google-drive",
          sourceDriveFileId: params.driveFileId,
        },
      })

      return {
        fileId: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        nextStep:
          `Imported "${row.filename}" as kernel fileId ${row.id}. To actually attach it, pass this ` +
          `fileId in the send tool's "attachments" array (e.g. mail__compose attachments:["${row.id}"] ` +
          `or tickets__reply attachments:["${row.id}"]). The file is NOT attached until you do this — ` +
          `do not claim it is attached unless this fileId is in the send call's attachments.`,
      }
    })
  } catch (err) {
    if (err instanceof DriveImportError) {
      return { error: { code: err.code, message: err.message } }
    }
    log.error({ err, driveFileId: params.driveFileId }, "drive_import materialization failed")
    throw err
  }
}

// --- Read -------------------------------------------------------------------
// Reading a Drive file's TEXT content (as opposed to `import`, which materialises
// binary bytes into a kernel.files row and returns NO content). This is the
// agent-callable read path for in-context work like parsing a spreadsheet's rows
// into contacts: it exports a native Google Sheet as CSV (rows the agent can
// parse), a native Google Doc as plain text, and downloads the text of a
// downloadable text/* file. Binary/non-text files (PDF, images, firmware .bin)
// are NOT readable as text here — import them instead.

const GOOGLE_EXPORTABLE_PREFIX = "application/vnd.google-apps."

export interface DriveReadResult {
  driveFileId: string
  name: string
  mimeType: string
  /** The exported/downloaded text content (CSV for sheets, plain text otherwise). */
  content: string
  /** The mimeType the content was exported/served as (e.g. text/csv). */
  contentMimeType: string
  webViewLink?: string
  modifiedTime?: string
}

/**
 * Read a Drive file's TEXT content. Unlike `driveImport` (binary → kernel.files,
 * no content returned), this returns the file's text so the agent can parse it
 * in-context — e.g. a "Dealer Prospects" Google Sheet exported as CSV rows that
 * the agent turns into per-prospect contacts_write proposals.
 */
async function driveReadInScope(
  ctx: DriveToolCtx,
  params: { driveFileId: string },
): Promise<DriveToolResult<DriveReadResult>> {
  if (!params.driveFileId) {
    return { error: { code: "invalid_params", message: "driveFileId is required." } }
  }
  const drive = ctx.drive
  if (!drive) return NOT_CONNECTED
  const fetchers = makeDriveFetchers(async () => drive)

  const meta = await fetchers.getMetadata({ id: params.driveFileId })
  const mimeType = meta.mimeType ?? ""

  if (mimeType.startsWith(GOOGLE_EXPORTABLE_PREFIX)) {
    const exportMime = googleExportMimeFor(mimeType)
    if (!exportMime) {
      return {
        error: {
          code: "not_readable_as_text",
          message: `This Google file type (${mimeType}) cannot be read as text. Drawings and other non-document types have no text export.`,
        },
      }
    }
    const { text } = await fetchers.exportGoogleDoc({
      id: params.driveFileId,
      mimeType: exportMime,
    })
    return {
      driveFileId: meta.id,
      name: meta.name ?? "drive-file",
      mimeType,
      content: text,
      contentMimeType: exportMime,
      webViewLink: meta.webViewLink,
      modifiedTime: meta.modifiedTime,
    }
  }

  // An Excel workbook: downloaded and turned into CSV, sheet by sheet.
  if (mimeType === XLSX_MIME) {
    if (meta.capabilities?.canDownload === false) {
      return {
        error: { code: "not_downloadable", message: `File "${meta.name}" cannot be downloaded.` },
      }
    }
    const { bytes } = await fetchers.downloadBytes({
      id: params.driveFileId,
      resourceKey: meta.resourceKey,
      mimeType,
    })
    let content: string
    try {
      content = await xlsxToText(bytes, meta.name ?? "the workbook")
    } catch (err) {
      log.warn({ err, driveFileId: params.driveFileId }, "drive_read: workbook not readable")
      return {
        error: {
          code: "not_readable_as_text",
          message: `"${meta.name}" could not be read as a workbook: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }
    return {
      driveFileId: meta.id,
      name: meta.name ?? "drive-file",
      mimeType,
      content,
      contentMimeType: "text/csv",
      webViewLink: meta.webViewLink,
      modifiedTime: meta.modifiedTime,
    }
  }

  // Non-native file: only text-ish files are readable as text; everything else
  // (PDF, images, octet-stream firmware) must be imported as a binary attachment.
  const isTextLike =
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/csv"
  if (!isTextLike) {
    return {
      error: {
        code: "not_readable_as_text",
        message: `File type ${mimeType || "unknown"} is not text — use import to pull it in as a binary attachment instead of reading it as text.`,
      },
    }
  }
  if (meta.capabilities?.canDownload === false) {
    return {
      error: { code: "not_downloadable", message: `File "${meta.name}" cannot be downloaded.` },
    }
  }
  const { text } = await fetchers.download({
    id: params.driveFileId,
    resourceKey: meta.resourceKey,
  })
  return {
    driveFileId: meta.id,
    name: meta.name ?? "drive-file",
    mimeType,
    content: text,
    contentMimeType: mimeType,
    webViewLink: meta.webViewLink,
    modifiedTime: meta.modifiedTime,
  }
}

// --- Upload -----------------------------------------------------------------
// Writing a NEW file into the connected Drive (files.create multipart).
// Uploads land in an app-owned "Liaison Reports" folder. IMPORTANT: the OAuth
// token is a UNION of drive.readonly + drive.file (both are in the manifest),
// so files.list sees the user's ENTIRE Drive — a bare name match could be a
// pre-existing USER folder the app cannot write into (drive.file grants writes
// only on app-created items). The app's folder is therefore TAGGED at creation
// with appProperties {liaisonReports: '1'} and the lookup filters on that tag;
// a create-into-parent failure (404/403 — folder deleted, or a stale/foreign
// id) mints a fresh tagged folder and retries ONCE. Not concurrency-safe: two
// simultaneous first uploads can each create a folder (Drive has no unique
// name constraint) — accepted for the single-operator v1 flow.
// TWO payload paths, both capped at 5 MB app-side:
//   • `contentBase64` — the caller carries the bytes. Fine for something small
//     the caller already holds.
//   • `sourceFileId`  — a kernel.files id; the server loads the bytes from
//     object storage and the caller carries NOTHING.
// The second exists because the first has a ceiling that is not the 5 MB cap:
// an AGENT calling this tool must EMIT the base64 as tool-call arguments, and a
// ~230 kB PDF is ~307 000 characters. That is what once stopped a quarterly
// report from reaching Drive — the file was well inside the cap and
// still unsendable, because the payload had to travel through the model.
// Bytes belong on the server. `POST /api/files/upload-url` → PUT → `/confirm`
// already returns a kernel file id without the caller ever holding the content;
// this parameter is the other end of that path.

export const UPLOAD_SIZE_CAP_BYTES = 5 * 1024 * 1024 // 5 MB decoded
export const REPORTS_FOLDER_NAME = "Liaison Reports"
/** appProperties tag marking the folder as app-created (see block comment). */
export const REPORTS_FOLDER_TAG_KEY = "liaisonReports"

const SCOPE_MISSING: DriveToolError = {
  error: {
    code: "drive_scope_missing",
    message:
      "Google Drive refused the write (insufficient OAuth scope). The connected Google account has not " +
      "granted the drive.file scope — reconnect Google Drive (the connection now requests " +
      "https://www.googleapis.com/auth/drive.file) and retry the upload.",
  },
}

/** Google 403 reasons that mean "the granted scope does not cover this write". */
const SCOPE_REASONS = new Set(["insufficientScopes", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"])
const RATE_REASONS = new Set(["userRateLimitExceeded", "rateLimitExceeded"])

/** Map a Drive 403 to a NAMED tool error using the captured Google reason —
 *  telling the human to reconnect (scope) when the real problem is a full
 *  Drive or a rate limit sends them down an unfixable path. */
function mapDrive403(err: DriveHttpError): DriveToolError {
  const reason = err.reason ?? ""
  if (reason === "storageQuotaExceeded") {
    return {
      error: {
        code: "drive_storage_full",
        message:
          "The connected Google account's Drive storage is full — free up space (or upgrade the " +
          "account's storage) and retry. Reconnecting Drive will NOT fix this.",
      },
    }
  }
  if (RATE_REASONS.has(reason)) {
    return {
      error: {
        code: "drive_rate_limited",
        message: `Google Drive rate limit hit (${reason}) — wait a minute and retry the upload.`,
      },
    }
  }
  if (SCOPE_REASONS.has(reason) || /scope/i.test(err.message)) return SCOPE_MISSING
  if (!reason) return SCOPE_MISSING // legacy 403 with no parseable body: scope is the likely cause
  return {
    error: {
      code: "drive_permission_denied",
      message: `Google Drive refused the write (403, reason: ${reason}). ${err.message}`,
    },
  }
}

export interface DriveUploadResult {
  fileId: string
  name: string
  webViewLink?: string
  /** Drive id of the app-owned "Liaison Reports" destination folder. */
  folderId: string
}

/** Load a kernel file's bytes for an upload-by-reference. RLS-scoped: a file the
 *  caller cannot see simply is not found. */
async function loadKernelFile(
  ctx: DriveToolCtx,
  sourceFileId: string,
): Promise<{ bytes: Buffer; filename: string; mimeType: string } | DriveToolError> {
  const rows = extractRows(
    await ctx.tx.execute(
      sql`SELECT filename, mime_type AS "mimeType", storage_key AS "storageKey",
                 size_bytes AS "sizeBytes"
          FROM ${K}.files WHERE id = ${sourceFileId}::uuid LIMIT 1`,
    ),
  ) as Array<{ filename: string; mimeType: string; storageKey: string; sizeBytes: number }>
  const row = rows[0]
  if (!row) {
    return {
      error: {
        code: "source_not_found",
        message:
          `No file ${sourceFileId} is visible to you. Stage the file first ` +
          "(POST /api/files/upload-url → PUT the bytes → POST /api/files/confirm) " +
          "and pass the id it returns.",
      },
    }
  }
  if (row.sizeBytes > UPLOAD_SIZE_CAP_BYTES) {
    return {
      error: {
        code: "file_too_large",
        message: `File is ${row.sizeBytes} bytes — the upload cap is 5 MB (${UPLOAD_SIZE_CAP_BYTES} bytes).`,
      },
    }
  }
  const buf = await getObjectBuffer(row.storageKey)
  return { bytes: Buffer.from(buf), filename: row.filename, mimeType: row.mimeType }
}

/**
 * Upload a new file to the connected Drive. The bytes come from EITHER
 * `sourceFileId` (a kernel.files id — preferred: nothing travels through the
 * caller) or `contentBase64`, and are sent as ONE multipart files.create
 * request; the destination is always the app-owned reports folder
 * (drive.file-compatible — arbitrary folderIds the app did not create would 404
 * under that scope, so none is accepted).
 */
export async function driveUpload(
  ctx: DriveToolCtx,
  params: { name: string; mimeType?: string; contentBase64?: string; sourceFileId?: string },
): Promise<DriveToolResult<DriveUploadResult>> {
  if (!params.name || (!params.contentBase64 && !params.sourceFileId)) {
    return {
      error: {
        code: "invalid_params",
        message: "name and one of sourceFileId / contentBase64 are required.",
      },
    }
  }
  if (params.contentBase64 && params.sourceFileId) {
    return {
      error: {
        code: "invalid_params",
        message:
          "Pass sourceFileId OR contentBase64, not both — two sources of truth for " +
          "the same bytes is a silent way to upload the wrong file.",
      },
    }
  }
  if (!ctx.drive) return NOT_CONNECTED

  let bytes: Buffer
  let derivedMime: string | undefined
  if (params.sourceFileId) {
    const loaded = await loadKernelFile(ctx, params.sourceFileId)
    if ("error" in loaded) return loaded
    bytes = loaded.bytes
    derivedMime = loaded.mimeType
  } else {
    const b64 = params.contentBase64 as string
    // Cheap pre-decode cap: base64 inflates by 4/3, so a compliant payload can
    // never exceed cap*4/3 (+ padding) characters. Refuse before materialising.
    if (b64.length > Math.ceil((UPLOAD_SIZE_CAP_BYTES * 4) / 3) + 4) {
      return {
        error: {
          code: "file_too_large",
          message: `contentBase64 decodes to more than the 5 MB upload cap — split or shrink the file (larger uploads are not supported in v1).`,
        },
      }
    }
    const compact = b64.replace(/\s+/g, "")
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 !== 0) {
      return {
        error: { code: "invalid_params", message: "contentBase64 is not valid base64." },
      }
    }
    bytes = Buffer.from(compact, "base64")
    if (bytes.byteLength > UPLOAD_SIZE_CAP_BYTES) {
      return {
        error: {
          code: "file_too_large",
          message: `File is ${bytes.byteLength} bytes — the upload cap is 5 MB (${UPLOAD_SIZE_CAP_BYTES} bytes).`,
        },
      }
    }
  }
  const mimeType = params.mimeType || derivedMime || "application/octet-stream"
  const drive = ctx.drive
  const fetchers = makeDriveFetchers(async () => drive)

  const mintFolder = async (): Promise<string> =>
    (
      await fetchers.createFolder({
        name: REPORTS_FOLDER_NAME,
        appProperties: { [REPORTS_FOLDER_TAG_KEY]: "1" },
      })
    ).id

  try {
    // Find the app-owned reports folder by its appProperties tag ALONE, never
    // by name: the token also carries drive.readonly, so the listing sees the
    // user's whole Drive and a same-named USER folder would shadow ours (and be
    // unwritable under drive.file). Tag-only also keeps the folder's display
    // name free to change without orphaning the folder an earlier version of
    // this app already created in a live Drive.
    const tagged = await fetchers.findTaggedFolder(REPORTS_FOLDER_TAG_KEY)
    let folderId = tagged?.id ?? (await mintFolder())

    let created: { id: string; webViewLink?: string }
    try {
      created = await fetchers.uploadMultipart({
        name: params.name,
        mimeType,
        bytes,
        parentId: folderId,
      })
    } catch (err) {
      // Parent rejected (404: folder gone or never visible to the write scope;
      // 403 on the parent): mint a fresh tagged folder and retry ONCE. A
      // failure on the retry propagates to the outer catch for mapping.
      if (!(err instanceof DriveHttpError) || (err.status !== 404 && err.status !== 403)) throw err
      log.warn(
        { err, folderId, name: params.name },
        "drive_upload parent rejected — recreating reports folder and retrying once",
      )
      folderId = await mintFolder()
      created = await fetchers.uploadMultipart({
        name: params.name,
        mimeType,
        bytes,
        parentId: folderId,
      })
    }
    return {
      fileId: created.id,
      name: params.name,
      webViewLink: created.webViewLink,
      folderId,
    }
  } catch (err) {
    const refused = driveScopeToolError(err)
    if (refused) return refused
    // 403s carry a Google reason (captured by driveFetch) that distinguishes
    // missing scope from quota/rate-limit/permission problems — map to the
    // right named error so the human gets an actionable fix, and log the
    // detail as a field observation either way.
    if (err instanceof DriveHttpError && err.status === 403) {
      const mapped = mapDrive403(err)
      log.error(
        { err, reason: err.reason, code: mapped.error.code, name: params.name },
        "drive_upload refused with 403",
      )
      return mapped
    }
    log.error({ err, name: params.name }, "drive_upload failed")
    throw err
  }
}

// --- Export -----------------------------------------------------------------
// The Drive connector owns its data export (the connected Drive accounts) the
// same way it owns its tools — through this module, not a kernel built-in.

const DRIVE_EXPORT_COLUMNS: Array<[outKey: string, dbKey: string]> = [
  ["id", "id"],
  ["connectionName", "connection_name"],
  ["identifier", "identifier"],
  ["displayName", "display_name"],
  ["status", "status"],
  ["createdAt", "created_at"],
]

function serializeRows(
  rows: Array<Record<string, unknown>>,
  columns: Array<[string, string]>,
  format: string,
): unknown {
  const projected = rows.map((row) => {
    const out: Record<string, string> = {}
    for (const [outKey, dbKey] of columns) {
      const v = row[dbKey]
      out[outKey] = v === null || v === undefined ? "" : String(v)
    }
    return out
  })
  if (format === "csv") {
    const header = columns.map(([k]) => k).join(",")
    const body = projected.map((r) => columns.map(([k]) => csvCell(r[k])).join(",")).join("\n")
    return body ? `${header}\n${body}\n` : `${header}\n`
  }
  return projected
}

/**
 * Export the org's connected Drive accounts (secrets excluded). Runs under the
 * caller's RLS context — never escalates. Backs the manifest `export` slot.
 */
export async function driveExport(
  ctx: DriveToolCtx,
  params: { format?: string; dateRange?: { from?: string; to?: string } },
): Promise<unknown> {
  const from = params.dateRange?.from
  const to = params.dateRange?.to
  const dateClause =
    from && to
      ? sql` AND created_at >= ${from} AND created_at <= ${to}`
      : from
        ? sql` AND created_at >= ${from}`
        : to
          ? sql` AND created_at <= ${to}`
          : sql``
  const rows = extractRows<Record<string, unknown>>(
    await ctx.tx.execute(
      sql`SELECT id, connection_name, identifier, display_name, status, created_at
          FROM ${K}.connected_accounts
          WHERE app_name = 'google-drive'${dateClause}
          ORDER BY created_at ASC`,
    ),
  )
  return serializeRows(rows, DRIVE_EXPORT_COLUMNS, params.format ?? "json")
}

/**
 * Download a Drive file and materialise it into `kernel.files` as an
 * attachable file. Returns a `kernel.files` id usable as a send-tool attachment.
 * A file outside the connection's read scope is refused by name.
 */
export function driveImport(
  ctx: DriveToolCtx,
  params: { driveFileId: string },
): Promise<DriveToolResult<DriveImportResult>> {
  return refusingOutOfScope(driveImportInScope(ctx, params))
}

/** Read a Drive file's TEXT content; a file outside the read scope is refused by name. */
export function driveRead(
  ctx: DriveToolCtx,
  params: { driveFileId: string },
): Promise<DriveToolResult<DriveReadResult>> {
  return refusingOutOfScope(driveReadInScope(ctx, params))
}
