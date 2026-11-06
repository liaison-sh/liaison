// SPDX-License-Identifier: FSL-1.1-ALv2
//
// POST /api/demo/start-over (routes.ts, START_OVER): a signed-in visitor gets a
// fresh workspace and stays signed in; the old one ends; the lead, the
// confirmed address, the spend and the end date carry over; nobody else can
// call it, and it is limited per visitor.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { type AppEnv, apiBodyLimitMiddleware, apiRequestTimeoutMiddleware, app } from "~/app"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import { reserveStep, settleStep, snapshot } from "~/modules/demo/demo-budget"
import {
  enableDemoDoorForTest,
  passingTurnstileToken,
  restoreDemoDoorEnv,
} from "~/modules/demo/demo-door.test-fixtures"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, reservedMarker } from "~/modules/demo/demo-org"
import { DemoSeederTestAccess, setDemoSeeder } from "~/modules/demo/demo-seeder"
import { DemoVerificationTestAccess, demoVerifiedIdentity } from "~/modules/demo/demo-verification"
import { mountDemoRoutes, useDemoRateLimit } from "~/modules/demo/routes"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const demoApp = new Hono<AppEnv>()
demoApp.use("/api/*", apiBodyLimitMiddleware)
useDemoRateLimit(demoApp, redis)
demoApp.use("/api/*", apiRequestTimeoutMiddleware)
demoApp.onError(errorHandler)
mountDemoRoutes(demoApp)

let peer = 0
function nextPeer(): string {
  peer += 1
  return `203.0.113.${peer % 250}`
}

interface Session {
  orgId: string
  userId: string
  state: string
  expiresAt: string
  accessToken: string
  needs: string[]
}

async function signup(email: string, extra: Record<string, unknown> = {}): Promise<Session> {
  const response = await demoApp.request("/api/demo/orgs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bun-socket-ip": nextPeer() },
    body: JSON.stringify({
      name: "Lea Martin",
      email,
      needs: ["support", "chat"],
      turnstileToken: passingTurnstileToken(),
      ...extra,
    }),
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { data: Session }).data
}

function startOver(accessToken: string) {
  return demoApp.request("/api/demo/start-over", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "x-bun-socket-ip": nextPeer() },
  })
}

async function markVerified(orgId: string): Promise<void> {
  await sql`UPDATE kernel.demo_leads SET verified_at = now() WHERE demo_org_id = ${orgId}`
  DemoVerificationTestAccess.reset()
}

async function markerOf(orgId: string) {
  const [row] = await sql<{ demo: { variant: string; expiresAt: string; needs?: string[] } }[]>`
    SELECT settings->'demo' AS demo FROM kernel.organizations WHERE id = ${orgId}`
  return row.demo
}

let emails = 0
function nextEmail(): string {
  emails += 1
  return `lea.${emails}.${Date.now()}@example.com`
}

describe("POST /api/demo/start-over", () => {
  beforeAll(async () => {
    await acquireTestLock()
    DemoModeTestAccess.set(true)
    enableDemoDoorForTest()
    setDemoSeeder(async ({ orgSlug, orgName, locale }) => {
      const { orgId } = await ensureOrg({ slug: orgSlug, name: orgName, locale })
      return { ok: true, orgId }
    })
  })

  afterAll(async () => {
    DemoModeTestAccess.set(null)
    restoreDemoDoorEnv()
    DemoSeederTestAccess.reset()
    await releaseTestLock()
  })

  afterEach(async () => {
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*", "demo:*"])
    await sql`DELETE FROM kernel.demo_spend`
    invalidateDemoMarker()
    DemoVerificationTestAccess.reset()
  })

  it("carries the company answer over to the fresh workspace", async () => {
    const first = await signup(nextEmail(), { entry: { id: "other", text: "A bakery" } })
    const response = await startOver(first.accessToken)
    expect(response.status).toBe(201)
    const fresh = ((await response.json()) as { data: Session }).data
    const marker = (await markerOf(fresh.orgId)) as { entry?: unknown }
    expect(marker.entry).toEqual({ id: "other", text: "A bakery" })
  })

  it("hands the visitor a fresh workspace and a session into it, and ends the old one", async () => {
    const email = nextEmail()
    const first = await signup(email)
    await markVerified(first.orgId)
    const before = await markerOf(first.orgId)

    const response = await startOver(first.accessToken)
    expect(response.status).toBe(201)
    const fresh = ((await response.json()) as { data: Session }).data
    expect(fresh.orgId).not.toBe(first.orgId)
    expect(fresh.needs).toEqual(["support", "chat"])

    // Signed in, in the new workspace.
    const me = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${fresh.accessToken}` },
    })
    expect(me.status).toBe(200)
    expect(((await me.json()) as { data: { id: string } }).data.id).toBe(fresh.userId)

    // The new workspace keeps the first one's end and picks; the old one is over.
    const after = await markerOf(fresh.orgId)
    expect(after.variant).toBe("visitor")
    expect(after.expiresAt).toBe(before.expiresAt)
    expect(after.needs).toEqual(["support", "chat"])
    const old = await markerOf(first.orgId)
    expect(Date.parse(old.expiresAt)).toBeLessThanOrEqual(Date.now())
    const oldMe = await app.request("/api/users/me", {
      headers: { Authorization: `Bearer ${first.accessToken}` },
    })
    expect(oldMe.status).toBe(403)

    // One person, one lead: it moved, confirmed, to the new workspace.
    const leads = await sql<{ demo_org_id: string; verified: boolean }[]>`
      SELECT demo_org_id, verified_at IS NOT NULL AS verified
      FROM kernel.demo_leads WHERE email = ${email}`
    expect([...leads]).toEqual([{ demo_org_id: fresh.orgId, verified: true }])
    expect(await demoVerifiedIdentity(fresh.orgId)).not.toBeNull()

    // The new world is a fresh seed, not the old one's rows.
    const [owner] = await sql<{ name: string }[]>`
      SELECT name FROM kernel.users WHERE id = ${fresh.userId} AND org_id = ${fresh.orgId}`
    expect(owner.name).toBe("Lea Martin")
  })

  it("leaves the spend budget exactly where it was", async () => {
    const first = await signup(nextEmail())
    await markVerified(first.orgId)
    const identity = await demoVerifiedIdentity(first.orgId)
    if (!identity) throw new Error("visitor not verified")
    const held = await reserveStep(
      identity,
      "deepseek/deepseek-v4.1-flash-1017",
      50_000,
      first.orgId,
    )
    await settleStep(held, 40_000)
    const spent = (await snapshot(identity)).usedMicroEur
    expect(spent).toBeGreaterThan(0)

    const response = await startOver(first.accessToken)
    expect(response.status).toBe(201)
    const fresh = ((await response.json()) as { data: Session }).data
    const carried = await demoVerifiedIdentity(fresh.orgId)
    expect(carried).toEqual(identity)
    expect((await snapshot(identity)).usedMicroEur).toBe(spent)
  })

  it("has no per-visitor count: the spend budget is the only limit", async () => {
    let session = await signup(nextEmail())
    for (let i = 0; i < 5; i++) {
      const response = await startOver(session.accessToken)
      expect(response.status).toBe(201)
      session = ((await response.json()) as { data: Session }).data
    }
    expect(Date.parse((await markerOf(session.orgId)).expiresAt)).toBeGreaterThan(Date.now())
  })

  it("refuses an org that is not a demo visitor org", async () => {
    const member = await minimal.adminSession((await createTestOrg()).id)
    expect((await startOver(member.bearer)).status).toBe(404)
  })

  it("refuses the reserved review org", async () => {
    const member = await minimal.adminSession((await createTestOrg()).id)
    await markOrgAsDemo(member.orgId, reservedMarker())
    expect((await startOver(member.bearer)).status).toBe(404)
  })

  it("refuses without a session", async () => {
    const response = await demoApp.request("/api/demo/start-over", {
      method: "POST",
      headers: { "x-bun-socket-ip": nextPeer() },
    })
    expect(response.status).toBe(401)
  })
})
