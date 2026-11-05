// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16 Task A8a — REST routes around `kernel.attention_subscriptions`.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("attention/subscriptions routes", () => {
  let userA: minimal.Session
  let userB: minimal.Session

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    userA = await minimal.session(org.id, { role: "member" })
    userB = await minimal.session(org.id, { role: "member" })
  })

  afterAll(async () => {
    if (userA && userB) {
      await sql`
        DELETE FROM kernel.attention_subscriptions
        WHERE user_id IN (${userA.userId}, ${userB.userId})
      `
    }
    await releaseTestLock()
  })

  it("rejects unauthenticated requests", async () => {
    const res = await app.request("/api/attention/subscriptions")
    expect(res.status).toBe(401)
  })

  it("creates a subscription rule for the current user", async () => {
    const res = await app.request("/api/attention/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA.bearer}`,
      },
      body: JSON.stringify({
        source: "shopify",
        kinds: ["shopify:order.created"],
        filters: { market: ["EU"] },
        enabled: true,
      }),
    })
    expect(res.status).toBe(201)
    const rows = await sql`
      SELECT source, kinds, filters, enabled
      FROM kernel.attention_subscriptions
      WHERE user_id = ${userA.userId}
    `
    expect(rows.length).toBe(1)
    expect(rows[0]!.source).toBe("shopify")
    expect(rows[0]!.kinds).toEqual(["shopify:order.created"])
    expect(rows[0]!.filters).toEqual({ market: ["EU"] })
    expect(rows[0]!.enabled).toBe(true)
  })

  it("POSTing a duplicate (user_id, source) returns 409", async () => {
    const res = await app.request("/api/attention/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA.bearer}`,
      },
      body: JSON.stringify({
        source: "shopify",
        kinds: ["*"],
        filters: {},
        enabled: true,
      }),
    })
    expect(res.status).toBe(409)
  })

  it("lists only the current user's rules (RLS isolation)", async () => {
    await sql`
      INSERT INTO kernel.attention_subscriptions (user_id, source, kinds, filters, enabled)
      VALUES (${userB.userId}, 'mail', ARRAY['mention'], '{}'::jsonb, true)
    `
    const res = await app.request("/api/attention/subscriptions", {
      headers: { Authorization: `Bearer ${userA.bearer}` },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.data.every((r: any) => r.source !== "mail")).toBe(true)
    expect(json.data.some((r: any) => r.source === "shopify")).toBe(true)
  })

  it("PUT replaces the rule body", async () => {
    const listRes = await app.request("/api/attention/subscriptions", {
      headers: { Authorization: `Bearer ${userA.bearer}` },
    })
    const list = (await listRes.json()) as any
    const id = list.data[0]!.id
    const beforeRows = await sql`
      SELECT updated_at FROM kernel.attention_subscriptions WHERE id = ${id}
    `
    const beforeUpdatedAt = new Date(beforeRows[0]!.updated_at as string).getTime()
    // Ensure a measurable clock delta so the PUT-bumped updated_at is strictly newer.
    await new Promise((r) => setTimeout(r, 5))

    const putRes = await app.request(`/api/attention/subscriptions/${id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA.bearer}`,
      },
      body: JSON.stringify({
        source: "shopify",
        kinds: ["shopify:order.created", "shopify:refund.created"],
        filters: { market: ["EU", "US"] },
        enabled: false,
      }),
    })
    expect(putRes.status).toBe(200)
    const rows = await sql`
      SELECT kinds, filters, enabled, updated_at FROM kernel.attention_subscriptions WHERE id = ${id}
    `
    expect(rows[0]!.kinds).toEqual(["shopify:order.created", "shopify:refund.created"])
    expect(rows[0]!.enabled).toBe(false)
    // PUT must bump updated_at (the route sets it explicitly).
    const afterUpdatedAt = new Date(rows[0]!.updated_at as string).getTime()
    expect(afterUpdatedAt).toBeGreaterThan(beforeUpdatedAt)
  })

  it("PUT against another user's rule returns 404 (RLS hides it)", async () => {
    const userBRows = await sql`
      SELECT id FROM kernel.attention_subscriptions WHERE user_id = ${userB.userId} LIMIT 1
    `
    const targetId = userBRows[0]!.id
    const res = await app.request(`/api/attention/subscriptions/${targetId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA.bearer}`,
      },
      body: JSON.stringify({
        source: "mail",
        kinds: ["mention"],
        filters: {},
        enabled: false,
      }),
    })
    expect(res.status).toBe(404)
  })

  it("DELETE removes the rule for the current user", async () => {
    const listRes = await app.request("/api/attention/subscriptions", {
      headers: { Authorization: `Bearer ${userA.bearer}` },
    })
    const list = (await listRes.json()) as any
    const id = list.data[0]!.id
    const delRes = await app.request(`/api/attention/subscriptions/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${userA.bearer}` },
    })
    expect(delRes.status).toBe(200)
    const rows = await sql`
      SELECT id FROM kernel.attention_subscriptions WHERE id = ${id}
    `
    expect(rows.length).toBe(0)
  })

  it("400 when body fails validation (bad source)", async () => {
    const res = await app.request("/api/attention/subscriptions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA.bearer}`,
      },
      body: JSON.stringify({
        source: "Bad Source!",
        kinds: ["*"],
        filters: {},
        enabled: true,
      }),
    })
    expect(res.status).toBe(400)
  })
})
