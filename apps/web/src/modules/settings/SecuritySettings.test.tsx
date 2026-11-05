// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import SecuritySettings from "~/modules/settings/SecuritySettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

function WrappedSecuritySettings() {
  return (
    <ApiProvider>
      <SecuritySettings />
    </ApiProvider>
  )
}

describe("SecuritySettings", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: { totpEnabled: false } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("renders security heading", () => {
    render(() => (
      <Router>
        <Route path="*" component={WrappedSecuritySettings} />
      </Router>
    ))
    expect(screen.getByText("Security")).toBeInTheDocument()
  })

  it("renders TOTP section", () => {
    render(() => (
      <Router>
        <Route path="*" component={WrappedSecuritySettings} />
      </Router>
    ))
    expect(screen.getByText(/two-factor/i)).toBeInTheDocument()
  })

  it("renders enable 2FA button", () => {
    render(() => (
      <Router>
        <Route path="*" component={WrappedSecuritySettings} />
      </Router>
    ))
    expect(screen.getByRole("button", { name: /enable 2fa/i })).toBeInTheDocument()
  })

  it("renders password change form", () => {
    render(() => (
      <Router>
        <Route path="*" component={WrappedSecuritySettings} />
      </Router>
    ))
    expect(screen.getByText("Change password")).toBeInTheDocument()
    expect(screen.getByText("Current password")).toBeInTheDocument()
    expect(screen.getByText("New password")).toBeInTheDocument()
  })
})
