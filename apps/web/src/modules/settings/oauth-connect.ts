// SPDX-License-Identifier: FSL-1.1-ALv2
//
// STARTING AN APP CONNECTION (Gmail, Shopify, Google Calendar, ...): every
// connect button goes through `connectWithOAuth`.
//
// In a browser tab it is what it always was: ask the server for the provider's
// authorize URL and navigate there. The server binds that flow to this browser
// with a cookie, and the callback lands back on the web app's settings page.
//
// In the desktop or mobile shell that cookie cannot exist (the shell's fetch is
// cross site, so the browser never stores it), and the provider's page must
// not run in the app's own webview anyway. So the shell runs the flow the way
// it signs in (modules/auth/desktop-oauth.ts, RFC 8252):
//
//   - This window mints a PKCE verifier, keeps it, and starts the flow with its
//     S256 challenge and a `state` of its own.
//   - The provider's page opens in the SYSTEM browser (desktop) or in the
//     system authentication session (iOS).
//   - The server parks the grant and hands the browser to
//     `liaison://oauth-complete?code=...&state=...`, which comes back here.
//   - A link whose `state` this window minted is redeemed with the verifier;
//     the server stores the connection only then.
//
// The verifier never leaves this window, so a code read off the link by
// anything else is worthless, and a forwarded authorize link ends on a code
// no one holding the verifier ever sees.

import { log } from "~/lib/logger"
import { type NativeAuthenticate, nativeAuthenticate } from "~/lib/native-bridge"
import { createPkcePair } from "~/modules/auth/desktop-oauth"
import {
  canConnectWithSystemBrowser,
  onOAuthCompleteLink,
  openExternalUrl,
} from "~/modules/desktop/desktop-store"
import { SETTINGS_CONNECTED_TOOLS_PATH } from "./settings-aliases"

const connectLog = log.child({ component: "oauth-connect" })

/** The scheme the server's handoff page ends on. */
const CALLBACK_SCHEME = "liaison"

/**
 * How long the desktop waits for the browser to come back: the server keeps a
 * flow's state for fifteen minutes, and nothing can complete after that.
 */
export const SHELL_CONNECT_TIMEOUT_MS = 15 * 60 * 1000

/** The slice of the API client a connect needs. */
export interface ConnectApi {
  post: <T = unknown>(path: string, body?: unknown) => Promise<T>
}

export type ConnectOutcome =
  /** A browser tab was sent to the provider. */
  | "redirected"
  /** A shell finished the connection; `onConnected` has run. */
  | "connected"
  /** The user closed the authentication sheet. Nothing to say. */
  | "cancelled"
  /** The server answered no authorize URL. */
  | "no-redirect"

export interface ConnectOptions {
  /** A browser tab's way to the provider. Default: a full page navigation. */
  navigate?: (url: string) => void
  /**
   * What a shell does once the connection is stored. Default: the settings
   * page the browser flow lands on.
   */
  onConnected?: (result: { settingsPath: string }) => void
}

/** The redemption route beside an authorize route (`.../connections/<app>/<conn>/authorize`). */
export function handoffPathFor(authorizePath: string): string {
  return authorizePath.startsWith("/api/")
    ? "/api/connections/oauth-handoff"
    : "/connections/oauth-handoff"
}

function randomState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function parseLink(link: string): { state: string; code?: string; error?: string } | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== `${CALLBACK_SCHEME}:` || url.host !== "oauth-complete") return null
  const state = url.searchParams.get("state")
  const code = url.searchParams.get("code")
  const error = url.searchParams.get("error")
  if (!state || (code === null) === (error === null)) return null
  return { state, code: code ?? undefined, error: error ?? undefined }
}

function sameState(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The wait a newer connect supersedes. */
let cancelWaiting: ((reason: Error) => void) | null = null

/**
 * The desktop's wait for its `liaison://oauth-complete` link. Subscribed BEFORE
 * the browser opens, so a fast round trip is not lost. A link with another
 * `state` (a forwarded flow, an old tab, a sign-in) is ignored and the wait
 * goes on.
 */
function waitForLink(state: string): { link: Promise<string>; stop: () => void } {
  let stop = () => {}
  const link = new Promise<string>((resolve, reject) => {
    cancelWaiting?.(new Error("A newer connection was started."))
    const timer = setTimeout(
      () => finish(() => reject(new Error("The connection was not completed in time."))),
      SHELL_CONNECT_TIMEOUT_MS,
    )
    const unsubscribe = onOAuthCompleteLink((raw) => {
      const parsed = parseLink(raw)
      if (!parsed || !sameState(parsed.state, state)) return
      finish(() => resolve(raw))
    })
    function finish(settle: () => void): void {
      clearTimeout(timer)
      unsubscribe()
      if (cancelWaiting === cancel) cancelWaiting = null
      settle()
    }
    const cancel = (reason: Error) => finish(() => reject(reason))
    cancelWaiting = cancel
    stop = () => finish(() => reject(new Error("The connection was stopped.")))
  })
  return { link, stop }
}

/** The parameters a shell flow starts with, beside the caller's own. */
export interface ShellStartParams {
  client: "desktop" | "mobile"
  code_challenge: string
  code_challenge_method: "S256"
  state: string
}

/**
 * One OAuth flow a shell can run (an app connection, an MCP server sign-in):
 * how to start it with the shell's parameters, answering the provider's URL,
 * and how to redeem the handoff link's code with the verifier.
 */
export interface ShellOAuthFlow<T> {
  start: (params: ShellStartParams) => Promise<string | undefined>
  redeem: (body: { code: string; code_verifier: string }) => Promise<T>
}

export type ShellOAuthOutcome<T> =
  /** The shell finished the flow; `result` is the redemption's answer. */
  | { kind: "connected"; result: T }
  /** The user closed the authentication sheet. Nothing to say. */
  | { kind: "cancelled" }
  /** The server answered no authorize URL. */
  | { kind: "no-redirect" }
  /** Not a shell that can run it: the caller keeps its browser flow. */
  | { kind: "not-a-shell" }

async function redeemLink<T>(
  flow: ShellOAuthFlow<T>,
  link: string,
  state: string,
  verifier: string,
): Promise<T> {
  const parsed = parseLink(link)
  if (!parsed || !sameState(parsed.state, state)) {
    throw new Error("The connection did not complete. Try again.")
  }
  if (parsed.error !== undefined) {
    throw new Error(`The provider did not authorize the connection (${parsed.error}).`)
  }
  return flow.redeem({ code: parsed.code as string, code_verifier: verifier })
}

async function startShellFlow<T>(
  flow: ShellOAuthFlow<T>,
  client: "desktop" | "mobile",
): Promise<{ redirectUrl: string | undefined; state: string; verifier: string }> {
  const { verifier, challenge } = await createPkcePair()
  const state = randomState()
  const redirectUrl = await flow.start({
    client,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })
  return { redirectUrl: redirectUrl || undefined, state, verifier }
}

async function desktopFlow<T>(flow: ShellOAuthFlow<T>): Promise<ShellOAuthOutcome<T>> {
  const { redirectUrl, state, verifier } = await startShellFlow(flow, "desktop")
  if (!redirectUrl) return { kind: "no-redirect" }
  const wait = waitForLink(state)
  if (!(await openExternalUrl(redirectUrl))) {
    wait.stop()
    void wait.link.catch(() => undefined)
    throw new Error("The browser could not be opened. Try again.")
  }
  const link = await wait.link
  return { kind: "connected", result: await redeemLink(flow, link, state, verifier) }
}

async function sessionFlow<T>(
  flow: ShellOAuthFlow<T>,
  authenticate: NativeAuthenticate,
): Promise<ShellOAuthOutcome<T>> {
  const { redirectUrl, state, verifier } = await startShellFlow(flow, "mobile")
  if (!redirectUrl) return { kind: "no-redirect" }
  let link: string | null
  try {
    link = await authenticate({ url: redirectUrl, callbackScheme: CALLBACK_SCHEME })
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === "cancelled") return { kind: "cancelled" }
    connectLog.warn({ err }, "The authentication session failed")
    throw new Error("The connection did not complete. Try again.")
  }
  // No session on this shell after all (a build without the plugin): the
  // parked flow is abandoned and the page's own flow runs instead.
  if (link === null) return { kind: "not-a-shell" }
  return { kind: "connected", result: await redeemLink(flow, link, state, verifier) }
}

/**
 * Runs `flow` the shell's way: the desktop through the system browser, the
 * phone through its authentication session. Anywhere else (a browser tab) it
 * answers `not-a-shell` and the caller runs its own flow. Rejects with an
 * Error whose message says what went wrong.
 */
/**
 * Whether this window is a shell that runs OAuth its own way (`runShellOAuth`).
 * Synchronous, so a click handler can decide before it opens a popup.
 */
export function shellRunsOAuth(): boolean {
  return canConnectWithSystemBrowser() || nativeAuthenticate() !== null
}

export async function runShellOAuth<T>(flow: ShellOAuthFlow<T>): Promise<ShellOAuthOutcome<T>> {
  if (canConnectWithSystemBrowser()) return desktopFlow(flow)
  const authenticate = nativeAuthenticate()
  if (authenticate) return sessionFlow(flow, authenticate)
  return { kind: "not-a-shell" }
}

function defaultOnConnected({ settingsPath }: { settingsPath: string }): void {
  window.location.assign(settingsPath)
}

async function browserFlow(
  api: ConnectApi,
  authorizePath: string,
  body: Record<string, unknown> | undefined,
  navigate: (url: string) => void,
): Promise<ConnectOutcome> {
  const res = await (body === undefined
    ? api.post<{ redirectUrl?: string } | null>(authorizePath)
    : api.post<{ redirectUrl?: string } | null>(authorizePath, body))
  if (!res?.redirectUrl) return "no-redirect"
  navigate(res.redirectUrl)
  return "redirected"
}

/**
 * Starts the connect flow at `authorizePath` (with `body`, e.g. the mode and a
 * Shopify `shop`), the shell's way in a shell and the browser's way elsewhere.
 * Rejects with an Error whose message says what went wrong.
 */
export async function connectWithOAuth(
  api: ConnectApi,
  authorizePath: string,
  body?: Record<string, unknown>,
  opts?: ConnectOptions,
): Promise<ConnectOutcome> {
  const options: Required<ConnectOptions> = {
    navigate: opts?.navigate ?? ((url) => window.location.assign(url)),
    onConnected: opts?.onConnected ?? defaultOnConnected,
  }
  const outcome = await runShellOAuth({
    start: async (params) => {
      const res = await api.post<{ redirectUrl?: string } | null>(authorizePath, {
        ...body,
        ...params,
      })
      return res?.redirectUrl
    },
    redeem: (redemption) =>
      api.post<{ settingsPath?: string } | null>(handoffPathFor(authorizePath), redemption),
  })
  switch (outcome.kind) {
    case "connected":
      options.onConnected({
        settingsPath: outcome.result?.settingsPath ?? SETTINGS_CONNECTED_TOOLS_PATH,
      })
      return "connected"
    case "cancelled":
      return "cancelled"
    case "no-redirect":
      return "no-redirect"
    case "not-a-shell":
      return browserFlow(api, authorizePath, body, options.navigate)
  }
}
