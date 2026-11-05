// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The legal original of an issued invoice or credit note: the bytes of its FIRST render, fixed
// at issue. For an e_invoice document that render is the Factur-X itself (PDF/A-3B with the CII
// XML attached); otherwise the PDF/A-3B of the same template. The file is stored under its own
// `legal_original` fileParent (never under the `pdf` parent a later re-render replaces), in an
// immutable `legal_originals` row born complete; the CII XML is also kept as its own
// `facturx_files` row (immutable and retained like the legal original) so it can be downloaded
// without opening the PDF. The XML of record is the one embedded in the legal original; the
// standalone copy is the same bytes (the builder is deterministic and every input it reads is
// locked once the legal original exists), and a copy lost to a rolled-back call is re-created
// by the next render request.
//
// Later renders (mark paid, an edit before the lock) are management copies: they never touch
// this row or its file, and every delivery sends the legal original (./delivery.ts).

import type { IssueCtx, IssueDb } from "../issue"
import { sha256Hex } from "../einvoicing/backfill-sha256"
import { buildCii, FacturxBuildError, type FacturxInput } from "../facturx/cii"
import { base64, utf8Bytes } from "./bytes"

/** OPEN: `Data` per the open-source Factur-X reference implementation; the FNFE example uses
 *  `Source`. One constant, switchable. */
export const FACTURX_AF_RELATIONSHIP = "Data" as const
export const FACTURX_FILENAME = "factur-x.xml"
export const FACTURX_PROFILE = "EN 16931"

export function facturxXmpExtension(documentType: "INVOICE" = "INVOICE") {
  return {
    schema: "Factur-X PDFA Extension Schema",
    namespaceUri: "urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#",
    prefix: "fx",
    properties: [
      { name: "DocumentFileName", value: FACTURX_FILENAME, description: "The name of the embedded XML document" },
      { name: "DocumentType", value: documentType, description: "The type of the hybrid document in capital letters, e.g. INVOICE or ORDER" },
      { name: "Version", value: "1.0", description: "The actual version of the standard applying to the embedded XML document" },
      { name: "ConformanceLevel", value: FACTURX_PROFILE, description: "The conformance level of the embedded XML document" },
    ],
  }
}

export interface LegalOriginalCtx {
  db: Pick<IssueDb, "insert" | "update" | "findMany">
  pdf: IssueCtx["pdf"]
  getUserId?(): Promise<string>
  files_importAttachment?(argsJson: string): Promise<string>
}

export type LegalOriginalResult =
  | { ok: true; file_id: string; legal_original_id: string; sha256: string; kind: "facturx" | "issued_pdf" }
  | { ok: false; code: string; message: string; facturx: boolean }

/**
 * Render and record the legal original of `documentId`. Writes `legal_originals` (+
 * `facturx_files`) and points the document at it (`legal_original_id`, `legal_original_sha256`,
 * `pdf_file_id`, `pdf_status`). Never throws for a render or Factur-X build failure: the caller
 * gets `{ok:false}` and decides the document's status (failed / facturx_failed).
 */
export async function recordLegalOriginal(
  ctx: LegalOriginalCtx,
  args: {
    documentId: string
    type: string
    number: string
    templateData: unknown
    /** Present for an e_invoice document: the Factur-X to embed. */
    facturx: FacturxInput | null
    /** The document is already committed and a cross-app reader (the mail app) will attach the
     *  file in this same call: let the host commit the row with the file. */
    commit?: boolean
  },
): Promise<LegalOriginalResult> {
  let xml: string | null = null
  if (args.facturx) {
    try {
      xml = buildCii(args.facturx)
    } catch (err) {
      if (err instanceof FacturxBuildError) return { ok: false, code: err.code, message: err.message, facturx: true }
      throw err
    }
  }
  const xmlBytes = xml != null ? utf8Bytes(xml) : null
  const kind = xmlBytes ? ("facturx" as const) : ("issued_pdf" as const)
  const recordedBy = ctx.getUserId ? await ctx.getUserId() : null
  const now = new Date().toISOString()
  // The row first (the file parent must exist for the render to attach to it), complete except
  // for what only the render knows. A row left empty by an earlier failed render of the same
  // document is reused (rows are immutable and the pair document/kind is unique); a complete one
  // means the legal original already exists and is never re-rendered.
  const existing = ((await ctx.db.findMany("legal_originals", {
    where: { document_id: args.documentId, kind },
    limit: 1,
  })) as Array<Record<string, unknown>>)[0]
  if (existing?.sha256 && existing.file_id) {
    // The legal original was committed by the host while the call that recorded it rolled back
    // (commit mode): re-create what that call lost, the XML copy and the document's pointers.
    if (xml != null && xmlBytes) await recordFacturxXml(ctx, args.documentId, args.number, xmlBytes, now)
    await ctx.db.update("documents", args.documentId, {
      legal_original_id: existing.id,
      legal_original_sha256: existing.sha256,
      pdf_file_id: existing.file_id,
      pdf_status: "ready",
    })
    return {
      ok: true,
      file_id: String(existing.file_id),
      legal_original_id: String(existing.id),
      sha256: String(existing.sha256),
      kind,
    }
  }
  // Committed mode: no row yet, the host inserts it with the file (see the SDK `commitRow`).
  const hostCommits = args.commit === true && !existing
  const original = hostCommits
    ? null
    : (existing ??
      ((await ctx.db.insert("legal_originals", {
        document_id: args.documentId,
        kind,
        file_id: null,
        sha256: null,
        byte_size: null,
        recorded_at: now,
        recorded_by: recordedBy,
      })) as Record<string, unknown>))
  const parent = hostCommits
    ? {
        entityType: "legal_original",
        commitRow: {
          values: { document_id: args.documentId, kind, recorded_at: now, recorded_by: recordedBy },
          fileIdColumn: "file_id",
          sha256Column: "sha256",
          sizeColumn: "byte_size",
        },
      }
    : { entityType: "legal_original", entityId: String((original as Record<string, unknown>).id) }
  let rendered:
    | { file_id: string; byte_size: number; sha256?: string; parent_entity_id?: string }
    | { error: { code?: string; message?: string } }
  try {
    rendered = (await ctx.pdf.render({
      template_kind: `invoicing:${args.type}_v1`,
      filename: `${args.type}-${args.number}.pdf`,
      data: args.templateData,
      pdfa: "3b",
      ...(xmlBytes
        ? {
            attachments: [
              {
                name: FACTURX_FILENAME,
                mime: "text/xml",
                bytesBase64: base64(xmlBytes),
                afRelationship: FACTURX_AF_RELATIONSHIP,
                description: "Factur-X invoice",
              },
            ],
            xmp: { extensions: [facturxXmpExtension()] },
          }
        : {}),
      parent,
    })) as typeof rendered
  } catch (err) {
    rendered = { error: { code: (err as { code?: string }).code, message: (err as { message?: string }).message } }
  }
  if ("error" in rendered || !rendered.sha256 || (hostCommits && !rendered.parent_entity_id)) {
    // An empty row (no file, no hash) is no legal original and is never read as one; the retry
    // fills it.
    const e = "error" in rendered ? rendered.error : { code: "render_failed", message: "the renderer returned no hash" }
    // A render failure is not a Factur-X data problem: the document goes to `failed`, retried
    // like any render; only a build refusal (FacturxBuildError above) is `facturx_failed`.
    return { ok: false, code: e.code ?? "render_failed", message: e.message ?? "PDF render failed", facturx: false }
  }
  const originalId = hostCommits ? String(rendered.parent_entity_id) : String((original as Record<string, unknown>).id)
  if (!hostCommits) {
    await ctx.db.update("legal_originals", originalId, {
      file_id: rendered.file_id,
      sha256: rendered.sha256,
      byte_size: rendered.byte_size,
    })
  }
  if (xml != null && xmlBytes) await recordFacturxXml(ctx, args.documentId, args.number, xmlBytes, now)
  await ctx.db.update("documents", args.documentId, {
    legal_original_id: originalId,
    legal_original_sha256: rendered.sha256,
    pdf_file_id: rendered.file_id,
    pdf_status: "ready",
  })
  return { ok: true, file_id: rendered.file_id, legal_original_id: originalId, sha256: rendered.sha256, kind }
}

/** The standalone CII copy of a legal original: one immutable `facturx_files` row per document,
 *  its file stored once. A row whose file was never stored (an import that failed) is filled; a
 *  complete row is left alone. */
async function recordFacturxXml(
  ctx: LegalOriginalCtx,
  documentId: string,
  number: string,
  xmlBytes: ReturnType<typeof utf8Bytes>,
  now: string,
): Promise<void> {
  const rows = (await ctx.db.findMany("facturx_files", { where: { document_id: documentId }, limit: 1 })) as Array<
    Record<string, unknown>
  >
  const existing = rows[0]
  if (existing?.file_id || (existing && !ctx.files_importAttachment)) return
  const row =
    existing ??
    ((await ctx.db.insert("facturx_files", {
      document_id: documentId,
      sha256: sha256Hex(xmlBytes),
      profile: FACTURX_PROFILE,
      generated_at: now,
    })) as Record<string, unknown>)
  if (!ctx.files_importAttachment) return
  const stored = JSON.parse(
    await ctx.files_importAttachment(
      JSON.stringify({
        targetApp: "invoicing",
        targetEntityType: "facturx_xml",
        targetEntityId: String(row.id),
        filename: `${number}-${FACTURX_FILENAME}`,
        mimeType: "text/xml",
        bytesBase64: base64(xmlBytes),
      }),
    ),
  ) as { id: string }
  await ctx.db.update("facturx_files", String(row.id), { file_id: stored.id })
}

/** Invoices and credit notes are the documents whose first render is a legal original. */
export function hasLegalOriginal(type: string): boolean {
  return type === "invoice" || type === "credit_note"
}
