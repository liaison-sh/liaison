// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { sql } from "~/db/connection"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { connectionRoutes } from "~/modules/apps/connections/routes"
import { createScope } from "~/modules/permissions/types"

const TEST_ORG = "00000000-0000-0000-0000-000000620001"
const TEST_USER = "00000000-0000-0000-0000-000000620002"
const OTHER_USER = "00000000-0000-0000-0000-000000620003"
const OTHER_ORG = "00000000-0000-0000-0000-000000620004"

function makeApp(scopes: string[] = []) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("orgId", TEST_ORG)
    c.set("userId", TEST_USER)
    c.set("scopes", scopes.map(createScope))
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/connections", connectionRoutes)
  return app
}

describe("connection routes", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${TEST_ORG}, 'Connection Routes Org', 'connection-routes')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${TEST_USER}, ${TEST_ORG}, 'conn-routes@test.com', 'hash', 'ConnTest', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${OTHER_USER}, ${TEST_ORG}, 'conn-routes-other@test.com', 'hash', 'Other', 'active')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${OTHER_ORG}, 'Connection Routes Other Org', 'connection-routes-other')
      ON CONFLICT (id) DO NOTHING`
    // Insert a connected account with fake encrypted tokens to verify response redaction
    await sql`INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
       identifier, access_token_encrypted, refresh_token_encrypted, credentials_encrypted,
       status, created_by)
      VALUES (
        ${TEST_ORG}, 'test-app', 'gitlab', 'user', ${TEST_USER}, 'oauth2',
        'test-user@example.com',
        ${encryptSecret("fake-access-token", env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)},
        ${encryptSecret("fake-refresh-token", env.ENCRYPTION_KEY, CryptoContext.connectedAccountRefreshToken)},
        NULL, 'active', ${TEST_USER}
      )
      ON CONFLICT DO NOTHING`
    connectionConfigRegistry.set([TEST_ORG, "mail", "imap"], {
      type: "credentials",
      allowedDomains: [],
      credentialFields: [
        { name: "email", label: "Email", type: "text", required: true },
        { name: "imapHost", label: "IMAP Host", type: "text", required: true, readable: true },
        { name: "imapPort", label: "IMAP Port", type: "number", required: true, readable: true },
        { name: "smtpHost", label: "SMTP Host", type: "text", required: true, readable: true },
        { name: "smtpPort", label: "SMTP Port", type: "number", required: true, readable: true },
        { name: "username", label: "Username", type: "text", required: true, readable: true },
        { name: "password", label: "Password", type: "password", required: true },
      ],
    })
  })

  afterAll(async () => {
    connectionConfigRegistry.delete([TEST_ORG, "mail", "imap"])
    connectionConfigRegistry.delete([TEST_ORG, "carrier", "api"])
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id IN (${TEST_ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.users WHERE id IN (${TEST_USER}, ${OTHER_USER})`
    await sql`DELETE FROM kernel.organizations WHERE id = ${OTHER_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
  })

  it("GET /api/connections returns 200 with array", async () => {
    const res = await makeApp().request("/api/connections")
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(Array.isArray(body.data)).toBe(true)
  })

  it("GET /api/connections does not expose encrypted secret fields", async () => {
    const res = await makeApp().request("/api/connections")
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.data.length).toBeGreaterThan(0)
    const account = body.data[0]
    expect(account).not.toHaveProperty("accessTokenEncrypted")
    expect(account).not.toHaveProperty("refreshTokenEncrypted")
    expect(account).not.toHaveProperty("credentialsEncrypted")
    // Safe fields are present
    expect(account.id).toBeDefined()
    expect(account.appName).toBe("test-app")
    expect(account.connectionName).toBe("gitlab")
    expect(account.status).toBe("active")
  })

  it("rejects org credential mode without mail account admin scope", async () => {
    const res = await makeApp().request("/api/connections/mail/imap/credentials?mode=org", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validImapCredentials("shared-no-admin@example.com")),
    })

    expect(res.status).toBe(403)
  })

  it("derives org ownership from explicit credential mode", async () => {
    const res = await makeApp(["mail:accounts:admin"]).request(
      "/api/connections/mail/imap/credentials?mode=org",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validImapCredentials("shared-admin@example.com")),
      },
    )

    expect(res.status).toBe(201)
    const [row] = await sql`
      SELECT owner_type, owner_id
      FROM kernel.connected_accounts
      WHERE org_id = ${TEST_ORG} AND identifier = 'shared-admin@example.com'
      ORDER BY created_at DESC
      LIMIT 1
    `
    expect(row.owner_type).toBe("org")
    expect(row.owner_id).toBeNull()
  })

  describe("GET /:id/settings, the edit form's prefill", () => {
    async function accountId(identifier: string): Promise<string> {
      const [row] = await sql`SELECT id FROM kernel.connected_accounts
        WHERE org_id = ${TEST_ORG} AND identifier = ${identifier} AND status = 'active'`
      return row.id as string
    }

    it("returns an org mailbox's stored hosts, ports and username to the admin wildcard, never the password", async () => {
      const email = "settings-shared@example.com"
      const created = await makeApp(["*"]).request(
        "/api/connections/mail/imap/credentials?mode=org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...validImapCredentials(email), smtpPort: "587" }),
        },
      )
      expect(created.status).toBe(201)

      const res = await makeApp(["*"]).request(
        `/api/connections/${await accountId(email)}/settings`,
      )
      expect(res.status).toBe(200)
      const body: any = await res.json()
      // Only the fields the manifest declares readable: never the password,
      // and not a field it did not mark (the email here).
      expect(body.data.settings).toEqual({
        imapHost: "imap.example.com",
        imapPort: "993",
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        username: email,
      })
      expect(JSON.stringify(body)).not.toContain("secret")
    })

    it("refuses an org mailbox's settings without the admin scope", async () => {
      const email = "settings-shared-2@example.com"
      await makeApp(["mail:accounts:admin"]).request(
        "/api/connections/mail/imap/credentials?mode=org",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validImapCredentials(email)),
        },
      )
      const res = await makeApp().request(`/api/connections/${await accountId(email)}/settings`)
      expect(res.status).toBe(403)
    })

    it("returns a personal mailbox's settings to its owner only", async () => {
      const email = "settings-personal@example.com"
      await makeApp().request("/api/connections/mail/imap/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validImapCredentials(email)),
      })
      const id = await accountId(email)
      const own = await makeApp().request(`/api/connections/${id}/settings`)
      expect(own.status).toBe(200)
      const ownBody: any = await own.json()
      expect(ownBody.data.settings.imapHost).toBe("imap.example.com")
      expect(ownBody.data.settings.password).toBeUndefined()
    })

    async function insertAccount(row: {
      orgId: string
      app: string
      connection: string
      ownerType: "user" | "org"
      ownerId: string | null
      identifier: string
      credentials: Record<string, string> | null
      providerType?: string
    }): Promise<string> {
      const [r] = await sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
         credentials_encrypted, status, created_by)
        VALUES (${row.orgId}, ${row.app}, ${row.connection}, ${row.ownerType}, ${row.ownerId},
          ${row.providerType ?? "credentials"}, ${row.identifier},
          ${row.credentials ? encryptSecret(JSON.stringify(row.credentials), env.ENCRYPTION_KEY, CryptoContext.connectedAccountCredentials) : null},
          'active', ${TEST_USER})
        RETURNING id`
      return r.id as string
    }

    it("another member's personal mailbox is not readable, even by the admin wildcard", async () => {
      const id = await insertAccount({
        orgId: TEST_ORG,
        app: "mail",
        connection: "imap",
        ownerType: "user",
        ownerId: OTHER_USER,
        identifier: "other-member@example.com",
        credentials: validImapCredentials("other-member@example.com"),
      })
      const res = await makeApp(["*"]).request(`/api/connections/${id}/settings`)
      expect(res.status).toBe(404)
    })

    it("an account of another org is not found", async () => {
      // Owned by the caller's own user id, so only the org filter refuses it.
      const id = await insertAccount({
        orgId: OTHER_ORG,
        app: "mail",
        connection: "imap",
        ownerType: "user",
        ownerId: TEST_USER,
        identifier: "cross-org@example.com",
        credentials: validImapCredentials("cross-org@example.com"),
      })
      const res = await makeApp(["*"]).request(`/api/connections/${id}/settings`)
      expect(res.status).toBe(404)
    })

    it("a secret typed as text is not returned unless the manifest marks the field readable", async () => {
      connectionConfigRegistry.set([TEST_ORG, "carrier", "api"], {
        type: "credentials",
        allowedDomains: [],
        credentialFields: [
          { name: "host", label: "Host", type: "text", required: true, readable: true },
          { name: "v1Key", label: "V1 key", type: "text", required: true },
          { name: "v3Key", label: "V3 key", type: "text", required: true },
        ],
      })
      const id = await insertAccount({
        orgId: TEST_ORG,
        app: "carrier",
        connection: "api",
        ownerType: "user",
        ownerId: TEST_USER,
        identifier: "carrier-account",
        credentials: { host: "api.carrier.example", v1Key: "k1-secret", v3Key: "k3-secret" },
      })
      const res = await makeApp().request(`/api/connections/${id}/settings`)
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.settings).toEqual({ host: "api.carrier.example" })
    })

    it("an OAuth connection has no readable settings", async () => {
      const id = await insertAccount({
        orgId: TEST_ORG,
        app: "test-app",
        connection: "gitlab",
        ownerType: "user",
        ownerId: TEST_USER,
        identifier: "oauth-settings@example.com",
        credentials: null,
        providerType: "oauth2",
      })
      const res = await makeApp().request(`/api/connections/${id}/settings`)
      expect(res.status).toBe(200)
      const body: any = await res.json()
      expect(body.data.settings).toEqual({})
    })

    it("a malformed id is not found, not a server error", async () => {
      const res = await makeApp(["*"]).request("/api/connections/not-a-uuid/settings")
      expect(res.status).toBe(404)
    })
  })

  it("ignores client-supplied ownerType on personal credential connect", async () => {
    const res = await makeApp().request("/api/connections/mail/imap/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...validImapCredentials("personal-owner-type@example.com"),
        ownerType: "org",
      }),
    })

    expect(res.status).toBe(201)
    const [row] = await sql`
      SELECT owner_type, owner_id
      FROM kernel.connected_accounts
      WHERE org_id = ${TEST_ORG} AND identifier = 'personal-owner-type@example.com'
      ORDER BY created_at DESC
      LIMIT 1
    `
    expect(row.owner_type).toBe("user")
    expect(row.owner_id).toBe(TEST_USER)
  })
})

function validImapCredentials(email: string) {
  return {
    email,
    imapHost: "imap.example.com",
    imapPort: "993",
    smtpHost: "smtp.example.com",
    smtpPort: "465",
    username: email,
    password: "secret",
  }
}
