// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S29 — Liaison's MCP client against a spec-compliant OAuth-protected MCP
// server, on loopback. The resource server is the official SDK `McpServer`
// over Streamable HTTP; the authorization server is separate (PRM at the
// path-aware location only, DCR, CIMD, PKCE and `resource` enforced, 2 s
// access tokens, rotating refresh tokens, revocation, `iss`). Everything runs
// through the real routes (probe, create, start, callback, test) and the real
// call path (pool, per-request credentials, proactive refresh, 401 refresh,
// advisory-locked refresh), so a regression anywhere in the chain fails here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { OAuthRegistrationTestAccess } from "~/apps/mcp-manager/oauth-registration"
import { mcpManagerOAuthRoutes } from "~/apps/mcp-manager/oauth-routes"
import { mcpManagerRoutes } from "~/apps/mcp-manager/routes"
import { buildMcpWorld, type McpTestWorld } from "~/apps/mcp-manager/test-helpers/world"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnectionHealth, mcpConnections } from "~/db/schema/app_mcp_manager"
import { errorHandler } from "~/middleware/error-handler"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { initMcpClient, McpClientTestAccess } from "./index"
import type { McpOAuthMetadata } from "./secrets"
import {
  ADMIN_TOOL,
  type OAuthFixtureHandle,
  type OAuthFixtureOptions,
  startOAuthMcpFixture,
} from "./transports/fixtures/oauth-mcp-server"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function appAs(actor: UserContext) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", actor.userId)
    c.set("orgId", actor.orgId)
    c.set("scopes", actor.scopes as never)
    c.set("dimensionGrants", actor.dimensionGrants ?? {})
    await next()
  })
  app.route("/api/apps/mcp-manager", mcpManagerRoutes)
  app.route("/api/apps/mcp-manager", mcpManagerOAuthRoutes)
  app.onError(errorHandler)
  return app
}

describe("S29: Liaison's MCP client against a real OAuth-protected MCP server", () => {
  let world: McpTestWorld
  const prevAllow = process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP

  beforeAll(async () => {
    await acquireTestLock()
    // Loopback MCP targets: the opt-in the e2e server uses (inert outside test).
    process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = "1"
    McpClientTestAccess.reset()
    await initMcpClient({ skipEnvBootstrap: true, skipReapTimer: true })
  })
  afterAll(async () => {
    McpClientTestAccess.reset()
    OAuthRegistrationTestAccess.setPublicBaseUrl(null)
    if (prevAllow === undefined) delete process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP
    else process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = prevAllow
    await releaseTestLock()
  })
  beforeEach(async () => {
    world = await buildMcpWorld()
    OAuthRegistrationTestAccess.setPublicBaseUrl(null)
  })

  async function json(res: Response): Promise<Record<string, any>> {
    return (await res.json()) as Record<string, any>
  }

  async function post(path: string, body: unknown) {
    return appAs(world.admin).request(`/api/apps/mcp-manager${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  /** The add flow as the web drives it: probe → create → start → consent → callback. */
  async function addAndSignIn(
    fixture: OAuthFixtureHandle,
    opts: { clientId?: string; clientSecret?: string } = {},
  ): Promise<{ id: string; probe: Record<string, any> }> {
    const probeRes = await post("/probe", { url: fixture.mcpUrl })
    expect(probeRes.status).toBe(200)
    const probe = (await json(probeRes)).data
    const created = await post("/connections", {
      slug: `s29-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "S29 server",
      transport: "http",
      httpUrl: fixture.mcpUrl,
      authFlavor: probe.mode === "preregistered" ? "oauth_static" : "oauth_dcr",
      connectionDefaultPolicy: "auto",
      ...(opts.clientId ? { oauthClientId: opts.clientId } : {}),
      ...(opts.clientSecret ? { oauthClientSecret: opts.clientSecret } : {}),
    })
    expect(created.status).toBe(200)
    const { id } = await json(created)
    const start = await post(`/connections/${id}/oauth/start`, {})
    expect(start.status).toBe(200)
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    const back = await fixture.authorize((await json(start)).authorizationUrl)
    const cb = await appAs(world.admin).request(`${back.pathname}${back.search}`, {
      method: "GET",
      headers: { cookie },
    })
    expect(cb.status).toBe(302)
    return { id, probe }
  }

  async function call(id: string, tool = "echo", engine = McpClientTestAccess.orchestrator()) {
    return engine.executeMcpCall({
      connectionId: id,
      serverToolName: tool,
      args: tool === "echo" ? { message: "ping" } : {},
      actor: world.admin,
    })
  }

  async function healthOf(id: string): Promise<string | undefined> {
    const [row] = await withSystemDb("s29-health", (db) =>
      db.select().from(mcpConnectionHealth).where(eq(mcpConnectionHealth.connectionId, id)),
    )
    return row?.status
  }

  async function metaOf(id: string): Promise<McpOAuthMetadata> {
    const [row] = await withSystemDb("s29-meta", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    return (row.oauthMetadata ?? {}) as McpOAuthMetadata
  }

  async function withFixture(
    opts: Partial<OAuthFixtureOptions> & { asPath?: string },
    fn: (fixture: OAuthFixtureHandle) => Promise<void>,
  ): Promise<void> {
    const fixture = await startOAuthMcpFixture(opts)
    try {
      await fn(fixture)
    } finally {
      await fixture.close()
    }
  }

  it("DCR: add → discovery → register → authorize → token → tools → call → expiry → proactive refresh → revoked refresh → needs_reauth", async () => {
    await withFixture({}, async (fixture) => {
      const { id, probe } = await addAndSignIn(fixture)
      expect(probe.mode).toBe("dcr")
      expect(fixture.stats.registerCalls).toBe(1)
      // The authorize request carried the PRM resource, the challenge scope, S256.
      expect(fixture.stats.lastAuthorize).toMatchObject({
        resource: fixture.mcpUrl,
        scope: "mcp:tools",
        code_challenge_method: "S256",
      })

      const test = await json(await post(`/connections/${id}/test`, {}))
      expect(test.ok).toBe(true)
      expect(test.tools.map((t: { name: string }) => t.name)).toContain("echo")

      const first = await call(id)
      expect(first).toMatchObject({ ok: true })

      // Past the 2 s access-token lifetime: the call refreshes BEFORE it goes
      // out, so the resource server never sees the expired token.
      await sleep(2_200)
      const refreshesBefore = fixture.stats.refreshSuccesses
      const rs401Before = fixture.stats.rs401
      const second = await call(id)
      expect(second).toMatchObject({ ok: true })
      expect(fixture.stats.refreshSuccesses).toBeGreaterThan(refreshesBefore)
      expect(fixture.stats.rs401).toBe(rs401Before)
      const refresh = fixture.stats.tokenRequests.filter((r) => r.grant_type === "refresh_token")
      expect(refresh.every((r) => r.resource === fixture.mcpUrl)).toBe(true)

      // The refresh token is revoked: the next refresh is invalid_grant → sign in again.
      fixture.revokeRefreshTokens()
      await sleep(2_200)
      const third = await call(id)
      expect(third).toMatchObject({ ok: false, error: { reason: "needs_reauth" } })
      expect(await healthOf(id)).toBe("needs_reauth")
      const list = await json(
        await appAs(world.admin).request("/api/apps/mcp-manager/connections", { method: "GET" }),
      )
      expect(list.data.find((c: { id: string }) => c.id === id)?.status).toBe("needs_reauth")
    })
  })

  it("pre-registered confidential client (no registration_endpoint): client_secret_post + PKCE", async () => {
    await withFixture(
      { registration: false, tokenEndpointAuthMethods: ["client_secret_post"] },
      async (fixture) => {
        const { callbackUrl } = await import("~/apps/mcp-manager/oauth-registration")
        fixture.addClient({
          clientId: "pre-registered-1",
          clientSecret: "pre-secret",
          authMethod: "client_secret_post",
          redirectUris: [callbackUrl()],
        })
        const { id, probe } = await addAndSignIn(fixture, {
          clientId: "pre-registered-1",
          clientSecret: "pre-secret",
        })
        expect(probe).toMatchObject({ mode: "preregistered", requiresClientSecret: true })
        expect(fixture.stats.registerCalls).toBe(0)
        expect(await call(id)).toMatchObject({ ok: true })
        // The refresh authenticates the confidential client too.
        await sleep(2_200)
        expect(await call(id)).toMatchObject({ ok: true })
        const refresh = fixture.stats.tokenRequests.find((r) => r.grant_type === "refresh_token")
        expect(refresh?.client_secret).toBe("pre-secret")
      },
    )
  })

  it("CIMD: the AS fetches Liaison's client metadata document as the client id", async () => {
    OAuthRegistrationTestAccess.setPublicBaseUrl("https://liaison.test")
    await withFixture({ cimd: true, registration: true }, async (fixture) => {
      fixture.setOptions({
        fetchClientMetadata: async (url) =>
          appAs(world.admin).request(new URL(url).pathname, { method: "GET" }),
      })
      const { id, probe } = await addAndSignIn(fixture)
      expect(probe.mode).toBe("cimd")
      expect(fixture.stats.registerCalls).toBe(0)
      expect(fixture.stats.cimdFetches).toContain(
        "https://liaison.test/api/apps/mcp-manager/oauth/client-metadata.json",
      )
      expect((await metaOf(id)).clientIdSource).toBe("cimd")
      expect(await call(id)).toMatchObject({ ok: true })
    })
  })

  it("an access token revoked early: 401 → refresh → the retry carries the NEW token", async () => {
    await withFixture({ accessTokenTtlSec: 3600 }, async (fixture) => {
      const { id } = await addAndSignIn(fixture)
      expect(await call(id)).toMatchObject({ ok: true })
      const before = fixture.stats.acceptedTokens.at(-1)
      fixture.revokeAccessTokens()
      const rs401Before = fixture.stats.rs401
      const result = await call(id)
      expect(result).toMatchObject({ ok: true })
      expect(fixture.stats.rs401).toBeGreaterThan(rs401Before)
      expect(fixture.stats.refreshSuccesses).toBe(1)
      const after = fixture.stats.acceptedTokens.at(-1)
      expect(after).not.toBe(before)
    })
  })

  it("two callers in separate clients after expiry both succeed through one refresh", async () => {
    await withFixture({}, async (fixture) => {
      const { id } = await addAndSignIn(fixture)
      // A second, independent engine: its own pool, credential cache and
      // refresher, like another API process sharing the database.
      const other = await McpClientTestAccess.buildEngine()
      try {
        expect(await call(id)).toMatchObject({ ok: true })
        expect(await call(id, "echo", other)).toMatchObject({ ok: true })
        // The first engine adopts the token the second one refreshed, so both
        // now hold the SAME token and the same (single-use) refresh token.
        const postsBeforeAdopt = fixture.stats.refreshPosts
        expect(await call(id)).toMatchObject({ ok: true })
        expect(fixture.stats.refreshPosts).toBe(postsBeforeAdopt)
        await sleep(2_200)
        // A slow token endpoint: the second refresh arrives while the first
        // one's POST is still in flight.
        fixture.setOptions({ tokenDelayMs: 400 })
        const postsBefore = fixture.stats.refreshPosts
        const [a, b] = await Promise.all([call(id), call(id, "echo", other)])
        expect(a).toMatchObject({ ok: true })
        expect(b).toMatchObject({ ok: true })
        // Rotation: a second POST would replay a dead refresh token.
        expect(fixture.stats.refreshPosts - postsBefore).toBe(1)
        expect(await healthOf(id)).not.toBe("needs_reauth")
      } finally {
        await other.close()
      }
    })
  })

  it("a 503 from the token endpoint is retried and the call succeeds", async () => {
    await withFixture({}, async (fixture) => {
      const { id } = await addAndSignIn(fixture)
      await sleep(2_200)
      fixture.failNextTokenRequests(1, 503)
      const postsBefore = fixture.stats.refreshPosts
      expect(await call(id)).toMatchObject({ ok: true })
      expect(fixture.stats.refreshPosts - postsBefore).toBe(2)
      expect(await healthOf(id)).not.toBe("needs_reauth")
    })
  })

  it("a token endpoint redirecting cross-origin: the refresh is refused and the other origin receives nothing", async () => {
    const stolen: Array<{ authorization: string | null; body: string }> = []
    const thief = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        stolen.push({ authorization: req.headers.get("authorization"), body: await req.text() })
        return Response.json({ access_token: "ATTACKER", token_type: "Bearer", expires_in: 3600 })
      },
    })
    try {
      await withFixture(
        { registration: false, tokenEndpointAuthMethods: ["client_secret_basic"] },
        async (fixture) => {
          const { callbackUrl } = await import("~/apps/mcp-manager/oauth-registration")
          fixture.addClient({
            clientId: "s29-redirect-client",
            clientSecret: "S29-REDIRECT-SECRET",
            authMethod: "client_secret_basic",
            redirectUris: [callbackUrl()],
          })
          const { id } = await addAndSignIn(fixture, {
            clientId: "s29-redirect-client",
            clientSecret: "S29-REDIRECT-SECRET",
          })
          expect(await call(id)).toMatchObject({ ok: true })
          await sleep(2_200)
          fixture.setOptions({ tokenRedirectTo: `http://127.0.0.1:${thief.port}/steal` })
          const postsBefore = fixture.stats.refreshPosts
          const result = await call(id)
          expect(result).toMatchObject({ ok: false })
          expect(fixture.stats.refreshPosts).toBeGreaterThan(postsBefore)
          expect(stolen).toEqual([])
          expect(fixture.stats.acceptedTokens).not.toContain("ATTACKER")
        },
      )
    } finally {
      thief.stop(true)
    }
  })

  it("403 insufficient_scope → needs_reauth; the next sign-in asks for the union scope", async () => {
    await withFixture({ accessTokenTtlSec: 3600 }, async (fixture) => {
      const { id } = await addAndSignIn(fixture)
      const res = await call(id, ADMIN_TOOL)
      expect(res).toMatchObject({ ok: false, error: { reason: "needs_reauth" } })
      expect(await healthOf(id)).toBe("needs_reauth")
      // A later successful call (another tool) does not hide the step-up.
      expect(await call(id)).toMatchObject({ ok: true })
      expect(await healthOf(id)).toBe("needs_reauth")
      const start = await post(`/connections/${id}/oauth/start`, {})
      const url = new URL((await json(start)).authorizationUrl)
      expect((url.searchParams.get("scope") ?? "").split(" ").sort()).toEqual([
        "mcp:admin",
        "mcp:tools",
      ])
      // Signing in again clears it and the tool works.
      const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
      const back = await fixture.authorize(url.toString())
      const cb = await appAs(world.admin).request(`${back.pathname}${back.search}`, {
        method: "GET",
        headers: { cookie },
      })
      expect(cb.status).toBe(302)
      expect(await healthOf(id)).not.toBe("needs_reauth")
      expect(await call(id, ADMIN_TOOL)).toMatchObject({ ok: true })
    })
  })

  describe("a misbehaving server is refused", () => {
    async function startRefused(
      opts: Partial<OAuthFixtureOptions>,
    ): Promise<{ status: number; text: string }> {
      let out = { status: 0, text: "" }
      await withFixture(opts, async (fixture) => {
        const created = await post("/connections", {
          slug: `bad-${crypto.randomUUID().slice(0, 8)}`,
          displayName: "Bad",
          transport: "http",
          httpUrl: fixture.mcpUrl,
          authFlavor: "oauth_dcr",
        })
        const { id } = await json(created)
        const start = await post(`/connections/${id}/oauth/start`, {})
        if (start.status !== 200) {
          out = { status: start.status, text: await start.text() }
          return
        }
        const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
        const back = await fixture.authorize((await json(start)).authorizationUrl)
        const cb = await appAs(world.admin).request(`${back.pathname}${back.search}`, {
          method: "GET",
          headers: { cookie },
        })
        out = { status: cb.status, text: await cb.text() }
        expect(fixture.stats.authorizationCodeGrants).toBe(0)
      })
      return out
    }

    it("PRM resource naming another server", async () => {
      const r = await startRefused({ prmResourceOverride: "https://mcp.example.com/mcp" })
      expect(r.status).toBe(502)
      expect(r.text).toContain("resource_mismatch")
    })
    it("AS metadata issuer mismatch", async () => {
      const r = await startRefused({ issuerOverride: "https://other.example" })
      expect(r.status).toBe(502)
      expect(r.text).toContain("issuer_mismatch")
    })
    it("missing iss when the AS advertises it", async () => {
      const r = await startRefused({ issPolicy: "missing" })
      expect(r.status).toBe(400)
      expect(r.text).toContain("iss_missing")
    })
    it("wrong iss", async () => {
      const r = await startRefused({ issPolicy: "wrong" })
      expect(r.status).toBe(400)
      expect(r.text).toContain("iss_mismatch")
    })
    it("no code_challenge_methods_supported", async () => {
      const r = await startRefused({ codeChallengeMethods: null })
      expect(r.status).toBe(502)
      expect(r.text).toContain("pkce_unsupported")
    })
  })
})
