// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One verified Stripe event, handled once.
//
//   1. Ledger claim on the event id (webhooks.ts): a duplicate answers 200 and
//      changes nothing.
//   2. Mode: an event whose `livemode` differs from the install's is
//      acknowledged, recorded as `mode_mismatch` and never dispatched.
//   3. `invoice.created` is only a ledger row and always answers 200 at once:
//      Stripe holds an automatic charge up to 72 hours while it is unanswered.
//      When even that write fails, the invoices catch-up is marked due.
//   4. Any other handled type: the object is RE-FETCHED by id through
//      `stripeFetch`. No value of the event's payload is ever used, only its
//      id, type, time and mode. Other types: 200, ignored, ledger row.
//   5. The fetched object goes through the allow-list and the card mask
//      (mirror.ts), and is written unless the stored row is newer.
//   6. One attention item when a card number was found in its text.
//   7. The typed `stripe/*` event, minor units as strings.
//   8. The connection's state: the first verified event moves it on and names
//      the event; later ones record the last event.
//
// FAILURES. A 401 on the re-fetch marks the key invalid, a 403 the permission
// missing: the delivery is `failed`, the catch-up is due, and Stripe gets a 200
// (retrying cannot help until a person fixes the key). A 404 is a deletion only
// on a `*.deleted` event, or when the same account is confirmed in the same
// tick (the account answers, the mode matches, another known object resolves);
// otherwise nothing is written and the connection reads `different_account`.
// Anything else (429, a Stripe 5xx, a database error) leaves the delivery
// `failed` and answers 500, so the kernel retries and Stripe redelivers; both
// converge on the same ledger row and the same mirror row.
import { decodeState, encodeState, transition } from "./connection"
import { StripeApiError, type StripeHttpCtx, stripeFetch } from "./http"
import {
  type MaskTally,
  type MirrorDb,
  type MirrorEntity,
  at,
  customerRow,
  disputeRow,
  invoiceRow,
  newTally,
  paymentRow,
  refundRow,
  scan,
  subscriptionRow,
  writeMirror,
} from "./mirror"
import { claimDelivery, type LedgerDb, settleDelivery } from "./webhooks"

type Obj = Record<string, unknown>

export interface IngestDb extends MirrorDb, LedgerDb {}

export interface IngestCtx extends StripeHttpCtx {
  db: IngestDb
  emit(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

export interface IngestResult {
  status: number
  body?: string
}

interface Route {
  entity: MirrorEntity
  path: string
  row: (obj: Obj, tally: MaskTally) => Obj
  /** The sync resource whose catch-up covers this object. */
  resource: string
}

const CUSTOMER: Route = { entity: "stripe_customers", path: "/v1/customers/", row: customerRow, resource: "customers" }
const SUBSCRIPTION: Route = {
  entity: "stripe_subscriptions",
  path: "/v1/subscriptions/",
  row: subscriptionRow,
  resource: "subscriptions",
}
const INVOICE: Route = { entity: "stripe_invoices", path: "/v1/invoices/", row: invoiceRow, resource: "invoices" }
const CHARGE: Route = { entity: "stripe_payments", path: "/v1/charges/", row: paymentRow, resource: "charges" }
const REFUND: Route = { entity: "stripe_refunds", path: "/v1/refunds/", row: refundRow, resource: "refunds" }
const DISPUTE: Route = { entity: "stripe_disputes", path: "/v1/disputes/", row: disputeRow, resource: "disputes" }

/** Every event type the app handles, and the object it re-fetches. */
export const HANDLED: Record<string, Route> = {
  "customer.created": CUSTOMER,
  "customer.updated": CUSTOMER,
  "customer.deleted": CUSTOMER,
  "customer.subscription.created": SUBSCRIPTION,
  "customer.subscription.updated": SUBSCRIPTION,
  "customer.subscription.deleted": SUBSCRIPTION,
  "customer.subscription.paused": SUBSCRIPTION,
  "customer.subscription.resumed": SUBSCRIPTION,
  "customer.subscription.trial_will_end": SUBSCRIPTION,
  "invoice.finalized": INVOICE,
  "invoice.finalization_failed": INVOICE,
  "invoice.paid": INVOICE,
  "invoice.payment_failed": INVOICE,
  "invoice.voided": INVOICE,
  "invoice.marked_uncollectible": INVOICE,
  "invoice.updated": INVOICE,
  "charge.succeeded": CHARGE,
  "charge.failed": CHARGE,
  "charge.refunded": CHARGE,
  "charge.updated": CHARGE,
  "charge.refund.updated": REFUND,
  "charge.dispute.created": DISPUTE,
  "charge.dispute.updated": DISPUTE,
  "charge.dispute.closed": DISPUTE,
  "charge.dispute.funds_withdrawn": DISPUTE,
  "charge.dispute.funds_reinstated": DISPUTE,
}

/** The typed event a Stripe event becomes, when it becomes one. */
const EMITS: Record<string, [string, string]> = {
  "customer.created": ["customer", "updated"],
  "customer.updated": ["customer", "updated"],
  "customer.deleted": ["customer", "updated"],
  "customer.subscription.created": ["subscription", "created"],
  "customer.subscription.updated": ["subscription", "updated"],
  "customer.subscription.paused": ["subscription", "updated"],
  "customer.subscription.resumed": ["subscription", "updated"],
  "customer.subscription.deleted": ["subscription", "canceled"],
  "customer.subscription.trial_will_end": ["trial", "ending_soon"],
  "invoice.finalized": ["invoice", "finalized"],
  "invoice.paid": ["invoice", "paid"],
  "invoice.payment_failed": ["invoice", "payment_failed"],
  "invoice.voided": ["invoice", "voided"],
  "invoice.marked_uncollectible": ["invoice", "uncollectible"],
  "charge.dispute.created": ["dispute", "opened"],
  "charge.dispute.closed": ["dispute", "closed"],
}

const ACK: IngestResult = { status: 200 }

interface StripeEvent {
  id: string
  type: string
  created: number | null
  livemode: boolean | null
  objectId: string | null
}

/** Only the envelope is read from the payload: id, type, time, mode, object id. */
export function readEnvelope(payload: unknown): StripeEvent | null {
  if (!payload || typeof payload !== "object") return null
  const p = payload as Obj
  const object = ((p.data as Obj | undefined)?.object ?? null) as Obj | null
  if (typeof p.id !== "string" || typeof p.type !== "string") return null
  return {
    id: p.id,
    type: p.type,
    created: typeof p.created === "number" ? p.created : null,
    livemode: typeof p.livemode === "boolean" ? p.livemode : null,
    objectId: typeof object?.id === "string" ? object.id : null,
  }
}

interface Install {
  id: string
  state: unknown
  livemode: unknown
  account_id: unknown
  webhook_confirmed_at: unknown
}

async function readInstall(db: IngestDb): Promise<Install | null> {
  const rows = (await db.findMany("install_metadata", { limit: 1 })) as Install[]
  return rows[0] ?? null
}

type InstallUpdate = Parameters<IngestDb["update"]>[2]

/** Move the state, recording the event; emits `connection:state_changed` when the state text changed. */
async function moveState(
  ctx: IngestCtx,
  install: Install,
  events: Array<Parameters<typeof transition>[1]>,
  extra: InstallUpdate,
): Promise<void> {
  const before = decodeState(install.state)
  let next = before
  for (const e of events) next = transition(next, e)
  const state = encodeState(next)
  await ctx.db.update("install_metadata", install.id, { ...extra, state })
  if (state !== encodeState(before)) {
    await ctx.emit({
      entity: "connection",
      action: "state_changed",
      entityId: install.id,
      data: { from: encodeState(before), to: state },
    })
  }
}

async function markCatchup(db: IngestDb, resource: string, code: string, now: Date): Promise<void> {
  const rows = (await db.findMany("sync_state", { where: { resource }, limit: 1 })) as Array<{ id: string }>
  const data = { catchup_due: true, last_error_code: code, updated: now.toISOString() }
  if (rows[0]) await db.update("sync_state", rows[0].id, data)
  else await db.insert("sync_state", { resource, status: "pending", done_count: 0, ...data })
}

/** True while some resource's first import is still running. */
async function importInProgress(db: IngestDb): Promise<boolean> {
  const rows = (await db.findMany("sync_state", { limit: 50 })) as Array<{ status?: unknown }>
  return rows.some((r) => r.status === "pending" || r.status === "running")
}

/** The instant the re-fetch starts, at the millisecond: the row's `stripe_updated`. */
const instant = (d: Date) => new Date(d.getTime()).toISOString()

/**
 * The same account, confirmed in this tick: the account answers (when its id is
 * known), and at least one other known object resolves in the install's mode.
 */
async function sameAccountConfirmed(ctx: IngestCtx, install: Install, exceptId: string): Promise<boolean> {
  const live = install.livemode === true
  try {
    if (typeof install.account_id === "string" && install.account_id) {
      const account = await stripeFetch<Obj>(ctx, "/v1/account", {}, { maxRetries: 0 })
      if (account?.id !== install.account_id) return false
    }
    const known: string[] = []
    for (const route of [CUSTOMER, SUBSCRIPTION, INVOICE]) {
      const rows = (await ctx.db.findMany(route.entity, { limit: 4 })) as Array<{ stripe_id?: unknown }>
      for (const r of rows) {
        if (typeof r.stripe_id === "string" && r.stripe_id !== exceptId && known.length < 3) {
          known.push(`${route.path}${r.stripe_id}`)
        }
      }
    }
    for (const path of known) {
      try {
        const obj = await stripeFetch<Obj>(ctx, path, {}, { maxRetries: 0 })
        if (obj?.livemode === live) return true
      } catch {
        // This one did not resolve; try the next.
      }
    }
    return false
  } catch {
    return false
  }
}

/** The typed event's payload: ids, statuses and minor units as strings, never the raw object. */
function typedPayload(route: Route, row: Obj, obj: Obj, tally: MaskTally): Obj {
  const s = (v: unknown) => (typeof v === "number" ? String(v) : v)
  if (route === INVOICE) {
    const lines = (((obj.lines as Obj | undefined)?.data ?? []) as Obj[]).map((l) => {
      const period = (l.period ?? {}) as Obj
      return {
        description: scan(l.description, "invoice line", tally),
        quantity: typeof l.quantity === "number" ? l.quantity : 1,
        amount_minor: s(l.amount),
        period_start: at(period.start),
        period_end: at(period.end),
      }
    })
    return {
      stripe_invoice_id: row.stripe_id,
      customer_id: row.customer_id,
      subscription_id: row.subscription_id,
      number: row.number,
      status: row.status,
      total_minor: s(row.total_minor),
      tax_minor: s(row.tax_minor),
      amount_paid_minor: s(row.amount_paid_minor),
      currency: row.currency,
      period_start: row.period_start,
      period_end: row.period_end,
      finalized_at: row.finalized_at,
      paid_at: row.paid_at,
      billing_reason: row.billing_reason,
      charge_id: typeof obj.charge === "string" ? obj.charge : null,
      lines,
    }
  }
  const out: Obj = { stripe_id: row.stripe_id }
  for (const k of ["customer_id", "payment_id", "status", "currency", "mrr_minor", "amount_minor", "trial_end"]) {
    if (k in row) out[k] = s(row[k])
  }
  return out
}

export interface DispatchOptions {
  now?: () => Date
}

/** Handle one verified delivery. Never throws for a Stripe or database failure: it answers a status. */
export async function handleStripeEvent(
  payload: unknown,
  ctx: IngestCtx,
  opts: DispatchOptions = {},
): Promise<IngestResult> {
  const now = opts.now ?? (() => new Date())
  const event = readEnvelope(payload)
  if (!event) return { status: 400, body: "Not a Stripe event: an id and a type are required. Nothing was stored." }

  // invoice.created: a ledger row, nothing else, and always a 200.
  if (event.type === "invoice.created") {
    try {
      const claim = await claimDelivery(ctx.db, event.id, event.type, now())
      if (claim.kind === "new") await settleDelivery(ctx.db, claim.row, "processed", now())
    } catch {
      try {
        await markCatchup(ctx.db, "invoices", "ledger_write_failed", now())
      } catch {
        // Even the catch-up mark failed; Stripe still gets its answer at once.
      }
    }
    return ACK
  }

  let claim: Awaited<ReturnType<typeof claimDelivery>>
  try {
    claim = await claimDelivery(ctx.db, event.id, event.type, now())
  } catch {
    return { status: 500, body: "The delivery ledger could not be written; Stripe will deliver again." }
  }
  if (claim.kind === "duplicate") return { status: 200, body: `Event ${event.id} was already handled; nothing changed.` }
  const row = claim.row

  try {
    const install = await readInstall(ctx.db)
    if (!install) {
      await settleDelivery(ctx.db, row, "not_connected", now())
      return ACK
    }
    if (event.livemode !== null && event.livemode !== (install.livemode === true)) {
      await settleDelivery(ctx.db, row, "mode_mismatch", now())
      return ACK
    }
    const route = HANDLED[event.type]
    if (!route || !event.objectId) {
      await settleDelivery(ctx.db, row, "ignored", now())
      return ACK
    }

    // Re-fetch: the payload's values are never used.
    const started = now()
    let obj: Obj | null = null
    try {
      obj = await stripeFetch<Obj>(ctx, `${route.path}${encodeURIComponent(event.objectId)}`, {}, { maxRetries: 0 })
    } catch (err) {
      if (!(err instanceof StripeApiError)) throw err
      if (err.code === "key_invalid" || err.code === "permission_missing") {
        await settleDelivery(ctx.db, row, "failed", now())
        await markCatchup(ctx.db, route.resource, err.code, now())
        await moveState(ctx, install, [{ kind: err.code === "key_invalid" ? "key_refused" : "permission_refused" }], {})
        return ACK
      }
      if (err.status !== 404) throw err
      // 404: a deletion only when it is one, or when the same account is confirmed.
      if (!event.type.endsWith(".deleted") && !(await sameAccountConfirmed(ctx, install, event.objectId))) {
        await settleDelivery(ctx.db, row, "different_account", now())
        await moveState(ctx, install, [{ kind: "account_unconfirmed" }], {})
        return ACK
      }
      if (route === CUSTOMER) {
        await ctx.db.updateMany("stripe_customers", {
          where: { stripe_id: event.objectId },
          data: { deleted_at: instant(started) },
        })
      }
      await settleDelivery(ctx.db, row, "processed", now())
      return ACK
    }

    const tally = newTally()
    const mirrorRow = route.row(obj ?? {}, tally)
    const outcome =
      route === CUSTOMER && obj?.deleted === true
        ? await ctx.db
            .updateMany("stripe_customers", { where: { stripe_id: event.objectId }, data: { deleted_at: instant(started) } })
            .then(() => "updated" as const)
        : await writeMirror(ctx.db, route.entity, mirrorRow, instant(started))

    // The typed event's payload is built first: its text is masked too.
    const typed = EMITS[event.type]
    const typedData = typed && outcome !== "stale" ? typedPayload(route, mirrorRow, obj ?? {}, tally) : null
    if (tally.cards > 0) {
      await ctx.emit({
        entity: "card_number",
        action: "masked",
        entityId: String(mirrorRow.stripe_id ?? event.objectId),
        data: { object: route.resource, stripe_id: mirrorRow.stripe_id, fields: tally.fields.join(", "), count: tally.cards },
      })
    }
    if (typed && typedData) {
      await ctx.emit({ entity: typed[0], action: typed[1], entityId: String(mirrorRow.stripe_id), data: typedData })
    }

    // The connection: the first verified event moves it on and names the event.
    const nowIso = now().toISOString()
    const first = !install.webhook_confirmed_at
    const steps: Array<Parameters<typeof transition>[1]> = first
      ? [{ kind: "webhook_secret_stored" }, { kind: "first_event" }]
      : [{ kind: "event_received" }]
    if (first && !(await importInProgress(ctx.db))) steps.push({ kind: "import_done" })
    await moveState(ctx, install, steps, {
      last_event_at: nowIso,
      last_event_type: event.type,
      ...(first ? { webhook_confirmed_at: nowIso } : {}),
    })

    await settleDelivery(ctx.db, row, "processed", now())
    return ACK
  } catch (err) {
    try {
      await settleDelivery(ctx.db, row, "failed", now())
    } catch {
      // The ledger itself failed; the kernel's retry and Stripe's redelivery still come.
    }
    const why = err instanceof StripeApiError ? `Stripe answered ${err.status}` : "a write failed"
    return { status: 500, body: `Event ${event.id} was not applied (${why}); it will be retried.` }
  }
}
