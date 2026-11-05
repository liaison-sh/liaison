// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell half of the hand-off apps/web reads in `lib/native-bridge.ts`.
//
// Same shape as the server address global (`boot/server-global.ts`) and for
// the same reason: the boot bundle is injected ahead of apps/web's own module
// entry, so it is the one place that can leave something behind for a bundle
// that imports no Capacitor at all.
//
// It is PUBLISHED IN PARTS. The synchronous members (ready, haptic, setTheme)
// must exist before the web app's first paint, and the ones behind a native
// capability check (the app lock) can only be added once that check has
// answered. So publishing merges rather than replaces: a later part never
// drops an earlier one, and the web app holds the same object throughout.

/** The name apps/web reads. Changing it changes both sides or neither. */
export const NATIVE_BRIDGE_GLOBAL = "__LIAISON_NATIVE__"

export type HapticKind = "selection" | "light" | "success" | "warning" | "error"

export interface SharePayload {
  title?: string
  text?: string
  url?: string
}

export interface NativeAppLock {
  isAvailable: () => Promise<boolean>
  getEnabled: () => Promise<boolean>
  setEnabled: (enabled: boolean) => Promise<void>
  authenticate: (reason: string) => Promise<boolean>
  onAppStateChange: (handler: (active: boolean) => void) => () => void
}

/** The servers this phone knows, as the settings screen reaches them. */
export interface NativeServerList {
  current: string | null
  servers: Array<{ address: string; label: string | null }>
}

export interface NativeServers {
  list: () => Promise<NativeServerList>
  add: (url: string) => Promise<void>
  switchTo: (address: string) => Promise<void>
  /** A notification from another saved server was tapped: move there, at the item. */
  openOn?: (address: string, link: string) => Promise<boolean>
  remove: (address: string) => Promise<void>
  signOut: () => Promise<void>
}

/**
 * A web sign in in ASWebAuthenticationSession (native/liaison-native.ts):
 * resolves the callback URL, null where the plugin is absent, rejects with an
 * Error whose `code` is "cancelled" when the user closes the sheet.
 */
export type NativeAuthenticate = (options: {
  url: string
  callbackScheme: string
}) => Promise<string | null>

/** The push permission Settings -> Notifications reads (native/push-permission.ts). */
export type NativePushPermissionState = "granted" | "denied" | "prompt"

export interface NativePushPermission {
  check: () => Promise<NativePushPermissionState>
  request: () => Promise<NativePushPermissionState>
}

/** Mirrors apps/web/src/lib/native-bridge.ts. Both sides stay optional. */
export interface NativeBridge {
  ready?: () => void
  setTheme?: (resolved: "light" | "dark") => void
  haptic?: (kind: HapticKind) => void
  onConnectivity?: (handler: (online: boolean) => void) => () => void
  /** Every return to the foreground (native/foreground.ts). Returns its unsubscribe. */
  onForeground?: (handler: () => void) => () => void
  isOnline?: () => Promise<boolean>
  share?: (payload: SharePayload) => Promise<void>
  appLock?: NativeAppLock
  servers?: NativeServers
  authenticate?: NativeAuthenticate
  pushPermission?: NativePushPermission
  /** The pixels the software keyboard covers, 0 when it is down (native/keyboard.ts). */
  onKeyboardInset?: (handler: (inset: number) => void) => () => void
  /** The page's report of the conversation on screen (native/thread-on-screen.ts). */
  setThreadOnScreen?: (threadId: string | null) => void
  /** Which phone app this is and its version, "1.0.<build>" (native/client-version.ts). */
  clientVersion?: () => Promise<{ platform: "ios" | "android"; version: string } | null>
}

/**
 * Merges `parts` into the published bridge and returns it. Anything already
 * on the global that is not an object is replaced: the bridge decides what
 * the wrapped app can reach, and a value page script wrote is not it.
 */
export function publishNativeBridge(target: object, parts: NativeBridge): NativeBridge {
  const slot = target as Record<string, unknown>
  const existing = slot[NATIVE_BRIDGE_GLOBAL]
  const bridge: NativeBridge =
    typeof existing === "object" && existing !== null ? (existing as NativeBridge) : {}
  Object.assign(bridge, parts)
  slot[NATIVE_BRIDGE_GLOBAL] = bridge
  return bridge
}

/** The published bridge, or null when nothing has published one. */
export function publishedNativeBridge(target: object): NativeBridge | null {
  const raw = (target as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  if (typeof raw !== "object" || raw === null) return null
  return raw as NativeBridge
}
