// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: draft line normalisation, net-of-tax lines, line financials, the
// two-eyes check and the issue input built from a draft.

import { counterpartyEinvoiceFields, type EinvoiceRowColumns } from "../einvoicing/issue-gate"
import {
  type Counterparty,
  type DraftLine,
  type DraftLineInput,
  type IssuerProfile,
  storedTaxCountry,
} from "../issue"
import type { IssueDateParts } from "../issue-date"
import { lineAmounts, netOfIncludedTax } from "../money"
import { type ClassifyInput, classify, KNOWN_COUNTRIES } from "../tax"
import {
  coerceMinorAmount,
  type DocumentType,
  type DraftRow,
  type ErrorEnvelope,
  lineAmountsError,
  type MutationsCtx,
} from "./shared"

// ── Invoice issuance (threshold-gated) ────────────────────────────────────

/**
 * Phase 17 fix T2 — in-handler two-eyes guard. On post-approval re-entry,
 * if the issuer profile has `require_two_eyes: true`, reject the mutation
 * when the deciding actor is the same as the calling actor.
 *
 * `ctx.approval.approvalDeciderId` is the actor that approved the request;
 * `await ctx.getUserId()` is the actor currently re-running the handler. The
 * kernel re-enters with the original requester as the actor, so these only
 * collide if the requester also approved (self-approval).
 */
export async function checkTwoEyes(
  ctx: MutationsCtx,
  issuer: { require_two_eyes?: boolean },
): Promise<ErrorEnvelope | null> {
  if (!issuer.require_two_eyes) return null
  if (!ctx.approval) return null
  if (ctx.approval.approvalDeciderId === (await ctx.getUserId())) {
    return {
      status: "error",
      error: {
        code: "two_eyes_required",
        message:
          "issuer profile requires two-eyes: the approving user must be different from the requesting user",
      },
    }
  }
  return null
}

/**
 * Coerce a single draft line so its bigint fields are real bigints. Wire
 * payloads (from JSON HTTP bodies) deliver `unit_price_minor` as a string
 * or number; the math helpers in `money.ts` strict-error on `bigint *
 * string`. This is the single boundary that promotes the input shape.
 */
export function normaliseDraftLine(l: DraftLineInput): DraftLine {
  return liftMisplacedCountryOnLine(
    liftMisplacedHsCode({
      ...l,
      // Canonicalise at the boundary (mirrors unit_price_minor): the wire / an edited approval
      // payload can deliver `quantity` as a NUMBER, but DraftLine.quantity is a decimal STRING and
      // parseDecimalQuantity downstream expects string semantics. String() makes a number "6"; a
      // genuinely-missing value stringifies to "undefined" and surfaces a descriptive invalid-quantity.
      quantity: String(l.quantity),
      unit_price_minor: coerceMinorAmount(l.unit_price_minor, "unit_price_minor"),
      discount_minor:
        l.discount_minor != null
          ? coerceMinorAmount(l.discount_minor, "discount_minor")
          : undefined,
    }),
  )
}

/**
 * HS-code format per the WCO Harmonized System: a dotted heading.subheading, optionally a
 * further national subdivision — e.g. `9207.90` or `9207.90.00`. The dotted shape is an
 * unambiguous HS signal in a line context; a bare integer (`920790`) could be a SKU/price/qty,
 * so it is NOT lifted.
 */
const MISPLACED_HS_CODE_RE = /\b\d{4}\.\d{2}(?:\.\d{2})?\b/

/**
 * Forgiving customs-facts normalization. A weak agent — especially when the user HANDS it the
 * codes — routinely writes the HS code into the free-text `customs_description` (or the item
 * `description`) instead of the structured `hs_code` field. The code then never reaches the
 * structured per-line customs data the commercial/export-invoice overlay is built from
 * (`issue.ts` "inline customs facts win"), `documents_get` reports `hs_code: null`, and a
 * correctly-STATED code silently fails the export. When `hs_code` is empty but a free-text field
 * carries a clear dotted HS token, lift the FIRST such token into `hs_code`. Conservative: an
 * explicit `hs_code` always wins (so the inline path is untouched), only the unambiguous dotted
 * format is lifted, and the source free-text is left intact (never destroys a real goods
 * description). General robustness — applies to every drafts_create / drafts_update / create-and-
 * issue path through normaliseDraftLine.
 */
export function liftMisplacedHsCode(line: DraftLine): DraftLine {
  if (line.hs_code && String(line.hs_code).trim()) return line
  for (const source of [line.customs_description, line.description]) {
    const match = source ? String(source).match(MISPLACED_HS_CODE_RE) : null
    if (match) return { ...line, hs_code: match[0] }
  }
  return line
}

/**
 * BL-44 — forgiving COUNTRY field normalization (the `liftMisplacedHsCode` analogue for country
 * codes). `counterparty_country` is the FIELD OF RECORD that drives tax treatment: `classify()`
 * re-derives export/reverse-charge/domestic from it at issue (`tax.ts`), and a NULL counterparty
 * country silently falls back to the issuer's DOMESTIC rate (no error). `tax_treatment` is only an
 * informational hint. A weak agent correcting/setting the destination routinely writes the country
 * code into `tax_treatment` ("US"/"JP"/"GB") instead of `counterparty_country`, so the document
 * issues at the wrong rate (domestic 20% instead of export 0%) with nothing to flag it. When
 * `counterparty_country` is empty but `tax_treatment` holds a bare KNOWN country token, lift it onto
 * `counterparty_country` and clear the misplaced hint (a real treatment keyword like "export" is not
 * a 2-letter country code, so it never matches — conservative). An explicit `counterparty_country`
 * always wins. Mirrors BL-39/BL-25/BL-41: fix the weak-model field-placement at the boundary,
 * mechanically, not via prompt text.
 */
export function liftMisplacedCountry<
  T extends { counterparty_country?: string | null; tax_treatment?: string | null },
>(header: T): T {
  if (header.counterparty_country && String(header.counterparty_country).trim()) return header
  const hint =
    typeof header.tax_treatment === "string" ? header.tax_treatment.trim().toUpperCase() : ""
  if (hint && KNOWN_COUNTRIES.has(hint)) {
    return { ...header, counterparty_country: hint, tax_treatment: null }
  }
  return header
}

/**
 * BL-44 (line variant) — lift a bare country token misplaced into the free-text `customs_description`
 * onto the structured `country_of_origin` for an export line. Only fires when `country_of_origin` is
 * empty AND `customs_description` is EXACTLY a known ISO-2 token (a real goods description never
 * equals a bare country code), so a genuine description is never destroyed. Mirrors liftMisplacedHsCode.
 */
export function liftMisplacedCountryOnLine(line: DraftLine): DraftLine {
  if (line.country_of_origin && String(line.country_of_origin).trim()) return line
  const cd =
    typeof line.customs_description === "string"
      ? line.customs_description.trim().toUpperCase()
      : ""
  if (cd && KNOWN_COUNTRIES.has(cd)) {
    return { ...line, country_of_origin: cd, customs_description: null }
  }
  return line
}

/** Apply normaliseDraftLine over an array, preserving order. */
export function normaliseDraftLines(lines: DraftLineInput[], field = "items"): DraftLine[] {
  // Defensive boundary: the type says DraftLine[], but a re-entry / edited approval payload can
  // deliver `items` as a NON-array (a stringified JSON, an object, a scalar). `.map` on that throws
  // QuickJS's contentless "not a function", which aborts the WHOLE gated issuance as a terse
  // handler_ambiguous → 422 with no diagnosable cause. Surface a descriptive error instead.
  if (!Array.isArray(lines)) {
    throw new Error(
      `invoicing: draft lines must be an array, got ${typeof lines} (${JSON.stringify(lines)?.slice(0, 160)})`,
    )
  }
  const amounts = lineAmountsError(lines, field)
  if (amounts) throw new Error(`${amounts.error.code}: ${amounts.error.message}`)
  return lines.map(normaliseDraftLine)
}

/**
 * Compute the grand total that `issueDocument` will persist for the given
 * lines and tax classifier input. Lines with a `tax_rate_bp_override` use
 * that rate; lines without fall back to the classifier's `default_rate_bp`.
 * This is the single source of truth for both the threshold gate and the
 * persistence layer so the two always compare the same amount.
 */
/**
 * Net-of-tax the lines a HUMAN or an AGENT typed, when the issuer profile says typed prices are
 * gross.
 *
 * `prices_include_tax` mirrors the Shopify shop's "include tax in prices" setting, so a price
 * typed on a quote line means exactly what the same price means in the Shopify admin: 120.00
 * typed for a French customer is 100.00 net plus 20.00 of VAT, not 120.00 plus 24.00. Documents
 * always STORE net unit prices and re-derive tax from the rate, so the division happens ONCE,
 * here, at the boundary where typed lines enter (create-and-issue and drafts_create). Lines that
 * arrive already net -- the Shopify draft-order sync, a convert-to-invoice, an update of an
 * existing document -- must never come through here or the tax would be divided out twice.
 *
 * A line the document charges no tax on (reverse charge, export, an explicit 0 bp override) keeps
 * the price exactly as typed: there is no included tax to remove.
 */
export function netLinesForIssuer<
  T extends {
    unit_price_minor: bigint
    discount_minor?: bigint
    tax_rate_bp_override?: number
  },
>(items: T[], issuer: { prices_include_tax?: boolean }, classifyInput: ClassifyInput): T[] {
  if (!issuer.prices_include_tax) return items
  const { default_rate_bp } = classify(classifyInput)
  return items.map((l) => {
    const rate =
      typeof l.tax_rate_bp_override === "number" ? l.tax_rate_bp_override : default_rate_bp
    if (rate <= 0) return l
    const next: T = { ...l, unit_price_minor: netOfIncludedTax(l.unit_price_minor, rate) }
    if (l.discount_minor != null) next.discount_minor = netOfIncludedTax(l.discount_minor, rate)
    return next
  })
}

export function computeLineFinancials(
  lines: DraftLine[],
  classifyInput: ClassifyInput,
): { subtotal: bigint; tax: bigint; grand: bigint } {
  const { default_rate_bp } = classify(classifyInput)
  let subtotal = 0n
  let tax = 0n
  for (const l of lines) {
    const rate =
      typeof l.tax_rate_bp_override === "number" ? l.tax_rate_bp_override : default_rate_bp
    const amounts = lineAmounts(
      {
        quantity: l.quantity,
        unit_price_minor: coerceMinorAmount(l.unit_price_minor, "unit_price_minor"),
        discount_minor:
          l.discount_minor == null ? 0n : coerceMinorAmount(l.discount_minor, "discount_minor"),
      },
      rate,
    )
    subtotal += amounts.subtotal_minor
    tax += amounts.tax_minor
  }
  return { subtotal, tax, grand: subtotal + tax }
}

/**
 * Build the issue-time counterparty from a DOCUMENT ROW's own snapshot columns (a draft row, or
 * the source document of a convert). Every draft-based issuance path goes through this so the
 * recipient the operator typed into the draft's Customer section is the recipient that lands on
 * the issued document.
 *
 * It replaces a family of hardcoded stubs (`legal_name: "Customer"`, `address: null`,
 * `email: null`) that silently DROPPED the draft's counterparty snapshot: an invoice issued from
 * a UI draft came out addressed to "Customer" with no address and no email, even though the
 * columns held the real values. Only `country` keeps a fallback (the issuer's country = domestic),
 * because the tax classifier needs a country and a blank one must not silently zero-rate.
 */
export function counterpartyFromRow(
  row: {
    counterparty_contact_id: string | null
    counterparty_name?: string | null
    counterparty_address?: string | null
    counterparty_shipping_address?: string | null
    counterparty_shipping_name?: string | null
    counterparty_vat_id?: string | null
    counterparty_email?: string | null
    counterparty_country?: string | null
    external_refs?: unknown
    /** Stored e-invoicing columns (kind, SIREN and its confirmation, structured billing). */
    einvoice?: EinvoiceRowColumns
  },
  issuer: { country: string },
): Counterparty {
  return {
    ...(row.einvoice ? counterpartyEinvoiceFields(row.einvoice) : {}),
    contact_id: row.counterparty_contact_id ?? null,
    legal_name: row.counterparty_name ?? "",
    // Real counterparty country drives export zero-rating; issuer country is the domestic fallback.
    country: row.counterparty_country ?? issuer.country,
    // The tax destination, when the row recorded one apart from its billing country.
    tax_country: storedTaxCountry(row),
    vat_id: row.counterparty_vat_id ?? null,
    address: row.counterparty_address ?? null,
    // Carried, never classified: `country` above stays the only tax input.
    shipping_address: row.counterparty_shipping_address ?? null,
    shipping_name: row.counterparty_shipping_name ?? null,
    email: row.counterparty_email ?? null,
  }
}

export function buildIssueInputFromDraft(
  draft: DraftRow,
  issuer: IssuerProfile,
  counterparty: Counterparty,
  when: IssueDateParts,
): {
  type: DocumentType
  issuer: IssuerProfile
  counterparty: Counterparty
  initial_status: string
  operation_category: DraftRow["operation_category"]
  draft: {
    currency: string
    incoterm: string
    year_of_issue: number
    issued_at: string
    due_at: string | null
    external_refs: Record<string, unknown>
    notes: string | null
    lines: DraftLine[]
  }
} {
  return {
    type: draft.type,
    issuer,
    counterparty,
    // Same rule as the create-and-issue path: a quote is born "sent" (a live offer),
    // everything else "issued".
    initial_status: draft.type === "quote" ? "sent" : "issued",
    // The category stated on the draft (drafts_create / drafts_update), else null.
    operation_category: draft.operation_category ?? null,
    draft: {
      currency: draft.currency,
      incoterm: draft.incoterm ?? "DAP",
      year_of_issue: when.year_of_issue,
      issued_at: when.issued_at,
      due_at: draft.due_at ?? null,
      external_refs: draft.external_refs ?? {},
      // Carried from the draft onto the issued document: a note typed while drafting is
      // exactly the note the customer is meant to read on the issued PDF.
      notes: draft.notes ?? null,
      lines: draft.lines,
    },
  }
}
