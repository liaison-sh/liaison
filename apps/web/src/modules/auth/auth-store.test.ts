// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { _resetRegistry, onSessionStart, onSessionTeardown } from "~/lib/session-lifecycle"
import {
  accessToken,
  clearAuth,
  hasAppsAdmin,
  hasScope,
  hasSession,
  isAuthenticated,
  isRestoringSession,
  probeCookieSession,
  sessionOrgId,
  setTokens,
  tokenExpiresAt,
  userFromToken,
} from "~/modules/auth/auth-store"

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

describe("auth-store", () => {
  beforeEach(() => {
    clearAuth()
    window.localStorage.clear()
  })

  it("setTokens announces the session start, so boot-gated hydration runs on login", () => {
    const started: number[] = []
    onSessionStart(() => started.push(1))
    setTokens(makeJwt({ userId: "u1", orgId: "o1", name: "Test", roles: [], scopes: [] }))
    expect(started).toHaveLength(1)
    _resetRegistry()
  })

  it("a session in another org tears the previous org's stores down first, even with no sign-out between", () => {
    const token = (orgId: string) =>
      makeJwt({
        userId: "u1",
        orgId,
        name: "Test",
        roles: [],
        scopes: [],
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    setTokens(token("org-a"))
    const events: string[] = []
    onSessionTeardown(() => events.push(`teardown:${sessionOrgId()}`))
    onSessionStart(() => events.push(`start:${sessionOrgId()}`))
    // A renewal in the same org is not a new session's state.
    setTokens(token("org-a"))
    // The session ends without the sign-out's teardown, then begins in org B.
    clearAuth()
    setTokens(token("org-b"))
    expect(events).toEqual(["start:org-a", "teardown:null", "start:org-b"])
    _resetRegistry()
  })

  it("starts unauthenticated", () => {
    expect(isAuthenticated()).toBe(false)
    expect(accessToken()).toBeNull()
    expect(hasSession()).toBe(false)
  })

  it("setTokens stores access token and sets session flag", () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt)
    expect(accessToken()).toBe(jwt)
    expect(hasSession()).toBe(true)
    expect(isAuthenticated()).toBe(true)
  })

  it("persists the session flag to localStorage", () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    setTokens(jwt)

    expect(window.localStorage.getItem("liaison:session")).toBe("1")
  })

  it("decodes user info from JWT payload", () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Alice",
      roles: ["admin"],
      scopes: ["kernel"],
      dimensionGrants: { department: ["sales"] },
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt)
    const user = userFromToken()
    expect(user).toEqual({
      userId: "u1",
      orgId: "o1",
      name: "Alice",
      roles: ["admin"],
      scopes: ["kernel"],
      dimensionGrants: { department: ["sales"] },
      exp: expect.any(Number),
    })
  })

  it("clearAuth resets all state", () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt)
    clearAuth()
    expect(isAuthenticated()).toBe(false)
    expect(accessToken()).toBeNull()
    expect(hasSession()).toBe(false)
    expect(window.localStorage.getItem("liaison:session")).toBeNull()
    expect(userFromToken()).toBeNull()
  })

  it("stops reporting session restoration once tokens are set", () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt)
    expect(isRestoringSession()).toBe(false)
  })

  it("tokenExpiresAt returns exp from JWT", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp,
    })
    setTokens(jwt)
    expect(tokenExpiresAt()).toBe(exp)
  })

  it("tokenExpiresAt returns null when not authenticated", () => {
    expect(tokenExpiresAt()).toBeNull()
  })

  it("hasScope matches exact scope", () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: ["kernel"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt)
    expect(hasScope("kernel")).toBe(true)
    expect(hasScope("crm")).toBe(false)
  })

  it("hasScope grants child scopes hierarchically", () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: ["kernel"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt)
    expect(hasScope("kernel:users")).toBe(true)
    expect(hasScope("kernel:users:read")).toBe(true)
    expect(hasScope("crm:contacts")).toBe(false)
  })

  it("hasScope returns false when not authenticated", () => {
    expect(hasScope("kernel")).toBe(false)
  })

  it("hasScope returns false when token is expired (G3)", () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: ["kernel"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) - 60,
    })
    setTokens(jwt)
    expect(hasScope("kernel")).toBe(false)
  })

  it("hasAppsAdmin is true for *, kernel:apps, kernel:apps:admin (exact membership)", () => {
    for (const scope of ["*", "kernel:apps", "kernel:apps:admin"]) {
      setTokens(
        makeJwt({
          userId: "u1",
          orgId: "o1",
          name: "Test",
          roles: [],
          scopes: [scope],
          dimensionGrants: {},
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      )
      expect(hasAppsAdmin()).toBe(true)
    }
  })

  it("hasAppsAdmin is FALSE for a bare kernel umbrella (mirrors backend exact-membership, not hierarchical)", () => {
    setTokens(
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "Test",
        roles: [],
        scopes: ["kernel"],
        dimensionGrants: {},
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
    // hasScope would say true hierarchically; hasAppsAdmin must not, matching the
    // server gate so the Edit affordance never over-promises then 403s on save.
    expect(hasScope("kernel:apps:admin")).toBe(true)
    expect(hasAppsAdmin()).toBe(false)
  })

  it("hasAppsAdmin is false when unauthenticated or expired", () => {
    expect(hasAppsAdmin()).toBe(false)
    setTokens(
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "Test",
        roles: [],
        scopes: ["kernel:apps:admin"],
        dimensionGrants: {},
        exp: Math.floor(Date.now() / 1000) - 60,
      }),
    )
    expect(hasAppsAdmin()).toBe(false)
  })
})

// BroadcastChannel tests need dynamic imports since bc is captured at module load time
describe("auth-store BroadcastChannel", () => {
  let mockPostMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    mockPostMessage = vi.fn()
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage = null
        postMessage = mockPostMessage
        close() {}
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("broadcasts login to other tabs via BroadcastChannel", async () => {
    const { setTokens: st } = await import("~/modules/auth/auth-store")
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    st(jwt)
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "login" }))
  })

  it("broadcasts logout to other tabs via BroadcastChannel", async () => {
    const { clearAuth: ca } = await import("~/modules/auth/auth-store")
    ca()
    expect(mockPostMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "logout" }))
  })

  it("receiving logout message clears auth state (J9)", async () => {
    let capturedOnMessage: ((e: MessageEvent) => void) | undefined
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: ((e: MessageEvent) => void) | null = null
        constructor() {
          // Capture the onmessage handler set by the module
          setTimeout(() => {
            if (this.onmessage) capturedOnMessage = this.onmessage
          }, 0)
        }
        postMessage() {}
        close() {}
      },
    )

    const store = await import("~/modules/auth/auth-store")
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: ["kernel"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    store.setTokens(jwt)
    expect(store.isAuthenticated()).toBe(true)

    // Wait for onmessage to be captured
    await new Promise((r) => setTimeout(r, 10))

    // Simulate receiving a logout message from another tab
    capturedOnMessage?.({ data: { type: "logout" } } as MessageEvent)
    expect(store.isAuthenticated()).toBe(false)
  })
})

describe("auth-store session restore", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    window.localStorage.clear()
    // Stub BroadcastChannel to prevent cross-test leakage from stale module instances
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage = null
        postMessage() {}
        close() {}
      },
    )
  })

  afterEach(async () => {
    // Clean up module-scoped resources (timers, online listeners, BroadcastChannel)
    try {
      const store = await import("~/modules/auth/auth-store")
      store._teardownAuth()
    } catch {
      /* module may not be loaded */
    }
    vi.unstubAllGlobals()
  })

  it("clears restoring flag on transient network failure (D1)", async () => {
    window.localStorage.setItem("liaison:session", "1")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

    const store = await import("~/modules/auth/auth-store")
    await Promise.resolve()

    expect(store.accessToken()).toBeNull()
    expect(store.hasSession()).toBe(true)
    expect(store.isRestoringSession()).toBe(false)
    expect(window.localStorage.getItem("liaison:session")).toBe("1")
  })

  it("retries restoration after the browser comes back online", async () => {
    window.localStorage.setItem("liaison:session", "1")
    const restoredJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { accessToken: restoredJwt } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    vi.stubGlobal("fetch", fetchMock)

    const store = await import("~/modules/auth/auth-store")

    // Wait until the first restore attempt has fully settled (fetch rejection
    // → .catch → scheduleRestoreRetry registers the "online" listener → .finally).
    // Only then is it safe to fire the online event. Extra timeout: under the
    // full-suite jsdom-worker load this settle can take >1s (default waitFor).
    await vi.waitFor(
      () => {
        expect(store.isRestoringSession()).toBe(false)
      },
      { timeout: 5000 },
    )

    window.dispatchEvent(new Event("online"))
    await vi.waitFor(
      () => {
        expect(store.accessToken()).toBe(restoredJwt)
      },
      { timeout: 5000 },
    )

    expect(store.hasSession()).toBe(true)
    expect(store.isRestoringSession()).toBe(false)
  })

  // P6d-FX9: a wrapped shell persists the refresh token natively and adds it
  // to the refresh call itself, so a cold start whose localStorage flag is
  // gone still holds a session. Gating the boot restore on the flag alone sent
  // it to the login screen instead.
  it("restores inside a wrapped shell with no stored flag", async () => {
    const restoredJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    // The shell publishes its address before the app's modules load, which is
    // what tells this page it is wrapped rather than in a browser.
    vi.stubGlobal("__LIAISON_SERVER_ADDRESS__", "https://box.example")
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: restoredJwt } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    vi.stubGlobal("fetch", fetchMock)
    expect(window.localStorage.getItem("liaison:session")).toBeNull()

    const store = await import("~/modules/auth/auth-store")

    await vi.waitFor(() => expect(store.accessToken()).toBe(restoredJwt), { timeout: 5000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain("/auth/refresh")
    expect(store.isAuthenticated()).toBe(true)
    // The flag is written on the way in, so the next boot needs no shell.
    expect(window.localStorage.getItem("liaison:session")).toBe("1")
  })

  it("a browser boot with no stored flag attempts no refresh at all", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const store = await import("~/modules/auth/auth-store")
    await Promise.resolve()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.isRestoringSession()).toBe(false)
  })

  it("clears auth when stored credentials are actually invalid", async () => {
    window.localStorage.setItem("liaison:session", "1")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })))

    const store = await import("~/modules/auth/auth-store")
    await Promise.resolve()

    expect(store.accessToken()).toBeNull()
    expect(store.hasSession()).toBe(false)
    expect(store.isRestoringSession()).toBe(false)
    expect(window.localStorage.getItem("liaison:session")).toBeNull()
  })
})

describe("probeCookieSession", () => {
  beforeEach(() => {
    clearAuth()
    window.localStorage.clear()
  })
  afterEach(() => vi.unstubAllGlobals())

  it("signs in from the refresh cookie when the stored flag is gone", async () => {
    const jwt = makeJwt({ userId: "u1", orgId: "o1", name: "T", roles: [], scopes: [] })
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: { accessToken: jwt } })),
    )
    vi.stubGlobal("fetch", fetchMock)
    expect(hasSession()).toBe(false)
    expect(await probeCookieSession()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(accessToken()).toBe(jwt)
    expect(isRestoringSession()).toBe(false)
  })

  it("a refused cookie leaves the visitor signed out, without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }))
    vi.stubGlobal("fetch", fetchMock)
    expect(await probeCookieSession()).toBe(false)
    expect(isAuthenticated()).toBe(false)
    expect(isRestoringSession()).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
