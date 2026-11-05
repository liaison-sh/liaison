// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "CONTINUE WITH GOOGLE" IN THE DESKTOP APP, the RFC 8252 way.
//
// The window used to navigate ITSELF to the authorize route, so the identity
// provider's page ran inside the app's embedded webview. Google refuses that
// by policy and, worse, its passkey sign-in cannot reach the platform passkey
// store from there: it fell back to "use your phone" over Bluetooth and a user
// with a passkey or 2FA could not sign in.
//
// Now the page never leaves the app. It mints a PKCE verifier and challenge
// and its own `state`, keeps them here (memory, and sessionStorage so a reload
// of this window does not lose them), and asks the shell to open the authorize
// URL in the SYSTEM browser with `client=desktop` and the challenge. The
// server ends that flow on a page that hands the browser to
// `liaison://oauth-complete?code=...&state=...`; the shell forwards that link
// here, and the code is redeemed with the verifier. The verifier never leaves
// this window, so a code read off that link by anything else is worthless.
//
// THE iOS SHELL RUNS THE SAME FLOW with `client=mobile`, in the system's own
// authentication session rather than a browser window (`signInInSession`): the
// session is handed the authorize URL and `liaison` as its callback scheme and
// answers the callback URL to the call that opened it, which then goes through
// `completeDesktopOAuth` like a forwarded link.

import { createSignal } from "solid-js"
import { log } from "~/lib/logger"
import type { NativeAuthenticate } from "~/lib/native-bridge"
import { exchangeOAuthCode } from "~/modules/auth/oauth-exchange"
import { openAuthInBrowser } from "~/modules/desktop/desktop-store"

const oauthLog = log.child({ component: "desktop-oauth" })

/** Where the pending sign-in survives a reload of this window. */
export const DESKTOP_OAUTH_STORAGE_KEY = "liaison:desktop-oauth"

/**
 * How long a pending sign-in is worth waiting for: the server keeps its own
 * half of the round trip for ten minutes, and nothing can complete after that.
 */
export const DESKTOP_OAUTH_TTL_MS = 10 * 60 * 1000

/** What this window is waiting on. The verifier is the secret half. */
export interface PendingDesktopOAuth {
  state: string
  verifier: string
  /** The exact URL opened in the browser, so it can be opened again. */
  authorizeUrl: string
  /** The provider's display name, for the waiting card. */
  provider: string
  returnTo: string
  startedAt: number
}

function base64url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

/** RFC 7636: a 32 byte verifier and its S256 challenge. */
export async function createPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64url(32)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}

function isPending(value: unknown): value is PendingDesktopOAuth {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    typeof v.state === "string" &&
    typeof v.verifier === "string" &&
    typeof v.authorizeUrl === "string" &&
    typeof v.provider === "string" &&
    typeof v.returnTo === "string" &&
    typeof v.startedAt === "number"
  )
}

function expired(entry: PendingDesktopOAuth, now = Date.now()): boolean {
  return now - entry.startedAt > DESKTOP_OAUTH_TTL_MS
}

function readStored(): PendingDesktopOAuth | null {
  try {
    const raw = sessionStorage.getItem(DESKTOP_OAUTH_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isPending(parsed) && !expired(parsed) ? parsed : null
  } catch {
    return null
  }
}

function store(entry: PendingDesktopOAuth | null): void {
  try {
    if (entry) sessionStorage.setItem(DESKTOP_OAUTH_STORAGE_KEY, JSON.stringify(entry))
    else sessionStorage.removeItem(DESKTOP_OAUTH_STORAGE_KEY)
  } catch {
    // A window that refuses storage keeps the sign-in in memory only, which
    // lasts exactly as long as the window does.
  }
}

const [pendingSignal, setPendingSignal] = createSignal<PendingDesktopOAuth | null>(readStored())

function setPending(entry: PendingDesktopOAuth | null): void {
  store(entry)
  setPendingSignal(entry)
}

/** The sign-in this window is waiting on in the browser, or null. */
export function desktopOAuthPending(): PendingDesktopOAuth | null {
  const entry = pendingSignal()
  return entry && !expired(entry) ? entry : null
}

interface SignInStart {
  /** The provider's authorize route on this install's server, no query. */
  authorizeBase: string
  provider: string
  returnTo: string
}

/** Mints the PKCE pair and state, records the pending sign-in, answers its URL. */
async function startPending(input: SignInStart, client: "desktop" | "mobile"): Promise<string> {
  const { verifier, challenge } = await createPkcePair()
  const state = randomBase64url(32)
  const query = new URLSearchParams({
    state,
    client,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  const authorizeUrl = `${input.authorizeBase}?${query}`
  setPending({
    state,
    verifier,
    authorizeUrl,
    provider: input.provider,
    returnTo: input.returnTo,
    startedAt: Date.now(),
  })
  return authorizeUrl
}

/**
 * Starts a system-browser sign-in. Answers whether the browser opened; the
 * sign-in stays pending either way, so "open the browser again" can retry.
 */
export async function beginDesktopOAuth(input: SignInStart): Promise<boolean> {
  return openAuthInBrowser(await startPending(input, "desktop"))
}

/** Opens the same sign-in in the browser again: same state, same challenge. */
export async function reopenDesktopOAuth(): Promise<boolean> {
  const entry = desktopOAuthPending()
  if (!entry) return false
  return openAuthInBrowser(entry.authorizeUrl)
}

/** The user gave up waiting. Any link that arrives later is refused. */
export function cancelDesktopOAuth(): void {
  setPending(null)
}

export type DesktopOAuthResult =
  /** Signed in: hand the token to the auth store and go where the user was going. */
  | { kind: "signedIn"; accessToken: string; returnTo: string }
  /** The provider was the first factor: answer the TOTP challenge, then go on. */
  | { kind: "totp"; challengeToken: string; returnTo: string }
  /** The sign-in this window started ended without a session. */
  | { kind: "error"; error: string }
  /** Not this window's sign-in (no pending one, a different state, a bad link). */
  | { kind: "ignored"; reason: "malformed" | "not-waiting" | "state-mismatch" }

/** What the page reads when the failure is not one the server named. */
export const DESKTOP_OAUTH_FAILED = "OAuth authentication failed"

function parseLink(link: string): { state: string; code?: string; error?: string } | null {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return null
  }
  if (url.protocol !== "liaison:" || url.host !== "oauth-complete") return null
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

/**
 * Takes one `liaison://oauth-complete` link to its end.
 *
 * A link is attacker reachable (any web page can navigate to `liaison://`), so
 * it is acted on only when this window is waiting AND its `state` is the one
 * this window minted. Anything else is ignored and the wait goes on: the real
 * link may still be coming. A matching link ends the wait whatever it says,
 * and only then is its code redeemed, with this window's verifier.
 */
export async function completeDesktopOAuth(link: string): Promise<DesktopOAuthResult> {
  const parsed = parseLink(link)
  if (!parsed) return { kind: "ignored", reason: "malformed" }
  const entry = desktopOAuthPending()
  if (!entry) return { kind: "ignored", reason: "not-waiting" }
  if (!sameState(parsed.state, entry.state)) {
    oauthLog.warn("Ignoring an oauth-complete link whose state this window did not mint")
    return { kind: "ignored", reason: "state-mismatch" }
  }
  setPending(null)
  if (parsed.error !== undefined) return { kind: "error", error: parsed.error }
  try {
    const outcome = await exchangeOAuthCode({
      code: parsed.code!,
      state: parsed.state,
      code_verifier: entry.verifier,
    })
    if (outcome?.kind === "token") {
      return { kind: "signedIn", accessToken: outcome.accessToken, returnTo: entry.returnTo }
    }
    if (outcome?.kind === "totp") {
      return { kind: "totp", challengeToken: outcome.challengeToken, returnTo: entry.returnTo }
    }
  } catch (err) {
    oauthLog.warn({ err }, "The desktop OAuth exchange failed")
  }
  return { kind: "error", error: DESKTOP_OAUTH_FAILED }
}

/** The scheme the authentication session ends on (the handoff page's link). */
export const MOBILE_CALLBACK_SCHEME = "liaison"

export type SessionOAuthResult =
  | DesktopOAuthResult
  /** The user closed the sheet. Nothing to say. */
  | { kind: "cancelled" }
  /** The shell could not run a session at all: the caller keeps its web path. */
  | { kind: "unavailable" }

/**
 * THE iOS SIGN-IN, start to end, in one call. The session is the only thing
 * that sees the callback, and it gives it back here; the link is then held to
 * exactly the checks a forwarded desktop link is (same state, this window's
 * verifier). Whatever happens, nothing is left pending: a session that ended
 * without a link has no second chance to deliver one.
 */
export async function signInInSession(
  input: SignInStart,
  authenticate: NativeAuthenticate,
): Promise<SessionOAuthResult> {
  const authorizeUrl = await startPending(input, "mobile")
  let link: string | null
  try {
    link = await authenticate({ url: authorizeUrl, callbackScheme: MOBILE_CALLBACK_SCHEME })
  } catch (err) {
    setPending(null)
    if ((err as { code?: unknown } | null)?.code === "cancelled") return { kind: "cancelled" }
    oauthLog.warn({ err }, "The authentication session failed")
    return { kind: "error", error: DESKTOP_OAUTH_FAILED }
  }
  if (link === null) {
    setPending(null)
    return { kind: "unavailable" }
  }
  const result = await completeDesktopOAuth(link)
  // A link the checks refused ends this sign-in too: the session is over.
  setPending(null)
  return result.kind === "ignored" ? { kind: "error", error: DESKTOP_OAUTH_FAILED } : result
}

/** Test seam: forgets any pending sign-in. */
export function resetDesktopOAuth(): void {
  setPending(null)
}
