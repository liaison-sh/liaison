// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { BillingStateTestAccess, ensureBillingModeLoaded } from "~/modules/settings/BillingState"
import { SettingsSidebar } from "~/modules/settings/SettingsSidebar"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { mockApiClient } from "~/tests/helpers/mock-api"

function makeAdminJwt(): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Admin",
      roles: ["admin"],
      scopes: ["*"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function renderSidebar() {
  render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <SettingsSidebar />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("Plan settings tab — edition-conditional visibility", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    BillingStateTestAccess.reset()
    setTokens(makeAdminJwt(), "refresh")
    bootstrapKernelApps()
  })
  afterEach(() => {
    cleanup()
    clearAuth()
    BillingStateTestAccess.reset()
  })

  it("Plan tab is hidden in self_hosted mode", async () => {
    mockApiClient({
      "/billing/state": {
        mode: "self_hosted",
        byokEnabled: true,
      },
    })
    const { createApiClient } = await import("~/lib/api-client")
    const api = createApiClient({
      getAccessToken: () => makeAdminJwt(),
      onUnauthorized: () => {},
    })
    await ensureBillingModeLoaded(api)

    renderSidebar()
    expect(screen.queryByTestId("settings-link-kernel:plan")).toBeNull()
  })

  it("Plan tab is visible in managed mode", async () => {
    mockApiClient({
      "/billing/state": {
        mode: "managed",
        plan: "base",
        tier: "team",
        status: "active",
        periodEnd: "2026-06-19T00:00:00.000Z",
        includedCredits: "500",
        previewEndsAt: null,
        autoTopUp: { enabled: false, thresholdCredits: 10, amountCredits: 50 },
      },
    })
    const { createApiClient } = await import("~/lib/api-client")
    const api = createApiClient({
      getAccessToken: () => makeAdminJwt(),
      onUnauthorized: () => {},
    })
    await ensureBillingModeLoaded(api)

    renderSidebar()
    expect(screen.getByTestId("settings-link-kernel:plan")).toBeInTheDocument()
  })
})
