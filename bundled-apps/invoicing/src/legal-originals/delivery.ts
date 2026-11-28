// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which file a delivery sends. Every delivery of an invoice or credit note (customer email,
// order-paid auto email, the deferred email retry; later the PA submission and the booking) sends
// the LEGAL ORIGINAL, never a management re-render (a mark-paid or edited copy). A document issued
// before legal originals existed has none and keeps sending its current PDF. A document corrected in
// place (mutations/correct-issued.ts) sends its latest correction's file: the corrected content is
// what the document says now, and the legal original stays archived with the correction record.

import type { IssueDb } from "../issue"

export async function deliveryFileId(
  db: Pick<IssueDb, "findMany">,
  doc: Record<string, unknown>,
): Promise<{
  file_id: string | null
  legal_original: boolean
  /** Set when the file is a correction's: its regenerated Factur-X XML, when it has one. */
  correction?: { id: string; facturx_xml_file_id: string | null }
}> {
  const correctionId =
    typeof doc.current_correction_id === "string" && doc.current_correction_id
      ? doc.current_correction_id
      : null
  if (correctionId) {
    const rows = (await db.findMany("document_corrections", {
      where: { id: correctionId },
      limit: 1,
    })) as Array<Record<string, unknown>>
    const row = rows[0]
    if (row?.file_id && row.sha256)
      return {
        file_id: String(row.file_id),
        legal_original: true,
        correction: {
          id: correctionId,
          facturx_xml_file_id: (row.facturx_xml_file_id as string | null) ?? null,
        },
      }
  }
  const legalId =
    typeof doc.legal_original_id === "string" && doc.legal_original_id
      ? doc.legal_original_id
      : null
  if (legalId) {
    const rows = (await db.findMany("legal_originals", {
      where: { id: legalId },
      limit: 1,
    })) as Array<Record<string, unknown>>
    const row = rows[0]
    if (row?.file_id && row.sha256) return { file_id: String(row.file_id), legal_original: true }
  }
  const current = typeof doc.pdf_file_id === "string" && doc.pdf_file_id ? doc.pdf_file_id : null
  return { file_id: current, legal_original: false }
}
