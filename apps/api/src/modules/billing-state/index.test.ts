// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { redis } from "~/lib/redis"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { type BillingStateConfig, createBillingStateRoutes } from "./"

const ORG_ID = "00000000-0000-4000-8000-0000000bs001"
const MANAGED: BillingStateConfig = {
  controlPlaneUrl: "https://cp.example",
  controlPlaneApiKey: "k".repeat(32),
}

function mountApp(config: BillingStateConfig, orgId = ORG_ID) {
  const app = new Hono<AppEnv>()
  app.use("/api/billing/state/*", async (c, next) => {
    c.set("orgId", orgId)
    return next()
  })
  app.use("/api/billing/state", async (c, next) => {
    c.set("orgId", orgId)
    return next()
  })
  app.route("/api/billing/state", createBillingStateRoutes(config))
  return app
}

const originalFetch = globalThis.fetch

beforeAll(acquireTestLock)
afterAll(releaseTestLock)
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("GET /api/billing/state", () => {
  test("self_hosted mode when control-plane env unset", async () => {
    await redis.del(`billingState:${ORG_ID}`, `billingState:last:${ORG_ID}`)
    const app = mountApp({})
    const r = await app.request("/api/billing/state")
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: Record<string, unknown> }
    expect(body.data.mode).toBe("self_hosted")
    expect(body.data.byokEnabled).toBe(true)
  })

  test("managed mode proxies to control plane and caches", async () => {
    await redis.del(`billingState:${ORG_ID}`, `billingState:last:${ORG_ID}`)
    const fetchSpy = mock(
      async () =>
        new Response(
          JSON.stringify({
            tier: "team",
            status: "active",
            billingPortalUrl: "https://cp.example/portal",
            checkoutUrl: "https://cp.example/checkout",
            includedCredits: "500",
            periodEnd: "2026-06-19T00:00:00Z",
          }),
          { status: 200 },
        ),
    )
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const app = mountApp(MANAGED)

    const r1 = await app.request("/api/billing/state")
    expect(r1.status).toBe(200)
    const b1 = (await r1.json()) as { data: Record<string, unknown> }
    expect(b1.data.mode).toBe("managed")
    expect(b1.data.tier).toBe("team")
    expect(b1.data.stale).toBe(false)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const r2 = await app.request("/api/billing/state")
    const b2 = (await r2.json()) as { data: Record<string, unknown> }
    expect(b2.data.tier).toBe("team")
    expect(fetchSpy).toHaveBeenCalledTimes(1) // served from cache
  })

  test("control-plane failure with last-known cache returns stale: true", async () => {
    await redis.del(`billingState:${ORG_ID}`)
    await redis.set(
      `billingState:last:${ORG_ID}`,
      JSON.stringify({
        mode: "managed",
        tier: "team",
        status: "active",
        billingPortalUrl: "x",
        checkoutUrl: "y",
        includedCredits: "0",
        periodEnd: "2026-01-01",
        fetchedAt: new Date(Date.now() - 90_000).toISOString(),
      }),
    )
    globalThis.fetch = mock(async () => {
      throw new Error("network")
    }) as unknown as typeof fetch
    const app = mountApp(MANAGED)
    const r = await app.request("/api/billing/state")
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: Record<string, unknown> }
    expect(body.data.stale).toBe(true)
    expect(body.data.tier).toBe("team")
  })

  test("control-plane failure with no cache returns billingUnavailable", async () => {
    await redis.del(`billingState:${ORG_ID}`, `billingState:last:${ORG_ID}`)
    globalThis.fetch = mock(async () => {
      throw new Error("network")
    }) as unknown as typeof fetch
    const app = mountApp(MANAGED)
    const r = await app.request("/api/billing/state")
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: Record<string, unknown> }
    expect(body.data.mode).toBe("managed")
    expect(body.data.billingUnavailable).toBe(true)
    expect(body.data.stale).toBe(true)
  })

  test("response body never contains control-plane URL or bearer", async () => {
    await redis.del(`billingState:${ORG_ID}`, `billingState:last:${ORG_ID}`)
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            tier: "team",
            status: "active",
            billingPortalUrl: "x",
            checkoutUrl: "y",
            includedCredits: "0",
            periodEnd: "2026-01-01",
          }),
        ),
    ) as unknown as typeof fetch
    const app = mountApp({
      controlPlaneUrl: "https://cp.example",
      controlPlaneApiKey: "secrettokensecrettoken_",
    })
    const r = await app.request("/api/billing/state")
    expect(r.status).toBe(200)
    const text = await r.text()
    expect(text).toMatch(/"mode":\s*"managed"/)
    expect(text).not.toContain("cp.example")
    expect(text).not.toContain("secrettokensecrettoken_")
  })

  test("mode transition managed → self_hosted is immediate (env-driven, no stale managed leak)", async () => {
    await redis.del(`billingState:${ORG_ID}`, `billingState:last:${ORG_ID}`)
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            tier: "team",
            status: "active",
            billingPortalUrl: "x",
            checkoutUrl: "y",
            includedCredits: "0",
            periodEnd: "2026-01-01",
          }),
        ),
    ) as unknown as typeof fetch
    const managedApp = mountApp(MANAGED)
    await managedApp.request("/api/billing/state")

    const selfHostedApp = mountApp({})
    const r = await selfHostedApp.request("/api/billing/state")
    const body = (await r.json()) as { data: Record<string, unknown> }
    expect(body.data.mode).toBe("self_hosted")
  })

  test("malformed JSON from control plane falls back to stale last-known", async () => {
    await redis.del(`billingState:${ORG_ID}`)
    await redis.set(
      `billingState:last:${ORG_ID}`,
      JSON.stringify({
        mode: "managed",
        tier: "team",
        status: "active",
        billingPortalUrl: "x",
        checkoutUrl: "y",
        includedCredits: "0",
        periodEnd: "2026-01-01",
      }),
    )
    globalThis.fetch = mock(
      async () => new Response("not json at all", { status: 200 }),
    ) as unknown as typeof fetch
    const app = mountApp(MANAGED)
    const r = await app.request("/api/billing/state")
    const body = (await r.json()) as { data: Record<string, unknown> }
    expect(body.data.stale).toBe(true)
    expect(body.data.tier).toBe("team")
  })

  test("a reply missing periodEnd is treated as an error", async () => {
    await redis.del(`billingState:${ORG_ID}`, `billingState:last:${ORG_ID}`)
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            tier: "team",
            status: "active",
            billingPortalUrl: "https://cp.example/portal",
            checkoutUrl: "https://cp.example/checkout",
            includedCredits: "500",
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch
    const app = mountApp(MANAGED)
    const r = await app.request("/api/billing/state")
    const body = (await r.json()) as { data: Record<string, unknown> }
    expect(body.data.mode).toBe("managed")
    expect(body.data.billingUnavailable).toBe(true)
    expect(body.data.stale).toBe(true)
    expect(body.data.tier).toBeUndefined()
  })

  test("non-2xx response from control plane treated as failure", async () => {
    await redis.del(`billingState:${ORG_ID}`, `billingState:last:${ORG_ID}`)
    globalThis.fetch = mock(
      async () => new Response("server error", { status: 502 }),
    ) as unknown as typeof fetch
    const app = mountApp(MANAGED)
    const r = await app.request("/api/billing/state")
    const body = (await r.json()) as { data: Record<string, unknown> }
    expect(body.data.billingUnavailable).toBe(true)
    expect(body.data.stale).toBe(true)
  })
})
