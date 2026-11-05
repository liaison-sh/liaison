// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 W3 — Managed-mode Plan tab degrades gracefully when control plane
// is unreachable (E2E plan 16-phase-14-e2e-plan.md). Two-stage fallback:
//   1. live cache miss + last-known cache present → stale banner + cached values
//   2. live cache miss + last-known cache empty → unavailable banner with Retry
// Retry: restore the upstream → assert hydration.
import { api } from "@liaison/test-helpers"
import { createProfiledE2ETest, expect } from "./fixtures/profiled-test"
import { deleteBillingStateCache } from "./helpers/billing-cache"
import { type FakeControlPlaneHandle, startFakeControlPlane } from "./helpers/mock-control-plane"

let cp: FakeControlPlaneHandle | undefined
let cpPort = 0
const PAYLOAD = {
  tier: "team",
  status: "active",
  billingPortalUrl: "https://fake-cp.local/portal",
  checkoutUrl: "https://fake-cp.local/checkout",
  includedCredits: "10000",
  periodEnd: "2099-01-01T00:00:00.000Z",
}

const test = createProfiledE2ETest({
  workerIdOffset: 80,
  portCount: 4,
  before: async (ports) => {
    cpPort = ports[2]
    cp = await startFakeControlPlane(cpPort, { initialPayload: PAYLOAD })
    return {
      env: {
        CONTROL_PLANE_URL: cp.url,
        CONTROL_PLANE_API_KEY: "w3-cp-key-32-chars-padded-padded-padded",
      },
      teardowns: [
        async () => {
          await cp?.kill().catch(() => {})
          cp = undefined
        },
      ],
    }
  },
})

test.describe.configure({ mode: "serial" })

test.describe("managed Plan degrades gracefully", () => {
  test("two-stage fallback: stale cached values, then unavailable banner with retry", async ({
    authenticatedPage,
    env,
    world,
    qa,
  }) => {
    const page = authenticatedPage

    // Stage 0 — warm both caches via a real proxy round-trip while the fake
    // control plane is up.
    if (!cp) throw new Error("fake control plane missing")
    await deleteBillingStateCache(env, world.org.id, { live: true, last: true })
    cp.resetRequests()
    const warm = await api(env.serverUrl, "/api/billing/state", {
      token: qa.admin.token,
    })
    expect(warm.status).toBe(200)
    expect((warm.body as { data: { stale: boolean } }).data.stale).toBe(false)

    // Stage 1 — kill the control plane, evict the live cache. The next
    // /billing/state must fall back to the last-known value with stale=true.
    await cp.kill()
    cp = undefined
    await deleteBillingStateCache(env, world.org.id, { live: true })

    await page.goto(`http://localhost:${env.ports[1]}/settings/plan`)
    await expect(page.getByTestId("plan-card")).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId("billing-stale-banner")).toBeVisible()
    // Tier still shows the cached value.
    await expect(page.getByTestId("plan-card")).toContainText(/team/i)

    // Stage 2 — drop the last-known cache too. The page should render the
    // unavailable banner on /settings/usage (where it lives) and offer Retry.
    await deleteBillingStateCache(env, world.org.id, { live: true, last: true })
    await page.goto(`http://localhost:${env.ports[1]}/settings/usage`)
    await expect(page.getByTestId("billing-state-unavailable")).toBeVisible({
      timeout: 15000,
    })

    // Stage 3 — restart the fake control plane, click Retry, expect hydration.
    cp = await startFakeControlPlane(cpPort, { initialPayload: PAYLOAD })
    await page.getByTestId("billing-state-retry").click()

    // The unavailable banner must clear once the resource refetches successfully.
    await expect(page.getByTestId("billing-state-unavailable")).toHaveCount(0, {
      timeout: 15000,
    })
  })
})
