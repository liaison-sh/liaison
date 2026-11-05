// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq, sql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnections, mcpOAuthState } from "~/db/schema/app_mcp_manager"
import { CryptoContext, decryptSecret } from "~/lib/crypto"
import { encryptionKey } from "~/lib/env"
import { errorHandler } from "~/middleware/error-handler"
import {
  type OAuthFixtureHandle,
  startOAuthMcpFixture,
} from "~/modules/mcp-client/transports/fixtures/oauth-mcp-server"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { mcpManagerOAuthRoutes } from "./oauth-routes"
import { buildMcpWorld, type McpTestWorld } from "./test-helpers/world"

/**
 * Minimal in-process OAuth fixture. Exposes:
 *   GET  /.well-known/oauth-authorization-server
 *   POST /register
 *   GET  /authorize    (immediately redirects back with `code` + `state`)
 *   POST /token        (returns deterministic access/refresh tokens)
 *
 * Returns a `Bun.serve` handle the test can close + the issuer base URL.
 */
async function startFixtureOAuthServer(
  options: { failRegister?: boolean; failToken?: boolean; authorizationEndpoint?: string } = {},
) {
  let registerCalls = 0
  // Bun.serve typing: `fetch` is invoked with the server bound at call time,
  // but ts-strict flags self-referential `server` lookup as implicit-any. Bind
  // the issuer URL once the server is constructed (below) and capture it via
  // a closure variable.
  let issuerBase = ""
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0, // ephemeral
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      const path = url.pathname
      if (path === "/.well-known/oauth-authorization-server") {
        const issuer = issuerBase
        return Response.json({
          issuer,
          authorization_endpoint: options.authorizationEndpoint ?? `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          registration_endpoint: `${issuer}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        })
      }
      if (path === "/register") {
        registerCalls++
        if (options.failRegister) return new Response("nope", { status: 404 })
        // RFC 7591 §3.2.1: the response carries the registered metadata.
        const registered = (await req.json()) as { redirect_uris?: string[] }
        return Response.json({
          client_id: "fixture-client-id",
          redirect_uris: registered.redirect_uris ?? [],
        })
      }
      if (path === "/token") {
        if (options.failToken) return new Response("bad", { status: 400 })
        return Response.json({
          access_token: "fixture-access-token",
          token_type: "Bearer",
          refresh_token: "fixture-refresh-token",
          sub: "user-42",
        })
      }
      return new Response("not found", { status: 404 })
    },
  })
  issuerBase = `http://${server.hostname}:${server.port}`
  return {
    issuerUrl: issuerBase,
    close: () => server.stop(true),
    getRegisterCalls: () => registerCalls,
  }
}

function appAs(actor: UserContext) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", actor.userId)
    c.set("orgId", actor.orgId)
    c.set("scopes", actor.scopes as any)
    c.set("dimensionGrants", actor.dimensionGrants ?? {})
    await next()
  })
  app.route("/apps/mcp-manager", mcpManagerOAuthRoutes)
  return app
}

/** The provider's redirect as it really arrives: no session, no Bearer token. */
function appWithoutSession() {
  const app = new Hono<AppEnv>()
  app.route("/apps/mcp-manager", mcpManagerOAuthRoutes)
  return app
}

describe("mcp-manager OAuth routes", () => {
  let world: McpTestWorld
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  beforeEach(async () => {
    world = await buildMcpWorld()
  })

  async function seedDcrConnection(httpUrl: string, displayName = "DCR Test") {
    return withSystemDb("oauth-seed-dcr", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: `dcr-${crypto.randomUUID().slice(0, 6)}`,
          displayName,
          transport: "http",
          httpUrl,
          authFlavor: "oauth_dcr",
          createdBy: world.admin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
  }

  async function seedStaticConnection(authzEndpoint: string, tokenEndpoint: string) {
    return withSystemDb("oauth-seed-static", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: `stat-${crypto.randomUUID().slice(0, 6)}`,
          displayName: "Static Test",
          transport: "http",
          httpUrl: "https://x",
          authFlavor: "oauth_static",
          oauthMetadata: {
            clientId: "preconfig-1",
            authorizationEndpoint: authzEndpoint,
            tokenEndpoint,
          },
          createdBy: world.admin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
  }

  it("oauth_dcr start: discovers + registers + returns authorizationUrl with PKCE challenge", async () => {
    const fixture = await startFixtureOAuthServer()
    try {
      const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
      const res = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.authorizationUrl).toContain("code_challenge=")
      expect(body.authorizationUrl).toContain("code_challenge_method=S256")
      expect(body.authorizationUrl).toContain("client_id=fixture-client-id")
      expect(fixture.getRegisterCalls()).toBe(1)
      // state row persisted
      const [row] = await withSystemDb("oauth-fetch-state", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      expect(row).toBeTruthy()
      expect(row.pkceVerifier.length).toBeGreaterThan(40)
    } finally {
      fixture.close()
    }
  })

  it("oauth_static start: does NOT call /register (uses admin-provided endpoints)", async () => {
    const fixture = await startFixtureOAuthServer()
    try {
      const connId = await seedStaticConnection(
        `${fixture.issuerUrl}/authorize`,
        `${fixture.issuerUrl}/token`,
      )
      const res = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.authorizationUrl).toContain(`${fixture.issuerUrl}/authorize`)
      expect(body.authorizationUrl).toContain("client_id=preconfig-1")
      // Critical: oauth_static must skip discovery + /register entirely
      expect(fixture.getRegisterCalls()).toBe(0)
    } finally {
      fixture.close()
    }
  })

  it("callback with state mismatch → 400 state_mismatch, no token persist", async () => {
    const fixture = await startFixtureOAuthServer()
    try {
      const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
      // No state seeded — callback should reject.
      const res = await appAs(world.admin).request(
        `/apps/mcp-manager/oauth/callback?code=fake&state=does-not-exist`,
        { method: "GET" },
      )
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error.code).toBe("state_mismatch")
      const [row] = await withSystemDb("oauth-after-bad", (db) =>
        db.select().from(mcpConnections).where(eq(mcpConnections.id, connId)),
      )
      expect(row.secretsEncrypted).toBeNull()
    } finally {
      fixture.close()
    }
  })

  it("callback for since-deleted connection: state cascades with the connection → state_mismatch (effective 'gone' signal)", async () => {
    // The FK constraint ON DELETE CASCADE means deleting the connection also
    // removes its mcp_oauth_state rows. The callback can't tell the difference
    // between "you never started this flow" and "the connection was deleted
    // mid-flow" — both surface as state_mismatch. That's the right contract:
    // the redirect target should never accidentally re-create a connection or
    // leak details about deletion timing.
    const fixture = await startFixtureOAuthServer()
    try {
      const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
      const seededState = `s-${crypto.randomUUID()}`
      await withSystemDb("oauth-seed-state", async (db) => {
        await db.insert(mcpOAuthState).values({
          connectionId: connId,
          pkceVerifier: "v".repeat(43),
          state: seededState,
          expiresAt: new Date(Date.now() + 60_000),
        })
        // Deleting the connection cascades the state row away.
        await db.delete(mcpConnections).where(eq(mcpConnections.id, connId))
      })
      const res = await appAs(world.admin).request(
        `/apps/mcp-manager/oauth/callback?code=fake&state=${seededState}`,
        { method: "GET" },
      )
      expect(res.status).toBe(400)
      expect(((await res.json()) as any).error.code).toBe("state_mismatch")
      // Sanity: confirm the cascade actually happened, so the test is honest.
      const orphan = await withSystemDb("oauth-cascade-check", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.state, seededState)),
      )
      expect(orphan).toHaveLength(0)
    } finally {
      fixture.close()
    }
  })

  it("oauth_dcr start refuses a non-https authorization_endpoint (javascript:) from discovery", async () => {
    const fixture = await startFixtureOAuthServer({ authorizationEndpoint: "javascript:alert(1)" })
    try {
      const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
      const res = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
      expect(res.status).toBe(502)
      expect(await res.text()).toContain("authorization server metadata")
      expect(fixture.getRegisterCalls()).toBe(0)
    } finally {
      fixture.close()
    }
  })

  it("the success page names the server the callback finished, escapes it, and reads no row by URL", async () => {
    const fixture = await startFixtureOAuthServer()
    try {
      const connId = await seedDcrConnection(
        `${fixture.issuerUrl}/mcp`,
        `Notion</title><script>alert(1)</script>`,
      )
      const start = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
      expect(start.status).toBe(200)
      const [stateRow] = await withSystemDb("oauth-done-state", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      const bindingCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!
      const cb = await appWithoutSession().request(
        `/apps/mcp-manager/oauth/callback?code=fake-auth-code&state=${stateRow.state}`,
        { method: "GET", headers: { cookie: bindingCookie } },
      )
      expect(cb.status).toBe(302)
      const location = new URL(cb.headers.get("location") ?? "")
      expect(location.pathname).toBe("/api/apps/mcp-manager/oauth/done")
      expect(location.searchParams.get("oauth")).toBe("ok")
      const res = await appWithoutSession().request(
        `/apps/mcp-manager/oauth/done${location.search}`,
      )
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain(
        "<h1>Notion&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt; connected</h1>",
      )
      expect(html).not.toContain("<script>")
      expect(html).toContain("You can close this window")
      const csp = res.headers.get("content-security-policy") ?? ""
      expect(csp).toContain("default-src 'none'")
      expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/=]+'/)
      // The connection id alone names nothing: the page reads no row for a URL.
      const byId = await appWithoutSession().request(
        `/apps/mcp-manager/oauth/done?connection=${connId}&oauth=ok`,
      )
      const byIdHtml = await byId.text()
      expect(byIdHtml).toContain("<h1>Server connected</h1>")
      expect(byIdHtml).not.toContain("Notion")
    } finally {
      fixture.close()
    }
    // A crafted query string never reaches the page.
    const forged = await appWithoutSession().request(
      "/apps/mcp-manager/oauth/done?connection=<b>x</b>&name=Evil&done=Evil",
    )
    const forgedHtml = await forged.text()
    expect(forgedHtml).toContain("<h1>Server connected</h1>")
    expect(forgedHtml).not.toContain("Evil")
    expect(forgedHtml).not.toContain("<b>x</b>")
  })

  it("oauth_static start refuses a data: authorization endpoint", async () => {
    const fixture = await startFixtureOAuthServer()
    try {
      const connId = await seedStaticConnection(
        "data:text/html,<script>1</script>",
        `${fixture.issuerUrl}/token`,
      )
      const res = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
      expect(res.status).toBe(502)
    } finally {
      fixture.close()
    }
  })

  it("DCR /register failure surfaces 502 with the pre-registered client hint", async () => {
    const fixture = await startFixtureOAuthServer({ failRegister: true })
    try {
      const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
      const res = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
      expect(res.status).toBe(502)
      const txt = await res.text()
      expect(txt.toLowerCase()).toContain("client id")
    } finally {
      fixture.close()
    }
  })

  it("a callback from a browser that did not start the flow is refused and spends the state", async () => {
    const fixture = await startFixtureOAuthServer()
    try {
      const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
      const start = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
      expect(start.status).toBe(200)
      const [stateRow] = await withSystemDb("oauth-fetch-state-unbound", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      // A colleague opening the forwarded authorize link: no binding cookie.
      const cb = await appAs(world.admin).request(
        `/apps/mcp-manager/oauth/callback?code=fake-auth-code&state=${stateRow.state}`,
        { method: "GET" },
      )
      expect(cb.status).toBe(403)
      const left = await withSystemDb("oauth-fetch-state-unbound-after", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      expect(left).toHaveLength(0)
    } finally {
      fixture.close()
    }
  })

  it("full flow: start → token exchange → secrets_encrypted populated, state row deleted, audit queued", async () => {
    const fixture = await startFixtureOAuthServer()
    try {
      const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
      // Start (gives us the verifier inside mcp_oauth_state)
      const start = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
      expect(start.status).toBe(200)
      const [stateRow] = await withSystemDb("oauth-fetch-state-2", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      // Simulate the issuer's redirect, in the browser that started the flow
      // (it carries the binding cookie the start response set).
      const bindingCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!
      const cb = await appAs(world.admin).request(
        `/apps/mcp-manager/oauth/callback?code=fake-auth-code&state=${stateRow.state}`,
        { method: "GET", headers: { cookie: bindingCookie } },
      )
      expect(cb.status).toBe(302)
      // Token persisted + state row cleaned up
      const [conn] = await withSystemDb("oauth-fetch-conn", (db) =>
        db.select().from(mcpConnections).where(eq(mcpConnections.id, connId)),
      )
      expect(conn.secretsEncrypted).toBeTruthy()
      const blob = JSON.parse(
        decryptSecret(conn.secretsEncrypted!, encryptionKey, CryptoContext.mcpConnectionSecrets),
      )
      expect(blob.accessToken).toBe("fixture-access-token")
      expect(blob.refreshToken).toBe("fixture-refresh-token")
      expect((conn.oauthMetadata as any).subject).toBe("user-42")
      const stateAfter = await withSystemDb("oauth-fetch-state-3", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      expect(stateAfter).toHaveLength(0)
    } finally {
      fixture.close()
    }
  })
  it("a sessionless callback records the person who started the flow as the actor", async () => {
    const fixture = await startFixtureOAuthServer()
    try {
      const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
      const start = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      )
      expect(start.status).toBe(200)
      const [stateRow] = await withSystemDb("oauth-fetch-state-actor", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      const bindingCookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!
      const cb = await appWithoutSession().request(
        `/apps/mcp-manager/oauth/callback?code=fake-auth-code&state=${stateRow.state}`,
        { method: "GET", headers: { cookie: bindingCookie } },
      )
      expect(cb.status).toBe(302)
      const rows = await withSystemDb("oauth-completed-event", (db) =>
        db.execute(sql`
          SELECT payload FROM kernel.pending_events
          WHERE payload->>'action' = 'oauth_completed' AND payload->>'entityId' = ${connId}`),
      )
      const payload =
        extractRows<{ payload: { actorId: string | null; actorType: string } }>(rows)[0]?.payload ??
        null
      expect(payload).toMatchObject({ actorId: world.admin.userId, actorType: "user" })
    } finally {
      fixture.close()
    }
  })
  // ── From the desktop or mobile shell (shell-connect.ts) ───────────────────
  // The shell's fetch is cross site, so the binding cookie the browser flow
  // relies on is never stored there: the shell binds the flow to itself with a
  // PKCE verifier, the callback parks the grant behind a one-time code handed
  // back on `liaison://oauth-complete`, and only the shell's own session with
  // its verifier completes it.
  describe("from the desktop or mobile shell", () => {
    const SHELL_ORIGIN = "tauri://localhost"
    const pkce = () => {
      const verifier = crypto.randomBytes(32).toString("base64url")
      return {
        verifier,
        challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
      }
    }
    const appState = () => crypto.randomBytes(32).toString("base64url")

    async function shellStart(
      connId: string,
      challenge: string,
      returnState: string,
      origin = SHELL_ORIGIN,
    ) {
      return appAs(world.admin).request(`/apps/mcp-manager/connections/${connId}/oauth/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          client: "desktop",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: returnState,
        }),
      })
    }

    async function stateOf(connId: string): Promise<string> {
      const [row] = await withSystemDb("oauth-shell-state", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      return row.state
    }

    async function handoffLink(res: Response): Promise<URL> {
      expect(res.status).toBe(200)
      const match = (await res.text()).match(/content="0;url=([^"]+)"/)
      expect(match).not.toBeNull()
      return new URL(match![1].replace(/&amp;/g, "&"))
    }

    async function storedAccessToken(connId: string): Promise<string | undefined> {
      const [conn] = await withSystemDb("oauth-shell-conn", (db) =>
        db.select().from(mcpConnections).where(eq(mcpConnections.id, connId)),
      )
      if (!conn.secretsEncrypted) return undefined
      return JSON.parse(
        decryptSecret(conn.secretsEncrypted, encryptionKey, CryptoContext.mcpConnectionSecrets),
      ).accessToken
    }

    const redeem = (body: Record<string, unknown>, actor: UserContext = world.admin) =>
      appAs(actor).request("/apps/mcp-manager/oauth/handoff", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: SHELL_ORIGIN },
        body: JSON.stringify(body),
      })

    it("completes a shell sign-in with the binding on, once, and only with the shell's verifier", async () => {
      const fixture = await startFixtureOAuthServer()
      try {
        const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
        const { verifier, challenge } = pkce()
        const returnState = appState()
        const start = await shellStart(connId, challenge, returnState)
        expect(start.status).toBe(200)
        // No binding cookie: the shell could not keep one, and nothing relies on it.
        expect(start.headers.get("set-cookie") ?? "").not.toContain("mcp_oauth_state")
        // The system browser lands on the callback with no cookie of the shell's.
        const cb = await appAs(world.admin).request(
          `/apps/mcp-manager/oauth/callback?code=fake-auth-code&state=${await stateOf(connId)}`,
          { method: "GET" },
        )
        const link = await handoffLink(cb)
        expect(link.protocol).toBe("liaison:")
        expect(link.host).toBe("oauth-complete")
        expect(link.searchParams.get("state")).toBe(returnState)
        const code = link.searchParams.get("code")!
        expect(code).toMatch(/^[0-9a-f]{64}$/)
        // Parked, not completed.
        expect(await storedAccessToken(connId)).toBeUndefined()

        const done = await redeem({ code, code_verifier: verifier })
        expect(done.status).toBe(200)
        expect(((await done.json()) as any).data).toEqual({ connectionId: connId })
        expect(await storedAccessToken(connId)).toBe("fixture-access-token")
        const left = await withSystemDb("oauth-shell-left", (db) =>
          db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
        )
        expect(left).toHaveLength(0)

        // A replayed code is refused.
        expect((await redeem({ code, code_verifier: verifier })).status).toBe(400)
      } finally {
        fixture.close()
      }
    })

    it("refuses a code redeemed without the shell's verifier or by another user, and burns it", async () => {
      const fixture = await startFixtureOAuthServer()
      try {
        const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
        const { verifier, challenge } = pkce()
        await shellStart(connId, challenge, appState())
        const cb = await appAs(world.admin).request(
          `/apps/mcp-manager/oauth/callback?code=fake-auth-code&state=${await stateOf(connId)}`,
          { method: "GET" },
        )
        const code = (await handoffLink(cb)).searchParams.get("code")!
        expect((await redeem({ code, code_verifier: pkce().verifier })).status).toBe(400)
        // The refused attempt burned it.
        expect((await redeem({ code, code_verifier: verifier })).status).toBe(400)
        expect(await storedAccessToken(connId)).toBeUndefined()

        // Another member of the org with the right verifier is refused too.
        const connId2 = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
        const second = pkce()
        await shellStart(connId2, second.challenge, appState())
        const cb2 = await appAs(world.admin).request(
          `/apps/mcp-manager/oauth/callback?code=fake-auth-code&state=${await stateOf(connId2)}`,
          { method: "GET" },
        )
        const code2 = (await handoffLink(cb2)).searchParams.get("code")!
        const other = { ...world.admin, userId: crypto.randomUUID() }
        expect((await redeem({ code: code2, code_verifier: second.verifier }, other)).status).toBe(
          400,
        )
        expect(await storedAccessToken(connId2)).toBeUndefined()
      } finally {
        fixture.close()
      }
    })

    it("a provider refusal on a shell flow goes back to the shell and spends the state", async () => {
      const fixture = await startFixtureOAuthServer()
      try {
        const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
        const returnState = appState()
        await shellStart(connId, pkce().challenge, returnState)
        const res = await appAs(world.admin).request(
          `/apps/mcp-manager/oauth/callback?error=access_denied&state=${await stateOf(connId)}`,
          { method: "GET" },
        )
        const link = await handoffLink(res)
        expect(link.searchParams.get("error")).toBe("access_denied")
        expect(link.searchParams.get("state")).toBe(returnState)
        const left = await withSystemDb("oauth-shell-refused", (db) =>
          db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
        )
        expect(left).toHaveLength(0)
      } finally {
        fixture.close()
      }
    })

    it("a browser tab cannot ask for the shell flow", async () => {
      const fixture = await startFixtureOAuthServer()
      try {
        const connId = await seedDcrConnection(`${fixture.issuerUrl}/mcp`)
        const refused = await shellStart(
          connId,
          pkce().challenge,
          appState(),
          "https://evil.example",
        )
        expect(refused.status).toBe(400)
      } finally {
        fixture.close()
      }
    })
  })
})

// ── S26 / A14: the MCP authorization spec against a compliant AS ───────────
describe("mcp-manager OAuth routes — MCP authorization spec", () => {
  let world: McpTestWorld
  let fixture: OAuthFixtureHandle
  const CALLBACK = "/apps/mcp-manager/oauth/callback"
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  beforeEach(async () => {
    world = await buildMcpWorld()
  })

  async function seed(httpUrl: string, flavor: "oauth_dcr" | "oauth_static" = "oauth_dcr") {
    return withSystemDb("oauth-spec-seed", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: `spec-${crypto.randomUUID().slice(0, 6)}`,
          displayName: "Spec",
          transport: "http",
          httpUrl,
          authFlavor: flavor,
          createdBy: world.admin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
  }

  async function start(connId: string) {
    const res = await appAs(world.admin).request(
      `/apps/mcp-manager/connections/${connId}/oauth/start`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    )
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
    return { res, cookie }
  }

  /** Consent at the AS, then land on Liaison's callback in the same browser. */
  async function consentAndReturn(authorizationUrl: string, cookie: string, accept?: string) {
    const back = await fixture.authorize(authorizationUrl)
    return appAs(world.admin).request(`${CALLBACK}${back.search}`, {
      method: "GET",
      headers: { cookie, ...(accept ? { accept } : {}) },
    })
  }

  async function storedBlob(connId: string) {
    const [conn] = await withSystemDb("oauth-spec-conn", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, connId)),
    )
    return {
      conn,
      blob: conn.secretsEncrypted
        ? JSON.parse(
            decryptSecret(conn.secretsEncrypted, encryptionKey, CryptoContext.mcpConnectionSecrets),
          )
        : {},
    }
  }

  it("start: the authorize URL carries the PRM resource verbatim, the challenge scope and S256", async () => {
    fixture = await startOAuthMcpFixture()
    try {
      const connId = await seed(fixture.mcpUrl)
      const { res } = await start(connId)
      expect(res.status).toBe(200)
      const url = new URL(((await res.json()) as any).authorizationUrl)
      expect(url.searchParams.get("resource")).toBe(fixture.mcpUrl)
      expect(url.searchParams.get("scope")).toBe("mcp:tools")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      const [stateRow] = await withSystemDb("oauth-spec-state", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      expect(stateRow.issuer).toBe(fixture.issuer)
      expect(stateRow.resource).toBe(fixture.mcpUrl)
      expect(stateRow.scope).toBe("mcp:tools")
      expect(stateRow.issSupported).toBe(true)
    } finally {
      await fixture.close()
    }
  })

  it("start: with no challenge scope and no PRM scopes, no scope parameter is sent", async () => {
    fixture = await startOAuthMcpFixture({ challengeScope: null, prmScopesSupported: [] })
    try {
      const connId = await seed(fixture.mcpUrl)
      const { res } = await start(connId)
      const url = new URL(((await res.json()) as any).authorizationUrl)
      expect(url.searchParams.has("scope")).toBe(false)
    } finally {
      await fixture.close()
    }
  })

  it("start: a PRM naming another server is refused with the URL to use", async () => {
    fixture = await startOAuthMcpFixture({ prmResourceOverride: "https://mcp.example.com" })
    try {
      const connId = await seed(fixture.mcpUrl)
      const { res } = await start(connId)
      expect(res.status).toBe(502)
      expect(await res.text()).toContain("Use https://mcp.example.com")
    } finally {
      await fixture.close()
    }
  })

  it("callback: the code exchange sends resource, and tokens + expiry are persisted", async () => {
    fixture = await startOAuthMcpFixture({ accessTokenTtlSec: 120 })
    try {
      const connId = await seed(fixture.mcpUrl)
      const { res, cookie } = await start(connId)
      const cb = await consentAndReturn(((await res.json()) as any).authorizationUrl, cookie)
      expect(cb.status).toBe(302)
      const exchange = fixture.stats.tokenRequests.find(
        (r) => r.grant_type === "authorization_code",
      )
      expect(exchange?.resource).toBe(fixture.mcpUrl)
      const { conn, blob } = await storedBlob(connId)
      expect(blob.accessToken).toMatch(/^at-/)
      expect(blob.refreshToken).toMatch(/^rt-/)
      const meta = conn.oauthMetadata as any
      expect(meta.issuer).toBe(fixture.issuer)
      expect(meta.resource).toBe(fixture.mcpUrl)
      expect(meta.clientIdSource).toBe("dcr")
      expect(Date.parse(meta.expiresAt)).toBeGreaterThan(Date.now() + 60_000)
    } finally {
      await fixture.close()
    }
  })

  it("callback: a missing iss from an AS that advertises it is refused", async () => {
    fixture = await startOAuthMcpFixture({ issPolicy: "missing" })
    try {
      const connId = await seed(fixture.mcpUrl)
      const { res, cookie } = await start(connId)
      const cb = await consentAndReturn(((await res.json()) as any).authorizationUrl, cookie)
      expect(cb.status).toBe(400)
      expect(((await cb.json()) as any).error.code).toBe("iss_missing")
      expect(fixture.stats.authorizationCodeGrants).toBe(0)
      expect((await storedBlob(connId)).blob.accessToken).toBeUndefined()
    } finally {
      await fixture.close()
    }
  })

  it("callback: a wrong iss is refused (mix-up defence)", async () => {
    fixture = await startOAuthMcpFixture({ issPolicy: "wrong" })
    try {
      const connId = await seed(fixture.mcpUrl)
      const { res, cookie } = await start(connId)
      const cb = await consentAndReturn(((await res.json()) as any).authorizationUrl, cookie)
      expect(cb.status).toBe(400)
      expect(((await cb.json()) as any).error.code).toBe("iss_mismatch")
      expect(fixture.stats.authorizationCodeGrants).toBe(0)
    } finally {
      await fixture.close()
    }
  })

  it("callback errors are a readable page for a browser", async () => {
    fixture = await startOAuthMcpFixture({ issPolicy: "wrong" })
    try {
      const connId = await seed(fixture.mcpUrl)
      const { res, cookie } = await start(connId)
      const cb = await consentAndReturn(
        ((await res.json()) as any).authorizationUrl,
        cookie,
        "text/html,application/xhtml+xml",
      )
      expect(cb.status).toBe(400)
      expect(cb.headers.get("content-type") ?? "").toContain("text/html")
      const html = await cb.text()
      expect(html).toContain("<h1>Sign-in did not complete</h1>")
      expect(html).toContain("iss_mismatch")
      expect(html).not.toContain('{"error"')
    } finally {
      await fixture.close()
    }
  })

  it("a shell flow with a wrong iss is refused before anything is handed back to the shell", async () => {
    fixture = await startOAuthMcpFixture({ issPolicy: "wrong" })
    try {
      const connId = await seed(fixture.mcpUrl)
      const verifier = crypto.randomBytes(32).toString("base64url")
      const res = await appAs(world.admin).request(
        `/apps/mcp-manager/connections/${connId}/oauth/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "tauri://localhost" },
          body: JSON.stringify({
            client: "desktop",
            code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
            code_challenge_method: "S256",
            state: crypto.randomBytes(32).toString("base64url"),
          }),
        },
      )
      expect(res.status).toBe(200)
      const back = await fixture.authorize(((await res.json()) as any).authorizationUrl)
      const cb = await appAs(world.admin).request(`${CALLBACK}${back.search}`, { method: "GET" })
      expect(cb.status).toBe(400)
      expect(await cb.text()).not.toContain("liaison://oauth-complete")
    } finally {
      await fixture.close()
    }
  })

  async function pointAt(connId: string, httpUrl: string) {
    await withSystemDb("oauth-spec-repoint", (db) =>
      db.update(mcpConnections).set({ httpUrl }).where(eq(mcpConnections.id, connId)),
    )
  }

  it("an abandoned re-sign-in leaves the live token endpoint, client and secrets in place", async () => {
    fixture = await startOAuthMcpFixture({ accessTokenTtlSec: 120 })
    const other = await startOAuthMcpFixture()
    try {
      const connId = await seed(fixture.mcpUrl)
      const first = await start(connId)
      const cb = await consentAndReturn(
        ((await first.res.json()) as any).authorizationUrl,
        first.cookie,
      )
      expect(cb.status).toBe(302)
      const before = await storedBlob(connId)
      // The server now names another authorization server; "Sign in again" is
      // started there and abandoned.
      await pointAt(connId, other.mcpUrl)
      const again = await start(connId)
      expect(again.res.status).toBe(200)
      const after = await storedBlob(connId)
      expect(after.conn.oauthMetadata).toEqual(before.conn.oauthMetadata)
      expect((after.conn.oauthMetadata as any).tokenEndpoint).toBe(`${fixture.issuer}/token`)
      expect(after.conn.secretsEncrypted).toBe(before.conn.secretsEncrypted)
    } finally {
      await fixture.close()
      await other.close()
    }
  })

  it("the callback exchanges the code with the plan stored with ITS state (RFC 9207 mix-up)", async () => {
    fixture = await startOAuthMcpFixture({ accessTokenTtlSec: 120 })
    const other = await startOAuthMcpFixture({ accessTokenTtlSec: 120 })
    try {
      const connId = await seed(fixture.mcpUrl)
      const a = await start(connId)
      const aUrl = ((await a.res.json()) as any).authorizationUrl
      // A second sign-in starts against another AS before the first one returns.
      await pointAt(connId, other.mcpUrl)
      const b = await start(connId)
      expect(b.res.status).toBe(200)
      // Back at the first server's address (a sign-in for another address is
      // refused outright, see below): the newer start's plan must still not win.
      await pointAt(connId, fixture.mcpUrl)
      const cb = await consentAndReturn(aUrl, a.cookie)
      expect(cb.status).toBe(302)
      expect(fixture.stats.authorizationCodeGrants).toBe(1)
      expect(other.stats.tokenRequests).toEqual([])
      const { conn, blob } = await storedBlob(connId)
      expect((conn.oauthMetadata as any).tokenEndpoint).toBe(`${fixture.issuer}/token`)
      expect((conn.oauthMetadata as any).issuer).toBe(fixture.issuer)
      expect(blob.accessToken).toMatch(/^at-/)
    } finally {
      await fixture.close()
      await other.close()
    }
  })

  it("a sign-in started for one server address does not finish on a connection re-pointed elsewhere", async () => {
    fixture = await startOAuthMcpFixture({ accessTokenTtlSec: 120 })
    const other = await startOAuthMcpFixture({ accessTokenTtlSec: 120 })
    try {
      const connId = await seed(fixture.mcpUrl)
      const before = await storedBlob(connId)
      const a = await start(connId)
      const aUrl = ((await a.res.json()) as any).authorizationUrl
      await pointAt(connId, other.mcpUrl)
      const cb = await consentAndReturn(aUrl, a.cookie)
      expect(cb.status).toBe(409)
      expect(fixture.stats.authorizationCodeGrants).toBe(0)
      expect(other.stats.tokenRequests).toEqual([])
      const after = await storedBlob(connId)
      expect(after.conn.secretsEncrypted).toBe(before.conn.secretsEncrypted)
    } finally {
      await fixture.close()
      await other.close()
    }
  })

  it("start refuses, and keeps the stored secrets, when they cannot be decrypted", async () => {
    fixture = await startOAuthMcpFixture({
      registration: false,
      tokenEndpointAuthMethods: ["client_secret_post"],
    })
    try {
      const { encryptSecretsBlob } = await import("~/modules/mcp-client/secrets")
      const good = encryptSecretsBlob({ oauthClientId: "pre-1", oauthClientSecret: "s3cret" })
      // A blob written under another ENCRYPTION_KEY: same shape, unreadable here.
      const unreadable = `${good.slice(0, -6)}AAAAAA`
      const connId = await withSystemDb("oauth-spec-seed-unreadable", async (db) => {
        const [row] = await db
          .insert(mcpConnections)
          .values({
            orgId: world.org.id,
            slug: `bad-${crypto.randomUUID().slice(0, 6)}`,
            displayName: "Unreadable",
            transport: "http",
            httpUrl: fixture.mcpUrl,
            authFlavor: "oauth_static",
            oauthMetadata: { clientId: "pre-1" },
            secretsEncrypted: unreadable,
            createdBy: world.admin.userId,
          })
          .returning({ id: mcpConnections.id })
        return row.id
      })
      const { res } = await start(connId)
      expect(res.status).toBe(409)
      expect(((await res.json()) as any).error.code).toBe("secrets_unreadable")
      const [conn] = await withSystemDb("oauth-spec-unreadable-read", (db) =>
        db.select().from(mcpConnections).where(eq(mcpConnections.id, connId)),
      )
      expect(conn.secretsEncrypted).toBe(unreadable)
      const states = await withSystemDb("oauth-spec-unreadable-state", (db) =>
        db.select().from(mcpOAuthState).where(eq(mcpOAuthState.connectionId, connId)),
      )
      expect(states).toEqual([])
    } finally {
      await fixture.close()
    }
  })

  it("a pre-registered client signs in with its secret and never registers", async () => {
    fixture = await startOAuthMcpFixture({
      registration: false,
      tokenEndpointAuthMethods: ["client_secret_post"],
    })
    try {
      const { callbackUrl } = await import("./oauth-registration")
      fixture.addClient({
        clientId: "pre-1",
        clientSecret: "s3cret",
        authMethod: "client_secret_post",
        redirectUris: [callbackUrl()],
      })
      const connId = await withSystemDb("oauth-spec-seed-static", async (db) => {
        const { encryptSecretsBlob } = await import("~/modules/mcp-client/secrets")
        const [row] = await db
          .insert(mcpConnections)
          .values({
            orgId: world.org.id,
            slug: `pre-${crypto.randomUUID().slice(0, 6)}`,
            displayName: "Pre",
            transport: "http",
            httpUrl: fixture.mcpUrl,
            authFlavor: "oauth_static",
            oauthMetadata: { clientId: "pre-1" },
            secretsEncrypted: encryptSecretsBlob({
              oauthClientId: "pre-1",
              oauthClientSecret: "s3cret",
            }),
            createdBy: world.admin.userId,
          })
          .returning({ id: mcpConnections.id })
        return row.id
      })
      const { res, cookie } = await start(connId)
      expect(res.status).toBe(200)
      const cb = await consentAndReturn(((await res.json()) as any).authorizationUrl, cookie)
      expect(cb.status).toBe(302)
      expect(fixture.stats.registerCalls).toBe(0)
      const exchange = fixture.stats.tokenRequests.find(
        (r) => r.grant_type === "authorization_code",
      )
      expect(exchange?.client_secret).toBe("s3cret")
      expect((await storedBlob(connId)).blob.accessToken).toMatch(/^at-/)
    } finally {
      await fixture.close()
    }
  })
})

// ── T6: the add flow's probe ───────────────────────────────────────────────
describe("POST /probe", () => {
  let world: McpTestWorld
  let fixture: OAuthFixtureHandle | null = null
  const prevAllow = process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP
  beforeAll(async () => {
    await acquireTestLock()
    // The fixtures run on loopback; the same opt-in the e2e server uses.
    process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = "1"
  })
  afterAll(async () => {
    if (prevAllow === undefined) delete process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP
    else process.env.LIAISON_E2E_ALLOW_PRIVATE_MCP = prevAllow
    await releaseTestLock()
  })
  beforeEach(async () => {
    world = await buildMcpWorld()
  })

  const withErrors = (actor: UserContext) => appAs(actor).onError(errorHandler)
  async function probe(url: string) {
    const res = await withErrors(world.admin).request("/apps/mcp-manager/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
    return { status: res.status, body: (await res.json()) as any }
  }

  it("a DCR server: mode dcr, its resource, scopes, issuer and the exact callback URL", async () => {
    fixture = await startOAuthMcpFixture()
    try {
      const { status, body } = await probe(fixture.mcpUrl)
      expect(status).toBe(200)
      expect(body.data).toMatchObject({
        mode: "dcr",
        resource: fixture.mcpUrl,
        scopes: ["mcp:tools"],
        issuer: fixture.issuer,
        requiresClientSecret: false,
      })
      expect(body.data.callbackUrl).toMatch(/\/api\/apps\/mcp-manager\/oauth\/callback$/)
      // A probe registers nothing.
      expect(fixture.stats.registerCalls).toBe(0)
    } finally {
      await fixture.close()
    }
  })

  it("a server without DCR or CIMD: mode preregistered, needing a secret when the AS has no public clients", async () => {
    fixture = await startOAuthMcpFixture({
      registration: false,
      tokenEndpointAuthMethods: ["client_secret_post"],
    })
    try {
      const { body } = await probe(fixture.mcpUrl)
      expect(body.data).toMatchObject({ mode: "preregistered", requiresClientSecret: true })
    } finally {
      await fixture.close()
    }
  })

  it("an open server: mode none", async () => {
    const { startFixtureHttpMcpServer } = await import(
      "~/modules/mcp-client/transports/fixtures/http-mcp-server"
    )
    const open = await startFixtureHttpMcpServer()
    try {
      const { body } = await probe(open.url)
      expect(body.data.mode).toBe("none")
    } finally {
      await open.close()
    }
  })

  it("a 401 with no OAuth discovery: mode bearer", async () => {
    const { startFixtureHttpMcpServer } = await import(
      "~/modules/mcp-client/transports/fixtures/http-mcp-server"
    )
    const closed = await startFixtureHttpMcpServer({ alwaysReturn401: true })
    try {
      const { body } = await probe(closed.url)
      expect(body.data.mode).toBe("bearer")
    } finally {
      await closed.close()
    }
  })

  it("a PRM naming another server: 422 with the URL to use", async () => {
    fixture = await startOAuthMcpFixture({ prmResourceOverride: "https://mcp.example.com" })
    try {
      const { status, body } = await probe(fixture.mcpUrl)
      expect(status).toBe(422)
      expect(body.error.code).toBe("resource_mismatch")
      expect(body.error.message).toContain("Use https://mcp.example.com")
    } finally {
      await fixture.close()
    }
  })

  // Every active member holds `personal_connection:write` (manifest
  // `everyMemberScopes`), so a member with no role may probe: the probe is the
  // first step of adding their own personal server. Only a session that holds
  // neither write scope is refused, before the URL is even read.
  it("refuses a caller without connection write scope", async () => {
    const readOnly: UserContext = { ...world.bob, scopes: ["mcp_manager:connection:read"] }
    const res = await withErrors(readOnly).request("/apps/mcp-manager/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://mcp.example.com/mcp" }),
    })
    expect(res.status).toBe(403)
  })

  it("lets a member with no role probe (personal write comes with membership)", async () => {
    expect(world.bob.scopes).toContain("mcp_manager:personal_connection:write")
    const res = await withErrors(world.bob).request("/apps/mcp-manager/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Past the scope guard, an unusable URL is refused without any dial.
      body: JSON.stringify({ url: "not a url" }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_url")
  })
})
