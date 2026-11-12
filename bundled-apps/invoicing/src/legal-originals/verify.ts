// SPDX-License-Identifier: FSL-1.1-ALv2
//
// legal_originals_verify — recompute the SHA-256 of stored legal originals and compare it with the
// hash recorded when each was fixed. Read only. Bytes are read through the file bridge (bounded
// per call), hashed in the sandbox while decoded; a large set is walked page by page.

import { sha256OfBase64 } from "../einvoicing/backfill-sha256"
import type { IssueDb } from "../issue"

export interface VerifyCtx {
  db: Pick<IssueDb, "findMany">
  files_getAttachmentBytes?(argsJson: string): Promise<string>
}

export interface VerifyParams {
  document_id?: string | null
  limit?: number | null
  offset?: number | null
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
/** Bytes read per call; the bridge's own cumulative cap is higher, this keeps a page quick. */
const BYTE_BUDGET = 25 * 1024 * 1024

type Row = Record<string, unknown>

export async function legalOriginalsVerify(ctx: VerifyCtx, params: VerifyParams = {}) {
  if (!ctx.files_getAttachmentBytes) {
    return {
      status: "error" as const,
      error: { code: "unsupported", message: "The file bridge is not available in this runtime." },
    }
  }
  const limit = Math.min(
    Math.max(Number(params.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  )
  const offset = Math.max(Number(params.offset ?? 0) || 0, 0)
  const where: Record<string, unknown> = params.document_id
    ? { document_id: String(params.document_id) }
    : {}
  const rows = (await ctx.db.findMany("legal_originals", {
    where,
    orderBy: { recorded_at: "asc" },
    limit: limit + 1,
    offset,
  })) as Row[]
  const page = rows.slice(0, limit)
  const intact: string[] = []
  const mismatched: Array<{
    legal_original_id: string
    document_id: string | null
    recorded_sha256: string
    actual_sha256: string
  }> = []
  const unreadable: Array<{
    legal_original_id: string
    document_id: string | null
    reason: string
  }> = []
  let bytes = 0
  let checked = 0
  let consumed = 0
  for (const r of page) {
    if (checked > 0 && bytes >= BYTE_BUDGET) break
    consumed += 1
    const id = String(r.id)
    const documentId = (r.document_id as string | null) ?? null
    // An empty row is a first render that never succeeded: not a legal original yet.
    if (!r.sha256 || !r.file_id) continue
    checked += 1
    let b64 = ""
    try {
      const file = JSON.parse(
        await ctx.files_getAttachmentBytes(
          JSON.stringify({
            fileId: String(r.file_id),
            allowedParents: [{ app: "invoicing", entityType: "legal_original", entityId: id }],
          }),
        ),
      ) as { bytesBase64?: string }
      b64 = file.bytesBase64 ?? ""
    } catch (err) {
      unreadable.push({
        legal_original_id: id,
        document_id: documentId,
        reason: (err as Error)?.message ?? String(err),
      })
      continue
    }
    if (!b64) {
      unreadable.push({
        legal_original_id: id,
        document_id: documentId,
        reason: "the stored file is empty or missing",
      })
      continue
    }
    const { sha256, byteLength } = sha256OfBase64(b64)
    bytes += byteLength
    if (sha256 === String(r.sha256)) intact.push(id)
    else
      mismatched.push({
        legal_original_id: id,
        document_id: documentId,
        recorded_sha256: String(r.sha256),
        actual_sha256: sha256,
      })
  }
  const more = rows.length > limit || consumed < page.length
  return {
    status: "ok" as const,
    checked,
    intact: intact.length,
    mismatched,
    unreadable,
    next_offset: more ? offset + consumed : null,
    message:
      mismatched.length === 0 && unreadable.length === 0
        ? `${intact.length} legal original(s) checked: every stored file matches its recorded fingerprint.`
        : `${mismatched.length} legal original(s) no longer match their recorded fingerprint and ${unreadable.length} could not be read: report them to an administrator.`,
  }
}
