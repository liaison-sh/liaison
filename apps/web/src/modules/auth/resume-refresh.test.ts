// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SESSION SURVIVES THE APP COMING BACK.
//
// A phone app resumed from the background holds an expired access token, and
// every store that resyncs on that moment sends its request with it: a dozen
// 401s at once, some of them answered only after the refresh they triggered
// has already landed. The real auth store, auth manager and API client are
// wired together here as the page wires them; only the network is a fake
// server that rotates its refresh token on every refresh.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

function makeJwt(exp: number, n: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "T",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp,
      n,
    }),
  )
  return `${header}.${body}.sig`
}

const nowS = () => Math.floor(Date.now() / 1000)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface FakeServer {
  refreshCalls: number
  /** Every request (not refresh) seen, with the bearer it carried. */
  requests: Array<{ path: string; bearer: string | null }>
  /** The refresh cookie this browser holds. */
  jar: { cookie: string }
  /** True once a spent token's replay revoked the whole family. */
  revoked: boolean
  /** Moves the server's clock (the race and lost-response windows). */
  advance: (ms: number) => void
}

/**
 * The server, with the API's rotation rule for the refresh COOKIE (apps/api
 * modules/auth auth.ts refreshSession, routes.ts): every refresh spends the
 * presented token and sets its successor in the jar. A spent token presented
 * under 30 s after its successor was issued is a race (409, nothing changes);
 * after that, a spent token whose successor was used (a request authenticated
 * with its access token, or a refresh of it) or past the 3 minute window
 * revokes the family (401), and every access token of it stops working. Only
 * access tokens it minted, of a family not revoked, are accepted: `expired`
 * never is. A refresh answers after `refreshMs`; `refreshStatus` other than
 * 200 refuses it. A refused request answers after the delay its path names in
 * `rejectDelays`, so some 401s come back after the refresh has landed.
 */
function fakeServer(opts: {
  expired: string
  refreshMs: number
  refreshStatus?: number
  rejectDelays?: Record<string, number>
}): FakeServer {
  let skew = 0
  const now = () => Date.now() + skew
  interface Row {
    successor: string | null
    issuedAt: number
    access: string | null
    used: boolean
  }
  const rows = new Map<string, Row>([
    ["rt-0", { successor: null, issuedAt: 0, access: null, used: false }],
  ])
  const byAccess = new Map<string, string>()
  const server: FakeServer = {
    refreshCalls: 0,
    requests: [],
    jar: { cookie: "rt-0" },
    revoked: false,
    advance: (ms) => {
      skew += ms
    },
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  const mint = (): string => {
    const refresh = `rt-${server.refreshCalls}`
    const access = makeJwt(nowS() + 900, server.refreshCalls)
    rows.set(refresh, { successor: null, issuedAt: 0, access, used: false })
    byAccess.set(access, refresh)
    server.jar.cookie = refresh
    return access
  }
  const refresh = (): Response => {
    const presented = server.jar.cookie
    const row = rows.get(presented)
    if (server.revoked || !row) return json(401, { error: { code: "INVALID_SESSION" } })
    if (row.successor === null) {
      const access = mint()
      row.successor = server.jar.cookie
      row.issuedAt = now()
      return json(200, { data: { accessToken: access } })
    }
    if (now() - row.issuedAt < 30_000) return json(409, { error: { code: "REFRESH_RACE" } })
    const successor = rows.get(row.successor)
    if (
      !successor ||
      successor.used ||
      successor.successor !== null ||
      now() - row.issuedAt > 180_000
    ) {
      server.revoked = true
      return json(401, { error: { code: "INVALID_SESSION" } })
    }
    const access = mint()
    row.successor = server.jar.cookie
    row.issuedAt = now()
    return json(200, { data: { accessToken: access } })
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/auth/refresh")) {
        server.refreshCalls += 1
        await sleep(opts.refreshMs)
        if ((opts.refreshStatus ?? 200) !== 200) {
          return json(opts.refreshStatus ?? 401, { error: { code: "INVALID_SESSION" } })
        }
        // Rotated on the server's side once the call is answered: a refresh of
        // the jar's token, read when it ARRIVES, as a browser sends its cookie.
        return refresh()
      }
      const path = new URL(url, "http://localhost").pathname
      const auth = new Headers(init?.headers).get("Authorization")
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null
      server.requests.push({ path, bearer })
      const family = bearer === null ? undefined : byAccess.get(bearer)
      const row = family === undefined ? undefined : rows.get(family)
      if (row && !server.revoked) {
        row.used = true
        return json(200, { data: { ok: path } })
      }
      await sleep(opts.rejectDelays?.[path] ?? 0)
      return json(401, { error: { code: "invalid_token" } })
    }),
  )
  return server
}

/**
 * A network whose refresh never answers until it is aborted (or `release`d),
 * while every request with `good` is accepted.
 */
function stalledRefreshNetwork(good: string) {
  let release: (token: string) => void = () => {}
  const seen: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input)
      seen.push(new URL(url, "http://localhost").pathname)
      if (url.includes("/auth/refresh") || url.includes("/auth/logout")) {
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("timeout", "TimeoutError")),
          )
          if (url.includes("/auth/refresh")) {
            release = (token) =>
              resolve(
                new Response(JSON.stringify({ data: { accessToken: token } }), {
                  status: 200,
                  headers: { "Content-Type": "application/json" },
                }),
              )
          }
        })
      }
      const bearer = new Headers(init?.headers).get("Authorization")
      const ok = bearer === `Bearer ${good}`
      return Promise.resolve(
        new Response(
          JSON.stringify(ok ? { data: { ok: true } } : { error: { code: "invalid_token" } }),
          {
            status: ok ? 200 : 401,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
    }),
  )
  return { seen, release: (token: string) => release(token) }
}

/** `promise`, or "hung" when it has not settled within `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | "hung"> {
  return Promise.race([
    promise,
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ms)),
  ])
}

async function wire(options: { refreshTimeoutMs?: number; logoutTimeoutMs?: number } = {}) {
  const store = await import("~/modules/auth/auth-store")
  const { createAuthManager } = await import("~/modules/auth/createAuthManager")
  const { createApiClient } = await import("~/lib/api-client")
  const manager = createAuthManager(options)
  const onUnauthorized = vi.fn(() => store.clearAuth())
  const api = createApiClient({
    getAccessToken: store.accessToken,
    ensureFreshToken: manager.ensureFreshToken,
    pendingRefresh: manager.pendingRefresh,
    onUnauthorized,
    baseUrl: "/api",
  })
  return { store, manager, api, onUnauthorized }
}

// The burst the production trace showed, by path.
const BURST = [
  "/api/nodes/me",
  "/api/push/tokens",
  "/api/me/node-sessions",
  "/api/threads/a",
  "/api/threads/b",
  "/api/threads/c",
  "/api/threads/d",
  "/api/threads/e",
  "/api/threads/f",
  "/api/threads/g",
  "/api/threads/h",
  "/api/threads/i",
]

describe("a session on resume", () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
  })
  afterEach(async () => {
    const { _teardownAuth } = await import("~/modules/auth/auth-store")
    _teardownAuth()
    vi.unstubAllGlobals()
  })

  it("stays signed in when a burst of requests meets 401 while the refresh succeeds, with ONE refresh", async () => {
    const expired = makeJwt(nowS() - 60, 0)
    // Half the 401s come back before the refresh lands (40 ms), half after.
    const rejectDelays = Object.fromEntries(BURST.map((p, i) => [p, i % 2 === 0 ? 5 : 80]))
    const server = fakeServer({ expired, refreshMs: 40, rejectDelays })
    const { store, api, onUnauthorized } = await wire()
    store.setTokens(expired)

    const results = await Promise.allSettled(
      BURST.map((p, i) =>
        i % 3 === 0 ? api.post(p.replace(/^\/api/, ""), {}) : api.get(p.replace(/^\/api/, "")),
      ),
    )

    expect(results.map((r) => r.status)).toEqual(BURST.map(() => "fulfilled"))
    expect(store.isAuthenticated()).toBe(true)
    expect(store.hasSession()).toBe(true)
    expect(onUnauthorized).not.toHaveBeenCalled()
    // One rotation for the whole burst: a late 401 joins it, never a second one.
    expect(server.refreshCalls).toBe(1)
    expect(server.revoked).toBe(false)
    // Each request was sent at most twice: once refused, once retried.
    for (const p of BURST) {
      expect(server.requests.filter((r) => r.path === p).length).toBeLessThanOrEqual(2)
    }
  })

  it("signs out when the refresh itself is refused", async () => {
    const expired = makeJwt(nowS() - 60, 0)
    fakeServer({ expired, refreshMs: 10, refreshStatus: 401 })
    const { store, api } = await wire()
    store.setTokens(expired)

    const results = await Promise.allSettled(BURST.slice(0, 4).map((p) => api.get(p.slice(4))))

    expect(results.every((r) => r.status === "rejected")).toBe(true)
    expect(store.isAuthenticated()).toBe(false)
    expect(store.hasSession()).toBe(false)
  })

  it("does not sign out on a 401 to the resend after a refresh that succeeded", async () => {
    const { createApiClient } = await import("~/lib/api-client")
    const onUnauthorized = vi.fn()
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: "invalid_token" } }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    )
    const api = createApiClient({
      getAccessToken: () => "token",
      onUnauthorized,
      ensureFreshToken: vi.fn().mockResolvedValue(undefined),
      baseUrl: "/api",
    })
    await expect(api.get("/nodes/me")).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it("refreshes when the page becomes visible, before the requests that follow it", async () => {
    const { installResumeRefresh } = await import("~/modules/auth/createAuthManager")
    const expired = makeJwt(nowS() - 60, 0)
    const server = fakeServer({ expired, refreshMs: 30, rejectDelays: {} })
    const { store, manager, api } = await wire()
    store.setTokens(expired)
    const uninstall = installResumeRefresh(manager, document, window)
    try {
      // The page comes back: the auth listener runs first, the stores' resync
      // fires its burst in the same tick.
      document.dispatchEvent(new Event("visibilitychange"))
      const results = await Promise.all(BURST.slice(0, 5).map((p) => api.get(p.slice(4))))
      expect(results).toHaveLength(5)
      expect(server.refreshCalls).toBe(1)
      // No request went out with the expired token: they waited for the refresh.
      expect(server.requests.some((r) => r.bearer === expired)).toBe(false)
      expect(store.isAuthenticated()).toBe(true)
      expect(server.revoked).toBe(false)
    } finally {
      uninstall()
    }
  })

  // The double is only worth something if it refuses what the API refuses: a
  // spent token presented after its successor was used ends the session.
  it("signs out when a spent refresh token comes back after its successor was used", async () => {
    const expired = makeJwt(nowS() - 60, 0)
    const server = fakeServer({ expired, refreshMs: 1 })
    const { store, api } = await wire()
    store.setTokens(expired)
    await api.get("/threads/a")
    expect(server.refreshCalls).toBe(1)
    // The browser kept the spent cookie (a lost Set-Cookie), the successor
    // has authenticated a request, and the race window is long past.
    server.jar.cookie = "rt-0"
    server.advance(31_000)
    store.setTokens(makeJwt(nowS() - 60, 99))
    await expect(api.get("/threads/b")).rejects.toMatchObject({ status: 401 })
    expect(server.revoked).toBe(true)
    expect(store.isAuthenticated()).toBe(false)
  })

  // A REFRESH THAT DOES NOT COME BACK holds up nothing that does not need it.
  it("sends a request with a valid token straight away while a refresh is stalled", async () => {
    const good = makeJwt(nowS() + 900, 0)
    stalledRefreshNetwork(good)
    const { store, manager, api } = await wire()
    store.setTokens(good)
    // A forced refresh (stale claims after a 4010) that never answers.
    void manager.ensureFreshToken({ force: true }).catch(() => undefined)
    expect(manager.pendingRefresh()).toBeNull()
    const result = await within(api.get("/threads/a"), 500)
    expect(result).not.toBe("hung")
  })

  it("fails a request with an expired token once the refresh times out, and keeps the session", async () => {
    const expired = makeJwt(nowS() - 60, 0)
    stalledRefreshNetwork("none")
    const { store, api } = await wire({ refreshTimeoutMs: 50 })
    store.setTokens(expired)
    const result = await within(
      api.get("/threads/a").then(
        () => "ok",
        (error: unknown) => error,
      ),
      1_000,
    )
    expect(result).not.toBe("hung")
    expect(result).not.toBe("ok")
    // A refresh that timed out is transient: the session is not ended over it.
    expect(store.hasSession()).toBe(true)
  })

  // A sign-out is never held hostage by the network, and a refresh it overtook
  // does not sign the user back in when it finally lands.
  it("signs out within its bound while a refresh is stalled, and stays signed out", async () => {
    const expired = makeJwt(nowS() - 60, 0)
    const network = stalledRefreshNetwork("none")
    const { store, manager } = await wire({ logoutTimeoutMs: 50 })
    store.setTokens(expired)
    const refreshing = manager.ensureFreshToken().catch(() => undefined)
    const outcome = await within(
      manager.logout().then(() => "signed out"),
      1_000,
    )
    expect(outcome).toBe("signed out")
    expect(store.isAuthenticated()).toBe(false)
    network.release(makeJwt(nowS() + 900, 1))
    await refreshing
    expect(store.isAuthenticated()).toBe(false)
  })

  it("costs nothing on resume while the token is still good", async () => {
    const { installResumeRefresh } = await import("~/modules/auth/createAuthManager")
    const fresh = makeJwt(nowS() + 900, 0)
    const server = fakeServer({ expired: "none", refreshMs: 1 })
    const { store, manager } = await wire()
    store.setTokens(fresh)
    const uninstall = installResumeRefresh(manager, document, window)
    try {
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("focus"))
      await sleep(5)
      expect(server.refreshCalls).toBe(0)
    } finally {
      uninstall()
    }
  })
})
