// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { allocatePorts, api, createUserWithScopes } from "@liaison/test-helpers"
import { startMockOidc } from "./helpers/mock-oidc"
import { setupScenario, teardownScenario } from "./setup"

// ─── Helpers ───

const SYNC_STARTED_STATUSES = ["pre-sync", "syncing", "active"]

async function patchOAuthState(env: WorkerEnv, state: string, oidcPort: number) {
  const redisPrefix = env.redisPrefix ?? ""
  const key = `${redisPrefix}oauth:state:${state}`
  const raw = await env.redis.redis.get(key)
  if (!raw) throw new Error("OAuth state not found in Redis")
  const parsed = JSON.parse(raw)
  parsed.tokenUrl = `http://localhost:${oidcPort}/token`
  const ttl = await env.redis.redis.ttl(key)
  await env.redis.redis.set(key, JSON.stringify(parsed), "EX", ttl > 0 ? ttl : 900)
}

async function waitForExtensionRow(
  env: WorkerEnv,
  where: string,
  timeoutMs = 5000,
): Promise<Record<string, any>> {
  const ms = env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const rows = await env.db.sql.unsafe(`SELECT * FROM ${ms}.accounts WHERE ${where} LIMIT 1`)
    if (rows.length > 0) return rows[0]
    await Bun.sleep(200)
  }
  throw new Error(`Extension row not found within ${timeoutMs}ms: ${where}`)
}

async function setGmailProviderEnabled(url: string, token: string, enabled: boolean) {
  const res = await api(url, "/api/mail/providers/gmail", {
    token,
    method: "PATCH",
    body: { enabled },
  })

  expect(res.status).toBe(200)
  expect(res.body.data.enabled).toBe(enabled)
}

async function doGmailOAuthFlow(
  url: string,
  token: string,
  env: WorkerEnv,
  oidcPort: number,
  opts?: { ownerType?: "org"; loginHint?: string },
): Promise<{ kernelId: string; extensionRow: Record<string, any> }> {
  // 1. Initiate authorize
  const authRes = await api(url, "/api/connections/mail/gmail/authorize", {
    token,
    body: opts?.ownerType ? { ownerType: opts.ownerType } : {},
  })
  expect(authRes.status).toBe(200)
  const redirectUrl = new URL(authRes.body.data.redirectUrl)
  const state = redirectUrl.searchParams.get("state")!

  // 2. Patch Redis state to point tokenUrl at mock OIDC
  await patchOAuthState(env, state, oidcPort)

  // 3. Call mock OIDC /authorize with the state (skip Google's real endpoint)
  const callbackUri = `${url}/api/connections/callback`
  const email = opts?.loginHint ?? "gmail-user@e2e.test"
  const oidcAuthUrl = `http://localhost:${oidcPort}/authorize?state=${state}&redirect_uri=${encodeURIComponent(callbackUri)}&login_hint=${encodeURIComponent(email)}`
  const oidcRes = await fetch(oidcAuthUrl, { redirect: "manual" })
  const oidcLocation = oidcRes.headers.get("location")!
  const cbUrl = new URL(oidcLocation)
  const code = cbUrl.searchParams.get("code")!

  // 4. Hit the real callback endpoint
  // The callback must come from the browser that started the flow: it carries
  // the binding cookie the authorize response set.
  const cbRes = await fetch(`${url}/api/connections/callback?code=${code}&state=${state}`, {
    redirect: "manual",
    headers: { cookie: (authRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
  })
  expect(cbRes.status).toBe(302)

  // 5. Wait for extension row; the initial sync worker may advance status quickly.
  const extensionRow = await waitForExtensionRow(
    env,
    `email_address = '${email}' AND sync_status != 'disconnected'`,
  )

  // 6. Find kernel row
  const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
  const [kernelRow] = await env.db.sql.unsafe(
    `SELECT id FROM ${ks}.connected_accounts WHERE identifier = '${email}' AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  )

  return { kernelId: kernelRow.id, extensionRow }
}

// ─── Test Suite ───

describe("Mail Connections Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string
  let oidc: Awaited<ReturnType<typeof startMockOidc>>
  let oidcPort: number

  // Shared across all journey groups
  let adminToken: string
  let orgId: string
  let nonAdminUser: { id: string; token: string; email: string }
  let _dimensionUser: { id: string; token: string; email: string }

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 6,
      org: { name: "Mail Connections Test" },
      populate: {
        users: { count: 10 },
        threads: { count: 20, participants: "random(2-4)", messages: "random(1-3)" },
      },
      serverEnv: {
        GMAIL_OAUTH_CLIENT_ID: "api-e2e-gmail-client-id",
        GMAIL_OAUTH_CLIENT_SECRET: "api-e2e-gmail-client-secret",
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    adminToken = world.admin.token
    orgId = world.org.id

    // Start mock OIDC on dynamic port
    const [port] = await allocatePorts(1)
    oidcPort = port
    oidc = await startMockOidc(oidcPort)

    // Create non-admin user with mail read/write but no admin
    nonAdminUser = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
      scopes: ["mail:accounts:read", "mail:accounts:write"],
      dimensions: {},
      schemaPrefix: env.schemaPrefix,
    })

    // Create dimension-granted user (will receive inbox grant after org account created)
    _dimensionUser = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
      scopes: ["mail:accounts:read"],
      dimensions: {},
      schemaPrefix: env.schemaPrefix,
    })
  }, 120_000)

  afterAll(async () => {
    if (oidc) oidc.stop()
    await teardownScenario(env, world)
  }, 15_000)

  // ════════════════════════════════════════════════════════════════════════
  //  Journey 1: Smoke — IMAP credential → extension row
  // ════════════════════════════════════════════════════════════════════════

  describe("Smoke", () => {
    it("IMAP credential connection creates extension row", async () => {
      const res = await api(url, "/api/connections/mail/imap/credentials", {
        token: adminToken,
        body: {
          email: "smoke-test@imap.test",
          imapHost: "imap.smoke.test",
          imapPort: 993,
          smtpHost: "smtp.smoke.test",
          smtpPort: 587,
          username: "smoke-test@imap.test",
          password: "smoke-password",
        },
      })
      expect(res.status).toBe(201)
      expect(res.body.data.identifier).toBe("smoke-test@imap.test")
      expect(res.body.data.status).toBe("active")
      expect(res.body.data.providerType).toBe("credentials")

      const row = await waitForExtensionRow(
        env,
        "provider = 'imap' AND email_address = 'smoke-test@imap.test'",
      )
      expect(SYNC_STARTED_STATUSES).toContain(row.sync_status)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  Journey 2: Gmail OAuth + IMAP journeys (S1, S2, S3, S4, S12)
  // ════════════════════════════════════════════════════════════════════════

  describe("Gmail OAuth + IMAP journeys", () => {
    let gmailKernelId: string
    let gmailExtensionRow: Record<string, any>
    let imapKernelId: string
    let imapExtensionRow: Record<string, any>
    let orgGmailKernelId: string
    let orgGmailExtensionRow: Record<string, any>

    it("S4b: Gmail authorize is blocked until the org enables Gmail, then the callback succeeds without an oauth_providers row", async () => {
      const disabled = await api(url, "/api/connections/mail/gmail/authorize", {
        token: nonAdminUser.token,
        body: {},
      })

      expect(disabled.status).toBe(403)
      expect(disabled.body.error.message).toContain("Gmail is not enabled")

      await setGmailProviderEnabled(url, adminToken, true)

      const authRes = await api(url, "/api/connections/mail/gmail/authorize", {
        token: nonAdminUser.token,
        body: {},
      })

      expect(authRes.status).toBe(200)
      expect(authRes.body.data.redirectUrl).toContain("accounts.google.com")

      const state = new URL(authRes.body.data.redirectUrl).searchParams.get("state")!
      await patchOAuthState(env, state, oidcPort)

      const callbackUri = `${url}/api/connections/callback`
      const email = "gmail-enabled@e2e.test"
      const oidcAuthUrl = `http://localhost:${oidcPort}/authorize?state=${state}&redirect_uri=${encodeURIComponent(callbackUri)}&login_hint=${encodeURIComponent(email)}`
      const oidcRes = await fetch(oidcAuthUrl, { redirect: "manual" })
      const callbackUrl = new URL(oidcRes.headers.get("location")!)
      const code = callbackUrl.searchParams.get("code")!

      // The callback must come from the browser that started the flow: it carries
      // the binding cookie the authorize response set.
      const callbackRes = await fetch(
        `${url}/api/connections/callback?code=${code}&state=${state}`,
        {
          redirect: "manual",
          headers: { cookie: (authRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "" },
        },
      )

      expect(callbackRes.status).toBe(302)

      const connected = await waitForExtensionRow(env, `email_address = '${email}'`)
      expect(connected.email_address).toBe(email)

      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
      const oauthProvidersRows = await env.db.sql.unsafe(
        `SELECT id FROM ${ks}.oauth_providers WHERE name = 'mail:gmail'`,
      )
      expect(oauthProvidersRows.length).toBe(0)
    })

    it("S4c: mail admins can configure shared Google integration, enable Gmail, and complete Gmail OAuth while unrelated SSO providers exist", async () => {
      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

      // Seed an unrelated SSO provider to prove separation
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.oauth_providers (org_id, name, issuer_url, authorization_endpoint, token_endpoint, userinfo_endpoint, client_id, client_secret_encrypted, scopes)
         VALUES ($1, 'corporate-sso', 'https://sso.corp.example', 'https://sso.corp.example/authorize', 'https://sso.corp.example/token', 'https://sso.corp.example/userinfo', 'sso-client-id', 'fake-encrypted', '["openid"]')`,
        [orgId],
      )

      // Configure shared Google integration
      const integrationRes = await api(url, "/api/settings/integrations/google", {
        token: adminToken,
        method: "PATCH",
        body: {
          clientId: "123456789-orgtest.apps.googleusercontent.com",
          clientSecret: "google-client-secret",
        },
      })
      expect(integrationRes.status).toBe(200)

      // Complete Gmail OAuth flow
      const result = await doGmailOAuthFlow(url, adminToken, env, oidcPort, {
        loginHint: "shared-google@gmail.e2e.test",
      })

      expect(result.extensionRow.email_address).toBe("shared-google@gmail.e2e.test")

      // Verify unrelated SSO provider still exists and is the only oauth_providers row
      const oauthProviderRows = await env.db.sql.unsafe(
        `SELECT name FROM ${ks}.oauth_providers WHERE org_id = '${orgId}' ORDER BY name ASC`,
      )
      expect(oauthProviderRows.map((row) => ({ name: row.name }))).toEqual([
        { name: "corporate-sso" },
      ])
    })

    // S1: Gmail OAuth — user connects personal account
    it("S1: Gmail OAuth — personal account connection", async () => {
      const result = await doGmailOAuthFlow(url, adminToken, env, oidcPort, {
        loginHint: "personal@gmail.e2e.test",
      })
      gmailKernelId = result.kernelId
      gmailExtensionRow = result.extensionRow

      // Verify kernel row
      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
      const [kernelRow] = await env.db.sql.unsafe(
        `SELECT * FROM ${ks}.connected_accounts WHERE id = '${gmailKernelId}'`,
      )
      expect(kernelRow.app_name).toBe("mail")
      expect(kernelRow.connection_name).toBe("gmail")
      expect(kernelRow.owner_type).toBe("user")
      expect(kernelRow.status).toBe("active")
      expect(kernelRow.identifier).toBe("personal@gmail.e2e.test")

      // Verify extension row
      expect(gmailExtensionRow.provider).toBe("gmail")
      expect(SYNC_STARTED_STATUSES).toContain(gmailExtensionRow.sync_status)
      expect(gmailExtensionRow.owner_type).toBe("user")
      expect(gmailExtensionRow.email_address).toBe("personal@gmail.e2e.test")
      expect(gmailExtensionRow.connected_account_id).toBe(gmailKernelId)
    })

    // S2: IMAP credential — user connects personal account
    it("S2: IMAP credential — personal account connection", async () => {
      const res = await api(url, "/api/connections/mail/imap/credentials", {
        token: adminToken,
        body: {
          email: "imap-user@provider.e2e.test",
          imapHost: "imap.provider.e2e.test",
          imapPort: 993,
          smtpHost: "smtp.provider.e2e.test",
          smtpPort: 587,
          username: "imap-user@provider.e2e.test",
          password: "imap-password-123",
        },
      })
      expect(res.status).toBe(201)
      expect(res.body.data.identifier).toBe("imap-user@provider.e2e.test")
      expect(res.body.data.providerType).toBe("credentials")
      imapKernelId = res.body.data.id

      // Verify kernel row has encrypted credentials
      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
      const [kernelRow] = await env.db.sql.unsafe(
        `SELECT * FROM ${ks}.connected_accounts WHERE id = '${imapKernelId}'`,
      )
      expect(kernelRow.credentials_encrypted).not.toBeNull()
      expect(kernelRow.provider_type).toBe("credentials")

      // Wait for extension row
      imapExtensionRow = await waitForExtensionRow(
        env,
        "email_address = 'imap-user@provider.e2e.test'",
      )
      expect(imapExtensionRow.provider).toBe("imap")
      expect(SYNC_STARTED_STATUSES).toContain(imapExtensionRow.sync_status)
      expect(imapExtensionRow.owner_type).toBe("user")
    })

    // S3: Org-level Gmail connection — admin connects shared account
    it("S3: Org-level Gmail — admin connects shared account", async () => {
      const result = await doGmailOAuthFlow(url, adminToken, env, oidcPort, {
        ownerType: "org",
        loginHint: "shared@company.e2e.test",
      })
      orgGmailKernelId = result.kernelId
      orgGmailExtensionRow = result.extensionRow

      // Verify kernel row
      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
      const [kernelRow] = await env.db.sql.unsafe(
        `SELECT * FROM ${ks}.connected_accounts WHERE id = '${orgGmailKernelId}'`,
      )
      expect(kernelRow.owner_type).toBe("org")
      expect(kernelRow.owner_id).toBeNull()

      // Verify extension row
      expect(orgGmailExtensionRow.owner_type).toBe("org")
      expect(orgGmailExtensionRow.owner_id).toBeNull()
    })

    // S4: Org-level connection — non-admin user rejected
    it("S4: Org-level connection — non-admin rejected", async () => {
      const res = await api(url, "/api/connections/mail/gmail/authorize", {
        token: nonAdminUser.token,
        body: { ownerType: "org" },
      })
      expect(res.status).toBe(403)
      expect(res.body.error.message).toContain("Admin scope required")
    })

    // S12: Event-driven initial sync job enqueued
    it("S12: initial sync job enqueued after IMAP credential connection", async () => {
      const uniqueEmail = `sync-job-test-${Date.now()}@imap.e2e.test`
      await api(url, "/api/connections/mail/imap/credentials", {
        token: adminToken,
        body: {
          email: uniqueEmail,
          imapHost: "imap.sync.e2e.test",
          imapPort: 993,
          smtpHost: "smtp.sync.e2e.test",
          smtpPort: 587,
          username: uniqueEmail,
          password: "sync-password",
        },
      })

      // Wait for extension row (proves onAccountConnected handler fired)
      await waitForExtensionRow(env, `email_address = '${uniqueEmail}'`)

      // Poll Redis for BullMQ job keys
      let jobFound = false
      const deadline = Date.now() + 5000
      const redisPrefix = env.redisPrefix ?? ""
      while (Date.now() < deadline) {
        const keys = await env.redis.redis.keys(`${redisPrefix}bull:app-mail:*`)
        if (keys.length > 0) {
          jobFound = true
          break
        }
        await Bun.sleep(100)
      }
      expect(jobFound).toBe(true)
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  Journey 3: RLS + Tools (S5, S6, S9, S10, S11)
  // ════════════════════════════════════════════════════════════════════════

  describe("RLS + Tools", () => {
    let userA: { id: string; token: string; email: string }
    let userB: { id: string; token: string; email: string }
    let personalExtensionRow: Record<string, any>
    let orgExtensionRow: Record<string, any>
    let personalKernelId: string
    let _orgKernelId: string

    beforeAll(async () => {
      // User A: has mail scopes + will get inbox dimension after org account created
      userA = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["mail:accounts:read", "mail:accounts:write"],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })

      // User B: has mail read scope but NO inbox dimension
      userB = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["mail:accounts:read"],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })

      // User A connects personal Gmail
      const personalResult = await doGmailOAuthFlow(url, userA.token, env, oidcPort, {
        loginHint: "usera-personal@gmail.e2e.test",
      })
      personalKernelId = personalResult.kernelId
      personalExtensionRow = personalResult.extensionRow

      // Admin connects org-level Gmail
      const orgResult = await doGmailOAuthFlow(url, adminToken, env, oidcPort, {
        ownerType: "org",
        loginHint: "org-shared-rls@company.e2e.test",
      })
      _orgKernelId = orgResult.kernelId
      orgExtensionRow = orgResult.extensionRow

      // Grant User A inbox dimension for the org account
      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

      // Find User A's role
      const [membership] = await env.db.sql.unsafe(
        `SELECT role_id FROM ${ks}.user_roles WHERE user_id = '${userA.id}' LIMIT 1`,
      )

      // Add inbox dimension grant to User A's role
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.role_dimension_grants (role_id, dimension_key, dimension_values)
         VALUES ($1, $2, $3)
         ON CONFLICT (role_id, dimension_key) DO UPDATE SET dimension_values = $3`,
        [membership.role_id, "mail:inbox", JSON.stringify([orgExtensionRow.id])],
      )

      // Re-login User A to get fresh token with updated dimensions
      const loginRes = await api(url, "/api/auth/login", {
        body: { email: userA.email, password: "Pass1234!" },
      })
      userA.token = loginRes.body.data.accessToken
    }, 60_000)

    // S5: RLS — shared account visible only with dimension grant
    it("S5: shared org account visible only to user with inbox dimension", async () => {
      // User A (has inbox dimension grant) should see org account
      const resA = await api(url, "/api/apps/tools/mail:listAccounts", {
        method: "POST",
        token: userA.token,
        body: {},
      })
      expect(resA.status).toBe(200)
      const accountsA = resA.body.data
      const orgAccountA = accountsA.find(
        (a: any) => a.emailAddress === "org-shared-rls@company.e2e.test",
      )
      expect(orgAccountA).toBeDefined()

      // User B (no inbox dimension) should NOT see org account
      const resB = await api(url, "/api/apps/tools/mail:listAccounts", {
        method: "POST",
        token: userB.token,
        body: {},
      })
      expect(resB.status).toBe(200)
      const accountsB = resB.body.data
      const orgAccountB = accountsB.find(
        (a: any) => a.emailAddress === "org-shared-rls@company.e2e.test",
      )
      expect(orgAccountB).toBeUndefined()
    })

    // S6: RLS — personal account visible only to owner
    it("S6: personal account visible only to owner", async () => {
      // User A (owner) should see their personal account
      const resA = await api(url, "/api/apps/tools/mail:listAccounts", {
        method: "POST",
        token: userA.token,
        body: {},
      })
      expect(resA.status).toBe(200)
      const personalA = resA.body.data.find(
        (a: any) => a.emailAddress === "usera-personal@gmail.e2e.test",
      )
      expect(personalA).toBeDefined()

      // User B should NOT see User A's personal account
      const resB = await api(url, "/api/apps/tools/mail:listAccounts", {
        method: "POST",
        token: userB.token,
        body: {},
      })
      expect(resB.status).toBe(200)
      const personalB = resB.body.data.find(
        (a: any) => a.emailAddress === "usera-personal@gmail.e2e.test",
      )
      expect(personalB).toBeUndefined()
    })

    // S9: Tool — listAccounts returns enriched data
    it("S9: listAccounts returns enriched data with kernel metadata", async () => {
      const res = await api(url, "/api/apps/tools/mail:listAccounts", {
        method: "POST",
        token: userA.token,
        body: {},
      })
      expect(res.status).toBe(200)
      const accounts = res.body.data
      expect(accounts.length).toBeGreaterThanOrEqual(1)

      for (const account of accounts) {
        expect(account.id).toBeDefined()
        expect(account.provider).toBeDefined()
        expect(account.emailAddress).toBeDefined()
        expect(account.syncStatus).toBeDefined()
        expect(account.ownerType).toBeDefined()
      }
    })

    // S10: Tool — getAccount returns single account with metadata
    it("S10: getAccount returns single account with metadata", async () => {
      const res = await api(url, "/api/apps/tools/mail:getAccount", {
        method: "POST",
        token: userA.token,
        body: { accountId: personalExtensionRow.id },
      })
      expect(res.status).toBe(200)
      const account = res.body.data
      expect(account.id).toBe(personalExtensionRow.id)
      expect(account.provider).toBe("gmail")
      expect(account.emailAddress).toBe("usera-personal@gmail.e2e.test")
      expect(SYNC_STARTED_STATUSES).toContain(account.syncStatus)
      expect(account.connectedAccountId).toBe(personalKernelId)
    })

    // S11: Tool — getSyncStatus returns sync state
    it("S11: getSyncStatus returns sync state", async () => {
      const res = await api(url, "/api/apps/tools/mail:getSyncStatus", {
        method: "POST",
        token: userA.token,
        body: { accountId: personalExtensionRow.id },
      })
      expect(res.status).toBe(200)
      expect(SYNC_STARTED_STATUSES).toContain(res.body.data.syncStatus)
      if (res.body.data.syncStatus === "active") {
        expect(res.body.data.lastSyncAt).not.toBeNull()
      } else {
        expect(res.body.data.lastSyncAt).toBeNull()
      }
      expect(res.body.data.lastSyncError).toBeNull()
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  //  Journey 4: Disconnect + Reconnect + Security (S7, S8, S13-S18)
  // ════════════════════════════════════════════════════════════════════════

  describe("Disconnect + Reconnect + Security", () => {
    let dcUser: { id: string; token: string; email: string }
    let dcAdminUser: { id: string; token: string; email: string }
    let dcNonAdmin: { id: string; token: string; email: string }
    let personalKernelId: string
    let personalExtensionRow: Record<string, any>
    let orgKernelId: string
    let orgExtensionRow: Record<string, any>

    beforeAll(async () => {
      // User for disconnect/reconnect
      dcUser = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["mail:accounts:read", "mail:accounts:write"],
        dimensions: {},
        schemaPrefix: env.schemaPrefix,
      })

      // Admin user for org operations
      dcAdminUser = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: [
          "mail:accounts:read",
          "mail:accounts:write",
          "mail:accounts:admin",
          "connections:admin",
        ],
        dimensions: { "*": ["*"] },
        schemaPrefix: env.schemaPrefix,
      })

      // Non-admin user (has write but NOT admin)
      dcNonAdmin = await createUserWithScopes(url, env.db.sql, adminToken, orgId, {
        scopes: ["mail:accounts:read", "mail:accounts:write"],
        dimensions: { "*": ["*"] },
        schemaPrefix: env.schemaPrefix,
      })

      // dcUser connects personal Gmail
      const personalResult = await doGmailOAuthFlow(url, dcUser.token, env, oidcPort, {
        loginHint: "dc-personal@gmail.e2e.test",
      })
      personalKernelId = personalResult.kernelId
      personalExtensionRow = personalResult.extensionRow

      // Admin connects org-level Gmail
      const orgResult = await doGmailOAuthFlow(url, dcAdminUser.token, env, oidcPort, {
        ownerType: "org",
        loginHint: "dc-org@company.e2e.test",
      })
      orgKernelId = orgResult.kernelId
      orgExtensionRow = orgResult.extensionRow

      // Grant dcNonAdmin a user_dimension_grant so kernel RLS lets them see org-owned mail accounts.
      // The kernel connected_accounts RLS checks user_dimension_grants (not role-based)
      // for org-owned rows: dimension_key LIKE (app_name || ':%')
      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, org_id, dimension_key) DO UPDATE SET dimension_values = $4`,
        [dcNonAdmin.id, orgId, "mail:inbox", JSON.stringify([orgExtensionRow.id])],
      )

      // Also grant dcAdminUser so they can see org accounts through kernel RLS
      await env.db.sql.unsafe(
        `INSERT INTO ${ks}.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, org_id, dimension_key) DO UPDATE SET dimension_values = $4`,
        [dcAdminUser.id, orgId, "mail:inbox", JSON.stringify([orgExtensionRow.id])],
      )
    }, 60_000)

    // S7: Disconnect account — soft-delete both kernel and extension rows
    it("S7: disconnect personal account — soft-delete both rows", async () => {
      const extensionId = personalExtensionRow.id

      const res = await api(url, "/api/apps/tools/mail:disconnectAccount", {
        method: "POST",
        token: dcUser.token,
        body: { accountId: extensionId },
      })
      expect(res.status).toBe(200)
      expect(res.body.data.success).toBe(true)

      // Wait for extension row to update
      const ms = env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
      let extRow: Record<string, any> | undefined
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        const [row] = await env.db.sql.unsafe(
          `SELECT * FROM ${ms}.accounts WHERE id = '${extensionId}'`,
        )
        if (row?.sync_status === "disconnected") {
          extRow = row
          break
        }
        await Bun.sleep(200)
      }
      expect(extRow).toBeDefined()
      expect(extRow!.sync_status).toBe("disconnected")
      expect(extRow!.disconnected_at).not.toBeNull()

      // Verify kernel row
      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
      const [kernelRow] = await env.db.sql.unsafe(
        `SELECT * FROM ${ks}.connected_accounts WHERE id = '${personalKernelId}'`,
      )
      expect(kernelRow.status).toBe("disconnected")
      expect(kernelRow.disconnected_at).not.toBeNull()

      // listAccounts (without includeDisconnected) should not show it
      const listRes = await api(url, "/api/apps/tools/mail:listAccounts", {
        method: "POST",
        token: dcUser.token,
        body: {},
      })
      expect(listRes.status).toBe(200)
      const found = listRes.body.data.find(
        (a: any) => a.emailAddress === "dc-personal@gmail.e2e.test",
      )
      expect(found).toBeUndefined()

      // listAccounts with includeDisconnected should show it
      const listDisRes = await api(url, "/api/apps/tools/mail:listAccounts", {
        method: "POST",
        token: dcUser.token,
        body: { includeDisconnected: true },
      })
      expect(listDisRes.status).toBe(200)
      const foundDis = listDisRes.body.data.find(
        (a: any) => a.emailAddress === "dc-personal@gmail.e2e.test",
      )
      expect(foundDis).toBeDefined()
      expect(foundDis.syncStatus).toBe("disconnected")
    })

    // S8: Reconnect — reactivates existing extension row
    it("S8: reconnect — reactivates existing extension row", async () => {
      const originalExtensionId = personalExtensionRow.id

      // Re-run Gmail OAuth flow with same email
      const result = await doGmailOAuthFlow(url, dcUser.token, env, oidcPort, {
        loginHint: "dc-personal@gmail.e2e.test",
      })

      // Extension row ID should be the same (reactivated, not new)
      expect(result.extensionRow.id).toBe(originalExtensionId)
      expect(SYNC_STARTED_STATUSES).toContain(result.extensionRow.sync_status)
      expect(result.extensionRow.disconnected_at).toBeNull()
      expect(result.extensionRow.connected_account_id).toBe(result.kernelId)

      // Verify no duplicates
      const ms = env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
      const rows = await env.db.sql.unsafe(
        `SELECT * FROM ${ms}.accounts WHERE email_address = 'dc-personal@gmail.e2e.test'`,
      )
      expect(rows.length).toBe(1)

      // Update reference for subsequent tests
      personalKernelId = result.kernelId
      personalExtensionRow = result.extensionRow
    })

    // S13: Mail read routes exist, but credential management stays on the generic connection surface
    it("S13: mail read routes exist while connection management stays sandboxed", async () => {
      const get = await api(url, "/api/mail/accounts", { token: dcUser.token })
      expect(get.status).toBe(200)
      expect(get.body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: personalExtensionRow.id,
            emailAddress: "dc-personal@gmail.e2e.test",
          }),
        ]),
      )

      const post = await api(url, "/api/mail/accounts/connect/gmail", {
        method: "POST",
        token: dcUser.token,
        body: {},
      })
      expect(post.status).toBe(404)

      const del = await fetch(`${url}/api/mail/accounts/some-id`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${dcUser.token}` },
      })
      expect(del.status).toBe(404)

      const syncStatus = await api(
        url,
        `/api/mail/accounts/${personalExtensionRow.id}/sync-status`,
        {
          token: dcUser.token,
        },
      )
      expect(syncStatus.status).toBe(200)
    })

    // S14: Credential validation — missing required fields rejected
    it("S14: credential validation — missing required fields rejected", async () => {
      const res = await api(url, "/api/connections/mail/imap/credentials", {
        token: dcUser.token,
        body: { email: "incomplete@test.com" },
      })
      expect(res.status).toBe(400)
      expect(res.body.error.message).toContain("Missing required credential field")
    })

    // S15: Duplicate email — the same mailbox never gets a second account
    // Re-entering the credentials of a connection that already exists (a
    // rotated password, an expired token) REPLACES it: same connected account,
    // reactivated, never a second row for the same mailbox
    // (createCredentialConnection, "re-connect replaces").
    it("S15: duplicate email — re-connecting the same mailbox reuses its account", async () => {
      // First create a successful IMAP connection
      const uniqueEmail = `dup-test-${Date.now()}@imap.e2e.test`
      const first = await api(url, "/api/connections/mail/imap/credentials", {
        token: dcUser.token,
        body: {
          email: uniqueEmail,
          imapHost: "imap.dup.e2e.test",
          imapPort: 993,
          smtpHost: "smtp.dup.e2e.test",
          smtpPort: 587,
          username: uniqueEmail,
          password: "dup-password",
        },
      })
      expect(first.status).toBe(201)

      // Wait for extension row to be created
      await waitForExtensionRow(env, `email_address = '${uniqueEmail}'`)

      // Second attempt with the same email replaces the first connection.
      const second = await api(url, "/api/connections/mail/imap/credentials", {
        token: dcUser.token,
        body: {
          email: uniqueEmail,
          imapHost: "imap.dup.e2e.test",
          imapPort: 993,
          smtpHost: "smtp.dup.e2e.test",
          smtpPort: 587,
          username: uniqueEmail,
          password: "dup-password-2",
        },
      })
      expect(second.status).toBe(201)
      expect(second.body.data.id).toBe(first.body.data.id)
      const ms = env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
      const rows = await env.db.sql.unsafe(
        `SELECT id FROM ${ms}.accounts WHERE email_address = $1`,
        [uniqueEmail],
      )
      expect(rows).toHaveLength(1)
    })

    // S16: Disconnect org account — non-admin rejected via tool
    it("S16: disconnect org account — non-admin rejected via tool", async () => {
      const res = await api(url, "/api/apps/tools/mail:disconnectAccount", {
        method: "POST",
        token: dcNonAdmin.token,
        body: { accountId: orgExtensionRow.id },
      })
      // Tool should reject due to missing mail:accounts:admin scope
      expect(res.status).not.toBe(200)

      // Verify account was not disconnected
      const ms = env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
      const [row] = await env.db.sql.unsafe(
        `SELECT sync_status FROM ${ms}.accounts WHERE id = '${orgExtensionRow.id}'`,
      )
      expect(row.sync_status).not.toBe("disconnected")
    })

    // S17: Disconnect org account — kernel route bypass blocked
    it("S17: kernel route disconnect — non-admin blocked, admin succeeds", async () => {
      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

      // Non-admin cannot disconnect via kernel route
      const nonAdminRes = await fetch(`${url}/api/connections/${orgKernelId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${dcNonAdmin.token}` },
      })
      expect(nonAdminRes.status).toBe(403)
      const nonAdminBody = (await nonAdminRes.json()) as any
      expect(nonAdminBody.error.message).toContain("Admin scope required")

      // Verify kernel row still active
      const [stillActive] = await env.db.sql.unsafe(
        `SELECT status FROM ${ks}.connected_accounts WHERE id = '${orgKernelId}'`,
      )
      expect(stillActive.status).toBe("active")

      // Admin CAN disconnect via kernel route
      const adminRes = await fetch(`${url}/api/connections/${orgKernelId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${dcAdminUser.token}` },
      })
      expect(adminRes.status).toBe(200)
      const adminBody = (await adminRes.json()) as any
      expect(adminBody.data.success).toBe(true)

      // Verify kernel row disconnected
      const [disconnected] = await env.db.sql.unsafe(
        `SELECT status FROM ${ks}.connected_accounts WHERE id = '${orgKernelId}'`,
      )
      expect(disconnected.status).toBe("disconnected")
    })

    // S18: Negative OAuth callback — tampered state rejected
    it("S18: negative OAuth callback — tampered state rejected", async () => {
      // Start a real OAuth flow to get a valid code
      const authRes = await api(url, "/api/connections/mail/gmail/authorize", {
        token: adminToken,
        body: {},
      })
      expect(authRes.status).toBe(200)
      const redirectUrl = new URL(authRes.body.data.redirectUrl)
      const realState = redirectUrl.searchParams.get("state")!

      // Patch Redis state for valid code generation
      await patchOAuthState(env, realState, oidcPort)

      const callbackUri = `${url}/api/connections/callback`
      const oidcAuthUrl = `http://localhost:${oidcPort}/authorize?state=${realState}&redirect_uri=${encodeURIComponent(callbackUri)}&login_hint=tampered@e2e.test`
      const oidcRes = await fetch(oidcAuthUrl, { redirect: "manual" })
      const cbUrl = new URL(oidcRes.headers.get("location")!)
      const validCode = cbUrl.searchParams.get("code")!

      // Use the valid code with a TAMPERED state
      const tamperedRes = await fetch(
        `${url}/api/connections/callback?code=${validCode}&state=tampered-invalid-state`,
        { redirect: "manual" },
      )
      // Should fail — not a 302 redirect to success
      expect(tamperedRes.status).not.toBe(302)

      // Verify no rows created for tampered state
      const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"
      const kernelRows = await env.db.sql.unsafe(
        `SELECT id FROM ${ks}.connected_accounts WHERE identifier = 'tampered@e2e.test'`,
      )
      expect(kernelRows.length).toBe(0)

      const ms = env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
      const extRows = await env.db.sql.unsafe(
        `SELECT id FROM ${ms}.accounts WHERE email_address = 'tampered@e2e.test'`,
      )
      expect(extRows.length).toBe(0)
    })
  })
})
