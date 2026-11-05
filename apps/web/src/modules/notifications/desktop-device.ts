// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DESKTOP APP AS A NOTIFICATION DEVICE (P1-T6, S4, A6, A7, F1).
//
// One install is one device. Its id is the install id the shell publishes
// (`d.<hex>`, src-tauri/src/notification_device.rs), NOT a localStorage key:
// a web sign out clears every `liaison:` key, and an id that changed would
// make every sign in a new device.
//
//   - The WS hello carries the id and the OS permission the system reports
//     (`granted` | `denied` | `not_determined`); the server sends computer
//     notifications to this app only while it is `granted` (A6).
//   - The app registers through POST /api/notifications/desktop-devices and
//     keeps the answered receipt-only credential IN THE SHELL, per server
//     (never in the page's storage).
//   - After each OS notification call it posts a receipt with that
//     credential, never the session: shown, or suppressed with a reason.
//   - A change of the system setting re-registers (so the Settings device
//     list is current) and tells the caller (which re-sends the presence with
//     the new word).
//
// Outside the desktop app every entry point is a no-op. Nothing here throws.

import type { ApiClient } from "~/lib/api-client"
import { getDesktopBridge } from "~/lib/desktop-shell-contract"
import { absoluteApiBase, serverAddressOverride } from "~/lib/env"
import type { NotificationPermissionState } from "./native-bridge"

export type ReportedPermission = "granted" | "denied" | "not_determined"

/** The browser's word to the server's (A6): not decided is not granted. */
export function wirePermission(state: NotificationPermissionState): ReportedPermission {
  if (state === "granted" || state === "denied") return state
  return "not_determined"
}

/** This install's id, or null outside the desktop app. */
export function desktopDeviceId(): string | null {
  const shell = getDesktopBridge()
  if (!shell?.notificationDeviceId) return null
  try {
    const id = shell.notificationDeviceId()
    return typeof id === "string" && id.length > 0 ? id : null
  } catch {
    return null
  }
}

let reported: ReportedPermission | undefined
let session: { api: Pick<ApiClient, "post">; userId: string } | null = null
let credential: { server: string; value: string } | null = null

/** The last permission read from the system; undefined before the first read or outside the app. */
export function reportedPermission(): ReportedPermission | undefined {
  return reported
}

/** Reads the system's permission through the shell and remembers it. */
export async function refreshReportedPermission(): Promise<ReportedPermission | undefined> {
  const shell = getDesktopBridge()
  if (!shell?.notificationPermission || !desktopDeviceId()) return undefined
  try {
    reported = wirePermission(await shell.notificationPermission())
  } catch {
    reported = "not_determined"
  }
  return reported
}

async function register(api: Pick<ApiClient, "post">): Promise<string | null> {
  const shell = getDesktopBridge()
  const deviceId = desktopDeviceId()
  const target = serverAddressOverride()
  if (!shell || !deviceId || !target) return null
  try {
    const res = await api.post<{ deviceId: string; receiptCredential: string }>(
      "/notifications/desktop-devices",
      {
        deviceId,
        notificationPermission: reported ?? (await refreshReportedPermission()) ?? "not_determined",
        os: shell.platform,
      },
    )
    if (!res?.receiptCredential) return null
    credential = { server: target, value: res.receiptCredential }
    await shell.storeNotificationCredential?.(target, res.receiptCredential).catch(() => undefined)
    return res.receiptCredential
  } catch {
    return null
  }
}

/**
 * At sign-in / shell start: this install becomes (again) a notification
 * device of `userId`, with its current permission, and keeps a fresh receipt
 * credential. False outside the desktop app or when the server refused.
 */
export async function ensureDesktopDevice(
  api: Pick<ApiClient, "post">,
  userId: string,
): Promise<boolean> {
  if (!desktopDeviceId()) return false
  session = { api, userId }
  if (reported === undefined) await refreshReportedPermission()
  return (await register(api)) !== null
}

async function currentCredential(): Promise<string | null> {
  const target = serverAddressOverride()
  if (!target) return null
  if (credential?.server === target) return credential.value
  const shell = getDesktopBridge()
  try {
    const stored = (await shell?.loadNotificationCredential?.(target)) ?? null
    if (stored) credential = { server: target, value: stored }
    return stored
  } catch {
    return null
  }
}

export interface DesktopReceipt {
  notificationId: string
  outcome: "shown" | "suppressed"
  reason?: string
}

async function send(
  token: string,
  deviceId: string,
  input: DesktopReceipt,
): Promise<Response | null> {
  try {
    return await fetch(`${absoluteApiBase()}/notifications/receipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        notificationId: input.notificationId,
        deviceId,
        surface: "desktop",
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
 * One receipt from this install, with its device credential (never the
 * session). A 401 (rotated or revoked credential) re-registers once under the
 * current session and retries. False when nothing was recorded.
 */
export async function postDesktopReceipt(input: DesktopReceipt): Promise<boolean> {
  const deviceId = desktopDeviceId()
  if (!deviceId) return false
  const token = await currentCredential()
  if (!token) return false
  let res = await send(token, deviceId, input)
  // A receipt that beat its delivery row (404) is posted once more a moment later.
  if (res?.status === 404) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    res = await send(token, deviceId, input)
  }
  if (res?.status === 401 && session) {
    const fresh = await register(session.api)
    if (!fresh) return false
    return (await send(fresh, deviceId, input))?.ok ?? false
  }
  return res?.ok ?? false
}

/**
 * Follows the system setting: on a change, remember it, re-register the
 * device with it, and tell `onChange` (the shell re-sends its presence).
 * Returns the uninstaller; a no-op outside the desktop app.
 */
export function installDesktopPermissionReporting(
  onChange: (permission: ReportedPermission) => void,
): () => void {
  const shell = getDesktopBridge()
  if (!shell?.onNotificationPermissionChange || !desktopDeviceId()) return () => {}
  return shell.onNotificationPermissionChange((permission) => {
    const next = wirePermission(permission)
    if (next === reported) return
    reported = next
    onChange(next)
    if (session) void register(session.api)
  })
}

/**
 * Sign-out in the desktop app: the server revokes the credential with the
 * session (the logout names this device, A44); the shell's copy goes too, so
 * a signed-out app posts no receipts for the previous user.
 */
export async function forgetDesktopDevice(): Promise<void> {
  const target = serverAddressOverride()
  session = null
  credential = null
  if (!target || !desktopDeviceId()) return
  await getDesktopBridge()
    ?.storeNotificationCredential?.(target, "")
    .catch(() => undefined)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const DesktopDeviceTestAccess = {
  /** Forget the remembered permission, session and credential. */
  reset(): void {
    reported = undefined
    session = null
    credential = null
  },
}
