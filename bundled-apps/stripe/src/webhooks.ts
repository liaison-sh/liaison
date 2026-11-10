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
// claimed again, so a retry converges on the same row instead of adding one.
// No event body is stored, only its id, type and outcome.

export type DeliveryStatus =
  | "processing"
  | "processed"
  | "ignored"
  | "failed"
  | "mode_mismatch"
  | "different_account"
  | "not_connected"

/** Outcomes a retry may take up again. */
const RECLAIMABLE: ReadonlySet<string> = new Set(["failed"])

export interface LedgerDb {
  findMany(entity: string, opts?: { where?: Record<string, unknown>; limit?: number }): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface DeliveryRow {
  id: string
  event_id: string
  topic: string
  status: string
  failure_count: number
}

export type Claim = { kind: "new"; row: DeliveryRow } | { kind: "duplicate"; row: DeliveryRow }

async function read(db: LedgerDb, eventId: string): Promise<DeliveryRow | null> {
  const rows = (await db.findMany("webhook_deliveries", { where: { event_id: eventId }, limit: 1 })) as DeliveryRow[]
  return rows[0] ?? null
}

async function reclaim(db: LedgerDb, row: DeliveryRow): Promise<Claim> {
  if (!RECLAIMABLE.has(row.status)) return { kind: "duplicate", row }
  await db.update("webhook_deliveries", row.id, { status: "processing" })
  return { kind: "new", row: { ...row, status: "processing" } }
}

/** Claim `eventId` for this delivery, or report that it was already handled. */
export async function claimDelivery(db: LedgerDb, eventId: string, topic: string, now: Date): Promise<Claim> {
  const existing = await read(db, eventId)
  if (existing) return reclaim(db, existing)
  try {
    const { id } = await db.insert("webhook_deliveries", {
      event_id: eventId,
      topic,
      status: "processing",
      failure_count: 0,
      received_at: now.toISOString(),
    })
    return { kind: "new", row: { id, event_id: eventId, topic, status: "processing", failure_count: 0 } }
  } catch (err) {
    // Lost the race on the unique index: the other delivery's row decides.
    const winner = await read(db, eventId)
    if (!winner) throw err
    return reclaim(db, winner)
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
