// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Approval card wording shared by the gated-tool summarizers (summarizers.ts) and the handlers
// that park their own approval (ctx.requestApproval). A card is read by a person deciding
// whether money moves or a legal document changes, so it says what approving DOES in plain
// words: the document by its number and type, the customer by name, money formatted with its
// currency, the order by its store name, and for an edit each changed field as before -> after.
// Never a raw id, a Shopify gid, JSON, a snake_case field name or a minor-unit amount.
//
// Pure (no I/O): summarizers run at gate time, possibly in the empty-bridge sandbox.

import { readMinorAmount } from "@liaison/app-sdk"
import type { BuyerVatFacts } from "./buyer-vat"
import { formatMoneyMinor, lineAmounts } from "./money"
import { type TaxPlan, treatmentWords } from "./tax-plan"

export interface CardLink {
  label: string
  app: string
  entityType: string
  entityId: string
}

export interface ApprovalCard {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
  links?: CardLink[]
}

/** The card holds 8 lines (kernel bound); facts first, so a long line list never pushes them off. */
export const CARD_MAX_LINES = 8

const DOC_TYPE_LABEL: Record<string, string> = {
  invoice: "invoice",
  quote: "quote",
  proforma: "proforma",
  purchase_order: "purchase order",
  credit_note: "credit note",
}

/** "purchase_order" -> "purchase order"; unknown types read as "document". */
export function docTypeLabel(type: unknown): string {
  return typeof type === "string" && DOC_TYPE_LABEL[type] ? DOC_TYPE_LABEL[type]! : "document"
}

export function capitalize(s: string): string {
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s
}

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const GID_RE = /gid:\/\/[A-Za-z]+\/[A-Za-z]+\/\d+(\?[^\s,)]*)?/g

/** True when a value is an opaque handle a person cannot read (uuid or Shopify gid). */
export function isOpaqueId(v: unknown): boolean {
  if (typeof v !== "string") return false
  const s = v.trim()
  return (
    /^gid:\/\//.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  )
}

/** Free text with any uuid or gid taken out (a reason or note an agent wrote may quote one). */
export function scrubIds(text: string): string {
  return text
    .replace(GID_RE, "")
    .replace(UUID_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim()
}

/** Plain text of a value for a card line: trimmed, capped, never "[object Object]". */
export function text(v: unknown, max = 120): string | null {
  if (v === undefined || v === null) return null
  if (typeof v === "object") return null
  const s = scrubIds(String(v)).replace(/\s+/g, " ").trim()
  if (!s) return null
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Minor units as BigInt, read as issuing reads them; null when not a whole number. */
export const toMinor = readMinorAmount

/** "1.00 USD" from minor units; null when the amount is unreadable. */
export function money(minor: unknown, currency: string): string | null {
  const m = toMinor(minor)
  return m === null ? null : formatMoneyMinor(m, currency || "EUR")
}

/** The store's order name ("#3446"), never a gid or numeric API handle. */
export function orderName(number: unknown): string | null {
  if (typeof number !== "string" && typeof number !== "number") return null
  const s = String(number).trim()
  if (!s || isOpaqueId(s)) return null
  return s.startsWith("#") ? s : `#${s}`
}

/** A line quantity as a number (decimal strings tolerated); unreadable -> 1. */
export function qtyOf(v: unknown): number {
  if (v === undefined || v === null || v === "") return 1
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : 1
}

export interface CardLineItem {
  description?: unknown
  quantity?: unknown
  unit_price_minor?: unknown
  discount_minor?: unknown
}

/** "Kestrel 6 x 1 @ 419.40 EUR" (with "less 10.00 EUR" when the line carries a discount). */
export function lineText(l: CardLineItem, currency: string): string {
  const desc = text(l.description, 80) ?? "(no description)"
  const price = money(l.unit_price_minor, currency) ?? "(no price)"
  const disc = toMinor(l.discount_minor)
  const less = disc && disc !== 0n ? `, less ${formatMoneyMinor(disc, currency)}` : ""
  return `${desc} x ${qtyOf(l.quantity)} @ ${price}${less}`
}

/** Sum of quantity x unit price, less line discounts: the pre-tax lines total. */
export function linesTotal(lines: CardLineItem[]): bigint {
  let sum = 0n
  for (const l of lines) {
    try {
      sum += lineAmounts(
        {
          quantity: qtyOf(l.quantity),
          unit_price_minor: toMinor(l.unit_price_minor) ?? 0n,
          discount_minor: toMinor(l.discount_minor) ?? 0n,
        },
        0,
      ).subtotal_minor
    } catch {
      // A quantity that cannot be read is refused at issue; it adds nothing here.
    }
  }
  return sum
}

/** The first line amount issuing would refuse, in words; null when every one can be read. */
export function unreadableLineAmount(lines: CardLineItem[]): string | null {
  for (const [i, l] of lines.entries()) {
    for (const [value, label] of [
      [l.unit_price_minor, "price"],
      [l.discount_minor, "discount"],
    ] as const) {
      const absent =
        value === undefined || value === null || (typeof value === "string" && value.trim() === "")
      if (!absent && toMinor(value) === null) {
        return `the ${label} on line ${i + 1} is ${JSON.stringify(value)}, not a whole number of cents`
      }
    }
  }
  return null
}

/** What a card says when approving cannot issue: no amount, since none would issue. */
function refusedCard(f: IssueCardFacts, type: string, customer: string, why: string): ApprovalCard {
  return finishCard({
    kind: f.kind,
    title: `This ${type} for ${customer} will be refused, nothing would issue`,
    subtitle: "Deny it: the agent has to send the call again with a correct amount",
    lines: [`WARNING: this will be REFUSED and takes no number: ${why}`, `Customer: ${customer}`],
  })
}

/** Up to `max` line texts plus "and N more lines". */
export function lineTexts(lines: CardLineItem[], currency: string, max = 3): string[] {
  const shown = lines.slice(0, max).map((l) => `Line: ${lineText(l, currency)}`)
  const rest = lines.length - shown.length
  if (rest > 0) shown.push(`and ${rest} more line${rest === 1 ? "" : "s"}`)
  return shown
}

/** "YYYY-MM-DD" from an ISO date or date-time; null on anything else. */
export function day(v: unknown): string | null {
  const s = v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1]! : null
}

/** A document the card names: "proforma PRO-2026-0029", or "draft proforma" before numbering. */
export function docName(
  doc: { type?: unknown; number?: unknown; status?: unknown } | null | undefined,
): string {
  const type = docTypeLabel(doc?.type)
  const number = text(doc?.number, 40)
  if (number) return `${type} ${number}`
  return `draft ${type}`
}

/** Link to the document's detail tab (the label is what the person sees). */
export function docLink(id: unknown, label: string): CardLink[] {
  return typeof id === "string" && id.trim() !== ""
    ? [{ label, app: "invoicing", entityType: "detail", entityId: id }]
    : []
}

/** Any value shown on a before -> after line. */
export function shown(v: unknown, max = 80): string {
  if (v === undefined || v === null || v === "") return "(empty)"
  if (typeof v === "boolean") return v ? "yes" : "no"
  if (typeof v === "object") return "(changed)"
  return text(v, max) ?? "(empty)"
}

/** Bound the card the way the kernel will, after scrubbing ids from every visible string. */
export function finishCard(card: ApprovalCard): ApprovalCard {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  return {
    kind: card.kind,
    title: clip(scrubIds(card.title), 200),
    ...(card.subtitle ? { subtitle: clip(scrubIds(card.subtitle), 200) } : {}),
    lines: card.lines
      .map((l) => scrubIds(l))
      .filter((l) => l.length > 0)
      .slice(0, CARD_MAX_LINES)
      .map((l) => clip(l, 200)),
    ...(card.links && card.links.length > 0 ? { links: card.links.slice(0, 10) } : {}),
  }
}

/** The handler-side `requestApproval` shape of a card. */
export function asHandlerSummary(card: ApprovalCard): {
  summary: string
  summary_detail: { subtitle?: string; lines: string[]; links?: CardLink[] }
} {
  const c = finishCard(card)
  return {
    summary: c.title,
    summary_detail: {
      ...(c.subtitle ? { subtitle: c.subtitle } : {}),
      lines: c.lines,
      ...(c.links ? { links: c.links } : {}),
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Issue a document (create-and-issue, or issue a saved draft). One wording for both the kernel
// gate (summarizer) and the handler's threshold gate.
// ---------------------------------------------------------------------------------------------

export interface IssueCardFacts {
  kind: string
  type: string
  /** True when the card issues a saved draft (the number is assigned on issue). */
  fromDraft: boolean
  customer: string | null
  country?: string | null
  currency: string
  lines: CardLineItem[]
  /** The exact total when known (handler gate: lines plus tax). Else the pre-tax lines total. */
  totalMinor?: bigint | null
  orderNumber?: string | null
  draftOrderName?: string | null
  poNumber?: string | null
  /** The customer's id in another system (a CRM record), printed as "Customer ref". */
  customerReference?: string | null
  /** The issue date the caller stated. Nothing stated means the day the number is taken. */
  issuedAt?: string | null
  dueAt?: string | null
  reason?: string | null
  declaredValueMinor?: unknown
  issuerName?: string | null
  originalNumber?: string | null
  /** The date of the invoice a credit note reverses, shown beside its number. */
  originalDate?: string | null
  /** The total of that invoice, when known: only a zero-value invoice takes a zero credit note. */
  originalTotalMinor?: unknown
  /** A credit note with no invoice to reverse. */
  standaloneCredit?: boolean
  draftId?: string | null
  /** What the document will charge (treatment, rate, price basis, net, VAT, total). Absent when
   *  the issuer's tax setup is not known at card time. */
  tax?: TaxPlan | null
  /** The tax destination the plan was computed for. */
  taxCountry?: string | null
  /** The buyer's VAT status (number, where it came from, VIES, consumer override). */
  buyer?: Partial<BuyerVatFacts> | null
}

/** The tax, price-basis and total lines of an issue card: exactly what will be issued. */
export function taxCardLines(
  f: Pick<IssueCardFacts, "tax" | "taxCountry" | "buyer" | "currency" | "customer">,
): string[] {
  const plan = f.tax
  if (!plan) return []
  const cur = f.currency
  const b = f.buyer ?? null
  const vat = b?.vat_id ? String(b.vat_id) : null
  let vatPart: string
  if (vat) {
    const from =
      b?.vat_id_source === "prior_document" && b.prior_document_number
        ? `, filled in from ${b.prior_document_number}`
        : ""
    const vies =
      b?.vies === "valid"
        ? `, VIES verified${b.vies_name ? `: ${text(b.vies_name, 60)}` : ""}${
            b.vies_name_mismatch
              ? ` (NAME MISMATCH with the buyer "${text(f.customer, 50) ?? "?"}", check it is the same company)`
              : ""
          }`
        : b?.vies === "unavailable"
          ? ", NOT verified (VIES unavailable)"
          : ""
    vatPart = `buyer VAT number ${vat}${from}${vies}`
  } else if (b?.buyer_is_consumer && (b.consumer_override_evidence?.length ?? 0) > 0) {
    vatPart =
      "no buyer VAT number: the agent declared this buyer a private consumer, against the evidence above"
  } else if (b?.business_unverified) {
    vatPart = `no buyer VAT number, business status NOT verified (${text(b.business_unverified, 80)}): approve only if you know the buyer is a private person`
  } else if (b?.buyer_is_consumer) {
    vatPart = "no buyer VAT number, the buyer was CONFIRMED a private consumer"
  } else {
    vatPart = "no buyer VAT number"
  }
  const prices =
    plan.price_basis === "gross_netted"
      ? `Prices: typed VAT included (issuer setting), ${formatMoneyMinor(plan.typed_total_minor, cur)} incl. VAT is ${formatMoneyMinor(plan.subtotal_minor, cur)} net`
      : plan.price_basis === "no_tax"
        ? "Prices: net as typed, no VAT added"
        : "Prices: net as typed, VAT added on top"
  return [
    `Total: ${formatMoneyMinor(plan.total_minor, cur)} (${formatMoneyMinor(plan.subtotal_minor, cur)} net + ${formatMoneyMinor(plan.tax_minor, cur)} VAT)`,
    `Tax: ${treatmentWords(plan.treatment, plan.rate_bp, f.taxCountry)}; ${vatPart}`,
    prices,
  ]
}

/**
 * The first lines of a card whose buyer the agent declared a private consumer against business
 * evidence (buyer-vat.ts `consumer_override_evidence`): the person deciding reads the evidence in
 * plain words before anything else. Empty when there is no such declaration.
 */
export function consumerOverrideCardLines(
  buyer: Partial<Pick<BuyerVatFacts, "consumer_override_evidence">> | null | undefined,
): string[] {
  const evidence = buyer?.consumer_override_evidence ?? []
  if (evidence.length === 0) return []
  // At most three lines: the card holds eight, and the tax lines below must stay on it.
  return [
    "WARNING: the agent declared this buyer a private consumer, but the org's data says business. Approve only if you know it is a private person.",
    ...evidence.slice(0, 2).map((e) => `Evidence: ${e}`),
  ]
}

export function issueCard(f: IssueCardFacts): ApprovalCard {
  const type = docTypeLabel(f.type)
  const customer = text(f.customer, 80) ?? "the customer"
  // Reached only by a call whose stage-time check could not run (a step of a sequence, an edited
  // payload): the card says issuing refuses it, and never prints an amount that will not exist.
  const unreadable = unreadableLineAmount(f.lines)
  if (unreadable) return refusedCard(f, type, customer, unreadable)
  const exact = (f.totalMinor !== undefined && f.totalMinor !== null) || !!f.tax
  const totalMinor = f.tax
    ? f.tax.total_minor
    : exact
      ? (f.totalMinor as bigint)
      : linesTotal(f.lines)
  const total = formatMoneyMinor(totalMinor, f.currency)
  // The original's total may be unknown here: a zero then waits for the stage-time check's answer.
  const originalTotal = toMinor(f.originalTotalMinor)
  if (
    f.type === "credit_note" &&
    (totalMinor > 0n ||
      (totalMinor === 0n &&
        (!f.originalNumber || (originalTotal !== null && originalTotal !== 0n))))
  ) {
    return refusedCard(
      f,
      type,
      customer,
      `a credit note's total must be negative, these lines total ${total}`,
    )
  }
  const order = orderName(f.orderNumber)
  const draftOrder = orderName(f.draftOrderName)
  const orderPart = order ? `, order ${order}` : draftOrder ? `, draft order ${draftOrder}` : ""
  const isCredit = f.type === "credit_note"
  const original = text(f.originalNumber, 40)
  const title = isCredit
    ? original
      ? `Credit ${total.replace(/^-/, "")} on ${original} for ${customer}`
      : `Issue a credit note of ${total.replace(/^-/, "")} to ${customer}`
    : `Issue ${type} for ${customer}, ${total}${orderPart}`
  const override = consumerOverrideCardLines(f.buyer)
  const issued = day(f.issuedAt)
  const originalDate = day(f.originalDate)
  const totalLines = f.tax
    ? // The tax lines (or, when the issuer's tax setup is unknown, the typed lines total, said as
      // such: a card never claims a tax basis it did not compute).
      taxCardLines(f)
    : [
        exact
          ? `Total: ${total}`
          : `Lines total: ${total} as typed (tax not computed here, check the document)`,
      ]
  const lines: string[] = isCredit
    ? [
        // The title names the document, the customer and the amount. What a person decides on then
        // comes first, so the eight lines of a card can never lose it: how much, the invoice it
        // reverses and the date its number follows. A credit note's lines are always net as typed.
        ...totalLines.slice(0, 2),
        original
          ? `Reverses invoice: ${original}${originalDate ? ` (${originalDate})` : ""}`
          : "WARNING: no original invoice referenced (standalone credit note)",
        `Issue date: ${issued ?? "the day this is approved"}`,
      ]
    : [
        ...override,
        // The title names the document; with the warning on top, its line gives the room back.
        ...(override.length > 0
          ? []
          : [
              f.fromDraft
                ? `Document: new ${type} from a saved draft (number assigned on issue)`
                : `Document: new ${type} (number assigned on issue)`,
            ]),
        `Customer: ${customer}`,
        ...totalLines,
      ]
  const factCount = lines.length
  if (order) lines.push(`Order: ${order}`)
  else if (draftOrder) lines.push(`Shopify draft order: ${draftOrder}`)
  const declared = money(f.declaredValueMinor, f.currency)
  if (declared) lines.push(`Declared customs value: ${declared}`)
  const reason = text(f.reason, 120)
  if (reason) lines.push(`Reason: ${reason}`)
  const po = text(f.poNumber, 40)
  if (po) lines.push(`Customer PO number: ${po}`)
  const customerRef = text(f.customerReference, 120)
  if (customerRef) lines.push(`Customer ref: ${customerRef}`)
  if (issued && !isCredit) lines.push(`Issue date: ${issued}`)
  const due = day(f.dueAt)
  // A quote's date is how long the offer holds, not a payment due date.
  if (due) lines.push(f.type === "quote" ? `Valid until: ${due}` : `Due date: ${due}`)
  const issuer = text(f.issuerName, 80)
  if (issuer) lines.push(`Issued by: ${issuer}`)
  // The lines fill whatever room the facts leave.
  const room = Math.max(1, CARD_MAX_LINES - lines.length)
  const itemLines = lineTexts(f.lines, f.currency, f.lines.length > room ? room - 1 : room)
  lines.splice(factCount, 0, ...itemLines)
  return finishCard({
    kind: f.kind,
    title,
    subtitle: f.fromDraft
      ? `Turns the saved draft into a ${type} for ${customer}, with its next ${type} number`
      : `Creates a ${type} for ${customer}, with its next ${type} number`,
    lines,
    links: f.fromDraft && f.draftId ? docLink(f.draftId, `Open the draft ${type}`) : [],
  })
}
