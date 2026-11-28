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
import { confirmSignOut, runBeforeSignOut } from "~/lib/session-lifecycle"
import { SHELL_BRIDGE_RANGE } from "~/lib/shell-bridge-range"

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
  signOut: (opts?: { forced?: boolean }) => Promise<void>
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
  /**
   * THE SERVED SHELL (iOS). The phone app runs either the web build compiled
   * into it or the connected server's own build, which its native host
   * verified against Liaison's signature before loading it (apps/mobile/ios/
   * LiaisonShell). This answers the host's bridge version (NATIVE_BRIDGE_
   * VERSION) and which one runs.
   */
  shellInfo?: () => Promise<NativeShellInfo | null>
  /**
   * The page painted, with the build id of its index.html. A served build
   * that never says so is quarantined by the host after its second try.
   */
  shellReady?: (buildId: string | null) => void
  /** Asks the host to choose the build again; true when a reload would change it. */
  refreshShell?: () => Promise<boolean>
}

/** What the phone's host reports about the shell the page runs. */
export interface NativeShellInfo {
  bridgeVersion: number
  /** `served:<buildId>` or `bundled:<reason>`, the shell part of the client report. */
  shell: string
  served: boolean
  buildId?: string
  reason?: string
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

/**
 * Which phone app wraps the page, or null in a browser or the desktop app.
 * The shell publishes the bridge before the web app's module entry runs, so
 * this answers correctly from the first render. Anything that is not Android
 * is the iOS app (an iPad web view may describe itself as a Mac).
 */
export function nativeShellPlatform(): "ios" | "android" | null {
  if (!isNativeShell()) return null
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent
  return /android/i.test(ua) ? "android" : "ios"
}

/**
 * THE ONE CHECK FOR PURCHASE SURFACES (App Store guideline 3.1.1).
 *
 * Inside the iOS app nothing may offer to buy, upgrade, change plan, add
 * credits or sign up for a paid workspace, nor link to a page that ends in a
 * payment. Every such control asks this and is absent when it answers true;
 * where a state still needs saying (credits ran out, storage is full), the
 * surface shows a plain sentence with no link or button. A browser, the
 * desktop app and the Android app are unchanged.
 */
export function purchaseSurfacesHidden(): boolean {
  return nativeShellPlatform() === "ios"
}

/**
 * THE ONE CHECK FOR THE APP STORE (App Store guidelines 2.5.2, 3.2.2, 4.7).
 *
 * Inside the iOS app there is no catalogue of apps to add and no way to
 * install one (the App store page, its listings, Install from URL, the
 * Connectors page's Add button): every such entry asks this and is absent
 * when it answers true. The apps already in the workspace keep working, their
 * settings pages included. A browser, the desktop app and the Android app are
 * unchanged.
 */
export function appStoreHidden(): boolean {
  return nativeShellPlatform() === "ios"
}

/** Tells the shell the app has painted. Safe to call more than once. */
export function signalNativeReady(): void {
  try {
    bridgeFn("ready")?.()
  } catch {
    // A shell that cannot hide its splash screen still has a 3 s fallback.
  }
  void signalShellReady()
}

/** The build id this page's index.html carries (web-build.ts reads the same meta). */
function pageBuildId(): string | null {
  const meta = globalThis.document?.querySelector?.('meta[name="liaison-web-build"]')
  return meta?.getAttribute("content") ?? null
}

/**
 * Whether this build runs against the phone host's bridge version: the
 * `ios`/`android` range of SHELL_BRIDGE_RANGE, as the host itself checks it
 * before loading a served build. Only the caret form the ranges use (`^N`) is
 * read here; anything else is the host's call alone.
 */
export function nativeBridgeVersionSupported(info: NativeShellInfo): boolean {
  const range =
    nativeShellPlatform() === "android" ? SHELL_BRIDGE_RANGE.android : SHELL_BRIDGE_RANGE.ios
  const caret = /^\^(\d+)$/.exec(range)
  return caret === null || Number(caret[1]) === info.bridgeVersion
}

/** The host's served-shell report, or null (a browser, the desktop, an older app). */
export async function nativeShellInfo(): Promise<NativeShellInfo | null> {
  const info = bridgeFn("shellInfo")
  if (!info) return null
  try {
    const answer = await info()
    if (answer === null || typeof answer !== "object") return null
    if (typeof answer.bridgeVersion !== "number" || typeof answer.shell !== "string") return null
    return answer
  } catch {
    return null
  }
}

/**
 * Tells the host this build painted, unless the host's bridge is outside the
 * range it was written for: such a build stays unconfirmed and the host falls
 * back to its last good build, else the bundled one.
 */
async function signalShellReady(): Promise<void> {
  const ready = bridgeFn("shellReady")
  if (!ready) return
  const info = await nativeShellInfo()
  if (info !== null && !nativeBridgeVersionSupported(info)) return
  try {
    ready(pageBuildId())
  } catch {
    // An unconfirmed build only costs the served shell, never the page.
  }
}

/** `served:<buildId>` or `bundled:<reason>` from the phone's host, else null. */
export async function nativeShellReport(): Promise<string | null> {
  return (await nativeShellInfo())?.shell ?? null
}

/** True when the phone runs the server's own build (no compat notes needed). */
export async function nativeShellServed(): Promise<boolean> {
  return (await nativeShellInfo())?.served === true
}

/**
 * Asks the phone's host to choose the build for the current server again (a
 * newer verified build may be staged). True when the page should reload to
 * run it; false in a browser, the desktop or an older app.
 */
export async function nativeRefreshShell(): Promise<boolean> {
  const refresh = bridgeFn("refreshShell")
  if (!refresh) return false
  try {
    return (await refresh()) === true
  } catch {
    return false
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
  // First of all the sign-out guards: unsaved text is saved, or the person is asked
  // and may stay signed in. `forced`: nothing to save or ask (a deleted account).
  const signOut = async (opts: { forced?: boolean } = {}): Promise<void> => {
    if (!(await confirmSignOut({ forced: opts.forced === true }))) return
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
