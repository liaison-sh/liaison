// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Factur-X input from a document as persisted (or about to be persisted at issue): the document's
// own snapshot columns (regime, buyer identity, structured billing / delivery, category, payment
// state, FX) are the only source. Nothing is recomputed from current contact or issuer data
// except the issuer profile, which is the seller's identity at issue time.

import { FacturxBuildError, type FacturxInput, type FacturxLine, type OperationCategory, type PaymentState } from "./cii"

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
  return (type === "invoice" || type === "credit_note") && f.regime === "e_invoice" && f.internal_cancellation !== true
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

export function facturxInputFrom(src: FacturxSource): FacturxInput {
  const d = flatDocument(src.doc)
  const i = src.issuer
  const category = str(d.operation_category) as OperationCategory | null
  if (!category) {
    throw new FacturxBuildError("facturx_data_missing", "The document has no operation category (goods, services or mixed).")
  }
  const number = str(d.number)
  const issueDate = dateOnly(d.issued_at)
  if (!number || !issueDate) throw new FacturxBuildError("facturx_data_missing", "The document has no number or issue date.")
  const stored = str(d.payment_state) as PaymentState | null
  // Credit notes always emit x1; an invoice born paid (order-paid flow) is x2. Only the state
  // recorded AT ISSUE counts: the current payment_status is a later fact (a Factur-X first
  // rendered after a mark-paid still describes an invoice that was due when issued).
  const paymentState: PaymentState = src.type === "credit_note" ? "due" : (stored ?? "due")
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
    seller: {
      legal_name: String(i.legal_name ?? ""),
      siren: str(i.siren),
      routing_address: str(i.routing_address),
      vat_id: str(i.vat_id),
      address: {
        line1: str(i.address_line1),
        line2: str(i.address_line2),
        postcode: str(i.postcode),
        city: str(i.city),
        country_code: str(i.country_code) ?? str(i.country),
      },
    },
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
    original:
      src.type === "credit_note" && src.original?.number && src.original.issue_date
        ? { number: src.original.number, issue_date: src.original.issue_date }
        : null,
    tax_total_eur_minor: d.tax_total_eur_minor == null || d.tax_total_eur_minor === "" ? null : big(d.tax_total_eur_minor),
    lines,
    subtotal_minor: big(d.subtotal_minor),
    tax_total_minor: big(d.tax_total_minor),
    grand_total_minor: big(d.grand_total_minor),
  }
}
