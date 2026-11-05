// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tab open in a demo workspace that ends: the first `demo_workspace_expired`
// answer (REST, token refresh or the socket) leaves the workspace ONCE, signs
// the session out, lands on the demo door and says why. No toast, no login page,
// no second exit for the answers racing the first.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApiClient } from "~/lib/api-client"
import {
  _resetDemoWorkspaceEnded,
  consumeDemoEndedNotice,
  DEMO_DOOR_PATH,
  demoWorkspaceEnded,
  setDemoWorkspaceExit,
} from "~/lib/demo-expired"
import { accessToken, clearAuth, hasSession, setTokens } from "~/modules/auth/auth-store"
import { authManager, leaveEndedDemoWorkspace } from "~/modules/auth/createAuthManager"
import { DemoEntry } from "~/modules/demo/DemoEntry"
import { I18nProvider } from "~/modules/i18n/i18n-context"

function jwt(): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Visitor",
      roles: ["admin"],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function expired(): Response {
  return new Response(
    JSON.stringify({
      error: { message: "This demo workspace has expired.", code: "demo_workspace_expired" },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } },
  )
}

describe("a demo workspace that ends under an open tab", () => {
  const goTo = vi.fn()
  const exit = vi.fn(() => leaveEndedDemoWorkspace(goTo))

  beforeEach(() => {
    _resetDemoWorkspaceEnded()
    goTo.mockReset()
    exit.mockClear()
    setDemoWorkspaceExit(exit)
    sessionStorage.clear()
    setTokens(jwt())
    sessionStorage.setItem("liaison:tour", "mid-scenario")
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    clearAuth()
    _resetDemoWorkspaceEnded()
  })

  it("leaves once: session cleared, the door, no toast and no login page", async () => {
    // Every request is refused the way the server refuses an ended workspace,
    // the refresh and the sign-out included.
    const fetchMock = vi.fn(async () => expired())
    vi.stubGlobal("fetch", fetchMock)
    const onError = vi.fn()
    const onUnauthorized = vi.fn()
    const api = createApiClient({
      getAccessToken: accessToken,
      ensureFreshToken: authManager.ensureFreshToken,
      onUnauthorized,
      onError,
    })

    await expect(api.get("/api/threads")).rejects.toMatchObject({
      status: 403,
      code: "demo_workspace_expired",
    })
    // A poll racing the exit, and a refresh refused with the same code.
    await api.get("/api/attention").catch(() => undefined)
    await authManager.ensureFreshToken({ force: true }).catch(() => undefined)
    await vi.waitFor(() => expect(goTo).toHaveBeenCalled())

    expect(demoWorkspaceEnded()).toBe(true)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(goTo).toHaveBeenCalledTimes(1)
    expect(goTo).toHaveBeenCalledWith(DEMO_DOOR_PATH)
    // Signed out as the sign-out button does it: no token, no session, the
    // workspace's own storage gone.
    expect(accessToken()).toBeNull()
    expect(hasSession()).toBe(false)
    expect(sessionStorage.getItem("liaison:tour")).toBeNull()
    expect(onError).not.toHaveBeenCalled()
    expect(onUnauthorized).not.toHaveBeenCalled()
    // The poll that raced the exit never reached the network.
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]))
    expect(urls.filter((u) => u.includes("/api/attention"))).toHaveLength(0)
  })

  it("the door says why the visitor is there, once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => expired()),
    )
    await leaveEndedDemoWorkspace(goTo)
    render(() => (
      <I18nProvider initialLocale="en">
        <Router>
          <Route path="*" component={() => <DemoEntry />} />
        </Router>
      </I18nProvider>
    ))
    expect(screen.getByTestId("demo-workspace-ended").textContent).toBe(
      "This demo workspace has ended. Start a new one below.",
    )
    // Read once: a reload of the door no longer shows it.
    expect(consumeDemoEndedNotice()).toBe(false)
  })

  it("an ordinary 403 is left alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "Forbidden", code: "FORBIDDEN" } }), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    )
    const onError = vi.fn()
    const api = createApiClient({ getAccessToken: accessToken, onUnauthorized: vi.fn(), onError })
    await api.get("/api/threads").catch(() => undefined)
    expect(demoWorkspaceEnded()).toBe(false)
    expect(exit).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
