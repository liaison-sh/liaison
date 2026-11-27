// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Factur-X input from a document as persisted (or about to be persisted at issue): the document's
// own snapshot columns (regime, buyer identity, structured billing / delivery, category, payment
// state, FX) are the only source. Nothing is recomputed from current contact or issuer data
// except the issuer profile, which is the seller's identity at issue time.

import { sirenFromFrVat } from "../einvoicing/identity"
import {
  FacturxBuildError,
  type FacturxInput,
  type FacturxLine,
  type FacturxParty,
  type OperationCategory,
  type PaymentState,
} from "./cii"

type Row = Record<string, unknown>

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

function dateOnly(v: unknown): string | null {
  const s = v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null
  return m ? (m[1] as string) : null
}

function big(v: unknown): bigint {
  if (typeof v === "bigint") return v
  if (typeof v === "number") return BigInt(Math.round(v))
  if (typeof v === "string" && v.trim() !== "") return BigInt(v.trim())
  return 0n
}

/** The document's columns with the issue-time e-invoicing snapshot (`einvoice`) flattened in. */
export function flatDocument(doc: Row): Row {
  const nested = doc.einvoice && typeof doc.einvoice === "object" ? (doc.einvoice as Row) : {}
  return { ...doc, ...nested }
}

/** A Factur-X is produced for invoices and credit notes in the e_invoice regime, except an
 *  internal cancellation (a credit note against a refused original is booked, never sent). */
export function facturxEligible(type: string, doc: Row): boolean {
  const f = flatDocument(doc)
  return (
    (type === "invoice" || type === "credit_note") &&
    f.regime === "e_invoice" &&
    f.internal_cancellation !== true
  )
}

/** A final after deposit: the advance invoices it deducts, as its draft recorded them. */
function precedingOf(doc: Row): Array<{ number: string; issue_date: string }> | null {
  const refs = doc.external_refs as Row | null | undefined
  const list =
    refs && Array.isArray(refs.preceding_invoices) ? (refs.preceding_invoices as Row[]) : []
  const out = list
    .filter(
      (p) =>
        typeof p.number === "string" && typeof p.issue_date === "string" && p.issue_date !== "",
    )
    .map((p) => ({ number: String(p.number), issue_date: String(p.issue_date) }))
  return out.length ? out : null
}

export interface FacturxSource {
  type: "invoice" | "credit_note"
  doc: Row
  lines: Array<{
    position: number
    description: string
    quantity: string
    unit_price_minor: unknown
    discount_minor?: unknown
    tax_rate_bp: number
    subtotal_minor: unknown
    tax_minor: unknown
  }>
  issuer: Row
  /** Credit notes: the corrected invoice's number and issue date. */
  original?: { number: string | null; issue_date: string | null } | null
  /** The legal mention printed on the PDF (exemption reason of a zero-rated group). */
  legalMention?: string | null
}

/** The seller of a Factur-X: the issuer profile as it stands at issue time. With no SIREN on
 *  file, a French VAT number carries it (FR, a 2-digit key, the 9-digit SIREN). */
export function facturxSellerFrom(i: Row): FacturxParty {
  return {
    legal_name: String(i.legal_name ?? ""),
    siren:
      str(i.siren) ??
      sirenFromFrVat(str(i.vat_id), { billingCountry: str(i.country_code) ?? str(i.country) }),
    routing_address: str(i.routing_address),
    vat_id: str(i.vat_id),
    address: {
      line1: str(i.address_line1),
      line2: str(i.address_line2),
      postcode: str(i.postcode),
      city: str(i.city),
      country_code: str(i.country_code) ?? str(i.country),
    },
  }
}

export function facturxInputFrom(src: FacturxSource): FacturxInput {
  const d = flatDocument(src.doc)
  const i = src.issuer
  const category = str(d.operation_category) as OperationCategory | null
  if (!category) {
    throw new FacturxBuildError(
      "facturx_data_missing",
      "The document has no operation category (goods, services or mixed).",
    )
  }
  const number = str(d.number)
  const issueDate = dateOnly(d.issued_at)
  if (!number || !issueDate)
    throw new FacturxBuildError("facturx_data_missing", "The document has no number or issue date.")
  const stored = str(d.payment_state) as PaymentState | null
  // Credit notes always emit x1; an invoice born paid (order-paid flow) is x2. Only the state
  // recorded AT ISSUE counts: the current payment_status is a later fact (a Factur-X first
  // rendered after a mark-paid still describes an invoice that was due when issued).
  const paymentState: PaymentState = src.type === "credit_note" ? "due" : (stored ?? "due")
  // The service month a document bills (planned vs done, a retainer month, a schedule run): every
  // line states it, and so does the document.
  // At issue the columns are still nested under the insert's `source`; read back they are flat.
  const source = d.source && typeof d.source === "object" ? (d.source as Row) : {}
  const periodStart = dateOnly(d.service_period_start ?? source.service_period_start)
  const periodEnd = dateOnly(d.service_period_end ?? source.service_period_end)
  const servicePeriod =
    periodStart && periodEnd && periodStart <= periodEnd
      ? { start: periodStart, end: periodEnd }
      : null
  const lines: FacturxLine[] = [...src.lines]
    .sort((a, b) => a.position - b.position)
    .map((l) => ({
      position: l.position,
      description: l.description,
      quantity: String(l.quantity),
      unit_price_minor: big(l.unit_price_minor),
      discount_minor: big(l.discount_minor),
      tax_rate_bp: Number(l.tax_rate_bp),
      subtotal_minor: big(l.subtotal_minor),
      tax_minor: big(l.tax_minor),
      period: servicePeriod,
    }))
  const deliveryLine = str(d.delivery_line1)
  return {
    type: src.type,
    number,
    issue_date: issueDate,
    due_date: dateOnly(d.due_at),
    currency: String(d.currency ?? "EUR"),
    operation_category: category,
    payment_state: paymentState,
    paid_date: dateOnly(d.paid_at),
    vat_on_debits: d.vat_on_debits === true,
    tax_treatment: str(d.tax_treatment),
    exemption_reason: src.legalMention ?? null,
    seller: facturxSellerFrom(i),
    buyer: {
      legal_name: str(d.buyer_legal_name) ?? String(d.counterparty_name ?? ""),
      siren: str(d.buyer_siren),
      routing_address: str(d.buyer_routing_address),
      vat_id: str(d.counterparty_vat_id),
      address: {
        line1: str(d.billing_line1),
        line2: str(d.billing_line2),
        postcode: str(d.billing_postcode),
        city: str(d.billing_city),
        country_code: str(d.billing_country_code) ?? str(d.counterparty_country),
      },
    },
    delivery: deliveryLine
      ? {
          name: str(d.delivery_name),
          line1: deliveryLine,
          line2: str(d.delivery_line2),
          postcode: str(d.delivery_postcode),
          city: str(d.delivery_city),
          country_code: str(d.delivery_country_code),
        }
      : null,
    po_number: str(d.po_number),
    iban: str(i.iban),
    bic: str(i.swift_bic),
    invoice_role:
      d.invoice_role === "advance" || d.invoice_role === "final" ? d.invoice_role : "standard",
    preceding: src.type === "invoice" ? precedingOf(src.doc) : null,
    original:
      src.type === "credit_note" && src.original?.number && src.original.issue_date
        ? { number: src.original.number, issue_date: src.original.issue_date }
        : null,
    tax_total_eur_minor:
      d.tax_total_eur_minor == null || d.tax_total_eur_minor === ""
        ? null
        : big(d.tax_total_eur_minor),
    service_period: servicePeriod,
    // The sale date, stored only when it differs from the issue date (see issue.ts). At issue it
    // still rides on the insert's `source`; read back it is the flat column.
    supply_date: src.type === "invoice" ? dateOnly(d.supply_date ?? source.supply_date) : null,
    lines,
    subtotal_minor: big(d.subtotal_minor),
    tax_total_minor: big(d.tax_total_minor),
    grand_total_minor: big(d.grand_total_minor),
  }
}
