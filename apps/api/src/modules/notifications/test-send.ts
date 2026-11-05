// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Send me a test" (S6, A4): one test notification to EVERY device of the
 * caller, individually, each under its own notificationId, so the Settings
 * view can poll a receipt per device.
 *
 * By design it bypasses the grid and quiet time and is not subject to the
 * computer-channel precedence (D13/A6): each iOS token gets an APNs push, each
 * desktop app (live connection or registered install) a `notify` frame, each
 * Web Push subscription a push, and the browser's most recent live tab a
 * frame. Every attempt is logged under channel `test`, so the receipt endpoint
 * accepts the device's receipt and the computer replay never picks it up.
 */
import { and, eq } from "drizzle-orm"
import { type UserContext, withRlsContext } from "~/db/rls"
import { type DeliveryResult, desktopDevices, pushTokens } from "~/db/schema/kernel"
import {
  getWsManager,
  type NotifyFrame,
  type NotifyPresenceEntry,
  selectNotifyTargets,
  type WebSocketManager,
} from "~/infra/websocket"
import { serverT } from "~/modules/i18n/server-i18n"
import { computeBadgeCount } from "~/modules/push/badge-count"
import { recipientLocale } from "~/modules/push/fanout-consumer"
import { orgLabel } from "~/modules/push/org-label"
import { sendPush as defaultSendPush } from "~/modules/push/sender"
import type { PushPayload, PushSendResult, PushTokenRow } from "~/modules/push/types"
import {
  loadWebPushSubscriptions,
  sendWebPushTo,
  type WebPushSend,
  webPushBody,
} from "~/modules/push/web-push"
import { type DeliveryRecord, recordDeliveries } from "./delivery-log"
import { notificationIdFor } from "./router"

export interface TestSendDeps {
  manager?: WebSocketManager | null
  sendPush?: (token: PushTokenRow, payload: PushPayload) => Promise<PushSendResult>
  webPush?: WebPushSend
}

let overrides: TestSendDeps = {}

/** Test seam: the route reads its wires from here. Production code never calls it. */
export const TestSendTestAccess = {
  setDeps(deps: TestSendDeps): void {
    overrides = deps
  },
  reset(): void {
    overrides = {}
  },
}

export type TestSendSurface = "ios" | "android" | "desktop" | "browser_tab" | "browser_push"

export interface TestSendLine {
  deviceId: string | null
  surface: TestSendSurface
  notificationId: string
  result: DeliveryResult
  reason: string | null
}

export interface TestSendResult {
  runId: string
  devices: TestSendLine[]
}

/** The copy of the test banner, in the recipient's language (shared i18n catalog). */
async function copyFor(orgId: string, userId: string): Promise<{ title: string; body: string }> {
  // The org default lives on kernel.organizations, which liaison_rls cannot
  // read: the push fan-out's own lookup (bound to org_id and user_id) answers it.
  const locale = await recipientLocale(orgId, userId)
  return {
    title: serverT(locale, "kernel.notifications.test.title"),
    body: serverT(locale, "kernel.notifications.test.body"),
  }
}

/**
 * Send one test notification to every device of the caller. Never throws per
 * device. The caller's own devices are read under the caller's RLS context:
 * push_tokens, desktop_devices and browser_push_subscriptions all admit
 * exactly (org_id, user_id)'s rows.
 */
export async function sendTestNotification(
  actor: UserContext,
  deps: TestSendDeps = overrides,
): Promise<TestSendResult> {
  const { orgId, userId } = actor
  const runId = crypto.randomUUID()
  const copy = await copyFor(orgId, userId)
  const lines: TestSendLine[] = []
  const idFor = (surface: string, deviceId: string | null) =>
    notificationIdFor(userId, `test:${runId}:${surface}:${deviceId ?? "none"}`)
  // Each device's delivery row is written as soon as its send returns: a fast
  // device (a phone's extension, a tab) receipts within a second, and a receipt
  // for a notification with no delivery row is refused 404 (walk 2026-10-08:
  // the rows were written after the last device and the iPhone never confirmed).
  const log = async (
    surface: TestSendSurface,
    deviceId: string | null,
    notificationId: string,
    result: DeliveryResult,
    extra: { reason?: string | null; providerStatus?: number | null; payload?: unknown } = {},
  ): Promise<void> => {
    lines.push({ deviceId, surface, notificationId, result, reason: extra.reason ?? null })
    const record: DeliveryRecord = {
      orgId,
      userId,
      notificationId,
      channel: "test",
      deviceId,
      surface,
      result,
      reason: extra.reason ?? null,
      providerStatus: extra.providerStatus ?? null,
      ...(extra.payload !== undefined ? { payload: extra.payload } : {}),
    }
    await recordDeliveries([record])
  }

  // iOS (and Android) tokens: one APNs/FCM push each.
  const tokens = await withRlsContext(actor, (tx) =>
    tx
      .select({
        id: pushTokens.id,
        platform: pushTokens.platform,
        token: pushTokens.token,
        environment: pushTokens.environment,
        multiServer: pushTokens.multiServer,
      })
      .from(pushTokens)
      .where(and(eq(pushTokens.orgId, orgId), eq(pushTokens.userId, userId))),
  )
  if (tokens.length > 0) {
    const badge = await computeBadgeCount(userId, orgId).catch(() => 0)
    const send = deps.sendPush ?? ((t: PushTokenRow, p: PushPayload) => defaultSendPush(t, p))
    const serverLabel = await orgLabel(orgId).catch(() => undefined)
    for (const token of tokens) {
      const notificationId = idFor(token.platform, token.id)
      const payload: PushPayload = {
        type: "attention",
        threadId: "",
        deepLink: "liaison://attention",
        badgeCount: badge,
        title: copy.title,
        body: copy.body,
        notificationId,
        ...(serverLabel ? { serverLabel } : {}),
      }
      let result: PushSendResult
      try {
        result = await send(token, payload)
      } catch (err) {
        result = { kind: "transient", detail: String(err) }
      }
      const status = result.hosts?.at(-1)?.status ?? null
      await log(
        token.platform,
        token.id,
        notificationId,
        result.kind === "sent" ? "accepted" : "rejected",
        {
          reason:
            result.kind === "sent"
              ? null
              : `${result.kind}${result.detail ? `: ${result.detail}` : ""}`,
          providerStatus: status,
          payload,
        },
      )
    }
  }

  // Computer: every live desktop app connection, every registered install not
  // live, and the browser's most recent tab. Precedence does not apply.
  const manager = deps.manager === undefined ? getWsManager() : deps.manager
  const entries: NotifyPresenceEntry[] = manager
    ? await manager.listNotifyPresence(orgId, userId)
    : []
  const frameFor = (
    notificationId: string,
    surface: string,
    deviceId: string | null,
  ): NotifyFrame => ({
    type: "notify",
    notifyId: `test:${runId}:${surface}:${deviceId ?? "none"}`,
    notificationId,
    group: "system",
    title: copy.title,
    body: copy.body,
    route: "settings/notifications",
    urgent: false,
  })
  const liveDesktops = entries.filter((e) => e.kind === "desktop_app")
  const tabs = selectNotifyTargets(entries.filter((e) => e.kind === "browser"))
  for (const target of [...liveDesktops, ...tabs]) {
    const surface: TestSendSurface = target.kind === "desktop_app" ? "desktop" : "browser_tab"
    const deviceId = target.deviceId ?? null
    const notificationId = idFor(`${surface}:${target.connId}`, deviceId)
    const frame = frameFor(notificationId, surface, deviceId)
    const [ok] = manager ? await manager.sendNotifyEach([target], frame) : [false]
    await log(surface, deviceId, notificationId, ok ? "accepted" : "no_connection", {
      payload: frame,
    })
  }
  const liveIds = new Set(liveDesktops.map((e) => e.deviceId).filter(Boolean))
  const installs = await withRlsContext(actor, (tx) =>
    tx
      .select({ deviceId: desktopDevices.deviceId })
      .from(desktopDevices)
      .where(and(eq(desktopDevices.orgId, orgId), eq(desktopDevices.userId, userId))),
  )
  for (const install of installs) {
    if (liveIds.has(install.deviceId)) continue
    await log("desktop", install.deviceId, idFor("desktop", install.deviceId), "no_connection")
  }

  // Every Web Push subscription.
  const subs = await withRlsContext(actor, (tx) => loadWebPushSubscriptions(orgId, userId, tx))
  for (const sub of subs) {
    const notificationId = idFor("browser_push", sub.deviceId)
    const frame = frameFor(notificationId, "browser_push", sub.deviceId)
    const { ok, status, reason } = await sendWebPushTo(
      orgId,
      userId,
      sub,
      webPushBody(userId, frame),
      deps.webPush,
    )
    await log("browser_push", sub.deviceId, notificationId, ok ? "accepted" : "rejected", {
      reason,
      providerStatus: status || null,
      payload: frame,
    })
  }

  return { runId, devices: lines }
}
