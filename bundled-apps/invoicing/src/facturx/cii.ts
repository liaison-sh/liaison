// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Factur-X XML builder: UN/CEFACT CII D22B, profile EN 16931, with the French rules (XP Z12-012 as
// implemented by the FNFE BR-FR schematron). Pure and deterministic: the same input always yields
// the same bytes, so the XML embedded in the legal original can be rebuilt and compared.
//
// What it emits (EN 16931 business terms):
//   BT-23 business process (category x payment state, nine codes), BT-24 EN 16931 guideline,
//   BT-1/BT-3/BT-2, BAR note `B2B` (always), PMT/PMD/AAB payment notes, seller BT-27/BT-30 (SIREN,
//   scheme 0002)/BT-31/BT-34 (scheme 0225) and structured BT-35..40, buyer BT-44/BT-47 (SIREN,
//   0002)/BT-48/BT-49 (0225) and structured BT-50..55, BG-15 delivery when
//   it differs from billing (BT-13, the buyer's purchase order, is deliberately not carried: it
//   stays amendable on the document after issue), BT-6 + BT-111 when the invoice currency is not EUR, BG-16 bank
//   transfer when an IBAN is known, BG-23 per-rate VAT breakdown with BT-8 = 5 when the seller opted
//   for VAT on debits (BT-7 never emitted), BT-9 due date (payment date for an already-paid
//   document), BT-25/BT-26 on credit notes, and lines BG-25.
//
// Never emitted: spaces inside numbers, type code 262, BT-7.
//
// Signs: the document type carries the direction. A credit note (381) is written with POSITIVE
// amounts even when it is stored with negative lines (the usual shape of a refund, cancellation,
// reissue or hand-made correction): its lines, VAT breakdown and totals are negated before
// emission. An item net price (BT-146) is never negative (BR-27, BR-FR-DEC-03); a line that still
// reduces the total carries the sign on its quantity instead. See `normalizeSigns`.
//
// Failures throw `FacturxBuildError` with a stable code; the caller (issue) turns that into
// `pdf_status = facturx_failed` and an attention item rather than a half-built legal original.

import { currencyExponent } from "../money"
import { type VatGroup, vatBreakdown, vatCategory } from "./vat-breakdown"

export type FacturxDocType = "invoice" | "credit_note"
export type OperationCategory = "goods" | "services" | "mixed"
export type PaymentState = "due" | "paid" | "final_after_deposit"

export interface FacturxAddress {
  line1: string | null
  line2?: string | null
  postcode: string | null
  city: string | null
  country_code: string | null
}

export interface FacturxParty {
  legal_name: string
  siren: string | null
  /** PA routing address (scheme 0225); defaults to the SIREN. */
  routing_address?: string | null
  vat_id?: string | null
  address: FacturxAddress
}

export interface FacturxLine {
  position: number
  description: string
  /** Decimal quantity as stored (e.g. "2", "1.5"). */
  quantity: string
  unit_price_minor: bigint
  discount_minor: bigint
  tax_rate_bp: number
  subtotal_minor: bigint
  tax_minor: bigint
}

export interface FacturxInput {
  type: FacturxDocType
  number: string
  /** YYYY-MM-DD */
  issue_date: string
  due_date: string | null
  currency: string
  operation_category: OperationCategory
  payment_state: PaymentState
  /** Payment date for an already-paid document (BT-9 must equal it, BR-FR-CO-09). */
  paid_date?: string | null
  vat_on_debits: boolean
  tax_treatment: string | null
  /** Legal mention text: the exemption reason of a zero-rated (E) group. */
  exemption_reason?: string | null
  seller: FacturxParty
  buyer: FacturxParty
  delivery?: (FacturxAddress & { name?: string | null }) | null
  po_number?: string | null
  iban?: string | null
  bic?: string | null
  /** Credit notes: the invoice they correct. */
  original?: { number: string; issue_date: string } | null
  /** Non-EUR: VAT total in EUR minor units at the stored ECB rate. */
  tax_total_eur_minor?: bigint | null
  lines: FacturxLine[]
  subtotal_minor: bigint
  tax_total_minor: bigint
  grand_total_minor: bigint
}

export type FacturxBuildErrorCode =
  | "facturx_unsupported_type"
  | "facturx_seller_incomplete"
  | "facturx_buyer_incomplete"
  | "facturx_fx_missing"
  | "facturx_original_missing"
  | "facturx_totals_inconsistent"
  | "facturx_no_lines"
  | "facturx_data_missing"

export class FacturxBuildError extends Error {
  readonly code: FacturxBuildErrorCode
  constructor(code: FacturxBuildErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "FacturxBuildError"
  }
}

/** Dated payment-terms notes required on every French B2B invoice (BR-FR-05, Code de commerce
 *  L441-10). Wording pending the accountant's review. */
export const PAYMENT_NOTES = {
  PMT: "Indemnité forfaitaire pour frais de recouvrement en cas de retard de paiement : 40 €.",
  PMD:
    "En cas de retard de paiement, des pénalités sont exigibles au taux de la Banque centrale européenne " +
    "majoré de 10 points.",
  AAB: "Pas d'escompte pour paiement anticipé.",
} as const

const CATEGORY_LETTER: Record<OperationCategory, string> = { goods: "B", services: "S", mixed: "M" }
const PAYMENT_DIGIT: Record<PaymentState, string> = {
  due: "1",
  paid: "2",
  final_after_deposit: "4",
}

/** BT-23: one of B1 S1 M1 B2 S2 M2 B4 S4 M4. */
export function businessProcessCode(category: OperationCategory, state: PaymentState): string {
  return `${CATEGORY_LETTER[category]}${PAYMENT_DIGIT[state]}`
}

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** Minor units → decimal string with the currency's exponent; no spaces, no grouping. */
export function amount(minor: bigint, exponent: number): string {
  const neg = minor < 0n
  const abs = neg ? -minor : minor
  if (exponent === 0) return `${neg ? "-" : ""}${abs.toString()}`
  const s = abs.toString().padStart(exponent + 1, "0")
  return `${neg ? "-" : ""}${s.slice(0, -exponent)}.${s.slice(-exponent)}`
}

function percent(bp: number): string {
  const whole = Math.trunc(bp / 100)
  const frac = Math.abs(bp % 100)
  return `${whole}.${frac.toString().padStart(2, "0")}`
}

function quantity(q: string): string {
  const t = q.trim()
  if (!/^-?\d+(\.\d+)?$/.test(t))
    throw new FacturxBuildError("facturx_totals_inconsistent", `quantity ${q} is not a decimal`)
  return t
}

function negateQuantity(q: string): string {
  const t = q.trim()
  return t.startsWith("-") ? t.slice(1) : `-${t}`
}

/**
 * The document as the CII must carry it. A credit note whose total is negative is negated
 * whole (lines, line taxes, totals, the EUR VAT total): BT-3 = 381 already says "credit", and a
 * 381 with negative totals would read as a debit. Then, on any document, a line with a negative
 * unit price moves the sign to its quantity (price and quantity both negated, the line amount is
 * unchanged), and a line with a negative quantity alone keeps it: EN 16931 allows a negative
 * BT-129 but never a negative BT-146. A negative line discount becomes a line charge at emission.
 */
export function normalizeSigns(input: FacturxInput): FacturxInput {
  const flip = input.type === "credit_note" && input.grand_total_minor < 0n
  const lines = input.lines.map((l) => {
    let line = flip
      ? {
          ...l,
          unit_price_minor: -l.unit_price_minor,
          discount_minor: -l.discount_minor,
          subtotal_minor: -l.subtotal_minor,
          tax_minor: -l.tax_minor,
        }
      : { ...l }
    if (line.unit_price_minor < 0n) {
      line = {
        ...line,
        unit_price_minor: -line.unit_price_minor,
        quantity: negateQuantity(line.quantity),
      }
    }
    return line
  })
  if (!flip) return { ...input, lines }
  const eur = input.tax_total_eur_minor
  return {
    ...input,
    lines,
    subtotal_minor: -input.subtotal_minor,
    tax_total_minor: -input.tax_total_minor,
    grand_total_minor: -input.grand_total_minor,
    tax_total_eur_minor: eur == null ? eur : eur < 0n ? -eur : eur,
  }
}

/**
 * Structural preconditions every emitted CII must meet. These are the fatal EN 16931 / BR-FR
 * rules the builder's own arithmetic decides (the full XSD + schematron run is a test-time check:
 * it needs an XSLT 3 engine the app sandbox does not have). A breach refuses the build, so the
 * caller parks the document in `facturx_failed` and no non-conformant legal original is stored.
 */
function assertPreconditions(input: FacturxInput): void {
  for (const l of input.lines) {
    if (l.unit_price_minor < 0n) {
      throw new FacturxBuildError(
        "facturx_totals_inconsistent",
        `BR-27: line ${l.position + 1} has a negative item net price`,
      )
    }
  }
  if (input.type === "credit_note" && input.grand_total_minor < 0n) {
    throw new FacturxBuildError(
      "facturx_totals_inconsistent",
      "BT-3: a credit note must carry a positive total once normalised",
    )
  }
}

function date102(iso: string): string {
  const d = iso.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d))
    throw new FacturxBuildError("facturx_totals_inconsistent", `date ${iso} is not YYYY-MM-DD`)
  return d.replace(/-/g, "")
}

function blank(v: string | null | undefined): boolean {
  return v == null || v.trim() === ""
}

function el(name: string, value: string | null | undefined, attrs = ""): string {
  if (value == null || value === "") return ""
  return `<${name}${attrs}>${xmlEscape(value)}</${name}>`
}

function note(subject: string, content: string): string {
  return `<ram:IncludedNote><ram:Content>${xmlEscape(content)}</ram:Content><ram:SubjectCode>${subject}</ram:SubjectCode></ram:IncludedNote>`
}

function address(a: FacturxAddress): string {
  return (
    "<ram:PostalTradeAddress>" +
    el("ram:PostcodeCode", a.postcode) +
    el("ram:LineOne", a.line1) +
    el("ram:LineTwo", a.line2 ?? null) +
    el("ram:CityName", a.city) +
    el("ram:CountryID", (a.country_code ?? "").toUpperCase()) +
    "</ram:PostalTradeAddress>"
  )
}

function party(p: FacturxParty): string {
  const routing = (p.routing_address ?? "").trim() || (p.siren ?? "")
  return (
    el("ram:Name", p.legal_name) +
    (p.siren
      ? `<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">${xmlEscape(p.siren)}</ram:ID></ram:SpecifiedLegalOrganization>`
      : "") +
    address(p.address) +
    (routing
      ? `<ram:URIUniversalCommunication><ram:URIID schemeID="0225">${xmlEscape(routing)}</ram:URIID></ram:URIUniversalCommunication>`
      : "") +
    (p.vat_id && p.vat_id.trim()
      ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEscape(p.vat_id.replace(/\s+/g, "").toUpperCase())}</ram:ID></ram:SpecifiedTaxRegistration>`
      : "")
  )
}

function checkParty(
  p: FacturxParty,
  code: "facturx_seller_incomplete" | "facturx_buyer_incomplete",
  who: string,
): void {
  const missing: string[] = []
  if (blank(p.legal_name)) missing.push("legal name")
  if (blank(p.siren) || !/^\d{9}$/.test((p.siren ?? "").trim())) missing.push("SIREN")
  if (blank(p.address.line1)) missing.push("address line")
  if (blank(p.address.postcode)) missing.push("postcode")
  if (blank(p.address.city)) missing.push("city")
  if (blank(p.address.country_code)) missing.push("country code")
  if (missing.length) throw new FacturxBuildError(code, `${who} is missing: ${missing.join(", ")}`)
}

function taxGroup(g: VatGroup, exp: number, input: FacturxInput, header: boolean): string {
  const exemption =
    g.category === "E" || g.category === "AE" || g.category === "G" || g.category === "K"
      ? (input.exemption_reason ?? "").trim() || defaultExemption(g.category)
      : null
  return (
    "<ram:ApplicableTradeTax>" +
    (header ? `<ram:CalculatedAmount>${amount(g.tax_minor, exp)}</ram:CalculatedAmount>` : "") +
    "<ram:TypeCode>VAT</ram:TypeCode>" +
    (header && exemption ? el("ram:ExemptionReason", exemption) : "") +
    (header ? `<ram:BasisAmount>${amount(g.basis_minor, exp)}</ram:BasisAmount>` : "") +
    `<ram:CategoryCode>${g.category}</ram:CategoryCode>` +
    // BT-8 = 5 ("date of invoice") carries the VAT-on-debits option; BT-7 is never emitted with it.
    (header && input.vat_on_debits ? "<ram:DueDateTypeCode>5</ram:DueDateTypeCode>" : "") +
    `<ram:RateApplicablePercent>${percent(g.rate_bp)}</ram:RateApplicablePercent>` +
    "</ram:ApplicableTradeTax>"
  )
}

function defaultExemption(cat: string): string {
  switch (cat) {
    case "AE":
      return "Autoliquidation"
    case "G":
      return "Exonération de TVA, article 262 I du CGI"
    case "K":
      return "Exonération de TVA, article 262 ter I du CGI"
    default:
      return "Exonération de TVA"
  }
}

export function buildCii(raw: FacturxInput): string {
  if (raw.type !== "invoice" && raw.type !== "credit_note") {
    throw new FacturxBuildError("facturx_unsupported_type", `no Factur-X for ${String(raw.type)}`)
  }
  for (const l of raw.lines) quantity(l.quantity)
  const input = normalizeSigns(raw)
  if (input.lines.length === 0)
    throw new FacturxBuildError("facturx_no_lines", "a Factur-X needs at least one line")
  checkParty(input.seller, "facturx_seller_incomplete", "The seller (issuer profile)")
  checkParty(input.buyer, "facturx_buyer_incomplete", "The buyer")
  const currency = input.currency.toUpperCase()
  const exp = currencyExponent(currency)
  const nonEur = currency !== "EUR"
  if (nonEur && input.tax_total_eur_minor == null) {
    throw new FacturxBuildError(
      "facturx_fx_missing",
      `A ${currency} e-invoice needs its VAT total in EUR at the ECB rate, and no rate is stored on the document.`,
    )
  }
  if (
    input.type === "credit_note" &&
    (!input.original || blank(input.original.number) || blank(input.original.issue_date))
  ) {
    throw new FacturxBuildError(
      "facturx_original_missing",
      "A credit note needs the number and issue date of the invoice it corrects.",
    )
  }

  const groups = vatBreakdown(input.lines, input.tax_treatment)
  const lineTotal = input.lines.reduce((s, l) => s + l.subtotal_minor, 0n)
  const taxTotal = groups.reduce((s, g) => s + g.tax_minor, 0n)
  if (
    lineTotal !== input.subtotal_minor ||
    taxTotal !== input.tax_total_minor ||
    lineTotal + taxTotal !== input.grand_total_minor
  ) {
    throw new FacturxBuildError(
      "facturx_totals_inconsistent",
      `document totals (${input.subtotal_minor}/${input.tax_total_minor}/${input.grand_total_minor}) do not match its lines (${lineTotal}/${taxTotal})`,
    )
  }
  assertPreconditions(input)
  const paid = input.payment_state === "paid"
  const prepaid = paid ? input.grand_total_minor : 0n
  const duePayable = input.grand_total_minor - prepaid
  const dueDate = paid ? (input.paid_date ?? input.issue_date) : input.due_date

  const lines = input.lines
    .map((l, i) => {
      const cat = vatCategory(l.tax_rate_bp, input.tax_treatment)
      return (
        "<ram:IncludedSupplyChainTradeLineItem>" +
        `<ram:AssociatedDocumentLineDocument><ram:LineID>${i + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>` +
        `<ram:SpecifiedTradeProduct>${el("ram:Name", l.description.trim() || `Line ${i + 1}`)}</ram:SpecifiedTradeProduct>` +
        "<ram:SpecifiedLineTradeAgreement>" +
        `<ram:NetPriceProductTradePrice><ram:ChargeAmount>${amount(l.unit_price_minor, exp)}</ram:ChargeAmount></ram:NetPriceProductTradePrice>` +
        "</ram:SpecifiedLineTradeAgreement>" +
        `<ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="C62">${quantity(l.quantity)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>` +
        "<ram:SpecifiedLineTradeSettlement>" +
        taxGroup(
          { category: cat, rate_bp: l.tax_rate_bp, basis_minor: 0n, tax_minor: 0n },
          exp,
          input,
          false,
        ) +
        (l.discount_minor > 0n
          ? "<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>false</udt:Indicator></ram:ChargeIndicator>" +
            `<ram:ActualAmount>${amount(l.discount_minor, exp)}</ram:ActualAmount><ram:Reason>Remise</ram:Reason></ram:SpecifiedTradeAllowanceCharge>`
          : l.discount_minor < 0n
            ? "<ram:SpecifiedTradeAllowanceCharge><ram:ChargeIndicator><udt:Indicator>true</udt:Indicator></ram:ChargeIndicator>" +
              `<ram:ActualAmount>${amount(-l.discount_minor, exp)}</ram:ActualAmount><ram:Reason>Ajustement</ram:Reason></ram:SpecifiedTradeAllowanceCharge>`
            : "") +
        `<ram:SpecifiedTradeSettlementLineMonetarySummation><ram:LineTotalAmount>${amount(l.subtotal_minor, exp)}</ram:LineTotalAmount></ram:SpecifiedTradeSettlementLineMonetarySummation>` +
        "</ram:SpecifiedLineTradeSettlement>" +
        "</ram:IncludedSupplyChainTradeLineItem>"
      )
    })
    .join("")

  const delivery =
    input.delivery && !blank(input.delivery.line1)
      ? "<ram:ShipToTradeParty>" +
        el("ram:Name", input.delivery.name ?? input.buyer.legal_name) +
        address(input.delivery) +
        "</ram:ShipToTradeParty>"
      : ""

  const paymentMeans =
    input.iban && input.iban.trim()
      ? "<ram:SpecifiedTradeSettlementPaymentMeans><ram:TypeCode>58</ram:TypeCode>" +
        `<ram:PayeePartyCreditorFinancialAccount><ram:IBANID>${xmlEscape(input.iban.replace(/\s+/g, "").toUpperCase())}</ram:IBANID></ram:PayeePartyCreditorFinancialAccount>` +
        (input.bic && input.bic.trim()
          ? `<ram:PayeeSpecifiedCreditorFinancialInstitution><ram:BICID>${xmlEscape(input.bic.replace(/\s+/g, "").toUpperCase())}</ram:BICID></ram:PayeeSpecifiedCreditorFinancialInstitution>`
          : "") +
        "</ram:SpecifiedTradeSettlementPaymentMeans>"
      : ""

  const header =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" ' +
    'xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100" ' +
    'xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" ' +
    'xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">' +
    "<rsm:ExchangedDocumentContext>" +
    `<ram:BusinessProcessSpecifiedDocumentContextParameter><ram:ID>${businessProcessCode(input.operation_category, input.payment_state)}</ram:ID></ram:BusinessProcessSpecifiedDocumentContextParameter>` +
    "<ram:GuidelineSpecifiedDocumentContextParameter><ram:ID>urn:cen.eu:en16931:2017</ram:ID></ram:GuidelineSpecifiedDocumentContextParameter>" +
    "</rsm:ExchangedDocumentContext>" +
    "<rsm:ExchangedDocument>" +
    el("ram:ID", input.number.replace(/\s+/g, "")) +
    `<ram:TypeCode>${input.type === "credit_note" ? "381" : "380"}</ram:TypeCode>` +
    `<ram:IssueDateTime><udt:DateTimeString format="102">${date102(input.issue_date)}</udt:DateTimeString></ram:IssueDateTime>` +
    note("BAR", "B2B") +
    note("PMT", PAYMENT_NOTES.PMT) +
    note("PMD", PAYMENT_NOTES.PMD) +
    note("AAB", PAYMENT_NOTES.AAB) +
    (input.vat_on_debits
      ? note("TXD", "Option pour le paiement de la taxe d'après les débits")
      : "") +
    "</rsm:ExchangedDocument>"

  const agreement =
    "<ram:ApplicableHeaderTradeAgreement>" +
    `<ram:SellerTradeParty>${party(input.seller)}</ram:SellerTradeParty>` +
    `<ram:BuyerTradeParty>${party(input.buyer)}</ram:BuyerTradeParty>` +
    "</ram:ApplicableHeaderTradeAgreement>"

  const settlement =
    "<ram:ApplicableHeaderTradeSettlement>" +
    (nonEur ? "<ram:TaxCurrencyCode>EUR</ram:TaxCurrencyCode>" : "") +
    `<ram:InvoiceCurrencyCode>${currency}</ram:InvoiceCurrencyCode>` +
    paymentMeans +
    groups.map((g) => taxGroup(g, exp, input, true)).join("") +
    (dueDate
      ? `<ram:SpecifiedTradePaymentTerms><ram:DueDateDateTime><udt:DateTimeString format="102">${date102(dueDate)}</udt:DateTimeString></ram:DueDateDateTime></ram:SpecifiedTradePaymentTerms>`
      : "") +
    "<ram:SpecifiedTradeSettlementHeaderMonetarySummation>" +
    `<ram:LineTotalAmount>${amount(lineTotal, exp)}</ram:LineTotalAmount>` +
    `<ram:TaxBasisTotalAmount>${amount(lineTotal, exp)}</ram:TaxBasisTotalAmount>` +
    `<ram:TaxTotalAmount currencyID="${currency}">${amount(taxTotal, exp)}</ram:TaxTotalAmount>` +
    (nonEur
      ? `<ram:TaxTotalAmount currencyID="EUR">${amount(input.tax_total_eur_minor as bigint, 2)}</ram:TaxTotalAmount>`
      : "") +
    `<ram:GrandTotalAmount>${amount(input.grand_total_minor, exp)}</ram:GrandTotalAmount>` +
    `<ram:TotalPrepaidAmount>${amount(prepaid, exp)}</ram:TotalPrepaidAmount>` +
    `<ram:DuePayableAmount>${amount(duePayable, exp)}</ram:DuePayableAmount>` +
    "</ram:SpecifiedTradeSettlementHeaderMonetarySummation>" +
    (input.type === "credit_note" && input.original
      ? "<ram:InvoiceReferencedDocument>" +
        el("ram:IssuerAssignedID", input.original.number.replace(/\s+/g, "")) +
        `<ram:FormattedIssueDateTime><qdt:DateTimeString format="102">${date102(input.original.issue_date)}</qdt:DateTimeString></ram:FormattedIssueDateTime>` +
        "</ram:InvoiceReferencedDocument>"
      : "") +
    "</ram:ApplicableHeaderTradeSettlement>"

  return (
    header +
    "<rsm:SupplyChainTradeTransaction>" +
    lines +
    agreement +
    `<ram:ApplicableHeaderTradeDelivery>${delivery}</ram:ApplicableHeaderTradeDelivery>` +
    settlement +
    "</rsm:SupplyChainTradeTransaction>" +
    "</rsm:CrossIndustryInvoice>"
  )
}
