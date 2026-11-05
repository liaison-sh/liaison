// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16 Task A8a — `GET /api/apps/manifests/attention-axes`.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import {
  manifestAttentionAxesRegistry,
  manifestAttentionRegistry,
} from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("GET /api/apps/manifests/attention-axes", () => {
  let userToken: string
  let orgId: string

  beforeAll(async () => {
    await acquireTestLock()

    const regRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "axes-admin@test.com",
        password: "testpass123",
        name: "Axes",
      }),
    })
    userToken = ((await regRes.json()) as any).data.accessToken
    const row = await sql`SELECT org_id FROM kernel.users WHERE email = 'axes-admin@test.com'`
    orgId = row[0]!.org_id as string
  })

  afterEach(() => {
    // Clear only the entries we seed here to avoid trampling other tests.
    manifestAttentionRegistry.deleteByPrefix([orgId, "shopify"])
    manifestAttentionRegistry.deleteByPrefix([orgId, "tickets"])
    manifestAttentionAxesRegistry.deleteByPrefix([orgId, "shopify"])
    manifestAttentionAxesRegistry.deleteByPrefix([orgId, "tickets"])
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("returns kinds + filterableAxes per installed app", async () => {
    manifestAttentionRegistry.set(
      [orgId, "shopify"],
      [
        {
          event: "shopify:order_created",
          kind: "shopify:order.created",
          urgency: 50,
          summary: "New order",
          recipients: { kind: "actor" },
        },
      ],
    )
    manifestAttentionAxesRegistry.set(
      [orgId, "shopify"],
      ["market", "currency", "order_value_band", "customer_language"],
    )
    manifestAttentionRegistry.set(
      [orgId, "tickets"],
      [
        {
          event: "tickets:ticket_assigned",
          kind: "unassigned",
          urgency: 50,
          summary: "New ticket",
          recipients: { kind: "actor" },
        },
      ],
    )
    // tickets has no filterableAxes declared.

    const res = await app.request("/api/apps/manifests/attention-axes", {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    const shopify = json.data.find((r: any) => r.app === "shopify")
    expect(shopify.filterableAxes).toEqual([
      "market",
      "currency",
      "order_value_band",
      "customer_language",
    ])
    expect(shopify.kinds).toContain("shopify:order.created")
    const tickets = json.data.find((r: any) => r.app === "tickets")
    expect(tickets.filterableAxes).toEqual([])
    expect(tickets.kinds).toContain("unassigned")
  })

  it("apps with no filterableAxes still appear with empty axes array", async () => {
    manifestAttentionRegistry.set(
      [orgId, "tickets"],
      [
        {
          event: "tickets:ticket_assigned",
          kind: "unassigned",
          urgency: 50,
          summary: "x",
          recipients: { kind: "actor" },
        },
      ],
    )
    const res = await app.request("/api/apps/manifests/attention-axes", {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    const json = (await res.json()) as any
    const tickets = json.data.find((r: any) => r.app === "tickets")
    expect(tickets).toBeDefined()
    expect(tickets.filterableAxes).toEqual([])
  })

  it("apps with only filterableAxes (no translations) still appear", async () => {
    manifestAttentionAxesRegistry.set([orgId, "shopify"], ["market"])
    const res = await app.request("/api/apps/manifests/attention-axes", {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    const json = (await res.json()) as any
    const shopify = json.data.find((r: any) => r.app === "shopify")
    expect(shopify).toBeDefined()
    expect(shopify.kinds).toEqual([])
    expect(shopify.filterableAxes).toEqual(["market"])
  })

  it("rejects unauthenticated requests", async () => {
    const res = await app.request("/api/apps/manifests/attention-axes")
    expect(res.status).toBe(401)
  })
})
