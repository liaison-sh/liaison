// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated-tool approval summarizers (host-side runtime import, TRUSTED bundled app).
// Bundled into the freeze entrypoint via the `export * from "./summarizers"`
// re-export in src/handlers.ts, so the host's `loadTrustedBundleFunction` can
// resolve them from the built bundle (mirrors the shopify/boxtal convention).
//
// Pure (no DB / no fetch) so it is safe to run synchronously at gate time.

import { minorToDecimal } from "./upload"

interface ApprovalSummaryShape {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null
}

/**
 * Summary for pennylane `supplier_invoice_upload`: what the approval books into Pennylane's
 * accounts payable (supplier, number, dates, total and tax as the agent read them from the bill).
 */
export function summarizeSupplierInvoiceUpload(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const supplier = str(p.supplier_name) ?? "(unknown supplier)"
  const currency = str(p.currency) ?? "EUR"
  const major = (v: unknown) => {
    const m = str(v)
    if (!m) return null
    const amount = minorToDecimal(m, currency)
    return amount === null ? `${m} (not a whole number of minor units, approving will be refused)` : `${amount} ${currency}`
  }
  const lines: string[] = []
  const number = str(p.invoice_number)
  if (number) lines.push(`Invoice number: ${number}`)
  const invoiceDate = str(p.invoice_date)
  if (invoiceDate) lines.push(`Invoice date: ${invoiceDate}`)
  const due = str(p.due_date)
  if (due) lines.push(`Due date: ${due}`)
  const total = major(p.amount_minor)
  if (total) lines.push(`Total including tax: ${total}`)
  const tax = major(p.tax_minor)
  if (tax) lines.push(`Of which tax: ${tax}`)
  if (str(p.supplier_id)) lines.push(`Pennylane supplier id: ${str(p.supplier_id)}`)
  lines.push("Approving imports the bill and its PDF into Pennylane's accounts payable")

  return Promise.resolve({
    kind: "supplier_invoice_upload",
    title: `Import the bill from ${supplier} into Pennylane`,
    subtitle: "Pending approval, books a supplier invoice in Pennylane",
    lines,
  })
}

/**
 * Summary for pennylane `webhooks_setup`: what gets subscribed and where. The signing secret
 * Pennylane returns is never part of the card (it is kept by the kernel).
 */
export function summarizeWebhooksSetup(params: unknown): Promise<ApprovalSummaryShape> {
  const p = isRec(params) ? params : {}
  const base = str(p.callback_base_url)
  return Promise.resolve({
    kind: "webhooks_setup",
    title: "Subscribe Pennylane e-invoicing events",
    subtitle: "Status changes of sent e-invoices and received supplier e-invoices",
    lines: [
      base ? `Callback base address: ${base}` : "Callback base address: the one recorded when Pennylane was connected",
      "Replaces an earlier subscription to the same address",
      "Pennylane's signing secret is kept by Liaison and never shown",
    ],
  })
}
