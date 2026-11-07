// SPDX-License-Identifier: FSL-1.1-ALv2
// The Plan tab in the managed edition shows the plan the control plane last
// pushed to the cell (kernel.org_billing_state, served by GET /api/billing/state)
// and links to no payment page (no portal, no checkout).
//
// The profiled fixture restarts the API as the managed edition (LIAISON_EDITION=managed, helpers/managed-edition.ts), so the
// worker runs as the managed edition; the push is seeded in the database.
import { createProfiledE2ETest, expect } from "./fixtures/profiled-test"
import { seedBillingState } from "./helpers/billing-state-seed"
import { MANAGED_VITE_ENV, managedEditionAfterWorld } from "./helpers/managed-edition"

const test = createProfiledE2ETest({
  workerIdOffset: 60,
  portCount: 3, // [0]=API, [1]=Vite, [2]=spare
  before: async () => ({
    env: {},
    teardowns: [],
    // Managed after the world exists (helpers/managed-edition.ts): the managed edition has no web bootstrap.
    viteEnv: MANAGED_VITE_ENV,
    envAfterWorld: managedEditionAfterWorld,
  }),
})

test.describe.configure({ mode: "serial" })

test.describe("managed billing UX", () => {
  test("Plan tab visible, /settings/plan shows the pushed plan, no payment page link", async ({
    authenticatedPage,
    env,
    world,
  }) => {
    const page = authenticatedPage
    await seedBillingState(env, world.org.id, { plan: "base" })

    await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
    await expect(page.getByTestId("settings-content")).toBeVisible({ timeout: 15000 })

    // The Plan link is gated on billingMode === 'managed', hydrated by
    // ensureBillingModeLoaded at startup.
    await expect(page.getByRole("link", { name: /^Plan$/ })).toBeVisible({
      timeout: 15000,
    })

    await page.goto(`http://localhost:${env.ports[1]}/settings/plan`)
    await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: 15000 })
    // The plan's name as sold, never the kernel tier behind it, and a readable date.
    await expect(page.getByTestId("plan-card")).toContainText("Base")
    await expect(page.getByTestId("plan-card")).not.toContainText(/team/i)
    await expect(page.getByTestId("plan-card")).toContainText("January 1, 2099")
    await expect(page.getByTestId("plan-open-billing")).toHaveAttribute("href", "/settings/billing")
    await expect(page.getByTestId("plan-card")).toContainText(/active/)
    await expect(page.getByTestId("plan-billing-portal-link")).toHaveCount(0)

    await page.goto(`http://localhost:${env.ports[1]}/settings/usage`)
    await expect(page.getByTestId("usage-balance")).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("add-credits-link")).toHaveCount(0)
    await expect(page.getByTestId("buy-credits-link")).toHaveCount(0)
  })
})
