// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { connectionConfigRegistry, manifestRegistry } from "~/modules/apps/app-registries"
import { signAccessToken } from "~/modules/auth/jwt"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// GET /api/apps/:appName/connections — the public-safe connection-config
// endpoint the connect UI reads (credentialFields + setupGuide for the form +
// `?` popover). Must never leak secret-config keys.
describe("GET /api/apps/:appName/connections", () => {
  const APP = "t2_demo"
  let orgId: string
  let token: string
  let userId: string

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    orgId = org.id
    userId = await withSystemDb("t2-user-lookup", async (db) => {
      const [u] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.orgId, orgId))
        .limit(1)
      if (!u) throw new Error("no admin user after createTestOrg")
      return u.id
    })
    token = await signAccessToken(
      { userId, orgId, name: "T2", authVersion: 1, permissionVersion: 1, scopes: [] },
      env.JWT_SECRET,
    )
    // The org is already initialized (createTestOrg → ensureAppsForOrg), so the
    // endpoint's own ensureAppsForOrg short-circuits and these synthetic
    // registry entries survive.
    manifestRegistry.set([orgId, APP], { name: APP, uiBundleUrl: null })
    connectionConfigRegistry.set([orgId, APP, "creds"], {
      type: "credentials",
      allowedDomains: ["demo.test"],
      credentialFields: [
        { name: "token", label: "API token", type: "password", required: true },
        { name: "region", label: "Region", type: "text" },
      ],
      setupGuide: {
        summary: "How to connect.",
        steps: ["Step one", "Step **two**"],
        docsUrl: "https://docs.demo.test",
      },
      clientSecretConfigKey: "demo.clientSecret",
      webhookSecretConfigKey: "demo.webhookSecret",
    })
    connectionConfigRegistry.set([orgId, APP, "oauthconn"], {
      type: "oauth2",
      allowedDomains: ["demo.test"],
      authorizationUrl: "https://demo.test/oauth/authorize",
      tokenUrl: "https://demo.test/oauth/token",
      clientSecretConfigKey: "demo.oauthSecret",
      setupGuide: { summary: "Click connect.", docsUrl: "https://docs.demo.test/oauth" },
    })
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`
    connectionConfigRegistry.deleteByPrefix([orgId, APP])
    manifestRegistry.delete([orgId, APP])
    await releaseTestLock()
  })

  it("returns credentialFields + setupGuide for a credentials connection", async () => {
    const res = await app.request(`/api/apps/${APP}/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const creds = body.data.find((x: any) => x.name === "creds")
    expect(creds.type).toBe("credentials")
    expect(creds.credentialFields).toHaveLength(2)
    expect(creds.credentialFields[0]).toMatchObject({
      name: "token",
      type: "password",
      required: true,
    })
    expect(creds.setupGuide.summary).toBe("How to connect.")
    expect(creds.setupGuide.steps).toEqual(["Step one", "Step **two**"])
    expect(creds.setupGuide.docsUrl).toBe("https://docs.demo.test")
  })

  it("omits secret-config keys and other non-public fields from every connection", async () => {
    const res = await app.request(`/api/apps/${APP}/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as any
    const serialized = JSON.stringify(body.data)
    expect(serialized).not.toContain("clientSecretConfigKey")
    expect(serialized).not.toContain("webhookSecretConfigKey")
    expect(serialized).not.toContain("demo.clientSecret")
    expect(serialized).not.toContain("demo.webhookSecret")
    expect(serialized).not.toContain("demo.oauthSecret")
    // Whitelist projection — OAuth endpoints + allowedDomains are not exposed.
    expect(serialized).not.toContain("authorizationUrl")
    expect(serialized).not.toContain("allowedDomains")
  })

  it("returns both oauth2 and credentials connections with their type + setupGuide", async () => {
    const res = await app.request(`/api/apps/${APP}/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as any
    const types = body.data.map((x: any) => x.type).sort()
    expect(types).toEqual(["credentials", "oauth2"])
    const oauth = body.data.find((x: any) => x.name === "oauthconn")
    expect(oauth.type).toBe("oauth2")
    expect(oauth.setupGuide.summary).toBe("Click connect.")
  })

  // A multi-instance connection's accounts are each named by an identifier the
  // app defines (an adapter slug), so the generic connect form cannot add or
  // replace one: the settings block reads this flag to leave that to the app.
  it("marks a multi-instance connection, and only that one", async () => {
    connectionConfigRegistry.set([orgId, APP, "multi"], {
      type: "credentials",
      multiInstance: true,
      allowedDomains: ["demo.test"],
      credentialFields: [{ name: "token", label: "Token", type: "password" }],
    })
    try {
      const res = await app.request(`/api/apps/${APP}/connections`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = (await res.json()) as any
      expect(body.data.find((x: any) => x.name === "multi").multiInstance).toBe(true)
      expect(body.data.find((x: any) => x.name === "creds").multiInstance).toBeUndefined()
    } finally {
      connectionConfigRegistry.delete([orgId, APP, "multi"])
    }
  })

  // Settings > Apps (design audit 2026-09-30, finding 11): each connection says
  // whether the app needs it, what it connects, and whether an account backs
  // it, and the page reads every app's connections in ONE request.
  describe("optional, purpose and account state", () => {
    const WEBHOOK = "webhook"
    let otherUserId: string

    beforeAll(async () => {
      connectionConfigRegistry.set([orgId, APP, WEBHOOK], {
        type: "credentials",
        allowedDomains: [],
        optional: true,
        purpose: "CI release-status webhook",
        credentialFields: [{ name: "label", label: "Label", type: "text" }],
        webhookSecretConfigKey: "demo.webhookSecret2",
      })
      const [other] = await sql<Array<{ id: string }>>`
        INSERT INTO kernel.users (org_id, email, name, status)
        VALUES (${orgId}, ${`other-${orgId}@test.local`}, 'Other', 'active') RETURNING id`
      otherUserId = other!.id
      const account = (ownerType: string, ownerId: string | null, conn: string, status: string) =>
        sql`INSERT INTO kernel.connected_accounts
              (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
               identifier, status, created_by)
            VALUES (${orgId}, ${APP}, ${conn}, ${ownerType}, ${ownerId}, 'credentials',
                    ${`${conn}-${status}-${ownerType}`}, ${status}, ${userId})`
      await account("org", null, "creds", "active")
      await account("user", userId, "creds", "error")
      // Another member's personal account and a disconnected one never count.
      await account("user", otherUserId, "oauthconn", "active")
      await account("org", null, "oauthconn", "disconnected")
    })

    it("marks optional connections, names their purpose, and lists them after required ones", async () => {
      const res = await app.request(`/api/apps/${APP}/connections`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = (await res.json()) as any
      expect(body.data.map((x: any) => x.name)).toEqual(["creds", "oauthconn", WEBHOOK])
      const hook = body.data.find((x: any) => x.name === WEBHOOK)
      expect(hook.optional).toBe(true)
      expect(hook.purpose).toBe("CI release-status webhook")
      expect(body.data.find((x: any) => x.name === "creds").optional).toBe(false)
      expect(JSON.stringify(body.data)).not.toContain("demo.webhookSecret2")
    })

    it("counts the org's accounts and the caller's own, never another member's", async () => {
      const res = await app.request(`/api/apps/${APP}/connections`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = (await res.json()) as any
      const byName = Object.fromEntries(body.data.map((x: any) => [x.name, x.accounts]))
      expect(byName.creds).toEqual({ active: 1, error: 1 })
      expect(byName.oauthconn).toEqual({ active: 0, error: 0 })
      expect(byName[WEBHOOK]).toEqual({ active: 0, error: 0 })
      // Counts only: no identifier of any account reaches the page.
      expect(JSON.stringify(body.data)).not.toContain("creds-active-org")
    })

    it("GET /api/apps/connections returns every app's views in one response", async () => {
      const res = await app.request("/api/apps/connections", {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      const single = (await (
        await app.request(`/api/apps/${APP}/connections`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).json()) as any
      expect(body.data[APP]).toEqual(single.data)
      expect(JSON.stringify(body.data)).not.toContain("clientSecretConfigKey")
      expect(JSON.stringify(body.data)).not.toContain("allowedDomains")
    })
  })

  it("404s for an app that is not installed", async () => {
    const res = await app.request(`/api/apps/nope_unknown/connections`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
  })
})
