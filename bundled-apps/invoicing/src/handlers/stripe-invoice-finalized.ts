// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Stripe invoice finalized while Liaison issues the invoices of card payments (mode A): one
// Liaison invoice per Stripe invoice, keyed `external_ref = stripe:<in_id>` (unique), in the
// issuer's own series, dated the day the number is taken in the issuer's time zone (never
// `finalized_at`, so a late event never moves a legal date or year).
//
// Steps, in order, each one stopping or parking with its reason:
//   1. the sale already has a document under any of its names (stripe-sale.ts), or Stripe no longer
//      holds the invoice open: stop, and close what waited;
//   1b. with no person deciding: past its last automatic retry, or waiting on its approval card, it
//      stays with the person; a payment with no Stripe invoice always does;
//   2. the card stream: Stripe issues, stop; nobody decided yet, park until a person decides;
//   3. finalized before Stripe was connected: stop;
//   4. a zero total: stop; a negative total: park for a person;
//   5. issuer profile missing: park awaiting_config; buyer's email or address missing: awaiting_data;
//   6. Stripe's tax per line against Liaison's, more than 1 minor unit apart: park for review;
//   7. the e-invoicing gate refuses: park on the buyer's identity;
//   8. above the issuer's approval threshold: a person approves first (the payload waits parked);
//   9. issue, due on the issue date, paid already when Stripe says so; link the Stripe invoice.
//
// A person's click (`byPerson`) that is refused at 4 to 7 leaves the park it was made on as it is:
// nothing it leaves behind issues later by itself.
//
// The typed payload is the Stripe app's `invoice:finalized` (and `invoice:paid`): minor units as
// strings across the JSON bridge, as the Shopify order payload is.
import {
  closeParksOfKind,
  type DeferredRow,
  isBulkDeadLettered,
  park,
  parksOf,
  resolveOpenParks,
  resolveParkAttention,
  STRIPE_INVOICE_PARK,
} from "../deferred"
import {
  EINVOICE_IDENTITY_PARK_KIND,
  GATE_CODES,
  type GateCode,
  raiseIdentityAttention,
} from "../einvoicing/gate"
import { checkEinvoiceGate } from "../einvoicing/issue-gate"
import { issuerParkBlockedOn, raiseIssuerAttention } from "../einvoicing/seller"
import type { Counterparty, DraftLine } from "../issue"
import { civilDateOf, issueDateParts } from "../issue-date"
import { lineAmounts, lineTax } from "../money"
import { findIssuerProfile } from "../mutations/db-helpers"
import { issueWithFxRate } from "../mutations/fx-issue"
import { type ErrorEnvelope, type MutationsCtx, toBigInt } from "../mutations/shared"
import { isoOf, issuerAt, type StreamIssuer, streamRows } from "../streams"
import { isPersonOnly, sayLineOf } from "./stripe-lines"
import { claimOps, isSaleTaken, recordSale, saleDocument, stripeRef } from "./stripe-sale"

export { stripeRef }

type Row = Record<string, unknown>

export interface StripeInvoiceLine {
  description?: string | null
  quantity?: number | string | null
  /** Unit price before tax, minor units. */
  unit_amount_excl_minor?: string | number | null
  /** Line amount as Stripe states it (used when the unit price before tax is absent). */
  amount_minor?: string | number | null
  discount_minor?: string | number | null
  tax_rate_bp?: number | null
  /** Tax Stripe charged on the line, minor units. Absent: the line is not judged. */
  tax_minor?: string | number | null
  period_start?: string | null
  period_end?: string | null
  product_name?: string | null
}

export interface StripeInvoicePayload {
  stripe_invoice_id: string
  customer_id?: string | null
  subscription_id?: string | null
  contact_id?: string | null
  number?: string | null
  status?: string | null
  total_minor: string | number
  tax_minor?: string | number | null
  currency: string
  period_start?: string | null
  period_end?: string | null
  finalized_at?: string | null
  paid_at?: string | null
  charge_id?: string | null
  /** Every charge of the invoice, when there are several. */
  charge_ids?: string[] | null
  billing_reason?: string | null
  next_payment_attempt?: string | null
  failure_code?: string | null
  customer?: {
    name?: string | null
    email?: string | null
    country?: string | null
    address?: string | null
    vat_id?: string | null
  } | null
  lines?: StripeInvoiceLine[]
}

export type StripeCtx = MutationsCtx & {
  resolveContact?(params: { email?: string; name?: string; externalId?: string }): Promise<unknown>
}

export type FinalizedResult =
  | { status: "ok"; document_id: string; number: string }
  | { status: "skipped"; reason: string; document_id?: string }
  | { status: "deferred"; deferred_id: string; reason: string; why?: string; words?: string }
  | { status: "pending_approval"; approval_id: string | null }
  | { status: "error"; error: ErrorEnvelope["error"] }

/** Parks of this flow carry `blocked_on.kind` starting with this, so the retry sweep routes them here. */
export const STRIPE_PARK_PREFIX = "stripe_"
export { STRIPE_INVOICE_PARK }
export const STRIPE_UNDECIDED_PARK = "stripe_issuer_undecided"
export const STRIPE_APPROVAL_PARK = "stripe_invoice_approval"
export const STRIPE_TAX_PARK = "tax_check"

/** The event's payload: the kernel delivers `{entity, action, data}`, a direct call the payload. */
export function payloadOf<T>(event: unknown): T {
  const e = (event ?? {}) as { data?: unknown }
  return (e.data && typeof e.data === "object" ? e.data : event) as T
}

export async function documentByRef(
  ctx: Pick<MutationsCtx, "db">,
  ref: string,
): Promise<Row | null> {
  const rows = (await ctx.db.findMany("documents", {
    where: { external_ref: ref },
    limit: 1,
  })) as Row[]
  return rows[0] ?? null
}

/** The connected card stream that issues a Stripe invoice finalized at `at`, and the issuer it names. */
export async function cardStreamFor(
  ctx: Pick<MutationsCtx, "db">,
  at: string,
  streams?: Row[],
): Promise<{ row: Row; issuer: StreamIssuer } | null> {
  const rows = (streams ?? (await streamRows(ctx))).filter((r) => r.stripe_connected === true)
  if (rows.length === 0) return null
  const named = rows.map((row) => ({ row, issuer: issuerAt(row, at) ?? "undecided" }))
  // Several issuer profiles: the one that issues decides; none issues, the first undecided waits.
  return (
    named.find((n) => n.issuer === "liaison") ??
    named.find((n) => n.issuer === "stripe") ??
    named[0] ??
    null
  )
}

const money = (minor: bigint, currency: string) =>
  `${(Number(minor) / 100).toFixed(2)} ${currency.toUpperCase()}`

function parkPayload(p: StripeInvoicePayload): StripeInvoicePayload & { kind: "stripe_invoice" } {
  return { ...p, kind: "stripe_invoice" }
}

async function parkInvoice(
  ctx: StripeCtx,
  p: StripeInvoicePayload,
  status: "awaiting_config" | "awaiting_data" | "awaiting_dependency",
  reason: string,
  kind: string,
  extra: Row = {},
): Promise<{ id: string; created: boolean }> {
  const def = await park(
    { db: ctx.db },
    {
      event_id: stripeRef(p.stripe_invoice_id),
      event_payload_json: parkPayload(p),
      status,
      reason,
      blocked_on: { kind, stripe_invoice_id: p.stripe_invoice_id, ...extra },
    },
  )
  if (kind !== STRIPE_INVOICE_PARK) await nowWaitsElsewhere(ctx, p)
  return def
}

/** The invoice got past what it first waited for and waits on another park. */
const nowWaitsElsewhere = (ctx: StripeCtx, p: StripeInvoicePayload) =>
  closeParksOfKind(ctx, stripeRef(p.stripe_invoice_id), STRIPE_INVOICE_PARK)

/** What an issue needs of its buyer and Stripe does not hold; null when it is all there. The name
 *  falls back on the email. The one rule of the issue and of the safety job. */
export function buyerLacks(c: StripeInvoicePayload["customer"]): "email" | "address" | null {
  if (typeof c?.email !== "string" || !c.email.includes("@")) return "email"
  return typeof c.address === "string" && c.address.trim() ? null : "address"
}

export const LACKS = {
  email: { reason: "customer_email_missing", words: "its customer has no email in Stripe" },
  address: {
    reason: "customer_address_missing",
    words: "its customer has no billing address in Stripe",
  },
} as const

async function raise(ctx: StripeCtx, action: string, entityId: string, data: Row): Promise<void> {
  if (ctx.emit)
    await ctx.emit({
      entity: "stripe_invoice",
      action,
      entityId,
      data: { ...data, resolved: false },
    })
}

export interface TaxMismatch {
  position: number
  description: string
  tax_rate_bp: number
  computed_minor: string
  stripe_minor: string
}

/** Net of a Stripe line before tax: quantity times the unit price before tax, less the discount. */
function lineNet(l: StripeInvoiceLine): { qty: bigint; unit: bigint; discount: bigint } {
  const qty = BigInt(Math.max(1, Math.round(Number(l.quantity ?? 1)) || 1))
  const discount = toBigInt(l.discount_minor ?? 0)
  if (l.unit_amount_excl_minor != null && l.unit_amount_excl_minor !== "") {
    return { qty, unit: toBigInt(l.unit_amount_excl_minor), discount }
  }
  // Only the line amount is known: the unit price is that amount over the quantity.
  return { qty, unit: toBigInt(l.amount_minor ?? 0) / qty, discount }
}

/**
 * Stripe's tax per line against Liaison's, computed half to even from the line's net at its rate.
 * More than 1 minor unit apart on any line: that line is listed. Lines without Stripe's figure or
 * rate are not judged.
 */
export function stripeTaxMismatches(lines: StripeInvoiceLine[]): TaxMismatch[] {
  const out: TaxMismatch[] = []
  for (const [i, l] of lines.entries()) {
    if (typeof l.tax_rate_bp !== "number" || l.tax_minor == null || l.tax_minor === "") continue
    const { qty, unit, discount } = lineNet(l)
    const computed = lineTax({ subtotal_minor: qty * unit - discount, tax_rate_bp: l.tax_rate_bp })
    const charged = toBigInt(l.tax_minor)
    const diff = computed > charged ? computed - charged : charged - computed
    if (diff > 1n) {
      out.push({
        position: i + 1,
        description: String(l.description ?? ""),
        tax_rate_bp: l.tax_rate_bp,
        computed_minor: computed.toString(),
        stripe_minor: charged.toString(),
      })
    }
  }
  return out
}

/**
 * What the Liaison invoice of these lines totals, computed as issuing computes it (one rounding
 * per line), or null when a line's rate is not known (several taxes on one line).
 */
export function liaisonTotalOf(lines: StripeInvoiceLine[]): bigint | null {
  let total = 0n
  for (const l of lines) {
    if (typeof l.tax_rate_bp !== "number") return null
    const { qty, unit, discount } = lineNet(l)
    total += lineAmounts(
      { quantity: qty.toString(), unit_price_minor: unit, discount_minor: discount },
      l.tax_rate_bp,
    ).total_minor
  }
  return total
}

/** The lines of the Liaison invoice: Stripe's own, at the rate Stripe charged, the period in the description. */
export function invoiceLines(p: StripeInvoicePayload): DraftLine[] {
  return (p.lines ?? []).map((l, i) => {
    const { qty, unit, discount } = lineNet(l)
    const start = (l.period_start ?? p.period_start ?? "").slice(0, 10)
    const end = (l.period_end ?? p.period_end ?? "").slice(0, 10)
    const base = String(l.description ?? l.product_name ?? "Subscription").trim() || "Subscription"
    return {
      position: i + 1,
      description: start && end && !base.includes(start) ? `${base} (${start} to ${end})` : base,
      quantity: qty.toString(),
      unit_price_minor: unit,
      ...(discount > 0n ? { discount_minor: discount } : {}),
      line_kind: "service",
      ...(typeof l.tax_rate_bp === "number" ? { tax_rate_bp_override: l.tax_rate_bp } : {}),
      product_source: null,
      external_id: null,
    }
  })
}

/** The buyer as Stripe names them, linked to a kernel contact by email; null fields stay null. */
async function counterpartyOf(
  ctx: StripeCtx,
  p: StripeInvoicePayload,
  issuerCountry: string,
): Promise<Counterparty> {
  const c = p.customer ?? {}
  const email = typeof c.email === "string" && c.email.includes("@") ? c.email.trim() : null
  let contactId = typeof p.contact_id === "string" && p.contact_id ? p.contact_id : null
  if (!contactId && email && ctx.resolveContact) {
    try {
      const resolved = (await ctx.resolveContact({
        email,
        ...(c.name ? { name: c.name } : {}),
        ...(p.customer_id ? { externalId: `stripe:${p.customer_id}` } : {}),
      })) as { id?: unknown; contactId?: unknown } | null
      const id = resolved?.id ?? resolved?.contactId
      contactId = typeof id === "string" ? id : null
    } catch {
      contactId = null
    }
  }
  const vat = typeof c.vat_id === "string" && c.vat_id.trim() ? c.vat_id.trim() : null
  return {
    contact_id: contactId,
    legal_name: String(c.name ?? "").trim() || (email ?? ""),
    country: String(c.country ?? issuerCountry).toUpperCase(),
    vat_id: vat,
    address: typeof c.address === "string" && c.address.trim() ? c.address.trim() : null,
    email,
    customer_kind: vat ? "business" : "individual",
  }
}

/**
 * A parked Stripe invoice as Stripe answers for it now: the Stripe app reads the invoice again,
 * with the buyer as its mirror holds them today, so a buyer completed in Stripe after the park (an
 * address, a name, an email) reaches the retry, and one voided or paid since is seen. Null when
 * Stripe cannot be read: the payload stored at the park may be out of date (an invoice voided, or
 * paid, or invoiced by hand since), so it is never issued from.
 */
export async function currentStripeInvoice(
  ctx: StripeCtx,
  stripeInvoiceId: string,
): Promise<StripeInvoicePayload | null> {
  if (!ctx.executeTool || !stripeInvoiceId) return null
  try {
    const env = await ctx.executeTool("stripe:invoice_payload", { stripeInvoiceId })
    if (env.status !== "completed") return null
    const fresh = (env.result as { invoice?: StripeInvoicePayload } | null)?.invoice
    return fresh && fresh.stripe_invoice_id === stripeInvoiceId ? fresh : null
  } catch {
    return null
  }
}

/** Why a park of an invoice Stripe no longer holds open (void, uncollectible) was dropped. */
export const NOT_OPEN_IN_STRIPE = "not_open_in_stripe"

/**
 * Whether Stripe still holds the invoice as one to invoice: open or paid. A payload with no status
 * (an older park) reads as the finalized invoice it was parked as.
 */
export function isInvoiceable(p: { status?: string | null }): boolean {
  const status = typeof p.status === "string" ? p.status.trim() : ""
  return status === "" || status === "open" || status === "paid"
}

export interface FinalizedOptions {
  /** A person decided this invoice (issue-now click, or the approval of the threshold card). */
  byPerson?: boolean
  /** The park that person decided on. */
  park?: DeferredRow
  /** The Stripe invoice a clicked payment pays: that invoice is issued whole, never the payment. */
  paysInvoice?: string
}

/** The names a payload gives its sale. */
export const saleNames = (p: StripeInvoicePayload): Array<string | null | undefined> => [
  p.stripe_invoice_id,
  p.charge_id,
  ...(Array.isArray(p.charge_ids) ? p.charge_ids : []),
]

/** The sale has its document: link the Stripe invoice to it and close everything that waited. */
async function alreadyInvoiced(
  ctx: StripeCtx,
  p: StripeInvoicePayload,
  doc: Row,
): Promise<FinalizedResult> {
  const id = String(doc.id)
  await recordSale(ctx, saleNames(p), id)
  if (p.stripe_invoice_id.startsWith("in_"))
    await linkBack(ctx, p.stripe_invoice_id, id, typeof doc.number === "string" ? doc.number : null)
  await closeSale(ctx, saleNames(p), "already_issued")
  return { status: "skipped", reason: "duplicate_document", document_id: id }
}

/** Close the parks of a sale, under each of its names: the given-up ones too, whose line a person
 *  still sees. */
export async function closeSale(
  ctx: StripeCtx,
  ids: ReadonlyArray<string | null | undefined>,
  reason: string,
): Promise<void> {
  for (const id of new Set(ids)) {
    if (!id) continue
    for (const r of await parksOf(ctx, stripeRef(id))) {
      await ctx.db.update("deferred_events", r.id, { status: "resolved", reason })
      await resolveParkAttention(ctx, r)
    }
  }
}

/**
 * With no person deciding, the event (a delivery, a retry, the safety job) changes nothing of what
 * a person decides. Its approval card keeps what it showed, only what Stripe says of the payment is
 * brought up to date; an invoice past its last retry keeps the newest payload, for the line.
 */
async function leftToAPerson(
  ctx: StripeCtx,
  p: StripeInvoicePayload,
): Promise<FinalizedResult | null> {
  const parks = await parksOf(ctx, stripeRef(p.stripe_invoice_id))
  const card = parks.find(
    (r) => r.blocked_on.kind === STRIPE_APPROVAL_PARK && r.status !== "permanent_failure",
  )
  if (card) {
    const shown = (card.event_payload_json ?? {}) as StripeInvoicePayload
    await ctx.db.update("deferred_events", card.id, {
      event_payload_json: withPaymentOf(shown, p),
    })
    return { status: "deferred", deferred_id: card.id, reason: "awaiting_dependency" }
  }
  const capped = parks.find(
    (r) => isPersonOnly({ ...r, status: "awaiting_data" }) && !isBulkDeadLettered(r.reason),
  )
  if (capped) {
    await ctx.db.update("deferred_events", capped.id, {
      ...(p.customer && p.lines ? { event_payload_json: parkPayload(p) } : {}),
      // Given up on by an earlier version: the safety job raises its line.
      ...(capped.status === "permanent_failure" ? { status: "awaiting_data" } : {}),
    })
    return { status: "deferred", deferred_id: capped.id, reason: "waits_for_a_person" }
  }
  if (!p.stripe_invoice_id.startsWith("in_"))
    return { status: "skipped", reason: "waits_for_a_person" }
  return null
}

/** What was shown of an invoice, with the payment Stripe reports of it now. */
export const withPaymentOf = (
  shown: StripeInvoicePayload,
  now: StripeInvoicePayload,
): StripeInvoicePayload => ({
  ...shown,
  status: now.status ?? shown.status,
  paid_at: now.paid_at ?? shown.paid_at,
  charge_id: now.charge_id ?? shown.charge_id,
  ...(now.charge_ids ? { charge_ids: now.charge_ids } : {}),
})

/**
 * A person's click is refused for now: the park it was made on stays the only one, with what was
 * missing, so nothing issues later that nobody decided again.
 */
async function refuseClick(
  ctx: StripeCtx,
  on: DeferredRow | undefined,
  why: string,
  words: string,
): Promise<FinalizedResult> {
  if (on) await noteRefusal(ctx, on, why, words)
  return { status: "deferred", deferred_id: on?.id ?? "", reason: "awaiting_data", why, words }
}

/** What an invoice past its retries was last refused for, on its park and its line. */
export async function noteRefusal(
  ctx: StripeCtx,
  on: DeferredRow,
  why: string,
  words: string,
): Promise<void> {
  if (!isPersonOnly(on)) return
  // What the job cannot see for itself stays on the line; an incomplete buyer it reads again.
  const read = why === LACKS.email.reason || why === LACKS.address.reason
  const blocked_on = { ...on.blocked_on, refused: read ? null : words }
  await ctx.db.update("deferred_events", on.id, { reason: why, blocked_on })
  if (!read) await sayLineOf(ctx, on.id, refusedText(words))
}

/** The Home line of an invoice whose last click was refused. */
export const refusedText = (words: string) =>
  `its last issue was refused: ${words}. Fix that, then issue it`

/**
 * Issue the Liaison invoice of one finalized Stripe invoice, or say why not. Idempotent: the
 * unique key stops a replay, a re-emit and a second worker; a concurrent second issue rolls back
 * with its transaction and takes no number.
 */
export async function onStripeInvoiceFinalized(
  event: unknown,
  ctx: StripeCtx,
  opts: FinalizedOptions = {},
): Promise<FinalizedResult> {
  const p = payloadOf<StripeInvoicePayload>(event)
  if (!p || typeof p.stripe_invoice_id !== "string" || !p.stripe_invoice_id) {
    return { status: "skipped", reason: "invalid_payload" }
  }
  const ref = stripeRef(p.stripe_invoice_id)

  // 1. One document per sale, whatever made it and whichever of its names it carries.
  const existing = await saleDocument(ctx, saleNames(p))
  if (existing) return alreadyInvoiced(ctx, p, existing)

  // An invoice voided or written off in Stripe since it was finalized (a park retried later
  // reads it again) has nothing left to invoice: its park is dropped and no number is taken.
  if (!isInvoiceable(p)) {
    await resolveOpenParks(ctx, ref, NOT_OPEN_IN_STRIPE)
    return { status: "skipped", reason: NOT_OPEN_IN_STRIPE }
  }

  // 1b. What a person decides is never decided by an event.
  if (!opts.byPerson) {
    const left = await leftToAPerson(ctx, p)
    if (left) return left
  }
  const drop = async (reason: string): Promise<FinalizedResult> => {
    await resolveOpenParks(ctx, ref, reason)
    return { status: "skipped", reason }
  }

  // 2. Who issues.
  const finalizedAt = isoOf(p.finalized_at) ?? new Date().toISOString()
  const stream = await cardStreamFor(ctx, finalizedAt)
  if (!stream) {
    if (opts.byPerson)
      return refuseClick(ctx, opts.park, "card_stream_missing", "no card stream issues it")
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_config",
      "card_stream_missing",
      STRIPE_INVOICE_PARK,
    )
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_config" }
  }
  if (stream.issuer === "stripe") {
    await markIssuedBy(ctx, p.stripe_invoice_id, "stripe")
    return drop("issued_by_stripe")
  }
  if (stream.issuer === "undecided" && !opts.byPerson) {
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_config",
      "issuer_undecided",
      STRIPE_UNDECIDED_PARK,
      {
        issuer_profile_id: stream.row.issuer_profile_id ?? null,
      },
    )
    if (def.created) {
      await raise(ctx, "issuer_undecided", def.id, {
        deferred_id: def.id,
        stripe_invoice_id: p.stripe_invoice_id,
        total: money(toBigInt(p.total_minor), p.currency),
      })
    }
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_config" }
  }

  // 3. Finalized before Stripe was connected: Stripe's invoice stands alone.
  const connectedAt = isoOf(stream.row.created_at)
  if (connectedAt && finalizedAt < connectedAt) {
    await markIssuedBy(ctx, p.stripe_invoice_id, "before_connection")
    return drop("before_connection")
  }

  // 3b. A payment of a Stripe invoice is never invoiced by itself: it may be a part of it.
  if (opts.paysInvoice)
    return refuseClick(
      ctx,
      opts.park,
      "pays_stripe_invoice",
      `it pays the Stripe invoice ${opts.paysInvoice}, which is invoiced as a whole: issue that one (stripeInvoiceId) once it waits here, or link this payment to the invoice already made for it`,
    )

  // 4. Totals.
  const total = toBigInt(p.total_minor)
  if (total === 0n) {
    // Nothing to invoice: Stripe's own zero invoice stands.
    await markIssuedBy(ctx, p.stripe_invoice_id, "stripe")
    return drop("zero_total")
  }
  if (total < 0n) {
    if (opts.byPerson) return refuseClick(ctx, opts.park, "negative_total", "its total is negative")
    const def = await parkInvoice(ctx, p, "awaiting_data", "negative_total", STRIPE_INVOICE_PARK)
    await sayLineOf(ctx, def.id, "its total is negative")
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // 5. Issuer and buyer.
  const issuer = await findIssuerProfile(ctx.db, String(stream.row.issuer_profile_id ?? ""))
  if (!issuer) {
    if (opts.byPerson)
      return refuseClick(
        ctx,
        opts.park,
        "issuer_profile_missing",
        "the issuer profile of card payments is missing",
      )
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_config",
      "issuer_profile_missing",
      STRIPE_INVOICE_PARK,
    )
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_config" }
  }
  const counterparty = await counterpartyOf(ctx, p, issuer.country)
  const lacks = buyerLacks(p.customer)
  if (lacks) {
    const { reason, words } = LACKS[lacks]
    if (opts.byPerson) return refuseClick(ctx, opts.park, reason, words)
    const def = await parkInvoice(ctx, p, "awaiting_data", reason, STRIPE_INVOICE_PARK, {
      customer_id: p.customer_id ?? null,
      ...(lacks === "address" ? { contact_id: counterparty.contact_id } : {}),
    })
    await sayLineOf(ctx, def.id, `${words}. Add it there and the invoice is issued`)
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // 6. Tax as charged, line by line.
  const mismatches = stripeTaxMismatches(p.lines ?? [])
  if (mismatches.length > 0) {
    if (opts.byPerson)
      return refuseClick(
        ctx,
        opts.park,
        "stripe_tax_mismatch",
        `line ${mismatches[0]?.position}: Stripe charged ${mismatches[0]?.stripe_minor} of tax, Liaison computes ${mismatches[0]?.computed_minor}`,
      )
    const def = await parkInvoice(ctx, p, "awaiting_data", "stripe_tax_mismatch", STRIPE_TAX_PARK, {
      lines: mismatches,
    })
    if (def.created && ctx.emit) {
      await ctx.emit({
        entity: "deferred",
        action: "stripe_tax_review",
        entityId: def.id,
        data: {
          deferred_id: def.id,
          stripe_invoice_id: p.stripe_invoice_id,
          reason: `line ${mismatches[0]?.position}: Stripe charged ${mismatches[0]?.stripe_minor}, Liaison computes ${mismatches[0]?.computed_minor}`,
          resolved: false,
        },
      })
    }
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // 6b. The whole invoice as charged. Each line's tax may differ from Stripe's by one minor unit
  //     (checked above); what that leaves goes on one 0-tax "Rounding adjustment" line, so the
  //     invoice totals the charge exactly. Anything more, or a line with several taxes (no single
  //     rate to issue at), waits for a person.
  const liaisonTotal = liaisonTotalOf(p.lines ?? [])
  const residual = liaisonTotal === null ? null : total - liaisonTotal
  const tolerance = BigInt((p.lines ?? []).length)
  if (residual === null || residual > tolerance || -residual > tolerance) {
    const difference =
      liaisonTotal === null
        ? "a line carries several taxes, so no single rate can be issued"
        : `Stripe charged ${money(total, p.currency)}, Liaison computes ${money(liaisonTotal, p.currency)}`
    if (opts.byPerson) return refuseClick(ctx, opts.park, "stripe_total_mismatch", difference)
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_data",
      "stripe_total_mismatch",
      STRIPE_TAX_PARK,
      {
        liaison_total_minor: liaisonTotal === null ? null : liaisonTotal.toString(),
        stripe_total_minor: total.toString(),
      },
    )
    if (def.created && ctx.emit) {
      await ctx.emit({
        entity: "deferred",
        action: "stripe_tax_review",
        entityId: def.id,
        data: {
          deferred_id: def.id,
          stripe_invoice_id: p.stripe_invoice_id,
          reason: difference,
          resolved: false,
        },
      })
    }
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  const lines = invoiceLines(p)
  if (residual !== 0n) {
    lines.push({
      position: lines.length + 1,
      description: "Rounding adjustment",
      quantity: "1",
      unit_price_minor: residual,
      line_kind: "service",
      tax_rate_bp_override: 0,
      product_source: null,
      external_id: null,
    })
  }
  // 7. The e-invoicing gate, before any number.
  const gate = await checkEinvoiceGate(ctx, { type: "invoice", issuer, counterparty, lines })
  if (!gate.ok && "seller" in gate) {
    // Enforce mode: the organization's own issuer profile cannot sign the e-invoice. The invoice
    // waits on the issuer (never on the buyer's identity), the people who may edit the issuer get
    // one attention item, and it is issued once Settings is completed.
    const gap = gate.error.error
    if (opts.byPerson)
      return refuseClick(
        ctx,
        opts.park,
        "issuer_incomplete",
        "the issuer profile cannot sign an e-invoice",
      )
    const def = await park(
      { db: ctx.db },
      {
        event_id: stripeRef(p.stripe_invoice_id),
        event_payload_json: parkPayload(p),
        status: "awaiting_dependency",
        reason: "issuer_incomplete",
        blocked_on: { ...issuerParkBlockedOn(gap), stripe_invoice_id: p.stripe_invoice_id },
      },
    )
    await nowWaitsElsewhere(ctx, p)
    await raiseIssuerAttention(ctx, {
      park: def,
      gap,
      waiting: `Stripe invoice ${p.number ?? p.stripe_invoice_id}`,
    })
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_dependency" }
  }
  if (!gate.ok) {
    const code = String(gate.error.error.code ?? "einvoice_gate")
    if (opts.byPerson)
      return refuseClick(
        ctx,
        opts.park,
        code,
        "its customer's e-invoicing identity is not complete",
      )
    const def = await parkInvoice(ctx, p, "awaiting_data", code, EINVOICE_IDENTITY_PARK_KIND, {
      contact_id: counterparty.contact_id,
      code,
    })
    if ((GATE_CODES as readonly string[]).includes(code)) {
      await raiseIdentityAttention(ctx, {
        park: def,
        contact_id: counterparty.contact_id,
        code: code as GateCode,
        data: {
          order_label: p.number ?? p.stripe_invoice_id,
          contact_label: counterparty.legal_name,
        },
      })
    }
    return { status: "deferred", deferred_id: def.id, reason: "awaiting_data" }
  }

  // 8. Above the threshold a person approves first; the payload waits parked under its key.
  const threshold =
    issuer.invoice_approval_threshold_minor != null
      ? toBigInt(issuer.invoice_approval_threshold_minor)
      : null
  if (!opts.byPerson && !ctx.approval && threshold != null && total > threshold) {
    const def = await parkInvoice(
      ctx,
      p,
      "awaiting_dependency",
      "approval_pending",
      STRIPE_APPROVAL_PARK,
    )
    if (!def.created)
      return { status: "deferred", deferred_id: def.id, reason: "awaiting_dependency" }
    const approval = await ctx.requestApproval({
      tool_name: "invoicing:invoice_from_stripe_payment",
      summary: `Issue the invoice of Stripe invoice ${p.number ?? p.stripe_invoice_id} (${money(total, p.currency)}) for ${counterparty.legal_name}`,
      summary_detail: {
        subtitle: "Above the approval threshold of this issuer",
        lines: [
          `It takes the next number of ${issuer.legal_name}'s invoices, dated the day it is approved.`,
        ],
      },
      current_payload: { stripeInvoiceId: p.stripe_invoice_id },
    })
    return { status: "pending_approval", approval_id: approval.approval_id }
  }

  // 9. Issue.
  const when = await issueDateParts(ctx, issuer)
  if (!when.ok) return { status: "error", error: when.error.error }
  let settlement: { paid_at: string; source: string } | null = null
  if (p.status === "paid" && p.paid_at) {
    const paid = await civilDateOf(ctx, issuer, p.paid_at)
    if (paid.ok) settlement = { paid_at: paid.date, source: "stripe" }
  }
  const issuing = {
    type: "invoice" as const,
    issuer,
    counterparty,
    external_ref: ref,
    // Every name of the sale, unique: of two transactions on it, one commits (stripe-sale.ts).
    commit_with: claimOps(saleNames(p), { $ref: "document" }),
    // Issued with no person: its e-invoice goes out like every other no-person issue (the card
    // stream's standing authorization when on, else the daily send card), never its own card.
    einvoice_send: opts.byPerson ? ("stage" as const) : ("batch" as const),
    ...(settlement ? { settlement } : {}),
    draft: {
      currency: p.currency.toUpperCase(),
      incoterm: "DAP",
      year_of_issue: when.year_of_issue,
      issued_at: when.issued_at,
      due_at: when.issued_at,
      external_refs: {
        stripe_invoice_id: p.stripe_invoice_id,
        ...(p.number ? { stripe_invoice_number: p.number } : {}),
        ...(p.charge_id ? { stripe_charge_id: p.charge_id } : {}),
        ...(p.subscription_id ? { stripe_subscription_id: p.subscription_id } : {}),
        ...(p.customer_id ? { stripe_customer_id: p.customer_id } : {}),
      },
      lines,
    },
  }
  let issued: Awaited<ReturnType<typeof issueWithFxRate>>
  try {
    issued = await issueWithFxRate(ctx, issuing)
  } catch (err) {
    // Another transaction issued or linked this sale between the check above and the commit:
    // this one rolled back, with its number.
    const other = isSaleTaken(err) ? await saleDocument(ctx, saleNames(p)) : null
    if (!other) throw err
    return alreadyInvoiced(ctx, p, other)
  }
  if (!issued.ok) return { status: "error", error: issued.error.error }
  await closeSale(ctx, saleNames(p), "issued")
  await linkBack(ctx, p.stripe_invoice_id, issued.result.document_id, issued.result.number ?? null)
  await noticeIfLate(ctx, p, issuer, when.issued_at, issued.result)
  return { status: "ok", document_id: issued.result.document_id, number: issued.result.number }
}

/** The period the invoice bills: its lines' own, else the one Stripe gives the invoice. */
function periodText(p: StripeInvoicePayload): string {
  const days = (k: "period_start" | "period_end") =>
    (p.lines ?? [])
      .map((l) => (l[k] ?? p[k] ?? "").slice(0, 10))
      .filter(Boolean)
      .sort()
  const start = days("period_start")[0]
  const end = days("period_end").at(-1)
  return start && end ? `${start} to ${end}` : "not given by Stripe"
}

/**
 * Stripe finalized the invoice in an earlier calendar month than the one Liaison dated it in (the
 * zone of the issue date): the people who issue invoices are told once. The period billed decides
 * nothing: an invoice in arrears and a cycle renewal both bill across months.
 */
async function noticeIfLate(
  ctx: StripeCtx,
  p: StripeInvoicePayload,
  issuer: { timezone?: string | null },
  issuedAt: string,
  doc: { document_id: string; number?: string | null },
): Promise<void> {
  const finalizedAt = isoOf(p.finalized_at)
  if (!finalizedAt) return
  const finalizedOn = await civilDateOf(ctx, issuer, finalizedAt)
  if (!finalizedOn.ok) return
  const finalizedMonth = finalizedOn.date.slice(0, 7)
  const issuedMonth = issuedAt.slice(0, 7)
  if (finalizedMonth >= issuedMonth) return
  await raise(ctx, "issued_late_period", doc.document_id, {
    document_id: doc.document_id,
    number: doc.number ?? null,
    stripe_number: p.number ?? p.stripe_invoice_id,
    period: periodText(p),
    finalized_month: finalizedMonth,
    issued_month: issuedMonth,
  })
}

/** Tell the Stripe app that Stripe's own invoice stands (no Liaison document), so its safety job
 *  walks past it. Best effort: the next run asks again. */
async function markIssuedBy(
  ctx: StripeCtx,
  stripeInvoiceId: string,
  issuedBy: "stripe" | "before_connection",
): Promise<void> {
  if (!ctx.executeTool) return
  try {
    await ctx.executeTool("stripe:invoice_document_link", { stripeInvoiceId, issuedBy })
  } catch {
    // Examined again on the next run; it decides the same.
  }
}

/** Tell the Stripe app which document its invoice became (`liaison_document_id`, set once). Best effort. */
export async function linkBack(
  ctx: StripeCtx,
  stripeInvoiceId: string,
  documentId: string,
  documentNumber: string | null = null,
): Promise<void> {
  if (!ctx.executeTool) return
  try {
    await ctx.executeTool("stripe:invoice_document_link", {
      stripeInvoiceId,
      documentId,
      ...(documentNumber ? { documentNumber } : {}),
    })
  } catch {
    // The safety job finds it again; the document itself is what counts.
  }
}
