// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Haptic feedback, named by INTENT on the bridge and mapped to a platform API
// here.
//
// The web app asks for "selection" or "success"; it never names an impact
// style or a notification type, because those are iOS' vocabulary and Android
// answers them with different hardware. One mapping, in one place, means a
// gesture feels the same everywhere and a platform that supports less simply
// does less.
//
// EVERY CALL IS FIRE AND FORGET. A haptic is confirmation of something that
// has already happened; awaiting it would put the motor on the path of a tap.
// A device with the motor disabled, a simulator, or a platform without the
// plugin rejects, and a rejection is dropped: there is nothing to retry and
// nothing the user needs told.

export type HapticKind = "selection" | "light" | "success" | "warning" | "error"

export type ImpactStyleName = "LIGHT" | "MEDIUM" | "HEAVY"
export type NotificationTypeName = "SUCCESS" | "WARNING" | "ERROR"

/** Just enough of @capacitor/haptics to be testable without a device. */
export interface HapticsPlugin {
  impact: (options: { style: ImpactStyleName }) => Promise<void>
  selectionChanged: () => Promise<void>
  notification: (options: { type: NotificationTypeName }) => Promise<void>
}

/**
 * What the shell calls for each kind, as a plain description. Exported so the
 * mapping itself is the thing under test rather than a mock's call log.
 */
export type HapticCall =
  | { call: "selectionChanged" }
  | { call: "impact"; style: ImpactStyleName }
  | { call: "notification"; type: NotificationTypeName }

export function hapticCallFor(kind: HapticKind): HapticCall {
  switch (kind) {
    case "selection":
      // The detent tick: a row passing its open threshold, a tab seat
      // changing. Deliberately the lightest thing the platform has.
      return { call: "selectionChanged" }
    case "light":
      // A committed action: a message sent, a swipe carried through.
      return { call: "impact", style: "LIGHT" }
    case "success":
      return { call: "notification", type: "SUCCESS" }
    case "warning":
      return { call: "notification", type: "WARNING" }
    case "error":
      return { call: "notification", type: "ERROR" }
  }
}

/** The bridge's `haptic`. Never throws and never returns a promise. */
export function createHaptics(plugin: HapticsPlugin): (kind: HapticKind) => void {
  return (kind: HapticKind): void => {
    let pending: Promise<void>
    try {
      const wanted = hapticCallFor(kind)
      if (wanted.call === "selectionChanged") pending = plugin.selectionChanged()
      else if (wanted.call === "impact") pending = plugin.impact({ style: wanted.style })
      else pending = plugin.notification({ type: wanted.type })
    } catch {
      // A plugin that throws synchronously (no implementation on this
      // platform) is the same non-event as one that rejects.
      return
    }
    void pending.catch(() => {})
  }
}
