// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A dispute that needs a response reaches the people who can act on it.
//
// A chargeback has an evidence due date: when nobody answers it in Stripe by
// then, the money is lost. So every dispute row the mirror writes says, as a
// `dispute:response_state` event, whether it still needs a response. The
// manifest turns that event into one Home line per dispute (amount, customer,
// due date) for the holders of `stripe:refunds:write`, and the same event with
// `needs_response: false` (answered, won, lost, closed) clears it.
//
// Where it comes from:
//   - a webhook delivery (dispatch.ts), for every `charge.dispute.*` event;
//   - the first import and the nightly reconcile, which emit no typed event but
//     must not leave an open chargeback unsaid (sync/backfill.ts, reconcile.ts);
//   - the daily `disputes-due` job (`runDisputesDue`), which says it again for
//     every dispute still waiting. A line someone read comes back the next day
//     while the dispute is unanswered, and once the due date has passed it
//     sorts higher (overdue). Urgency orders Home only: the line is never
//     marked urgent.
type Obj = Record<string, unknown>

/** The statuses Stripe gives a dispute that waits for the merchant's evidence. */
export const NEEDS_RESPONSE_STATUSES = ["needs_response", "warning_needs_response"] as const

export function needsResponse(status: unknown): boolean {
  return (NEEDS_RESPONSE_STATUSES as readonly string[]).includes(String(status ?? ""))
}

export interface DisputeDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]>
}

export interface DisputeEmitCtx {
  db: DisputeDb
  emit(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

const money = (minor: number, currency: string) =>
  `${(minor / 100).toFixed(2)} ${currency.toUpperCase()}`

function msOf(v: unknown): number {
  if (v instanceof Date) return v.getTime()
  return typeof v === "string" && v ? Date.parse(v) : Number.NaN
}

/** Who the dispute is from, as the mirror knows them: name, else email, else the charge. */
async function customerOf(db: DisputeDb, paymentId: string): Promise<string> {
  if (!paymentId) return "an unknown customer"
  const [pay] = (await db.findMany("stripe_payments", {
    where: { stripe_id: paymentId },
    limit: 1,
  })) as Obj[]
  const customerId = typeof pay?.customer_id === "string" ? pay.customer_id : ""
  if (customerId) {
    const [cust] = (await db.findMany("stripe_customers", {
      where: { stripe_id: customerId },
      limit: 1,
    })) as Obj[]
    const name = typeof cust?.name === "string" ? cust.name.trim() : ""
    if (name) return name
    const email = typeof cust?.email === "string" ? cust.email.trim() : ""
    if (email) return email
    return customerId
  }
  return `the payer of charge ${paymentId}`
}

/** The event's payload for one mirror row of `stripe_disputes`. */
export async function disputeResponseState(
  db: DisputeDb,
  row: Obj,
  now: Date,
): Promise<{ entity: string; action: string; entityId: string; data: Obj }> {
  const open = needsResponse(row.status)
  const dueMs = msOf(row.evidence_due_by)
  const due = Number.isFinite(dueMs) ? new Date(dueMs).toISOString().slice(0, 10) : null
  const amountMinor = Number(row.amount_minor ?? 0)
  const currency = String(row.currency ?? "")
  const data: Obj = {
    stripe_id: String(row.stripe_id),
    payment_id: String(row.payment_id ?? ""),
    status: String(row.status ?? ""),
    needs_response: open,
    overdue: open && Number.isFinite(dueMs) && dueMs < now.getTime(),
    amount: money(Number.isFinite(amountMinor) ? amountMinor : 0, currency),
    customer: open ? await customerOf(db, String(row.payment_id ?? "")) : "",
    due: due ?? "no due date given",
    reason: String(row.reason ?? "") || "no reason given",
  }
  return { entity: "dispute", action: "response_state", entityId: String(row.stripe_id), data }
}

/** Say where one written dispute row stands. `onlyOpen`: say nothing for one that needs nothing. */
export async function emitDisputeResponseState(
  ctx: DisputeEmitCtx,
  row: Obj,
  now: Date,
  opts: { onlyOpen?: boolean } = {},
): Promise<void> {
  if (typeof row.stripe_id !== "string" || !row.stripe_id) return
  if (opts.onlyOpen && !needsResponse(row.status)) return
  await ctx.emit(await disputeResponseState(ctx.db, row, now))
}

const PER_RUN = 500

/** The daily job: every dispute still waiting for a response, said again (see the header). */
export async function runDisputesDue(
  ctx: DisputeEmitCtx,
  opts: { now?: () => Date } = {},
): Promise<{ open: number }> {
  const now = (opts.now ?? (() => new Date()))()
  let open = 0
  for (const status of NEEDS_RESPONSE_STATUSES) {
    const rows = (await ctx.db.findMany("stripe_disputes", {
      where: { status },
      limit: PER_RUN,
    })) as Obj[]
    for (const row of rows) {
      await emitDisputeResponseState(ctx, row, now)
      open++
    }
  }
  return { open }
}
