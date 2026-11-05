// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The business terms a received supplier e-invoice states about itself, read from its original
// XML (UN/CEFACT CII, or UBL Invoice / CreditNote) through the safe reader. Used to show the
// file's own figures beside the provider's and to flag any difference; never rendered.
import { child, children, parseXmlSafe, text, type XmlElement, type XmlLimits } from "./xml"

export interface ReceivedFileFacts {
  format: "cii" | "ubl"
  invoice_number: string | null
  type_code: string | null
  issue_date: string | null
  due_date: string | null
  currency: string | null
  seller: { name: string | null; siren: string | null; vat_id: string | null }
  totals: { before_tax: string | null; tax: string | null; total: string | null }
}

/** CII format 102 (YYYYMMDD) → YYYY-MM-DD; an ISO date is kept. */
function isoDate(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  return null
}

function amount(v: string | null): string | null {
  if (!v) return null
  const t = v.trim()
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null
}

function sirenFrom(ids: XmlElement[]): string | null {
  for (const id of ids) {
    const v = id.text.trim()
    if (id.attrs.schemeID === "0002" && /^\d{9}$/.test(v)) return v
    if (id.attrs.schemeID === "0009" && /^\d{14}$/.test(v)) return v.slice(0, 9)
  }
  return null
}

function fromCii(root: XmlElement): ReceivedFileFacts {
  const doc = child(root, "ExchangedDocument")
  const tx = child(root, "SupplyChainTradeTransaction")
  const seller = child(tx, "ApplicableHeaderTradeAgreement", "SellerTradeParty")
  const settlement = child(tx, "ApplicableHeaderTradeSettlement")
  const currency = text(settlement, "InvoiceCurrencyCode")
  const sum = child(settlement, "SpecifiedTradeSettlementHeaderMonetarySummation")
  // BT-110 is the TaxTotalAmount in the invoice currency (a second one may carry BT-111 in EUR).
  const taxes = children(sum, "TaxTotalAmount")
  const tax = taxes.find((t) => !t.attrs.currencyID || t.attrs.currencyID === currency) ?? taxes[0]
  const vat = children(seller, "SpecifiedTaxRegistration")
    .map((r) => child(r, "ID"))
    .find((id) => id && (id.attrs.schemeID ?? "VA") === "VA")
  return {
    format: "cii",
    invoice_number: text(doc, "ID"),
    type_code: text(doc, "TypeCode"),
    issue_date: isoDate(text(doc, "IssueDateTime", "DateTimeString")),
    due_date: isoDate(text(settlement, "SpecifiedTradePaymentTerms", "DueDateDateTime", "DateTimeString")),
    currency,
    seller: {
      name: text(seller, "Name"),
      siren: sirenFrom(children(child(seller, "SpecifiedLegalOrganization"), "ID")),
      vat_id: vat?.text.trim() || null,
    },
    totals: {
      before_tax: amount(text(sum, "TaxBasisTotalAmount")),
      tax: amount(tax?.text ?? null),
      total: amount(text(sum, "GrandTotalAmount")),
    },
  }
}

function fromUbl(root: XmlElement): ReceivedFileFacts {
  const party = child(root, "AccountingSupplierParty", "Party")
  const legal = child(party, "PartyLegalEntity")
  const currency = text(root, "DocumentCurrencyCode")
  const totals = child(root, "LegalMonetaryTotal")
  const taxTotal = children(root, "TaxTotal")
    .map((t) => child(t, "TaxAmount"))
    .find((a) => a && (!a.attrs.currencyID || a.attrs.currencyID === currency))
  return {
    format: "ubl",
    invoice_number: text(root, "ID"),
    type_code: text(root, root.name === "CreditNote" ? "CreditNoteTypeCode" : "InvoiceTypeCode"),
    issue_date: isoDate(text(root, "IssueDate")),
    due_date: isoDate(text(root, "DueDate") ?? text(root, "PaymentMeans", "PaymentDueDate")),
    currency,
    seller: {
      name: text(legal, "RegistrationName") ?? text(party, "PartyName", "Name"),
      siren: sirenFrom(children(legal, "CompanyID")),
      vat_id: text(party, "PartyTaxScheme", "CompanyID"),
    },
    totals: {
      before_tax: amount(text(totals, "TaxExclusiveAmount")),
      tax: amount(taxTotal?.text ?? null),
      total: amount(text(totals, "TaxInclusiveAmount")),
    },
  }
}

export type ExtractOutcome =
  | { ok: true; facts: ReceivedFileFacts }
  | { ok: false; code: string; message: string }

/** Read the facts of a CII or UBL document. Refusals (DTD, entities, size, time) are outcomes. */
export function extractReceivedFacts(xml: string, limits?: Partial<XmlLimits>): ExtractOutcome {
  let root: XmlElement
  try {
    root = parseXmlSafe(xml, limits)
  } catch (e) {
    const code = (e as { code?: string }).code ?? "xml_malformed"
    return { ok: false, code, message: e instanceof Error ? e.message : String(e) }
  }
  if (root.name === "CrossIndustryInvoice") return { ok: true, facts: fromCii(root) }
  if (root.name === "Invoice" || root.name === "CreditNote") return { ok: true, facts: fromUbl(root) }
  return { ok: false, code: "xml_not_an_invoice", message: `root element ${root.name} is neither CII nor UBL` }
}

/** Fields where the file and the provider disagree (amounts compared to the cent). */
export function totalsDiffer(
  provider: { before_tax: string | null; tax: string | null; total: string | null },
  file: { before_tax: string | null; tax: string | null; total: string | null },
): string[] {
  const out: string[] = []
  for (const k of ["before_tax", "tax", "total"] as const) {
    const a = provider[k]
    const b = file[k]
    if (a === null || b === null) continue
    if (Math.round(Number(a) * 100) !== Math.round(Number(b) * 100)) out.push(k)
  }
  return out
}
