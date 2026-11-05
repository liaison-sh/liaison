// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host-side PDF merge. Loads several `kernel.files` PDFs the caller can see
// (RLS-scoped, same access path as files_read / files_list), concatenates their
// pages in order (duplicates allowed and meaningful — the operator flow merges
// the same customs invoice several times), and persists the result as a new
// `kernel.files` row staged in a caller-owned upload session. The staged file is
// RLS-visible to its owner, so it downloads via files_read and attaches to any
// reply exactly like a human's staged upload.

import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { degrees, PDFDocument } from "pdf-lib"
import type { RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { files } from "~/db/schema/kernel/files"
import { schemaRef } from "~/db/schema-ref"
import {
  getObjectBuffer as defaultGetObjectBuffer,
  putObject as defaultPutObject,
} from "~/infra/storage/object-storage"
import { pdfLogger as log } from "~/lib/logger"
import { buildStorageKey, loadOrgSettings, wouldExceedOrgQuota } from "~/modules/files/service"

const K = sql.raw(schemaRef("kernel"))

/** Total input bytes across all (deduped-by-fetch, but counted per reference) files. */
export const MERGE_MAX_TOTAL_INPUT_BYTES = 50 * 1024 * 1024
/** Page ceiling for the merged output. */
export const MERGE_MAX_OUTPUT_PAGES = 500

export type MergePdfsErrorCode =
  | "too_few_files"
  | "too_many_files"
  | "file_not_found"
  | "not_a_pdf"
  | "input_too_large"
  | "too_many_pages"
  | "merge_failed"
  | "storage_quota_exceeded"

/** Carries a stable `code` so the tool bridge surfaces a typed error, not a 500. */
export class MergePdfsError extends Error {
  readonly code: MergePdfsErrorCode
  constructor(code: MergePdfsErrorCode, message?: string) {
    super(message ?? code)
    this.code = code
    this.name = "MergePdfsError"
  }
}

// A UNARY merge (one file) is a deliberate, supported use: it re-serializes the
// PDF through the same pipeline, whose rotation baking turns a page-level
// /Rotate flag into upright content — the orientation-normalization path the
// boxtal print pack uses on carrier labels (Letter landscape /Rotate 270).
const MIN_FILES = 1
const MAX_FILES = 20
const PDF_MAGIC = "%PDF-"

/** Ensure a caller-supplied title ends in a single `.pdf` (case-insensitive). */
export function normalizeMergedTitle(raw: string | undefined): string {
  const trimmed = (raw ?? "").trim()
  const base = trimmed.length > 0 ? trimmed : "merged.pdf"
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`
}

export function looksLikePdf(mimeType: string, bytes: Uint8Array): boolean {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase()
  if (mime === "application/pdf") return true
  // Fall back to the magic number — a mis-typed but genuine PDF still merges.
  const head = Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString("latin1")
  return head === PDF_MAGIC
}

interface SourcePdfRow {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  storageKey: string
}

export interface MergePdfsInput {
  fileIds: string[]
  title?: string
}

export interface MergePdfsResult {
  file_id: string
  byte_size: number
  page_count: number
  title: string
}

export interface MergePdfsDeps {
  /** Caller-scoped RLS client — gates which source files are visible + owns the staging session. */
  rlsTx: RlsClient
  orgId: string
  userId: string
  getObjectBuffer?: typeof defaultGetObjectBuffer
  putObject?: typeof defaultPutObject
}

/**
 * Merge the given PDF file ids into one new PDF file. Preserves input order
 * exactly, including repeats. Every source is loaded under the caller's RLS
 * context — a file the caller cannot see (or that does not exist) is a typed
 * `file_not_found` naming the offending id, never a silent skip.
 */
export async function mergePdfs(
  input: MergePdfsInput,
  deps: MergePdfsDeps,
): Promise<MergePdfsResult> {
  const { fileIds } = input
  if (fileIds.length < MIN_FILES) {
    throw new MergePdfsError("too_few_files", `Need at least ${MIN_FILES} files to merge`)
  }
  if (fileIds.length > MAX_FILES) {
    throw new MergePdfsError("too_many_files", `Cannot merge more than ${MAX_FILES} files at once`)
  }

  const title = normalizeMergedTitle(input.title)
  const getObjectBuffer = deps.getObjectBuffer ?? defaultGetObjectBuffer

  // Resolve each DISTINCT id once under the caller's RLS context — a file the
  // caller cannot see is absent from the row set and reported by id below.
  const distinctIds = [...new Set(fileIds)]
  const idList = sql.join(
    distinctIds.map((id) => sql`${id}`),
    sql`, `,
  )
  const rows = (await deps.rlsTx.execute<Record<string, unknown>>(
    sql`SELECT id::text AS id, filename, mime_type AS "mimeType",
               size_bytes AS "sizeBytes", storage_key AS "storageKey"
        FROM ${K}.files
        WHERE id::text IN (${idList}) AND org_id = ${deps.orgId}`,
  )) as unknown as SourcePdfRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = distinctIds.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new MergePdfsError(
      "file_not_found",
      `File(s) not found or not accessible: ${missing.join(", ")}`,
    )
  }

  // Total input size is the SUM OVER REFERENCES (a file listed 3x counts 3x),
  // matching the byte volume actually copied into the output.
  const totalInputBytes = fileIds.reduce((sum, id) => sum + Number(byId.get(id)?.sizeBytes ?? 0), 0)
  if (totalInputBytes > MERGE_MAX_TOTAL_INPUT_BYTES) {
    throw new MergePdfsError(
      "input_too_large",
      `Total input ${totalInputBytes} bytes exceeds ${MERGE_MAX_TOTAL_INPUT_BYTES} byte cap`,
    )
  }

  // Fetch + validate each distinct source ONCE; reuse its parsed document for
  // repeated references so an invoice merged 3x is read + parsed a single time.
  const parsedById = new Map<string, PDFDocument>()
  for (const id of distinctIds) {
    const row = byId.get(id)
    if (!row) continue
    const buf = await getObjectBuffer(row.storageKey)
    const bytes = new Uint8Array(buf)
    if (!looksLikePdf(row.mimeType, bytes)) {
      throw new MergePdfsError(
        "not_a_pdf",
        `File ${id} (${row.filename}) is not a PDF (mime ${row.mimeType})`,
      )
    }
    try {
      parsedById.set(id, await PDFDocument.load(bytes, { ignoreEncryption: true }))
    } catch (err) {
      log.warn({ err, fileId: id, orgId: deps.orgId }, "pdf merge: source parse failed")
      throw new MergePdfsError("not_a_pdf", `File ${id} (${row.filename}) is not a readable PDF`)
    }
  }

  // Bound the output page count before copying anything.
  const totalPages = fileIds.reduce((sum, id) => sum + (parsedById.get(id)?.getPageCount() ?? 0), 0)
  if (totalPages > MERGE_MAX_OUTPUT_PAGES) {
    throw new MergePdfsError(
      "too_many_pages",
      `Merged output has ${totalPages} pages (cap ${MERGE_MAX_OUTPUT_PAGES})`,
    )
  }

  let bytes: Uint8Array
  let pageCount: number
  try {
    const out = await PDFDocument.create()
    for (const id of fileIds) {
      const src = parsedById.get(id)
      if (!src) continue
      const indices = src.getPageIndices()
      const copied = await out.copyPages(src, indices)
      for (let i = 0; i < copied.length; i++) {
        const page = copied[i]!
        const angle = ((page.getRotation().angle % 360) + 360) % 360
        if (angle === 0) {
          out.addPage(page)
          continue
        }
        // BAKE the source page's /Rotate into the content instead of carrying
        // the flag: viewers honor /Rotate but print pipelines and extractors
        // frequently do not on mixed-orientation documents, so a rotated
        // carrier label merged after portrait invoices printed sideways
        // (prod, 2026-07-20). Embed the page and draw it rotated onto a fresh
        // page with the corrected dimensions; the output carries upright
        // pages only (/Rotate 0 everywhere). Annotations are flattened by
        // embedding, which is fine for print-oriented packs.
        const srcPage = src.getPage(indices[i]!)
        // A page without a content stream cannot be embedded (pdf-lib throws
        // "missing Contents") — keep it as-is with its flag rather than
        // failing the whole merge; a blank page has nothing to mis-rotate.
        let emb: Awaited<ReturnType<typeof out.embedPage>>
        try {
          emb = await out.embedPage(srcPage)
        } catch {
          out.addPage(page)
          continue
        }
        const { width: w, height: h } = srcPage.getSize()
        if (angle === 180) {
          out.addPage([w, h]).drawPage(emb, { x: w, y: h, rotate: degrees(180) })
        } else if (angle === 90) {
          // /Rotate 90: displayed by rotating the content 90 clockwise.
          out.addPage([h, w]).drawPage(emb, { x: 0, y: w, rotate: degrees(-90) })
        } else {
          // /Rotate 270: displayed by rotating the content 90 counter-clockwise.
          out.addPage([h, w]).drawPage(emb, { x: h, y: 0, rotate: degrees(90) })
        }
      }
    }
    out.setTitle(title)
    pageCount = out.getPageCount()
    bytes = await out.save({ useObjectStreams: false })
  } catch (err) {
    log.error({ err, orgId: deps.orgId }, "pdf merge: assembly failed")
    throw new MergePdfsError("merge_failed", "Failed to assemble merged PDF")
  }

  // Stage the result in a caller-owned upload session. A session-parented file
  // is RLS-visible ONLY to its owner (file_upload_sessions_owner policy), so the
  // caller can download it via files_read and attach it to any reply through the
  // standard session-staging attach path — identical to a human's staged upload.
  const sessionRows = (await deps.rlsTx.execute<{ id: string }>(
    sql`INSERT INTO ${K}.file_upload_sessions (org_id, created_by, target_app, target_entity_type)
        VALUES (${deps.orgId}, ${deps.userId}, 'kernel', 'merged_pdf')
        RETURNING id::text AS id`,
  )) as unknown as { id: string }[]
  const sessionId = sessionRows[0]?.id
  if (!sessionId) {
    throw new MergePdfsError("merge_failed", "Failed to create staging session for merged PDF")
  }

  // The merged file counts toward the org's storage, like an upload: refused
  // before any byte is stored when it would go past the operator's cap.
  const full = await withPrivilegedDb(deps.orgId, "pdf:merge-quota", async (tx) =>
    wouldExceedOrgQuota(tx, deps.orgId, await loadOrgSettings(tx, deps.orgId), bytes.byteLength),
  )
  if (full) {
    throw new MergePdfsError(
      "storage_quota_exceeded",
      "The organization's storage limit is reached; the merged PDF was not saved",
    )
  }

  const fileId = randomUUID()
  const storageKey = buildStorageKey({
    orgId: deps.orgId,
    app: "kernel",
    entityType: "file_upload_session",
    entityId: sessionId,
    filename: title,
  })
  const put = deps.putObject ?? defaultPutObject
  await put({ key: storageKey, body: bytes, contentType: "application/pdf" })

  await withPrivilegedDb(deps.orgId, "pdf:merge-insert", async (tx) => {
    await tx.insert(files).values({
      id: fileId,
      orgId: deps.orgId,
      app: "kernel",
      entityType: "file_upload_session",
      entityId: sessionId,
      filename: title,
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      storageKey,
      uploadedBy: deps.userId,
      disposition: "attachment",
    })
  })

  return {
    file_id: fileId,
    byte_size: bytes.byteLength,
    page_count: pageCount,
    title,
  }
}
