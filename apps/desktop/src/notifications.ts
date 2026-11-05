// SPDX-License-Identifier: FSL-1.1-ALv2
//
// NATIVE NOTIFICATIONS (S7, P1-T6), the shell's half.
//
// RAISING goes through the shell's own `raise_notification`
// (src-tauri/src/desktop_notifications.rs): on a bundled macOS app it raises
// through UNUserNotificationCenter with the item's route in the notification,
// elsewhere through `tauri-plugin-notification` from Rust. The window is
// granted none of the plugin's commands (capabilities/default.json). Commands
// are invoked by name: `src/tauri.ts` is the one module that may import a
// Tauri package.
//
// A CLICK (LIF-18): where the shell hears one (`notification_click_support`,
// macOS bundled), it brings the window forward, keeps the route and emits
// `liaison://notification-click`; the page takes the route with
// `take_notification_click` on that event and once when it starts listening,
// which is how a click that launched the app still opens its item.
//
// THE PERMISSION does NOT: on a desktop the plugin answers "granted" to both of
// its permission commands whatever the OS settings say (read from its source,
// 2.5.0 `src/desktop.rs`). The server routes computer notifications to this
// app only while it reports `granted` (A6), so the shell asks the system
// itself (src-tauri/src/desktop_notifications.rs: UNUserNotificationCenter on
// macOS), answers `granted` | `denied` | `not_determined`, and emits
// `liaison://notification-permission` when the system setting moves.
//
// THE DEVICE: the install id the shell published before the page loaded
// (src-tauri/src/notification_device.rs) and the receipt credential the
// server issued it, kept by the shell per server, never in the page.
//
// Nothing here throws into the page: a refused, missing or broken command
// costs the notification and answers false, "default" or null.
import type {
  DesktopNotification,
  DesktopNotificationPermission,
} from "@liaison/web/lib/desktop-shell-contract"
import { invoke, listen } from "./tauri"

export const NOTIFY_COMMAND = "raise_notification"
/** The app icon's unread badge (src-tauri/src/dock_badge.rs). */
export const BADGE_COMMAND = "set_unread_badge"
export const CLICK_SUPPORT_COMMAND = "notification_click_support"
export const TAKE_CLICK_COMMAND = "take_notification_click"
export const CLICK_EVENT = "liaison://notification-click"
/** Another saved server's notification was clicked (src-tauri/src/server_listeners.rs). */
export const CLICK_SERVER_COMMAND = "notification_click_server"
export const SWITCH_EVENT = "liaison://notification-switch"
export const OS_PERMISSION_COMMAND = "notification_os_permission"
export const REQUEST_PERMISSION_COMMAND = "request_notification_os_permission"
export const PERMISSION_EVENT = "liaison://notification-permission"
/** The global src-tauri/src/notification_device.rs publishes (DEVICE_ID_GLOBAL). */
export const DEVICE_ID_GLOBAL = "__LIAISON_NOTIFICATION_DEVICE_ID__"

export async function raiseNotification(notification: DesktopNotification): Promise<boolean> {
  try {
    const shown = await invoke<boolean>(NOTIFY_COMMAND, {
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
      route: notification.route ?? null,
      sound: notification.sound === true,
    })
    return shown === true
  } catch {
    return false
  }
}

/** Puts `count` on the app icon (zero clears it). Never throws. */
export async function setUnreadBadge(count: number): Promise<void> {
  const whole = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  try {
    await invoke<void>(BADGE_COMMAND, { count: whole })
  } catch {
    // A shell without the command shows no badge.
  }
}

/** Whether a click on a notification the shell raised reaches the page. */
export async function notificationClickSupport(): Promise<boolean> {
  try {
    return (await invoke<boolean>(CLICK_SUPPORT_COMMAND)) === true
  } catch {
    return false
  }
}

/**
 * Calls back with the route of every clicked notification, once each,
 * including a click that launched the app before anything listened. Returns
 * the unsubscribe.
 */
export function onNotificationClick(listener: (route: string) => void): () => void {
  let stopped = false
  let unlisten: (() => void) | null = null
  const take = async (): Promise<void> => {
    try {
      const route = await invoke<string | null>(TAKE_CLICK_COMMAND)
      if (!stopped && typeof route === "string" && route.length > 0) listener(route)
    } catch {
      // A shell without the command has nothing to deliver.
    }
  }
  void listen<unknown>(CLICK_EVENT, () => {
    if (!stopped) void take()
  })
    .then((stop) => {
      if (stopped) stop()
      else unlisten = stop
    })
    .catch(() => undefined)
    .then(() => {
      if (!stopped) void take()
    })
  return () => {
    stopped = true
    unlisten?.()
  }
}

/**
 * A CLICK ON ANOTHER SERVER'S NOTIFICATION. The shell keeps a channel to
 * every signed-in server the window is not on and raises their notifications
 * itself; a click on one names its server, and the window has to be on that
 * server before the item can open (its route means nothing here). So
 * `switchTo` is called with the server, on the shell's event and once when
 * listening starts (a click that launched the app); the page that then starts
 * on that server takes the route through `onNotificationClick`, as for its
 * own. Returns the unsubscribe.
 */
export function onNotificationServerClick(
  switchTo: (address: string) => Promise<unknown>,
): () => void {
  let stopped = false
  let unlisten: (() => void) | null = null
  let switching = false
  const ask = async (): Promise<void> => {
    if (switching) return
    try {
      const server = await invoke<string | null>(CLICK_SERVER_COMMAND)
      if (stopped || typeof server !== "string" || server.length === 0) return
      switching = true
      await switchTo(server)
    } catch {
      // A refused switch leaves the window where it is; the click stays pending.
    } finally {
      switching = false
    }
  }
  void listen<unknown>(SWITCH_EVENT, () => {
    if (!stopped) void ask()
  })
    .then((stop) => {
      if (stopped) stop()
      else unlisten = stop
    })
    .catch(() => undefined)
    .then(() => {
      if (!stopped) void ask()
    })
  return () => {
    stopped = true
    unlisten?.()
  }
}

/** The system's word to the browser's: not decided (or unknown) is "default". */
function fromSystem(word: unknown): DesktopNotificationPermission {
  if (word === "granted") return "granted"
  if (word === "denied") return "denied"
  return "default"
}

export async function notificationPermission(): Promise<DesktopNotificationPermission> {
  try {
    return fromSystem(await invoke<string>(OS_PERMISSION_COMMAND))
  } catch {
    return "default"
  }
}

export async function requestNotificationPermission(): Promise<DesktopNotificationPermission> {
  try {
    return fromSystem(await invoke<string>(REQUEST_PERMISSION_COMMAND))
  } catch {
    return "default"
  }
}

/** Calls back on every change of the system setting. Returns the unsubscribe. */
export function onNotificationPermissionChange(
  listener: (permission: DesktopNotificationPermission) => void,
): () => void {
  let stopped = false
  let unlisten: (() => void) | null = null
  void listen<unknown>(PERMISSION_EVENT, (event) => {
    if (!stopped) listener(fromSystem(event.payload))
  })
    .then((stop) => {
      if (stopped) stop()
      else unlisten = stop
    })
    .catch(() => undefined)
  return () => {
    stopped = true
    unlisten?.()
  }
}

/** This install's notification device id, or null from a shell that published none. */
export function notificationDeviceId(): string | null {
  const id = (globalThis as Record<string, unknown>)[DEVICE_ID_GLOBAL]
  return typeof id === "string" && id.length > 0 ? id : null
}

export async function storeNotificationCredential(
  server: string,
  credential: string,
): Promise<void> {
  try {
    await invoke("store_notification_credential", { server, credential })
  } catch {
    // A server that is no longer current keeps nothing; the next start registers again.
  }
}

export async function loadNotificationCredential(server: string): Promise<string | null> {
  try {
    const stored = await invoke<string | null>("load_notification_credential", { server })
    return typeof stored === "string" && stored.length > 0 ? stored : null
  } catch {
    return null
  }
}

export async function launchAtLogin(): Promise<boolean> {
  try {
    return (await invoke<boolean>("get_launch_at_login")) === true
  } catch {
    return false
  }
}

export async function setLaunchAtLogin(enabled: boolean): Promise<boolean> {
  try {
    return (await invoke<boolean>("set_launch_at_login", { enabled })) === true
  } catch {
    return launchAtLogin()
  }
}
