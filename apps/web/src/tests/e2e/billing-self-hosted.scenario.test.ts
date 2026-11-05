// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 W2a — Plan tab is hidden in self-hosted mode (E2E plan
// 16-phase-14-e2e-plan.md). The default Playwright fixture leaves
// CONTROL_PLANE_URL / CONTROL_PLANE_API_KEY unset, so the API boots in
// self_hosted mode and the SPA's `visibleWhen` predicate keeps the Plan tab
// hidden.
import { expect, test } from "./fixtures/test"

test.describe("self-hosted billing UX", () => {
  test("Plan tab is hidden, /settings/plan shows the unavailable fallback, Usage is a credit-free monitoring page", async ({
    authenticatedPage,
    env,
  }) => {
    const page = authenticatedPage

    await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
    await expect(page.getByTestId("settings-content")).toBeVisible({ timeout: 15000 })

    // Plan nav link must not render — visibleWhen() === billingMode === 'managed'.
    await expect(page.getByRole("link", { name: /^Plan$/ })).toHaveCount(0)

    // Direct navigation to /settings/plan: the page renders but the managed
    // card is absent and the fallback "plan-unavailable" target appears.
    await page.goto(`http://localhost:${env.ports[1]}/settings/plan`)
    await expect(page.getByTestId("plan-settings")).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("plan-unavailable")).toBeVisible()
    await expect(page.getByTestId("plan-card")).toHaveCount(0)
    await expect(page.getByTestId("plan-billing-portal-link")).toHaveCount(0)
    await expect(page.getByTestId("plan-checkout-link")).toHaveCount(0)

    // Self-hosted Usage is a pure monitoring page: no credit balance, no
    // top-up/buy-credits CTAs, no plan card — just the chart, the computed-usage
    // disclaimer, and the Providers section.
    await page.goto(`http://localhost:${env.ports[1]}/settings/usage`)
    await expect(page.getByTestId("usage-chart")).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("computed-usage-disclaimer")).toBeVisible()
    await expect(page.getByTestId("providers-section")).toBeVisible()
    await expect(page.getByTestId("usage-balance")).toHaveCount(0)
    await expect(page.getByTestId("balance-included")).toHaveCount(0)
    await expect(page.getByTestId("balance-purchased")).toHaveCount(0)
    await expect(page.getByTestId("buy-credits-link")).toHaveCount(0)
    await expect(page.getByTestId("add-credits-link")).toHaveCount(0)
    await expect(page.getByTestId("plan-tier")).toHaveCount(0)
  })
})
