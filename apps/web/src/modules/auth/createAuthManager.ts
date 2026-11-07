// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  AuthRefreshError,
  type EnsureFreshTokenOptions,
  isInvalidRefreshStatus,
} from "~/lib/auth-refresh"
import {
  DEMO_DOOR_PATH,
  leaveDemoEndedNotice,
  noteIfDemoWorkspaceExpired,
  setDemoWorkspaceExit,
} from "~/lib/demo-expired"
import { authApiUrl } from "~/lib/env"
import { log } from "~/lib/logger"
import { noteIfOrgSuspended } from "~/lib/org-suspended"
import { runBeforeSignOut, teardownSession } from "~/lib/session-lifecycle"
import { clearLiaisonStorage } from "~/lib/storage"
import {
  accessToken,
  clearAuth,
  hasSession,
  isRestoringSession,
  restoreSession,
  setTokens,
  tokenExpiresAt,
} from "~/modules/auth/auth-store"
import { forgetNodeSession } from "~/modules/nodes/node-session"
import { signOutBrowserDevice } from "~/modules/notifications/browser-push"
import { desktopDeviceId, forgetDesktopDevice } from "~/modules/notifications/desktop-device"
import { DEVICE_ID_KEY } from "~/primitives/createWebSocket"

const TOKEN_REFRESH_MARGIN_S = 30

const authLog = log.child({ component: "AuthManager" })

/** Wait before retrying a refresh another tab won (its Set-Cookie has landed by then). */
const REFRESH_RACE_RETRY_MS = 250
/**
 * How long one refresh call may take. A refresh that never answers (a dead
 * connection after a resume) held every request waiting on it, for ever; past
 * this it fails as a transient error and those requests go their own way.
 */
const REFRESH_TIMEOUT_MS = 10_000
/** How long the sign-out call may take before the page signs out anyway. */
const LOGOUT_TIMEOUT_MS = 10_000

export interface AuthManagerOptions {
  refreshTimeoutMs?: number
  logoutTimeoutMs?: number
}

/** A signal that aborts after `ms`, and the timer's cleanup. */
function timeoutSignal(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("timed out")), ms)
  return { signal: controller.signal, done: () => clearTimeout(timer) }
}

export function createAuthManager(options: AuthManagerOptions = {}) {
  const refreshTimeoutMs = options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS
  const logoutTimeoutMs = options.logoutTimeoutMs ?? LOGOUT_TIMEOUT_MS
  // Instance-scoped to prevent cross-test leakage
  let refreshPromise: Promise<void> | null = null
  // Bumped by every sign-out: a refresh it overtook does not sign back in.
  let epoch = 0
  function isTokenExpired(): boolean {
    const exp = tokenExpiresAt()
    if (!exp) return true
    return Date.now() / 1000 >= exp - TOKEN_REFRESH_MARGIN_S
  }

  async function doRefresh(): Promise<void> {
    if (!hasSession()) {
      clearAuth()
      throw new AuthRefreshError("invalid_credentials", "No active session")
    }

    const started = epoch
    try {
      const post = async () => {
        const deadline = timeoutSignal(refreshTimeoutMs)
        try {
          return await fetch(authApiUrl("/refresh"), {
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
            signal: deadline.signal,
          })
        } finally {
          deadline.done()
        }
      }
      let res = await post()
      // 409: another tab of this browser rotated the shared cookie a moment ago
      // and the server left the rotated one in place. One retry picks it up.
      if (res.status === 409) {
        await new Promise((resolve) => setTimeout(resolve, REFRESH_RACE_RETRY_MS))
        res = await post()
      }

      if (!res.ok) {
        if (isInvalidRefreshStatus(res.status)) {
          authLog.warn({ status: res.status }, "Token refresh rejected, logging out")
          // A workspace that ended leaves for the demo door (lib/demo-expired.ts).
          await noteIfDemoWorkspaceExpired(res)
          // A suspended org's page is the suspended view (lib/org-suspended.ts).
          await noteIfOrgSuspended(res)
          clearAuth()
          throw new AuthRefreshError("invalid_credentials", "Refresh token rejected")
        }

        authLog.warn({ status: res.status }, "Token refresh failed, keeping session")
        throw new AuthRefreshError("transient", "Token refresh temporarily unavailable")
      }

      const json = await res.json()
      // OVERTAKEN BY A SIGN-OUT: the session this refresh renewed has ended
      // on this page, so its token is not taken up.
      if (epoch !== started) {
        throw new AuthRefreshError("invalid_credentials", "Signed out during the refresh")
      }
      const data = json.data ?? json
      if (!data?.accessToken) {
        throw new AuthRefreshError("transient", "Token refresh returned an invalid payload")
      }

      setTokens(data.accessToken)
      authLog.debug("Token refreshed")
    } catch (error) {
      if (error instanceof AuthRefreshError) throw error

      authLog.error({ err: error }, "Token refresh network error")
      throw new AuthRefreshError("transient", "Token refresh network error")
    }
  }

  async function ensureFreshToken(opts?: EnsureFreshTokenOptions): Promise<void> {
    // A REQUEST REFUSED WITH A TOKEN joins the refresh its burst already
    // started, and when that refresh has landed while it was in flight (the
    // page now holds another token) it is sent again with the new one, no
    // refresh at all. Forcing a second rotation for every late 401 of a burst
    // is what put a resuming app's session at risk: one refresh per burst.
    if (opts && "rejected" in opts) {
      if (refreshPromise) return refreshPromise
      const current = accessToken()
      if (current !== null && current !== opts.rejected) return
    }
    // `force` refreshes even when the token is not near expiry — required
    // after a WS 4010 (session_invalidated / permissionVersion bump), where
    // the current token is still temporally valid but carries stale claims.
    if (!opts?.force && !isTokenExpired()) return

    // If a session restore is in progress (cold load), piggyback on it
    // instead of firing a duplicate refresh request. A restore mints a brand
    // new token, so it satisfies `force` too.
    if (isRestoringSession()) {
      await restoreSession()
      if (!isTokenExpired()) return
    }

    // Deduplicate concurrent refresh attempts
    if (!refreshPromise) {
      refreshPromise = doRefresh().finally(() => {
        refreshPromise = null
      })
    }
    return refreshPromise
  }

  async function logout(): Promise<void> {
    epoch += 1
    // First, while the session still authenticates it: work that must land
    // before the sign-out (a decision still inside its Undo window is sent).
    await runBeforeSignOut()
    // The device signing out names itself (A7), so the server revokes its
    // receipt credential with the session; a browser also forgets its Web Push
    // device first, while the session still authorises it.
    // The desktop app names its install id (A44, P1-T6), never a page key.
    let deviceId: string | null = desktopDeviceId()
    if (!deviceId) {
      try {
        deviceId = localStorage.getItem(DEVICE_ID_KEY)
      } catch {
        deviceId = null
      }
    }
    await signOutBrowserDevice(accessToken()).catch(() => {})
    // BOUNDED: a sign-out that waits on a call that never answers is a user
    // who cannot sign out. The page signs out whatever the server says.
    const deadline = timeoutSignal(logoutTimeoutMs)
    try {
      await fetch(authApiUrl("/logout"), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken()}`,
        },
        body: JSON.stringify(deviceId ? { deviceId } : {}),
        signal: deadline.signal,
      })
    } catch {
      authLog.warn("Logout request failed")
    } finally {
      deadline.done()
    }
    await forgetDesktopDevice().catch(() => {})
    await forgetNodeSession().catch(() => {})
    clearAuth()
    // Reset all domain stores to prevent cross-session data leaks.
    // Stores self-register via onSessionTeardown() — no manual list needed.
    teardownSession()
    clearLiaisonStorage()
  }

  /**
   * The refresh in flight, when the token a request would carry is expired (or
   * about to be): that request waits for it. A request whose token is still
   * good goes straight away; a refresh forced for stale claims does not hold
   * it up, and a 401 to it joins that refresh then (`rejected`).
   */
  function pendingRefresh(): Promise<void> | null {
    return refreshPromise && isTokenExpired() ? refreshPromise : null
  }

  return { ensureFreshToken, pendingRefresh, logout }
}

type AuthManager = ReturnType<typeof createAuthManager>

/**
 * THE PAGE COMING BACK REFRESHES FIRST.
 *
 * A phone app resumed after a while in the background, a laptop waking, a tab
 * brought forward: the access token in memory has expired, and every store
 * that resyncs on that same moment fires its request with it. They all met a
 * 401 together and raced to refresh. So the first listener on the way back is
 * this one: an expired token starts the (single-flight) refresh synchronously,
 * and every request sent after it waits for that refresh instead
 * (api-client, `pendingRefresh`). A token that is still good costs nothing.
 *
 * Installed once, at page start, before the stores add listeners of their own,
 * so it runs ahead of them. Returns the uninstaller.
 */
export function installResumeRefresh(
  manager: Pick<AuthManager, "ensureFreshToken"> = authManager,
  doc: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> = document,
  win: Pick<Window, "addEventListener" | "removeEventListener"> = window,
): () => void {
  const refresh = () => {
    if (accessToken() === null) return
    void manager.ensureFreshToken().catch(() => {
      // Its outcome is the requests' to handle: a refused refresh has already
      // ended the session, a transient one is retried by the next 401.
    })
  }
  const onVisibility = () => {
    if (doc.visibilityState === "visible") refresh()
  }
  doc.addEventListener("visibilitychange", onVisibility)
  win.addEventListener("focus", refresh)
  win.addEventListener("online", refresh)
  return () => {
    doc.removeEventListener("visibilitychange", onVisibility)
    win.removeEventListener("focus", refresh)
    win.removeEventListener("online", refresh)
  }
}

export const authManager = createAuthManager()

/**
 * The demo workspace this tab is in has ended (lib/demo-expired.ts, once per
 * page). Its stores, tour and sockets stop now, the session is signed out
 * exactly as the sign-out button does it, and the page is replaced by the demo
 * door, which says why. A full load, so nothing of the old workspace keeps
 * running; the next page has no session, so it cannot come back here.
 */
export async function leaveEndedDemoWorkspace(
  goTo: (path: string) => void = (path) => window.location.replace(path),
): Promise<void> {
  teardownSession()
  try {
    await authManager.logout()
  } catch (err) {
    authLog.warn({ err }, "Sign-out of an ended demo workspace failed; leaving anyway")
    clearAuth()
    clearLiaisonStorage()
  }
  leaveDemoEndedNotice()
  goTo(DEMO_DOOR_PATH)
}

setDemoWorkspaceExit(() => {
  void leaveEndedDemoWorkspace()
})
