// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-FX11: A SHELL BOUND TO A SERVER THAT DOES NOT ANSWER.
//
// The desktop shell mirrors the last address it bound into the page, so a
// stale one (a dev server that is gone, a VPN that is off, a server that
// moved) is where the boot refresh goes. It used to end at a "Restoring
// session" splash that never lifted, with the connect card that is the only
// way out sitting behind it.
//
// These cases drive the real path: the shell global, a refresh that does not
// arrive, and the surfaces that have to say so. Modules are imported
// dynamically because the store runs its boot restore AT IMPORT.
//
// The two SURFACE cases below assert nothing about the store: they read the
// rendered text and the route, so they stay red if ProtectedRoute and Login
// were put back the way they were while the store kept everything it exports.

import { render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const SHELL_ADDRESS = "http://127.0.0.1:18080"
const UNREACHABLE_LINE =
  "Liaison at 127.0.0.1:18080 is not answering yet. Check the address or try again."

function stubBroadcastChannel(): void {
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage = null
      postMessage() {}
      close() {}
    },
  )
}

/** A page the shell has published its address into: a wrapped shell. */
function stubShell(): void {
  vi.stubGlobal("__LIAISON_SERVER_ADDRESS__", SHELL_ADDRESS)
  stubBroadcastChannel()
}

function jwt(): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function sessionResponse(): Response {
  return new Response(JSON.stringify({ data: { accessToken: jwt() } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

async function loadStore() {
  return await import("~/modules/auth/auth-store")
}

describe("wrapped shell, server unreachable", () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    // The URL a case starts on is part of the case: jsdom keeps whatever the
    // last render navigated to, and a routing assertion against a leftover
    // URL asserts nothing.
    window.history.replaceState(null, "", "/")
  })

  afterEach(async () => {
    try {
      const store = await loadStore()
      store.clearAuth()
      store._teardownAuth()
    } catch {
      /* module may not be loaded */
    }
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it("a network error under a shell stops the restore and says the server is unreachable", async () => {
    window.localStorage.setItem("liaison:session", "1")
    stubShell()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

    const store = await loadStore()

    await vi.waitFor(() => expect(store.serverUnreachable()).toBe(true), { timeout: 5000 })
    expect(store.isRestoringSession()).toBe(false)
    // The credentials were never rejected, so the session flag stands and the
    // retry loop keeps going behind the message.
    expect(store.hasSession()).toBe(true)
  })

  it("a server that never answers gives up on the splash after the bounded wait", async () => {
    vi.useFakeTimers()
    window.localStorage.setItem("liaison:session", "1")
    stubShell()
    // No answer at all: the promise never settles, the way a routed but dead
    // address behaves until the platform's own connect timeout.
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})))

    const store = await loadStore()
    expect(store.isRestoringSession()).toBe(true)

    // Nothing is claimed before the bound is up: a slow server is not a dead one.
    await vi.advanceTimersByTimeAsync(29_000)
    expect(store.serverUnreachable()).toBe(false)
    expect(store.isRestoringSession()).toBe(true)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(store.isRestoringSession()).toBe(false)
    expect(store.serverUnreachable()).toBe(true)
  })

  it("a server answering inside the bound never raises the message at all", async () => {
    vi.useFakeTimers()
    window.localStorage.setItem("liaison:session", "1")
    stubShell()
    // Twelve seconds: slow, and well inside what a cold server behind a
    // tunnel costs. The user must see no flicker of a failure that did not
    // happen.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            setTimeout(() => resolve(sessionResponse()), 12_000)
          }),
      ),
    )

    const store = await loadStore()
    await vi.advanceTimersByTimeAsync(13_000)

    expect(store.isAuthenticated()).toBe(true)
    expect(store.serverUnreachable()).toBe(false)
    expect(store.isRestoringSession()).toBe(false)

    await vi.advanceTimersByTimeAsync(40_000)
    expect(store.serverUnreachable()).toBe(false)
  })

  it("a hung server never stacks up refreshes: one attempt in flight, whatever the loop does", async () => {
    vi.useFakeTimers()
    window.localStorage.setItem("liaison:session", "1")
    stubShell()
    // A fetch that ignores its abort signal, which is the worst case: the
    // slot has to be held by the store rather than by the request.
    const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}))
    vi.stubGlobal("fetch", fetchMock)

    const store = await loadStore()
    // The bound lifts the splash at 30s and the retry loop then runs four
    // more times inside this window.
    await vi.advanceTimersByTimeAsync(60_000)

    expect(store.serverUnreachable()).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("a browser keeps the old behaviour: no unreachable state, splash stays up", async () => {
    window.localStorage.setItem("liaison:session", "1")
    stubBroadcastChannel()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

    const store = await loadStore()

    await vi.waitFor(() => expect(store.isRestoringSession()).toBe(false), { timeout: 5000 })
    expect(store.serverUnreachable()).toBe(false)
  })

  it("a late answer from the retry loop still signs the user in", async () => {
    window.localStorage.setItem("liaison:session", "1")
    stubShell()
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(sessionResponse())
    vi.stubGlobal("fetch", fetchMock)

    const store = await loadStore()
    await vi.waitFor(() => expect(store.serverUnreachable()).toBe(true), { timeout: 5000 })

    expect(await store.retryRestore()).toBe(true)
    expect(store.isAuthenticated()).toBe(true)
    // The session clears the message: nothing is left saying the server is down.
    expect(store.serverUnreachable()).toBe(false)
  })

  it("ProtectedRoute drops the splash and routes to the connect surface", async () => {
    // NOTHING FROM THE STORE IS READ HERE. The page is put in the state the
    // user was in (a shell address, a stored session, a refresh that fails)
    // and the assertions are the rendered text and the route, so this case
    // stays red if the guard were put back the way it was.
    window.localStorage.setItem("liaison:session", "1")
    stubShell()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

    // The router is imported HERE, not at the top: `vi.resetModules()` gives
    // the dynamically imported component a fresh copy of every module, and a
    // <Router> from the stale copy is a different context object, which the
    // component sees as no router at all.
    const { Route, Router, useLocation } = await import("@solidjs/router")
    const { ProtectedRoute } = await import("~/modules/auth/ProtectedRoute")
    // /login is its OWN route, outside the guard, exactly as the app has it:
    // a catch-all that kept the guard mounted on its own destination would
    // bounce forever and bury the run in redirect rejections.
    let where = ""
    render(() => (
      <Router>
        <Route
          path="/login"
          component={() => {
            const loc = useLocation()
            where = `${loc.pathname}${loc.search}`
            return <div>Login page</div>
          }}
        />
        <Route
          path="*"
          component={() => (
            <ProtectedRoute>
              <div>Protected content</div>
            </ProtectedRoute>
          )}
        />
      </Router>
    ))

    await vi.waitFor(() => expect(screen.queryByText("Login page")).toBeInTheDocument(), {
      timeout: 5000,
    })
    expect(where).toContain("/login?returnTo=")
    // The stored session flag still stands and the retry loop is still
    // running: neither is a reason to hold the splash over the only screen
    // that can change the address.
    expect(screen.queryByText("Restoring session…")).not.toBeInTheDocument()
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument()
  })

  it("the login card names the server, offers the connect field and keeps the email form", async () => {
    window.localStorage.setItem("liaison:session", "1")
    stubShell()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    await loadStore()

    window.history.replaceState(null, "", "/login")
    const { installFakeBridge, uninstallFakeBridge } = await import("~/modules/desktop/fake-bridge")
    // The shell is bound to the stale address, which is the whole defect: the
    // connect card was hidden precisely because an address was on file.
    installFakeBridge({}, { serverAddress: SHELL_ADDRESS })
    try {
      const { Route, Router } = await import("@solidjs/router")
      const { default: Login } = await import("~/modules/auth/Login")
      render(() => (
        <Router>
          <Route path="*" component={Login} />
        </Router>
      ))

      await vi.waitFor(() => expect(screen.getByText(UNREACHABLE_LINE)).toBeInTheDocument(), {
        timeout: 5000,
      })
      expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument()
      // The way out: the connect field, which a bound address used to hide.
      expect(screen.getByLabelText("Liaison org URL")).toBeInTheDocument()
      // And the account this install signs into has not changed, so the
      // ordinary form is still there rather than swapped away.
      expect(screen.getByPlaceholderText("you@company.com")).toBeInTheDocument()
    } finally {
      uninstallFakeBridge()
    }
  })

  it("a shell with no address field to offer does not tell the user to check the address", async () => {
    window.localStorage.setItem("liaison:session", "1")
    // A wrapped shell with no desktop bridge: the mobile app, whose server is
    // bound somewhere else entirely.
    stubShell()
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))
    await loadStore()

    window.history.replaceState(null, "", "/login")
    const { Route, Router } = await import("@solidjs/router")
    const { default: Login } = await import("~/modules/auth/Login")
    render(() => (
      <Router>
        <Route path="*" component={Login} />
      </Router>
    ))

    await vi.waitFor(
      () =>
        expect(
          screen.getByText(
            "Liaison at 127.0.0.1:18080 is not answering yet. Try again in a moment.",
          ),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    )
    expect(screen.queryByText(UNREACHABLE_LINE)).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Liaison org URL")).not.toBeInTheDocument()
  })

  it("a signed-in browser tab sitting on /login is left where its user put it", async () => {
    // A browser (no shell global) whose stored session restores cleanly: the
    // page is signed in within a tick of mounting, exactly as a tab is when
    // another tab signs in.
    window.localStorage.setItem("liaison:session", "1")
    stubBroadcastChannel()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sessionResponse()),
    )

    window.history.replaceState(null, "", "/login")
    const { Route, Router } = await import("@solidjs/router")
    const { default: Login } = await import("~/modules/auth/Login")
    render(() => (
      <Router>
        <Route path="/" component={() => <div>Workspace</div>} />
        <Route path="*" component={Login} />
      </Router>
    ))

    // Nothing took this tab to /login, so nothing takes it away from it.
    await vi.waitFor(() => expect(screen.getByTestId("auth-card")).toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(screen.queryByText("Workspace")).not.toBeInTheDocument()
  })
})
