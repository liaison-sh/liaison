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

  it("renders tier + status from the pushed state, and no payment page link", async () => {
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
    renderPlan()
    expect(await screen.findByText("Base")).toBeInTheDocument()
    expect(screen.queryByText(/team/i)).toBeNull()
    expect(screen.queryByText(/2026-06-19T/)).toBeNull()
    expect(screen.getByTestId("plan-open-billing").getAttribute("href")).toBe("/settings/billing")
    expect(await screen.findByText(/active/i)).toBeInTheDocument()
    expect(screen.queryByTestId("plan-billing-portal-link")).toBeNull()
    expect(screen.queryByTestId("plan-checkout-link")).toBeNull()
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
