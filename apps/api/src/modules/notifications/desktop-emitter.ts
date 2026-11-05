// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The computer-channel emitter (S4, S5, S6, A5, A6): the one way a producer
 * raises a notification on a computer. It takes the router's
 * `RouterDecision`, so nothing reaches a computer the grid, a rule, a mute or
 * quiet time held back.
 *
 * Precedence for one item and user (A6):
 *   1. every live desktop app whose reported OS permission is `granted`, by
 *      `notify` frame; a 10 s delayed check follows (`runDesktopFallback`);
 *   2. else the single most recently active browser tab, by `notify` frame
 *      (the tab keeps its on-screen suppression);
 *   3. else every Web Push subscription of the user.
 * A phone is never a target here (push covers it). The choice reads the
 * shared presence registry, so it holds across API instances. The claim
 * `SET notify:<userId>:<notifyId> NX EX 86400` makes a second emit of the same
 * item (an at-least-once redelivery, another instance) a no-op.
 *
 * The desktop is confirmed by its receipt: with none within 10 s (a killed app
 * stays in presence until its 60 s TTL), the item falls through to rule 2 or 3
 * for that notification, once. A desktop that (re)connects with permission
 * gets the computer items of the last 15 minutes that no computer surface
 * receipted, the router did not suppress and nobody read since, once each
 * (`notify-replay:<userId>:<notificationId>`).
 *
 * Every outcome is logged (S1): one `notification_deliveries` row per target
 * (`accepted` / `no_connection` for a frame, the push service's answer for Web
 * Push), or one `no_target` row when nothing is live. Each row keeps the frame
 * (already redacted) as its payload, which is what the replay sends.
 *
 * Never throws: a Redis or DB failure costs the computer notification, not the
 * producer's transaction.
 */
import { sql } from "drizzle-orm"
import type Redis from "ioredis"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { enqueueAppJob } from "~/infra/jobs/jobs"
import {
  getWsManager,
  type NotifyFrame,
  type NotifyPresenceEntry,
  selectNotifyTargets,
  type WebSocketManager,
} from "~/infra/websocket"
import { recordSinkEffect } from "~/lib/effect-sink"
import { isLoadOrg } from "~/lib/load-harness"
import { rootLogger } from "~/lib/logger"
import {
  loadWebPushSubscriptions,
  sendWebPushTo,
  type WebPushSend,
  type WebPushSubscriptionRow,
  webPushBody,
} from "~/modules/push/web-push"
import { type DeliveryRecord, recordDeliveries } from "./delivery-log"
import { notificationIdFor, type RouterDecision } from "./router"

const log = rootLogger.child({ module: "notifications-desktop" })
const K = sql.raw(schemaRef("kernel"))

export const NOTIFY_IDEMPOTENCY_TTL_SECONDS = 86_400
/** How long a desktop delivery waits for its receipt before falling through (A6). */
export const DESKTOP_RECEIPT_WINDOW_MS = 10_000
/** How far back a reconnecting desktop is caught up (A5). */
export const REPLAY_WINDOW_MINUTES = 15
/** The kernel job that runs the 10 s check. */
export const DESKTOP_FALLBACK_JOB = "notify-desktop-fallback"

/** What the producer says about the item; group and urgency come from the decision. */
export interface DesktopNotifyPayload {
  /** `attention:<eventId>[:<revision>]` or `message:<messageId>`. */
  notifyId: string
  title: string
  body: string
  /** In-app route the item opens (the desktop click only focuses the app today). */
  route: string
  /** The OS notification tag. Absent, it is the route's conversation (`desktopTag`). */
  tag?: string
}

/**
 * The tag of a computer notification: the producer's, else the conversation
 * its route names (`thread/<id>` without the reply query, or the item's own
 * route), else the item. A newer notification with the same tag replaces the
 * older one on screen (the browser `tag`, the desktop app's request id).
 */
export function desktopTag(payload: DesktopNotifyPayload): string {
  if (payload.tag) return payload.tag
  const conversation = payload.route.split("?")[0]
  return conversation ? conversation : payload.notifyId
}

export interface DesktopNotifyResult {
  /** Targets the item was addressed to (frames and Web Push sends). */
  sent: number
  skipped?: "not_routed" | "duplicate" | "no_target" | "no_realtime" | "error"
}

/** The payload of the 10 s check: everything needed to deliver the item again. */
export interface DesktopFallbackJob {
  orgId: string
  userId: string
  notifyId: string
  notificationId: string
  frame: NotifyFrame
}

export interface DesktopNotifyDeps {
  /** Defaults to this process's realtime manager. */
  manager?: WebSocketManager | null
  /** Defaults to the manager's own Redis client. */
  redis?: Redis
  /** The delivery log writer. Defaults to `recordDeliveries`. */
  record?: (rows: DeliveryRecord[]) => Promise<void>
  /** The Web Push wire. Defaults to `defaultWebPushSend` (VAPID from env). */
  webPush?: WebPushSend
  /** The user's Web Push subscriptions. Defaults to the DB. */
  loadSubscriptions?: (orgId: string, userId: string) => Promise<WebPushSubscriptionRow[]>
  /** Arms the 10 s desktop check. Defaults to a delayed kernel job. */
  scheduleFallback?: (job: DesktopFallbackJob, delayMs: number) => Promise<void>
}

type Base = Pick<DeliveryRecord, "orgId" | "userId" | "notificationId" | "channel">

/** Claim `key` for the idempotency window; false when it was already claimed. */
async function claimOnce(redis: Redis, key: string): Promise<boolean> {
  return (await redis.set(key, "1", "EX", NOTIFY_IDEMPOTENCY_TTL_SECONDS, "NX")) === "OK"
}

const defaultScheduleFallback = async (job: DesktopFallbackJob, delayMs: number) => {
  await enqueueAppJob("kernel", DESKTOP_FALLBACK_JOB, job, {
    jobId: `notify-fallback:${job.notificationId}`,
    delay: delayMs,
    attempts: 1,
  })
}

/** Send a frame to connections and log one row per connection. */
async function sendFrames(
  manager: WebSocketManager,
  targets: NotifyPresenceEntry[],
  frame: NotifyFrame,
  base: Base,
  record: NonNullable<DesktopNotifyDeps["record"]>,
  reason: string | null = null,
): Promise<number> {
  const results = await manager.sendNotifyEach(targets, frame)
  const at = new Date()
  await record(
    targets.map((t, i) => ({
      ...base,
      deviceId: t.deviceId ?? null,
      surface: t.kind === "desktop_app" ? ("desktop" as const) : ("browser_tab" as const),
      result: results[i] ? ("accepted" as const) : ("no_connection" as const),
      reason,
      payload: frame,
      attemptedAt: at,
    })),
  )
  return results.filter(Boolean).length
}

/**
 * Rules 2 and 3 (A6): the most recent live tab, else every Web Push
 * subscription, else a `no_target` row. A desktop app is never chosen here.
 */
async function deliverToBrowser(
  manager: WebSocketManager | null,
  entries: NotifyPresenceEntry[],
  frame: NotifyFrame,
  base: Base,
  deps: DesktopNotifyDeps,
): Promise<number> {
  const record = deps.record ?? recordDeliveries
  const tabs = selectNotifyTargets(entries.filter((e) => e.kind === "browser"))
  if (manager && tabs.length > 0) return sendFrames(manager, tabs, frame, base, record)

  let subs: WebPushSubscriptionRow[] = []
  try {
    subs = await (deps.loadSubscriptions ?? loadWebPushSubscriptions)(base.orgId, base.userId)
  } catch (err) {
    log.warn({ err, userId: base.userId }, "web push subscriptions unreadable")
  }
  if (subs.length === 0) {
    await record([{ ...base, result: "no_target", payload: frame }])
    return 0
  }
  const body = webPushBody(base.userId, frame)
  let sent = 0
  // A load org's Web Push goes to the effect sink, never to a browser (A13).
  // Its once-guard is the `notify:` / `notify-fallback:` claim above, taken
  // before any send.
  const sink = await isLoadOrg(base.orgId)
  for (const sub of subs) {
    if (sink) {
      await recordSinkEffect(base.orgId, "push", `webpush:${base.notificationId}:${sub.deviceId}`)
      sent += 1
      continue
    }
    const { ok, status, reason } = await sendWebPushTo(
      base.orgId,
      base.userId,
      sub,
      body,
      deps.webPush,
    )
    if (ok) sent += 1
    await record([
      {
        ...base,
        deviceId: sub.deviceId,
        surface: "browser_push",
        result: ok ? "accepted" : "rejected",
        reason,
        providerStatus: status || null,
        payload: frame,
      },
    ])
  }
  return sent
}

export async function emitDesktopNotify(
  decision: RouterDecision,
  payload: DesktopNotifyPayload,
  deps: DesktopNotifyDeps = {},
): Promise<DesktopNotifyResult> {
  if (!decision.channels.desktop.deliver) return { sent: 0, skipped: "not_routed" }
  const record = deps.record ?? recordDeliveries
  const notificationId = notificationIdFor(decision.userId, payload.notifyId)
  const base: Base = {
    orgId: decision.orgId,
    userId: decision.userId,
    notificationId,
    channel: "desktop",
  }
  const frame: NotifyFrame = {
    type: "notify",
    notifyId: payload.notifyId,
    notificationId,
    group: decision.group,
    title: payload.title,
    body: payload.body,
    route: payload.route,
    urgent: decision.urgent,
    tag: desktopTag(payload),
  }
  const manager = deps.manager === undefined ? getWsManager() : deps.manager
  if (!manager) {
    await record([{ ...base, result: "no_target", reason: "no_realtime", payload: frame }])
    return { sent: 0, skipped: "no_realtime" }
  }
  const redis = deps.redis ?? manager.redisClient
  try {
    if (!(await claimOnce(redis, `notify:${decision.userId}:${payload.notifyId}`)))
      return { sent: 0, skipped: "duplicate" }
    const entries = await manager.listNotifyPresence(decision.orgId, decision.userId)
    const targets = selectNotifyTargets(entries)
    if (targets.length > 0 && targets[0]?.kind === "desktop_app") {
      const sent = await sendFrames(manager, targets, frame, base, record)
      try {
        await (deps.scheduleFallback ?? defaultScheduleFallback)(
          {
            orgId: decision.orgId,
            userId: decision.userId,
            notifyId: payload.notifyId,
            notificationId,
            frame,
          },
          DESKTOP_RECEIPT_WINDOW_MS,
        )
      } catch (err) {
        log.warn({ err, notificationId }, "desktop fallback check could not be armed")
      }
      return { sent }
    }
    const sent = await deliverToBrowser(manager, entries, frame, base, deps)
    return sent > 0 ? { sent } : { sent: 0, skipped: "no_target" }
  } catch (err) {
    log.warn(
      { err, userId: decision.userId, orgId: decision.orgId, notifyId: payload.notifyId },
      "desktop notify failed",
    )
    return { sent: 0, skipped: "error" }
  }
}

/** Did a desktop app post a receipt (any outcome) for this notification? */
async function hasDesktopReceipt(job: DesktopFallbackJob): Promise<boolean> {
  const rows = (await withPrivilegedDb(job.orgId, "notifications:desktop-receipt", (tx) =>
    tx.execute(sql`
      SELECT 1 FROM ${K}.notification_receipts r
       WHERE r.notification_id = ${job.notificationId}
         AND r.org_id = ${job.orgId}
         AND r.user_id = ${job.userId}
         AND (r.surface = 'desktop' OR EXISTS (
               SELECT 1 FROM ${K}.notification_deliveries d
                WHERE d.notification_id = r.notification_id
                  AND d.org_id = r.org_id
                  AND d.device_id = r.device_id
                  AND d.surface = 'desktop'))
       LIMIT 1`),
  )) as unknown as unknown[]
  return rows.length > 0
}

/**
 * The 10 s check (A6): no desktop receipt for the item, so it goes to the
 * next rule (live tab, else Web Push), at most once per notification.
 */
export async function runDesktopFallback(
  job: DesktopFallbackJob,
  deps: DesktopNotifyDeps = {},
): Promise<"receipted" | "duplicate" | "delivered" | "no_target" | "error"> {
  try {
    if (await hasDesktopReceipt(job)) return "receipted"
    const manager = deps.manager === undefined ? getWsManager() : deps.manager
    const redis = deps.redis ?? manager?.redisClient
    if (redis && !(await claimOnce(redis, `notify-fallback:${job.userId}:${job.notifyId}`))) {
      return "duplicate"
    }
    const entries = manager ? await manager.listNotifyPresence(job.orgId, job.userId) : []
    const sent = await deliverToBrowser(
      manager,
      entries,
      job.frame,
      {
        orgId: job.orgId,
        userId: job.userId,
        notificationId: job.notificationId,
        channel: "desktop",
      },
      deps,
    )
    return sent > 0 ? "delivered" : "no_target"
  } catch (err) {
    log.warn({ err, notificationId: job.notificationId }, "desktop fallback failed")
    return "error"
  }
}

const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

/**
 * A desktop app (re)connected with permission (A5): send it, once each, the
 * computer items of the last 15 minutes that no computer surface receipted
 * and the router did not suppress, unless it was read meanwhile (rule 5).
 * Returns how many were replayed.
 */
export async function replayMissedDesktopNotifications(
  manager: WebSocketManager,
  entry: NotifyPresenceEntry,
  orgId: string,
  userId: string,
  deps: Pick<DesktopNotifyDeps, "record" | "redis"> = {},
): Promise<number> {
  if (entry.kind !== "desktop_app" || entry.notificationPermission !== "granted") return 0
  try {
    const missed = (await withPrivilegedDb(orgId, "notifications:desktop-replay", (tx) =>
      tx.execute(sql`
        SELECT DISTINCT ON (d.notification_id) d.notification_id, d.payload
          FROM ${K}.notification_deliveries d
         WHERE d.org_id = ${orgId}
           AND d.user_id = ${userId}
           AND d.channel = 'desktop'
           AND d.payload IS NOT NULL
           AND d.attempted_at > now() - make_interval(mins => ${REPLAY_WINDOW_MINUTES})
           AND NOT EXISTS (
             SELECT 1 FROM ${K}.notification_deliveries s
              WHERE s.notification_id = d.notification_id
                AND s.org_id = d.org_id
                AND s.channel = 'desktop'
                AND s.result = 'suppressed')
           AND NOT EXISTS (
             SELECT 1 FROM ${K}.notification_receipts r
              WHERE r.notification_id = d.notification_id
                AND r.org_id = d.org_id
                AND r.user_id = d.user_id
                AND r.surface IN ('desktop', 'browser_tab', 'browser_push'))
           -- Rule 5, read once, read everywhere: nothing read on another
           -- device meanwhile comes back. A message is read once the reader's
           -- mark in its thread is at or past it; an attention item once its
           -- row is read.
           AND NOT EXISTS (
             SELECT 1 FROM ${K}.messages m
               JOIN ${K}.user_thread_state uts
                 ON uts.thread_id = m.thread_id AND uts.user_id = d.user_id
               JOIN ${K}.messages lr ON lr.id = uts.last_read_message_id
              WHERE d.payload->>'notifyId' LIKE 'message:%'
                AND m.id = CASE WHEN substring(d.payload->>'notifyId' FROM 9) ~* ${UUID_PATTERN}
                                THEN substring(d.payload->>'notifyId' FROM 9)::uuid END
                AND lr.created_at >= m.created_at)
           AND NOT EXISTS (
             SELECT 1 FROM ${K}.attention_events ae
              WHERE d.payload->>'notifyId' LIKE 'attention:%'
                AND ae.id = CASE WHEN substring(d.payload->>'notifyId' FROM 11) ~* ${UUID_PATTERN}
                                 THEN substring(d.payload->>'notifyId' FROM 11)::uuid END
                AND ae.user_id = d.user_id
                AND ae.read_at IS NOT NULL)
         ORDER BY d.notification_id, d.attempted_at`),
    )) as unknown as Array<{ notification_id: string; payload: NotifyFrame }>
    if (missed.length === 0) return 0
    const redis = deps.redis ?? manager.redisClient
    const record = deps.record ?? recordDeliveries
    let replayed = 0
    for (const row of missed) {
      if (!(await claimOnce(redis, `notify-replay:${userId}:${row.notification_id}`))) continue
      replayed += await sendFrames(
        manager,
        [entry],
        row.payload,
        { orgId, userId, notificationId: row.notification_id, channel: "desktop" },
        record,
        "replay",
      )
    }
    return replayed
  } catch (err) {
    log.warn({ err, userId }, "desktop replay failed")
    return 0
  }
}
