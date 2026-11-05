// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-000000ad0001"
const OTHER_ORG_ID = "00000000-0000-4000-8000-000000ad0009"
const ADMIN_ID = "00000000-0000-4000-8000-000000ad0002"
const MEMBER_ID = "00000000-0000-4000-8000-000000ad0003"
const OTHER_USER_ID = "00000000-0000-4000-8000-000000ad0004"
const BILLING_READER_ID = "00000000-0000-4000-8000-000000ad0005"

describe("credit routes", () => {
  let adminToken: string
  let memberToken: string
  let otherOrgToken: string
  let billingReaderToken: string
  let noBillingToken: string

  beforeAll(async () => {
    await acquireTestLock()

    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CreditOrg', 'credit-org')`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OTHER_ORG_ID}, 'OtherCreditOrg', 'other-credit-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN_ID}, ${ORG_ID}, 'credits-admin@test.com', 'Credits Admin')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${MEMBER_ID}, ${ORG_ID}, 'credits-member@test.com', 'Credits Member')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${BILLING_READER_ID}, ${ORG_ID}, 'credits-reader@test.com', 'Credits Reader')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER_USER_ID}, ${OTHER_ORG_ID}, 'credits-other@test.com', 'Other User')`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.50000000', '5.25000000', 'USD')`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${OTHER_ORG_ID}, '1.00000000', '0.00000000', 'USD')`

    await sql`
      INSERT INTO kernel.credit_transactions
        (id, org_id, user_id, type, amount, balance_after, model, input_tokens, output_tokens, description, created_at)
      VALUES
        ('00000000-0000-4000-8000-000000ad0101', ${ORG_ID}, ${ADMIN_ID}, 'usage', '-1.00000000', '14.75000000', 'claude-sonnet-4', 100, 20, 'usage-1', '2026-04-01T10:00:00Z'),
        ('00000000-0000-4000-8000-000000ad0102', ${ORG_ID}, ${MEMBER_ID}, 'usage', '-2.00000000', '12.75000000', 'gpt-4o', 200, 40, 'usage-2', '2026-04-02T10:00:00Z'),
        ('00000000-0000-4000-8000-000000ad0103', ${ORG_ID}, ${ADMIN_ID}, 'top_up', '5.00000000', '17.75000000', NULL, NULL, NULL, 'top-up', '2026-04-03T10:00:00Z')
    `

    adminToken = await signAccessToken(
      {
        userId: ADMIN_ID,
        orgId: ORG_ID,
        name: "Credits Admin",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )

    memberToken = await signAccessToken(
      {
        userId: MEMBER_ID,
        orgId: ORG_ID,
        name: "Credits Member",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )

    const tokenFor = (userId: string, scopes: string[]) =>
      signAccessToken(
        {
          userId,
          orgId: ORG_ID,
          name: "Credits Reader",
          authVersion: 1,
          permissionVersion: 1,
          scopes,
          dimensionGrants: {},
        },
        env.JWT_SECRET,
      )
    // A role granted ONLY the billing read scope, and a member without it.
    billingReaderToken = await tokenFor(BILLING_READER_ID, ["kernel:billing:read"])
    noBillingToken = await tokenFor(MEMBER_ID, ["kernel:threads:read", "kernel:threads:write"])

    otherOrgToken = await signAccessToken(
      {
        userId: OTHER_USER_ID,
        orgId: OTHER_ORG_ID,
        name: "Other User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.credit_transactions WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
    await sql`DELETE FROM kernel.credit_balances WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG_ID}, ${OTHER_ORG_ID})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_ID}, ${OTHER_ORG_ID})`
    await releaseTestLock()
  })

  it("returns 401 without auth", async () => {
    const res = await app.request("/api/credits/balance")
    expect(res.status).toBe(401)
  })

  it("returns 200 with balance shape", async () => {
    const res = await app.request("/api/credits/balance", {
      headers: { Authorization: `Bearer ${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.currency).toBe("USD")
    expect(body.data).toHaveProperty("included")
    expect(body.data).toHaveProperty("purchased")
  })

  it("paginates transactions without duplicates or gaps", async () => {
    const firstRes = await app.request("/api/credits/transactions?limit=2", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(firstRes.status).toBe(200)
    const firstBody: any = await firstRes.json()
    expect(firstBody.data.items).toHaveLength(2)
    expect(firstBody.data.hasMore).toBe(true)

    const secondRes = await app.request(
      `/api/credits/transactions?limit=2&cursor=${encodeURIComponent(firstBody.data.cursor)}`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    )
    expect(secondRes.status).toBe(200)
    const secondBody: any = await secondRes.json()
    const firstIds = new Set(firstBody.data.items.map((item: any) => item.id))
    for (const item of secondBody.data.items) {
      expect(firstIds.has(item.id)).toBe(false)
    }
  })

  it("scopes transactions to the current user for non-admin requests", async () => {
    const res = await app.request("/api/credits/transactions?limit=10", {
      headers: { Authorization: `Bearer ${memberToken}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.items.length).toBeGreaterThan(0)
    expect(body.data.items.every((item: any) => item.userId === MEMBER_ID)).toBe(true)
  })

  it("aggregates usage with admin user filtering", async () => {
    const res = await app.request(
      `/api/credits/usage?period=daily&from=2026-04-01&to=2026-04-03&userId=${ADMIN_ID}`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    )
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.totalCost).toBe("1.00000000")
    expect(body.data.buckets).toHaveLength(1)
    expect(body.data.buckets[0].models["claude-sonnet-4"]).toBe("1.00000000")
  })

  it("includes byok_usage rows in the usage chart aggregation", async () => {
    const day = "2026-05-10"
    await sql`INSERT INTO kernel.credit_transactions (org_id, user_id, type, amount, balance_after, model, input_tokens, output_tokens, raw_cost, created_at)
      VALUES
        (${ORG_ID}, ${ADMIN_ID}, 'usage',       -1.00000000, 0, 'claude-haiku-4-5', 100, 50, 1.00000000, ${`${day}T10:00:00Z`}),
        (${ORG_ID}, ${ADMIN_ID}, 'byok_usage',  -2.00000000, 0, 'claude-haiku-4-5', 200, 90, 2.00000000, ${`${day}T11:00:00Z`})`

    const res = await app.request(`/api/credits/usage?period=daily&from=2026-05-10&to=2026-05-10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    // Exactly one bucket for the single seeded day (date_trunc bucketing).
    expect(body.data.buckets).toHaveLength(1)
    const bucket = body.data.buckets[0]
    // 1.00 (usage) + 2.00 (byok_usage) both counted — byok_usage is not excluded
    expect(Number(bucket.total)).toBeCloseTo(3.0, 6)
    expect(bucket.models["claude-haiku-4-5"]).toBeDefined()
    expect(Number(body.data.totalCost)).toBeCloseTo(3.0, 6)
  })

  it("lets a billing:read only role read usage and its own transactions", async () => {
    const auth = { headers: { Authorization: `Bearer ${billingReaderToken}` } }
    const usage = await app.request(
      `/api/credits/usage?period=daily&from=2026-04-01&to=2026-04-03&userId=${ADMIN_ID}`,
      auth,
    )
    expect(usage.status).toBe(200)
    // Not an org admin: the userId filter is ignored, the reader has no spend.
    const usageBody: any = await usage.json()
    expect(Number(usageBody.data.totalCost)).toBe(0)

    const tx = await app.request(`/api/credits/transactions?limit=10&userId=${ADMIN_ID}`, auth)
    expect(tx.status).toBe(200)
    const txBody: any = await tx.json()
    expect(txBody.data.items).toEqual([])
  })

  it("refuses usage and transaction reads without kernel:billing:read, balance stays open", async () => {
    const auth = { headers: { Authorization: `Bearer ${noBillingToken}` } }
    const usage = await app.request(
      "/api/credits/usage?period=daily&from=2026-04-01&to=2026-04-03",
      auth,
    )
    expect(usage.status).toBe(403)
    const tx = await app.request("/api/credits/transactions?limit=10", auth)
    expect(tx.status).toBe(403)
    const balance = await app.request("/api/credits/balance", auth)
    expect(balance.status).toBe(200)
  })

  it("does not let a billing:read only role mutate org AI keys", async () => {
    const res = await app.request("/api/settings/ai/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${billingReaderToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider: "anthropic", apiKey: "sk-ant-test-not-real" }),
    })
    expect(res.status).toBe(403)
    const del = await app.request("/api/settings/ai/keys/anthropic", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${billingReaderToken}` },
    })
    expect(del.status).toBe(403)
  })

  it("does not allow cross-org tokens to observe this org's transaction stream", async () => {
    const res = await app.request("/api/credits/transactions?limit=10", {
      headers: { Authorization: `Bearer ${otherOrgToken}` },
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.items).toEqual([])
  })
})
