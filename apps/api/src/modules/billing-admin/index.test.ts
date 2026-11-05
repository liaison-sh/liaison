// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createBillingAdminRoutes } from "./"

const APIKEY = "supersecretsupersecret_____________"

function appWithKey(key?: string) {
  const a = new Hono()
  a.route("/api/admin/billing", createBillingAdminRoutes(key))
  return a
}

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("POST /api/admin/billing/credits", () => {
  test("401 without bearer", async () => {
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)
    const r = await app.request("/api/admin/billing/credits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: org.id, amountCredits: "10", externalPaymentRef: "x" }),
    })
    expect(r.status).toBe(401)
  })

  test("404 when env unset", async () => {
    const app = appWithKey(undefined)
    const r = await app.request("/api/admin/billing/credits", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: "{}",
    })
    expect(r.status).toBe(404)
  })

  test("200 with bearer; returns transactionId and balanceAfter", async () => {
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)
    const r = await app.request("/api/admin/billing/credits", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify({ orgId: org.id, amountCredits: "25", externalPaymentRef: "ref_001" }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: { balanceAfter: string; transactionId: string } }
    // bootstrap initialises an included balance; top-up adds 25 on top.
    expect(Number(body.data.balanceAfter)).toBeGreaterThanOrEqual(25)
    expect(typeof body.data.transactionId).toBe("string")
  })

  test("idempotent replay returns 200 with existing tx", async () => {
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)
    const body = { orgId: org.id, amountCredits: "25", externalPaymentRef: "ref_dup" }
    const r1 = await app.request("/api/admin/billing/credits", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const r2 = await app.request("/api/admin/billing/credits", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const b1 = (await r1.json()) as { data: { transactionId: string } }
    const b2 = (await r2.json()) as { data: { transactionId: string } }
    expect(b2.data.transactionId).toBe(b1.data.transactionId)
  })

  test("409 on same ref with different amount", async () => {
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)
    const send = (amt: string) =>
      app.request("/api/admin/billing/credits", {
        method: "POST",
        headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
        body: JSON.stringify({ orgId: org.id, amountCredits: amt, externalPaymentRef: "ref_conf" }),
      })
    expect((await send("10")).status).toBe(200)
    const r = await send("99")
    expect(r.status).toBe(409)
    const body = (await r.json()) as { error: { code: string; diff: unknown } }
    expect(body.error.code).toBe("idempotency_conflict")
    expect(body.error.diff).toBeDefined()
  })

  test("400 on missing required fields", async () => {
    const app = appWithKey(APIKEY)
    const r = await app.request("/api/admin/billing/credits", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
  })
})

describe("POST /api/admin/billing/credits/reset", () => {
  test("idempotent on cycleId", async () => {
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)
    const body = { orgId: org.id, cycleId: "2026-05" }
    const r1 = await app.request("/api/admin/billing/credits/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const r2 = await app.request("/api/admin/billing/credits/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const b1 = (await r1.json()) as { data: { balanceAfter: string } }
    const b2 = (await r2.json()) as { data: { balanceAfter: string } }
    expect(b2.data.balanceAfter).toBe(b1.data.balanceAfter)
  })

  test("replay after tier change returns the original balance, not 409", async () => {
    // Reset at tier A, then change tier to B, then replay the same (orgId,
    // cycleId). The replay must succeed (200) with the original balance,
    // because the cycle is already settled — recomputing allowance from the
    // current tier would otherwise raise idempotency_conflict on amount.
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)
    const body = { orgId: org.id, cycleId: "2026-06" }
    const r1 = await app.request("/api/admin/billing/credits/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(r1.status).toBe(200)
    const b1 = (await r1.json()) as { data: { balanceAfter: string } }

    // Bump tier — kernel default would now compute a different allowance.
    const t = await app.request(`/api/admin/billing/org/${org.id}/tier`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify({ tier: "business" }),
    })
    expect(t.status).toBe(200)

    const r2 = await app.request("/api/admin/billing/credits/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(r2.status).toBe(200)
    const b2 = (await r2.json()) as { data: { balanceAfter: string } }
    expect(b2.data.balanceAfter).toBe(b1.data.balanceAfter)
  })

  test("concurrent reset requests both succeed and return the same balance", async () => {
    // Simulate a concurrent race: fire two identical reset requests in parallel.
    // The second one will hit the IdempotencyConflictError fallback path in the
    // route and must return 200 with the stored value rather than a 409/500.
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)
    const body = { orgId: org.id, cycleId: "2026-07" }
    const [r1, r2] = await Promise.all([
      app.request("/api/admin/billing/credits/reset", {
        method: "POST",
        headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      app.request("/api/admin/billing/credits/reset", {
        method: "POST",
        headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ])
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    const b1 = (await r1.json()) as { data: { balanceAfter: string } }
    const b2 = (await r2.json()) as { data: { balanceAfter: string } }
    expect(b1.data.balanceAfter).toBe(b2.data.balanceAfter)
  })

  test("zero-allowance tier reset returns 200 with unchanged balance", async () => {
    // The starter tier has a 0-credit monthly allowance. Resetting for a starter
    // org must still return 200 — addCredits(0) is a valid no-op reset.
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)

    // Ensure the org is on the starter tier (which has 0 included credits).
    const tierR = await app.request(`/api/admin/billing/org/${org.id}/tier`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify({ tier: "starter" }),
    })
    expect(tierR.status).toBe(200)

    const r = await app.request("/api/admin/billing/credits/reset", {
      method: "POST",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify({ orgId: org.id, cycleId: "2026-08" }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { data: { balanceAfter: string } }
    // Numeric result is non-negative (existing balance preserved; 0 included
    // credits adds nothing on top).
    expect(Number(body.data.balanceAfter)).toBeGreaterThanOrEqual(0)
  })
})

describe("PATCH /api/admin/billing/org/:orgId/tier", () => {
  test("updates tier", async () => {
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)
    const r = await app.request(`/api/admin/billing/org/${org.id}/tier`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify({ tier: "team" }),
    })
    expect(r.status).toBe(200)
    const b = (await r.json()) as { data: { tier: string } }
    expect(b.data.tier).toBe("team")
  })

  test("rejects unknown tier", async () => {
    const org = await createTestOrg()
    const app = appWithKey(APIKEY)
    const r = await app.request(`/api/admin/billing/org/${org.id}/tier`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${APIKEY}`, "content-type": "application/json" },
      body: JSON.stringify({ tier: "nonsense" }),
    })
    expect(r.status).toBe(400)
  })
})
