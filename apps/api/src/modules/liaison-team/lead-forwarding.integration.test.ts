// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Demo leads through the Liaison team outbox (lead-forwarding.ts and its call
// sites in the demo module): the signup route, the opt-out, the notify-managed
// click, verification and the reaper. The outbox rows are read straight from
// the table; nothing is sent (no endpoint is needed to queue).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { type AppEnv, apiBodyLimitMiddleware, apiRequestTimeoutMiddleware } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import {
  enableDemoDoorForTest,
  lastCapturedCode,
  passingTurnstileToken,
  restoreDemoDoorEnv,
} from "~/modules/demo/demo-door.test-fixtures"
import {
  eraseExpiredDemoIdentities,
  optOutDemoLead,
  recordDemoLead,
  setDemoLeadNotifyManaged,
} from "~/modules/demo/demo-leads"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import { invalidateDemoMarker, markOrgAsDemo, visitorMarker } from "~/modules/demo/demo-org"
import { purgeDemoOrg } from "~/modules/demo/demo-reset"
import { DemoSeederTestAccess, setDemoSeeder } from "~/modules/demo/demo-seeder"
import { DemoVerificationTestAccess, verifyDemoCode } from "~/modules/demo/demo-verification"
import { mountDemoRoutes, useDemoRateLimit } from "~/modules/demo/routes"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import { type LiaisonTeamIdentity, mintIdentity, writeIdentity } from "./identity"
import { forwardDemoLeadUpdate, forwardNewDemoLead } from "./lead-forwarding"

const demoApp = new Hono<AppEnv>()
demoApp.use("/api/*", apiBodyLimitMiddleware)
useDemoRateLimit(demoApp, redis)
demoApp.use("/api/*", apiRequestTimeoutMiddleware)
demoApp.onError(errorHandler)
mountDemoRoutes(demoApp)

const env_ = env as { LIAISON_TEAM_FORWARD_DEMO_LEADS: boolean }
const savedFlag = env.LIAISON_TEAM_FORWARD_DEMO_LEADS
// The signups below share one /24: the verification ceilings are not under test.
const caps = env as unknown as Record<string, number>
const CAP_KEYS = [
  "LIAISON_DEMO_VERIFIED_PER_HOUR",
  "LIAISON_DEMO_DOMAIN_VERIFIED_PER_DAY",
  "LIAISON_DEMO_NETWORK_VERIFIED_PER_HOUR",
  "LIAISON_DEMO_NETWORK_VERIFIED_PER_DAY",
] as const
const savedCaps = Object.fromEntries(CAP_KEYS.map((k) => [k, caps[k]]))

interface Queued {
  type: string
  status: string
  depends_on: string | null
  data: Record<string, unknown>
}
const queued = (): Promise<Queued[]> =>
  sql<
    Queued[]
  >`SELECT type, status, depends_on, data FROM kernel.control_plane_outbox ORDER BY created_at, id`

async function setIdentity(state: LiaisonTeamIdentity["state"] | null): Promise<void> {
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  if (!state) return
  await withSystemDb("test", (tx) => writeIdentity(tx, { ...mintIdentity(), state }))
  // The registration switch is on while there is a registered or pending identity.
  const register = state !== "retiring"
  await sql`INSERT INTO kernel.instance_settings (key, value, decided_at)
            VALUES ('liaison_team.sharing', ${JSON.stringify({ register, forwardBugReports: false })}::jsonb, now())`
}

/** Wait until another session of this database waits on a lock (at most 10 s). */
async function someoneWaitsOnALock(): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    const [r] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE datname = current_database() AND wait_event_type = 'Lock'`
    if ((r?.n ?? 0) > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

let peer = 0
let emails = 0
async function signup(newsOptIn?: boolean): Promise<{ orgId: string; email: string }> {
  peer += 1
  emails += 1
  const email = `lea.${emails}.${Date.now()}@example.com`
  const response = await demoApp.request("/api/demo/orgs", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-bun-socket-ip": `203.0.113.${peer % 250}` },
    body: JSON.stringify({
      name: "Lea Martin",
      email,
      needs: ["support", "chat"],
      ...(newsOptIn ? { newsOptIn } : {}),
      turnstileToken: passingTurnstileToken(),
    }),
  })
  expect(response.status).toBe(201)
  return { orgId: ((await response.json()) as { data: { orgId: string } }).data.orgId, email }
}

beforeAll(async () => {
  await acquireTestLock()
  enableDemoDoorForTest()
  setDemoSeeder(async ({ orgSlug, orgName, locale }) => {
    const { orgId } = await ensureOrg({ slug: orgSlug, name: orgName, locale })
    return { ok: true, orgId }
  })
})

afterAll(async () => {
  env_.LIAISON_TEAM_FORWARD_DEMO_LEADS = savedFlag
  for (const k of CAP_KEYS) caps[k] = savedCaps[k] as number
  DemoModeTestAccess.set(null)
  restoreDemoDoorEnv()
  DemoSeederTestAccess.reset()
  await sql`DELETE FROM kernel.control_plane_outbox`
  await sql`DELETE FROM kernel.instance_settings WHERE key LIKE 'liaison_team.%'`
  await releaseTestLock()
})

beforeEach(async () => {
  await sql`DELETE FROM kernel.control_plane_outbox`
  DemoModeTestAccess.set(true)
  env_.LIAISON_TEAM_FORWARD_DEMO_LEADS = true
  for (const k of CAP_KEYS) caps[k] = 1000
  await setIdentity("registered")
})

afterEach(async () => {
  await clearRedisPatterns(["ratelimit:*", "bruteforce:*", "demo:*"])
  await sql`DELETE FROM kernel.demo_spend`
  // Verified rows on one test domain count against the daily cap of later files.
  await sql`DELETE FROM kernel.demo_leads`
  invalidateDemoMarker()
  DemoVerificationTestAccess.reset()
})

describe("demo leads through the Liaison team outbox", () => {
  // Discriminator: an extra field (network, opt-out token, company) or a missing one fails the exact key set.
  it("flag on: signup on a registered demo instance enqueues one lead with exactly the Protocol fields", async () => {
    const { email } = await signup()
    const rows = await queued()
    expect(rows.map((r) => [r.type, r.status])).toEqual([["lead", "pending"]])
    const data = rows[0]?.data as Record<string, unknown>
    expect(Object.keys(data).sort()).toEqual([
      "email",
      "leadId",
      "name",
      "needs",
      "noticeVersion",
      "notifyManaged",
      "signedUpAt",
      "verified",
    ])
    expect(data).toMatchObject({
      email,
      name: "Lea Martin",
      needs: ["support", "chat"],
      verified: false,
      notifyManaged: false,
    })
    const [lead] = await sql<
      { id: string }[]
    >`SELECT id FROM kernel.demo_leads WHERE email = ${email}`
    expect(data.leadId).toBe(lead?.id as string)
  })

  // Discriminator (R4): registration alone must never send leads.
  it("flag off: a registered demo-mode instance enqueues nothing", async () => {
    env_.LIAISON_TEAM_FORWARD_DEMO_LEADS = false
    await signup()
    expect(await queued()).toEqual([])
  })

  it("unregistered or non-demo instance enqueues nothing", async () => {
    await setIdentity(null)
    await signup()
    await setIdentity("pending")
    await signup()
    await setIdentity("retiring")
    await signup()
    expect(await queued()).toEqual([])

    await setIdentity("registered")
    DemoModeTestAccess.set(false)
    const { id } = await recordDemoLead({
      email: "x@example.com",
      name: "X",
      demoOrgId: crypto.randomUUID(),
    })
    await optOutDemoLead("x".repeat(40))
    await setDemoLeadNotifyManaged(crypto.randomUUID())
    expect(id).toBeTruthy()
    expect(await queued()).toEqual([])
  })

  // Discriminator: a lead that opted out before it was queued is never sent.
  it("an opted-out lead is never sent", async () => {
    const { orgId } = await signup()
    await sql`DELETE FROM kernel.control_plane_outbox`
    const [lead] = await sql<{ id: string; opt_out_token: string }[]>`
      UPDATE kernel.demo_leads SET opted_out_at = now() WHERE demo_org_id = ${orgId}
      RETURNING id, opt_out_token`
    await forwardNewDemoLead(lead?.id as string)
    await sql`UPDATE kernel.demo_leads SET verified_at = now() WHERE id = ${lead?.id}`
    await setDemoLeadNotifyManaged(orgId)
    expect(await queued()).toEqual([])
  })

  it("opt-out enqueues lead-update optedOut once, after the lead", async () => {
    const { orgId } = await signup()
    const [lead] = await sql<{ id: string; opt_out_token: string }[]>`
      SELECT id, opt_out_token FROM kernel.demo_leads WHERE demo_org_id = ${orgId}`
    // The lead has gone out already.
    await sql`UPDATE kernel.control_plane_outbox SET status = 'delivered', attempts = 1`
    expect(await optOutDemoLead(lead?.opt_out_token as string)).toBe(true)
    expect(await optOutDemoLead(lead?.opt_out_token as string)).toBe(true)
    const rows = await queued()
    expect(rows.map((r) => r.type)).toEqual(["lead", "lead-update"])
    expect(rows[1]?.data).toEqual({ leadId: lead?.id as string, optedOut: true })
    expect(rows[1]?.depends_on).not.toBeNull()
  })

  // Discriminator: queuing the opt-out behind a lead that never left sends the
  // email and name after the visitor opted out.
  it("an opt-out while the lead waits unsent cancels it and queues nothing", async () => {
    const { orgId } = await signup()
    const [lead] = await sql<{ id: string; opt_out_token: string }[]>`
      SELECT id, opt_out_token FROM kernel.demo_leads WHERE demo_org_id = ${orgId}`
    expect(await optOutDemoLead(lead?.opt_out_token as string)).toBe(true)
    const rows = await sql<{ type: string; status: string; last_error: string | null }[]>`
      SELECT type, status, last_error FROM kernel.control_plane_outbox`
    expect(rows.map((r) => [r.type, r.status, r.last_error])).toEqual([
      ["lead", "cancelled", "opted_out"],
    ])
  })

  // Discriminator: a lead row already attempted may have reached the Liaison
  // team, so its opt-out must still be sent.
  it("an opt-out after a failed attempt still queues the opt-out", async () => {
    const { orgId } = await signup()
    const [lead] = await sql<{ id: string; opt_out_token: string }[]>`
      SELECT id, opt_out_token FROM kernel.demo_leads WHERE demo_org_id = ${orgId}`
    await sql`UPDATE kernel.control_plane_outbox SET attempts = 1`
    expect(await optOutDemoLead(lead?.opt_out_token as string)).toBe(true)
    expect((await queued()).map((r) => [r.type, r.status])).toEqual([
      ["lead", "pending"],
      ["lead-update", "pending"],
    ])
  })

  // Discriminator: a forward without a synthetic filter files every load-run
  // signup with the Liaison team.
  it("a load-harness lead is never sent, nor its updates", async () => {
    const { id } = await recordDemoLead({
      email: `visitor.${Date.now()}@load.invalid`,
      name: "Load",
      demoOrgId: crypto.randomUUID(),
    })
    await forwardDemoLeadUpdate(id, { verified: true })
    await forwardDemoLeadUpdate(id, { scenarios: ["support-triage"] })
    await forwardDemoLeadUpdate(id, { optedOut: true })
    expect(await queued()).toEqual([])
  })

  // Discriminator: a gate read outside the switches' lock queues the lead
  // after a switch-off that already cancelled the outbox.
  it("a lead queued during a switch-off waits for it and then queues nothing", async () => {
    env_.LIAISON_TEAM_FORWARD_DEMO_LEADS = false
    const { id } = await recordDemoLead({
      email: `race.${Date.now()}@example.com`,
      name: "Race",
      demoOrgId: crypto.randomUUID(),
    })
    env_.LIAISON_TEAM_FORWARD_DEMO_LEADS = true
    let release: () => void = () => {}
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let locked: () => void = () => {}
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve
    })
    // An admin's switch-off, holding the switches' lock: registration off, the
    // identity retiring.
    const switchOff = sql.begin(async (t) => {
      await t`SELECT pg_advisory_xact_lock(hashtext('liaison:liaison_team'))`
      await t`UPDATE kernel.instance_settings
                 SET value = jsonb_set(value, '{register}', 'false')
               WHERE key = 'liaison_team.sharing'`
      await t`UPDATE kernel.instance_settings
                 SET value = jsonb_set(value, '{state}', '"retiring"')
               WHERE key = 'liaison_team.identity'`
      locked()
      await released
    })
    await lockHeld
    const forwarded = forwardNewDemoLead(id)
    const waited = await someoneWaitsOnALock()
    release()
    await switchOff
    await forwarded
    expect(waited).toBe(true)
    expect(await queued()).toEqual([])
  })

  it("notify-managed enqueues lead-update notifyManaged once", async () => {
    const { orgId } = await signup()
    await sql`UPDATE kernel.demo_leads SET verified_at = now() WHERE demo_org_id = ${orgId}`
    expect(await setDemoLeadNotifyManaged(orgId)).toBe(true)
    expect(await setDemoLeadNotifyManaged(orgId)).toBe(true)
    const updates = (await queued()).filter((r) => r.type === "lead-update")
    expect(updates.map((r) => r.data.notifyManaged)).toEqual([true])
  })

  it("a ticked lead goes with notifyManaged, and in full again once verified", async () => {
    const { orgId, email } = await signup(true)
    const code = lastCapturedCode(email)?.code
    await verifyDemoCode(orgId, code as string)
    const rows = await queued()
    expect(rows.map((r) => r.type)).toEqual(["lead", "lead-update", "lead"])
    expect(rows[0]?.data).toMatchObject({ email, notifyManaged: true, verified: false })
    expect(rows[2]?.data).toMatchObject({ email, notifyManaged: true, verified: true })
  })

  it("an unticked lead is not sent a second time on verification", async () => {
    const { orgId, email } = await signup()
    await verifyDemoCode(orgId, lastCapturedCode(email)?.code as string)
    expect((await queued()).map((r) => r.type)).toEqual(["lead", "lead-update"])
  })

  it("an opt-out with the first copy delivered and a second waiting still reaches the team", async () => {
    const { orgId } = await signup()
    await sql`UPDATE kernel.demo_leads SET verified_at = now() WHERE demo_org_id = ${orgId}`
    await sql`UPDATE kernel.control_plane_outbox SET status = 'delivered' WHERE type = 'lead'`
    await setDemoLeadNotifyManaged(orgId)
    const [lead] = await sql<{ opt_out_token: string }[]>`
      SELECT opt_out_token FROM kernel.demo_leads WHERE demo_org_id = ${orgId}`
    await optOutDemoLead(lead?.opt_out_token as string)
    const rows = await queued()
    expect(rows.filter((r) => r.type === "lead").map((r) => r.status)).toEqual([
      "delivered",
      "cancelled",
    ])
    expect(rows.at(-1)).toMatchObject({ type: "lead-update", data: { optedOut: true } })
  })

  it("an erased lead leaves no name or address in the outbox", async () => {
    const first = await signup()
    const second = await signup()
    await sql`UPDATE kernel.control_plane_outbox SET status = 'delivered'
               WHERE type = 'lead' AND data ->> 'email' = ${first.email}`
    await sql`UPDATE kernel.demo_leads SET created_at = now() - interval '73 hours'
               WHERE demo_org_id IN (${first.orgId}, ${second.orgId})`
    expect(await eraseExpiredDemoIdentities()).toBeGreaterThanOrEqual(2)
    const rows = await queued()
    expect(rows.map((r) => [r.status, r.data])).toEqual([
      ["delivered", {}],
      ["cancelled", {}],
    ])
  })

  it("verification enqueues lead-update verified", async () => {
    const { orgId, email } = await signup()
    const code = lastCapturedCode(email)?.code
    expect(code).toBeTruthy()
    await verifyDemoCode(orgId, code as string)
    const updates = (await queued()).filter((r) => r.type === "lead-update")
    const [lead] = await sql<
      { id: string }[]
    >`SELECT id FROM kernel.demo_leads WHERE demo_org_id = ${orgId}`
    expect(updates.map((r) => r.data)).toEqual([{ leadId: lead?.id as string, verified: true }])
  })

  it("the reaper enqueues the played tour ids before the org is gone", async () => {
    const { orgId } = await signup()
    await markOrgAsDemo(orgId, visitorMarker(72, new Date(Date.now() - 80 * 3600_000)))
    invalidateDemoMarker()
    const [user] = await sql<
      { id: string }[]
    >`SELECT id FROM kernel.users WHERE org_id = ${orgId} LIMIT 1`
    for (const tour of ["support-triage", "invoice-run", "support-triage"]) {
      await sql`
        INSERT INTO kernel.tour_progress (org_id, user_id, tour_id, status, source)
        VALUES (${orgId}, ${user?.id}, ${tour}, 'active', 'demo')
        ON CONFLICT DO NOTHING`
    }
    const result = await purgeDemoOrg(orgId)
    expect(result.purged).toBe(true)
    const updates = (await queued()).filter((r) => r.type === "lead-update")
    expect(updates.map((r) => r.data.scenarios)).toEqual([["invoice-run", "support-triage"]])
  })

  it("the reaper queues nothing for an org that played nothing", async () => {
    const { orgId } = await signup()
    await markOrgAsDemo(orgId, visitorMarker(72, new Date(Date.now() - 80 * 3600_000)))
    invalidateDemoMarker()
    expect((await purgeDemoOrg(orgId)).purged).toBe(true)
    expect((await queued()).filter((r) => r.type === "lead-update")).toEqual([])
  })

  // Discriminator: an unguarded forward would reject recordDemoLead and fail the signup.
  it("enqueue throwing does not fail recordDemoLead", async () => {
    // An address the contract rejects makes the payload build throw before the insert.
    const lead = await recordDemoLead({
      email: "not an address",
      name: "Y",
      demoOrgId: crypto.randomUUID(),
    })
    expect(lead.id).toBeTruthy()
    expect(await queued()).toEqual([])
  })
})
