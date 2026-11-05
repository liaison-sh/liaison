// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { app } from "~/app"
import { withPrivilegedDb } from "~/db/privileged"
import {
  oauthAccounts,
  oauthProviders,
  organizations,
  roleScopeGrants,
  roles,
  users,
} from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { encryptionKey, env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { GOOGLE_ISSUER } from "~/modules/auth/google-login-provider"
import {
  isPrivateIp,
  oauthAdmin,
  oauthStateCookieSpec,
  parseExchangePayload,
  serializeExchangePayload,
} from "~/modules/auth/oauth-routes"
import { clearRedisPatterns } from "~/tests/route-test-setup"

/**
 * Negative-path tests for OAuth callback and related endpoints.
 *
 * These exercise error handling in the OAuth flow without needing
 * a running OIDC provider — they test parameter validation, state
 * management, and routing guards that don't require external calls.
 */

async function clearOAuthRedisKeys() {
  await clearRedisPatterns([
    "oauth:login-state:test-*",
    "oauth:state:test-*",
    "oauth:exchange:test-*",
  ])
}

describe("OAuth routes — negative paths", () => {
  beforeAll(async () => {
    await clearOAuthRedisKeys()
  })

  afterAll(async () => {
    await clearOAuthRedisKeys()
  })

  // ── callback parameter validation ──

  it("callback without code returns 400", async () => {
    const res = await app.request("/api/auth/oauth/callback?state=abc")
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.message).toContain("Missing code or state")
  })

  it("callback without state returns 400", async () => {
    const res = await app.request("/api/auth/oauth/callback?code=abc")
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.message).toContain("Missing code or state")
  })

  it("callback without any params returns 400", async () => {
    const res = await app.request("/api/auth/oauth/callback")
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.message).toContain("Missing code or state")
  })

  it("connections callback with provider cancel redirects to app", async () => {
    // An unknown state names no app: the browser lands on Connectors, which shows the error.
    const res = await app.request("/api/connections/callback?error=access_denied&state=cancelled")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe(
      "http://localhost:5173/settings/connectors?oauth_error=access_denied",
    )
  })

  it("a provider error goes back to the settings of the app that started the flow", async () => {
    const orgId = crypto.randomUUID()
    const state = `w4-${crypto.randomUUID()}`
    manifestRegistry.set([orgId, "w4conn"], {
      name: "w4conn",
      uiBundleUrl: null,
      kind: "connector",
    })
    await redis.set(
      `oauth:state:${state}`,
      JSON.stringify({ orgId, appName: "w4conn", connectionName: "c" }),
      "EX",
      60,
    )
    try {
      const res = await app.request(`/api/connections/callback?error=access_denied&state=${state}`)
      expect(res.status).toBe(302)
      expect(res.headers.get("location")).toBe(
        "http://localhost:5173/settings/connectors?open=w4conn&oauth_error=access_denied",
      )
    } finally {
      manifestRegistry.delete([orgId, "w4conn"])
      await redis.del(`oauth:state:${state}`)
    }
  })

  // ── state validation ──

  it("callback with invalid state returns 400", async () => {
    const res = await app.request("/api/auth/oauth/callback?code=abc&state=nonexistent")
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.message).toContain("Invalid state")
  })

  it("state cannot be replayed", async () => {
    // Seed a state in Redis with a valid-format UUID that doesn't exist
    await redis.set(
      "oauth:login-state:test-state-replay",
      JSON.stringify({
        providerId: "00000000-0000-0000-0000-000000000000",
        codeVerifier: "fake-verifier",
      }),
      "EX",
      600,
    )

    // First use consumes the state (will fail downstream on provider lookup, but state is deleted)
    await app.request("/api/auth/oauth/callback?code=abc&state=test-state-replay")

    // Second use should fail because the state was already consumed
    const res = await app.request("/api/auth/oauth/callback?code=abc&state=test-state-replay")
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.message).toContain("Invalid state")
  })

  it("a connection flow's state is neither read nor spent by the login callback, nor the reverse", async () => {
    await redis.set("oauth:state:test-cross-connect", JSON.stringify({ appName: "x" }), "EX", 600)
    const login = await app.request("/api/auth/oauth/callback?code=abc&state=test-cross-connect")
    expect(login.status).toBe(400)
    expect(((await login.json()) as any).error.message).toContain("Invalid state")
    expect(await redis.get("oauth:state:test-cross-connect")).not.toBeNull()

    await redis.set(
      "oauth:login-state:test-cross-login",
      JSON.stringify({ providerId: "00000000-0000-0000-0000-000000000000", codeVerifier: "v" }),
      "EX",
      600,
    )
    await app.request("/api/connections/callback?code=abc&state=test-cross-login")
    expect(await redis.get("oauth:login-state:test-cross-login")).not.toBeNull()
  })

  // ── provider endpoints ──

  it("GET /providers returns available providers", async () => {
    const res = await app.request("/api/auth/oauth/providers")
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(Array.isArray(body.data)).toBe(true)
  })

  it("authorize with non-existent provider returns 404", async () => {
    // Use a valid UUID format so PostgreSQL doesn't reject the query with a type error
    const res = await app.request("/api/auth/oauth/00000000-0000-0000-0000-000000000000/authorize")
    expect(res.status).toBe(404)
    const body = (await res.json()) as any
    expect(body.error.message).toContain("Provider not found")
  })

  // ── one-time code exchange (C1) ──

  it("exchange with valid code returns accessToken and consumes code", async () => {
    await redis.set("oauth:exchange:test-code-valid", "jwt-token-here", "EX", 30)
    const res = await app.request("/api/auth/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "test-code-valid" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.accessToken).toBe("jwt-token-here")

    // Second call with same code should fail — code was consumed
    const res2 = await app.request("/api/auth/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "test-code-valid" }),
    })
    expect(res2.status).toBe(400)
  })

  // A WRAPPED SHELL CANNOT HOLD A SESSION OFF A COOKIE. Its calls to the
  // server are all cross site, so the SameSite=Strict cookie the redirect set
  // travels on none of them: an OAuth login that answered with the access
  // token alone left the shell with a session that died at the first expiry.
  // The exchange is the step the page makes itself, with its own Origin, so it
  // is where the shell is recognised.
  it("gives an app origin the refresh token in the body and sets no cookie", async () => {
    await redis.set(
      "oauth:exchange:test-code-app",
      serializeExchangePayload({ accessToken: "at-app", refreshToken: "rt-app" }),
      "EX",
      30,
    )
    const res = await app.request("/api/auth/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "capacitor://localhost" },
      body: JSON.stringify({ code: "test-code-app" }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.accessToken).toBe("at-app")
    expect(body.data.refreshToken).toBe("rt-app")
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  it("gives a browser origin the access token alone", async () => {
    const flag = env as { EXPOSE_REFRESH_TOKEN_IN_BODY: boolean }
    const saved = flag.EXPOSE_REFRESH_TOKEN_IN_BODY
    flag.EXPOSE_REFRESH_TOKEN_IN_BODY = false
    try {
      await redis.set(
        "oauth:exchange:test-code-browser",
        serializeExchangePayload({ accessToken: "at-web", refreshToken: "rt-web" }),
        "EX",
        30,
      )
      const res = await app.request("/api/auth/oauth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify({ code: "test-code-browser" }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data.accessToken).toBe("at-web")
      expect(body.data.refreshToken).toBeUndefined()
    } finally {
      flag.EXPOSE_REFRESH_TOKEN_IN_BODY = saved
    }
  })

  // The two halves of the hand-off have to agree, and a code minted by the
  // build before this one is still live for thirty seconds after a deploy.
  it("reads back what it wrote, and a legacy bare token too", () => {
    const round = parseExchangePayload(
      serializeExchangePayload({ accessToken: "a", refreshToken: "r" }),
    )
    expect(round).toEqual({ accessToken: "a", refreshToken: "r" })
    expect(parseExchangePayload("jwt-token-here")).toEqual({ accessToken: "jwt-token-here" })
  })

  it("exchange with invalid code returns 400", async () => {
    const res = await app.request("/api/auth/oauth/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "nonexistent-code" }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.message).toContain("Invalid or expired code")
  })
})

describe("isPrivateIp — SSRF protection", () => {
  // RFC 1918 / loopback / link-local — must be blocked
  const privateIps = [
    "127.0.0.1",
    "127.255.255.255",
    "10.0.0.1",
    "10.255.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.0.1",
    "169.254.255.255",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd12::1",
    "0.0.0.0",
    "0.1.2.3",
    "localhost",
  ]

  for (const ip of privateIps) {
    it(`rejects private IP: ${ip}`, () => {
      expect(isPrivateIp(ip)).toBe(true)
    })
  }

  // Public IPs — must be allowed
  const publicIps = [
    "8.8.8.8",
    "1.1.1.1",
    "9.9.9.9",
    "172.15.255.255", // just below 172.16
    "172.32.0.1", // just above 172.31
    "192.167.0.1", // not 192.168
    "11.0.0.1", // not 10.x
  ]

  for (const ip of publicIps) {
    it(`allows public IP: ${ip}`, () => {
      expect(isPrivateIp(ip)).toBe(false)
    })
  }
})

describe("OAuth admin — reserved integration provider names", () => {
  const TEST_ORG_ID = "00000000-0000-0000-0000-000000000999"

  beforeAll(async () => {
    await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-org-setup", async (db) => {
      await db.delete(oauthProviders).where(eq(oauthProviders.orgId, TEST_ORG_ID))
      await db.delete(organizations).where(eq(organizations.id, TEST_ORG_ID))
      await db.insert(organizations).values({
        id: TEST_ORG_ID,
        name: "OAuth Admin Test Org",
        slug: "oauth-admin-test",
      })
    })
  })

  afterAll(async () => {
    await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-org-cleanup", async (db) => {
      await db.delete(oauthProviders).where(eq(oauthProviders.orgId, TEST_ORG_ID))
      await db.delete(organizations).where(eq(organizations.id, TEST_ORG_ID))
    })
  })

  function adminApp() {
    const testApp = new Hono<AppEnv>()
    testApp.use("*", async (c, next) => {
      c.set("userId", "test-user")
      c.set("orgId", TEST_ORG_ID)
      c.set("scopes", ["kernel:users:admin"] as any)
      c.set("dimensionGrants", {})
      await next()
    })
    testApp.route("/api/admin/oauth-providers", oauthAdmin)
    return testApp
  }

  it("POST /api/admin/oauth-providers with auto-provision needs authority over the member role", async () => {
    const [member] = await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-member", (db) =>
      db.insert(roles).values({ orgId: TEST_ORG_ID, name: "member" }).returning({ id: roles.id }),
    )
    await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-member-scope", (db) =>
      db.insert(roleScopeGrants).values({ roleId: member!.id, scope: "kernel:threads:write" }),
    )
    try {
      const testApp = adminApp()
      testApp.onError((err, c) =>
        c.json({ error: { message: err.message } }, (err as HTTPException).status ?? 500),
      )
      const res = await testApp.request("/api/admin/oauth-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Self-hosted IdP",
          issuerUrl: "https://idp.example.com",
          clientId: "cid",
          clientSecret: "secret",
          autoProvision: true,
        }),
      })
      expect(res.status).toBe(403)
      const rows = await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-none", (db) =>
        db.select().from(oauthProviders).where(eq(oauthProviders.orgId, TEST_ORG_ID)),
      )
      expect(rows).toHaveLength(0)
    } finally {
      await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-member-clean", (db) =>
        db.delete(roles).where(eq(roles.id, member!.id)),
      )
    }
  })

  it("POST /api/admin/oauth-providers rejects reserved Gmail provider names", async () => {
    const testApp = adminApp()
    // Add error handler to convert HTTPException to JSON
    testApp.onError((err, c) => {
      if (err instanceof HTTPException) {
        return c.json({ error: { message: err.message } }, err.status as any)
      }
      return c.json({ error: { message: "Internal Server Error" } }, 500)
    })
    const res = await testApp.request("/api/admin/oauth-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "gmail",
        issuerUrl: "https://accounts.google.com",
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
      }),
    })

    expect(res.status).toBe(400)
    const body = (await res.json()) as any
    expect(body.error.message).toBe(
      "Google app integrations are configured from Settings > Administration > Integrations, not OAuth Providers",
    )
  })

  it("GET /api/admin/oauth-providers returns configured providers without secrets", async () => {
    const testApp = adminApp()
    await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-list-setup", async (db) => {
      await db
        .delete(oauthProviders)
        .where(and(eq(oauthProviders.orgId, TEST_ORG_ID), eq(oauthProviders.name, "acme-oidc")))
      await db.insert(oauthProviders).values({
        orgId: TEST_ORG_ID,
        name: "acme-oidc",
        issuerUrl: "https://idp.acme.test",
        authorizationEndpoint: "https://idp.acme.test/authorize",
        tokenEndpoint: "https://idp.acme.test/token",
        userinfoEndpoint: "https://idp.acme.test/userinfo",
        clientId: "client-id",
        clientSecretEncrypted: "encrypted-secret",
        scopes: "openid email profile",
        autoProvision: true,
      })
    })

    const res = await testApp.request("/api/admin/oauth-providers")

    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data).toContainEqual(
      expect.objectContaining({
        name: "acme-oidc",
        issuerUrl: "https://idp.acme.test",
        configured: true,
        connectedAccountCount: 0,
        autoProvision: true,
      }),
    )
    expect(body.data.find((provider: any) => provider.name === "acme-oidc")).not.toHaveProperty(
      "clientSecretEncrypted",
    )

    await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-list-cleanup", async (db) => {
      await db
        .delete(oauthProviders)
        .where(and(eq(oauthProviders.orgId, TEST_ORG_ID), eq(oauthProviders.name, "acme-oidc")))
    })
  })

  it("DELETE /api/admin/oauth-providers/:providerId removes an org provider", async () => {
    const testApp = adminApp()
    const [provider] = await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-delete-setup", (db) =>
      db
        .insert(oauthProviders)
        .values({
          orgId: TEST_ORG_ID,
          name: "delete-me-oidc",
          issuerUrl: "https://delete-me.acme.test",
          authorizationEndpoint: "https://delete-me.acme.test/authorize",
          tokenEndpoint: "https://delete-me.acme.test/token",
          userinfoEndpoint: "https://delete-me.acme.test/userinfo",
          clientId: "client-id",
          clientSecretEncrypted: "encrypted-secret",
          scopes: "openid email profile",
          autoProvision: false,
        })
        .returning({ id: oauthProviders.id }),
    )

    expect(provider).toBeDefined()

    const res = await testApp.request(`/api/admin/oauth-providers/${provider!.id}`, {
      method: "DELETE",
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { deleted: true } })

    const rows = await withPrivilegedDb(TEST_ORG_ID, "test-oauth-admin-delete-check", (db) =>
      db
        .select({ id: oauthProviders.id })
        .from(oauthProviders)
        .where(eq(oauthProviders.id, provider!.id)),
    )
    expect(rows).toHaveLength(0)
  })
})

// ── Callback: a verified provider email that matches an existing, unlinked user ──
// Drives the real callback against a local IdP stub (id_token is decode-only in
// NODE_ENV=test; issuer, audience and nonce are still checked).

describe("OAuth callback: existing account without a linked identity", () => {
  const ORG_ID = "00000000-0000-0000-0000-000000000998"
  const EXISTING_METHOD_ERROR =
    "An account with this email exists. Sign in with your existing method"
  const GOOGLE_CLIENT_ID = "callback-test-google.apps.googleusercontent.com"

  let idp: ReturnType<typeof Bun.serve>
  let idpUrl: string
  let nextIdToken: Record<string, unknown> = {}
  let nextNonce = ""
  const savedGoogleEnv = {
    id: env.GOOGLE_OAUTH_CLIENT_ID,
    secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
  }

  function unsignedJwt(payload: Record<string, unknown>): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
    return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.sig`
  }

  async function insertProvider(values: {
    name: string
    issuerUrl: string
    clientId: string
    autoProvision: boolean
  }): Promise<string> {
    const [row] = await withPrivilegedDb(ORG_ID, "test-oauth-callback-provider", (db) =>
      db
        .insert(oauthProviders)
        .values({
          orgId: ORG_ID,
          name: values.name,
          issuerUrl: values.issuerUrl,
          authorizationEndpoint: `${idpUrl}/authorize`,
          tokenEndpoint: `${idpUrl}/token`,
          userinfoEndpoint: `${idpUrl}/userinfo`,
          clientId: values.clientId,
          clientSecretEncrypted: encryptSecret(
            "secret",
            encryptionKey,
            CryptoContext.oauthProviderClientSecret,
          ),
          scopes: "openid email profile",
          autoProvision: values.autoProvision,
        })
        .returning({ id: oauthProviders.id }),
    )
    return row!.id
  }

  async function insertUser(email: string, status: "active" | "suspended" | "deactivated") {
    const [row] = await withPrivilegedDb(ORG_ID, "test-oauth-callback-user", (db) =>
      db
        .insert(users)
        .values({ orgId: ORG_ID, email, name: email, status })
        .returning({ id: users.id }),
    )
    return row!.id
  }

  /** authorize -> IdP stub -> callback, returning the callback redirect target. */
  async function runCallback(
    providerId: string,
    issuer: string,
    clientId: string,
    claims: { sub: string; email: string },
  ): Promise<string> {
    const authRes = await app.request(`/api/auth/oauth/${providerId}/authorize`)
    expect(authRes.status).toBe(302)
    const authLocation = new URL(authRes.headers.get("location")!)
    const state = authLocation.searchParams.get("state")!
    nextNonce = authLocation.searchParams.get("nonce")!
    nextIdToken = {
      iss: issuer,
      aud: clientId,
      exp: Math.floor(Date.now() / 1000) + 600,
      sub: claims.sub,
      email: claims.email,
      email_verified: true,
      nonce: nextNonce,
    }
    const cookie = (authRes.headers.get("set-cookie") ?? "").split(";")[0]!
    const cbRes = await app.request(
      `/api/auth/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    )
    expect(cbRes.status).toBe(302)
    return cbRes.headers.get("location")!
  }

  async function linkedAccounts(providerId: string) {
    return withPrivilegedDb(ORG_ID, "test-oauth-callback-links", (db) =>
      db.select().from(oauthAccounts).where(eq(oauthAccounts.providerId, providerId)),
    )
  }

  async function cleanOrg() {
    await withPrivilegedDb(ORG_ID, "test-oauth-callback-clean", async (db) => {
      await db.delete(oauthAccounts).where(eq(oauthAccounts.orgId, ORG_ID))
      await db.delete(oauthProviders).where(eq(oauthProviders.orgId, ORG_ID))
      await db.delete(users).where(eq(users.orgId, ORG_ID))
      await db.delete(organizations).where(eq(organizations.id, ORG_ID))
    })
  }

  beforeAll(async () => {
    idp = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url)
        if (pathname === "/token") {
          return Response.json({
            access_token: "stub-access-token",
            token_type: "Bearer",
            id_token: unsignedJwt(nextIdToken),
          })
        }
        if (pathname === "/userinfo") {
          return Response.json({
            sub: nextIdToken.sub,
            email: nextIdToken.email,
            email_verified: true,
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    idpUrl = `http://localhost:${idp.port}`
    await cleanOrg()
    await withPrivilegedDb(ORG_ID, "test-oauth-callback-org", (db) =>
      db
        .insert(organizations)
        .values({ id: ORG_ID, name: "OAuth Callback Test Org", slug: "oauth-callback-test" }),
    )
    ;(env as { GOOGLE_OAUTH_CLIENT_ID?: string }).GOOGLE_OAUTH_CLIENT_ID = GOOGLE_CLIENT_ID
    ;(env as { GOOGLE_OAUTH_CLIENT_SECRET?: string }).GOOGLE_OAUTH_CLIENT_SECRET = "secret"
  })

  afterAll(async () => {
    ;(env as { GOOGLE_OAUTH_CLIENT_ID?: string }).GOOGLE_OAUTH_CLIENT_ID = savedGoogleEnv.id
    ;(env as { GOOGLE_OAUTH_CLIENT_SECRET?: string }).GOOGLE_OAUTH_CLIENT_SECRET =
      savedGoogleEnv.secret
    await cleanOrg()
    await clearRedisPatterns(["oauth:pending-link:callback-test-*"])
    idp.stop(true)
  })

  it("third-party provider: existing user is not linked, login fails closed with the existing-method error", async () => {
    // autoProvision on, so a fall-through to provisioning would also be caught.
    const providerId = await insertProvider({
      name: "acme-idp",
      issuerUrl: idpUrl,
      clientId: "acme-client",
      autoProvision: true,
    })
    await insertUser("existing-thirdparty@callback.test", "active")

    const location = await runCallback(providerId, idpUrl, "acme-client", {
      sub: "callback-test-acme-1",
      email: "existing-thirdparty@callback.test",
    })

    expect(location).not.toContain("oauth_link_pending")
    const url = new URL(location, "http://x")
    expect(url.pathname).toBe("/login")
    expect(url.searchParams.get("error")).toBe(EXISTING_METHOD_ERROR)
    expect(await linkedAccounts(providerId)).toHaveLength(0)
    expect(await redis.keys("oauth:pending-link:*")).toHaveLength(0)
  })

  it("auto-provision at the org's seat limit: no account, back to the login with the reason", async () => {
    const providerId = await insertProvider({
      name: "seat-idp",
      issuerUrl: idpUrl,
      clientId: "seat-client",
      autoProvision: true,
    })
    await insertUser("seat-holder@callback.test", "active")
    await withPrivilegedDb(ORG_ID, "test-oauth-callback-caps", (db) =>
      db
        .update(organizations)
        .set({ caps: { seats: 1 } })
        .where(eq(organizations.id, ORG_ID)),
    )
    try {
      const location = await runCallback(providerId, idpUrl, "seat-client", {
        sub: "callback-test-seat-1",
        email: "newcomer@callback.test",
      })
      const url = new URL(location, "http://x")
      expect(url.pathname).toBe("/login")
      expect(url.searchParams.get("error")).toContain("seats")
      const created = await withPrivilegedDb(ORG_ID, "test-oauth-callback-seat-user", (db) =>
        db.select().from(users).where(eq(users.email, "newcomer@callback.test")),
      )
      expect(created).toHaveLength(0)
      expect(await linkedAccounts(providerId)).toHaveLength(0)
    } finally {
      await withPrivilegedDb(ORG_ID, "test-oauth-callback-caps-reset", (db) =>
        db.update(organizations).set({ caps: {} }).where(eq(organizations.id, ORG_ID)),
      )
    }
  })

  it("first-party Google: an active invited user is linked and signed in (unchanged SSO path)", async () => {
    const providerId = await insertProvider({
      name: "Google",
      issuerUrl: GOOGLE_ISSUER,
      clientId: GOOGLE_CLIENT_ID,
      autoProvision: false,
    })
    const userId = await insertUser("invited-google@callback.test", "active")

    const location = await runCallback(providerId, GOOGLE_ISSUER, GOOGLE_CLIENT_ID, {
      sub: "callback-test-google-1",
      email: "invited-google@callback.test",
    })

    expect(location).toContain("/login/oauth-complete?code=")
    const links = await linkedAccounts(providerId)
    expect(links).toHaveLength(1)
    expect(links[0]!.userId).toBe(userId)
    expect(links[0]!.externalSubject).toBe("callback-test-google-1")

    // A second sign-in rides the existing link.
    const again = await runCallback(providerId, GOOGLE_ISSUER, GOOGLE_CLIENT_ID, {
      sub: "callback-test-google-1",
      email: "invited-google@callback.test",
    })
    expect(again).toContain("/login/oauth-complete?code=")
  })

  it("first-party Google: a suspended user is not linked and gets the existing-method error", async () => {
    await withPrivilegedDb(ORG_ID, "test-oauth-callback-clean-providers", async (db) => {
      await db.delete(oauthAccounts).where(eq(oauthAccounts.orgId, ORG_ID))
      await db.delete(oauthProviders).where(eq(oauthProviders.orgId, ORG_ID))
    })
    const providerId = await insertProvider({
      name: "Google",
      issuerUrl: GOOGLE_ISSUER,
      clientId: GOOGLE_CLIENT_ID,
      autoProvision: false,
    })
    await insertUser("suspended-google@callback.test", "suspended")

    const location = await runCallback(providerId, GOOGLE_ISSUER, GOOGLE_CLIENT_ID, {
      sub: "callback-test-google-2",
      email: "suspended-google@callback.test",
    })

    expect(new URL(location, "http://x").searchParams.get("error")).toBe(EXISTING_METHOD_ERROR)
    expect(await linkedAccounts(providerId)).toHaveLength(0)
    expect(await redis.keys("oauth:pending-link:*")).toHaveLength(0)
  })

  it("first-party Google: a deactivated user still gets the deactivated error", async () => {
    const [provider] = await withPrivilegedDb(ORG_ID, "test-oauth-callback-google-row", (db) =>
      db
        .select({ id: oauthProviders.id })
        .from(oauthProviders)
        .where(eq(oauthProviders.orgId, ORG_ID)),
    )
    await insertUser("deactivated-google@callback.test", "deactivated")

    const location = await runCallback(provider!.id, GOOGLE_ISSUER, GOOGLE_CLIENT_ID, {
      sub: "callback-test-google-3",
      email: "deactivated-google@callback.test",
    })

    expect(new URL(location, "http://x").searchParams.get("error")).toBe("Account deactivated")
    expect(await linkedAccounts(provider!.id)).toHaveLength(0)
  })

  it("first-party Google: an account in a demo org (unverified address) is never linked by email", async () => {
    const { markOrgAsDemo, invalidateDemoMarker, visitorMarker } = await import(
      "~/modules/demo/demo-org"
    )
    await withPrivilegedDb(ORG_ID, "test-oauth-callback-clean-providers-demo", async (db) => {
      await db.delete(oauthAccounts).where(eq(oauthAccounts.orgId, ORG_ID))
      await db.delete(oauthProviders).where(eq(oauthProviders.orgId, ORG_ID))
    })
    const providerId = await insertProvider({
      name: "Google",
      issuerUrl: GOOGLE_ISSUER,
      clientId: GOOGLE_CLIENT_ID,
      autoProvision: false,
    })
    await insertUser("precreated-demo@callback.test", "active")
    await markOrgAsDemo(ORG_ID, visitorMarker(24))
    try {
      const location = await runCallback(providerId, GOOGLE_ISSUER, GOOGLE_CLIENT_ID, {
        sub: "callback-test-google-demo",
        email: "precreated-demo@callback.test",
      })
      expect(new URL(location, "http://x").searchParams.get("error")).toBe(EXISTING_METHOD_ERROR)
      expect(await linkedAccounts(providerId)).toHaveLength(0)
    } finally {
      await withPrivilegedDb(ORG_ID, "test-oauth-callback-unmark-demo", (db) =>
        db.update(organizations).set({ settings: {} }).where(eq(organizations.id, ORG_ID)),
      )
      invalidateDemoMarker(ORG_ID)
    }
  })

  it("the state binding is read by exact cookie name, never from a look-alike cookie", async () => {
    await withPrivilegedDb(ORG_ID, "test-oauth-callback-clean-providers-cookie", async (db) => {
      await db.delete(oauthAccounts).where(eq(oauthAccounts.orgId, ORG_ID))
      await db.delete(oauthProviders).where(eq(oauthProviders.orgId, ORG_ID))
    })
    const providerId = await insertProvider({
      name: "Google",
      issuerUrl: GOOGLE_ISSUER,
      clientId: GOOGLE_CLIENT_ID,
      autoProvision: false,
    })
    const authRes = await app.request(`/api/auth/oauth/${providerId}/authorize`)
    const state = new URL(authRes.headers.get("location")!).searchParams.get("state")!
    const real = (authRes.headers.get("set-cookie") ?? "").split(";")[0]!
    expect(real.startsWith(`${oauthStateCookieSpec(false).name}=`)).toBe(true)
    const cbRes = await app.request(
      `/api/auth/oauth/callback?code=test-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: `x${real}` } },
    )
    expect(cbRes.status).toBe(400)
    expect(oauthStateCookieSpec(true)).toEqual({ name: "__Host-oauth_state", path: "/" })
  })

  it("the legacy link-complete route no longer exists", async () => {
    const res = await app.request("/api/auth/oauth/link-complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sub: "x", providerId: "00000000-0000-0000-0000-000000000001" }),
    })
    expect(res.status).toBe(404)
  })
})
