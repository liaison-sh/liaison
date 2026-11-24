// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scheduled safety job for card payments on Stripe (every 10 minutes), the Stripe twin of
// `reconcile-shopify-payments`: it tightens payment status toward what Stripe already reports,
// never touches money, and never issues by itself. What an event missed (invoicing was off, an
// event failed for good) is handed to the SAME idempotent handler the event would have reached:
//   - a Stripe invoice issued by Liaison, finalized after the connection, with no document:
//     the finalized handler (its unique key stops a second document);
//   - a paid Stripe invoice whose document is unpaid: the paid handler;
//   - a succeeded refund in mode A with no credit note, whose payment's invoice has a document:
//     the refund handler (its unique key stops a second credit note).
// Past its last automatic retry a Stripe invoice is issued by a person only: the job notices what
// it lacked is there (its buyer complete in Stripe, its issuer set) and says so on Home, one line
// per invoice or one for many (stripe-lines.ts), and closes the ones invoiced or void since. A
// credit note past its retries goes back to the retry sweep once its invoice exists.
// It also lists, once, the Stripe invoices that waited while nobody had decided who issues, as
// soon as a person picked Liaison: they issue only on a person's click. A refund still waiting for
// its invoice after a day raises one Home item.
import {
  DEAD_LETTER_CAP,
  type DeferredRow,
  isBulkDeadLettered,
  isStalled,
  openRowsOf,
  resolveOpenParks,
  revive,
  STRIPE_CREDIT_NOTE_PARK,
  STRIPE_INVOICE_PARK,
} from "../deferred"
import { findIssuerProfile } from "../mutations/db-helpers"
import { toBigInt } from "../mutations/shared"
import { isoOf, issuerAt, streamRows } from "../streams"
import {
  buyerLacks,
  cardStreamFor,
  isInvoiceable,
  LACKS,
  NOT_OPEN_IN_STRIPE,
  onStripeInvoiceFinalized,
  refusedText,
  STRIPE_UNDECIDED_PARK,
  type StripeCtx,
  type StripeInvoicePayload,
  saleNames,
  stripeRef,
} from "./stripe-invoice-finalized"
import { hasCollectionMark, onStripeInvoicePaid } from "./stripe-invoice-paid"
import {
  invoiceIdOf,
  isPersonOnly,
  type LinesCtx,
  type PersonInvoice,
  sayPersonLines,
  TOUCH_MAX,
} from "./stripe-lines"
import { hasUnmatchedPark } from "./stripe-payment-unmatched"
import {
  flagLongRefundWaits,
  onStripeRefundCreated,
  type ParkedStripeCreditNote,
  type StripeRefundPayload,
} from "./stripe-refund-created"
import { documentIdsByKey, invoicesLinkedTo, saleDocument } from "./stripe-sale"

type Row = Record<string, unknown>

export interface ReconcileCandidates {
  invoices?: StripeInvoicePayload[]
  refunds?: Array<
    StripeRefundPayload & { refund_id: string; amount_minor: string | number; status: string }
  >
}

/** What the Stripe mirror holds now of the customers and invoices asked for. */
interface WaitingState {
  buyers: Map<string, StripeInvoicePayload["customer"]>
  statuses: Map<string, string>
}

export interface StripeReconcileResult {
  status: "ok"
  issued: number
  marked_paid: number
  credit_notes: number
  listed_undecided: number
  message: string
}

const WAITING_MAX = 500
/** How far back the candidates read goes (its 35 days, and one for the clock). */
const CANDIDATE_DAYS_MS = 36 * 24 * 60 * 60 * 1000

/** An invoice only a person issues, with what its payload says of it. */
interface PersonPark {
  row: DeferredRow
  customer_id: string | null
  customer: StripeInvoicePayload["customer"]
  negative: boolean
  finalized_at: string | null
  keys: string[]
}

interface Waiting {
  /** Stripe invoices and refunds an open park holds, the newest first. */
  ids: string[]
  persons: PersonPark[]
  /** Credit notes past their retries. */
  notes: DeferredRow[]
  /** Parks an earlier version left on a payment, beside the payment's own. */
  strays: DeferredRow[]
}

/** Everything that waits on Stripe, read a page at a time, payloads dropped as they are read. */
async function waitingRows(ctx: StripeCtx): Promise<Waiting> {
  const out: Waiting = { ids: [], persons: [], notes: [], strays: [] }
  const held: Array<{ id: string; at: number }> = []
  const db = ctx as LinesCtx
  for await (const r of openRowsOf(db, "stripe:", { payload: true })) {
    const m = /^stripe:((?:in|re)_[A-Za-z0-9]+)$/.exec(r.event_id)
    if (m?.[1]) held.push({ id: m[1], at: r.created_at.getTime() })
    if (isPersonOnly(r)) out.persons.push(personPark(r))
    else if (isStalled(r) && r.blocked_on.kind === STRIPE_CREDIT_NOTE_PARK) out.notes.push(r)
    else if (isStalled(r) && r.blocked_on.kind === STRIPE_INVOICE_PARK) out.strays.push(r)
  }
  // What the candidates read would find again: the newest, as that read goes back 35 days.
  const since = Date.now() - CANDIDATE_DAYS_MS
  out.ids = held
    .filter((h) => h.at === 0 || h.at >= since)
    .sort((a, b) => b.at - a.at)
    .slice(0, WAITING_MAX)
    .map((h) => h.id)
  return out
}

function personPark(row: DeferredRow): PersonPark {
  const p = (row.event_payload_json ?? {}) as StripeInvoicePayload
  const customer = row.blocked_on.customer_id ?? p.customer_id
  return {
    row: { ...row, event_payload_json: undefined },
    customer_id: typeof customer === "string" && customer ? customer : null,
    customer: p.customer ?? null,
    negative: toBigInt(p.total_minor ?? 0) < 0n,
    finalized_at: p.finalized_at ?? null,
    keys: [
      ...new Set([
        row.event_id,
        ...saleNames(p)
          .filter((n) => !!n)
          .map((n) => stripeRef(String(n))),
      ]),
    ],
  }
}

/** Invoices an earlier version gave up on (a dead letter) wait for a person like the others. */
async function reopenGivenUp(ctx: StripeCtx): Promise<void> {
  const db = ctx as LinesCtx
  const open = new Set<string>()
  const given: DeferredRow[] = []
  for await (const r of openRowsOf(db, "stripe:in_", { statuses: ["permanent_failure"] }))
    if (r.blocked_on.kind === STRIPE_INVOICE_PARK && !isBulkDeadLettered(r.reason)) given.push(r)
  if (given.length === 0) return
  for await (const r of openRowsOf(db, "stripe:in_")) open.add(r.event_id)
  let touched = 0
  for (const r of given) {
    if (open.has(r.event_id) || touched >= TOUCH_MAX) continue
    touched += 1
    open.add(r.event_id)
    await ctx.db.update("deferred_events", r.id, {
      status: "awaiting_data",
      retry_count: Math.max(r.retry_count, DEAD_LETTER_CAP),
    })
  }
}

/** Close an invoice only a person issues, with its line; the grouped line is counted after. */
async function dropPerson(ctx: StripeCtx, row: DeferredRow, reason: string): Promise<void> {
  await ctx.db.update("deferred_events", row.id, { status: "resolved", reason })
  await ctx.emit({
    entity: "stripe_invoice",
    action: "needs_person",
    entityId: row.id,
    data: { deferred_id: row.id, resolved: true },
  })
}

/** What the Stripe mirror says of the invoices only a person issues, or null when it cannot say. */
async function waitingState(ctx: StripeCtx, persons: PersonPark[]): Promise<WaitingState | null> {
  const out: WaitingState = { buyers: new Map(), statuses: new Map() }
  const customers = [...new Set(persons.map((p) => p.customer_id).filter((c) => c !== null))]
  const ids = persons.map((p) => invoiceIdOf(p.row))
  for (let i = 0; i < Math.max(customers.length, ids.length); i += WAITING_MAX) {
    try {
      const env = await ctx.executeTool?.("stripe:waiting_state", {
        customers: customers.slice(i, i + WAITING_MAX),
        invoices: ids.slice(i, i + WAITING_MAX),
      })
      if (env?.status !== "completed") return null
      const r = env.result as {
        buyers?: Array<{ customer_id: string; customer?: StripeInvoicePayload["customer"] }>
        invoices?: Array<{ stripe_invoice_id: string; status?: string | null }>
      }
      for (const b of r.buyers ?? []) out.buyers.set(b.customer_id, b.customer ?? null)
      for (const v of r.invoices ?? [])
        out.statuses.set(v.stripe_invoice_id, String(v.status ?? ""))
    } catch {
      return null
    }
  }
  return out
}

const ON_HAND = "it is no longer issued on its own"

/** What an invoice only a person issues waits for now, and whether a click issues it. */
async function stateOf(
  ctx: StripeCtx,
  p: PersonPark,
  state: WaitingState | null,
): Promise<{ text: string; ready: boolean }> {
  const said = p.row.blocked_on.line
  if (p.negative) return { text: "its total is negative", ready: false }
  const refused = p.row.blocked_on.refused
  if (typeof refused === "string") return { text: refusedText(refused), ready: false }
  if (p.row.status === "awaiting_config") {
    const stream = await cardStreamFor(ctx, isoOf(p.finalized_at) ?? new Date().toISOString())
    const profile = String(stream?.row.issuer_profile_id ?? "")
    const issuer = profile ? await findIssuerProfile(ctx.db, profile) : null
    if (!issuer)
      return {
        text: `the issuer profile is missing. Set it in the issuer settings, then issue it: ${ON_HAND}`,
        ready: false,
      }
  }
  // The mirror could not say: the line keeps what it says.
  if (!state && typeof said === "string") return { text: said, ready: said.includes(READY_WORDS) }
  const buyer = (p.customer_id ? state?.buyers.get(p.customer_id) : null) ?? p.customer
  const lacks = buyerLacks(buyer)
  if (lacks)
    return { text: `${LACKS[lacks].words}. Add it there, then issue it: ${ON_HAND}`, ready: false }
  return {
    text:
      p.row.status === "awaiting_config"
        ? `its issuer is set. ${READY_WORDS}: ${ON_HAND}`
        : `its customer is complete in Stripe now. ${READY_WORDS}: ${ON_HAND}`,
    ready: true,
  }
}
const READY_WORDS = "Issue it"

/** Whether Stripe issues it now: a click would refuse it, so nothing offers one. */
async function issuedByStripe(ctx: StripeCtx, p: PersonPark, streams: Row[]): Promise<boolean> {
  const at = isoOf(p.finalized_at) ?? new Date().toISOString()
  const stream = await cardStreamFor(ctx, at, streams)
  return stream?.issuer === "stripe"
}

/** Home, for every invoice only a person issues. Nothing is issued. */
async function sayWhatWaits(ctx: StripeCtx, persons: PersonPark[]): Promise<void> {
  const taken = await documentIdsByKey(ctx, [...new Set(persons.flatMap((p) => p.keys))])
  const state = persons.length > 0 ? await waitingState(ctx, persons) : null
  const streams = persons.length > 0 ? await streamRows(ctx) : []
  const waiting: PersonInvoice[] = []
  let dropped = 0
  for (const p of persons) {
    const status = state?.statuses.get(invoiceIdOf(p.row))
    const gone = p.keys.some((k) => taken.has(k))
      ? "already_issued"
      : status !== undefined && !isInvoiceable({ status })
        ? NOT_OPEN_IN_STRIPE
        : (await issuedByStripe(ctx, p, streams))
          ? "issued_by_stripe"
          : null
    if (gone) {
      if (dropped < TOUCH_MAX) await dropPerson(ctx, p.row, gone)
      dropped += 1
      continue
    }
    waiting.push({ row: p.row, ...(await stateOf(ctx, p, state)) })
  }
  await sayPersonLines(ctx as LinesCtx, waiting)
}

/** Most credit notes handed back per run: two sweeps' worth, so the queue never fills with them. */
export const REVIVE_MAX = 50

/** Credit notes past their retries go back to the sweep once their invoice is there: issued from
 *  Stripe, or made by hand and linked to the charge. */
async function reviveNotes(ctx: StripeCtx, notes: DeferredRow[]): Promise<void> {
  if (notes.length === 0) return
  const chargeOf = (r: DeferredRow) =>
    String((r.event_payload_json as Partial<ParkedStripeCreditNote> | null)?.charge_id ?? "")
  const keysOf = (r: DeferredRow) => [String(r.blocked_on.invoice_ref), stripeRef(chargeOf(r))]
  const byKey = await documentIdsByKey(ctx, [...new Set(notes.flatMap(keysOf))])
  const left = notes.filter((r) => !keysOf(r).some((k) => byKey.has(k)))
  const linked = await invoicesLinkedTo(ctx, left.map(chargeOf).filter(Boolean))
  let revived = 0
  for (const r of notes) {
    if (revived >= REVIVE_MAX) return
    if (!keysOf(r).some((k) => byKey.has(k)) && !linked.has(chargeOf(r))) continue
    await revive(ctx, r.id)
    revived += 1
  }
}

async function candidates(ctx: StripeCtx, waiting: string[]): Promise<ReconcileCandidates | null> {
  if (!ctx.executeTool) return null
  try {
    const env = await ctx.executeTool("stripe:reconcile_candidates", { waiting })
    return env.status === "completed" ? ((env.result ?? {}) as ReconcileCandidates) : null
  } catch {
    return null
  }
}

/** Parks of invoices finalized while undecided, listed once a person has picked Liaison. */
async function listUndecided(ctx: StripeCtx): Promise<number> {
  const streams = (await streamRows(ctx)).filter((r) => r.stripe_connected === true)
  if (!streams.some((s) => s.issuer === "liaison")) return 0
  const parks = (await ctx.db.findMany("deferred_events", {
    where: { reason: "issuer_undecided" },
    limit: 200,
  })) as Row[]
  const fresh = parks.filter((r) => {
    const b = (r.blocked_on ?? {}) as Row
    return r.status !== "resolved" && b.kind === STRIPE_UNDECIDED_PARK && b.listed !== true
  })
  const stillLiaison = fresh.filter((r) => {
    const p = (r.event_payload_json ?? {}) as StripeInvoicePayload
    const s = streams.find(
      (x) =>
        x.issuer_profile_id === ((r.blocked_on as Row).issuer_profile_id ?? x.issuer_profile_id),
    )
    return s
      ? issuerAt(s, isoOf(p.finalized_at) ?? "") === "liaison" || s.issuer === "liaison"
      : false
  })
  if (stillLiaison.length === 0) return 0
  for (const r of stillLiaison) {
    await ctx.db.update("deferred_events", String(r.id), {
      blocked_on: { ...((r.blocked_on ?? {}) as Row), listed: true },
    })
  }
  await ctx.emit({
    entity: "stripe_invoice",
    action: "undecided_listed",
    entityId: String(stillLiaison[0]?.id),
    data: {
      count: stillLiaison.length,
      invoices: stillLiaison
        .map((r) => String(((r.event_payload_json ?? {}) as Row).stripe_invoice_id ?? ""))
        .join(", "),
      resolved: false,
    },
  })
  return stillLiaison.length
}

export async function reconcileStripePayments(ctx: StripeCtx): Promise<StripeReconcileResult> {
  let issued = 0
  let paid = 0
  let notes = 0
  const listed = await listUndecided(ctx)
  await flagLongRefundWaits(ctx)
  await reopenGivenUp(ctx)
  const waiting = await waitingRows(ctx)
  for (const r of waiting.strays)
    if (await hasUnmatchedPark(ctx, r.event_id))
      await ctx.db.update("deferred_events", r.id, {
        status: "resolved",
        reason: "waits_elsewhere",
      })
  await reviveNotes(ctx, waiting.notes)
  await sayWhatWaits(ctx, waiting.persons)
  const found = await candidates(ctx, waiting.ids)
  for (const inv of found?.invoices ?? []) {
    const doc = await saleDocument(ctx, saleNames(inv))
    if (!doc) {
      // A paid invoice's short row (its document was linked) says too little to issue from.
      if (!inv.lines) continue
      // Re-emitted to its own handler: the decision to issue is the handler's, never this job's.
      const r = await onStripeInvoiceFinalized(inv, ctx)
      if (r.status === "ok") issued += 1
      continue
    }
    if (
      inv.status === "paid" &&
      (doc.payment_status !== "paid" ||
        doc.collection_state === "failed" ||
        !hasCollectionMark(doc))
    ) {
      const r = await onStripeInvoicePaid(inv, ctx)
      if (r.status === "ok") paid += 1
    } else if (doc.payment_status === "paid") {
      await resolveOpenParks(ctx, stripeRef(inv.stripe_invoice_id), "already_issued")
    }
  }
  for (const ref of found?.refunds ?? []) {
    const r = await onStripeRefundCreated(
      {
        charge_id: ref.charge_id,
        invoice_id: ref.invoice_id ?? null,
        charged_at: ref.charged_at ?? null,
        refunds: [{ id: ref.refund_id, amount_minor: ref.amount_minor, status: ref.status }],
      },
      ctx,
    )
    notes += r.refunds.filter((x) => x.outcome === "issued").length
  }
  return {
    status: "ok",
    issued,
    marked_paid: paid,
    credit_notes: notes,
    listed_undecided: listed,
    message: found
      ? `Stripe reconciled: ${issued} missing invoice(s) issued by their handler, ${paid} marked paid, ${notes} missing credit note(s) issued.`
      : "Stripe could not be read; nothing changed. The next run tries again.",
  }
}

export const reconcileStripePaymentsJobHandler = (_payload: unknown, ctx: StripeCtx) =>
  reconcileStripePayments(ctx)
