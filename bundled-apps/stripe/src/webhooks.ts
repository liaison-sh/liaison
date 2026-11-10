// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The delivery ledger (`webhook_deliveries`): one row per Stripe event id, the
// app's own record that an event was handled. The kernel's replay claim lives in
// Redis and is released on a failure or lost on a cache reset; this ledger is
// what stops the same event being applied twice after that.
//
// CLAIM. The unique index on `(org_id, event_id)` decides: a second delivery of
// the same id finds the row (or loses its insert to it, waiting until the first
// delivery's transaction commits) and changes nothing. A row left `failed` is
// claimed again, so a retry converges on the same row instead of adding one,
// and so is a row still `processing` past its lease (`DELIVERY_LEASE_MS` after
// its claim): the worker that claimed it died mid-dispatch, and without this
// Stripe's retry would be told the event was handled. Taking a row up again is
// a conditional update on its status and claim time, so of two retries at the
// same time only one wins. No event body is stored, only its id, type and
// outcome.

export type DeliveryStatus =
  | "processing"
  | "processed"
  | "ignored"
  | "failed"
  | "mode_mismatch"
  | "different_account"
  | "not_connected"

/** How long a claimed delivery may stay `processing` before a retry takes it up again. */
export const DELIVERY_LEASE_MS = 5 * 60_000

export interface LedgerDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number; orderBy?: Record<string, "asc" | "desc"> },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  updateMany(entity: string, opts: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
}

export interface DeliveryRow {
  id: string
  event_id: string
  topic: string
  status: string
  failure_count: number
  received_at?: string | null
  claimed_at?: string | null
}

function timeOf(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

/** Whether a retry may take `row` up again at `now`. */
function reclaimable(row: DeliveryRow, now: Date): boolean {
  if (row.status === "failed") return true
  if (row.status !== "processing") return false
  const claimed = timeOf(row.claimed_at) ?? timeOf(row.received_at)
  return claimed !== null && now.getTime() - claimed >= DELIVERY_LEASE_MS
}

export type Claim = { kind: "new"; row: DeliveryRow } | { kind: "duplicate"; row: DeliveryRow }

async function read(db: LedgerDb, eventId: string): Promise<DeliveryRow | null> {
  const rows = (await db.findMany("webhook_deliveries", { where: { event_id: eventId }, limit: 1 })) as DeliveryRow[]
  return rows[0] ?? null
}

async function reclaim(db: LedgerDb, row: DeliveryRow, now: Date): Promise<Claim> {
  if (!reclaimable(row, now)) return { kind: "duplicate", row }
  const claimedAt = now.toISOString()
  const won = await db.updateMany("webhook_deliveries", {
    where: { id: row.id, status: row.status, claimed_at: row.claimed_at ?? null },
    data: { status: "processing", claimed_at: claimedAt },
  })
  if (won.count !== 1) return { kind: "duplicate", row }
  return { kind: "new", row: { ...row, status: "processing", claimed_at: claimedAt } }
}

/** Claim `eventId` for this delivery, or report that it was already handled. */
export async function claimDelivery(db: LedgerDb, eventId: string, topic: string, now: Date): Promise<Claim> {
  const existing = await read(db, eventId)
  if (existing) return reclaim(db, existing, now)
  try {
    const { id } = await db.insert("webhook_deliveries", {
      event_id: eventId,
      topic,
      status: "processing",
      failure_count: 0,
      received_at: now.toISOString(),
      claimed_at: now.toISOString(),
    })
    return { kind: "new", row: { id, event_id: eventId, topic, status: "processing", failure_count: 0, claimed_at: now.toISOString() } }
  } catch (err) {
    // Lost the race on the unique index: the other delivery's row decides.
    const winner = await read(db, eventId)
    if (!winner) throw err
    return reclaim(db, winner, now)
  }
}

/** Record the delivery's outcome. A failure counts one more attempt. */
export async function settleDelivery(
  db: LedgerDb,
  row: DeliveryRow,
  status: Exclude<DeliveryStatus, "processing">,
  now: Date,
): Promise<void> {
  await db.update("webhook_deliveries", row.id, {
    status,
    ...(status === "failed"
      ? { failure_count: (Number(row.failure_count) || 0) + 1 }
      : { processed_at: now.toISOString() }),
  })
}
