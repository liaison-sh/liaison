// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import PlanSettings from "~/modules/settings/PlanSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { mockApiClient } from "~/tests/helpers/mock-api"

function renderPlan() {
  render(() => (
    <I18nProvider initialLocale="en">
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>
              <PlanSettings />
            </ApiProvider>
          )}
        />
      </Router>
    </I18nProvider>
  ))
}

describe("PlanSettings (managed mode)", () => {
  afterEach(cleanup)

  it("renders tier + status + 'Open billing portal' link", async () => {
    mockApiClient({
      "/billing/state": {
        mode: "managed",
        tier: "team",
        status: "active",
        billingPortalUrl: "https://cp.example/portal",
        checkoutUrl: "https://cp.example/checkout",
        includedCredits: "500",
        periodEnd: "2026-06-19",
        stale: false,
      },
    })
    renderPlan()
    expect(await screen.findByText(/team/i)).toBeInTheDocument()
    expect(await screen.findByText(/active/i)).toBeInTheDocument()
    const portal = await screen.findByTestId("plan-billing-portal-link")
    expect(portal.getAttribute("href")).toBe("https://cp.example/portal")
  })

  it("self_hosted: renders 'Plan unavailable' fallback", async () => {
    mockApiClient({
      "/billing/state": {
        mode: "self_hosted",
        byokEnabled: true,
      },
    })
    renderPlan()
    expect(
      await screen.findByText(/plan information is currently unavailable/i),
    ).toBeInTheDocument()
  })
})
