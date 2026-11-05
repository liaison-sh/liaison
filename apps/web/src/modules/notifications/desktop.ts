// SPDX-License-Identifier: FSL-1.1-ALv2
// Desktop (OS-level) notifications, driven by the server (S5, S6).
//
// The server decides: for each item and user it sends one `notify` realtime
// frame to the chosen connections only (every desktop app, else the one
// browser tab the user touched last, never a phone). This module never
// re-decides; it checks the OS permission and raises through the bridge
// (native-bridge.ts: the desktop app's plugin, else the browser Notification).
//
// What it tells the server: the client kind in the hello and, in the 30 s
// heartbeat, when the user last touched this window. The old per-browser
// localStorage switch is gone: the grid's desktop column is the switch, and
// the OS permission stays per device.

import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { isNativeShell } from "~/lib/native-bridge"
import { isDesktop } from "~/modules/desktop/desktop-store"
import { replyRootOfRoute, threadOfRoute } from "~/modules/notifications/thread-on-screen"
import { type BrowserReceipt, postBrowserReceipt } from "./browser-push"
import { postDesktopReceipt } from "./desktop-device"
import {
  desktopNotificationPermission,
  raiseDesktopNotification,
  requestDesktopNotificationPermission,
} from "./native-bridge"
import { offerShellNotificationRoute, openNotificationRoute } from "./open-route"

const BANNER_DISMISSED_KEY = "liaison:desktop-notifications-banner-dismissed"

function hasNotificationApi(): boolean {
  return typeof window !== "undefined" && "Notification" in window
}

/** Whether the browser exposes the Notification API at all (Safari private mode / http origins do not). */
export function isSupported(): boolean {
  return hasNotificationApi()
}

/** Enabled means the OS/browser permission is granted; the grid decides what reaches it. */
export function isEnabled(): boolean {
  return hasNotificationApi() && Notification.permission === "granted"
}

/** Must be called from a click handler: the permission request needs a user gesture. */
export async function enable(): Promise<boolean> {
  return (await requestDesktopNotificationPermission()) === "granted"
}

/** "blocked by browser" vs "not yet decided" vs "granted": drives the Settings display state. */
export function permissionState(): NotificationPermission | "unsupported" {
  if (!hasNotificationApi()) return "unsupported"
  return Notification.permission
}

export type ClientKind = "desktop_app" | "browser" | "mobile_app"

/** What this window announces in its realtime hello (S6). */
export function clientKind(): ClientKind {
  if (isDesktop()) return "desktop_app"
  if (isNativeShell()) return "mobile_app"
  return "browser"
}

let lastActive = Date.now()

/** When the user last touched this window (ms), sent with the hello and the heartbeat. */
export function lastActiveAt(): number {
  return lastActive
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const DesktopNotificationsTestAccess = {
  /** Set the activity clock. */
  setLastActiveAt(value: number): void {
    lastActive = value
  },
}

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "focus"] as const
const ACTIVE_REPORT_THROTTLE_MS = 10_000

/**
 * Tracks user activity in this window. `onBecameActive` runs (at most every
 * 10 s) when the user comes back to it, so the server learns about a switch
 * of tab before the next heartbeat. Returns the uninstaller.
 */
export function installActivityTracking(onBecameActive?: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  let lastReport = 0
  const mark = () => {
    lastActive = Date.now()
    if (onBecameActive && lastActive - lastReport >= ACTIVE_REPORT_THROTTLE_MS) {
      lastReport = lastActive
      onBecameActive()
    }
  }
  const onVisibility = () => {
    if (document.visibilityState === "visible") mark()
  }
  for (const e of ACTIVITY_EVENTS) window.addEventListener(e, mark, { passive: true })
  document.addEventListener("visibilitychange", onVisibility)
  return () => {
    for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, mark)
    document.removeEventListener("visibilitychange", onVisibility)
  }
}

export interface NotifyFrame {
  type: "notify"
  notifyId: string
  /** The server's id for this delivery (S1): receipts name it. */
  notificationId?: string
  group: string
  title: string
  body: string
  route: string
  urgent: boolean
  /** The conversation (OS tag): a newer notification of it replaces the older. */
  tag?: string
}

/**
 * The `notify` frame handler: the server already chose this window, so what
 * is left is the OS permission, and one thing only the page knows: a message
 * notice for the conversation the user is looking at is redundant (they are
 * reading it), so it is not raised. `threadOnScreen` is that answer; every
 * other conversation still notifies. Never throws (it runs in the WS dispatch
 * chain).
 */
export async function handleNotifyFrame(
  frame: Partial<NotifyFrame>,
  threadOnScreen: () => string | readonly string[] | null = () => null,
): Promise<boolean> {
  if (typeof frame?.notifyId !== "string" || typeof frame.title !== "string") return false
  // Receipts (S1, A5): a browser tab reports what it did with the frame under
  // the browser device's credential (T4); the desktop app reports after its
  // OS notification call under its install's credential (T6). A phone never
  // gets a `notify` frame.
  const notificationId = frame.notificationId
  const kind = clientKind()
  const report = (outcome: BrowserReceipt["outcome"], reason?: string): void => {
    if (typeof notificationId !== "string") return
    if (kind === "browser") {
      void postBrowserReceipt({
        notificationId,
        surface: "browser_tab",
        outcome,
        ...(reason ? { reason } : {}),
      })
    } else if (kind === "desktop_app") {
      void postDesktopReceipt({ notificationId, outcome, ...(reason ? { reason } : {}) })
    }
  }
  try {
    const onScreen = threadOnScreen()
    // A reply's notice is also on screen when its reply pane is. (Its route
    // does not say whether the channel shows the reply too, so the channel
    // on screen still counts, as before; the server keys device pushes on
    // the reply root precisely.)
    const visible = onScreen === null ? [] : typeof onScreen === "string" ? [onScreen] : onScreen
    const routed = [threadOfRoute(frame.route), replyRootOfRoute(frame.route)]
    if (routed.some((id) => id !== null && visible.includes(id))) {
      report("suppressed", "on_screen")
      return false
    }
    if ((await desktopNotificationPermission()) !== "granted") {
      report("suppressed", "os_permission_denied")
      return false
    }
    // LIF-18: the click opens what the notification is about. A browser
    // notification reports its click here; a shell that hears its own
    // (macOS) hands it to open-route.ts through `onNotificationClick`; only
    // where the shell hears none does the page offer the item itself.
    const route = typeof frame.route === "string" && frame.route.length > 0 ? frame.route : null
    const shell = getDesktopBridge()
    const viaShell = typeof shell?.raiseNotification === "function"
    const shown = await raiseDesktopNotification(
      {
        title: frame.title,
        body: typeof frame.body === "string" ? frame.body : "",
        // One notification per conversation: the newer replaces the older.
        tag: typeof frame.tag === "string" && frame.tag.length > 0 ? frame.tag : frame.notifyId,
        ...(route ? { route } : {}),
        // Direct messages and mentions play the system's sound; the rest are silent.
        ...(frame.group === "direct" ? { sound: true } : {}),
      },
      route ? { onClick: () => void openNotificationRoute(route) } : {},
    )
    if (shown && route && viaShell && !(await shellReportsClicks(shell))) {
      offerShellNotificationRoute(route, frame.title)
    }
    report(shown ? "shown" : "suppressed", shown ? undefined : "raise_failed")
    return shown
  } catch {
    return false
  }
}

/** Whether the shell reports a click on its notifications itself (LIF-18). */
async function shellReportsClicks(shell: ReturnType<typeof getDesktopBridge>): Promise<boolean> {
  try {
    return (await shell?.notificationClickSupport?.()) === true
  } catch {
    return false
  }
}

export function isBannerDismissed(): boolean {
  try {
    return localStorage.getItem(BANNER_DISMISSED_KEY) === "1"
  } catch {
    return false
  }
}

export function dismissBanner(): void {
  try {
    localStorage.setItem(BANNER_DISMISSED_KEY, "1")
  } catch {
    // Best-effort.
  }
}
