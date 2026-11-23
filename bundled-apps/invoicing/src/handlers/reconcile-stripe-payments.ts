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
// It gives back to the retry sweep the parks whose ordinary retries ran out, once what they wait on
// is there (a buyer completed in Stripe, the issuer, a credit note's invoice).
// It also lists, once, the Stripe invoices that waited while nobody had decided who issues, as
// soon as a person picked Liaison: they issue only on a person's click. A refund still waiting for
// its invoice after a day raises one Home item.
import {
  type DeferredRow,
  isStalled,
  resolveOpenParks,
  revive,
  STRIPE_CREDIT_NOTE_PARK,
  toDeferredRow,
} from "../deferred"
import { findIssuerProfile } from "../mutations/db-helpers"
import { isoOf, issuerAt, streamRows } from "../streams"
import {
  buyerIsComplete,
  cardStreamFor,
  documentByRef,
  onStripeInvoiceFinalized,
  STRIPE_UNDECIDED_PARK,
  type StripeCtx,
  type StripeInvoicePayload,
  stripeRef,
} from "./stripe-invoice-finalized"
import { hasCollectionMark, onStripeInvoicePaid } from "./stripe-invoice-paid"
import {
  flagLongRefundWaits,
  onStripeRefundCreated,
  type StripeRefundPayload,
} from "./stripe-refund-created"

type Row = Record<string, unknown>

export interface ReconcileCandidates {
  invoices?: StripeInvoicePayload[]
  refunds?: Array<
    StripeRefundPayload & { refund_id: string; amount_minor: string | number; status: string }
  >
  /** The customers asked for, as the Stripe mirror holds them now. */
  buyers?: Array<{
    customer_id: string
    contact_id?: string | null
    customer?: StripeInvoicePayload["customer"]
  }>
}

export interface StripeReconcileResult {
  status: "ok"
  issued: number
  marked_paid: number
  credit_notes: number
  listed_undecided: number
  message: string
}

const OPEN_PARK = ["awaiting_config", "awaiting_data", "awaiting_dependency"]
const WAITING_MAX = 500

async function openParks(ctx: StripeCtx): Promise<Row[]> {
  return (await ctx.db.findMany("deferred_events", {
    where: { status: { in: OPEN_PARK } },
    limit: 2000,
  })) as Row[]
}

/** Stripe invoices and refunds held by an open park: the retry sweep re-drives them, so the
 *  safety job's places go to what no handler holds. */
function waitingIds(rows: Row[]): string[] {
  const ids = new Set<string>()
  for (const r of rows) {
    const m = /^stripe:((?:in|re)_[A-Za-z0-9]+)$/.exec(String(r.event_id ?? ""))
    if (m?.[1]) ids.add(m[1])
    if (ids.size >= WAITING_MAX) break
  }
  return [...ids]
}

/** The Stripe customer a stalled park waits for, or null when it waits on something else. */
function waitedCustomer(r: DeferredRow): string | null {
  const id = r.blocked_on.customer_id
  return r.status === "awaiting_data" && typeof id === "string" && id ? id : null
}

/** Most stalled parks revived per run: two sweeps' worth, so the queue never fills with them. */
const REVIVE_MAX = 50

/**
 * Parks the sweep no longer tries (isStalled), given back to it once what they wait on is there:
 * the buyer is complete in Stripe, the issuer is set, the credit note's invoice is issued. Nothing
 * is issued here, and a park whose record is still missing costs no retry and no call to Stripe.
 */
async function reviveStalled(
  ctx: StripeCtx,
  stalled: DeferredRow[],
  buyers: ReconcileCandidates["buyers"],
): Promise<void> {
  const byCustomer = new Map((buyers ?? []).map((b) => [b.customer_id, b]))
  const refs = stalled
    .filter((r) => r.blocked_on.kind === STRIPE_CREDIT_NOTE_PARK)
    .map((r) => String(r.blocked_on.invoice_ref))
  const issued = new Set(
    refs.length === 0
      ? []
      : (
          (await ctx.db.findMany("documents", {
            where: { external_ref: { in: refs } },
            limit: refs.length,
          })) as Row[]
        ).map((d) => String(d.external_ref)),
  )
  let revived = 0
  for (const r of stalled) {
    if (revived >= REVIVE_MAX) return
    const p = (r.event_payload_json ?? {}) as StripeInvoicePayload
    const customer = waitedCustomer(r)
    if (customer) {
      const buyer = byCustomer.get(customer)
      if (!buyerIsComplete(buyer?.customer)) continue
      await revive(ctx, r.id, {
        ...p,
        customer: buyer?.customer,
        contact_id: buyer?.contact_id ?? p.contact_id ?? null,
      })
    } else if (r.blocked_on.kind === STRIPE_CREDIT_NOTE_PARK) {
      if (!issued.has(String(r.blocked_on.invoice_ref))) continue
      await revive(ctx, r.id)
    } else {
      if (r.status !== "awaiting_config") continue
      const stream = await cardStreamFor(ctx, isoOf(p.finalized_at) ?? new Date().toISOString())
      const profile = String(stream?.row.issuer_profile_id ?? "")
      if (!profile || !(await findIssuerProfile(ctx.db, profile))) continue
      await revive(ctx, r.id)
    }
    revived += 1
  }
}

async function candidates(
  ctx: StripeCtx,
  parks: Row[],
  stalled: DeferredRow[],
): Promise<ReconcileCandidates | null> {
  if (!ctx.executeTool) return null
  const buyers = [...new Set(stalled.map(waitedCustomer).filter((c): c is string => c !== null))]
  try {
    const env = await ctx.executeTool("stripe:reconcile_candidates", {
      waiting: waitingIds(parks),
      ...(buyers.length > 0 ? { buyers: buyers.slice(0, WAITING_MAX) } : {}),
    })
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
  const parks = await openParks(ctx)
  const stalled = parks.map(toDeferredRow).filter(isStalled)
  const found = await candidates(ctx, parks, stalled)
  await reviveStalled(ctx, stalled, found?.buyers)
  for (const inv of found?.invoices ?? []) {
    const doc = await documentByRef(ctx, stripeRef(inv.stripe_invoice_id))
    if (!doc) {
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
