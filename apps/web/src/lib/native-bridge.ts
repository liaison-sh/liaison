// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT THE WEB APP KNOWS ABOUT BEING WRAPPED, and it is only this file.
//
// apps/web never imports Capacitor. One build runs in a browser, in the Tauri
// desktop shell and inside the Capacitor wrapper (S15), and a Capacitor import
// anywhere in this tree would pull a native runtime into the browser bundle
// and fail at the first call. So the shell publishes a small object of
// OPTIONAL functions on a single global, exactly the way it already publishes
// the server address (`lib/env.ts`), and everything below is a no-op when that
// global is absent, which is what a browser tab always sees.
//
// Every accessor here answers null rather than throwing, and every call is
// wrapped: a shell whose plugin is missing, refused or broken costs the
// feature and never the page. A bridge function is a hint, never a gate — the
// callers each keep a browser fallback of their own (`lib/share.ts`,
// `navigator.onLine`).
import { runBeforeSignOut } from "~/lib/session-lifecycle"

/** The name the mobile boot bundle publishes. Changing it changes both sides. */
export const NATIVE_BRIDGE_GLOBAL = "__LIAISON_NATIVE__"

/**
 * The feedback a gesture asks for, named by INTENT rather than by any one
 * platform's API: the shell maps these onto Haptics' impact and notification
 * styles, and a platform without one of them simply does less.
 */
export type HapticKind = "selection" | "light" | "success" | "warning" | "error"

export interface SharePayload {
  title?: string
  text?: string
  url?: string
}

/**
 * The lock the shell can put in front of the app. `authenticate` resolves true
 * only on a real biometric (or device passcode) success; anything else, a
 * refusal and a missing sensor included, is false. It never carries a
 * credential: the refresh token stays where the shell already keeps it.
 */
export interface NativeAppLock {
  isAvailable: () => Promise<boolean>
  getEnabled: () => Promise<boolean>
  setEnabled: (enabled: boolean) => Promise<void>
  authenticate: (reason: string) => Promise<boolean>
  /** Subscribes to foreground/background. Returns its own unsubscribe. */
  onAppStateChange: (handler: (active: boolean) => void) => () => void
}

/** One saved server, as the phone's shell keeps it. */
export interface NativeSavedServer {
  address: string
  /** The organisation's own name, or null until the server has said it. */
  label: string | null
}

/**
 * THE SERVERS THIS PHONE KNOWS (apps/mobile servers/server-list.ts). Every
 * change of server starts the page again on the new one, which is the only way
 * this app's modules resolve against another origin; nothing of the server
 * being left (its token, its push registration, this page's own storage)
 * reaches the next. `add` rejects with `NotALiaisonServer`,
 * `ServerUnreachable` or `InvalidAddress`.
 */
export interface NativeServers {
  list: () => Promise<{ current: string | null; servers: NativeSavedServer[] }>
  add: (url: string) => Promise<void>
  switchTo: (address: string) => Promise<void>
  remove: (address: string) => Promise<void>
  signOut: () => Promise<void>
  /**
   * True when the shell asks its own removal question (the desktop's native
   * dialog), so the page asks none. The phone's shell leaves it unset.
   */
  confirmsRemoval?: boolean
  /** Opens the shell's own connect step instead of the group's address field. */
  beginAdd?: () => void
}

/**
 * A web sign in run by the shell in the system's own authentication session
 * (ASWebAuthenticationSession on iOS). Resolves the callback URL the session
 * ended on, or null where the shell cannot run one. Rejects with an Error whose
 * `code` is "cancelled" when the user closes the sheet.
 */
export type NativeAuthenticate = (options: {
  url: string
  /** The scheme whose redirect ends the session, without "://". */
  callbackScheme: string
}) => Promise<string | null>

/**
 * The phone's permission to show push notifications, read and asked for by
 * Settings -> Notifications ("This device"). `prompt` means the system has not
 * asked yet; once it is `denied` only the system settings can change it. A
 * `request` that ends `granted` also registers the phone for a push token.
 */
export type NativePushPermissionState = "granted" | "denied" | "prompt"

export interface NativePushPermission {
  check: () => Promise<NativePushPermissionState>
  request: () => Promise<NativePushPermissionState>
}

/**
 * EVERY MEMBER IS OPTIONAL. A shell publishes what its build actually carries,
 * an older shell wrapping a newer web bundle carries less, and a browser
 * carries none of it. No caller may assume any of these exists.
 */
export interface NativeBridge {
  /** The web app has painted. The shell hides its splash screen on this. */
  ready?: () => void
  /** The resolved theme, pushed on every change, for the status bar style. */
  setTheme?: (resolved: "light" | "dark") => void
  haptic?: (kind: HapticKind) => void
  /** Subscribes to connectivity. Returns its own unsubscribe. */
  onConnectivity?: (handler: (online: boolean) => void) => () => void
  /**
   * Subscribes to the app coming back to the foreground. Returns its own
   * unsubscribe. The socket probes itself on it (createWebSocket, S26).
   */
  onForeground?: (handler: () => void) => () => void
  isOnline?: () => Promise<boolean>
  share?: (payload: SharePayload) => Promise<void>
  appLock?: NativeAppLock
  servers?: NativeServers
  authenticate?: NativeAuthenticate
  pushPermission?: NativePushPermission
  /**
   * Subscribes to the pixels the software keyboard covers at the bottom of
   * the page, 0 when it is down. Returns its own unsubscribe. The web view
   * itself is never told (primitives/keyboardInset.ts).
   */
  onKeyboardInset?: (handler: (inset: number) => void) => () => void
  /**
   * The conversation on screen, pushed on every change (null when none is, or
   * the page is hidden). The shell reads it so a push that lands for the
   * conversation the user is already reading raises no in-app notice.
   */
  setThreadOnScreen?: (threadId: string | null) => void
  /**
   * Which phone app this is and its version ("1.0.<build>"), which the page
   * compares with the oldest version the server supports
   * (lib/client-version.ts). Null when the shell cannot read it.
   */
  clientVersion?: () => Promise<NativeClientVersion | null>
}

/** The phone app as it names itself to the server. */
export interface NativeClientVersion {
  platform: "ios" | "android"
  version: string
}

/** The published bridge, or null in a plain browser. */
export function nativeBridge(): NativeBridge | null {
  const raw = (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  if (typeof raw !== "object" || raw === null) return null
  return raw as NativeBridge
}

/**
 * The named member, but only when it is really a function. A global is
 * writable by anything in the page, so a string or a number sitting on one of
 * these names answers null here rather than throwing at the call site.
 */
function bridgeFn<K extends keyof NativeBridge>(name: K): NativeBridge[K] | null {
  const bridge = nativeBridge()
  if (bridge === null) return null
  const value = bridge[name]
  return typeof value === "function" ? value : null
}

/** Whether the page is running inside a native shell at all. */
export function isNativeShell(): boolean {
  return nativeBridge() !== null
}

/** Tells the shell the app has painted. Safe to call more than once. */
export function signalNativeReady(): void {
  try {
    bridgeFn("ready")?.()
  } catch {
    // A shell that cannot hide its splash screen still has a 3 s fallback.
  }
}

/** Pushes the resolved theme so the status bar matches the app. */
export function nativeSetTheme(resolved: "light" | "dark"): void {
  try {
    bridgeFn("setTheme")?.(resolved)
  } catch {
    // Cosmetic. Never worth an exception on a theme change.
  }
}

/** Tells the shell which conversation is on screen (null for none). */
export function nativeSetThreadOnScreen(threadId: string | null): void {
  try {
    bridgeFn("setThreadOnScreen")?.(threadId)
  } catch {
    // The worst case is one redundant notice, never a broken page.
  }
}

/** One haptic tick, silently ignored anywhere without a shell. */
export function nativeHaptic(kind: HapticKind): void {
  try {
    bridgeFn("haptic")?.(kind)
  } catch {
    // Feedback is never load-bearing.
  }
}

/** The app lock, when the shell published one. */
export function nativeAppLock(): NativeAppLock | null {
  const bridge = nativeBridge()
  const lock = bridge?.appLock
  if (typeof lock !== "object" || lock === null) return null
  if (typeof lock.authenticate !== "function") return null
  return lock
}

/** The phone's saved servers, when the shell published them. */
export function nativeServers(): NativeServers | null {
  const servers = nativeBridge()?.servers
  if (typeof servers !== "object" || servers === null) return null
  for (const name of ["list", "add", "switchTo", "remove", "signOut"] as const) {
    if (typeof servers[name] !== "function") return null
  }
  // The shell signs out by itself (the page never runs its own logout), so the
  // page's before-sign-out work runs here first, while the session still
  // authenticates it.
  const signOut = async (): Promise<void> => {
    await runBeforeSignOut()
    await servers.signOut()
  }
  return Object.assign(Object.create(servers) as NativeServers, { signOut })
}

/** The shell's authentication session, when it published one. */
export function nativeAuthenticate(): NativeAuthenticate | null {
  return bridgeFn("authenticate") ?? null
}

/** The phone's push permission, when the shell published it. */
export function nativePushPermission(): NativePushPermission | null {
  const permission = nativeBridge()?.pushPermission
  if (typeof permission !== "object" || permission === null) return null
  if (typeof permission.check !== "function" || typeof permission.request !== "function") {
    return null
  }
  return permission
}

/** The shell's keyboard inset subscription, when it published one. */
export function nativeOnKeyboardInset(): NativeBridge["onKeyboardInset"] | null {
  return bridgeFn("onKeyboardInset") ?? null
}
