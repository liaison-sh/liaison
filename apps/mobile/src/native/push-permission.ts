// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone's push permission, behind the bridge, for the "This device" row of
// Settings -> Notifications.
//
// The push client (push-client.ts) already asks once at sign in and listens
// for the token. A person who said no then, or was never asked, can ask again
// from Settings: when that request ends granted, `register` runs so the token
// reaches the server through the push client's own listener. Once iOS has a
// refusal on record it no longer shows its prompt, so `request` answers
// `denied` and the page sends the person to the system settings.

import type { NativePushPermission, NativePushPermissionState } from "../bridge/native-bridge"

/** Just enough of @capacitor/push-notifications to be testable without a device. */
export interface PushPermissionPlugin {
  checkPermissions: () => Promise<{ receive: string }>
  requestPermissions: () => Promise<{ receive: string }>
  register: () => Promise<void>
}

function normalise(receive: string): NativePushPermissionState {
  if (receive === "granted") return "granted"
  if (receive === "denied") return "denied"
  // "prompt" and Android's "prompt-with-rationale": the system can still ask.
  return "prompt"
}

export function createPushPermission(plugin: PushPermissionPlugin): NativePushPermission {
  return {
    check: async () => normalise((await plugin.checkPermissions()).receive),
    request: async () => {
      const state = normalise((await plugin.requestPermissions()).receive)
      if (state === "granted") {
        // The permission stands even when the token does not come: the next
        // foreground registers again (push-client.ts).
        await plugin.register().catch(() => undefined)
      }
      return state
    },
  }
}
