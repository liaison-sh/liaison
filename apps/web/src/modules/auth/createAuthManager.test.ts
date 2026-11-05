// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

describe("createAuthManager", () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(async () => {
    // Each test loads its own auth-store; an instance left listening on the
    // shared BroadcastChannel answers the NEXT test's login with a restore of
    // its own, and that test's fetch count goes with it.
    const { _teardownAuth } = await import("~/modules/auth/auth-store")
    _teardownAuth()
    vi.unstubAllGlobals()
  })

  // Another tab of this browser rotated the shared cookie a moment earlier: the
  // server answers 409 REFRESH_RACE and leaves the cookie (now the rotated one)
  // in place. One retry is a fresh session, not a sign-out.
  it("retries once on a 409 refresh race instead of signing out", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens, accessToken, hasSession } = await import("~/modules/auth/auth-store")
    const jwt = (exp: number) =>
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "T",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp,
      })
    setTokens(jwt(Math.floor(Date.now() / 1000) + 3600))
    const fresh = jwt(Math.floor(Date.now() / 1000) + 7200)
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "REFRESH_RACE" } }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { accessToken: fresh } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
    await createAuthManager().ensureFreshToken({ force: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(accessToken()).toBe(fresh)
    expect(hasSession()).toBe(true)
  })

  // The server rotates the refresh token as soon as it answers. A refresh the
  // page cancels (a navigation, a reload) loses the Set-Cookie carrying the
  // successor: the browser keeps the spent token and the session ends at the
  // next refresh (409 REFRESH_RACE, then 401). keepalive lets the request, and
  // its cookie, outlive the page that started it.
  it("sends every refresh with keepalive, so a navigation cannot drop the rotated cookie", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens } = await import("~/modules/auth/auth-store")
    const jwt = (exp: number) =>
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "T",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp,
      })
    setTokens(jwt(Math.floor(Date.now() / 1000) + 3600))
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: { accessToken: jwt(Math.floor(Date.now() / 1000) + 7200) } }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    )
    await createAuthManager().ensureFreshToken({ force: true })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("/refresh")
    expect(init.keepalive).toBe(true)
    expect(init.credentials).toBe("include")
  })

  it("restores a session with keepalive too (the cold-load refresh a reload races)", async () => {
    const { restoreSession, setTokens, accessToken } = await import("~/modules/auth/auth-store")
    const jwt = (exp: number) =>
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "T",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp,
      })
    setTokens(jwt(Math.floor(Date.now() / 1000) + 3600)) // sets the session flag
    const fresh = jwt(Math.floor(Date.now() / 1000) + 7200)
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    await restoreSession()
    const refreshCall = fetchMock.mock.calls.find(([u]) => String(u).includes("/refresh"))
    expect(refreshCall, "restoreSession made no refresh request").toBeTruthy()
    expect((refreshCall![1] as RequestInit).keepalive).toBe(true)
    expect(accessToken()).toBe(fresh)
  })

  it("refreshes token when access token is expired", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens, accessToken } = await import("~/modules/auth/auth-store")

    const expiredJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) - 60,
    })
    const freshJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    setTokens(expiredJwt)

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { accessToken: freshJwt } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const manager = createAuthManager()
    await manager.ensureFreshToken()

    expect(accessToken()).toBe(freshJwt)
  })

  it("deduplicates concurrent refresh calls", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens } = await import("~/modules/auth/auth-store")

    const expiredJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) - 60,
    })
    const freshJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    setTokens(expiredJwt)

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: freshJwt } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const manager = createAuthManager()
    await Promise.all([
      manager.ensureFreshToken(),
      manager.ensureFreshToken(),
      manager.ensureFreshToken(),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // A 401 that comes back after the refresh it triggered has landed names the
  // token it was refused with: that token is gone, so the request is simply
  // sent again with the new one, and nothing rotates a second time.
  it("does not refresh again for a 401 on a token a refresh already replaced", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens } = await import("~/modules/auth/auth-store")
    const jwt = (exp: number) =>
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "T",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp,
      })
    const stale = jwt(Math.floor(Date.now() / 1000) - 60)
    setTokens(jwt(Math.floor(Date.now() / 1000) + 3600))
    await createAuthManager().ensureFreshToken({ force: true, rejected: stale })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("joins the refresh in flight for a 401 on the current token, and forces one when none is", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens, accessToken } = await import("~/modules/auth/auth-store")
    const jwt = (exp: number) =>
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "T",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp,
      })
    const current = jwt(Math.floor(Date.now() / 1000) + 3600)
    const fresh = jwt(Math.floor(Date.now() / 1000) + 7200)
    setTokens(current)
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { accessToken: fresh } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )
    const manager = createAuthManager()
    const first = manager.ensureFreshToken({ force: true, rejected: current })
    // The token is still good, so the forced refresh holds no request up.
    expect(manager.pendingRefresh()).toBeNull()
    await Promise.all([first, manager.ensureFreshToken({ force: true, rejected: current })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(accessToken()).toBe(fresh)
    expect(manager.pendingRefresh()).toBeNull()
  })

  it("keeps auth state when token refresh hits a network failure", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens, accessToken, hasSession, isAuthenticated } = await import(
      "~/modules/auth/auth-store"
    )

    const expiredJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) - 60,
    })
    setTokens(expiredJwt)

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))

    const manager = createAuthManager()

    await expect(manager.ensureFreshToken()).rejects.toMatchObject({
      kind: "transient",
    })
    expect(isAuthenticated()).toBe(true)
    expect(accessToken()).toBe(expiredJwt)
    expect(hasSession()).toBe(true)
  })

  it("clears auth when the refresh token is rejected", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens, isAuthenticated, hasSession } = await import("~/modules/auth/auth-store")

    const expiredJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) - 60,
    })
    setTokens(expiredJwt)

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))

    const manager = createAuthManager()

    await expect(manager.ensureFreshToken()).rejects.toMatchObject({
      kind: "invalid_credentials",
    })
    expect(isAuthenticated()).toBe(false)
    expect(hasSession()).toBe(false)
  })

  it("does not refresh when token is still valid", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens } = await import("~/modules/auth/auth-store")

    const validJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(validJwt)

    const manager = createAuthManager()
    await manager.ensureFreshToken()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("refreshes when token is within 30s margin of expiry", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens } = await import("~/modules/auth/auth-store")

    // Token expires in 20 seconds — within the 30s margin
    const marginJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 20,
    })
    const freshJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })

    setTokens(marginJwt)

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { accessToken: freshJwt } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    )

    const manager = createAuthManager()
    await manager.ensureFreshToken()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not refresh when token expires in 31+ seconds", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens } = await import("~/modules/auth/auth-store")

    const safeJwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 60,
    })
    setTokens(safeJwt)

    const manager = createAuthManager()
    await manager.ensureFreshToken()

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("logout calls server and clears auth", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens, isAuthenticated } = await import("~/modules/auth/auth-store")

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

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: {} }), { status: 200 }))

    const manager = createAuthManager()
    await manager.logout()

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    )
    expect(isAuthenticated()).toBe(false)
  })

  // A decision still inside its Undo window is sent while the session still
  // authenticates it, not after the token is gone (a 401, the decision lost).
  it("logout runs the before-sign-out work first, while the token is still held", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens, accessToken } = await import("~/modules/auth/auth-store")
    const { onBeforeSignOut } = await import("~/lib/session-lifecycle")
    setTokens(
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "Test",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))
    const seen: { token: string | null; fetches: number }[] = []
    onBeforeSignOut(async () => {
      seen.push({ token: accessToken(), fetches: fetchMock.mock.calls.length })
    })
    await createAuthManager().logout()
    expect(seen).toHaveLength(1)
    expect(seen[0].token).not.toBeNull()
    expect(seen[0].fetches).toBe(0)
  })

  it("logout names this device so the server revokes its receipt credential (A7)", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens } = await import("~/modules/auth/auth-store")
    setTokens(
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "Test",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
    localStorage.setItem("liaison:deviceId", "dev-logout-1")
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))

    await createAuthManager().logout()

    const call = fetchMock.mock.calls.find(([url]) => url === "/api/auth/logout")
    expect(call).toBeDefined()
    expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
      deviceId: "dev-logout-1",
    })
    expect(localStorage.getItem("liaison:deviceId")).toBeNull()
  })

  it("the desktop app's logout names its install id, not a page key (A44, P1-T6)", async () => {
    const { createAuthManager } = await import("~/modules/auth/createAuthManager")
    const { setTokens } = await import("~/modules/auth/auth-store")
    const { installFakeBridge, uninstallFakeBridge } = await import("~/modules/desktop/fake-bridge")
    const { getDesktopBridge } = await import("~/lib/desktop-shell-contract")
    setTokens(
      makeJwt({
        userId: "u1",
        orgId: "o1",
        name: "Test",
        roles: [],
        scopes: [],
        dimensionGrants: {},
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    )
    installFakeBridge()
    try {
      Object.assign(getDesktopBridge() as unknown as Record<string, unknown>, {
        notificationDeviceId: () => "d.install-1",
      })
      // A stale browser-style key must not win over the install id.
      localStorage.setItem("liaison:deviceId", "page-key")
      fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200 }))

      await createAuthManager().logout()

      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/auth/logout"))
      expect(call).toBeDefined()
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        deviceId: "d.install-1",
      })
    } finally {
      uninstallFakeBridge()
    }
  })
})
