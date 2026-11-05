// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `files_list` agent tool — lets an agent enumerate files attached to any
 * entity it can see (thread, email conversation, ticket, knowledge document,
 * …). All such files are `kernel.files` rows, so one generic tool covers every
 * current and future app. Visibility is fully gated by RLS on `kernel.files`.
 */
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { isBlockedFileType } from "~/modules/files/attach"
import {
  authorizeAgentUpload,
  confirmUpload,
  DIRECT_PUT_TTL_SECONDS,
  FileServiceError,
  type FileTokenPayload,
  getRelayDownloadUrl,
  listFiles,
  storeRelayedUpload,
  UPLOAD_TOKEN_TTL_SECONDS,
  verifyFileToken,
} from "~/modules/files/service"
import { type MergePdfsResult, mergePdfs } from "~/modules/pdf/merge"

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

/**
 * Return a short-lived signed download URL for one file the agent can see,
 * for EVERY file type (a `.log`, a diagnostics `.json`, a `.espreset` blob, an
 * image). The URL is returned instead of the bytes on purpose: it keeps large
 * or noisy attachments (bug-report logs, presets) out of the agent's context —
 * the caller fetches the content out of band. Visibility is gated by RLS on
 * `kernel.files` (a file the caller cannot see raises PARENT_NOT_FOUND, the same
 * not-found-or-forbidden boundary `files_list` uses), and the tool itself is
 * gated on `kernel:files:read`.
 */
export async function handleFilesRead(
  params: { fileId: string; expiresInSec?: number },
  ctx: FileToolContext,
): Promise<AgentFileDownload> {
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
