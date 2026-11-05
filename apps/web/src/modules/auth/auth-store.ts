// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import { AuthRefreshError, isInvalidRefreshStatus } from "~/lib/auth-refresh"
import { noteIfDemoWorkspaceExpired } from "~/lib/demo-expired"
import { authApiUrl, serverAddressOverride } from "~/lib/env"
import { startSession, teardownSession } from "~/lib/session-lifecycle"

interface TokenPayload {
  userId: string
  orgId: string
  name: string
  roles: string[]
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  exp: number
  /** An administrator whose org requires a second factor they have not set up: enroll first. */
  secondFactorRequired?: boolean
}

const SESSION_FLAG_KEY = "liaison:session"
const RESTORE_RETRY_DELAY_MS = 5_000
/**
 * How long a shell waits for its server to answer the boot refresh before it
 * says so. A browser has no such bound: it is served BY the server it is
 * asking, so "no answer" is a page that never loaded.
 *
 * Generous on purpose: a cold server behind a tunnel, a laptop waking with
 * its VPN still coming up, a first request that pays for TLS and a container
 * warm-up all answer well inside half a minute, and a message that appears
 * before they do is a wrong message.
 */
const RESTORE_TIMEOUT_MS = 30_000

function hasStoredSession(): boolean {
  try {
    if (typeof window !== "undefined") {
      return localStorage.getItem(SESSION_FLAG_KEY) === "1"
    }
  } catch {
    // localStorage can be unavailable in tests/private browsing modes
  }
  return false
}

function persistSessionFlag(active: boolean): void {
  try {
    if (typeof window === "undefined") return
    if (active) {
      localStorage.setItem(SESSION_FLAG_KEY, "1")
    } else {
      localStorage.removeItem(SESSION_FLAG_KEY)
    }
  } catch {
    // localStorage can be unavailable in tests/private browsing modes
  }
}

/**
 * A COLD START INSIDE A WRAPPED SHELL STILL HAS A SESSION (P6d-FX9).
 *
 * In a browser the refresh token is the `liaison_rt` cookie and this flag is
 * the only thing that says a session may be restorable, so a boot without it
 * is a boot with nothing to try. Inside a shell it is not: the shell persists
 * the refresh token natively (Capacitor Preferences on iOS and Android, the
 * shell's own store on the desktop) and adds it to the refresh call itself
 * (apps/mobile/src/auth/refresh-bridge.ts), so the token outlives the
 * webview's localStorage. Gating on the flag alone therefore sent a cold start
 * that holds a perfectly good refresh token to the login screen: a reinstalled
 * webview, an evicted store, or simply a shell that signed in before the flag
 * was ever written.
 *
 * So under a shell the refresh is ATTEMPTED and the answer decides. A shell
 * with no stored token gets one 401, which is the login screen it was already
 * heading for, and the flag is written on success like any other login.
 *
 * `serverAddressOverride()` is what makes this a shell rather than a browser:
 * the shell sets that global before the app's modules load (lib/env.ts), and a
 * browser has none.
 */
export function inWrappedShell(): boolean {
  return serverAddressOverride() !== null
}

const hadSession = hasStoredSession()
/** Whether boot has something to restore: the flag, or a shell's own token. */
const bootMayRestore = hadSession || inWrappedShell()

const [_accessToken, _setAccessToken] = createSignal<string | null>(null)
const [_hasSession, _setHasSession] = createSignal(hadSession)
const [_challengeToken, _setChallengeToken] = createSignal<string | null>(null)
const [_isRestoringSession, _setIsRestoringSession] = createSignal(bootMayRestore)
const [_serverUnreachable, _setServerUnreachable] = createSignal(false)
const [_bouncedByUnreachable, _setBouncedByUnreachable] = createSignal(false)

/** Whether a restore is worth attempting NOW: the flag, or a shell's token. */
function mayRestore(): boolean {
  return _hasSession() || inWrappedShell()
}

export const accessToken = _accessToken
/** Whether the user has an active refresh token (cookie-managed, not exposed to JS). */
export const hasSession = _hasSession
export const challengeToken = _challengeToken
export const isRestoringSession = _isRestoringSession
/**
 * THE SHELL IS POINTED AT SOMETHING THAT DOES NOT ANSWER (P6d-FX11).
 *
 * A browser can only ever ask the server that served it, so a restore that
 * fails there is a blip worth retrying behind a splash. A wrapped shell asks
 * whatever address it was last bound to, and that address goes stale: a dev
 * server that is gone, a box behind a VPN that is off, a server that moved.
 * The retry loop below is right to keep trying, but it used to be the ONLY
 * thing that happened: `isRestoringSession` went true again every five
 * seconds, ProtectedRoute kept the "Restoring session" splash up forever, and
 * the one screen that can change the address (the connect card on /login) was
 * behind that splash. So a shell whose restore cannot reach the server raises
 * this, and the login surface says so and offers the card.
 *
 * It is never raised in a browser, and it is cleared by a session (a late
 * answer from the retry loop lands here as an ordinary `setTokens`).
 */
export const serverUnreachable = _serverUnreachable

/**
 * WHETHER THE USER IS ON /login BECAUSE OF THE ABOVE, and not because they
 * asked for it. It is the login surface's licence to move: a browser tab
 * sitting on /login, signed in or signed in by another tab, is exactly where
 * its user put it, and sending it into the app would be taking the page away
 * from somebody who opened it on purpose.
 */
export const bouncedByUnreachable = _bouncedByUnreachable

/** Says the route change was ours. Only ProtectedRoute has cause to call it. */
export function noteUnreachableBounce(): void {
  _setBouncedByUnreachable(true)
}

/** Reads and clears it: the licence is spent on one navigation. */
export function consumeUnreachableBounce(): boolean {
  const bounced = _bouncedByUnreachable()
  _setBouncedByUnreachable(false)
  return bounced
}

/** Set a challenge token from a first-factor login response. */
export function setChallengeToken(token: string): void {
  _setChallengeToken(token)
}

/** Read and atomically clear the challenge token (single use). */
export function consumeChallengeToken(): string | null {
  const token = _challengeToken()
  _setChallengeToken(null)
  return token
}

export const isAuthenticated = () => _accessToken() !== null

const AUTH_CHANNEL = "liaison-auth"

/**
 * Work for THIS tab when ANOTHER tab's login ended (its sign-out or refused
 * refresh broadcast "logout"): the shared login is over here too, so a store
 * holding the user's data drops it (S58, batch-5 F5: the session events
 * cache's queued writes and held transcripts). Listeners must not throw and
 * must be idempotent.
 */
const logoutBroadcastListeners = new Set<() => void>()

export function onLogoutBroadcast(fn: () => void): () => void {
  logoutBroadcastListeners.add(fn)
  return () => {
    logoutBroadcastListeners.delete(fn)
  }
}
let bc: BroadcastChannel | null = null
let restorePromise: Promise<void> | null = null
/** The live attempt's abort handle, so the bound and the user can drop it. */
let restoreController: AbortController | null = null
let restoreRetryTimer: ReturnType<typeof setTimeout> | null = null
let retryOnlineHandler: (() => void) | null = null

function clearRestoreRetryWaiters(): void {
  if (restoreRetryTimer) {
    clearTimeout(restoreRetryTimer)
    restoreRetryTimer = null
  }

  if (retryOnlineHandler && typeof window !== "undefined") {
    window.removeEventListener("online", retryOnlineHandler)
    retryOnlineHandler = null
  }
}

try {
  bc = new BroadcastChannel(AUTH_CHANNEL)
  bc.onmessage = (e) => {
    if (typeof e.data !== "object" || e.data === null) return
    if (e.data.type === "login") {
      // Token not transmitted — each tab fetches its own via refresh cookie
      _setHasSession(true)
      persistSessionFlag(true)
      if (!_accessToken() && !_isRestoringSession()) void restoreSession()
    } else if (e.data.type === "logout") {
      _setAccessToken(null)
      _setHasSession(false)
      persistSessionFlag(false)
      _setIsRestoringSession(false)
      for (const fn of [...logoutBroadcastListeners]) {
        try {
          fn()
        } catch {
          // A listener's failure never keeps this tab's session alive.
        }
      }
    }
  }
} catch {
  // BroadcastChannel not supported (e.g., test env)
}

/**
 * How long a login lasts from its last renewal. The server's refresh session
 * is 30 days, and every refresh starts a fresh 30 (apps/api auth.ts
 * `createSession`, and the cookie's Max-Age in lib/response.ts). The page is
 * never shown the refresh token itself, so it counts from the last token it
 * was given: that is when the server last started the 30 days.
 */
export const LOGIN_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

let loginRenewedAt: number | null = null

/**
 * Epoch milliseconds at which the current login (its refresh token) ends, or
 * null when there is no login. What the device keeps the unlocked mailbox
 * under: "the unlock lives as long as the login does".
 */
export function loginSessionExpiresAt(): number | null {
  return loginRenewedAt === null ? null : loginRenewedAt + LOGIN_SESSION_TTL_MS
}

/**
 * The org of the last session this page held. It outlives `clearAuth` on
 * purpose: a session can end without the sign-out's teardown (an ended demo
 * workspace's "Start over", a rejected refresh) and the next one begin in
 * ANOTHER org without a page load.
 */
let lastSessionOrgId: string | null = null

export function setTokens(access: string, _refresh?: string): void {
  // ANOTHER ORG IS ANOTHER SESSION. Every per-session store (the tour on
  // screen, the demo's verification and budget, lists, apps) belongs to the
  // org it was read in, so it resets here before the new org's session starts,
  // exactly as on a sign-out, and the new org starts as a fresh page load does.
  const nextOrgId = decodeJwtPayload(access)?.orgId ?? null
  if (lastSessionOrgId !== null && nextOrgId !== null && nextOrgId !== lastSessionOrgId) {
    teardownSession()
  }
  if (nextOrgId !== null) lastSessionOrgId = nextOrgId
  loginRenewedAt = Date.now()
  clearRestoreRetryWaiters()
  _setServerUnreachable(false)
  _setAccessToken(access)
  _setHasSession(true)
  _setIsRestoringSession(false)
  persistSessionFlag(true)
  bc?.postMessage({ type: "login" })
  // A LOGIN IS A SESSION START, whether or not the page reloads. Startup's
  // hydration is gated on `hasSession()` at boot, so signing in without a
  // reload used to leave every store it fills empty for the whole session:
  // Home rendered "no conversations" against an account in a hundred of them,
  // and only the next launch showed them. Handlers are idempotent, so the
  // token refresh that also lands here costs nothing.
  startSession()
}

/**
 * Work that must run on EVERY end of a session, not only the sign-out button:
 * a rejected refresh token, a failed restore, an unauthorized answer all end
 * here. The browser device registers its local cleanup (browser-push.ts), so
 * the next user of this browser never inherits the previous user's Web Push
 * subscription or receipt credential (fix2-F1). Listeners must not throw and
 * must be idempotent (sign-out runs its own cleanup first, then this one).
 */
const authClearedListeners = new Set<() => void>()

export function onAuthCleared(fn: () => void): () => void {
  authClearedListeners.add(fn)
  return () => {
    authClearedListeners.delete(fn)
  }
}

export function clearAuth(): void {
  for (const fn of [...authClearedListeners]) {
    try {
      fn()
    } catch {
      // A listener's failure never keeps a session alive.
    }
  }
  loginRenewedAt = null
  clearRestoreRetryWaiters()
  _setServerUnreachable(false)
  _setBouncedByUnreachable(false)
  _setAccessToken(null)
  _setChallengeToken(null)
  _setHasSession(false)
  _setIsRestoringSession(false)
  persistSessionFlag(false)
  bc?.postMessage({ type: "logout" })
}

function scheduleRestoreRetry(): void {
  if (typeof window !== "undefined" && !retryOnlineHandler) {
    retryOnlineHandler = () => {
      clearRestoreRetryWaiters()
      if (mayRestore()) {
        void restoreSession()
      }
    }

    window.addEventListener("online", retryOnlineHandler)
  }

  if (restoreRetryTimer) return

  restoreRetryTimer = setTimeout(() => {
    clearRestoreRetryWaiters()
    if (mayRestore()) {
      void restoreSession()
    }
  }, RESTORE_RETRY_DELAY_MS)
}

async function requestSessionRestore(signal?: AbortSignal): Promise<void> {
  const post = () =>
    fetch(authApiUrl("/refresh"), {
      method: "POST",
      credentials: "include",
      // keepalive: a navigation or reload while this is in flight must not
      // drop the response. The server has rotated the refresh token by then;
      // a cancelled request loses the Set-Cookie carrying its successor, the
      // browser keeps the spent one, and every later refresh is answered
      // REFRESH_RACE (409) and then 401: the page signs itself out.
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    })
  let res = await post()
  // 409: another tab rotated the shared cookie a moment ago (see createAuthManager).
  if (res.status === 409) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    res = await post()
  }

  if (!res.ok) {
    if (isInvalidRefreshStatus(res.status)) {
      // A workspace that ended leaves for the demo door (lib/demo-expired.ts).
      await noteIfDemoWorkspaceExpired(res)
      clearAuth()
      throw new AuthRefreshError("invalid_credentials", "Stored refresh token rejected")
    }

    throw new AuthRefreshError("transient", "Session restore temporarily unavailable")
  }

  const json = await res.json()
  const data = json.data ?? json
  if (!data?.accessToken) {
    throw new AuthRefreshError("transient", "Session restore returned an invalid payload")
  }

  setTokens(data.accessToken)
}

/**
 * A BROWSER WITH THE COOKIE BUT NOT THE FLAG STILL HAS A SESSION.
 *
 * In a browser the refresh token is the HttpOnly `liaison_rt` cookie and the
 * `liaison:session` flag is the only thing that says it may exist, so a boot
 * without the flag never asked. A browser that keeps cookies but loses local
 * storage (an embedded browser, a cleared site storage, a privacy setting) was
 * therefore signed out on every visit while holding a perfectly good session:
 * that is what an approval link opened from Claude's own browser kept doing.
 *
 * So a boot ON A DEEP LINK (the link someone was sent, never the sign-in pages
 * or the bare root a logged-out visitor lands on) asks once. A refused cookie
 * is one 401 and the sign-in page it was heading to anyway, with its return
 * path; nothing is retried, and nothing is announced to other tabs.
 */
export async function probeCookieSession(): Promise<boolean> {
  if (mayRestore() || _accessToken()) return isAuthenticated()
  _setIsRestoringSession(true)
  try {
    await requestSessionRestore()
  } catch {
    // Not signed in here: the sign-in page follows, carrying the deep link.
  } finally {
    _setIsRestoringSession(false)
  }
  return isAuthenticated()
}

/** What a failed attempt does, once, whichever way it failed. */
function noteRestoreFailure(): void {
  // Network error, a status that is not a rejected credential, or no answer
  // at all inside the bound: under a shell that is an address the user has to
  // be able to see and change.
  _setIsRestoringSession(false)
  if (inWrappedShell()) _setServerUnreachable(true)
  scheduleRestoreRetry()
}

/**
 * Asks again NOW, on the user's say-so, and reports whether it got in.
 * The unreachable state is left standing until a session clears it, so the
 * login surface does not flicker between the message and the splash.
 */
export async function retryRestore(): Promise<boolean> {
  clearRestoreRetryWaiters()
  // A HUNG ATTEMPT IS WHAT THE USER IS CLICKING THROUGH. Waiting on it again
  // would make the button a second wait on the request that already failed
  // them, so it is dropped and the ask is a real new request.
  const pending = restorePromise
  if (pending) {
    restoreController?.abort()
    await pending.catch(() => undefined)
  }
  // The message is about the attempt that failed, and this is a new one: it
  // comes back only if this one fails too. The card keeps its shape while the
  // button spins (Login.tsx), so nothing the user is looking at moves.
  _setServerUnreachable(false)
  await restoreSession()
  return isAuthenticated()
}

export async function restoreSession(): Promise<void> {
  // A shell carries its own refresh token, so "no flag" is not "no session".
  if (!mayRestore()) {
    _setIsRestoringSession(false)
    return
  }

  // ONE ATTEMPT IN FLIGHT, EVER.
  //
  // The bound below is a bound on the WAIT, not on the request: a host that
  // is routed but dead leaves the POST hanging for as long as the platform's
  // own connect timeout, which is minutes. Releasing the slot at the timeout
  // and letting the five second loop start another would pile a new hanging
  // refresh on the old one every retry, so the slot is held until the
  // request itself settles and the timeout ABORTS rather than abandons it.
  // The loop is kept alive here rather than by the released slot.
  if (restorePromise) {
    scheduleRestoreRetry()
    return restorePromise
  }

  _setIsRestoringSession(true)

  let settled = false
  const failOnce = () => {
    if (settled) return
    settled = true
    noteRestoreFailure()
  }

  // A shell waits a bounded time and then says so. A browser does not: it was
  // served BY the server it is asking, and its splash is behind a page that
  // loaded, so the old unbounded wait is what it keeps.
  const controller =
    inWrappedShell() && typeof AbortController === "function" ? new AbortController() : null
  restoreController = controller
  const timer =
    inWrappedShell() && typeof setTimeout === "function"
      ? setTimeout(() => {
          // The UI is freed here even if the abort does not take (a fetch
          // that ignores its signal): the slot stays held, so nothing new is
          // sent, and the user has the message and the Try again button.
          controller?.abort()
          failOnce()
        }, RESTORE_TIMEOUT_MS)
      : null

  const attempt: Promise<void> = requestSessionRestore(controller?.signal)
    .then(() => {
      settled = true
    })
    .catch((error) => {
      if (error instanceof AuthRefreshError && error.kind === "invalid_credentials") {
        settled = true
        return
      }
      failOnce()
    })
    .finally(() => {
      if (timer !== null) clearTimeout(timer)
      // Identity guarded, both of them: a retry that dropped this attempt has
      // already put its own in the slot, and clearing it blindly would let a
      // third run alongside the second.
      if (restoreController === controller) restoreController = null
      if (restorePromise === attempt) restorePromise = null
    })
  restorePromise = attempt

  return attempt
}

function decodeJwtPayload(token: string): TokenPayload | null {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    // Use TextDecoder so multi-byte UTF-8 characters (e.g. non-ASCII names)
    // are decoded correctly rather than being corrupted by a bare atob() call.
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const payload = JSON.parse(new TextDecoder().decode(bytes))
    if (!payload || typeof payload !== "object") return null
    if (typeof payload.userId !== "string") return null
    if (typeof payload.orgId !== "string") return null
    if (!Array.isArray(payload.scopes)) return null
    if (!Array.isArray(payload.roles)) return null
    if (typeof payload.exp !== "number") return null
    if (typeof payload.name !== "string") return null
    return payload as TokenPayload
  } catch {
    return null
  }
}

export function userFromToken(): TokenPayload | null {
  const token = _accessToken()
  if (!token) return null
  return decodeJwtPayload(token)
}

/** The org this session is in (reactive), or null with no session. Per-org
 *  "once" flags key on it, so another org is a first arrival again. */
export function sessionOrgId(): string | null {
  return userFromToken()?.orgId ?? null
}

/** The session can only enroll a second factor (the org requires one of administrators). */
export function secondFactorRequired(): boolean {
  return userFromToken()?.secondFactorRequired === true
}

export function tokenExpiresAt(): number | null {
  const payload = userFromToken()
  return payload?.exp ?? null
}

/** Whether `granted` holds `scope`: the wildcard, the scope itself or a parent of it. */
export function scopeGranted(scope: string, granted: readonly string[]): boolean {
  return granted.some((s) => s === "*" || s === scope || scope.startsWith(`${s}:`))
}

export function hasScope(scope: string): boolean {
  const payload = userFromToken()
  if (!payload) return false
  if (payload.exp && Date.now() / 1000 >= payload.exp) return false
  return scopeGranted(scope, payload.scopes)
}

/**
 * Mirrors the backend `hasAppsAdmin` (modules/agent/tools/skills-routines-tools.ts):
 * org-admin authority over apps and org-shared skills/routines. Deliberately an
 * EXACT-membership test (`*`, `kernel:apps:admin`, or `kernel:apps`), NOT the
 * hierarchical `hasScope` — a bare `kernel` umbrella grant does not confer
 * apps-admin on the backend, so the UI must not claim it does. Kept byte-for-byte
 * with the server gate so an affordance shown on its say-so can never 403 on save.
 */
export function hasAppsAdmin(): boolean {
  const payload = userFromToken()
  if (!payload) return false
  if (payload.exp && Date.now() / 1000 >= payload.exp) return false
  const have = new Set(payload.scopes)
  return have.has("*") || have.has("kernel:apps:admin") || have.has("kernel:apps")
}

export function canAccessScope(scope?: string | null): boolean {
  return !scope || hasScope(scope)
}

if (bootMayRestore) {
  void restoreSession()
}

/** Tear down module-scoped resources (timers, event listeners, BroadcastChannel). Tests only. */
export function _teardownAuth(): void {
  lastSessionOrgId = null
  clearRestoreRetryWaiters()
  bc?.close()
  bc = null
}
