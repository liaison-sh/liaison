// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The delivery log (S1, A5, A10): `kernel.notification_deliveries`.
 *
 * Two kinds of row:
 *  - router level, `device_id` NULL: a live channel the router held back
 *    (`suppressed` with the rule's reason, `no_device`), or a computer-channel
 *    item with no live target (`no_target`). One per (notification, channel):
 *    the unique partial index makes a replayed event insert nothing new.
 *  - per attempt, one per device per try: the APNs answer of each host tried,
 *    the desktop frame per connection (`accepted` or `no_connection`).
 *
 * Writing is best effort and never throws: a log row is not worth failing the
 * producer or the outbox tick that raised the notification.
 */
import { type SQL, sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import {
  type DeliveryResult,
  type DeliverySurface,
  notificationDeliveries,
} from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { rootLogger } from "~/lib/logger"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"
import { notificationIdFor, type RouterDecision } from "./router"

const K = sql.raw(schemaRef("kernel"))

const log = rootLogger.child({ module: "notifications-delivery-log" })

export type DeliveryChannel = "push" | "desktop" | "in_app" | "email" | "test"

export interface DeliveryRecord {
  orgId: string
  userId: string
  notificationId: string
  channel: DeliveryChannel
  result: DeliveryResult
  deviceId?: string | null
  surface?: DeliverySurface | null
  reason?: string | null
  providerStatus?: number | null
  /** The frame as sent, already redacted. */
  payload?: unknown
  attemptedAt?: Date
}

/** Insert rows; a router-level duplicate is skipped. Never throws. */
export async function recordDeliveries(records: DeliveryRecord[]): Promise<void> {
  if (records.length === 0) return
  const byOrg = new Map<string, DeliveryRecord[]>()
  for (const r of records) {
    const list = byOrg.get(r.orgId) ?? []
    list.push(r)
    byOrg.set(r.orgId, list)
  }
  for (const [orgId, rows] of byOrg) {
    try {
      await withPrivilegedDb(orgId, "notifications:delivery-log", (tx) =>
        tx
          .insert(notificationDeliveries)
          .values(
            rows.map((r) => ({
              orgId: r.orgId,
              userId: r.userId,
              notificationId: r.notificationId,
              channel: r.channel,
              result: r.result,
              deviceId: r.deviceId ?? null,
              surface: r.surface ?? null,
              reason: r.reason ?? null,
              providerStatus: r.providerStatus ?? null,
              payload: r.payload === undefined ? null : r.payload,
              // One clock (this process's) for every row, so order reads true.
              attemptedAt: r.attemptedAt ?? new Date(),
            })),
          )
          .onConflictDoNothing(),
      )
    } catch (err) {
      log.warn({ err, orgId, rows: rows.length }, "delivery log write failed")
    }
  }
}

/**
 * The router-level rows of one decision: every live channel (push, desktop)
 * the router held back. `no_device` is its own result; every other reason is
 * `suppressed`. A channel that delivers writes nothing here: its attempt rows
 * come from the sender.
 */
export function routerSuppressionRecords(
  decision: RouterDecision,
  notifyId: string,
): DeliveryRecord[] {
  const notificationId = notificationIdFor(decision.userId, notifyId)
  const out: DeliveryRecord[] = []
  for (const channel of ["desktop", "push"] as const) {
    const d = decision.channels[channel]
    if (d.deliver) continue
    out.push({
      orgId: decision.orgId,
      userId: decision.userId,
      notificationId,
      channel,
      result: d.reason === "no_device" ? "no_device" : "suppressed",
      reason: d.reason ?? null,
    })
  }
  return out
}

/** Write the router-level rows of one decision. Never throws. */
export async function recordRouterSuppressions(
  decision: RouterDecision,
  notifyId: string,
): Promise<void> {
  await recordDeliveries(routerSuppressionRecords(decision, notifyId))
}

const NOTIFICATION_LOG_RETENTION_DAYS = 30
const RETENTION_BATCH_SIZE = 5000

/** Delete rows older than the retention, batched so one statement never holds a long lock. */
async function purgeOlderThanRetention(
  label: string,
  table: SQL,
  timeColumn: SQL,
): Promise<number> {
  let deleted = 0
  // An org being moved keeps its rows as they are until the move ends.
  for (;;) {
    const result = await sweepSkippingMoving((notMoving) =>
      withSystemDb(label, (db) =>
        db.execute(sql`
        WITH doomed AS (
          SELECT id FROM ${table}
          WHERE ${timeColumn} < NOW() - MAKE_INTERVAL(days => ${NOTIFICATION_LOG_RETENTION_DAYS})
            AND ${notMoving(sql.raw("org_id"))}
          LIMIT ${RETENTION_BATCH_SIZE}
        )
        DELETE FROM ${table} t
        USING doomed
        WHERE t.id = doomed.id
        RETURNING t.id
      `),
      ),
    )
    const rows = extractRows(result)
    deleted += rows.length
    if (rows.length < RETENTION_BATCH_SIZE) return deleted
  }
}

/** The 30-day purge of the delivery log (payloads included). */
export async function runNotificationDeliveriesRetention(): Promise<{ deleted: number }> {
  let deleted = await purgeOlderThanRetention(
    "notification-deliveries-retention",
    sql`${notificationDeliveries}`,
    sql.raw("attempted_at"),
  )
  // Receipts share the log's retention (S1).
  deleted += await purgeOlderThanRetention(
    "notification-receipts-retention",
    sql`${K}.notification_receipts`,
    sql.raw("received_at"),
  )
  if (deleted > 0) log.info({ count: deleted }, "notification delivery log retention")
  return { deleted }
}
