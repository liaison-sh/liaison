// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every portal route that writes has its own budget per person and per address,
// counted before the route reads its body: past it the route answers 429 with
// Retry-After, and nothing behind it runs. Another person keeps their own budget.
// The limits are real only with RATE_LIMIT_FORCE_ENABLED (off under NODE_ENV=test).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { createPortalSession } from "~/modules/auth/auth"
import { portalBudgetFor } from "~/modules/portal/rate-limits"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"
import { createDoorWorld, type DoorWorld, dropDoorWorld, insertShare } from "./fixture"
import { dropReadsWorld } from "./reads-world"

let w: DoorWorld
let forced: string | undefined

const WRITES = [
  "/api/portal/requests",
  `/api/portal/requests/${crypto.randomUUID()}/reply`,
  "/api/portal/requests/attachments",
  "/api/portal/me/totp/setup",
  "/api/portal/me/totp/confirm",
  "/api/portal/me/notice-ack",
]

async function hit(path: string, token: string) {
  return app.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    // An empty body: the budget counts before validation, so a refused body still counts.
    body: "{}",
  })
}

beforeAll(async () => {
  await acquireTestLock()
  forced = process.env.RATE_LIMIT_FORCE_ENABLED
  process.env.RATE_LIMIT_FORCE_ENABLED = "1"
  w = await createDoorWorld()
  await insertShare(w, { company_id: w.companyA, kind: "requests" })
  await clearRedisPatterns(["ratelimit:portal:*", "ratelimit:ip:*", "ratelimit:user:*"])
}, 180_000)

afterAll(async () => {
  if (forced === undefined) delete process.env.RATE_LIMIT_FORCE_ENABLED
  else process.env.RATE_LIMIT_FORCE_ENABLED = forced
  await clearRedisPatterns(["ratelimit:portal:*", "ratelimit:ip:*", "ratelimit:user:*"])
  if (w) {
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${w.orgId}`.catch(() => {})
    await dropReadsWorld(w)
    await dropDoorWorld(w)
  }
  await sql.unsafe("REVOKE liaison_portal FROM liaison_request GRANTED BY liaison").catch(() => {})
  await releaseTestLock()
})

describe("portal write limits", () => {
  it("every portal write route answers 429 with Retry-After past its budget, and another person keeps theirs", async () => {
    const mine = (await createPortalSession(w.clientA.userId, w.orgId)).accessToken
    const theirs = (await createPortalSession(w.clientB.userId, w.orgId)).accessToken
    for (const path of WRITES) {
      const budget = portalBudgetFor("POST", path)
      expect({ path, budget: budget !== undefined }).toEqual({ path, budget: true })
      if (!budget) continue
      for (let i = 0; i < budget.perPerson; i++) {
        const res = await hit(path, mine)
        expect({ path, i, status: res.status }).not.toEqual({ path, i, status: 429 })
      }
      const over = await hit(path, mine)
      expect({ path, status: over.status }).toEqual({ path, status: 429 })
      expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0)
      const other = await hit(path, theirs)
      expect({ path, status: other.status }).not.toEqual({ path, status: 429 })
    }
  }, 120_000)

  it("a request over the budget creates no ticket", async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM app_tickets.tickets WHERE org_id = ${w.orgId}`
    const budget = portalBudgetFor("POST", "/api/portal/requests")
    // The empty bodies above were refused by validation: no ticket either way.
    expect(n).toBe(0)
    const token = (await createPortalSession(w.clientA.userId, w.orgId)).accessToken
    const res = await app.request("/api/portal/requests", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ subject: "One more", text: "Over the budget." }),
    })
    expect(res.status).toBe(429)
    expect(budget).toBeDefined()
    const [{ m }] = await sql<{ m: number }[]>`
      SELECT count(*)::int AS m FROM app_tickets.tickets WHERE org_id = ${w.orgId}`
    expect(m).toBe(0)
  })
})
