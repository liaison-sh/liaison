// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router, useLocation } from "@solidjs/router"
import { render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { ProtectedRoute } from "~/modules/auth/ProtectedRoute"

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.fake`
}

describe("ProtectedRoute", () => {
  beforeEach(() => {
    clearAuth()
  })

  it("renders children when authenticated", () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt, "refresh")

    render(() => (
      <Router>
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
    expect(screen.getByText("Protected content")).toBeInTheDocument()
  })

  it("shows only the second-factor enrollment when the session requires it", async () => {
    const jwt = makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Test",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      restricted: true,
      secondFactorRequired: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
    setTokens(jwt, "refresh")

    render(() => (
      <Router>
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
    await waitFor(() => expect(screen.getByTestId("second-factor-enrollment")).toBeInTheDocument())
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument()
  })

  it("does not render children when unauthenticated", () => {
    render(() => (
      <Router>
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
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument()
  })

  it("redirects to /login with returnTo param when unauthenticated", async () => {
    let capturedSearch = ""
    render(() => (
      <Router>
        <Route
          path="/settings"
          component={() => (
            <ProtectedRoute>
              <div>Protected content</div>
            </ProtectedRoute>
          )}
        />
        <Route
          path="/login"
          component={() => {
            const loc = useLocation()
            capturedSearch = loc.search
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
    await waitFor(() => {
      expect(screen.queryByText("Login page")).toBeInTheDocument()
    })
    expect(capturedSearch).toContain("returnTo=")
  })
})
