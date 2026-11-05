// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE WAY TO RAISE AN OS NOTIFICATION, wherever the page runs (S7).
//
// In the desktop app the shell raises it through its notification plugin
// (`raiseNotification` on the desktop bridge), which shows it with the window
// hidden or minimised too. Everywhere else, and in a shell too old to offer
// the plugin, it is the browser's `Notification`. A browser notification's
// click brings the window to the front and runs the caller's `onClick` (the
// item opens, LIF-18). The desktop plugin reports no click, so the caller
// offers the item in the page instead (open-route.ts).
//
// Nothing here throws: a missing API, a refused permission or a broken shell
// answers false or "unsupported", and the in-app feed still has the item.

import { type DesktopNotification, getDesktopBridge } from "~/lib/desktop-shell-contract"
import { replyRootOfRoute, threadOfRoute } from "~/modules/notifications/thread-on-screen"

export type NotificationPermissionState = "granted" | "denied" | "default" | "unsupported"

function browserNotification(): typeof Notification | null {
  if (typeof window === "undefined") return null
  const api = (window as unknown as { Notification?: typeof Notification }).Notification
  return typeof api === "function" ? api : null
}

/** The browser notifications this page raised and has not seen closed, by tag, with their route. */
const raisedByTag = new Map<string, { raised: Notification; route: string | null }>()

export interface RaiseOptions {
  /** A click on a browser notification (after the window is focused). */
  onClick?: () => void
}

export async function raiseDesktopNotification(
  notification: DesktopNotification,
  options: RaiseOptions = {},
): Promise<boolean> {
  const shell = getDesktopBridge()
  if (shell?.raiseNotification) {
    try {
      return await shell.raiseNotification(notification)
    } catch {
      return false
    }
  }
  const api = browserNotification()
  if (api?.permission !== "granted") return false
  try {
    // `renotify`: a notification that replaces one with the same tag (the
    // same conversation) still alerts. Not in TypeScript's DOM types yet.
    const init: NotificationOptions & { renotify?: boolean } = {
      body: notification.body,
      tag: notification.tag,
      renotify: true,
    }
    const raised = new api(notification.title, init)
    if (notification.tag) {
      raisedByTag.set(notification.tag, { raised, route: notification.route ?? null })
      raised.onclose = () => {
        if (raisedByTag.get(notification.tag ?? "")?.raised === raised)
          raisedByTag.delete(notification.tag ?? "")
      }
    }
    raised.onclick = () => {
      window.focus()
      raised.close?.()
      options.onClick?.()
    }
    return true
  } catch {
    // The constructor throws on some user agents even with the permission
    // granted (Chrome for Android: "Illegal constructor").
    return false
  }
}

export async function desktopNotificationPermission(): Promise<NotificationPermissionState> {
  const shell = getDesktopBridge()
  if (shell?.notificationPermission) {
    try {
      return await shell.notificationPermission()
    } catch {
      return "default"
    }
  }
  const api = browserNotification()
  return api ? api.permission : "unsupported"
}

/** From a click: the browser refuses a request made without a user gesture. */
export async function requestDesktopNotificationPermission(): Promise<NotificationPermissionState> {
  const shell = getDesktopBridge()
  if (shell?.requestNotificationPermission) {
    try {
      return await shell.requestNotificationPermission()
    } catch {
      return "default"
    }
  }
  const api = browserNotification()
  if (!api) return "unsupported"
  try {
    return await api.requestPermission()
  } catch {
    return api.permission
  }
}

/**
 * RULE 5, READ ONCE, READ EVERYWHERE: what was read on any device leaves this
 * computer. Closes the browser notifications this page raised and the Web Push
 * ones the service worker shows, judged by the route each carries, never by
 * its tag (a reply is tagged with its channel): a channel read
 * (`replyRootId` absent) closes the channel's own notifications
 * (`thread/<id>`) and none of its replies'; a reply thread's read closes that
 * root's (`thread/<id>?replyRoot=<root>`). A notification whose route is
 * unknown, or names an entity rather than the thread, stays. The desktop
 * app's own notifications (the shell's notification center) stay until the
 * shell offers a call to withdraw them. Never throws.
 */
function readRouteMatches(route: unknown, threadId: string, replyRootId?: string): boolean {
  if (typeof route !== "string" || !/^\/?threads?\//.test(route)) return false
  if (threadOfRoute(route) !== threadId) return false
  const root = replyRootOfRoute(route)
  return replyRootId ? root === replyRootId : root === null
}

export async function withdrawThreadNotifications(
  threadId: string,
  replyRootId?: string,
): Promise<number> {
  let closed = 0
  for (const [tag, { raised, route }] of [...raisedByTag]) {
    if (!readRouteMatches(route, threadId, replyRootId)) continue
    raisedByTag.delete(tag)
    try {
      raised.close()
      closed += 1
    } catch {
      // Already gone.
    }
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration?.()
    const shown = (await registration?.getNotifications?.()) ?? []
    for (const n of shown) {
      const route = (n.data as { route?: unknown } | null)?.route
      if (!readRouteMatches(route, threadId, replyRootId)) continue
      n.close()
      closed += 1
    }
  } catch {
    // No service worker here (the desktop app, a private window): nothing shown by it.
  }
  return closed
}

/** Test access to this module's private state. Production code never calls it. */
export const NativeBridgeTestAccess = {
  reset(): void {
    raisedByTag.clear()
  },
}
