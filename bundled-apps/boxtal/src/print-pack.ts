// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Print pack — the "Ready to ship" per-row document preparation. Produces the
// print-station documents as TWO SEPARATE jobs that are NEVER merged into one
// PDF, because they go to two different printers:
//   1. The LABEL alone (self-adhesive label printer). Boxtal serves labels as
//      Letter landscape pages carrying a `/Rotate 270` flag, which viewers
//      honor but label-print pipelines often ignore (prod, 2026-07-20:
//      sideways labels). The label is therefore normalized SERVER-side — the
//      rotation is BAKED into the page content via the kernel's PDF pipeline
//      (a unary `kernel:files_merge_pdfs`, whose merge bakes every source
//      page's /Rotate into upright content) before it is served. Label page
//      only; the invoice is never touched.
//   2. The INVOICE (A4 printer), with the number of copies the route requires:
//      1 copy for an EU/domestic route, 3 copies for an export outside the EU
//      (carrier + customs + recipient). The copy count is REPORTED, not baked
//      into a repeated-page PDF, so the operator prints N copies on A4.

import { EU_MEMBERS } from "./customs"
import { importLabelDocument } from "./shipment"
import { findShipmentByRef } from "./shipment-lookup"
import type { BoxtalToolCtx } from "./ctx"

type Ctx = BoxtalToolCtx

/** How many A4 copies of the invoice the route requires, and why. Domestic or
 *  intra-EU: 1 copy (no customs paperwork). Export outside the EU: 3 copies
 *  (carrier pouch + customs + recipient). Unknown destination degrades to the
 *  export count — printing one sheet too many is cheaper than a stuck parcel. */
export function invoiceCopiesFor(
  senderCountry: string | null | undefined,
  destinationCountry: string | null | undefined,
): { copies: 1 | 3; reason: "eu_or_domestic" | "export_non_eu" } {
  const from = (senderCountry ?? "").trim().toUpperCase()
  const to = (destinationCountry ?? "").trim().toUpperCase()
  if (to !== "" && (to === from || (EU_MEMBERS.includes(from) && EU_MEMBERS.includes(to)))) {
    return { copies: 1, reason: "eu_or_domestic" }
  }
  return { copies: 3, reason: "export_non_eu" }
}

export interface PrintPackInput {
  /** The local shipment row id (a ready_list row id) or the Boxtal order id. */
  shipment_id: string
}

export interface PrintPackResult {
  /** The orientation-normalized label PDF (a fresh kernel file, /Rotate baked
   *  into the content) — print job 1, label printer. Null when the label is not
   *  available yet (Boxtal generates it asynchronously). */
  label: { file_id: string; filename: string } | null
  /** Why the label is missing, when it is. */
  label_error?: string
  /** The invoice PDF — print job 2, A4 printer, `copies` copies. An issued
   *  invoice with no PDF yet is rendered on demand; the file is null only when
   *  that is not possible (draft, void, render failed), and `invoice_error`
   *  says what to do. */
  invoice: {
    file_id: string | null
    copies: 1 | 3
    reason: "eu_or_domestic" | "export_non_eu"
  }
  invoice_error?: string
  error?: { code: string; message: string }
}

interface ShipmentRowView {
  id: string | number
  boxtal_order_id?: string | null
  document_ref?: string | null
  tracking_number?: string | null
}

/** Resolve the two print jobs for one ready-to-ship shipment. Read-only apart
 *  from the file imports (label backfill + the normalized copy). */
export async function printPack(ctx: Ctx, input: PrintPackInput): Promise<PrintPackResult> {
  const ref = String(input.shipment_id ?? "").trim()
  if (!ref) {
    return {
      label: null,
      invoice: { file_id: null, copies: 3, reason: "export_non_eu" },
      error: { code: "invalid_params", message: "shipment_id is required (a ready_list row id)." },
    }
  }
  const row = await findShipmentByRef<ShipmentRowView>(ctx, ref)
  if (!row) {
    return {
      label: null,
      invoice: { file_id: null, copies: 3, reason: "export_non_eu" },
      error: { code: "not_found", message: `No shipment row matches "${ref}".` },
    }
  }

  // — Job 1: the label, normalized —
  let label: PrintPackResult["label"] = null
  let labelError: string | undefined
  const imported = await importLabelDocument(ctx, { id: String(row.id) })
  if (imported.error || !imported.label_file_id) {
    labelError = imported.error?.message ?? "Label not available yet."
  } else {
    const filename = `label-${row.tracking_number ?? row.boxtal_order_id ?? row.id}.pdf`
    // Unary merge = the kernel PDF pipeline's rotation baking (upright content,
    // /Rotate 0) with the label page(s) only — never combined with the invoice.
    const env = (await ctx.executeTool("kernel:files_merge_pdfs", {
      file_ids: [imported.label_file_id],
      title: filename,
    })) as { status?: string; result?: { fileId?: string } | null; error?: { message?: string } }
    if (env.status === "completed" && env.result?.fileId) {
      label = { file_id: env.result.fileId, filename }
    } else {
      // Degrade to the raw imported label rather than blocking the print: an
      // un-normalized label still prints (sideways at worst), a missing one
      // does not ship the parcel.
      label = { file_id: imported.label_file_id, filename }
      labelError = `Label orientation could not be normalized (${env.error?.message ?? "pdf pipeline unavailable"}); serving the raw label.`
    }
  }

  // — Job 2: the invoice, with its route-driven copy count —
  const documentRef = row.document_ref ?? null
  let invoiceFileId: string | null = null
  let invoiceError: string | undefined
  let destinationCountry: string | null = null
  if (!documentRef) {
    invoiceError = "This shipment has no linked invoicing document."
  } else {
    const doc = (await ctx.executeTool("invoicing:documents_get", { id: documentRef })) as {
      status?: string
      result?: { counterparty_country?: string | null; status?: string | null; number?: string | null } | null
    }
    const docStatus = doc.status === "completed" && doc.result ? (doc.result.status ?? null) : null
    if (doc.status === "completed" && doc.result) {
      destinationCountry = doc.result.counterparty_country ?? null
    }
    const pdf = (await ctx.executeTool("invoicing:documents_download_pdf", { id: documentRef })) as {
      status?: string
      result?: { file_id?: string | null } | null
      error?: { message?: string }
    }
    if (pdf.status === "completed" && pdf.result?.file_id) {
      invoiceFileId = pdf.result.file_id
    } else if (docStatus === "draft") {
      invoiceError = "The invoice is still a draft: issue it in Invoicing, then print again."
    } else if (docStatus !== null && NOT_PRINTABLE.has(docStatus)) {
      invoiceError = `The invoice is ${docStatus} and has no PDF to print.`
    } else {
      // An issued document with no PDF has not been rendered yet (its first render is pending,
      // never ran, or failed). Render it now through the invoicing app's own render path, the
      // same one its "Retry PDF" action uses, instead of failing the print.
      const rendered = await renderInvoicePdf(ctx, documentRef)
      if (rendered.file_id) invoiceFileId = rendered.file_id
      else invoiceError = rendered.error
    }
  }

  const senderCountry = await senderCountryFromConfig(ctx)
  const { copies, reason } = invoiceCopiesFor(senderCountry, destinationCountry)

  return {
    label,
    ...(labelError ? { label_error: labelError } : {}),
    invoice: { file_id: invoiceFileId, copies, reason },
    ...(invoiceError ? { invoice_error: invoiceError } : {}),
  }
}

/** Document statuses with nothing to print: their PDF is never rendered on demand. */
const NOT_PRINTABLE = new Set(["void", "voided", "cancelled", "discarded"])

/** Render an issued invoice's missing PDF via `invoicing:documents_retry_pdf`. Returns the file
 *  id, or a message that tells the operator what to do when the render cannot run here. */
async function renderInvoicePdf(
  ctx: Ctx,
  documentRef: string,
): Promise<{ file_id: string | null; error: string }> {
  const fallback =
    "The invoice PDF has not been rendered yet. Open the invoice in Invoicing and use Retry PDF, then print again."
  let env: Awaited<ReturnType<Ctx["executeTool"]>>
  try {
    env = await ctx.executeTool("invoicing:documents_retry_pdf", { id: documentRef })
  } catch {
    return { file_id: null, error: fallback }
  }
  if (env.status === "pending_approval") {
    return {
      file_id: null,
      error: "Rendering the invoice PDF is waiting for approval. Print again once it is approved.",
    }
  }
  const res =
    env.status === "completed"
      ? (env.result as
          | { status?: string; pdf_file_id?: string | null; error?: { message?: string } }
          | null
          | undefined)
      : null
  if (res?.status === "completed" && res.pdf_file_id) return { file_id: res.pdf_file_id, error: "" }
  const why = env.status === "error" ? env.error.message : res?.error?.message
  return {
    file_id: null,
    error: why
      ? `The invoice PDF could not be rendered (${why}). Open the invoice in Invoicing and use Retry PDF, then print again.`
      : fallback,
  }
}

/** Ship-from country from the persisted sender config (default FR). */
async function senderCountryFromConfig(ctx: Ctx): Promise<string> {
  const rows = (await ctx.db.findMany("app_config", {
    where: { key: "sender_address" },
    limit: 1,
  })) as Array<{ value?: { countryIsoCode?: string | null } | null }>
  const c = rows[0]?.value?.countryIsoCode
  return typeof c === "string" && c.trim() !== "" ? c.trim().toUpperCase() : "FR"
}
