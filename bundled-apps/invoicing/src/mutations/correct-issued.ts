// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: documents_correct_issued, the in-place correction of an ISSUED invoice or
// credit note whose content was wrong because of a tool error (a line priced in the wrong
// currency, a VAT rate the tool should not have charged, a shipping line on the wrong document of
// a split order, a cent of per-line rounding).
//
// The usual French correction is a credit note and a new invoice (documents_update refuses lines
// and tax treatment on an issued document for that reason). This tool is the deliberate exception
// for a tool fault, decided by a person who holds `invoicing:issuer:admin`, with the company's
// accountant in agreement:
//   - it changes the lines (description, quantity, unit price, discount, VAT rate, line kind, the
//     line's VAT within one minor unit), the tax treatment (its legal mention follows), and the
//     buyer's name, VAT number, country, address or kind only when the call passes them;
//   - the corrected file prints the legal mention in force on the CORRECTION's date (the document
//     keeps its issue date): a wrong wording on an issued document is corrected in place, alone,
//     with `refresh_legal_mention`. The card shows the old and the new mention;
//   - it never changes the number, the type, the issue date, the issuer or the currency, creates
//     no document and no number, and sends no mail;
//   - a change of the grand total needs its own stated reason (`total_change_reason`);
//   - `move_shipping` moves one shipping line from this document to another document of the same
//     Shopify order in one commit: the order's combined total does not change;
//   - the previous file stays: the legal original (and its Factur-X) is immutable and kept, and
//     every correction is an immutable `document_corrections` row holding the before and after,
//     who, when and why, the previous file and the corrected file. The corrected file (a new
//     PDF/A-3B, with its regenerated Factur-X for an e-invoice) becomes the document's file of
//     record (legal-originals/delivery.ts): previews, downloads and the buyer invoices API serve it;
//   - a document already transmitted to (or waiting for) the e-invoicing platform is refused: the
//     platform holds the original, so a correction there is a credit note.
//
// GATED (`noAutoApprove`): an agent proposes, a person decides; the run refuses unless the person
// it runs for holds `invoicing:issuer:admin`.

import { operationCategory } from "../einvoicing/classify-operation"
import { eurMinor } from "../einvoicing/fx"
import { TERMINAL_SEND_FAILURES } from "../einvoicing/transmit"
import { type LineKind, storedTaxCountry } from "../issue"
import { currencyExponent, documentRollup, lineSubtotal, lineTax, sourceLineTax } from "../money"
import type { TaxTreatment } from "../tax"
import { FOREIGN_ID_CHARS, findIssuerProfile } from "./db-helpers"
import { ISSUER_ADMIN_SCOPE } from "./issuer-profiles"
import { correctionMentionDate, renderCorrection, storedLegalMention } from "./pdf"
import {
  type ErrorEnvelope,
  lineAmountsError,
  type MutationsCtx,
  type PreflightResult,
  toBigInt,
} from "./shared"

type Row = Record<string, unknown>

export const CORRECTED_EVENT = "corrected_in_place"

const TAX_TREATMENTS: ReadonlySet<string> = new Set<TaxTreatment>([
  "eu_domestic",
  "eu_reverse_charge",
  "eu_b2c_oss",
  "eu_export_non_eu",
  "uk_domestic",
  "uk_export_eu",
  "uk_export_non_eu",
  "us_domestic",
  "us_export",
])

/** The line kinds a correction may set. `digital` is the plain word for a software line. */
const LINE_KIND_ALIASES: Record<string, LineKind> = {
  goods: "goods",
  service: "service",
  services: "service",
  software: "software",
  digital: "software",
  shipping: "shipping",
}

/** The buyer kinds a correction may set (`documents.customer_kind`). */
const CUSTOMER_KINDS: ReadonlySet<string> = new Set([
  "business",
  "individual",
  "public_entity",
  "non_registered_entity",
])

const CORRECTABLE_TYPES = new Set(["invoice", "credit_note"])
const NOT_CORRECTABLE_STATUSES = new Set(["draft", "pending_approval", "voided", "cancelled"])
const REASON_MIN = 10
const REASON_MAX = 1000

export interface CorrectionLineInput {
  position?: number
  description: string
  quantity: string | number
  unit_price_minor: string | number | bigint
  discount_minor?: string | number | bigint | null
  /** The line's VAT rate in basis points (2000 = 20 %). Required: a correction states every rate. */
  tax_rate_bp: number
  /** The line's VAT as it was charged, when it differs by one minor unit from the rate's (a
   *  rounding fix). Further off is refused. */
  tax_minor?: string | number | bigint | null
  /** goods, service, digital (software) or shipping. Omitted: the kind of the line at the same
   *  position before the correction, else goods. */
  line_kind?: string | null
  hs_code?: string | null
  country_of_origin?: string | null
  customs_description?: string | null
  product_source?: string | null
  external_id?: string | null
}

export interface CorrectIssuedInput {
  /** The issued invoice or credit note (id or number). */
  id: string
  /** Why it is corrected: the tool error it repairs. Printed on the audit record. */
  reason: string
  /** The full corrected line set (replaces every line). */
  lines?: CorrectionLineInput[] | null
  tax_treatment?: string | null
  /** The buyer's identity changes ONLY through these, when passed. */
  counterparty_name?: string | null
  counterparty_vat_id?: string | null
  counterparty_country?: string | null
  counterparty_address?: string | null
  /** The buyer's kind (business, individual, ...): picks the consumer or business wording. */
  customer_kind?: string | null
  /** Print the legal mention in force today (the correction's date) instead of the one of the
   *  issue date. Alone, it corrects only the wording; refused when the mention would not change. */
  refresh_legal_mention?: boolean | null
  /** Required when the grand total changes: why (e.g. "the shop charged 84.55, the tool billed
   *  74.20 in the wrong currency"). */
  total_change_reason?: string | null
  /** Move one shipping line (by its position on this document) to another issued document of the
   *  same Shopify order. Nothing else may be passed with it. */
  move_shipping?: { to_document_id?: string | null; position?: number | null } | null
}

interface LineRow {
  position: number
  description: string
  quantity: string
  unit_price_minor: bigint
  discount_minor: bigint
  line_kind: LineKind
  tax_rate_bp: number
  subtotal_minor: bigint
  tax_minor: bigint
  total_minor: bigint
  hs_code: string | null
  country_of_origin: string | null
  customs_description: string | null
  product_source: string | null
  external_id: string | null
}

/** What a correction records as "before" and "after", and what the card shows. */
export interface CorrectionSnapshot {
  number: string | null
  type: string
  currency: string
  tax_treatment: string | null
  operation_category: string | null
  counterparty_name: string | null
  counterparty_vat_id: string | null
  counterparty_country: string | null
  counterparty_address?: string | null
  customer_kind?: string | null
  /** The legal mention the file prints. */
  legal_mention?: string
  subtotal_minor: string
  tax_total_minor: string
  grand_total_minor: string
  tax_total_eur_minor: string | null
  lines: Array<{
    position: number
    description: string
    quantity: string
    unit_price_minor: string
    discount_minor: string
    line_kind: string
    tax_rate_bp: number
    subtotal_minor: string
    tax_minor: string
    total_minor: string
  }>
}

interface PlannedCorrection {
  doc: Row
  oldLines: Row[]
  newLines: LineRow[]
  linesChanged: boolean
  update: Row
  before: CorrectionSnapshot
  after: CorrectionSnapshot
  totalChanged: boolean
  changedFields: string[]
  sequence: number
}

interface Plan {
  kind: "correct" | "move_shipping"
  reason: string
  totalChangeReason: string | null
  items: PlannedCorrection[]
}

export interface CorrectionPreview {
  kind: "correct" | "move_shipping" | null
  refusal: { code: string; message: string } | null
  documents: Array<{
    id: string
    number: string | null
    type: string
    currency: string
    counterparty_name: string | null
    total_changed: boolean
    changed_fields: string[]
    before: CorrectionSnapshot
    after: CorrectionSnapshot
  }>
  reason: string | null
  total_change_reason: string | null
}

export type CorrectIssuedResult =
  | {
      status: "completed"
      kind: "correct" | "move_shipping"
      documents: Array<{
        id: string
        number: string | null
        correction_id: string
        grand_total_before_minor: string
        grand_total_after_minor: string
        pdf_status: string
      }>
      message: string
    }
  | ErrorEnvelope

function refuse(code: string, message: string): ErrorEnvelope {
  return { status: "error", error: { code, message } }
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

function refsOf(v: unknown): Row {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Row
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v) as unknown
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Row
    } catch {
      // not JSON
    }
  }
  return {}
}

function lineOfRow(r: Row): LineRow {
  return {
    position: Number(r.position ?? 0),
    description: String(r.description ?? ""),
    quantity: String(r.quantity ?? "1"),
    unit_price_minor: toBigInt(r.unit_price_minor),
    discount_minor: toBigInt(r.discount_minor),
    line_kind: (LINE_KIND_ALIASES[String(r.line_kind ?? "goods")] ?? "goods") as LineKind,
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
}

function snapshotLines(lines: LineRow[]): CorrectionSnapshot["lines"] {
  return lines.map((l) => ({
    position: l.position,
    description: l.description,
    quantity: l.quantity,
    unit_price_minor: l.unit_price_minor.toString(),
    discount_minor: l.discount_minor.toString(),
    line_kind: l.line_kind,
    tax_rate_bp: l.tax_rate_bp,
    subtotal_minor: l.subtotal_minor.toString(),
    tax_minor: l.tax_minor.toString(),
    total_minor: l.total_minor.toString(),
  }))
}

function snapshotOf(doc: Row, lines: LineRow[], withAddress: boolean): CorrectionSnapshot {
  return {
    number: (doc.number as string | null) ?? null,
    type: String(doc.type ?? "invoice"),
    currency: String(doc.currency ?? "EUR"),
    tax_treatment: (doc.tax_treatment as string | null) ?? null,
    operation_category: (doc.operation_category as string | null) ?? null,
    counterparty_name: (doc.counterparty_name as string | null) ?? null,
    counterparty_vat_id: (doc.counterparty_vat_id as string | null) ?? null,
    counterparty_country: (doc.counterparty_country as string | null) ?? null,
    ...(withAddress
      ? { counterparty_address: (doc.counterparty_address as string | null) ?? null }
      : {}),
    customer_kind: (doc.customer_kind as string | null) ?? null,
    subtotal_minor: toBigInt(doc.subtotal_minor).toString(),
    tax_total_minor: toBigInt(doc.tax_total_minor).toString(),
    grand_total_minor: toBigInt(doc.grand_total_minor).toString(),
    tax_total_eur_minor:
      doc.tax_total_eur_minor == null ? null : toBigInt(doc.tax_total_eur_minor).toString(),
    lines: snapshotLines(lines),
  }
}

async function findDocument(ctx: MutationsCtx, raw: unknown): Promise<Row | null> {
  const id = str(raw)
  if (!id || FOREIGN_ID_CHARS.test(id)) return null
  const where = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? { id }
    : { number: id }
  const rows = (await ctx.db.findMany("documents", { where, limit: 1 })) as Row[]
  return rows[0] ?? null
}

async function loadLines(ctx: MutationsCtx, documentId: string): Promise<Row[]> {
  return (await ctx.db.findMany("document_lines", {
    where: { document_id: documentId },
    orderBy: { position: "asc" },
    limit: 1000,
  })) as Row[]
}

/** Why `doc` cannot be corrected in place, or null. Read-only. */
async function documentRefusal(ctx: MutationsCtx, doc: Row): Promise<ErrorEnvelope | null> {
  const label = String(doc.number ?? doc.id)
  const type = String(doc.type ?? "")
  if (!CORRECTABLE_TYPES.has(type)) {
    return refuse(
      "not_correctable_type",
      `${label} is a ${type.replace(/_/g, " ")}, not an invoice or a credit note: documents_update edits it. Nothing was changed.`,
    )
  }
  const status = String(doc.status ?? "draft")
  if (NOT_CORRECTABLE_STATUSES.has(status)) {
    return refuse(
      "not_correctable_status",
      status === "draft" || status === "pending_approval"
        ? `${label} is not issued yet (${status.replace(/_/g, " ")}): correct the draft with drafts_update. Nothing was changed.`
        : `${label} is ${status}: a ${status} document is never changed. Nothing was changed.`,
    )
  }
  if (str(refsOf(doc.external_refs).import_source)) {
    return refuse(
      "imported_document",
      `${label} was imported from another tool: its PDF is the original that tool issued, and Liaison does not re-render it. Correct it in that tool or with a credit note. Nothing was changed.`,
    )
  }
  if (
    str(doc.einvoice_state) ||
    str(doc.einvoice_send_requested_at) ||
    str(doc.einvoice_send_approval_id)
  ) {
    return refuse(
      "einvoice_transmitted",
      `${label} was sent, or is waiting to be sent, to the e-invoicing platform (state: ${String(doc.einvoice_state ?? "send requested")}). The platform holds the original, so it is corrected with a credit note, never in place. Nothing was changed.`,
    )
  }
  const transmissions = (await ctx.db.findMany("einvoice_transmissions", {
    where: { document_id: String(doc.id) },
    limit: 20,
  })) as Row[]
  const live = transmissions.find((t) => !TERMINAL_SEND_FAILURES.has(String(t.state ?? "")))
  if (live) {
    return refuse(
      "einvoice_transmitted",
      `${label} has an e-invoicing ${live.action === "book_sale" ? "booking" : "transmission"} (${String(live.state)}): the platform holds the original, so it is corrected with a credit note, never in place. Nothing was changed.`,
    )
  }
  return null
}

function validReason(raw: unknown, field: string): { ok: true; value: string } | ErrorEnvelope {
  const r = str(raw)
  if (!r || r.length < REASON_MIN) {
    return refuse(
      "reason_required",
      `${field} is required: say in a sentence which tool error this corrects (at least ${REASON_MIN} characters). Nothing was changed.`,
    )
  }
  if (r.length > REASON_MAX)
    return refuse(
      "reason_too_long",
      `${field} is over ${REASON_MAX} characters. Nothing was changed.`,
    )
  return { ok: true, value: r }
}

/** The corrected line rows, or a refusal naming the line. */
function buildLines(
  input: CorrectionLineInput[],
  oldLines: LineRow[],
): { ok: true; lines: LineRow[] } | ErrorEnvelope {
  if (!Array.isArray(input) || input.length === 0) {
    return refuse(
      "invalid_lines",
      "lines must list every line of the corrected document. Nothing was changed.",
    )
  }
  const amounts = lineAmountsError(input, "lines")
  if (amounts) return amounts
  const out: LineRow[] = []
  for (const [i, l] of input.entries()) {
    const at = `lines[${i}]`
    if (!l || typeof l !== "object")
      return refuse("invalid_lines", `${at} is not a line. Nothing was changed.`)
    const description = str(l.description)
    if (!description)
      return refuse("invalid_lines", `${at}.description is required. Nothing was changed.`)
    const rate = l.tax_rate_bp
    if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 0 || rate > 10_000) {
      return refuse(
        "invalid_lines",
        `${at}.tax_rate_bp must be a whole number of basis points between 0 and 10000 (2000 is 20 %). Nothing was changed.`,
      )
    }
    const position =
      typeof l.position === "number" && Number.isInteger(l.position) ? l.position : i + 1
    const old = oldLines.find((o) => o.position === position) ?? null
    const kindRaw = str(l.line_kind)
    const kind = kindRaw ? LINE_KIND_ALIASES[kindRaw.toLowerCase()] : (old?.line_kind ?? "goods")
    if (!kind) {
      return refuse(
        "invalid_lines",
        `${at}.line_kind must be goods, service, digital or shipping. Nothing was changed.`,
      )
    }
    let quantity: string
    let subtotal: bigint
    let price: bigint
    let discount: bigint
    try {
      quantity = String(l.quantity)
      price = toBigInt(l.unit_price_minor)
      discount = l.discount_minor == null ? 0n : toBigInt(l.discount_minor)
      subtotal = lineSubtotal({ quantity, unit_price_minor: price }) - discount
    } catch {
      return refuse("invalid_lines", `${at}.quantity is not a number. Nothing was changed.`)
    }
    const computed = lineTax({ subtotal_minor: subtotal, tax_rate_bp: rate })
    let tax = computed
    if (l.tax_minor != null && l.tax_minor !== "") {
      const stated = toBigInt(l.tax_minor)
      if (stated !== computed) {
        const fixed = sourceLineTax(subtotal, rate, stated)
        if (fixed == null) {
          return refuse(
            "line_tax_off",
            `${at}.tax_minor ${stated} is not the line's VAT at ${rate / 100} % (${computed}): only a one-unit rounding difference may be stated. Nothing was changed.`,
          )
        }
        tax = fixed
      }
    }
    const keep = <
      K extends
        | "hs_code"
        | "country_of_origin"
        | "customs_description"
        | "product_source"
        | "external_id",
    >(
      k: K,
    ): string | null => (l[k] !== undefined ? (l[k] ?? null) : (old?.[k] ?? null))
    out.push({
      position,
      description,
      quantity,
      unit_price_minor: price,
      discount_minor: discount,
      line_kind: kind,
      tax_rate_bp: rate,
      subtotal_minor: subtotal,
      tax_minor: tax,
      total_minor: subtotal + tax,
      hs_code: kind === "goods" ? keep("hs_code") : null,
      country_of_origin: kind === "goods" ? keep("country_of_origin") : null,
      customs_description: kind === "goods" ? keep("customs_description") : null,
      product_source: keep("product_source"),
      external_id: keep("external_id"),
    })
  }
  const positions = new Set(out.map((l) => l.position))
  if (positions.size !== out.length)
    return refuse("invalid_lines", "two lines carry the same position. Nothing was changed.")
  return { ok: true, lines: out }
}

const sameLines = (a: LineRow[], b: LineRow[]): boolean =>
  JSON.stringify(snapshotLines(a)) === JSON.stringify(snapshotLines(b))

/** The document fields that follow a new line set and treatment. */
function totalsUpdate(doc: Row, lines: LineRow[]): Row {
  const rollup = documentRollup(
    lines.map((l) => ({
      subtotal_minor: l.subtotal_minor,
      tax_rate_bp: l.tax_rate_bp,
      tax_minor_fixed: l.tax_minor,
    })),
  )
  const out: Row = {
    subtotal_minor: rollup.subtotal_minor.toString(),
    tax_total_minor: rollup.tax_total_minor.toString(),
    grand_total_minor: rollup.grand_total_minor.toString(),
  }
  const category = operationCategory(lines, { authoritative: true }).category
  if (category) {
    out.operation_category = category
    out.operation_category_source = "lines_authoritative"
  }
  const currency = String(doc.currency ?? "EUR")
  const rate = str(doc.fx_rate)
  if (rate && currency !== "EUR") {
    out.tax_total_eur_minor = eurMinor(
      rollup.tax_total_minor,
      rate,
      currencyExponent(currency),
    ).toString()
  }
  return out
}

async function nextSequence(ctx: MutationsCtx, documentId: string): Promise<number> {
  const rows = (await ctx.db.findMany("document_corrections", {
    where: { document_id: documentId },
    orderBy: { sequence: "desc" },
    limit: 1,
  })) as Row[]
  return rows[0] ? Number(rows[0].sequence ?? 0) + 1 : 1
}

function planItem(
  doc: Row,
  oldRows: Row[],
  newLines: LineRow[],
  extra: Row,
  sequence: number,
): PlannedCorrection {
  const oldLines = oldRows.map(lineOfRow)
  const linesChanged = !sameLines(oldLines, newLines)
  const update: Row = { ...extra, ...(linesChanged ? totalsUpdate(doc, newLines) : {}) }
  const changedFields = [
    ...(linesChanged ? ["lines"] : []),
    ...Object.keys(extra).filter((k) => (doc[k] ?? null) !== (extra[k] ?? null)),
  ]
  const withAddress = "counterparty_address" in extra
  const after = snapshotOf({ ...doc, ...update }, newLines, withAddress)
  const before = snapshotOf(doc, oldLines, withAddress)
  return {
    doc,
    oldLines: oldRows,
    newLines,
    linesChanged,
    update,
    before,
    after,
    totalChanged: before.grand_total_minor !== after.grand_total_minor,
    changedFields,
    sequence,
  }
}

/**
 * Fill the before and after legal mention of a planned correction. Before: what the current file
 * prints (the wording of the issue date, or of the previous correction's date). After: what the
 * corrected file will print, the wording in force today, the correction's date.
 */
async function withMentions(
  ctx: MutationsCtx,
  item: PlannedCorrection,
): Promise<{ ok: true; changed: boolean } | ErrorEnvelope> {
  const issuer = await findIssuerProfile(ctx.db, String(item.doc.issuer_profile_id))
  if (!issuer) return refuse("issuer_not_found", "the document's issuer profile is missing")
  const mentionOf = (
    doc: Row,
    lines: ReadonlyArray<{ line_kind?: string | null }>,
    on: string | null,
  ) =>
    storedLegalMention(
      ctx.db,
      doc,
      issuer,
      {
        country: (doc.counterparty_country as string | null) ?? issuer.country,
        tax_country: storedTaxCountry(doc),
        vat_id: (doc.counterparty_vat_id as string | null) ?? null,
      },
      lines,
      { mentionDate: on },
    )
  const beforeDoc = item.doc
  item.before.legal_mention = await mentionOf(
    beforeDoc,
    item.oldLines.map(lineOfRow),
    await correctionMentionDate(ctx.db, beforeDoc),
  )
  // The corrected document carries a correction, so it prints its stored treatment.
  const afterDoc = { ...item.doc, ...item.update, current_correction_id: "planned" }
  item.after.legal_mention = await mentionOf(
    afterDoc,
    item.newLines,
    new Date().toISOString().slice(0, 10),
  )
  return { ok: true, changed: item.before.legal_mention !== item.after.legal_mention }
}

/** Everything read and checked, nothing written. */
async function planCorrection(
  ctx: MutationsCtx,
  input: CorrectIssuedInput,
): Promise<{ ok: true; plan: Plan } | ErrorEnvelope> {
  const reason = validReason(input?.reason, "reason")
  if (!("ok" in reason)) return reason
  const doc = await findDocument(ctx, input?.id)
  if (!doc) return refuse("not_found", `document ${String(input?.id ?? "")} not found`)
  const refused = await documentRefusal(ctx, doc)
  if (refused) return refused
  const totalChangeReason = str(input.total_change_reason)

  if (input.move_shipping != null) return planMove(ctx, input, doc, reason.value)

  const extra: Row = {}
  if (input.tax_treatment !== undefined) {
    const t = str(input.tax_treatment)
    if (!t || !TAX_TREATMENTS.has(t)) {
      return refuse(
        "invalid_tax_treatment",
        `tax_treatment must be one of ${[...TAX_TREATMENTS].join(", ")}. Nothing was changed.`,
      )
    }
    extra.tax_treatment = t
  }
  for (const k of [
    "counterparty_name",
    "counterparty_vat_id",
    "counterparty_country",
    "counterparty_address",
  ] as const) {
    if (input[k] === undefined) continue
    const v = str(input[k])
    if (k === "counterparty_name" && !v)
      return refuse("invalid_params", "counterparty_name cannot be blank. Nothing was changed.")
    if (k === "counterparty_country" && (!v || !/^[A-Za-z]{2}$/.test(v)))
      return refuse(
        "invalid_params",
        "counterparty_country is a two-letter country code. Nothing was changed.",
      )
    extra[k] =
      k === "counterparty_country"
        ? v?.toUpperCase()
        : k === "counterparty_vat_id"
          ? (v?.replace(/\s+/g, "").toUpperCase() ?? null)
          : v
  }
  if (input.customer_kind !== undefined) {
    const k = str(input.customer_kind)
    if (!k || !CUSTOMER_KINDS.has(k))
      return refuse(
        "invalid_params",
        `customer_kind must be one of ${[...CUSTOMER_KINDS].join(", ")}. Nothing was changed.`,
      )
    extra.customer_kind = k
  }
  // The structured buyer fields the e-invoice carries follow the name and the country.
  if (typeof extra.counterparty_name === "string" && doc.buyer_legal_name != null)
    extra.buyer_legal_name = extra.counterparty_name
  if (typeof extra.counterparty_country === "string" && doc.billing_country_code != null)
    extra.billing_country_code = extra.counterparty_country

  const oldRows = await loadLines(ctx, String(doc.id))
  let newLines = oldRows.map(lineOfRow)
  if (input.lines != null) {
    const built = buildLines(input.lines, newLines)
    if (!("ok" in built)) return built
    newLines = built.lines
  }
  const item = planItem(doc, oldRows, newLines, extra, await nextSequence(ctx, String(doc.id)))
  const mentions = await withMentions(ctx, item)
  if (!("ok" in mentions)) return mentions
  const label = String(doc.number ?? doc.id)
  if (mentions.changed) {
    if (item.changedFields.length === 0 && input.refresh_legal_mention !== true) {
      return refuse(
        "no_change",
        `the correction changes nothing on ${label} but its legal mention, which would read "${item.after.legal_mention}" instead of "${item.before.legal_mention}": pass refresh_legal_mention: true to correct the mention. Nothing was changed.`,
      )
    }
    item.changedFields.push("legal_mention")
  }
  if (item.changedFields.length === 0) {
    return refuse(
      "no_change",
      input.refresh_legal_mention === true
        ? `the legal mention of ${label} is already the current one ("${item.before.legal_mention}") and nothing else changes. Nothing was changed.`
        : `the correction changes nothing on ${label}. Nothing was changed.`,
    )
  }
  if (item.totalChanged && !totalChangeReason) {
    return refuse(
      "total_change_unexplained",
      `this correction changes the grand total of ${String(doc.number ?? doc.id)} from ${item.before.grand_total_minor} to ${item.after.grand_total_minor} (minor units, ${item.after.currency}). Say why in total_change_reason (e.g. a 0.01 rounding fix, or the amount the customer actually paid). Nothing was changed.`,
    )
  }
  if (!item.totalChanged && totalChangeReason) {
    return refuse(
      "total_unchanged",
      "total_change_reason was given but the grand total does not change: leave it out. Nothing was changed.",
    )
  }
  return {
    ok: true,
    plan: {
      kind: "correct",
      reason: reason.value,
      totalChangeReason: item.totalChanged ? totalChangeReason : null,
      items: [item],
    },
  }
}

function sameOrder(a: Row, b: Row): boolean {
  const ida = str(a.shopify_order_id)
  const idb = str(b.shopify_order_id)
  if (ida || idb) return ida === idb
  const na = str(a.shopify_order_number)
  return na !== null && na === str(b.shopify_order_number)
}

async function planMove(
  ctx: MutationsCtx,
  input: CorrectIssuedInput,
  from: Row,
  reason: string,
): Promise<{ ok: true; plan: Plan } | ErrorEnvelope> {
  const others = [
    "lines",
    "tax_treatment",
    "customer_kind",
    "refresh_legal_mention",
    "counterparty_name",
    "counterparty_vat_id",
    "counterparty_country",
    "counterparty_address",
    "total_change_reason",
  ].filter((k) => (input as unknown as Row)[k] != null)
  if (others.length > 0) {
    return refuse(
      "invalid_params",
      `move_shipping moves one line and nothing else (also passed: ${others.join(", ")}). Correct the rest in a separate call. Nothing was changed.`,
    )
  }
  const move = input.move_shipping ?? {}
  const position = move.position
  if (typeof position !== "number" || !Number.isInteger(position))
    return refuse(
      "invalid_params",
      "move_shipping.position is the shipping line's position. Nothing was changed.",
    )
  const to = await findDocument(ctx, move.to_document_id)
  if (!to) return refuse("not_found", `document ${String(move.to_document_id ?? "")} not found`)
  if (String(to.id) === String(from.id))
    return refuse(
      "invalid_params",
      "move_shipping.to_document_id is this same document. Nothing was changed.",
    )
  const refusedTo = await documentRefusal(ctx, to)
  if (refusedTo) return refusedTo
  const fromLabel = String(from.number ?? from.id)
  const toLabel = String(to.number ?? to.id)
  if (String(from.type) !== String(to.type))
    return refuse(
      "not_same_order",
      `${fromLabel} and ${toLabel} are not the same kind of document. Nothing was changed.`,
    )
  if (!sameOrder(from, to))
    return refuse(
      "not_same_order",
      `${fromLabel} and ${toLabel} are not documents of the same Shopify order. Nothing was changed.`,
    )
  if (
    String(from.issuer_profile_id) !== String(to.issuer_profile_id) ||
    String(from.currency) !== String(to.currency)
  )
    return refuse(
      "not_same_order",
      `${fromLabel} and ${toLabel} have a different issuer or currency. Nothing was changed.`,
    )

  const fromRows = await loadLines(ctx, String(from.id))
  const fromLines = fromRows.map(lineOfRow)
  const moved = fromLines.find((l) => l.position === position)
  if (!moved)
    return refuse(
      "line_not_found",
      `${fromLabel} has no line at position ${position}. Nothing was changed.`,
    )
  if (moved.line_kind !== "shipping")
    return refuse(
      "not_a_shipping_line",
      `line ${position} of ${fromLabel} is a ${moved.line_kind} line, not shipping. Nothing was changed.`,
    )
  if (fromLines.length < 2)
    return refuse(
      "last_line",
      `the shipping line is the only line of ${fromLabel}: a document keeps at least one line. Nothing was changed.`,
    )
  const toRows = await loadLines(ctx, String(to.id))
  const toLines = toRows.map(lineOfRow)
  const nextPos = toLines.reduce((m, l) => Math.max(m, l.position), 0) + 1
  const fromAfter = fromLines.filter((l) => l.position !== position)
  const toAfter = [...toLines, { ...moved, position: nextPos }]
  const a = planItem(from, fromRows, fromAfter, {}, await nextSequence(ctx, String(from.id)))
  const b = planItem(to, toRows, toAfter, {}, await nextSequence(ctx, String(to.id)))
  for (const item of [a, b]) {
    const m = await withMentions(ctx, item)
    if (!("ok" in m)) return m
    if (m.changed) item.changedFields.push("legal_mention")
  }
  const before = toBigInt(a.before.grand_total_minor) + toBigInt(b.before.grand_total_minor)
  const after = toBigInt(a.after.grand_total_minor) + toBigInt(b.after.grand_total_minor)
  if (before !== after) {
    // The line moves as it is, so this cannot happen; a guard against a future change.
    return refuse(
      "order_total_changed",
      "moving the line would change the order's combined total. Nothing was changed.",
    )
  }
  return {
    ok: true,
    plan: { kind: "move_shipping", reason, totalChangeReason: null, items: [a, b] },
  }
}

/** Refuse unless the run is for a person holding the issuer admin scope. */
async function authorityRefusal(ctx: MutationsCtx): Promise<ErrorEnvelope | null> {
  const holds =
    typeof ctx.hasScope === "function" && (await ctx.hasScope(ISSUER_ADMIN_SCOPE)) === true
  if (holds) return null
  return refuse(
    "forbidden",
    `Correcting an issued document in place needs the ${ISSUER_ADMIN_SCOPE} scope (held by admins, grantable to a role). Ask an administrator to decide it. Nothing was changed.`,
  )
}

/** Stage-time check: every validation the run makes (the scope is checked on the run, since the
 *  person who decides is not known yet). Writes nothing. */
export async function correctIssuedPreflight(
  ctx: MutationsCtx,
  input: CorrectIssuedInput,
): Promise<PreflightResult> {
  const r = await planCorrection(ctx, input)
  if ("ok" in r) return { ok: true }
  return { error: r.error }
}

/** The read behind the approval card: before and after of every document the call changes. */
export async function correctIssuedPreview(
  ctx: MutationsCtx,
  input: CorrectIssuedInput,
): Promise<CorrectionPreview> {
  const r = await planCorrection(ctx, input)
  if (!("ok" in r)) {
    return {
      kind: null,
      refusal: r.error,
      documents: [],
      reason: str(input?.reason),
      total_change_reason: str(input?.total_change_reason),
    }
  }
  return {
    kind: r.plan.kind,
    refusal: null,
    documents: r.plan.items.map((i) => ({
      id: String(i.doc.id),
      number: (i.doc.number as string | null) ?? null,
      type: String(i.doc.type),
      currency: String(i.doc.currency ?? "EUR"),
      counterparty_name: (i.doc.counterparty_name as string | null) ?? null,
      total_changed: i.totalChanged,
      changed_fields: i.changedFields,
      before: i.before,
      after: i.after,
    })),
    reason: r.plan.reason,
    total_change_reason: r.plan.totalChangeReason,
  }
}

function lineInsert(documentId: string, l: LineRow): Row {
  return {
    document_id: documentId,
    position: l.position,
    description: l.description,
    quantity: l.quantity,
    unit_price_minor: l.unit_price_minor.toString(),
    discount_minor: l.discount_minor.toString(),
    line_kind: l.line_kind,
    tax_rate_bp: l.tax_rate_bp,
    subtotal_minor: l.subtotal_minor.toString(),
    tax_minor: l.tax_minor.toString(),
    total_minor: l.total_minor.toString(),
    hs_code: l.hs_code,
    country_of_origin: l.country_of_origin,
    customs_description: l.customs_description,
    product_source: l.product_source,
    external_id: l.external_id,
  }
}

export async function correctIssued(
  ctx: MutationsCtx,
  input: CorrectIssuedInput,
): Promise<CorrectIssuedResult> {
  const authority = await authorityRefusal(ctx)
  if (authority) return authority
  const planned = await planCorrection(ctx, input)
  if (!("ok" in planned)) return planned
  const { plan } = planned
  const actor = await ctx.getUserId()
  const decider = ctx.approval?.approvalDeciderId ?? actor
  const now = new Date().toISOString()
  const groupId = plan.items.length > 1 ? crypto.randomUUID() : null

  const ops: Array<Record<string, unknown>> = []
  for (const [i, item] of plan.items.entries()) {
    const id = String(item.doc.id)
    const as = `correction_${i}`
    ops.push({
      insert: "document_corrections",
      as,
      data: {
        document_id: id,
        sequence: item.sequence,
        kind: plan.kind,
        group_id: groupId,
        reason: plan.reason,
        total_changed: item.totalChanged,
        total_change_reason:
          plan.kind === "move_shipping" && item.totalChanged
            ? "shipping line moved between two documents of the same order; the order's total is unchanged"
            : plan.totalChangeReason,
        changed_fields: item.changedFields,
        before: item.before,
        after: item.after,
        previous_legal_original_id: (item.doc.legal_original_id as string | null) ?? null,
        previous_legal_original_sha256: (item.doc.legal_original_sha256 as string | null) ?? null,
        previous_correction_id: (item.doc.current_correction_id as string | null) ?? null,
        previous_pdf_file_id: (item.doc.pdf_file_id as string | null) ?? null,
        corrected_by: actor,
        approved_by: decider,
        approval_request_id: ctx.approval?.approvalRequestId ?? null,
        corrected_at: now,
      },
    })
    if (item.linesChanged) {
      for (const old of item.oldLines) ops.push({ delete: "document_lines", id: String(old.id) })
      for (const l of item.newLines) ops.push({ insert: "document_lines", data: lineInsert(id, l) })
    }
    const log = Array.isArray(item.doc.lifecycle_log) ? (item.doc.lifecycle_log as Row[]) : []
    ops.push({
      update: "documents",
      id,
      expect: { minRows: 1, maxRows: 1 },
      data: {
        ...item.update,
        current_correction_id: { $ref: as },
        pdf_status: "pending",
        lifecycle_log: [
          ...log,
          {
            event: CORRECTED_EVENT,
            actor,
            approved_by: decider,
            ts: now,
            kind: plan.kind,
            sequence: item.sequence,
            fields: item.changedFields,
            reason: plan.reason,
            grand_total_before_minor: item.before.grand_total_minor,
            grand_total_after_minor: item.after.grand_total_minor,
            ...(groupId ? { group_id: groupId } : {}),
          },
        ],
      },
    })
  }
  // The lines, totals and correction records of every document land in ONE commit: a move never
  // leaves the line on both documents or on neither.
  const committed = await ctx.db.batch({ ops: ops as never })

  const out: Extract<CorrectIssuedResult, { status: "completed" }>["documents"] = []
  for (const [i, item] of plan.items.entries()) {
    const id = String(item.doc.id)
    const correctionId = String(committed.rows[`correction_${i}`]?.id ?? "")
    await ctx.emit({
      entity: "document",
      action: "corrected",
      entityId: id,
      data: {
        document_id: id,
        type: String(item.doc.type),
        number: (item.doc.number as string | null) ?? null,
        status: String(item.doc.status ?? ""),
        correction_id: correctionId,
        kind: plan.kind,
        changed_fields: item.changedFields,
        reason: plan.reason,
        total_changed: item.totalChanged,
        changes: {
          subtotal_minor: { from: item.before.subtotal_minor, to: item.after.subtotal_minor },
          tax_total_minor: { from: item.before.tax_total_minor, to: item.after.tax_total_minor },
          grand_total_minor: {
            from: item.before.grand_total_minor,
            to: item.after.grand_total_minor,
          },
          tax_treatment: { from: item.before.tax_treatment, to: item.after.tax_treatment },
        },
      },
    })
    // The corrected file of record. A render failure keeps the correction (pdf_status says so)
    // and documents_retry_pdf renders it again.
    const rendered = await renderCorrection(ctx, id)
    out.push({
      id,
      number: (item.doc.number as string | null) ?? null,
      correction_id: correctionId,
      grand_total_before_minor: item.before.grand_total_minor,
      grand_total_after_minor: item.after.grand_total_minor,
      pdf_status: rendered.ok ? "ready" : "failed",
    })
  }
  const names = out.map((d) => d.number ?? d.id).join(" and ")
  return {
    status: "completed",
    kind: plan.kind,
    documents: out,
    message:
      `${names} corrected in place: same number and date, no new document, nothing mailed. ` +
      "The previous file stays archived with the correction record." +
      (out.some((d) => d.pdf_status !== "ready")
        ? " The corrected PDF did not render: run documents_retry_pdf."
        : ""),
  }
}
