// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `files_list` agent tool — lets an agent enumerate files attached to any
 * entity it can see (thread, email conversation, ticket, knowledge document,
 * …). All such files are `kernel.files` rows, so one generic tool covers every
 * current and future app. Visibility is fully gated by RLS on `kernel.files`.
 */
import { sql } from "drizzle-orm"
import { extractRows, type PrivilegedDb, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { getObjectRange } from "~/infra/storage/object-storage"
import { wrapExternalContent } from "~/lib/external-content"
import { isBlockedFileType } from "~/modules/files/attach"
import {
  authorizeAgentUpload,
  confirmUpload,
  DIRECT_PUT_TTL_SECONDS,
  FileServiceError,
  type FileTokenPayload,
  getRelayDownloadUrl,
  isRelayedFileServable,
  listFiles,
  storeRelayedUpload,
  UPLOAD_TOKEN_TTL_SECONDS,
  verifyFileToken,
} from "~/modules/files/service"
import { decodeTextBytes, isTextLikeFile, TEXT_READ_MAX_BYTES } from "~/modules/files/text-read"
import { isMailFilePrivate } from "~/modules/mailbox-crypto/content-suppression"
import { type MergePdfsResult, mergePdfs } from "~/modules/pdf/merge"

const K = sql.raw(schemaRef("kernel"))

interface FileToolContext {
  userId: string
  orgId: string
  db: RlsClient
  /** Who is calling: a person's own client (`user`, `mcp`) or the in-app agent (`agent`). */
  actorType?: "user" | "agent" | "mcp"
}

export interface MergePdfsToolResult {
  fileId: string
  byteSize: number
  pageCount: number
  title: string
}

export interface AgentFileSummary {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  disposition: string
}

export interface AgentFileDownload {
  fileId: string
  filename: string
  mimeType: string
  sizeBytes: number
  /** Short-lived, pre-authenticated download URL. Fetch the bytes OUT of band. */
  downloadUrl: string
  expiresInSec: number
}

/**
 * List files attached to the given `(app, entityType, entityId)` entity. An
 * entity the agent cannot see (or one with no files) yields an empty list —
 * never an error, so the agent can reason over the result directly.
 */
export async function handleFilesList(
  params: { app: string; entityType: string; entityId: string },
  ctx: FileToolContext,
): Promise<{ files: AgentFileSummary[] }> {
  const result = await listFiles(
    {
      app: params.app,
      entityType: params.entityType,
      entityId: params.entityId,
      includeDownloadUrls: false,
    },
    { rlsTx: ctx.db },
  )
  return {
    files: result.files.map((f) => ({
      id: f.id,
      filename: f.filename,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
      disposition: f.disposition,
    })),
  }
}

/** A text file's content, read in the turn: no URL to fetch. */
export interface AgentFileText {
  fileId: string
  filename: string
  mimeType: string
  sizeBytes: number
  /** The file's text inside the untrusted-content fence: data, never instructions. */
  text: string
  truncated: boolean
  /** Set when `truncated`: how much of the file the text holds. */
  note?: string
}

export interface FileReadError {
  error: { code: string; message: string }
}

export interface FilesReadDeps {
  readRange: (storageKey: string, end: number) => Promise<Uint8Array>
  isServable: typeof isRelayedFileServable
  isPrivateMailFile: (orgId: string, fileId: string) => Promise<boolean>
}

const defaultFilesReadDeps: FilesReadDeps = {
  readRange: async (storageKey, end) => (await getObjectRange(storageKey, { start: 0, end })).bytes,
  isServable: isRelayedFileServable,
  // Fails closed: a lookup error counts as a private mailbox file.
  isPrivateMailFile: (orgId, fileId) =>
    withPrivilegedDb(orgId, "files-read:private-mail", (tx) =>
      isMailFilePrivate(tx, orgId, fileId),
    ).catch(() => true),
}

interface VisibleFileRow {
  id: string
  app: string
  filename: string
  mimeType: string
  sizeBytes: number | string
  storageKey: string
  encVersion: number | string | null
}

/**
 * Read one file the agent can see. A text file (Markdown, plain text, CSV,
 * JSON, YAML, XML, HTML, source code, a log) comes back as its text, at most
 * `TEXT_READ_MAX_BYTES` of it with a note when cut, fenced as untrusted outside
 * content: an attachment is data, never instructions. Any other file (an image,
 * a PDF, a `.espreset` blob), or a text file asked for with `download: true`,
 * comes back as a short-lived signed download URL, which keeps large binary
 * attachments out of the agent's context.
 *
 * Access is the file's own: the row is read under the caller's RLS context (a
 * file of another org, or of a thread or ticket the caller cannot see, raises
 * PARENT_NOT_FOUND exactly like the URL path), the attachment of a deleted
 * message is refused, and the bytes are read server side from the storage key
 * of that row, never from a URL. A sealed file (end-to-end encrypted) and the
 * attachment of a private mailbox are never decoded here: their plaintext must
 * not land in a stored tool result, so they keep the URL path, unchanged.
 * The tool is gated on `kernel:files:read`.
 */
export async function handleFilesRead(
  params: { fileId: string; expiresInSec?: number; download?: boolean },
  ctx: FileToolContext,
  deps: FilesReadDeps = defaultFilesReadDeps,
): Promise<AgentFileDownload | AgentFileText | FileReadError> {
  if (params.download !== true) {
    const row = extractRows<VisibleFileRow>(
      await ctx.db.execute(
        sql`SELECT id, app, filename, mime_type AS "mimeType", size_bytes AS "sizeBytes",
                   storage_key AS "storageKey", enc_version AS "encVersion"
              FROM ${K}.files WHERE id = ${params.fileId} LIMIT 1`,
      ),
    )[0]
    if (!row) throw new FileServiceError("PARENT_NOT_FOUND", "File not visible")
    const text = isTextLikeFile(row.mimeType, row.filename)
      ? await readTextFile(row, ctx, deps)
      : null
    if (text) return text
  }
  const result = await getRelayDownloadUrl(params.fileId, {
    rlsTx: ctx.db,
    ttlSeconds: params.expiresInSec,
  })
  return {
    fileId: result.id,
    filename: result.filename,
    mimeType: result.mimeType,
    sizeBytes: result.sizeBytes,
    downloadUrl: result.downloadUrl,
    expiresInSec: result.expiresInSec,
  }
}

/** The text of a visible text file, a refusal, or null for the URL path. */
async function readTextFile(
  row: VisibleFileRow,
  ctx: FileToolContext,
  deps: FilesReadDeps,
): Promise<AgentFileText | FileReadError | null> {
  if (Number(row.encVersion ?? 0) > 0) return null
  if (row.app === "mail" && (await deps.isPrivateMailFile(ctx.orgId, row.id))) return null
  if (!(await deps.isServable({ orgId: ctx.orgId, fileId: row.id, storageKey: row.storageKey }))) {
    throw new FileServiceError("PARENT_NOT_FOUND", "File not visible")
  }
  const sizeBytes = Number(row.sizeBytes)
  const truncated = sizeBytes > TEXT_READ_MAX_BYTES
  // An empty object has no byte range to ask for.
  const bytes =
    sizeBytes === 0
      ? new Uint8Array()
      : await deps.readRange(row.storageKey, Math.min(sizeBytes, TEXT_READ_MAX_BYTES) - 1)
  const decoded = decodeTextBytes(bytes, truncated)
  if (!decoded.ok) {
    return {
      error: {
        code: "binary_file",
        message: `${row.filename} is named or typed as text but its content is binary (not UTF-8 text), so it is not shown. Ask the person what the file is, or use kernel__analyze_media for an image, video or document.`,
      },
    }
  }
  return {
    fileId: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes,
    text: wrapExternalContent(decoded.text),
    truncated,
    ...(truncated
      ? {
          note: `Only the first ${TEXT_READ_MAX_BYTES} bytes of ${sizeBytes} are shown; the rest of the file is cut. Say so when you answer from it.`,
        }
      : {}),
  }
}

/**
 * Merge several stored PDF files into one new PDF file, returning its id. Each
 * source is loaded under the caller's RLS context (same gating as files_read),
 * so an agent can only merge PDFs it can already see. Input order is preserved
 * exactly, including repeats — the operator flow merges the same customs invoice
 * several times. The result is a new kernel file the caller can download via
 * files_read or attach to any reply, exactly like any other file.
 */
export async function handleFilesMergePdfs(
  params: { file_ids: string[]; title?: string },
  ctx: FileToolContext,
): Promise<MergePdfsToolResult> {
  const result: MergePdfsResult = await mergePdfs(
    { fileIds: params.file_ids, title: params.title },
    { rlsTx: ctx.db, orgId: ctx.orgId, userId: ctx.userId },
  )
  return {
    fileId: result.file_id,
    byteSize: result.byte_size,
    pageCount: result.page_count,
    title: result.title,
  }
}

/**
 * Decoded-size ceiling for `contentBase64` on files_upload_url. Base64 in tool
 * arguments costs a third more than the bytes and rides in the model's context,
 * so it is a convenience for small files only; anything larger takes the PUT.
 */
export const INLINE_UPLOAD_MAX_BYTES = 256 * 1024

export interface UploadToolError {
  error: { code: string; message: string }
}

export type FilesUploadUrlResult =
  | {
      uploadUrl: string
      method: "PUT"
      headers: Record<string, string>
      fileToken: string
      expiresInSec: number
      nextStep: string
    }
  | {
      fileId: string
      filename: string
      mimeType: string
      sizeBytes: number
      nextStep: string
    }
  | UploadToolError

export type FilesUploadConfirmResult =
  | { fileId: string; filename: string; mimeType: string; sizeBytes: number; nextStep: string }
  | UploadToolError

function attachNextStep(fileId: string): string {
  return (
    `Uploaded as kernel fileId ${fileId}. It is NOT attached yet: pass it in a send tool's ` +
    `"attachments" (kernel__threads_reply, mail compose/reply/forward, tickets reply) within 24 hours.`
  )
}

function toToolError(err: unknown): UploadToolError {
  if (err instanceof FileServiceError) return { error: { code: err.code, message: err.message } }
  throw err
}

function privilegedFor(orgId: string) {
  return <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>): Promise<T> =>
    withPrivilegedDb(orgId, reason, fn)
}

const BASE64_RE = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/

/**
 * Stage a local file for an agent (an MCP client) that has no browser session:
 * returns a short-lived PUT URL plus a file token, the exact checks of the web
 * `/files/upload-url` route (org size limit, quota, executable types refused),
 * with the file parented to a session only the caller can see. The bytes go
 * out of band (`curl -X PUT --data-binary @file`), then files_upload_confirm
 * turns the token into a kernel file id. A small file may instead come inline
 * as `contentBase64`, which is stored and confirmed in this one call.
 */
export async function handleFilesUploadUrl(
  params: { filename: string; mimeType: string; sizeBytes?: number; contentBase64?: string },
  ctx: FileToolContext,
): Promise<FilesUploadUrlResult> {
  const mimeType = params.mimeType.trim()
  // The operator's extension allowance is for what staff author: a person's own
  // client uploading, never the in-app agent writing a file of its own.
  const staffAuthored = ctx.actorType === "user" || ctx.actorType === "mcp"
  if (isBlockedFileType(params.filename, mimeType, { staffAuthored })) {
    return {
      error: {
        code: "UNSAFE_FILE_TYPE",
        message: `Executable or script files cannot be uploaded (${params.filename}, ${mimeType}).`,
      },
    }
  }

  let inline: Uint8Array | null = null
  if (params.contentBase64 !== undefined) {
    if (!BASE64_RE.test(params.contentBase64)) {
      return { error: { code: "INVALID_BASE64", message: "contentBase64 is not valid base64." } }
    }
    inline = new Uint8Array(Buffer.from(params.contentBase64, "base64"))
    if (inline.byteLength > INLINE_UPLOAD_MAX_BYTES) {
      return {
        error: {
          code: "INLINE_TOO_LARGE",
          message: `contentBase64 is capped at ${INLINE_UPLOAD_MAX_BYTES} bytes decoded (got ${inline.byteLength}). Omit it and pass sizeBytes to get a PUT URL instead.`,
        },
      }
    }
    if (params.sizeBytes !== undefined && params.sizeBytes !== inline.byteLength) {
      return {
        error: {
          code: "SIZE_MISMATCH",
          message: `sizeBytes ${params.sizeBytes} does not match the ${inline.byteLength} decoded bytes of contentBase64.`,
        },
      }
    }
  } else if (params.sizeBytes === undefined) {
    return {
      error: {
        code: "SIZE_REQUIRED",
        message: "Pass sizeBytes (the exact byte size of the file) or a small contentBase64.",
      },
    }
  }
  const sizeBytes = inline ? inline.byteLength : (params.sizeBytes as number)
  const privileged = privilegedFor(ctx.orgId)

  try {
    const auth = await authorizeAgentUpload(
      { orgId: ctx.orgId, userId: ctx.userId, filename: params.filename, mimeType, sizeBytes },
      { rlsTx: ctx.db, privileged },
    )
    if (inline) {
      const payload: FileTokenPayload = await verifyFileToken(auth.fileToken)
      await storeRelayedUpload(payload, inline, { privileged })
      const row = await confirmUpload(
        auth.fileToken,
        { callerOrgId: ctx.orgId, privileged },
        { disposition: "attachment" },
      )
      return {
        fileId: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        nextStep: attachNextStep(row.id),
      }
    }
    const expiresInSec =
      auth.uploadMode === "direct" ? DIRECT_PUT_TTL_SECONDS : UPLOAD_TOKEN_TTL_SECONDS
    return {
      uploadUrl: auth.uploadUrl,
      method: "PUT",
      headers: { "Content-Type": mimeType },
      fileToken: auth.fileToken,
      expiresInSec,
      nextStep:
        `Within ${expiresInSec}s run: curl -fsS -X PUT -H 'Content-Type: ${mimeType}' ` +
        `--data-binary @<local path> '<uploadUrl>' (the body must be exactly ${sizeBytes} bytes), ` +
        `then call kernel__files_upload_confirm with this fileToken to get the file id.`,
    }
  } catch (err) {
    return toToolError(err)
  }
}

/**
 * Confirm a PUT made against a files_upload_url URL: the stored object is
 * checked against the declared size and type exactly as the web
 * `/files/confirm` route does, and the kernel file row is created. Only the
 * caller who minted the token can confirm it. Retrying returns the same id.
 */
export async function handleFilesUploadConfirm(
  params: { fileToken: string },
  ctx: FileToolContext,
): Promise<FilesUploadConfirmResult> {
  let payload: FileTokenPayload
  try {
    payload = await verifyFileToken(params.fileToken)
  } catch {
    return {
      error: {
        code: "INVALID_TOKEN",
        message: "Invalid or expired file token: call kernel__files_upload_url again.",
      },
    }
  }
  if (payload.orgId !== ctx.orgId || payload.userId !== ctx.userId) {
    return {
      error: { code: "FORBIDDEN", message: "This file token was issued to a different user." },
    }
  }
  const privileged = privilegedFor(ctx.orgId)
  try {
    // Disposition is always attachment: an agent upload is never served inline,
    // so an SVG or HTML file can only ever be downloaded.
    const row = await confirmUpload(
      params.fileToken,
      { callerOrgId: ctx.orgId, privileged },
      { disposition: "attachment" },
    )
    return {
      fileId: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      nextStep: attachNextStep(row.id),
    }
  } catch (err) {
    return toToolError(err)
  }
}
