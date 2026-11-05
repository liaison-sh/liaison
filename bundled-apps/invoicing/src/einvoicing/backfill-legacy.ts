// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `einvoicing_backfill_legacy_originals`: every imported legacy document's legal original is the
// PDF the importer stored, never anything the app rendered. This records it: a `legacy_import`
// legal-original row carrying the SHA-256 and size of the imported file and its own copy of the
// bytes (on the row's fileParent), and the document's `legal_original_id` /
// `legal_original_sha256`. A document whose `pdf_file_id` a later re-render replaced is pointed
// back at the imported file (lifecycle `legal_original_restored`).
//
// The imported file is `external_refs.import_file_id` (stamped by the migration from the
// importer's own file row), else the document's current `pdf_file_id`. Bytes travel through the
// file bridge, which caps a call's reads and writes, so a call works in a batch: at most `limit`
// documents and, past the first, no more than `max_bytes` read. `remaining` says what is left.
// `dry_run` (the default) reports the batch without reading or writing anything. Idempotent: a
// document with a legal original is never selected again. A document whose imported file could not
// be read is set aside: the failure is recorded on its `external_refs` against that file id, so the
// next batch moves past it and `remaining` only counts what a run can still progress; `set_aside`
// counts them, and `retry_failed` takes them again (a marker against another file never applies).
import { sha256OfBase64 } from "./backfill-sha256"

type Row = Record<string, unknown>

export interface LegacyBackfillCtx {
  db: {
    findMany(
      entity: string,
      opts?: {
        where?: Record<string, unknown>
        orderBy?: Record<string, "asc" | "desc">
        limit?: number
        offset?: number
        select?: string[]
      },
    ): Promise<unknown[]>
    insert(entity: string, data: Record<string, unknown>): Promise<unknown>
    update(entity: string, id: string, data: Record<string, unknown>): Promise<unknown>
  }
  getUserId?(): Promise<string>
  files_getAttachmentBytes?(argsJson: string): Promise<string>
  files_importAttachment?(argsJson: string): Promise<string>
}

export const LEGACY_DEFAULT_LIMIT = 10
export const LEGACY_MAX_LIMIT = 50
export const LEGACY_DEFAULT_MAX_BYTES = 5_000_000
/** The file bridge allows 35 MB of reads per call; a batch reads at most max_bytes plus one file
 *  (25 MB per-call cap), so max_bytes stays at or under 10 MB. */
export const LEGACY_MAX_MAX_BYTES = 10_000_000
const SCAN_PAGE = 500

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}

function refsOf(v: unknown): Row {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Row
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v) as unknown
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Row
    } catch {
      // not JSON
    }
  }
  return {}
}

function logOf(v: unknown): Row[] {
  if (Array.isArray(v)) return v as Row[]
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v) as unknown
      if (Array.isArray(p)) return p as Row[]
    } catch {
      // not JSON
    }
  }
  return []
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err
  const e = err as { message?: unknown; code?: unknown } | null
  if (e && typeof e.message === "string" && e.message) return e.message
  try {
    return JSON.stringify(err) ?? "unreadable"
  } catch {
    return String(err)
  }
}

function clampInt(v: unknown, def: number, max: number): number {
  const n = Number(v ?? def)
  return Math.min(max, Math.max(1, Number.isFinite(n) ? Math.floor(n) : def))
}

/** The `external_refs` key recording a failed backfill attempt: `{ file_id, error, at }`. */
export const LEGACY_FAILURE_KEY = "legal_original_backfill_failure"

interface Candidate {
  id: string
  number: string | null
  sourceFileId: string | null
  currentFileId: string | null
  refs: Row
  /** A failure is recorded against the file this run would read again. */
  setAside: boolean
}

/** True when the recorded failure was against `sourceFileId` (null included): a changed file retries. */
function failedOn(refs: Row, sourceFileId: string | null): boolean {
  const f = refs[LEGACY_FAILURE_KEY]
  if (!f || typeof f !== "object" || Array.isArray(f)) return false
  return str((f as Row).file_id) === sourceFileId
}

/** Imported documents without a legal original yet, in id order. */
async function candidates(ctx: LegacyBackfillCtx): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (let offset = 0; ; offset += SCAN_PAGE) {
    const page = (await ctx.db.findMany("documents", {
      where: { legal_original_id: null },
      orderBy: { id: "asc" },
      select: ["id", "number", "pdf_file_id", "external_refs"],
      limit: SCAN_PAGE,
      offset,
    })) as Row[]
    for (const d of page) {
      const refs = refsOf(d.external_refs)
      if (!str(refs.import_source)) continue
      const current = str(d.pdf_file_id)
      const sourceFileId = str(refs.import_file_id) ?? current
      out.push({
        id: String(d.id),
        number: str(d.number),
        sourceFileId,
        currentFileId: current,
        refs,
        setAside: failedOn(refs, sourceFileId),
      })
    }
    if (page.length < SCAN_PAGE) break
  }
  return out
}

export async function backfillLegacyOriginals(
  ctx: LegacyBackfillCtx,
  input: {
    dry_run?: boolean | null
    max_bytes?: number | null
    limit?: number | null
    retry_failed?: boolean | null
  } = {},
): Promise<Row> {
  const dryRun = input?.dry_run !== false
  const retryFailed = input?.retry_failed === true
  const limit = clampInt(input?.limit, LEGACY_DEFAULT_LIMIT, LEGACY_MAX_LIMIT)
  const maxBytes = clampInt(input?.max_bytes, LEGACY_DEFAULT_MAX_BYTES, LEGACY_MAX_MAX_BYTES)
  const found = await candidates(ctx)
  const all = retryFailed ? found : found.filter((c) => !c.setAside)
  const batch = all.slice(0, limit)

  if (dryRun) {
    const inBatch = new Set(batch.map((c) => c.id))
    const setAsideBefore = found.filter((c) => c.setAside && !inBatch.has(c.id)).length
    const repointed = batch.filter((c) => c.sourceFileId && c.sourceFileId !== c.currentFileId).length
    return {
      status: "ok",
      dry_run: true,
      limit,
      max_bytes: maxBytes,
      processed: batch.length,
      repointed,
      remaining: all.length - batch.length,
      set_aside: setAsideBefore,
      bytes: 0,
      message:
        `Dry run, nothing written: ${batch.length} imported document(s) in this batch` +
        (repointed ? `, ${repointed} of them re-rendered over and to be restored` : "") +
        `; ${all.length - batch.length} more after it` +
        (setAsideBefore ? `; ${setAsideBefore} set aside after a failed read (retry_failed: true takes them again).` : "."),
    }
  }

  if (!ctx.files_getAttachmentBytes || !ctx.files_importAttachment) {
    return { status: "error", error: { code: "unsupported", message: "The file bridge is not available in this runtime." } }
  }
  const recordedBy = ctx.getUserId ? await ctx.getUserId() : null
  let processed = 0
  let repointed = 0
  let bytes = 0
  const failed: Array<{ document_id: string; number: string | null; error: string }> = []
  const items: Array<Row> = []
  // Record the failure on the document, against the file that failed, so the next batch pages past it.
  const fail = async (c: Candidate, error: string) => {
    failed.push({ document_id: c.id, number: c.number, error })
    await ctx.db.update("documents", c.id, {
      external_refs: {
        ...c.refs,
        [LEGACY_FAILURE_KEY]: { file_id: c.sourceFileId, error, at: new Date().toISOString() },
      },
    })
  }

  for (const c of batch) {
    if (!c.sourceFileId) {
      await fail(c, "imported_original_missing")
      continue
    }
    const isRepointed = c.sourceFileId !== c.currentFileId
    // Point the document back at the imported file FIRST: the file is readable only through the
    // document that references it (its `pdf` fileParent joins documents.pdf_file_id).
    if (isRepointed) await ctx.db.update("documents", c.id, { pdf_file_id: c.sourceFileId, pdf_status: "ready" })
    const undo = async () => {
      if (isRepointed) await ctx.db.update("documents", c.id, { pdf_file_id: c.currentFileId })
    }
    let file: { filename?: string; mimeType?: string; bytesBase64?: string }
    try {
      file = JSON.parse(
        await ctx.files_getAttachmentBytes(
          JSON.stringify({
            fileId: c.sourceFileId,
            allowedParents: [{ app: "invoicing", entityType: "pdf", entityId: c.sourceFileId }],
          }),
        ),
      ) as typeof file
    } catch (err) {
      await undo()
      await fail(c, errorText(err))
      continue
    }
    const b64 = file.bytesBase64 ?? ""
    // Hashed while decoded: the sandbox has no typed arrays, and a byte array of a large file
    // would not fit its memory.
    const { sha256, byteLength } = sha256OfBase64(b64)
    if (processed > 0 && bytes + byteLength > maxBytes) {
      await undo()
      break
    }
    // A batch cut off mid-document (a request timeout) can leave this document's legal-original
    // row written but the document not yet pointed at it. Resume from that row instead of inserting
    // a second one: the same bytes finish the record; different bytes are a conflict for a person.
    const prior = ((await ctx.db.findMany("legal_originals", {
      where: { document_id: c.id, kind: "legacy_import" },
      limit: 1,
    })) as Row[])[0]
    if (prior && str(prior.sha256) !== sha256) {
      await undo()
      await fail(c, `legal_original_conflict: a recorded legacy original has sha256 ${str(prior.sha256)}, the imported file ${sha256}`)
      continue
    }
    const row =
      prior ??
      ((await ctx.db.insert("legal_originals", {
        document_id: c.id,
        kind: "legacy_import",
        file_id: null,
        sha256,
        byte_size: byteLength,
        recorded_at: new Date().toISOString(),
        recorded_by: recordedBy,
      })) as Row)
    const rowId = String(row.id)
    if (!str(row.file_id)) {
      const copy = JSON.parse(
        await ctx.files_importAttachment(
          JSON.stringify({
            targetApp: "invoicing",
            targetEntityType: "legal_original",
            targetEntityId: rowId,
            filename: file.filename ?? `${c.number ?? c.id}.pdf`,
            mimeType: file.mimeType ?? "application/pdf",
            bytesBase64: b64,
          }),
        ),
      ) as { id: string }
      await ctx.db.update("legal_originals", rowId, { file_id: copy.id })
    }

    const docUpdate: Row = { legal_original_id: rowId, legal_original_sha256: sha256 }
    if (LEGACY_FAILURE_KEY in c.refs) {
      const { [LEGACY_FAILURE_KEY]: _cleared, ...rest } = c.refs
      docUpdate.external_refs = rest
    }
    if (isRepointed) {
      const docRow = ((await ctx.db.findMany("documents", { where: { id: c.id }, limit: 1 })) as Row[])[0]
      docUpdate.lifecycle_log = [
        ...logOf(docRow?.lifecycle_log),
        {
          ts: new Date().toISOString(),
          event: "legal_original_restored",
          from_file_id: c.currentFileId,
          to_file_id: c.sourceFileId,
          sha256,
        },
      ]
    }
    await ctx.db.update("documents", c.id, docUpdate)
    processed += 1
    bytes += byteLength
    if (isRepointed) repointed += 1
    items.push({ document_id: c.id, number: c.number, sha256, byte_size: byteLength, repointed: isRepointed })
  }

  // A document that failed in this run is set aside too: it no longer counts as remaining.
  const done = new Set(items.map((i) => String(i.document_id)))
  const failedIds = new Set(failed.map((f) => f.document_id))
  const open = found.filter((c) => !done.has(c.id))
  const remaining = open.filter((c) => !failedIds.has(c.id) && !c.setAside).length
  const setAside = open.filter((c) => failedIds.has(c.id) || c.setAside).length
  return {
    status: "ok",
    dry_run: false,
    limit,
    max_bytes: maxBytes,
    processed,
    repointed,
    remaining,
    set_aside: setAside,
    bytes,
    items,
    failed,
    message:
      `Recorded the legal original of ${processed} imported document(s) (${bytes} bytes)` +
      (repointed ? `, restored ${repointed} whose PDF had been replaced` : "") +
      (failed.length ? `; ${failed.length} could not be read and were set aside` : "") +
      (remaining ? `. ${remaining} remain: run again.` : ". None remain.") +
      (setAside ? ` ${setAside} set aside after a failed read: retry_failed: true takes them again.` : ""),
  }
}
