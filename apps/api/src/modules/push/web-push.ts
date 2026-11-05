// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Web Push (VAPID) for the browser computer channel (A6, rule 3).
//
// The wire is an injected `WebPushSend`, like the APNs transport: tests prove
// the selection, the payload and the 410 handling without a push service. The
// default goes through the `web-push` package with the VAPID keys from
// `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`. Without them the
// browser rule is a LOUD NO-OP (one warn), never a throw.
//
// A 404 or 410 from the push service means the subscription is gone for good:
// its endpoint and keys are cleared (the browser device itself stays, with its
// receipt credential for in-tab receipts), and the delivery is
// `rejected/expired`.
import { createHash } from "node:crypto"
import { and, eq, isNotNull } from "drizzle-orm"
import webpush from "web-push"
import type { PrivilegedDb, RlsClient } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { browserPushSubscriptions } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { fetchWithPinnedHost } from "~/lib/outbound-fetch"

const log = rootLogger.child({ module: "web-push" })

export interface WebPushTarget {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

/** One send: the push service's HTTP status (0 = not attempted). */
export type WebPushSend = (target: WebPushTarget, body: string) => Promise<{ status: number }>

let disabledNoticed = false

/** Exposed for tests: forget that the missing-keys warning was logged. */
export function _resetWebPushNotice(): void {
  disabledNoticed = false
}

/**
 * The user marker every Web Push body carries (fix2-F1): a hash of the
 * recipient's user id, never the id itself. The service worker hashes the
 * user id of the credential this browser holds the same way and drops a push
 * addressed to anyone else (public/liaison-sw.js, `userTagOf`).
 */
export function webPushUserTag(userId: string): string {
  return createHash("sha256").update(`liaison-push-user:${userId}`).digest("hex")
}

/** A Web Push body: the frame plus its recipient marker. */
export function webPushBody(userId: string, frame: object): string {
  return JSON.stringify({ ...frame, userTag: webPushUserTag(userId) })
}

const PUSH_SEND_TIMEOUT_MS = 15_000

/** The production wire: `web-push` with the configured VAPID keys. */
export const defaultWebPushSend: WebPushSend = async (target, body) => {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim()
  const privateKey = env.VAPID_PRIVATE_KEY?.trim()
  const subject = env.VAPID_SUBJECT?.trim()
  if (!publicKey || !privateKey || !subject) {
    if (!disabledNoticed) {
      disabledNoticed = true
      log.warn("web push disabled: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT")
    }
    return { status: 0 }
  }
  try {
    // The endpoint is user-supplied, so the request is built by `web-push`
    // (VAPID + payload encryption) but SENT through the SSRF guard: https only,
    // DNS pinned, private/internal targets refused, no redirects followed.
    const details = webpush.generateRequestDetails(target, body, {
      vapidDetails: { subject, publicKey, privateKey },
      TTL: 60 * 60,
      urgency: "high",
    })
    const res = await fetchWithPinnedHost(
      details.endpoint,
      {
        method: details.method,
        headers: details.headers as Record<string, string>,
        body: details.body,
        signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
      },
      { requireHttps: true, maxRedirects: 0 },
    )
    await res.body?.cancel().catch(() => undefined)
    return { status: res.status }
  } catch (err) {
    const status = (err as { statusCode?: unknown }).statusCode
    if (typeof status === "number") return { status }
    log.warn({ err }, "web push send failed")
    return { status: 0 }
  }
}

export interface WebPushSubscriptionRow {
  deviceId: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * The user's browsers that hold a live Web Push subscription. `db` is the
 * user's own RLS client when the caller has one (browser_push_subscriptions_owner
 * admits exactly these rows); without it (the fan-out, off the outbox, with no
 * actor) the read is privileged and bound to (org_id, user_id).
 */
export async function loadWebPushSubscriptions(
  orgId: string,
  userId: string,
  db?: RlsClient,
): Promise<WebPushSubscriptionRow[]> {
  const read = (tx: RlsClient | PrivilegedDb) =>
    tx
      .select({
        deviceId: browserPushSubscriptions.deviceId,
        endpoint: browserPushSubscriptions.endpoint,
        p256dh: browserPushSubscriptions.p256dh,
        auth: browserPushSubscriptions.auth,
      })
      .from(browserPushSubscriptions)
      .where(
        and(
          eq(browserPushSubscriptions.orgId, orgId),
          eq(browserPushSubscriptions.userId, userId),
          isNotNull(browserPushSubscriptions.endpoint),
        ),
      )
  const rows = db ? await read(db) : await withPrivilegedDb(orgId, "web-push-subscriptions", read)
  return rows.filter(
    (r): r is WebPushSubscriptionRow => r.endpoint !== null && r.p256dh !== null && r.auth !== null,
  )
}

/** The push service said the subscription is gone (404/410): forget it. */
async function expireWebPushSubscription(
  orgId: string,
  userId: string,
  deviceId: string,
): Promise<void> {
  await withPrivilegedDb(orgId, "web-push-expire", (tx) =>
    tx
      .update(browserPushSubscriptions)
      .set({ endpoint: null, p256dh: null, auth: null })
      .where(
        and(
          eq(browserPushSubscriptions.orgId, orgId),
          eq(browserPushSubscriptions.userId, userId),
          eq(browserPushSubscriptions.deviceId, deviceId),
        ),
      ),
  )
}

/** One send's outcome, as the delivery log records it. */
export interface WebPushOutcome {
  ok: boolean
  /** The push service's HTTP status (0 = not sent). */
  status: number
  /** Null when accepted; `expired`, `not_sent` or `http_<status>` otherwise. */
  reason: string | null
}

/**
 * Send `body` to one stored subscription. Never throws: a send that throws
 * reads as `not_sent`. A 404 or 410 expires the subscription.
 */
export async function sendWebPushTo(
  orgId: string,
  userId: string,
  sub: WebPushSubscriptionRow,
  body: string,
  send: WebPushSend = defaultWebPushSend,
): Promise<WebPushOutcome> {
  let status = 0
  try {
    status = (
      await send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body)
    ).status
  } catch (err) {
    log.warn({ err, deviceId: sub.deviceId }, "web push send threw")
  }
  const ok = status >= 200 && status < 300
  const expired = status === 404 || status === 410
  if (expired) await expireWebPushSubscription(orgId, userId, sub.deviceId)
  const reason = ok ? null : expired ? "expired" : status === 0 ? "not_sent" : `http_${status}`
  return { ok, status, reason }
}
