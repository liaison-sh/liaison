// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import SettingsLayout from "~/modules/settings/SettingsLayout"
// Pre-import the admin detail components so the lazy() in bootstrap doesn't
// race the test's findByTestId. The bootstrap registers them with lazy(...);
// vitest cold-start can leave the dynamic import unresolved past findByTestId
// timeout on the very first test, even though it works in isolation.
import "~/modules/settings/AdminUserDetail"
import "~/modules/settings/AdminRoleDetail"
import { ApiProvider } from "~/modules/shell/ApiContext"

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.fake`
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function loginAsAdmin() {
  const jwt = makeJwt({
    userId: "u1",
    orgId: "o1",
    name: "Admin",
    roles: ["admin"],
    scopes: ["kernel:users:admin", "kernel:org:admin", "tickets:settings:admin"],
    dimensionGrants: {},
    exp: Math.floor(Date.now() / 1000) + 3600,
  })
  setTokens(jwt, "refresh")
}

function renderSettingsAt(path: string) {
  window.history.pushState({}, "", path)
  return render(() => (
    <Router>
      <Route
        path="/settings/admin/users/:id"
        component={() => (
          <ApiProvider>
            <SettingsLayout entityId="settings" />
          </ApiProvider>
        )}
      />
      <Route
        path="/settings/admin/roles/:id"
        component={() => (
          <ApiProvider>
            <SettingsLayout entityId="settings" />
          </ApiProvider>
        )}
      />
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <SettingsLayout entityId="settings" />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

beforeEach(() => {
  clearAuth()
  resetRegistry()
  resetBootstrap()
  bootstrapKernelApps()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string") {
        if (url.match(/\/admin\/users\/[^/]+$/)) {
          return jsonResp({
            data: {
              id: "u1",
              email: "alice@test.com",
              name: "Alice",
              status: "active",
              roles: [],
              effectiveScopes: [],
              dimensions: {},
            },
          })
        }
        if (url.match(/\/admin\/roles\/[^/]+$/)) {
          return jsonResp({
            data: {
              id: "r1",
              name: "Support",
              description: null,
              scopes: [],
              dimensionGrants: [],
              members: [],
            },
          })
        }
        if (url.includes("/admin/scope-catalog")) {
          return jsonResp({ data: [] })
        }
        if (url.includes("/admin/users")) return jsonResp({ data: [] })
        if (url.includes("/admin/roles")) return jsonResp({ data: [] })
      }
      return jsonResp({ data: [] })
    }),
  )
})

afterEach(() => vi.unstubAllGlobals())

describe("SettingsLayout — admin detail routes", () => {
  it("/settings/admin/users/:id renders AdminUserDetail and keeps Users sidebar active", async () => {
    loginAsAdmin()
    // Give SolidJS a tick to propagate the new auth state before rendering.
    await Promise.resolve()
    renderSettingsAt("/settings/admin/users/u1")
    expect(await screen.findByTestId("admin-user-section-identity")).toBeInTheDocument()
    // Should stay on the detail path (not redirect)
    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/admin/users/u1")
    })
  })

  it("/settings/admin/roles/:id renders AdminRoleDetail", async () => {
    loginAsAdmin()
    await Promise.resolve()
    renderSettingsAt("/settings/admin/roles/r1")
    expect(await screen.findByTestId("admin-role-section-scopes")).toBeInTheDocument()
    await waitFor(() => {
      expect(window.location.pathname).toBe("/settings/admin/roles/r1")
    })
  })
})

// The former Attention, MCP and Service Levels paths: the table-driven route
// test over settings-aliases.ts (SettingsLayout.aliases.test.tsx) covers them.
