// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE BROWSER AS A NOTIFICATION DEVICE (S5, A6, A7, A12, F1).
//
// A browser profile is one device: its id is the one the WS hello sends
// (createWebSocket `notificationDeviceId`, shared by its tabs and its service
// worker). It registers through POST /api/notifications/browser-subscriptions
// and gets a receipt-only credential back, kept in IndexedDB
// (device-credential.ts) for the in-tab handler and the service worker.
//
//   - Without the notification permission it registers the device alone, so
//     in-tab notifications can post receipts.
//   - With the permission it also registers the service worker
//     (public/liaison-sw.js) and a Web Push subscription made with the
//     server's VAPID key (GET /api/notifications/web-push/config).
//
// ONLY IN A REAL BROWSER. The same bundle runs in the Tauri desktop shell and
// the Capacitor phone shell; neither gets a service worker or a Web Push
// subscription (the desktop app has its own channel, the phone has APNs).
// `isRealBrowser()` is that guard, and every entry point checks it first.
//
// Nothing here throws: a refused permission, a missing API or a server
// without VAPID keys costs Web Push, never the page.

import type { ApiClient } from "~/lib/api-client"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { apiUrl, serverAddressOverride } from "~/lib/env"
import { isNativeShell } from "~/lib/native-bridge"
import { onAuthCleared } from "~/modules/auth/auth-store"
import { isDesktop } from "~/modules/desktop/desktop-store"
import { base64ToBytes } from "~/modules/mailbox/mailbox-bytes"
import { DEVICE_ID_KEY, notificationDeviceId } from "~/primitives/createWebSocket"
import {
  type BrowserDeviceRecord,
  clearBrowserDevice,
  readBrowserDevice,
  writeBrowserDevice,
} from "./device-credential"

/** The service worker script (apps/web/public), registered at the root scope. */
export const SW_URL = "/liaison-sw.js"

const READY_TIMEOUT_MS = 10_000

/**
 * True only in a real browser that can run a service worker and Web Push:
 * never in the Tauri or Capacitor webviews (A12), whose markers are checked
 * several ways because one late-published bridge must not let a shell through.
 */
export function isRealBrowser(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false
  if (getDesktopBridge() !== null || isDesktop()) return false
  if (isNativeShell()) return false
  // Both shells inject the server address; a browser never has one.
  if (serverAddressOverride() !== null) return false
  const g = globalThis as Record<string, unknown>
  if (g.__TAURI_INTERNALS__ !== undefined || g.__TAURI__ !== undefined) return false
  if (g.Capacitor !== undefined) return false
  const protocol = window.location?.protocol
  if (protocol !== "https:" && protocol !== "http:") return false
  if (!window.isSecureContext) return false
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) return false
  if (typeof g.PushManager !== "function") return false
  if (typeof g.Notification !== "function") return false
  return true
}

function permission(): NotificationPermission {
  try {
    return Notification.permission
  } catch {
    return "default"
  }
}

function receiptsUrl(): string {
  return new URL(apiUrl("/notifications/receipts"), window.location.href).href
}

/** The VAPID public key (base64url) as the bytes PushManager.subscribe wants. */
export function vapidKeyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64url}${"=".repeat((4 - (base64url.length % 4)) % 4)}`
  return base64ToBytes(padded.replace(/-/g, "+").replace(/_/g, "/"))
}

interface SubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

function subscriptionJson(sub: PushSubscription): SubscriptionJson | null {
  const json = sub.toJSON() as Partial<SubscriptionJson>
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return null
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  await navigator.serviceWorker.register(SW_URL, { scope: "/" })
  // subscribe() needs an ACTIVE worker, which `ready` waits for.
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), READY_TIMEOUT_MS)),
  ])
}

type PushOutcome = { sub: SubscriptionJson } | "no_key" | "failed"

/** Register the worker and reuse or make a Web Push subscription. */
async function ensurePushSubscription(api: ApiClient): Promise<PushOutcome> {
  try {
    const reg = await readyRegistration()
    if (!reg) return "failed"
    const existing = await reg.pushManager.getSubscription()
    if (existing) {
      const json = subscriptionJson(existing)
      if (json) return { sub: json }
    }
    const config = await api.get<{ publicKey: string | null }>("/notifications/web-push/config")
    if (!config?.publicKey) return "no_key"
    const made = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKeyBytes(config.publicKey),
    })
    const json = subscriptionJson(made)
    return json ? { sub: json } : "failed"
  } catch {
    return "failed"
  }
}

/** The session the last registration ran under, to re-register on a 401. */
let session: { api: ApiClient; userId: string } | null = null

/** The local cleanup in flight, which a new registration waits for. */
let forgetting: Promise<void> = Promise.resolve()

/**
 * POST the device (and its subscription, when given) and keep the answered
 * credential. `sub` undefined keeps whatever subscription the server holds.
 */
async function register(
  api: ApiClient,
  userId: string,
  deviceId: string,
  sub: SubscriptionJson | undefined,
  keepEndpoint: string | null,
): Promise<BrowserDeviceRecord | null> {
  try {
    const body: Record<string, unknown> = { deviceId, userAgent: navigator.userAgent.slice(0, 512) }
    if (sub) body.subscription = sub
    const res = await api.post<{ deviceId: string; receiptCredential: string }>(
      "/notifications/browser-subscriptions",
      body,
    )
    if (!res?.receiptCredential) return null
    const url = receiptsUrl()
    const rec: BrowserDeviceRecord = {
      deviceId,
      credential: res.receiptCredential,
      userId,
      serverOrigin: new URL(url).origin,
      receiptsUrl: url,
      endpoint: sub ? sub.endpoint : keepEndpoint,
    }
    await writeBrowserDevice(rec)
    return rec
  } catch {
    return null
  }
}

/**
 * At sign-in / shell start: make sure this browser is a registered device of
 * `userId`, with its Web Push subscription when the permission is already
 * granted. Registers again only when something changed (no credential,
 * another user, another server, a new endpoint). Null outside a real browser.
 */
export async function ensureBrowserDevice(
  api: ApiClient,
  userId: string,
): Promise<BrowserDeviceRecord | null> {
  if (!isRealBrowser()) return null
  session = { api, userId }
  await forgetting
  const deviceId = notificationDeviceId()
  if (!deviceId) return null
  // Another account (or another server) on this browser: the subscription and
  // credential left behind are someone else's, never reused (fix2-F1). The
  // device id stays: this page's WebSocket already said hello with it.
  const origin = new URL(receiptsUrl()).origin
  const prior = await readBrowserDevice()
  if (prior !== null && (prior.userId !== userId || prior.serverOrigin !== origin)) {
    await dropLocalDevice()
  }
  const push = permission() === "granted" ? await ensurePushSubscription(api) : null
  const sub = push && typeof push === "object" ? push.sub : undefined
  const rec = await readBrowserDevice()
  const current =
    rec !== null &&
    rec.userId === userId &&
    rec.deviceId === deviceId &&
    rec.serverOrigin === origin &&
    (sub === undefined || rec.endpoint === sub.endpoint)
  if (current) return rec
  return register(api, userId, deviceId, sub, null)
}

export type EnableResult = "enabled" | "denied" | "unsupported" | "unavailable" | "failed"

/**
 * "Turn on browser notifications": from a click (the permission prompt needs a
 * user gesture), ask the permission, subscribe, register. `unavailable` is a
 * server without VAPID keys.
 */
export async function enableBrowserPush(api: ApiClient, userId: string): Promise<EnableResult> {
  if (!isRealBrowser()) return "unsupported"
  session = { api, userId }
  await forgetting
  let granted: NotificationPermission
  try {
    granted = await Notification.requestPermission()
  } catch {
    granted = permission()
  }
  if (granted !== "granted") return "denied"
  const deviceId = notificationDeviceId()
  if (!deviceId) return "failed"
  const push = await ensurePushSubscription(api)
  if (push === "no_key") {
    await register(api, userId, deviceId, undefined, null)
    return "unavailable"
  }
  if (push === "failed") return "failed"
  return (await register(api, userId, deviceId, push.sub, null)) ? "enabled" : "failed"
}

export interface BrowserReceipt {
  notificationId: string
  surface: "browser_tab" | "browser_push"
  outcome: "shown" | "suppressed"
  reason?: string
}

async function send(rec: BrowserDeviceRecord, input: BrowserReceipt): Promise<Response | null> {
  try {
    return await fetch(rec.receiptsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${rec.credential}` },
      body: JSON.stringify({
        notificationId: input.notificationId,
        deviceId: rec.deviceId,
        surface: input.surface,
        appState: typeof document !== "undefined" ? document.visibilityState : undefined,
        outcome: input.outcome,
        ...(input.reason ? { reason: input.reason } : {}),
      }),
    })
  } catch {
    return null
  }
}

/**
 * One receipt from this browser, with the device credential (never the
 * session). A 401 (rotated or revoked credential) re-registers once under the
 * current session and retries. False when nothing was recorded.
 */
/** Wait before re-posting a receipt that beat its delivery row (404). */
export const RECEIPT_RETRY_MS = 1500

export async function postBrowserReceipt(input: BrowserReceipt): Promise<boolean> {
  const rec = await readBrowserDevice()
  if (!rec) return false
  let res = await send(rec, input)
  // The server writes the delivery row just after handing the frame over, so an
  // instant answer can arrive first and read 404: one later retry lands it.
  if (res?.status === 404) {
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_RETRY_MS))
    res = await send(rec, input)
  }
  if (res?.status === 401 && session && session.userId === rec.userId) {
    const fresh = await register(session.api, session.userId, rec.deviceId, undefined, rec.endpoint)
    if (!fresh) return false
    return (await send(fresh, input))?.ok ?? false
  }
  return res?.ok ?? false
}

/**
 * Sign-out in a browser: the server forgets this device (subscription and
 * credential), the push service drops the subscription, and the credential
 * leaves IndexedDB, so a signed-out browser neither receives nor receipts the
 * previous user's notifications. Runs BEFORE the session ends (it needs it).
 */
export async function signOutBrowserDevice(sessionToken: string | null): Promise<void> {
  if (!isRealBrowser()) return
  session = null
  const rec = await readBrowserDevice()
  let deviceId: string | null = rec?.deviceId ?? null
  if (!deviceId) {
    try {
      deviceId = localStorage.getItem(DEVICE_ID_KEY)
    } catch {
      deviceId = null
    }
  }
  if (deviceId && sessionToken) {
    try {
      await fetch(apiUrl(`/notifications/browser-subscriptions/${encodeURIComponent(deviceId)}`), {
        method: "DELETE",
        credentials: "include",
        headers: { Authorization: `Bearer ${sessionToken}` },
      })
    } catch {
      // The server keeps the row; its credential still dies with the session.
    }
  }
  await dropLocalDevice()
}

/** Unsubscribe this browser's Web Push and delete its stored credential. */
async function dropLocalDevice(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration?.()
    const sub = await reg?.pushManager.getSubscription()
    await sub?.unsubscribe()
  } catch {
    // Best effort: the server gives the endpoint to its next owner anyway.
  }
  await clearBrowserDevice()
}

/**
 * EVERY END OF A SESSION, local half (fix2-F1): a rejected refresh token or a
 * failed restore ends the session without the sign-out button, and without a
 * session to tell the server with. So the browser forgets on its own: Web Push
 * unsubscribed, credential and device id deleted. The server half (A's row
 * losing the endpoint) happens when the next user registers it.
 */
export function forgetBrowserDevice(): Promise<void> {
  if (!isRealBrowser()) return Promise.resolve()
  session = null
  try {
    localStorage.removeItem(DEVICE_ID_KEY)
  } catch {
    // No storage: no device id to forget.
  }
  forgetting = forgetting.then(dropLocalDevice, dropLocalDevice)
  return forgetting
}

onAuthCleared(() => {
  void forgetBrowserDevice()
})

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const BrowserPushTestAccess = {
  /** Forget the remembered session. */
  reset(): void {
    session = null
  },
}
