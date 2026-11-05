// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The visitor TTL, which used to be enforced NOWHERE: `isDemoOrgExpired` had
// zero callers in apps/ and scripts/, so LIAISON_DEMO_VISITOR_TTL_HOURS wrote a
// field nothing read and visitor orgs accumulated forever on a public box.
//
// Both halves are asserted: an expired workspace stops being usable, and a
// reaper can find the ones to collect. Plus, as always, that neither half
// touches a normal org or a normal deployment.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { errorHandler } from "~/middleware/error-handler"
import { demoExpiryMiddleware, listExpiredDemoOrgs } from "~/modules/demo/demo-expiry"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  invalidateDemoMarker,
  markOrgAsDemo,
  reservedMarker,
  visitorMarker,
} from "~/modules/demo/demo-org"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** A one-route app whose only middleware is the one under test. */
function appFor(orgId: string) {
  const testApp = new Hono<AppEnv>()
  testApp.onError(errorHandler)
  testApp.use("*", async (c, next) => {
    c.set("orgId", orgId)
    await next()
  })
  testApp.use("*", demoExpiryMiddleware())
  testApp.get("/thing", (c) => c.json({ ok: true }))
  return testApp
}

const HOUR = 60 * 60 * 1000

describe("demo visitor expiry", () => {
  let liveOrgId: string
  let expiredOrgId: string
  let reservedOrgId: string
  let normalOrgId: string

  beforeAll(async () => {
    await acquireTestLock()
    liveOrgId = (await ensureOrg({ slug: "expiry-live", name: "Expiry Live" })).orgId
    expiredOrgId = (await ensureOrg({ slug: "expiry-gone", name: "Expiry Gone" })).orgId
    reservedOrgId = (await ensureOrg({ slug: "expiry-reserved", name: "Expiry Reserved" })).orgId
    normalOrgId = (await ensureOrg({ slug: "expiry-normal", name: "Expiry Normal" })).orgId
    await markOrgAsDemo(liveOrgId, visitorMarker(72))
    // A marker minted 72 hours in the past, i.e. one that expired an hour ago.
    await markOrgAsDemo(expiredOrgId, visitorMarker(72, new Date(Date.now() - 73 * HOUR)))
    await markOrgAsDemo(reservedOrgId, reservedMarker())
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    await releaseTestLock()
  })

  afterEach(() => {
    invalidateDemoMarker()
  })

  it("refuses an authenticated request into an expired visitor workspace", async () => {
    DemoModeTestAccess.set(true)
    const response = await appFor(expiredOrgId).request("/thing")
    expect(response.status).toBe(403)
    const body = (await response.json()) as { error: { message: string } }
    expect(body.error.message).toContain("expired")
  })

  it("lets a visitor workspace that is still inside its TTL through", async () => {
    DemoModeTestAccess.set(true)
    expect((await appFor(liveOrgId).request("/thing")).status).toBe(200)
  })

  it("never expires the reserved org, whose marker carries a null expiry", async () => {
    DemoModeTestAccess.set(true)
    expect((await appFor(reservedOrgId).request("/thing")).status).toBe(200)
  })

  it("never touches a normal org, even on the demo box", async () => {
    DemoModeTestAccess.set(true)
    expect((await appFor(normalOrgId).request("/thing")).status).toBe(200)
  })

  it("is inert with demo mode off, marker or no marker", async () => {
    DemoModeTestAccess.set(false)
    expect((await appFor(expiredOrgId).request("/thing")).status).toBe(200)
    expect((await appFor(normalOrgId).request("/thing")).status).toBe(200)
  })

  describe("listExpiredDemoOrgs", () => {
    it("returns the expired visitor orgs a reaper would collect, and nothing else", async () => {
      DemoModeTestAccess.set(true)
      const ids = (await listExpiredDemoOrgs()).map((o) => o.orgId)
      expect(ids).toContain(expiredOrgId)
      expect(ids).not.toContain(liveOrgId)
      expect(ids).not.toContain(reservedOrgId)
      expect(ids).not.toContain(normalOrgId)
    })

    it("carries what an operator needs in a log line", async () => {
      DemoModeTestAccess.set(true)
      const row = (await listExpiredDemoOrgs()).find((o) => o.orgId === expiredOrgId)
      expect(row?.slug).toBe("expiry-gone")
      expect(row?.name).toBe("Expiry Gone")
      expect(row?.variant).toBe("visitor")
      expect(Date.parse(row?.expiresAt ?? "")).toBeLessThan(Date.now())
    })

    it("respects the caller's clock, so a reaper can ask about a future sweep", async () => {
      DemoModeTestAccess.set(true)
      const later = new Date(Date.now() + 200 * HOUR)
      const ids = (await listExpiredDemoOrgs(later)).map((o) => o.orgId)
      expect(ids).toContain(liveOrgId)
      expect(ids).not.toContain(reservedOrgId)
    })

    it("runs no query at all with demo mode off", async () => {
      DemoModeTestAccess.set(false)
      expect(await listExpiredDemoOrgs()).toEqual([])
    })

    it("skips a hand-mangled marker instead of failing the whole sweep", async () => {
      DemoModeTestAccess.set(true)
      const { orgId } = await ensureOrg({ slug: "expiry-mangled", name: "Expiry Mangled" })
      await sql`
        UPDATE kernel.organizations
        SET settings = COALESCE(settings, '{}'::jsonb) ||
          jsonb_build_object('demo', jsonb_build_object('variant', 'visitor',
                                                        'expiresAt', 'not-a-date'))
        WHERE id = ${orgId}`
      invalidateDemoMarker()
      const ids = (await listExpiredDemoOrgs()).map((o) => o.orgId)
      expect(ids).toContain(expiredOrgId)
      expect(ids).not.toContain(orgId)
    })
  })
})
