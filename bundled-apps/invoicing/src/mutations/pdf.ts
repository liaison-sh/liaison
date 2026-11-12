// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: document PDF rendering (ensureDocumentPdf) and the explicit retry.

import type { OperationCategory } from "../einvoicing/classify-operation"
import { importedOriginalMissing } from "../einvoicing/gate"
import { documentLegalMention } from "../einvoicing/mentions"
import { FacturxBuildError, type FacturxInput } from "../facturx/cii"
import { facturxEligible, facturxInputFrom } from "../facturx/input"
import {
  buildTemplateData,
  type Counterparty,
  type IssueCtx,
  type IssueDb,
  storedTaxCountry,
  taxCountryOf,
} from "../issue"
import { hasLegalOriginal, recordLegalOriginal } from "../legal-originals/record"
import { isUuid } from "../reads"
import { classify } from "../tax"
import { dateOnly, FOREIGN_ID_CHARS, findIssuerProfile } from "./db-helpers"
import { type DocumentType, type MutationResult, type MutationsCtx, toBigInt } from "./shared"

/**
 * documents_retry_pdf — re-render a document's PDF (the affordance shown when
 * `pdf_status='failed'`). Reconstructs the render input from the persisted
 * document snapshot + lines + issuer (the counterparty name/country are now
 * persisted on the document, so the retry renders the same content), calls K2,
 * and updates `pdf_file_id` / `pdf_status`.
 */
/**
 * Ensure `id` has a ready PDF, rendering it on-demand when it is missing or failed. The single
 * render-from-a-persisted-document path, shared by `documents.retry_pdf` (explicit, `force`) and
 * `documents.send_to_customer` (implicit self-heal). An issued document whose issue-time render
 * never ran or failed (`pdf_status` null/pending/failed) is (re)rendered HERE instead of blocking
 * the downstream consumer — this makes good on issue.ts's "absent `pdf_file_id` = retry me"
 * contract. Returns the ready file id, or a render-error envelope. With `force`, always re-renders
 * even when a ready PDF already exists (retry semantics); otherwise a ready PDF is reused as-is.
 */
/** Minimal ctx surface for re-rendering a persisted document's PDF: read the row + issuer + lines,
 *  render, write pdf_file_id/pdf_status. MutationsCtx satisfies it; so does the scheduled
 *  `reconcile-shopify-payments` job's ctx, which reuses `ensureDocumentPdf` to refresh the PDF of an
 *  invoice it settles late (a delayed bank transfer paid AFTER issuance) so it stops reading
 *  "Total due". Kept structural so neither caller needs the full MutationsCtx. */
export interface DocumentRenderCtx {
  db: Pick<IssueDb, "findMany" | "update" | "insert">
  pdf: IssueCtx["pdf"]
  getUserId?(): Promise<string>
  files_importAttachment?(argsJson: string): Promise<string>
  emit?: IssueCtx["emit"]
}
export async function ensureDocumentPdf(
  ctx: DocumentRenderCtx,
  idOrNumber: string,
  opts?: { force?: boolean; link?: boolean },
): Promise<
  | { ok: true; pdf_file_id: string }
  | {
      ok: false
      error: { code: string; message: string; retryable?: boolean; status?: number; body?: unknown }
    }
> {
  // Accept a document NUMBER as well as its uuid id — documents_retry_pdf is called directly with
  // whatever identifier the agent has (often the visible number), not always a pre-resolved uuid.
  if (!idOrNumber || FOREIGN_ID_CHARS.test(idOrNumber)) {
    return {
      ok: false,
      error: {
        code: "not_found",
        message: `document ${idOrNumber} not found`,
      },
    }
  }
  const where = isUuid(idOrNumber) ? { id: idOrNumber } : { number: idOrNumber }
  const docRows = await ctx.db.findMany("documents", { where, limit: 1 })
  const doc = docRows[0] as Record<string, unknown> | undefined
  if (!doc)
    return { ok: false, error: { code: "not_found", message: `document ${idOrNumber} not found` } }
  const id = String(doc.id)
  const existing = (doc.pdf_file_id as string | null) ?? null
  const refs = refsOf(doc.external_refs)
  // An imported legacy document's PDF IS its legal original (the file the importer stored). No
  // write path (mark paid, documents_update, retry, payment reconcile) may render over it, forced
  // or not: a render would replace the original with a copy rebuilt from approximated data.
  if (typeof refs.import_source === "string" && refs.import_source.trim()) {
    if (existing) return { ok: true, pdf_file_id: existing }
    const refusal = importedOriginalMissing()
    return {
      ok: false,
      error: {
        code: refusal.code,
        message: refusal.message,
        retryable: true,
        status: refusal.status,
        body: { missing: refusal.missing, regime: null, reasons: [], gate_mode: refusal.mode },
      },
    }
  }
  if (!opts?.force && existing && (doc.pdf_status as string | null) === "ready") {
    return { ok: true, pdf_file_id: existing }
  }
  // An issued invoice / credit note whose first render never succeeded has no legal original
  // yet: THIS render is it (Factur-X for an e_invoice document). A document that already has a
  // ready PDF but no legal original was issued before legal originals existed; re-rendering it
  // stays a management copy, as before.
  const docType = String(doc.type)
  const firstRender =
    hasLegalOriginal(docType) &&
    !doc.legal_original_id &&
    typeof doc.number === "string" &&
    doc.number !== "" &&
    (doc.pdf_status as string | null) !== "ready"
  const issuer = await findIssuerProfile(ctx.db, String(doc.issuer_profile_id))
  if (!issuer)
    return { ok: false, error: { code: "issuer_not_found", message: "issuer profile missing" } }
  const lineRows = await ctx.db.findMany("document_lines", {
    where: { document_id: id },
    orderBy: { position: "asc" },
    limit: 1000,
  })
  const lines = lineRows.map((row) => {
    const r = row as Record<string, unknown>
    return {
      position: Number(r.position ?? 0),
      description: String(r.description ?? ""),
      quantity: String(r.quantity ?? "1"),
      unit_price_minor: toBigInt(r.unit_price_minor),
      discount_minor: toBigInt(r.discount_minor),
      line_kind: (r.line_kind as "goods" | "software" | "shipping" | undefined) ?? "goods",
      tax_rate_bp: Number(r.tax_rate_bp ?? 0),
      subtotal_minor: toBigInt(r.subtotal_minor),
      tax_minor: toBigInt(r.tax_minor),
      total_minor: toBigInt(r.total_minor),
      hs_code: (r.hs_code as string | null) ?? null,
      country_of_origin: (r.country_of_origin as string | null) ?? null,
      customs_description: (r.customs_description as string | null) ?? null,
      product_source: (r.product_source as string | null) ?? null,
      external_id: (r.external_id as string | null) ?? null,
    }
  })
  // Rebuild the counterparty from the PERSISTED snapshot (counterparty_address/vat_id/email), not a
  // name/country-only stub — otherwise a re-render (retry or on-demand self-heal in
  // documents_send_to_customer) silently drops the Bill-to address/VAT/email that issue-time
  // buildTemplateData originally rendered.
  const counterparty: Counterparty = {
    contact_id: (doc.counterparty_contact_id as string | null) ?? null,
    legal_name: (doc.counterparty_name as string | null) ?? "Customer",
    country: (doc.counterparty_country as string | null) ?? issuer.country,
    tax_country: storedTaxCountry(doc),
    vat_id: (doc.counterparty_vat_id as string | null) ?? null,
    address: (doc.counterparty_address as string | null) ?? null,
    // A re-render must reproduce the SHIP TO block too: rebuilding without these would silently
    // drop the ship to from every retried / self-healed PDF.
    shipping_address: (doc.counterparty_shipping_address as string | null) ?? null,
    shipping_name: (doc.counterparty_shipping_name as string | null) ?? null,
    email: (doc.counterparty_email as string | null) ?? null,
  }
  const classification = classify({
    issuer_country: issuer.country,
    // Same inputs issueDocument classified on, so a re-render keeps the issue-time legal mention
    // (the tax destination, and the VAT id that makes an intra EU sale a reverse charge).
    counterparty_country: taxCountryOf(counterparty),
    has_vat_id: !!counterparty.vat_id,
  })
  const type = String(doc.type) as DocumentType
  // A credit note's reference to the invoice it reverses (number + issue date, and the reason) is
  // printed on the PDF; a re-render rebuilds it exactly as issue time did, from the original row.
  const creditRef = type === "credit_note" ? await creditNoteReference(ctx, doc, refs) : null
  const legalMention = await documentLegalMention(
    ctx.db,
    classification.treatment,
    issuer.default_language,
    {
      category: (doc.operation_category as OperationCategory | null | undefined) ?? null,
      issueDate: dateOnly(doc.issued_at),
    },
  )
  if (firstRender) {
    return renderFirstLegalOriginal(ctx, {
      // An on-demand first render (send) hands the file to the mail app in this same call: the
      // host commits the legal original row with the file (BL-191). documents_update/payments
      // (link:false) already hold the documents row and keep everything in their transaction.
      commit: opts?.link !== false,
      doc,
      id,
      type,
      lines,
      issuer: issuer as unknown as Record<string, unknown>,
      creditRef,
      legalMention,
      // biome-ignore lint/suspicious/noExplicitAny: persisted row → DocumentRow (string money; buildTemplateData calls .toString()).
      templateData: buildTemplateData({
        type,
        document: { ...(doc as any), id },
        issuer,
        counterparty,
        lines,
        requires_hs_code: classification.requires_hs_code,
        legal_mention: legalMention,
        ...(creditRef ?? {}),
      }),
    })
  }
  // The bridge normally wraps a thrown render error into an `{ error }` envelope, but a direct
  // throw is still possible (and the unit mock throws) — handle both so a render failure becomes a
  // typed error + `pdf_status='failed'`, never an unhandled rejection that aborts the gated send.
  let rendered: { file_id: string } | { error: { code?: string; message?: string } }
  try {
    rendered = (await ctx.pdf.render({
      template_kind: `invoicing:${type}_v1`,
      // Re-render keeps the document-identifying filename (see issue.ts); an
      // unnumbered draft falls back to the host's template-kind name.
      ...((doc.number as string | null) ? { filename: `${type}-${doc.number as string}.pdf` } : {}),
      // biome-ignore lint/suspicious/noExplicitAny: persisted row → DocumentRow (string money; buildTemplateData calls .toString()).
      data: buildTemplateData({
        type,
        document: { ...(doc as any), id },
        issuer,
        counterparty,
        lines,
        requires_hs_code: classification.requires_hs_code,
        // The stored snapshot (category, issue date), never a recomputation from current data.
        legal_mention: legalMention,
        ...(creditRef ?? {}),
      }),
      // BL-191 — COMMIT the documents.pdf_file_id link in the SAME privileged tx the host uses to write
      // the file row, so an ON-DEMAND render inside documents_send_to_customer is visible to the
      // cross-app mail:composeForApp (whose `pdf` fileParent RLS joins documents.pdf_file_id =
      // files.entity_id) BEFORE this handler's tx commits. Without it the gated send fails closed
      // "Source file not visible to caller" on any issued-but-unrendered invoice. The redundant
      // ctx.db.update below keeps pdf_status in the handler tx (rolls back with the handler on failure).
      //
      // `link: false` callers (documents_update): the handler has ALREADY UPDATED this documents row
      // inside its own open transaction, so the row is LOCKED — the host's privileged link-write
      // (a separate tx) would block on that lock while the handler awaits the render: a deadlock
      // that rides the sandbox timeout to a killed worker. Those callers persist pdf_file_id via
      // the in-tx ctx.db.update below instead; the cross-tx link only matters for the
      // send-to-customer same-tx visibility flow (BL-191), which never pre-updates the row.
      ...(opts?.link === false
        ? {}
        : { link: { table: "documents", column: "pdf_file_id", row_id: id } }),
    })) as { file_id: string } | { error: { code?: string; message?: string } }
  } catch (err) {
    await ctx.db.update("documents", id, { pdf_status: "failed" })
    return {
      ok: false,
      error: {
        code: (err as { code?: string }).code ?? "render_failed",
        message: (err as { message?: string }).message ?? "PDF render failed",
      },
    }
  }
  if ("error" in rendered) {
    await ctx.db.update("documents", id, { pdf_status: "failed" })
    return {
      ok: false,
      error: {
        code: (rendered.error.code as string) ?? "render_failed",
        message: rendered.error.message ?? "PDF render failed",
      },
    }
  }
  await ctx.db.update("documents", id, { pdf_file_id: rendered.file_id, pdf_status: "ready" })
  return { ok: true, pdf_file_id: rendered.file_id }
}

/** The first successful render of an issued invoice / credit note: its legal original. */
async function renderFirstLegalOriginal(
  ctx: DocumentRenderCtx,
  a: {
    commit: boolean
    doc: Record<string, unknown>
    id: string
    type: DocumentType
    lines: Array<{
      position: number
      description: string
      quantity: string
      unit_price_minor: bigint
      discount_minor: bigint
      tax_rate_bp: number
      subtotal_minor: bigint
      tax_minor: bigint
    }>
    issuer: Record<string, unknown>
    creditRef: {
      original_invoice_number: string | null
      original_invoice_date: string | null
    } | null
    legalMention: string
    templateData: unknown
  },
): Promise<
  | { ok: true; pdf_file_id: string }
  | { ok: false; error: { code: string; message: string; retryable?: boolean } }
> {
  const wasFacturxFailed = a.doc.pdf_status === "facturx_failed"
  let facturx: FacturxInput | null = null
  let built: { ok: false; code: string; message: string; facturx: true } | null = null
  if (facturxEligible(a.type, a.doc)) {
    try {
      facturx = facturxInputFrom({
        type: a.type as "invoice" | "credit_note",
        doc: a.doc,
        lines: a.lines,
        issuer: a.issuer,
        original: a.creditRef
          ? {
              number: a.creditRef.original_invoice_number,
              issue_date: a.creditRef.original_invoice_date,
            }
          : null,
        legalMention: a.legalMention,
      })
    } catch (err) {
      if (!(err instanceof FacturxBuildError)) throw err
      built = { ok: false, code: err.code, message: err.message, facturx: true }
    }
  }
  const r =
    built ??
    (await recordLegalOriginal(ctx, {
      documentId: a.id,
      type: a.type,
      number: String(a.doc.number),
      templateData: a.templateData,
      facturx,
      commit: a.commit,
    }))
  if (!r.ok) {
    await ctx.db.update("documents", a.id, { pdf_status: r.facturx ? "facturx_failed" : "failed" })
    return { ok: false, error: { code: r.code, message: r.message, retryable: true } }
  }
  if (wasFacturxFailed && ctx.emit) {
    await ctx.emit({
      entity: "einvoicing",
      action: "facturx_failed",
      entityId: a.id,
      data: {
        document_id: a.id,
        number: a.doc.number,
        code: "resolved",
        reason: "",
        resolved: true,
      },
    })
  }
  return { ok: true, pdf_file_id: r.file_id }
}

function refsOf(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>
    } catch {
      // not JSON: no refs
    }
  }
  return {}
}

/** The original invoice's number + issue date and the credit note's reason, as issue time passed
 *  them to the template: the original's link column (then the refs mirror) names the original
 *  row; the stored number stands in when that row is unknown. */
async function creditNoteReference(
  ctx: DocumentRenderCtx,
  doc: Record<string, unknown>,
  refs: Record<string, unknown>,
): Promise<{
  original_invoice_number: string | null
  original_invoice_date: string | null
  reason: string | null
}> {
  const linked =
    (doc.original_document_id as string | null) ??
    (refs.original_document_id as string | undefined) ??
    null
  let original: Record<string, unknown> | undefined
  if (linked && isUuid(String(linked))) {
    const rows = await ctx.db.findMany("documents", { where: { id: String(linked) }, limit: 1 })
    original = rows[0] as Record<string, unknown> | undefined
  }
  const storedNumber =
    typeof refs.original_document_number === "string" ? refs.original_document_number : null
  return {
    original_invoice_number: ((original?.number as string | null) ?? null) || storedNumber,
    original_invoice_date: original ? dateOnly(original.issued_at) : null,
    reason: typeof refs.reason === "string" ? refs.reason : null,
  }
}

export async function documentsRetryPdf(
  ctx: MutationsCtx,
  input: { id: string },
): Promise<MutationResult<{ document_id: string; pdf_file_id: string | null }>> {
  const id = input?.id ? String(input.id) : ""
  if (!id) {
    return { status: "error", error: { code: "invalid_params", message: "id is required" } }
  }
  // retry_pdf is the EXPLICIT retry: always re-render, even if a ready PDF already exists.
  const r = await ensureDocumentPdf(ctx, id, { force: true })
  if (!r.ok) return { status: "error", error: r.error }
  return { status: "completed", document_id: id, pdf_file_id: r.pdf_file_id }
}
