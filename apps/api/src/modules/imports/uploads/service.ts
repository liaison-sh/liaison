// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import uploads: large export files (up to the org's `importFileSizeLimitMb`,
 * 5 GB by default) uploaded straight from the browser to object storage as an
 * S3 multipart upload, resumable after a dropped connection.
 *
 *   create    checks the import cap and the storage quota, opens an upload
 *             session (the file's owner-only staging parent), starts the
 *             multipart upload and signs the first part URLs
 *   get       the store's own list of received parts (ListParts) and the
 *             missing part numbers: what a client resumes from
 *   sign      fresh URLs for the parts still to send
 *   complete  CompleteMultipartUpload, then the ordinary file confirm (HEAD,
 *             size and type check, quota, kernel.files row)
 *   abort     AbortMultipartUpload; the reaper does the same for uploads
 *             left open past 24 hours
 *
 * When the deployment relays uploads through the API (OBJECT_STORAGE_BROWSER_DIRECT
 * off), there is no browser-to-store path for parts: a file up to the
 * ordinary `fileSizeLimitMb` goes through the existing relay PUT, a larger one
 * is refused with a message naming that setting.
 */
import { and, eq, gt, lt, sql, sum } from "drizzle-orm"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { fileUploadSessions, importUploads, organizations } from "~/db/schema/kernel"
import type { ImportUpload } from "~/db/schema/kernel/import-uploads"
import { type StorageDelivery, storageDelivery } from "~/infra/storage/delivery"
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  listUploadedParts,
  multipartPartCount,
  multipartPartSize,
  presignUploadPart,
} from "~/infra/storage/multipart"
import type { ObjectStorageDeps } from "~/infra/storage/object-storage"
import { sanitizeFilename } from "~/infra/storage/object-storage"
import { filesLogger as log } from "~/lib/logger"
import {
  authorizeAgentUpload,
  buildStorageKey,
  confirmUpload,
  FileServiceError,
  loadOrgSettings,
  orgQuotaBytes,
  signFileToken,
  wouldExceedOrgQuota,
} from "~/modules/files/service"
import {
  SKIPPED_MOVING,
  sweepSkippingMoving,
  writeUnlessMoving,
} from "~/modules/org/transfer-state/skip-moving"

/** Default import cap, in MB, when the org sets no `importFileSizeLimitMb`. */
export const IMPORT_FILE_SIZE_LIMIT_MB_DEFAULT = 5120
/** Part URLs signed at once (create returns this many; `sign` takes at most this many). */
export const IMPORT_SIGN_BATCH = 1000
const PART_URL_TTL_SECONDS = 3600
/** How long an upload stays open without activity before the reaper aborts it. */
const UPLOAD_TTL_MS = 24 * 3600 * 1000
/** The upload-session target an import upload's file is staged under. */
export const IMPORT_UPLOAD_SESSION_TARGET = { app: "kernel", entityType: "import_upload" } as const

export type ImportUploadErrorCode =
  | "NOT_FOUND"
  | "IMPORT_FILE_TOO_LARGE"
  | "RELAY_FILE_TOO_LARGE"
  | "STORAGE_QUOTA_EXCEEDED"
  | "PARTS_MISSING"
  | "INVALID_REQUEST"
  | "NOT_OPEN"
  | "STORAGE_UNAVAILABLE"
  | "FILE_VERIFY_FAILED"

const HTTP_STATUS: Record<ImportUploadErrorCode, 400 | 404 | 409 | 413 | 422 | 503> = {
  NOT_FOUND: 404,
  IMPORT_FILE_TOO_LARGE: 413,
  RELAY_FILE_TOO_LARGE: 413,
  // 409 like the files route: the org state refuses it, not the request size.
  STORAGE_QUOTA_EXCEEDED: 409,
  PARTS_MISSING: 409,
  INVALID_REQUEST: 400,
  NOT_OPEN: 409,
  STORAGE_UNAVAILABLE: 503,
  FILE_VERIFY_FAILED: 422,
}

export class ImportUploadError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 422 | 503
  constructor(
    readonly code: ImportUploadErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "ImportUploadError"
    this.status = HTTP_STATUS[code]
  }
}

export interface ImportUploadDeps {
  privileged: <T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>) => Promise<T>
  rlsTx: RlsClient
  /** Overrides the deployment's direct/relay decision (tests). */
  delivery?: StorageDelivery
  /** Test seam: runs right after the quota check, inside the quota lock. */
  afterQuotaCheck?: () => Promise<void>
  storage?: ObjectStorageDeps
}

export interface ImportUploadView {
  id: string
  mode: "multipart" | "relay"
  status: "uploading" | "complete" | "aborted"
  filename: string
  mimeType: string
  size: number
  partSize: number
  partCount: number
  fileId: string | null
  expiresAt: string
}

export interface CreateImportUploadResult extends ImportUploadView {
  /** Multipart: signed URLs for the first parts (`IMPORT_SIGN_BATCH` at most). */
  parts?: Array<{ partNumber: number; url: string }>
  /** Relay: the single PUT target. */
  uploadUrl?: string
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i

function view(row: ImportUpload): ImportUploadView {
  return {
    id: row.id,
    mode: row.mode,
    status: row.status,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    partSize: row.partSize,
    partCount: row.mode === "multipart" ? multipartPartCount(row.size, row.partSize) : 1,
    fileId: row.fileId,
    expiresAt: row.expiresAt.toISOString(),
  }
}

/** The org's import cap in MB (`settings.importFileSizeLimitMb`, default 5120). */
export async function loadImportFileSizeLimitMb(tx: PrivilegedDb, orgId: string): Promise<number> {
  const rows = await tx
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1)
  const raw = (rows[0]?.settings as { importFileSizeLimitMb?: unknown } | undefined)
    ?.importFileSizeLimitMb
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : IMPORT_FILE_SIZE_LIMIT_MB_DEFAULT
}

async function ownUpload(
  deps: ImportUploadDeps,
  orgId: string,
  userId: string,
  id: string,
): Promise<ImportUpload> {
  const rows = await deps.privileged("imports:upload-load", (tx) =>
    tx
      .select()
      .from(importUploads)
      .where(
        and(
          eq(importUploads.id, id),
          eq(importUploads.orgId, orgId),
          eq(importUploads.createdBy, userId),
        ),
      )
      .limit(1),
  )
  const row = rows[0]
  if (!row) throw new ImportUploadError("NOT_FOUND", "No such import upload.")
  return row
}

/** The exact size of one part: the part size, the remainder for the last one. */
function partLength(row: ImportUpload, partNumber: number): number {
  const count = multipartPartCount(row.size, row.partSize)
  return partNumber < count ? row.partSize : row.size - (count - 1) * row.partSize
}

async function signParts(
  row: ImportUpload,
  partNumbers: number[],
  storage?: ObjectStorageDeps,
): Promise<Array<{ partNumber: number; url: string }>> {
  if (!row.uploadId) return []
  const uploadId = row.uploadId
  try {
    return await Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await presignUploadPart(
          {
            key: row.storageKey,
            uploadId,
            partNumber,
            contentLength: partLength(row, partNumber),
            expiresInSec: PART_URL_TTL_SECONDS,
          },
          storage,
        ),
      })),
    )
  } catch (err) {
    log.warn({ err, uploadId: row.id }, "import upload: part presign failed")
    throw new ImportUploadError("STORAGE_UNAVAILABLE", "Object storage is unreachable.")
  }
}

export async function createImportUpload(
  input: { orgId: string; userId: string; filename: string; mimeType: string; size: number },
  deps: ImportUploadDeps,
): Promise<CreateImportUploadResult> {
  if (!Number.isSafeInteger(input.size) || input.size <= 0) {
    throw new ImportUploadError("INVALID_REQUEST", "size must be a positive number of bytes.")
  }
  const mimeType = MIME_RE.test(input.mimeType)
    ? input.mimeType.toLowerCase()
    : "application/octet-stream"
  const filename = sanitizeFilename(input.filename)
  const { importLimitMb, settings } = await deps.privileged(
    "imports:upload-limits",
    async (tx) => ({
      importLimitMb: await loadImportFileSizeLimitMb(tx, input.orgId),
      settings: await loadOrgSettings(tx, input.orgId),
    }),
  )
  if (input.size > importLimitMb * 1024 * 1024) {
    throw new ImportUploadError(
      "IMPORT_FILE_TOO_LARGE",
      `The file is larger than this organization's import limit of ${importLimitMb} MB (organization setting importFileSizeLimitMb).`,
    )
  }
  // Open uploads reserve their declared size: the bytes are not stored yet,
  // so the quota alone would let several large uploads start at once. The
  // per-org lock is taken in the request transaction that inserts the row and
  // held until it commits, so a concurrent create sums after this row exists.
  await deps.rlsTx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`import-upload-quota:${input.orgId}`}))`,
  )
  const overQuota =
    orgQuotaBytes(settings) !== null &&
    (await deps.privileged("imports:upload-quota", async (tx) => {
      const [open] = await tx
        .select({ bytes: sum(importUploads.size) })
        .from(importUploads)
        .where(
          and(
            eq(importUploads.orgId, input.orgId),
            eq(importUploads.status, "uploading"),
            gt(importUploads.expiresAt, new Date()),
          ),
        )
      const reserved = Number(open?.bytes ?? 0)
      return wouldExceedOrgQuota(tx, input.orgId, settings, input.size + reserved)
    }))
  await deps.afterQuotaCheck?.()
  if (overQuota) {
    throw new ImportUploadError(
      "STORAGE_QUOTA_EXCEEDED",
      "The organization's storage quota would be exceeded.",
    )
  }

  const mode = deps.delivery ?? storageDelivery({ sealed: false })
  if (mode === "relay") {
    if (input.size > settings.fileSizeLimitMb * 1024 * 1024) {
      throw new ImportUploadError(
        "RELAY_FILE_TOO_LARGE",
        `This server relays uploads through the API, which takes files up to the organization setting fileSizeLimitMb (${settings.fileSizeLimitMb} MB). Larger import files need direct uploads to object storage (OBJECT_STORAGE_BROWSER_DIRECT=true and the bucket's CORS rule exposing ETag).`,
      )
    }
    let authorized: Awaited<ReturnType<typeof authorizeAgentUpload>>
    try {
      authorized = await authorizeAgentUpload(
        { orgId: input.orgId, userId: input.userId, filename, mimeType, sizeBytes: input.size },
        { rlsTx: deps.rlsTx, privileged: deps.privileged, delivery: "relay" },
      )
    } catch (err) {
      if (err instanceof FileServiceError)
        throw new ImportUploadError("INVALID_REQUEST", err.message)
      throw err
    }
    // Same transaction as the upload session (not yet committed): the RLS
    // insert policy lets the owner create their own row.
    const [row] = await deps.rlsTx
      .insert(importUploads)
      .values({
        orgId: input.orgId,
        createdBy: input.userId,
        sessionId: authorized.sessionId,
        filename,
        mimeType,
        storageKey: authorized.storageKey,
        mode: "relay",
        size: input.size,
      })
      .returning()
    return { ...view(row as ImportUpload), uploadUrl: authorized.uploadUrl }
  }

  const [session] = await deps.rlsTx
    .insert(fileUploadSessions)
    .values({
      orgId: input.orgId,
      createdBy: input.userId,
      targetApp: IMPORT_UPLOAD_SESSION_TARGET.app,
      targetEntityType: IMPORT_UPLOAD_SESSION_TARGET.entityType,
    })
    .returning({ id: fileUploadSessions.id })
  if (!session)
    throw new ImportUploadError("STORAGE_UNAVAILABLE", "Failed to open an upload session.")
  const storageKey = buildStorageKey({
    orgId: input.orgId,
    app: "kernel",
    entityType: "file_upload_session",
    entityId: session.id,
    filename,
  })
  const partSize = multipartPartSize(input.size)
  let uploadId: string
  try {
    uploadId = await createMultipartUpload({ key: storageKey, contentType: mimeType }, deps.storage)
  } catch (err) {
    log.warn({ err }, "import upload: CreateMultipartUpload failed")
    throw new ImportUploadError("STORAGE_UNAVAILABLE", "Object storage is unreachable.")
  }
  let created: ImportUpload
  try {
    const [row] = await deps.rlsTx
      .insert(importUploads)
      .values({
        orgId: input.orgId,
        createdBy: input.userId,
        sessionId: session.id,
        filename,
        mimeType,
        storageKey,
        mode: "multipart",
        uploadId,
        partSize,
        size: input.size,
      })
      .returning()
    created = row as ImportUpload
  } catch (err) {
    // No row will ever point at the store's upload: abort it now, not at the reaper.
    await abortMultipartUpload({ key: storageKey, uploadId }, deps.storage).catch(() => undefined)
    throw err
  }
  const count = multipartPartCount(input.size, partSize)
  const first = Array.from({ length: Math.min(count, IMPORT_SIGN_BATCH) }, (_, i) => i + 1)
  try {
    return { ...view(created), parts: await signParts(created, first, deps.storage) }
  } catch (err) {
    // The request fails and its transaction (and the row) rolls back: abort the
    // store's upload too, so nothing is left that no row points at.
    await abortMultipartUpload({ key: storageKey, uploadId }, deps.storage).catch(() => undefined)
    throw err
  }
}

export interface ImportUploadState extends ImportUploadView {
  received: Array<{ partNumber: number; size: number }>
  missing: number[]
}

/** The upload and, while it is open, the parts the store holds and those still missing. */
export async function getImportUpload(
  input: { orgId: string; userId: string; id: string },
  deps: ImportUploadDeps,
): Promise<ImportUploadState> {
  const row = await ownUpload(deps, input.orgId, input.userId, input.id)
  const v = view(row)
  if (row.status !== "uploading" || row.mode !== "multipart" || !row.uploadId) {
    return { ...v, received: [], missing: [] }
  }
  let parts: Awaited<ReturnType<typeof listUploadedParts>>
  try {
    parts = await listUploadedParts({ key: row.storageKey, uploadId: row.uploadId }, deps.storage)
  } catch (err) {
    log.warn({ err, uploadId: row.id }, "import upload: ListParts failed")
    throw new ImportUploadError("STORAGE_UNAVAILABLE", "Object storage is unreachable.")
  }
  const have = new Set(parts.map((p) => p.partNumber))
  const missing: number[] = []
  for (let n = 1; n <= v.partCount; n++) if (!have.has(n)) missing.push(n)
  return { ...v, received: parts.map((p) => ({ partNumber: p.partNumber, size: p.size })), missing }
}

export async function signImportUploadParts(
  input: { orgId: string; userId: string; id: string; partNumbers: number[] },
  deps: ImportUploadDeps,
): Promise<Array<{ partNumber: number; url: string }>> {
  const row = await ownUpload(deps, input.orgId, input.userId, input.id)
  if (row.status !== "uploading" || row.mode !== "multipart") {
    throw new ImportUploadError("NOT_OPEN", "This upload is not open for parts.")
  }
  const count = multipartPartCount(row.size, row.partSize)
  const wanted = [...new Set(input.partNumbers)]
  if (wanted.length === 0 || wanted.length > IMPORT_SIGN_BATCH) {
    throw new ImportUploadError(
      "INVALID_REQUEST",
      `Ask for 1 to ${IMPORT_SIGN_BATCH} part numbers.`,
    )
  }
  if (wanted.some((n) => !Number.isInteger(n) || n < 1 || n > count)) {
    throw new ImportUploadError("INVALID_REQUEST", `Part numbers run from 1 to ${count}.`)
  }
  // A client still sending parts keeps its upload alive past the reaper's 24 hours.
  await deps.privileged("imports:upload-extend", (tx) =>
    tx
      .update(importUploads)
      .set({ expiresAt: new Date(Date.now() + UPLOAD_TTL_MS) })
      .where(and(eq(importUploads.id, row.id), eq(importUploads.status, "uploading"))),
  )
  return signParts(
    row,
    wanted.sort((a, b) => a - b),
    deps.storage,
  )
}

/** Finish the upload: the stored object becomes a kernel.files row the uploader owns. */
export async function completeImportUpload(
  input: { orgId: string; userId: string; id: string },
  deps: ImportUploadDeps,
): Promise<ImportUploadView> {
  const row = await ownUpload(deps, input.orgId, input.userId, input.id)
  if (row.status === "complete") return view(row)
  if (row.status !== "uploading")
    throw new ImportUploadError("NOT_OPEN", "This upload was aborted.")
  if (!row.sessionId) throw new ImportUploadError("NOT_OPEN", "This upload's session is gone.")

  if (row.mode === "multipart" && row.uploadId) {
    const state = await getImportUpload(input, deps)
    if (state.missing.length > 0) {
      throw new ImportUploadError(
        "PARTS_MISSING",
        `Parts still missing: ${state.missing.slice(0, 20).join(", ")}${state.missing.length > 20 ? ` and ${state.missing.length - 20} more` : ""}.`,
      )
    }
    const parts = await listUploadedParts(
      { key: row.storageKey, uploadId: row.uploadId },
      deps.storage,
    )
    const total = parts.reduce((s, p) => s + p.size, 0)
    if (total !== row.size) {
      throw new ImportUploadError(
        "PARTS_MISSING",
        `The parts hold ${total} bytes; the upload declared ${row.size}.`,
      )
    }
    try {
      await completeMultipartUpload(
        { key: row.storageKey, uploadId: row.uploadId, parts },
        deps.storage,
      )
    } catch (err) {
      log.warn({ err, uploadId: row.id }, "import upload: CompleteMultipartUpload failed")
      throw new ImportUploadError(
        "STORAGE_UNAVAILABLE",
        "Object storage could not complete the upload.",
      )
    }
  }

  const token = await signFileToken({
    orgId: row.orgId,
    userId: row.createdBy,
    app: "kernel",
    entityType: "file_upload_session",
    entityId: row.sessionId,
    storageKey: row.storageKey,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.size,
  })
  let fileId: string
  try {
    const confirmed = await confirmUpload(token, {
      callerOrgId: input.orgId,
      privileged: deps.privileged,
    })
    fileId = confirmed.id
  } catch (err) {
    if (err instanceof FileServiceError) {
      if (err.code === "FILE_VERIFY_FAILED") {
        await deps.privileged("imports:upload-refused", (tx) =>
          tx.update(importUploads).set({ status: "aborted" }).where(eq(importUploads.id, row.id)),
        )
      }
      throw new ImportUploadError(
        err.code === "STORAGE_QUOTA_EXCEEDED" ? "STORAGE_QUOTA_EXCEEDED" : "FILE_VERIFY_FAILED",
        err.message,
      )
    }
    throw err
  }
  const [done] = await deps.privileged("imports:upload-complete", (tx) =>
    tx
      .update(importUploads)
      .set({ status: "complete", fileId, completedAt: new Date() })
      .where(and(eq(importUploads.id, row.id), eq(importUploads.status, "uploading")))
      .returning(),
  )
  if (done) return view(done)
  // A concurrent complete or abort got there first: report what it left.
  const current = await ownUpload(deps, input.orgId, input.userId, input.id)
  if (current.status === "complete") return view(current)
  throw new ImportUploadError("NOT_OPEN", "This upload was aborted.")
}

export async function abortImportUpload(
  input: { orgId: string; userId: string; id: string },
  deps: ImportUploadDeps,
): Promise<ImportUploadView> {
  const row = await ownUpload(deps, input.orgId, input.userId, input.id)
  if (row.status !== "uploading") return view(row)
  if (row.mode === "multipart" && row.uploadId) {
    try {
      await abortMultipartUpload({ key: row.storageKey, uploadId: row.uploadId }, deps.storage)
    } catch (err) {
      log.warn({ err, uploadId: row.id }, "import upload: AbortMultipartUpload failed")
      throw new ImportUploadError("STORAGE_UNAVAILABLE", "Object storage is unreachable.")
    }
  }
  const [done] = await deps.privileged("imports:upload-abort", (tx) =>
    tx
      .update(importUploads)
      .set({ status: "aborted" })
      .where(eq(importUploads.id, row.id))
      .returning(),
  )
  return view(done as ImportUpload)
}

/**
 * Abort every upload still open past its expiry (24 hours), across orgs.
 * Returns how many were aborted. A store error on one upload leaves it for the
 * next pass.
 */
export async function reapExpiredImportUploads(
  opts: { now?: Date; limit?: number; storage?: ObjectStorageDeps } = {},
): Promise<{ aborted: number; failed: number }> {
  const now = opts.now ?? new Date()
  // An org being moved keeps its uploads as they are until the move ends.
  const rows = await sweepSkippingMoving((notMoving) =>
    withSystemDb("imports:upload-reaper:list", (tx) =>
      tx
        .select()
        .from(importUploads)
        .where(
          and(
            eq(importUploads.status, "uploading"),
            lt(importUploads.expiresAt, now),
            notMoving(importUploads.orgId),
          ),
        )
        .limit(opts.limit ?? 500),
    ),
  )
  let aborted = 0
  let failed = 0
  for (const row of rows) {
    try {
      const marked = await writeUnlessMoving(row.orgId, async () => {
        if (row.mode === "multipart" && row.uploadId) {
          await abortMultipartUpload({ key: row.storageKey, uploadId: row.uploadId }, opts.storage)
        }
        await withSystemDb("imports:upload-reaper:mark", (tx) =>
          tx
            .update(importUploads)
            .set({ status: "aborted" })
            .where(and(eq(importUploads.id, row.id), eq(importUploads.status, "uploading"))),
        )
      })
      if (marked === SKIPPED_MOVING) continue
      aborted++
    } catch (err) {
      failed++
      log.warn({ err, uploadId: row.id, orgId: row.orgId }, "import upload reaper: abort failed")
    }
  }
  if (aborted > 0 || failed > 0) log.info({ aborted, failed }, "import upload reaper pass")
  return { aborted, failed }
}
