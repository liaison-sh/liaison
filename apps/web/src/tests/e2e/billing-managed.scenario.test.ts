// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 W2b — Plan tab is visible in managed mode and surfaces the control
// plane's tier/status + hosted billing controls (E2E plan
// 16-phase-14-e2e-plan.md).
//
// The profiled fixture starts a per-worker fake control plane BEFORE
// `createWorkerEnv`, then boots the API with both CONTROL_PLANE_URL and
// CONTROL_PLANE_API_KEY set so app.ts's startup matrix puts the worker in
// managed mode and `createBillingStateRoutes` proxies real fetches to the fake.
import { createProfiledE2ETest, expect } from "./fixtures/profiled-test"
import { type FakeControlPlaneHandle, startFakeControlPlane } from "./helpers/mock-control-plane"

let cp: FakeControlPlaneHandle | undefined

const test = createProfiledE2ETest({
  workerIdOffset: 60,
  portCount: 4, // [0]=API, [1]=Vite, [2]=fake CP, [3]=spare
  before: async (ports) => {
    const cpPort = ports[2]
    cp = await startFakeControlPlane(cpPort, {
      initialPayload: {
        tier: "team",
        status: "active",
        billingPortalUrl: "https://fake-cp.local/portal",
        checkoutUrl: "https://fake-cp.local/checkout",
        includedCredits: "10000",
        periodEnd: "2099-01-01T00:00:00.000Z",
      },
    })
    return {
      env: {
        CONTROL_PLANE_URL: cp.url,
        CONTROL_PLANE_API_KEY: "w2b-control-plane-key-32-chars-padded-padded",
      },
      teardowns: [
        async () => {
          await cp?.kill()
          cp = undefined
        },
      ],
    }
  },
})

test.describe.configure({ mode: "serial" })

test.describe("managed billing UX", () => {
  test("Plan tab visible, /settings/plan shows tier + portal link, Usage shows add-credits link", async ({
    authenticatedPage,
    env,
  }) => {
    const page = authenticatedPage

    await page.goto(`http://localhost:${env.ports[1]}/settings/profile`)
    await expect(page.getByTestId("settings-content")).toBeVisible({ timeout: 15000 })

    // The Plan link is gated on billingMode === 'managed', which is hydrated
    // by ensureBillingModeLoaded at startup. Give the resource a beat to
    // resolve against the fake control plane.
    await expect(page.getByRole("link", { name: /^Plan$/ })).toBeVisible({
      timeout: 15000,
    })

    await page.goto(`http://localhost:${env.ports[1]}/settings/plan`)
    await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: 15000 })
    // Tier label rendered from the fake CP's payload ('team' → 'Team').
    await expect(page.getByTestId("plan-card")).toContainText(/team/i)
    await expect(page.getByTestId("plan-card")).toContainText(/active/)

    const portal = page.getByTestId("plan-billing-portal-link")
    await expect(portal).toBeVisible()
    await expect(portal).toHaveAttribute("href", /fake-cp\.local\/portal/)

    // Usage page: the managed-mode add-credits link, not the self-hosted buy link.
    await page.goto(`http://localhost:${env.ports[1]}/settings/usage`)
    const add = page.getByTestId("add-credits-link")
    await expect(add).toBeVisible({ timeout: 15000 })
    await expect(add).toHaveAttribute("href", /fake-cp\.local\/checkout/)
    await expect(page.getByTestId("buy-credits-link")).toHaveCount(0)
  })
})
