// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Stripe payment no invoice explains, after the connection: one row in the deferred queue and
// one attention item, never silent, never twice for one charge. A person resolves it with one of
// two gated tools, never auto-approved:
//   invoice_from_stripe_payment: issue the Liaison invoice now (it takes the next number), keyed
//     like any document made from that charge (`stripeDocumentRef`), so it never doubles a
//     finalized invoice; with `stripeInvoiceId` it issues a Stripe invoice that waited for a
//     person (the card stream undecided, above the approval threshold, or past its last automatic
//     retry). Each click reads the invoice or the payment from Stripe at that moment: it issues
//     what Stripe answers, or refuses with the reason and takes no number (Stripe unreadable, void,
//     already invoiced, the buyer incomplete). A refused click leaves nothing that issues later;
//   payment_link_to_invoice: link the charge to an invoice already issued, once, and close what
//     waited for the sale: the payment and its Stripe invoice.
import { type DeferredRow, openRowsOf, park, parksOf, toDeferredRow } from "../deferred"
import { lineTax, netOfIncludedTax } from "../money"
import { toBigInt } from "../mutations/shared"
import { isoOf, streamRows, stripeDocumentRef } from "../streams"
import {
  closeSale,
  currentStripeInvoice,
  type FinalizedResult,
  linkBack,
  NOT_OPEN_IN_STRIPE,
  noteRefusal,
  onStripeInvoiceFinalized,
  payloadOf,
  STRIPE_APPROVAL_PARK,
  type StripeCtx,
  type StripeInvoicePayload,
  saleNames,
  withPaymentOf,
} from "./stripe-invoice-finalized"
import type { LinesCtx } from "./stripe-lines"
import { claimOps, isSaleTaken, saleDocument, stripeRef } from "./stripe-sale"

type Row = Record<string, unknown>

export interface StripePaymentPayload {
  charge_id: string
  invoice_id?: string | null
  customer_id?: string | null
  contact_id?: string | null
  amount_minor: string | number
  currency: string
  created?: string | null
  description?: string | null
  customer?: StripeInvoicePayload["customer"]
}

export const STRIPE_UNMATCHED_PARK = "stripe_unmatched_payment"

const fail = (code: string, message: string) => ({
  status: "error" as const,
  error: { code, message },
})
const money = (minor: bigint, currency: string) =>
  `${(Number(minor) / 100).toFixed(2)} ${currency.toUpperCase()}`

async function connectedSince(ctx: StripeCtx): Promise<string | null> {
  const rows = (await streamRows(ctx)).filter((r) => r.stripe_connected === true)
  const times = rows
    .map((r) => isoOf(r.created_at))
    .filter((t): t is string => !!t)
    .sort()
  return rows.length === 0 ? null : (times[0] ?? "")
}

/**
 * Money first: the customer of a billing plan's quote paid while the plan's advance has no invoice
 * yet. The payment may be that advance, so its one Home line asks which: draft the advance invoice
 * (`advance_draft_create`), or not an advance (issue or link it as any unmatched payment). Null
 * when no plan waits on this customer.
 */
async function waitingAdvance(ctx: StripeCtx, contactId: string | null): Promise<Row | null> {
  if (!contactId) return null
  const steps = (await ctx.db.findMany("billing_steps", {
    where: { kind: "advance", state: "planned" },
    limit: 200,
  })) as Row[]
  for (const step of steps) {
    if (typeof step.document_id === "string" || typeof step.quote_document_id !== "string") continue
    const quote = (
      (await ctx.db.findMany("documents", {
        where: { id: step.quote_document_id },
        limit: 1,
      })) as Row[]
    )[0]
    if (quote?.counterparty_contact_id === contactId) return step
  }
  return null
}

export async function onStripePaymentUnmatched(event: unknown, ctx: StripeCtx) {
  const p = payloadOf<StripePaymentPayload>(event)
  if (!p || typeof p.charge_id !== "string" || !p.charge_id)
    return { status: "skipped" as const, reason: "invalid_payload" }
  if (p.invoice_id) return { status: "skipped" as const, reason: "has_invoice" }
  const since = await connectedSince(ctx)
  if (since === null) return { status: "skipped" as const, reason: "not_connected" }
  const created = isoOf(p.created)
  if (since && created && created < since)
    return { status: "skipped" as const, reason: "before_connection" }
  const ref = stripeRef(p.charge_id)
  const made = await saleDocument(ctx, [p.charge_id])
  if (made)
    return {
      status: "skipped" as const,
      reason: made.external_ref === ref ? "already_invoiced" : "already_linked",
    }
  const advance = await waitingAdvance(ctx, p.contact_id ?? null)
  const def = await park(
    { db: ctx.db },
    {
      event_id: ref,
      event_payload_json: { ...p, kind: STRIPE_UNMATCHED_PARK },
      status: "awaiting_data",
      reason: "stripe_payment_unmatched",
      blocked_on: {
        kind: STRIPE_UNMATCHED_PARK,
        charge_id: p.charge_id,
        contact_id: p.contact_id ?? null,
        ...(advance ? { step_id: String(advance.id) } : {}),
      },
    },
  )
  if (def.created && advance) {
    // One line per receipt: the advance's question replaces the unmatched line. Nothing issues.
    await ctx.emit({
      entity: "stripe_payment",
      action: "advance_received",
      entityId: p.charge_id,
      data: {
        deferred_id: def.id,
        charge_id: p.charge_id,
        amount: money(toBigInt(p.amount_minor), p.currency),
        customer: p.customer?.name ?? p.customer?.email ?? p.customer_id ?? "unknown",
        project_id: String(advance.billing_project_id),
        step_id: String(advance.id),
        step_label: String(advance.label ?? "the advance"),
        received_on: (isoOf(p.created) ?? "").slice(0, 10) || null,
        resolved: false,
      },
    })
  } else if (def.created) {
    await ctx.emit({
      entity: "stripe_payment",
      action: "unmatched",
      entityId: p.charge_id,
      data: {
        deferred_id: def.id,
        charge_id: p.charge_id,
        amount: money(toBigInt(p.amount_minor), p.currency),
        customer: p.customer?.name ?? p.customer?.email ?? p.customer_id ?? "unknown",
        resolved: false,
      },
    })
  }
  return { status: "deferred" as const, deferred_id: def.id, created: def.created }
}

/** Which park a click is made on, when an event has several. */
const CLICKED_FIRST = [STRIPE_APPROVAL_PARK, STRIPE_UNMATCHED_PARK, "stripe_issuer_undecided"]

/** The park a person decides on: not resolved (a given-up one still is theirs to decide). */
async function parkToDecide(ctx: StripeCtx, eventId: string): Promise<DeferredRow | null> {
  const rows = await parksOf(ctx, eventId)
  const rank = (r: DeferredRow) => {
    const i = CLICKED_FIRST.indexOf(String(r.blocked_on.kind ?? ""))
    return i === -1 ? CLICKED_FIRST.length : i
  }
  return [...rows].sort((a, b) => rank(a) - rank(b))[0] ?? null
}

/** Whether a payment's own park still waits for a person. */
export async function hasUnmatchedPark(ctx: StripeCtx, eventId: string): Promise<boolean> {
  return (await parksOf(ctx, eventId)).some((r) => r.blocked_on.kind === STRIPE_UNMATCHED_PARK)
}

/** A charge as Stripe answers for it now, or null when Stripe cannot be read. */
async function currentStripePayment(
  ctx: StripeCtx,
  chargeId: string,
): Promise<(StripePaymentPayload & { status?: string | null }) | null> {
  if (!ctx.executeTool) return null
  try {
    const env = await ctx.executeTool("stripe:payment_payload", { chargeId })
    if (env.status !== "completed") return null
    const p = (env.result as { payment?: StripePaymentPayload & { status?: string } } | null)
      ?.payment
    return p && p.charge_id === chargeId ? p : null
  } catch {
    return null
  }
}

export interface InvoiceFromStripeInput {
  chargeId?: string
  stripeInvoiceId?: string
  /** The VAT rate in the charge's amount (basis points), for a payment with no Stripe invoice. */
  vatRateBp?: number
  description?: string
}

/**
 * What a person's decision changed of the waiting sale: closed, with every park under its names, or
 * refused. Parks are the system's to write (a person holds no right to their table), so the
 * decision is told as an event and recorded by `onStripeSaleDecided` on the system's behalf.
 */
export interface SaleDecided {
  names: string[]
  closed?: string
  refused?: { park_id: string; why: string; words: string }
}

const tellDecided = (
  ctx: StripeCtx,
  names: ReadonlyArray<string | null | undefined>,
  what: Omit<SaleDecided, "names">,
) =>
  ctx.emit({
    entity: "stripe_sale",
    action: "decided",
    entityId: String(names.find((n) => !!n) ?? ""),
    data: { names: [...new Set(names.filter((n): n is string => !!n))], ...what },
  })

export async function onStripeSaleDecided(event: unknown, ctx: StripeCtx) {
  const d = payloadOf<SaleDecided>(event)
  if (!Array.isArray(d?.names)) return { status: "skipped" as const, reason: "invalid_payload" }
  if (d.closed) await closeSale(ctx, d.names, d.closed)
  if (d.refused) {
    const { park_id, why, words } = d.refused
    const [row] = (await ctx.db.findMany("deferred_events", {
      where: { id: park_id },
      limit: 1,
    })) as Row[]
    if (row) await noteRefusal(ctx, toDeferredRow(row), why, words)
  }
  return { status: "ok" as const }
}

/** Stage-time check: there is something waiting to issue, and it is not issued already. */
export async function invoiceFromStripePaymentPreflight(
  ctx: StripeCtx,
  input: InvoiceFromStripeInput,
) {
  const found = await waiting(ctx, input)
  return "status" in found ? found : { ok: true, noAutoApprove: true }
}

const taken = (id: string, doc: Row) =>
  fail(
    "already_invoiced",
    `${id} is already invoiced by ${String(doc.number ?? doc.id)}; nothing was issued again and no number was taken.`,
  )

const unreadable = (id: string) =>
  fail(
    "stripe_unreadable",
    `${id} could not be read from Stripe, so it may have been paid, voided or refunded since; nothing was issued and no number was taken. Try again once Stripe answers.`,
  )

/** `close`: the click itself (not its stage-time check) closes what waited for an invoiced sale. */
async function waiting(ctx: StripeCtx, input: InvoiceFromStripeInput, close = false) {
  const id = input.stripeInvoiceId?.trim() || input.chargeId?.trim() || ""
  if (!id)
    return fail(
      "payment_ref_missing",
      "Name the Stripe payment (chargeId, ch_...) or the Stripe invoice (stripeInvoiceId, in_...); nothing was issued.",
    )
  const byInvoice = !!input.stripeInvoiceId?.trim()
  if (byInvoice && !id.startsWith("in_"))
    return fail(
      "payment_ref_missing",
      `${id} is a payment, not a Stripe invoice; nothing was issued. Name it as chargeId, with the VAT rate its amount includes (vatRateBp).`,
    )
  const row = await parkToDecide(ctx, stripeRef(id))
  const stored = (row?.event_payload_json ?? {}) as Partial<
    StripeInvoicePayload & StripePaymentPayload
  >
  const names = [
    id,
    ...(byInvoice ? saleNames(stored as StripeInvoicePayload) : [stored.invoice_id]),
  ]
  const existing = await saleDocument(ctx, names)
  if (existing) {
    if (close) {
      await closeSale(ctx, names, "already_issued")
      await tellDecided(ctx, names, { closed: "already_issued" })
    }
    return taken(id, existing)
  }
  if (!row)
    return fail(
      "nothing_waiting",
      `No Stripe payment or invoice ${id} is waiting to be invoiced; nothing was issued. List the waiting ones with deferred_list.`,
    )
  if (!byInvoice && (typeof input.vatRateBp !== "number" || input.vatRateBp < 0)) {
    return fail(
      "vat_rate_required",
      `Charge ${id} has no Stripe invoice, so its VAT rate is not known; nothing was issued. Ask the person which rate the amount includes and pass vatRateBp (2000 for 20%).`,
    )
  }
  return { row, id }
}

/**
 * The lines of an invoice for a charge of `gross` that includes VAT at `rateBp`: the net whose
 * net plus its tax is the charge, and when no net is (9.99 at 20%: 8.32 gives 9.98, 8.33 gives
 * 10.00), the nearest one below plus a 0-tax "Rounding adjustment" line, so the invoice always
 * totals what was charged.
 */
export function chargeLines(
  gross: bigint,
  rateBp: number,
  description: string,
): StripeInvoicePayload["lines"] {
  const gross_of = (n: bigint) => n + lineTax({ subtotal_minor: n, tax_rate_bp: rateBp })
  let net = netOfIncludedTax(gross, rateBp)
  while (net > 0n && gross_of(net) > gross) net -= 1n
  while (gross_of(net + 1n) <= gross) net += 1n
  const residual = gross - gross_of(net)
  const lines: NonNullable<StripeInvoicePayload["lines"]> = [
    { description, quantity: 1, unit_amount_excl_minor: net.toString(), tax_rate_bp: rateBp },
  ]
  if (residual !== 0n)
    lines.push({
      description: "Rounding adjustment",
      quantity: 1,
      unit_amount_excl_minor: residual.toString(),
      tax_rate_bp: 0,
    })
  return lines
}

/** Why a click issued nothing, in words. */
const SKIPPED: Record<string, string> = {
  [NOT_OPEN_IN_STRIPE]: "it was voided or written off in Stripe",
  issued_by_stripe: "Stripe issues it",
  before_connection: "it was finalized before Stripe was connected",
  zero_total: "its total is zero",
}

/** What a click on a Stripe invoice issues: the invoice as Stripe answers for it now, or, for the
 *  approval card, what the card showed with the payment as it is now. */
async function invoiceToIssue(
  ctx: StripeCtx,
  id: string,
  row: DeferredRow,
): Promise<StripeInvoicePayload | ReturnType<typeof fail>> {
  const now = await currentStripeInvoice(ctx, id)
  if (!now) return unreadable(id)
  if (row.blocked_on.kind !== STRIPE_APPROVAL_PARK) return now
  const shown = (row.event_payload_json ?? {}) as StripeInvoicePayload
  if (
    toBigInt(now.total_minor) !== toBigInt(shown.total_minor) ||
    now.currency.toLowerCase() !== shown.currency.toLowerCase()
  )
    return fail(
      "not_issued",
      `${id} was not invoiced: its amount changed in Stripe since its card was made; no number was taken.`,
    )
  return withPaymentOf(shown, now)
}

/** What a click on a payment issues: the charge and its customer as Stripe answers for them now,
 *  at the rate and with the description of this click. */
async function paymentToIssue(
  ctx: StripeCtx,
  id: string,
  row: DeferredRow,
  input: InvoiceFromStripeInput,
): Promise<StripeInvoicePayload | ReturnType<typeof fail>> {
  const now = await currentStripePayment(ctx, id)
  if (!now) return unreadable(id)
  if (now.status && now.status !== "succeeded")
    return fail(
      "not_issued",
      `${id} was not invoiced: the payment did not succeed in Stripe (${now.status}); no number was taken.`,
    )
  const stored = (row.event_payload_json ?? {}) as Partial<StripePaymentPayload>
  const gross = toBigInt(now.amount_minor)
  return {
    // One document per charge: keyed by its invoice when it has one, else by itself.
    stripe_invoice_id: stripeDocumentRef({
      id,
      invoice: now.invoice_id ?? stored.invoice_id ?? null,
    }).slice("stripe:".length),
    customer_id: now.customer_id ?? null,
    contact_id: now.contact_id ?? stored.contact_id ?? null,
    total_minor: gross.toString(),
    currency: now.currency,
    finalized_at: now.created ?? null,
    paid_at: now.created ?? null,
    status: "paid",
    charge_id: id,
    customer: now.customer ?? null,
    lines: chargeLines(
      gross,
      Number(input.vatRateBp ?? 0),
      input.description?.trim() || now.description || `Payment ${id}`,
    ),
  }
}

export async function invoiceFromStripePayment(ctx: StripeCtx, input: InvoiceFromStripeInput) {
  const found = await waiting(ctx, input, true)
  if ("status" in found) return found
  const { row, id } = found
  const invoice = input.stripeInvoiceId
    ? await invoiceToIssue(ctx, id, row)
    : await paymentToIssue(ctx, id, row, input)
  if ("error" in invoice) return invoice
  const outcome: FinalizedResult = await onStripeInvoiceFinalized(invoice, ctx, {
    byPerson: true,
    park: row,
    ...(id.startsWith("in_") || !invoice.stripe_invoice_id.startsWith("in_")
      ? {}
      : { paysInvoice: invoice.stripe_invoice_id }),
  })
  const names = [id, ...saleNames(invoice)]
  if (outcome.status === "ok") {
    await closeSale(ctx, names, "issued")
    await tellDecided(ctx, names, { closed: "issued" })
    return {
      status: "completed" as const,
      document_id: outcome.document_id,
      number: outcome.number,
      summary: `Invoice ${outcome.number} was issued for ${id} and took the next number. Send it with documents_send_to_customer.`,
    }
  }
  if (outcome.status === "pending_approval")
    return { status: "pending_approval" as const, approval_id: outcome.approval_id }
  if (outcome.status === "error") return { status: "error" as const, error: outcome.error }
  if (outcome.status === "skipped") {
    await tellDecided(ctx, names, {
      closed: outcome.document_id ? "already_issued" : outcome.reason,
    })
    if (outcome.document_id) {
      const doc = (await ctx.db.findOne("documents", outcome.document_id)) as Row | null
      return taken(id, doc ?? { id: outcome.document_id })
    }
    return fail(
      "not_issued",
      `${id} was not invoiced: ${SKIPPED[outcome.reason] ?? outcome.reason}; no number was taken.`,
    )
  }
  const why = outcome.why ?? outcome.reason
  const words = outcome.words ?? outcome.reason
  await tellDecided(ctx, names, { refused: { park_id: row.id, why, words } })
  return fail(
    "not_issued",
    `${id} was not invoiced: ${words} (${why}); no number was taken. It stays in the queue, and nothing issues it but the next decision.`,
  )
}

export interface PaymentLinkInput {
  chargeId: string
  documentId: string
}

/** The Stripe invoice a charge paid: what a waiting invoice says of itself, else what Stripe says
 *  of the charge. Null: none is known. */
async function invoiceOfCharge(ctx: StripeCtx, chargeId: string): Promise<string | null> {
  for await (const r of openRowsOf(ctx as LinesCtx, "stripe:in_", { payload: true })) {
    const p = (r.event_payload_json ?? {}) as StripeInvoicePayload
    if (saleNames(p).includes(chargeId)) return p.stripe_invoice_id
  }
  return (await currentStripePayment(ctx, chargeId))?.invoice_id ?? null
}

async function linkCheck(ctx: StripeCtx, input: PaymentLinkInput) {
  const chargeId = input.chargeId?.trim() ?? ""
  if (!/^(ch|py)_/.test(chargeId))
    return fail(
      "payment_ref_missing",
      "Name the Stripe payment (chargeId, ch_...); nothing was linked.",
    )
  const doc = (await ctx.db.findOne("documents", String(input.documentId ?? ""))) as Row | null
  if (!doc || doc.type !== "invoice" || doc.status === "draft") {
    return fail(
      "invoice_not_found",
      `No issued invoice ${input.documentId}; nothing was linked. Find it with documents_search.`,
    )
  }
  const invoiceId = await invoiceOfCharge(ctx, chargeId)
  const holder = await saleDocument(ctx, [chargeId, invoiceId])
  if (holder) return linked(chargeId, holder)
  return { doc, chargeId, invoiceId }
}

const linked = (chargeId: string, holder: Row) =>
  fail(
    "already_linked",
    `Payment ${chargeId} is already linked to ${String(holder.number ?? holder.id)}; nothing changed.`,
  )

export async function paymentLinkToInvoicePreflight(ctx: StripeCtx, input: PaymentLinkInput) {
  const r = await linkCheck(ctx, input)
  return "status" in r ? r : { ok: true, noAutoApprove: true }
}

export async function paymentLinkToInvoice(ctx: StripeCtx, input: PaymentLinkInput) {
  const r = await linkCheck(ctx, input)
  if ("status" in r) return r
  const { doc, chargeId, invoiceId } = r
  const names = [chargeId, invoiceId]
  try {
    // The sale's names with the link: of a link and an issue of one sale, one commits.
    await ctx.db.batch({
      ops: [
        ...claimOps(names, String(doc.id)),
        {
          update: "documents",
          id: String(doc.id),
          ...(doc.external_ref ? {} : { data: { external_ref: stripeRef(chargeId) } }),
          merge: {
            external_refs: { stripe_charge_id: chargeId },
          },
          append: {
            lifecycle_log: [
              {
                event: "stripe_payment_linked",
                actor: await ctx.getUserId(),
                ts: new Date().toISOString(),
                charge_id: chargeId,
              },
            ],
          },
        },
      ],
    })
  } catch (err) {
    const holder = isSaleTaken(err) ? await saleDocument(ctx, names) : null
    if (!holder) throw err
    return linked(chargeId, holder)
  }
  await closeSale(ctx, names, "linked")
  await tellDecided(ctx, names, { closed: "linked" })
  if (invoiceId)
    await linkBack(
      ctx,
      invoiceId,
      String(doc.id),
      typeof doc.number === "string" ? doc.number : null,
    )
  return {
    status: "completed" as const,
    document_id: String(doc.id),
    summary: `Payment ${chargeId} is linked to invoice ${String(doc.number ?? doc.id)}; no number was taken and nothing changed in Stripe.`,
  }
}
