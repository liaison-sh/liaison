// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { type AppEvent, onEvent } from "~/infra/events/event-bus"
import { integrationsRoutes } from "~/modules/settings/integrations-routes"

const TEST_ORG_ID = "00000000-0000-0000-0000-000000000999"

function testApp(scopes: string[] = ["kernel:org:admin"]) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", "test-user")
    c.set("orgId", TEST_ORG_ID)
    c.set("scopes", scopes as any)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/settings/integrations", integrationsRoutes)
  return app
}

describe("integrations routes", () => {
  beforeAll(async () => {
    await sql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG_ID}, 'Integrations Route Org', 'integrations-route-test')
      ON CONFLICT (id) DO NOTHING
    `
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG_ID}`
  })

  it("PATCH /api/settings/integrations/google saves org-level Google OAuth config", async () => {
    const app = testApp()
    const res = await app.request("/api/settings/integrations/google", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "123456789-orgtest.apps.googleusercontent.com",
        clientSecret: "google-client-secret",
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: {
        provider: "google",
        configured: true,
        configurationSource: "org",
        clientIdHint: "...orgtest",
        // No Gmail or Calendar account is connected with another client.
        reconnectToMove: 0,
      },
    })
  })

  it("walk N42: saving or clearing the Google client tells open Settings > Mail pages (mail:provider)", async () => {
    const seen: AppEvent[] = []
    onEvent(
      async (event) => {
        if (event.orgId === TEST_ORG_ID && event.app === "mail" && event.entity === "provider")
          seen.push(event)
      },
      { delivery: "per-replica" },
    )
    const app = testApp()
    const saved = await app.request("/api/settings/integrations/google", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "123456789-orgtest.apps.googleusercontent.com",
        clientSecret: "google-client-secret",
      }),
    })
    expect(saved.status).toBe(200)
    const cleared = await app.request("/api/settings/integrations/google", { method: "DELETE" })
    expect(cleared.status).toBe(200)
    for (let i = 0; i < 50 && seen.length < 2; i++) await Bun.sleep(20)
    expect(seen.map((e) => e.data)).toEqual([
      { id: "gmail", integrationConfigured: true },
      { id: "gmail", integrationConfigured: false },
    ])
  })

  it("PATCH /api/settings/integrations/google rejects a clientId that is not a Google OAuth client id", async () => {
    const app = testApp()
    // The exact foot-gun observed in the field: an email address pasted into
    // the Client ID field, which Google rejects downstream as invalid_client.
    const res = await app.request("/api/settings/integrations/google", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "someone@example.com",
        clientSecret: "google-client-secret",
      }),
    })

    expect(res.status).toBe(400)
  })

  it("PATCH /api/settings/integrations/google rejects callers without org admin scope", async () => {
    const app = testApp([])
    const res = await app.request("/api/settings/integrations/google", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "123456789-orgtest.apps.googleusercontent.com",
        clientSecret: "google-client-secret",
      }),
    })

    expect(res.status).toBe(403)
  })

  it("DELETE /api/settings/integrations/google clears the org override", async () => {
    const app = testApp()
    const save = await app.request("/api/settings/integrations/google", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "123456789-orgtest.apps.googleusercontent.com",
        clientSecret: "google-client-secret",
      }),
    })
    expect(save.status).toBe(200)

    const res = await app.request("/api/settings/integrations/google", { method: "DELETE" })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { configurationSource: string | null } }
    expect(body.data.configurationSource).not.toBe("org")

    const rows = await sql`
      SELECT settings #> '{integrations,google,oauthClient}' AS oauth_client
      FROM kernel.organizations WHERE id = ${TEST_ORG_ID}
    `
    expect(rows[0]?.oauth_client).toBeNull()
  })

  it("DELETE /api/settings/integrations/google rejects callers without org admin scope", async () => {
    const app = testApp([])
    const res = await app.request("/api/settings/integrations/google", { method: "DELETE" })
    expect(res.status).toBe(403)
  })
})
