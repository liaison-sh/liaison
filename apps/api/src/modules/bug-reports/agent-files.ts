// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The files an agent attaches to `kernel:report_bug` (`attachments`: kernel.files
// ids). Each must be readable by the caller: the ids are looked up under the
// caller's own RLS context, so an id the user cannot open refuses the call
// (nothing is filed or prepared). A readable file that cannot go along (end-to-end
// encrypted, over the size cap, a blocked type, its bytes gone) is listed as not
// sent and never fails the report.
//
// Team-only, the prepared draft keeps each file's id and the SHA-256 of its bytes
// at preparation; the payload's attachment list (and so the digest the reporter
// confirms) carries the same metadata as the form's ticked files. On the
// reporter's click the bytes are read again, checked against that SHA-256, and
// staged for the outbox exactly like the form's files (stageForwardFiles); a file
// changed or deleted in between is not sent. Outside team-only the bytes join the
// local report through the form's own attachment path (fileBugReport).

import { createHash } from "node:crypto"
import { MAX_FORWARD_ATTACHMENT_BYTES } from "@liaison/control-plane-contract"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { rootLogger } from "~/lib/logger"
import { isBlockedStoredFile } from "~/modules/files/attach"
import type { ChosenAttachment, StoredForwardFile } from "~/modules/liaison-team/bug-report-payload"
import { stageForwardFiles } from "~/modules/liaison-team/team-only"

const log = rootLogger.child({ service: "bug-reports" })
const K = () => drizzleSql.raw(`"${schemaRef("kernel")}"`)

/** At most this many files on one report (the form's cap and the wire's). */
export const MAX_REPORT_FILES = 5

/** One readable file as the caller sees it. */
export interface ReportFile {
  fileId: string
  /** Its position in the call's `attachments` list. */
  index: number
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
  encrypted: boolean
}

/** A file listed on the report but not sent with it. */
export interface FileNotSent {
  filename: string
  reason: string
}

/** A prepared (team-only) file: what the payload lists, plus the local id. */
export type DraftFile = ChosenAttachment & { fileId: string }

export class UnreadableFilesError extends Error {
  constructor(readonly fileIds: string[]) {
    super(
      `These attachments are not files this user can read: ${fileIds.join(", ")}. Nothing was filed or prepared. Use ids from files_list (or an upload's id), or leave them out.`,
    )
    this.name = "UnreadableFilesError"
  }
}

/**
 * The files of `ids` the caller can read, in the order given (duplicates
 * dropped). Throws `UnreadableFilesError` naming every id the caller's RLS
 * context does not show.
 */
export async function readableReportFiles(
  db: RlsClient,
  orgId: string,
  ids: readonly string[],
): Promise<ReportFile[]> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return []
  const rows = extractRows<{
    id: string
    filename: string
    mime_type: string
    size_bytes: number | string
    storage_key: string
    enc_version: number
  }>(
    await db.execute(drizzleSql`
      SELECT id::text AS id, filename, mime_type, size_bytes, storage_key, enc_version
        FROM ${K()}.files
       WHERE org_id = ${orgId}::uuid
         AND id IN (${drizzleSql.join(
           unique.map((id) => drizzleSql`${id}::uuid`),
           drizzleSql`, `,
         )})`),
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = unique.filter((id) => !byId.has(id))
  if (missing.length > 0) throw new UnreadableFilesError(missing)
  return unique.map((id, index) => {
    const r = byId.get(id) as (typeof rows)[number]
    return {
      fileId: id,
      index,
      filename: r.filename,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes),
      storageKey: r.storage_key,
      encrypted: Number(r.enc_version ?? 0) !== 0,
    }
  })
}

const isMissingObject = (err: unknown): boolean => {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === "NoSuchKey" || e?.Code === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404
}

/** The bytes of a file, or why they cannot be sent. */
async function bytesOf(
  file: { storageKey: string; sizeBytes: number },
  maxBytes: number,
): Promise<Buffer | string> {
  try {
    const bytes = await getObjectBuffer(file.storageKey, undefined, { maxBytes })
    return bytes
  } catch (err) {
    if (isMissingObject(err)) return "its content is missing from storage"
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("maxBytes")) return "too large"
    log.error({ err, storageKey: file.storageKey }, "bug report attachment could not be read")
    return `storage could not be read (${message.slice(0, 200)})`
  }
}

const ENCRYPTED = "end-to-end encrypted: the server cannot read it"

/**
 * Team-only: the files that go with the prepared report (their SHA-256 now) and
 * the ones listed as not sent. The rules are the form's: at most
 * MAX_FORWARD_ATTACHMENT_BYTES each, no blocked type.
 */
export async function prepareDraftFiles(
  orgId: string,
  files: ReportFile[],
): Promise<{ chosen: DraftFile[]; notSent: FileNotSent[] }> {
  const chosen: DraftFile[] = []
  const notSent: FileNotSent[] = []
  for (const file of files) {
    const skip = (reason: string) => notSent.push({ filename: file.filename, reason })
    if (file.encrypted) {
      skip(ENCRYPTED)
      continue
    }
    if (file.sizeBytes > MAX_FORWARD_ATTACHMENT_BYTES || file.sizeBytes <= 0) {
      skip(
        file.sizeBytes <= 0
          ? "empty file"
          : `too large to send to the Liaison team (over ${MAX_FORWARD_ATTACHMENT_BYTES / (1024 * 1024)} MB)`,
      )
      continue
    }
    if (
      await isBlockedStoredFile(orgId, {
        id: file.fileId,
        filename: file.filename,
        mimeType: file.mimeType,
      })
    ) {
      skip("a file type that cannot be sent")
      continue
    }
    const bytes = await bytesOf(file, MAX_FORWARD_ATTACHMENT_BYTES)
    if (typeof bytes === "string") {
      skip(bytes === "too large" ? "too large to send to the Liaison team" : bytes)
      continue
    }
    chosen.push({
      index: file.index,
      fileId: file.fileId,
      filename: file.filename,
      mimeType: file.mimeType,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
  }
  return { chosen, notSent }
}

/**
 * The reporter's click: read each prepared file again and stage it for the
 * outbox under `stageId`, exactly like the form's ticked files. A file deleted
 * or changed since it was prepared is left out (logged). Throws when staging
 * fails; the caller then deletes what was staged.
 */
export async function stageDraftFiles(
  orgId: string,
  stageId: string,
  files: readonly DraftFile[],
): Promise<StoredForwardFile[]> {
  const ready: Array<{ file: DraftFile; bytes: Buffer }> = []
  for (const file of files) {
    const [row] = extractRows<{ storage_key: string; enc_version: number }>(
      await withPrivilegedDb(orgId, "bug-report-draft-file", (tx) =>
        tx.execute(drizzleSql`
          SELECT storage_key, enc_version FROM ${K()}.files
           WHERE id = ${file.fileId}::uuid AND org_id = ${orgId}::uuid`),
      ),
    )
    if (!row || Number(row.enc_version ?? 0) !== 0) {
      log.warn({ fileId: file.fileId }, "prepared bug report file is gone: not sent")
      continue
    }
    const bytes = await bytesOf(
      { storageKey: row.storage_key, sizeBytes: file.sizeBytes },
      file.sizeBytes,
    )
    if (
      typeof bytes === "string" ||
      bytes.byteLength !== file.sizeBytes ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    ) {
      log.warn(
        { fileId: file.fileId },
        "prepared bug report file changed since it was prepared: not sent",
      )
      continue
    }
    ready.push({ file, bytes })
  }
  const ids = await stageForwardFiles(
    orgId,
    stageId,
    ready.map(({ file, bytes }) => ({
      index: file.index,
      filename: file.filename,
      mimeType: file.mimeType,
      bytes,
    })),
  )
  const out: StoredForwardFile[] = []
  for (const { file } of ready) {
    const stagedId = ids.get(file.index)
    if (!stagedId) continue
    const { fileId: _local, ...meta } = file
    out.push({ ...meta, fileId: stagedId })
  }
  return out
}

/**
 * Outside team-only: the files as the form sends them (base64), for the local
 * report's own attachment path, and the ones that cannot go along. Blocked types
 * are left to that path, which lists them the form's way.
 */
export async function localReportFiles(
  files: ReportFile[],
  maxBytes: number,
): Promise<{
  attachments: Array<{ filename: string; mimeType: string; bytesBase64: string }>
  notSent: FileNotSent[]
}> {
  const attachments: Array<{ filename: string; mimeType: string; bytesBase64: string }> = []
  const notSent: FileNotSent[] = []
  for (const file of files) {
    if (file.encrypted) {
      notSent.push({ filename: file.filename, reason: ENCRYPTED })
      continue
    }
    if (file.sizeBytes > maxBytes || file.sizeBytes <= 0) {
      notSent.push({
        filename: file.filename,
        reason:
          file.sizeBytes <= 0 ? "empty file" : `too large (over ${maxBytes / (1024 * 1024)} MB)`,
      })
      continue
    }
    const bytes = await bytesOf(file, maxBytes)
    if (typeof bytes === "string") {
      notSent.push({ filename: file.filename, reason: bytes })
      continue
    }
    attachments.push({
      filename: file.filename,
      mimeType: file.mimeType,
      bytesBase64: bytes.toString("base64"),
    })
  }
  return { attachments, notSent }
}
