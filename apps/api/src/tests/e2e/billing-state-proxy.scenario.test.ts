// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 14 A2 — Billing-state proxy round-trip in managed mode against a real
// fake control plane (E2E plan 16-phase-14-e2e-plan.md).
//
// Validates the cache + stale-fallback contract end-to-end, plus the security
// property that the control-plane URL never leaks to the browser.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld } from "@liaison/test-helpers"
import { allocatePorts, api, type WorkerEnv } from "@liaison/test-helpers"
import { deleteBillingStateCache } from "./helpers/billing-cache"
import { type FakeControlPlaneHandle, startFakeControlPlane } from "./helpers/mock-control-plane"
import { setupScenario, teardownScenario } from "./setup"

describe("/api/billing/state managed-mode proxy", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let token: string
  let orgId: string
  let cp: FakeControlPlaneHandle

  const TEST_KEY = "a2-test-key-32chars-min-padding-padding"

  beforeAll(async () => {
    const [cpPort] = await allocatePorts(1)
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

    const result = await setupScenario({
      seed: 142,
      org: { name: "Billing Proxy E2E" },
      serverEnv: {
        CONTROL_PLANE_URL: cp.url,
        CONTROL_PLANE_API_KEY: TEST_KEY,
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    token = world.admin.token
    orgId = world.org.id
    await deleteBillingStateCache(env, orgId, { live: true, last: true })
  }, 120_000)

  afterAll(async () => {
    if (cp) await cp.kill()
    await teardownScenario(env, world)
  }, 15_000)

  async function getState() {
    return api(url, "/api/billing/state", { token })
  }

  it("mirrors the control plane response on first call (fresh fetch)", async () => {
    await deleteBillingStateCache(env, orgId, { live: true, last: true })
    cp.resetRequests()
    cp.setStatus(200)
    cp.setPayload({
      tier: "team",
      status: "active",
      billingPortalUrl: "https://fake-cp.local/portal",
      checkoutUrl: "https://fake-cp.local/checkout",
      includedCredits: "10000",
      periodEnd: "2099-01-01T00:00:00.000Z",
    })

    const r = await getState()
    expect(r.status).toBe(200)
    expect(r.body.data.mode).toBe("managed")
    expect(r.body.data.tier).toBe("team")
    expect(r.body.data.status).toBe("active")
    expect(r.body.data.billingPortalUrl).toBe("https://fake-cp.local/portal")
    expect(r.body.data.stale).toBe(false)

    const inboundRequests = cp.getRequests().filter((req) => req.path.startsWith("/v1/"))
    expect(inboundRequests).toHaveLength(1)
    expect(inboundRequests[0].authorization).toBe(`Bearer ${TEST_KEY}`)

    // Security: the payload must never echo the upstream URL — that would leak
    // the control-plane base to the browser.
    expect(JSON.stringify(r.body)).not.toContain(cp.url)
  })

  it("serves the cached value on the second call (no upstream traffic)", async () => {
    cp.resetRequests()
    const r = await getState()
    expect(r.status).toBe(200)
    expect(r.body.data.tier).toBe("team")
    expect(cp.getRequests().filter((req) => req.path.startsWith("/v1/"))).toHaveLength(0)
  })

  it("refetches after the live cache is evicted", async () => {
    cp.resetRequests()
    cp.setPayload({
      tier: "personal",
      status: "active",
      billingPortalUrl: "https://fake-cp.local/portal",
      checkoutUrl: "https://fake-cp.local/checkout",
      includedCredits: "1000",
      periodEnd: "2099-02-01T00:00:00.000Z",
    })

    await deleteBillingStateCache(env, orgId, { live: true })
    const r = await getState()
    expect(r.status).toBe(200)
    expect(r.body.data.tier).toBe("personal")
    expect(r.body.data.stale).toBe(false)
    expect(cp.getRequests().filter((req) => req.path.startsWith("/v1/"))).toHaveLength(1)
  })

  it("returns the last-known value with stale=true when the control plane is unreachable", async () => {
    // Force a successful refresh so the last-known cache is warm.
    await deleteBillingStateCache(env, orgId, { live: true })
    cp.setStatus(200)
    const warm = await getState()
    expect(warm.status).toBe(200)
    expect(warm.body.data.stale).toBe(false)

    // Kill upstream, drop the live cache so the next call must refetch.
    await cp.kill()
    await deleteBillingStateCache(env, orgId, { live: true })

    const stale = await getState()
    expect(stale.status).toBe(200)
    expect(stale.body.data.stale).toBe(true)
    // Last-known payload is still present.
    expect(stale.body.data.tier).toBeDefined()
    expect(JSON.stringify(stale.body)).not.toContain(cp.url)
  })
})
