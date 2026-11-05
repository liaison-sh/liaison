// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Batch print: one merged PDF per PRINT JOB, for a selection of shipments.
//
// The single-shipment print_pack opens two tabs, one per printer (label roll, A4 invoice). Doing
// that for a morning's twelve parcels is twenty four tabs, each one a popup the browser may block
// and a print dialog to confirm — which is why the print station batches by hand today. This
// merges instead: every selected label into ONE document for the label printer, every selected
// invoice into ONE document for A4.
//
// The two jobs stay SEPARATE for the same reason they do in print_pack: the label goes on the box
// from a roll of self-adhesive labels, the invoice goes in the pouch from an A4 tray. A combined
// PDF cannot be printed correctly on either.
//
// Per-destination copy counts survive the merge: an invoice that needs three copies (export
// outside the EU) is placed three times in the invoice document, in row order, so the stack comes
// off the printer already collated per parcel.
import { printPack } from "./print-pack"
import type { BoxtalToolCtx } from "./ctx"

export interface PrintPackBatchInput {
  shipment_ids?: unknown
}

export interface PrintPackBatchResult {
  /** The merged label document for the label printer, or null when no selected row had a label. */
  labels: { file_id: string; filename: string; shipment_count: number } | null
  /** The merged invoice document for A4, already collated to the per-destination copy counts. */
  invoices: { file_id: string; filename: string; shipment_count: number; page_copies: number } | null
  /** Rows that contributed nothing, each with the reason, so the operator knows what to chase
   *  instead of discovering a missing parcel at the packing bench. */
  skipped: Array<{ shipment_id: string; what: "label" | "invoice" | "both"; reason: string }>
  error?: { code: string; message: string }
}

/**
 * Rows per batch. Bounded by the tool's own 60s ceiling (the runtime's manifest cap), not by
 * taste: each row costs a label import, a PDF normalization and two invoicing reads, run in
 * sequence to keep the merged stack in the operator's collation order. Twenty fits with room to
 * spare; a bigger selection prints as two batches, which is still two dialogs instead of forty.
 */
const MAX_BATCH = 20

/** Merge a set of already-imported PDFs into one document. Returns null (never throws) when the
 *  kernel pipeline is unavailable: a failed merge must degrade to "print them individually". */
async function mergePdfs(
  ctx: BoxtalToolCtx,
  fileIds: string[],
  title: string,
): Promise<string | null> {
  if (fileIds.length === 0) return null
  try {
    const env = (await ctx.executeTool("kernel:files_merge_pdfs", {
      file_ids: fileIds,
      title,
    })) as { status?: string; result?: { fileId?: string } | null }
    return env.status === "completed" && env.result?.fileId ? env.result.fileId : null
  } catch {
    return null
  }
}

export async function printPackBatch(
  ctx: BoxtalToolCtx,
  input: PrintPackBatchInput,
): Promise<PrintPackBatchResult> {
  const ids = Array.isArray(input.shipment_ids)
    ? input.shipment_ids.map((i) => String(i ?? "").trim()).filter((i) => i !== "")
    : []
  if (ids.length === 0) {
    return {
      labels: null,
      invoices: null,
      skipped: [],
      error: { code: "invalid_params", message: "shipment_ids must list at least one shipment." },
    }
  }
  if (ids.length > MAX_BATCH) {
    return {
      labels: null,
      invoices: null,
      skipped: [],
      error: {
        code: "too_many",
        message: `A batch prints at most ${MAX_BATCH} shipments at once; ${ids.length} were selected. Print them in two batches.`,
      },
    }
  }

  const labelFiles: string[] = []
  const invoiceFiles: string[] = []
  const skipped: PrintPackBatchResult["skipped"] = []
  let labelCount = 0
  let invoiceCount = 0

  // Sequential on purpose: each print_pack does several cross-app reads and a PDF normalization,
  // and the merged document's page ORDER is the operator's collation order. Parallelising would
  // trade a predictable stack for a faster one.
  for (const id of ids) {
    const pack = await printPack(ctx, { shipment_id: id })
    const noLabel = !pack.label?.file_id
    const noInvoice = !pack.invoice?.file_id
    if (pack.error) {
      skipped.push({ shipment_id: id, what: "both", reason: pack.error.message })
      continue
    }
    if (pack.label?.file_id) {
      labelFiles.push(pack.label.file_id)
      labelCount++
    }
    if (pack.invoice?.file_id) {
      // The copy count is per destination (1 intra-EU, 3 for an export): repeat the same file so
      // the merged stack is already collated, rather than leaving the operator to re-print.
      for (let i = 0; i < pack.invoice.copies; i++) invoiceFiles.push(pack.invoice.file_id)
      invoiceCount++
    }
    if (noLabel && noInvoice) {
      skipped.push({
        shipment_id: id,
        what: "both",
        reason: pack.label_error ?? pack.invoice_error ?? "Neither document is available yet.",
      })
    } else if (noLabel) {
      skipped.push({ shipment_id: id, what: "label", reason: pack.label_error ?? "Label not available yet." })
    } else if (noInvoice) {
      skipped.push({ shipment_id: id, what: "invoice", reason: pack.invoice_error ?? "Invoice not available yet." })
    }
  }

  const stamp = new Date().toISOString().slice(0, 10)
  const labelsFileId = await mergePdfs(ctx, labelFiles, `labels-${stamp}.pdf`)
  const invoicesFileId = await mergePdfs(ctx, invoiceFiles, `invoices-${stamp}.pdf`)

  if (labelFiles.length > 0 && !labelsFileId) {
    skipped.push({
      shipment_id: "*",
      what: "label",
      reason: "The labels could not be merged into one document; print the rows individually.",
    })
  }
  if (invoiceFiles.length > 0 && !invoicesFileId) {
    skipped.push({
      shipment_id: "*",
      what: "invoice",
      reason: "The invoices could not be merged into one document; print the rows individually.",
    })
  }

  return {
    labels: labelsFileId
      ? { file_id: labelsFileId, filename: `labels-${stamp}.pdf`, shipment_count: labelCount }
      : null,
    invoices: invoicesFileId
      ? {
          file_id: invoicesFileId,
          filename: `invoices-${stamp}.pdf`,
          shipment_count: invoiceCount,
          page_copies: invoiceFiles.length,
        }
      : null,
    skipped,
  }
}

/** Operator-facing summary of a batch run. Pure, so the UI and the agent say the same thing.
 *  No dash punctuation. */
export function printPackBatchSummary(res: PrintPackBatchResult): string {
  if (res.error) return res.error.message
  const parts: string[] = []
  parts.push(
    res.labels
      ? `Labels: ${res.labels.shipment_count} in one document (label printer)`
      : "Labels: none available",
  )
  parts.push(
    res.invoices
      ? `Invoices: ${res.invoices.shipment_count} in one document, ${res.invoices.page_copies} ${res.invoices.page_copies === 1 ? "copy" : "copies"} on A4`
      : "Invoices: none available",
  )
  if (res.skipped.length > 0) {
    const rows = new Set(res.skipped.map((s) => s.shipment_id))
    parts.push(`${rows.size} ${rows.size === 1 ? "row" : "rows"} incomplete: ${res.skipped[0]!.reason}`)
  }
  return `${parts.join(". ")}.`
}
