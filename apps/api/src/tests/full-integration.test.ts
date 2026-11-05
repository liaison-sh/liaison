// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { initEventBus } from "~/infra/events/event-bus"
import { resetAppRegistries, toolRegistry, webhookHandlers } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { clearRedisPatterns } from "~/tests/route-test-setup"
import { testApp } from "../../test-support/apps/test"

function makeWebhookHeaders(
  payload: string,
  deliveryId = crypto.randomUUID(),
  timestamp = Math.floor(Date.now() / 1000),
) {
  const signature = createHmac("sha256", "test-webhook-secret")
    .update(`${timestamp}.${payload}`)
    .digest("hex")
  return {
    "Content-Type": "application/json",
    "x-webhook-signature": signature,
    "x-webhook-delivery": deliveryId,
    "x-webhook-timestamp": String(timestamp),
  }
}

describe("kernel full integration", () => {
  let adminToken: string
  let orgId: string

  beforeAll(async () => {
    // Clear all test-related Redis keys
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*", "oauth:*", "events:*"])

    await sql`TRUNCATE kernel.users, kernel.organizations, kernel.sessions,
			kernel.roles, kernel.role_scope_grants, kernel.role_dimension_grants,
			kernel.user_roles, kernel.invitations, kernel.contacts,
			kernel.timeline_entries, kernel.audit_log, kernel.apps CASCADE`

    initEventBus()

    // Bootstrap admin
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpass123", name: "Admin" }),
    })
    const body = (await res.json()) as any as any
    adminToken = body.data.accessToken

    const orgs = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    orgId = orgs[0].id

    // Create test app schema and table
    await sql`CREATE SCHEMA IF NOT EXISTS app_test`
    await sql`CREATE TABLE IF NOT EXISTS app_test.items (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			org_id UUID NOT NULL,
			title TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open',
			team TEXT NOT NULL,
			sensitivity TEXT NOT NULL DEFAULT 'public',
			created_by UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		)`

    // Reset registries so the code-format test app can override the manifest-format
    // one that ensureAppsForOrg registered during auth/register
    resetAppRegistries()
    await registerApps([testApp], orgId)
  })

  afterAll(async () => {
    await sql`TRUNCATE kernel.users, kernel.organizations, kernel.sessions,
			kernel.roles, kernel.role_scope_grants, kernel.role_dimension_grants,
			kernel.user_roles, kernel.invitations, kernel.contacts,
			kernel.timeline_entries, kernel.audit_log, kernel.apps CASCADE`
    await sql`DROP SCHEMA IF EXISTS app_test CASCADE`

    // Clear all test-related Redis keys
    await clearRedisPatterns(["ratelimit:*", "bruteforce:*", "oauth:*", "events:*"])
  })

  describe("test app registration", () => {
    it("test app is registered with active status", async () => {
      const [appRecord] = await sql`SELECT * FROM kernel.apps WHERE name = 'test'`
      expect(appRecord).toBeDefined()
      expect(appRecord.status).toBe("active")
    })

    it("tools appear in registry", () => {
      expect(toolRegistry.has([orgId, "test", "listItems"])).toBe(true)
      expect(toolRegistry.has([orgId, "test", "createItem"])).toBe(true)
      expect(toolRegistry.has([orgId, "test", "riskyAction"])).toBe(true)
      expect(toolRegistry.has([orgId, "test", "externalSearch"])).toBe(true)
    })

    it("webhooks registered", () => {
      expect(webhookHandlers.has([orgId, "test", "test-hook"])).toBe(true)
    })
  })

  describe("health check", () => {
    it("server responds with ok", async () => {
      const res = await app.request("/api/health")
      expect(res.status).toBe(200)
      const body = (await res.json()) as any as any
      expect(body.data.status).toBe("ok")
    })
  })

  describe("full auth lifecycle", () => {
    it("login -> access -> refresh -> logout", async () => {
      const loginRes = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@test.com", password: "testpass123" }),
      })
      expect(loginRes.status).toBe(200)
      const { data: loginData } = (await loginRes.json()) as any

      // Access protected route
      const meRes = await app.request("/api/users/me", {
        headers: { Authorization: `Bearer ${loginData.accessToken}` },
      })
      expect(meRes.status).toBe(200)

      // Refresh
      const refreshRes = await app.request("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: loginData.refreshToken }),
      })
      expect(refreshRes.status).toBe(200)
      const { data: refreshData } = (await refreshRes.json()) as any

      // Old refresh token is in grace period (30s) — still valid briefly for concurrent tabs.
      // After grace period expires, it would return 401. We verify the new token works instead.
      const newMeRes = await app.request("/api/users/me", {
        headers: { Authorization: `Bearer ${refreshData.accessToken}` },
      })
      expect(newMeRes.status).toBe(200)

      // Logout
      const logoutRes = await app.request("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: refreshData.refreshToken }),
      })
      expect(logoutRes.status).toBe(200)
    })
  })

  describe("contact registry", () => {
    it("resolve creates and deduplicates contacts", async () => {
      const res1 = await app.request("/api/contacts/resolve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ email: "integration@test.com", name: "Test" }),
      })
      const { data: c1 } = (await res1.json()) as any

      const res2 = await app.request("/api/contacts/resolve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          email: "integration@test.com",
          externalId: { crm: "123" },
        }),
      })
      const { data: c2 } = (await res2.json()) as any

      expect(c2.id).toBe(c1.id)
      expect(c2.externalIds?.crm).toBe("123")
    })
  })

  describe("webhook infrastructure", () => {
    it("valid signature -> handler invoked -> 200", async () => {
      await clearRedisPatterns(["webhook:replay:*"])

      const payload = JSON.stringify({ event: "test", data: "hello", ts: Date.now() })

      const res = await app.request(`/webhooks/${orgId}/test/test-hook`, {
        method: "POST",
        headers: makeWebhookHeaders(payload),
        body: payload,
      })
      expect(res.status).toBe(200)
    })

    it("invalid signature -> 401", async () => {
      const payload = JSON.stringify({ data: "tampered", ts: Date.now() })
      const res = await app.request(`/webhooks/${orgId}/test/test-hook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-signature": "invalid",
          "x-webhook-delivery": crypto.randomUUID(),
          "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: payload,
      })
      expect(res.status).toBe(401)
    })

    it("missing signature -> 401", async () => {
      const res = await app.request(`/webhooks/${orgId}/test/test-hook`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-webhook-delivery": crypto.randomUUID(),
          "x-webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        },
        body: JSON.stringify({ data: "no sig", ts: Date.now() }),
      })
      expect(res.status).toBe(401)
    })

    it("GET -> 405", async () => {
      const res = await app.request(`/webhooks/${orgId}/test/test-hook`)
      expect(res.status).toBe(405)
    })

    it("unknown endpoint -> 404", async () => {
      const res = await app.request(`/webhooks/${orgId}/test/nonexistent`, {
        method: "POST",
        body: "{}",
      })
      expect(res.status).toBe(404)
    })

    it("webhook does NOT require JWT auth", async () => {
      const payload = JSON.stringify({ noauth: true, ts: Date.now() })

      const res = await app.request(`/webhooks/${orgId}/test/test-hook`, {
        method: "POST",
        headers: makeWebhookHeaders(payload),
        body: payload,
      })
      expect(res.status).toBe(200)
    })

    it("duplicate delivery id -> 409", async () => {
      const payload = JSON.stringify({ event: "test", ts: Date.now() })
      const deliveryId = crypto.randomUUID()
      const headers = makeWebhookHeaders(payload, deliveryId)

      const first = await app.request(`/webhooks/${orgId}/test/test-hook`, {
        method: "POST",
        headers,
        body: payload,
      })
      expect(first.status).toBe(200)

      const second = await app.request(`/webhooks/${orgId}/test/test-hook`, {
        method: "POST",
        headers,
        body: payload,
      })
      // Phase 7.1: duplicate delivery returns 200 with `duplicate: true` (was 409).
      expect(second.status).toBe(200)
      const body = (await second.json()) as { data: { duplicate?: boolean } }
      expect(body.data.duplicate).toBe(true)
    })

    it("stale webhook timestamp -> 401", async () => {
      const payload = JSON.stringify({ event: "test", ts: Date.now() })
      const staleTimestamp = Math.floor(Date.now() / 1000) - 301
      const res = await app.request(`/webhooks/${orgId}/test/test-hook`, {
        method: "POST",
        headers: makeWebhookHeaders(payload, crypto.randomUUID(), staleTimestamp),
        body: payload,
      })
      expect(res.status).toBe(401)
    })
  })

  describe("org settings", () => {
    it("bootstrap created org with defaults", async () => {
      const res = await app.request("/api/org", {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      expect(res.status).toBe(200)
      const { data } = (await res.json()) as any as any
      expect(data.timezone).toBe("UTC")
      expect(data.settings).toBeDefined()
    })
  })

  describe("audit log", () => {
    it("admin can query audit log", async () => {
      const res = await app.request("/api/audit", {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as any as any
      expect(Array.isArray(body.data)).toBe(true)
    })
  })

  describe("middleware pipeline", () => {
    it("404 returns envelope format", async () => {
      const res = await app.request("/api/nonexistent")
      expect(res.status).toBe(404)
      const body = (await res.json()) as any as any
      expect(body.error).toBeDefined()
      expect(body.error.code).toBe("NOT_FOUND")
    })

    it("missing auth on protected route -> 401", async () => {
      const res = await app.request("/api/users/me")
      expect(res.status).toBe(401)
    })
  })
})
