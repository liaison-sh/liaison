// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import App, { AppErrorFallback } from "~/App"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.fake`
}

describe("App", () => {
  beforeEach(() => {
    clearAuth()
    // Reset URL to root — jsdom persists location between tests
    window.history.pushState({}, "", "/")
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders login page when unauthenticated", async () => {
    render(() => <App />)
    await waitFor(() => {
      expect(screen.getByText("Liaison")).toBeInTheDocument()
      expect(screen.getByText("Sign in to your workspace")).toBeInTheDocument()
    })
  })

  it("renders shell when authenticated", async () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: ["kernel"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt, "refresh")

    render(() => <App />)
    await waitFor(() => {
      expect(screen.getByTestId("activity-bar")).toBeInTheDocument()
    })
  })

  // The API hands every device grant a verificationUri of
  // `<base>/auth/device?code=<userCode>`. When this route was missing, that
  // link fell through to `/*` and the user landed on Home with nothing to
  // approve, which is exactly what shipped in desktop 0.1.0.
  it("routes /auth/device to the device approval page, not the shell", async () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: ["kernel"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt, "refresh")
    window.history.pushState({}, "", "/auth/device?code=TC9NYDAJ")

    render(() => <App />)
    await waitFor(() => {
      expect(screen.getByTestId("device-approval-card")).toBeInTheDocument()
    })
    expect(screen.queryByTestId("activity-bar")).not.toBeInTheDocument()
  })
})

// The root boundary is the LAST guard: whatever escapes every local boundary
// lands here, and it has to paint a way out. It used to offer only `reset`,
// which re-renders the very shell that threw; a shell that throws on every
// render then had no exit at all.
describe("AppErrorFallback - the root boundary always paints a way out", () => {
  afterEach(() => cleanup())

  it("names the failure and offers both a retry and a reload", () => {
    const reset = vi.fn()
    render(() => AppErrorFallback(new Error("shell exploded"), reset))
    expect(screen.getByTestId("app-error-fallback")).toBeInTheDocument()
    expect(screen.getByText("Something went wrong")).toBeInTheDocument()
    const reload = screen.getByTestId("app-error-reload")
    expect(reload).toHaveTextContent("Reload page")
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(reset).toHaveBeenCalled()
  })
})
