// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "This device" on Settings -> Notifications: which surface this page runs in
// and the real permission it has to notify, read and asked for the one way
// that surface allows.
//
//   phone        the iOS shell: the push permission, through the native bridge
//                (lib/native-bridge.ts `pushPermission`).
//   desktop_app  the Tauri app: the system's own notification setting, read
//                by the shell (src-tauri/src/desktop_notifications.rs; the
//                plugin's answer was always "granted", P1-T6).
//   browser      the browser's Notification permission.

import { nativePushPermission } from "~/lib/native-bridge"
import { isDesktop } from "~/modules/desktop/desktop-store"
import {
  desktopNotificationPermission,
  type NotificationPermissionState,
  requestDesktopNotificationPermission,
} from "~/modules/notifications/native-bridge"

export type DeviceKind = "phone" | "desktop_app" | "browser"
export type DevicePermission = "granted" | "denied" | "prompt" | "unsupported"

export interface ThisDevice {
  kind: DeviceKind
  read: () => Promise<DevicePermission>
  /** From a click: browsers refuse a request made without a user gesture. */
  request: () => Promise<DevicePermission>
}

function fromWeb(state: NotificationPermissionState): DevicePermission {
  return state === "default" ? "prompt" : state
}

async function guarded(run: () => Promise<DevicePermission>): Promise<DevicePermission> {
  try {
    return await run()
  } catch {
    return "unsupported"
  }
}

export function thisDevice(): ThisDevice {
  const push = nativePushPermission()
  if (push) {
    return {
      kind: "phone",
      read: () => guarded(() => push.check()),
      request: () => guarded(() => push.request()),
    }
  }
  return {
    kind: isDesktop() ? "desktop_app" : "browser",
    read: () => guarded(async () => fromWeb(await desktopNotificationPermission())),
    request: () => guarded(async () => fromWeb(await requestDesktopNotificationPermission())),
  }
}
