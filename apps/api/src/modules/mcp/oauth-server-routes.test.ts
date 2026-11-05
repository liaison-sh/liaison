// SPDX-License-Identifier: FSL-1.1-ALv2

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { mcpOauthClients } from "~/db/schema/kernel"
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { signAccessToken } from "~/modules/auth/jwt"
import { stepUpCodeKey } from "~/modules/auth/step-up"

const TEST_SECRET = "test-secret-at-least-32-chars-long!!"
const ORG = "00000000-0000-4000-a000-00000000a001"
const USER = "00000000-0000-4000-a000-00000000a002"

async function createTestApp() {
  const { mcpOAuth, mcpOAuthWellKnown } = await import("~/modules/mcp/oauth-server-routes")
  const { authMiddleware } = await import("~/middleware/auth")
  const app = new Hono()
  // Mirror app.ts: GET /authorize is the PUBLIC consent page; code issuance
  // (POST /authorize/consent) is behind authMiddleware.
  app.use("/mcp/oauth/authorize/consent", authMiddleware(TEST_SECRET))
  app.route("/.well-known", mcpOAuthWellKnown)
  app.route("/mcp/oauth", mcpOAuth)
  return app
}

/**
 * The headers + body of a full-access approval: a fresh emailed step-up code,
 * as `/api/auth/totp/step-up` stores it (full-access-consent-step-up.test.ts
 * covers the refusal without one).
 */
async function withStepUp(token: string): Promise<RequestInit> {
  const code = String(100000 + Math.floor(Math.random() * 900000))
  await redis.set(stepUpCodeKey(USER, "mcp_connect"), hashToken(code), "EX", 600)
  return {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ stepUpCode: code }),
  }
}

function pkce() {
  const verifier = randomBytes(32).toString("hex")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

describe("mcp oauth server", () => {
  let app: Hono
  let webToken: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'MCP OAuth Org', 'mcp-oauth') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${USER}, ${ORG}, 'mcp-oauth@test.com', 'OAuth User', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
    app = await createTestApp()
    webToken = await signAccessToken(
      { userId: USER, orgId: ORG, name: "OAuth User", authVersion: 1, permissionVersion: 1 },
      TEST_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.mcp_oauth_clients WHERE client_name LIKE 'OAuthTest%'`
    await sql`DELETE FROM kernel.users WHERE id = ${USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  async function registerClient(redirectUris = ["https://client.example/cb"]) {
    const res = await app.request("/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "OAuthTest Client", redirect_uris: redirectUris }),
    })
    expect(res.status).toBe(201)
    return (await res.json()) as { client_id: string }
  }

  it("serves protected-resource metadata", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource")
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.resource).toBeTruthy()
    expect(Array.isArray(body.authorization_servers)).toBe(true)
  })

  it("serves authorization-server metadata", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server")
    const body: any = await res.json()
    expect(body.authorization_endpoint).toContain("/mcp/oauth/authorize")
    expect(body.token_endpoint).toContain("/mcp/oauth/token")
    expect(body.registration_endpoint).toContain("/mcp/oauth/register")
    expect(body.device_authorization_endpoint).toContain("/mcp/device")
    expect(body.grant_types_supported).toContain("authorization_code")
    expect(body.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:device_code")
    expect(body.code_challenge_methods_supported).toContain("S256")
  })

  it("serves /.well-known/mcp", async () => {
    const res = await app.request("/.well-known/mcp")
    const body: any = await res.json()
    expect(body.transport).toBeTruthy()
    expect(body.auth_methods).toBeTruthy()
  })

  it("DCR creates a client; invalid metadata 400", async () => {
    const { client_id } = await registerClient()
    const [row] = await withSystemDb("t", (db) =>
      db.select().from(mcpOauthClients).where(eq(mcpOauthClients.clientId, client_id)),
    )
    expect(row).toBeTruthy()
    const bad = await app.request("/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x" }),
    })
    expect(bad.status).toBe(400)
  })

  // ---- dynamic client registration rules -----------------------------------
  async function register(body: Record<string, unknown>) {
    return app.request("/mcp/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  }

  it("DCR refuses script schemes and plain http to a remote host, and stores a bounded name", async () => {
    for (const uri of [
      "javascript:alert(1)",
      "data:text/html,x",
      "http://evil.example/cb",
      "https://client.example/cb#frag",
    ]) {
      expect((await register({ client_name: "OAuthTest bad", redirect_uris: [uri] })).status).toBe(
        400,
      )
    }
    // Allowed: https, loopback http, an app scheme.
    for (const uri of ["http://localhost:8123/cb", "http://127.0.0.1/cb", "cursor://auth/cb"]) {
      expect((await register({ client_name: "OAuthTest ok", redirect_uris: [uri] })).status).toBe(
        201,
      )
    }
    const long = await register({
      client_name: `OAuthTest ${"x".repeat(500)}\n\u0007`,
      redirect_uris: ["https://client.example/cb"],
    })
    const body = (await long.json()) as { client_name: string }
    expect(body.client_name.length).toBeLessThanOrEqual(100)
    expect([...body.client_name].every((ch) => ch.charCodeAt(0) >= 32)).toBe(true)
  })

  it("a client stored before the redirect rule cannot use a URI the rule now refuses", async () => {
    const legacyId = crypto.randomUUID()
    await sql`INSERT INTO kernel.mcp_oauth_clients (client_id, client_name, redirect_uris)
      VALUES (${legacyId}, 'OAuthTest legacy', ARRAY[${"http://legacy.example/cb"}]::text[])`
    const res = await app.request(
      `/mcp/oauth/authorize?response_type=code&client_id=${legacyId}&redirect_uri=${encodeURIComponent("http://legacy.example/cb")}&code_challenge=abc&code_challenge_method=S256`,
    )
    expect(res.status).toBe(400)
  })

  it("the consent page marks the name unverified and shows the redirect host", async () => {
    const reg = await register({
      client_name: "OAuthTest Claude (official)",
      redirect_uris: ["https://phish.example/cb"],
    })
    const { client_id } = (await reg.json()) as { client_id: string }
    const res = await app.request(
      `/mcp/oauth/authorize?response_type=code&client_id=${client_id}&redirect_uri=${encodeURIComponent("https://phish.example/cb")}&code_challenge=abc&code_challenge_method=S256`,
    )
    const html = await res.text()
    expect(html).toContain("Unverified application")
    expect(html).toContain('id="dest">phish.example<')
  })

  function authorizeQuery(
    clientId: string,
    challenge: string,
    state = "xyz",
    cb = "https://client.example/cb",
  ) {
    return `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(cb)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`
  }

  it("GET /authorize renders a consent page and issues NO code (B3)", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const res = await app.request(`/mcp/oauth/authorize?${authorizeQuery(client_id, challenge)}`, {
      redirect: "manual",
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const html = await res.text()
    // Consent page shows the requesting client + an explicit approve action.
    expect(html).toContain("OAuthTest Client")
    expect(html.toLowerCase()).toContain("approve")
    // No redirect, no code anywhere in the response.
    expect(res.headers.get("location")).toBeNull()
    expect(html).not.toContain("code=")
  })

  it("GET /authorize loads its script externally under CSP script-src 'self' (no inline script)", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const res = await app.request(`/mcp/oauth/authorize?${authorizeQuery(client_id, challenge)}`, {
      redirect: "manual",
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    // The page references its button wiring via an external same-origin script,
    // so it loads under `script-src 'self'` (security-headers.ts). It must NOT
    // contain an inline <script> body (CSP would block it in a real browser).
    // Its URL carries a hash of the script, so a release that changes the
    // script changes the URL and no browser runs a cached older copy.
    expect(html).toMatch(/<script src="\/mcp\/oauth\/authorize\.js\?v=[0-9a-f]{16}"><\/script>/)
    // No inline script: every <script ...> tag must carry a `src=` attribute.
    const scriptOpenTags = html.match(/<script\b[^>]*>/g) ?? []
    expect(scriptOpenTags.length).toBe(1)
    for (const tag of scriptOpenTags) expect(tag).toContain("src=")
  })

  it("GET /authorize.js serves the static wiring as application/javascript", async () => {
    const res = await app.request("/mcp/oauth/authorize.js", { redirect: "manual" })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/javascript")
    const js = await res.text()
    // The wiring reads the OAuth params from the card's data-* attributes (no
    // per-request interpolation) and posts to the consent endpoint.
    expect(js).toContain("card.dataset")
    expect(js).toContain("/mcp/oauth/authorize/consent")
    // Static: it must not embed any request-derived value.
    expect(js).not.toContain("client_id=")
  })

  it("GET /authorize.js is immutable only at the URL the page references", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const page = await app.request(`/mcp/oauth/authorize?${authorizeQuery(client_id, challenge)}`, {
      redirect: "manual",
    })
    const src = (await page.text()).match(/<script src="([^"]+)"/)?.[1]
    expect(src).toMatch(/^\/mcp\/oauth\/authorize\.js\?v=[0-9a-f]{16}$/)
    const versioned = await app.request(src as string)
    expect(versioned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    // An old page's bare URL, or a stale version, never gets a cacheable copy.
    const bare = await app.request("/mcp/oauth/authorize.js")
    expect(bare.headers.get("cache-control")).toBe("no-store")
    const stale = await app.request("/mcp/oauth/authorize.js?v=0000000000000000")
    expect(stale.headers.get("cache-control")).toBe("no-store")
    expect(await stale.text()).toBe(await versioned.text())
  })

  // The app tab and this consent page refresh with the same cookie at once (the
  // personal MCP wizard opens the page right after a permission change). The
  // loser gets 409 REFRESH_RACE with the rotated cookie left in place: the page
  // retries once and completes, instead of "make sure you are signed in".
  it("authorize.js retries a 409 refresh once and still completes the consent", async () => {
    const js = await (await app.request("/mcp/oauth/authorize.js")).text()
    const calls: string[] = []
    const responses = [
      new Response(JSON.stringify({ error: { code: "REFRESH_RACE" } }), { status: 409 }),
      new Response(JSON.stringify({ data: { accessToken: "tok" } }), { status: 200 }),
      new Response(JSON.stringify({ redirect: "https://client.example/cb?code=x" }), {
        status: 200,
      }),
    ]
    const fetchStub = async (url: string) => {
      calls.push(url.split("?")[0] as string)
      return responses.shift() as Response
    }
    const el = () => ({ onclick: null, style: {}, dataset: {} as Record<string, string> })
    const nodes: Record<string, ReturnType<typeof el>> = {
      consent: el(),
      deny: el(),
      approve: el(),
      err: el(),
    }
    const documentStub = {
      getElementById: (id: string) => nodes[id],
      readyState: "complete",
      addEventListener: (_e: string, cb: () => void) => cb(),
    }
    const windowStub = { location: { href: "" } }
    new Function("document", "fetch", "window", "setTimeout", js)(
      documentStub,
      fetchStub,
      windowStub,
      (cb: () => void) => cb(),
    )
    for (let i = 0; i < 20 && windowStub.location.href === ""; i++) await Bun.sleep(5)
    expect(calls).toEqual([
      "/api/auth/refresh",
      "/api/auth/refresh",
      "/mcp/oauth/authorize/consent",
    ])
    expect(windowStub.location.href).toBe("https://client.example/cb?code=x")
  })

  // Full access takes a step-up: the page sends the emailed code (never a
  // password) with the approval, and a refused proof is shown on the step-up block, not
  // as "make sure you are signed in".
  it("authorize.js sends the step-up proof with a full-access approval and reports a refused one", async () => {
    const js = await (await app.request("/mcp/oauth/authorize.js")).text()
    const approvals: Array<string | undefined> = []
    let accept = false
    const fetchStub = async (url: string, init?: { body?: string }) => {
      if (url.startsWith("/api/auth/refresh")) {
        return new Response(JSON.stringify({ data: { accessToken: "tok" } }), { status: 200 })
      }
      if (url.includes("consent=auto")) {
        return new Response(JSON.stringify({ error: "consent_required" }), { status: 403 })
      }
      if (url.startsWith("/api/auth/totp/step-up")) {
        return new Response(JSON.stringify({ data: { sent: true, retryAfterSeconds: 60 } }), {
          status: 200,
        })
      }
      approvals.push(init?.body)
      if (!accept) {
        return new Response(
          JSON.stringify({ error: { message: "Invalid or expired step-up code" } }),
          { status: 422 },
        )
      }
      return new Response(JSON.stringify({ redirect: "https://client.example/cb?code=y" }), {
        status: 200,
      })
    }
    const el = (extra: Record<string, unknown> = {}) => ({
      onclick: null as null | (() => void),
      onchange: null,
      disabled: false,
      style: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      value: "",
      textContent: "",
      checked: false,
      focus: () => {},
      ...extra,
    })
    const nodes: Record<string, ReturnType<typeof el>> = {
      consent: el(),
      deny: el(),
      approve: el(),
      err: el(),
      ack: el({ checked: true }),
      stepup: el(),
      code: el(),
      resend: el(),
      sent: el(),
      wait: el(),
      senderr: el(),
      steperr: el(),
    }
    const windowStub = { location: { href: "" } }
    new Function("document", "fetch", "window", "setTimeout", js)(
      { getElementById: (id: string) => nodes[id] },
      fetchStub,
      windowStub,
      () => {},
    )
    const click = () => (nodes.approve.onclick as unknown as () => void).call(nodes.approve)
    // The page emailed the code by itself once the silent re-consent was refused.
    for (let i = 0; i < 20 && nodes.sent.style.display !== "block"; i++) await Bun.sleep(5)
    expect(nodes.sent.style.display).toBe("block")

    // No proof: refused on the page, nothing sent.
    click()
    expect(approvals).toEqual([])
    expect(nodes.steperr.style.display).toBe("block")

    // A wrong code: sent, refused, shown on the step-up block.
    nodes.code.value = "111111"
    click()
    for (let i = 0; i < 20 && approvals.length < 1; i++) await Bun.sleep(5)
    await Bun.sleep(10)
    expect(JSON.parse(approvals[0]!)).toEqual({ stepUpCode: "111111" })
    expect(nodes.steperr.style.display).toBe("block")
    expect(nodes.err.style.display).not.toBe("block")

    // The right code: approved.
    accept = true
    nodes.code.value = "222222"
    click()
    for (let i = 0; i < 20 && windowStub.location.href === ""; i++) await Bun.sleep(5)
    expect(JSON.parse(approvals[1]!)).toEqual({ stepUpCode: "222222" })
    expect(windowStub.location.href).toBe("https://client.example/cb?code=y")
  })

  it("GET /authorize escapes reflected params — no <script> breakout (XSS)", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    // Attacker-controlled `state` attempting to break out of the page.
    const evil = '"></div><script>alert(document.cookie)</script>'
    const res = await app.request(
      `/mcp/oauth/authorize?${authorizeQuery(client_id, challenge, encodeURIComponent(evil))}`,
      { redirect: "manual" },
    )
    expect(res.status).toBe(200)
    const html = await res.text()
    // The only <script> tag in the document is the external-src one; the
    // injected inline <script> must NOT survive (it is escaped at the
    // data-* attribute sink via escapeHtml).
    const scriptOpenTags = html.match(/<script\b[^>]*>/g) ?? []
    expect(scriptOpenTags.length).toBe(1)
    expect(scriptOpenTags[0]).toContain("src=")
    expect(html).not.toContain("<script>alert(document.cookie)</script>")
    // The payload survives only as escaped text inside the data-state attribute.
    expect(html).toContain("&lt;script&gt;")
  })

  it("GET /authorize rejects an oversized state (reflected-payload abuse)", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const huge = "a".repeat(1025)
    const res = await app.request(
      `/mcp/oauth/authorize?${authorizeQuery(client_id, challenge, huge)}`,
      { redirect: "manual" },
    )
    expect(res.status).toBe(400)
  })

  it("POST /authorize/consent with consent=approve issues code+state (B3)", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge)}&consent=approve&ack=full`,
      await withStepUp(webToken),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirect: string }
    const loc = new URL(body.redirect)
    expect(loc.searchParams.get("code")).toBeTruthy()
    expect(loc.searchParams.get("state")).toBe("xyz")
  })

  it("POST /authorize/consent without consent=approve issues NO code (B3)", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge)}`,
      { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("invalid_request")
  })

  it("consent=auto without a prior connection is rejected (consent_required)", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge)}&consent=auto`,
      { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error?: string }
    expect(body.error).toBe("consent_required")
  })

  it("consent=auto with a live prior connection silently issues a code", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    // The user previously approved this client: a non-revoked connection exists.
    await sql`INSERT INTO kernel.mcp_connections (id, org_id, user_id, client_id, label, refresh_token_hash)
      VALUES (gen_random_uuid(), ${ORG}, ${USER}, ${client_id}, 'OAuthTest Conn', 'test-hash')`
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge)}&consent=auto`,
      { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirect: string }
    expect(new URL(body.redirect).searchParams.get("code")).toBeTruthy()

    // A REVOKED prior connection must not auto-consent.
    await sql`UPDATE kernel.mcp_connections SET revoked_at = now() WHERE client_id = ${client_id}`
    const { challenge: challenge2 } = pkce()
    const res2 = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge2)}&consent=auto`,
      { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
    )
    expect(res2.status).toBe(403)
  })

  it("consent=auto only re-issues the binding the person approved before", async () => {
    const agentId = "00000000-0000-4000-a000-00000000a011"
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${agentId}, ${ORG}, 'role', '@mcp-auto-agent', 'Auto Agent', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    try {
      const { client_id } = await registerClient()
      // Approved before, bound to an agent (narrow, no full-access acknowledgement).
      await sql`INSERT INTO kernel.mcp_connections (id, org_id, user_id, client_id, label, refresh_token_hash, agent_id)
        VALUES (gen_random_uuid(), ${ORG}, ${USER}, ${client_id}, 'OAuthTest Bound', 'test-hash', ${agentId})`
      const consent = (extra: string) =>
        app.request(
          `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, pkce().challenge)}&consent=auto${extra}`,
          { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
        )
      // The same binding reconnects silently.
      expect((await consent(`&agent_id=${agentId}`)).status).toBe(200)
      // An unbound (full access) connection was never approved: no silent code.
      const unbound = await consent("")
      expect(unbound.status).toBe(403)
      expect(((await unbound.json()) as { error?: string }).error).toBe("consent_required")
    } finally {
      await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
  })

  it("consent cannot bind a connection to another member's personal agent or to the system agent", async () => {
    const other = "00000000-0000-4000-a000-00000000a030"
    const personal = "00000000-0000-4000-a000-00000000a031"
    const system = "00000000-0000-4000-a000-00000000a032"
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${other}, ${ORG}, 'mcp-oauth-other@test.com', 'Other User', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${personal}, ${ORG}, 'personal', '@mcp-other-personal', 'Other Personal', '[]'::jsonb, ${other})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${system}, ${ORG}, 'system', '@mcp-oauth-system', 'System', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    try {
      const { client_id } = await registerClient()
      for (const agentId of [personal, system]) {
        const res = await app.request(
          `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, pkce().challenge)}&consent=approve&agent_id=${agentId}`,
          { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
        )
        expect(res.status).toBe(400)
        expect(((await res.json()) as { redirect?: string }).redirect).toBeUndefined()
      }
    } finally {
      await sql`DELETE FROM kernel.agents WHERE id IN (${personal}, ${system})`
      await sql`DELETE FROM kernel.users WHERE id = ${other}`
    }
  })

  it("POST /authorize/consent with consent=deny → access_denied redirect, no code (B3)", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge)}&consent=deny`,
      { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { redirect: string }
    const loc = new URL(body.redirect)
    expect(loc.searchParams.get("error")).toBe("access_denied")
    expect(loc.searchParams.get("code")).toBeNull()
  })

  it("authorize consent unregistered client → invalid_client", async () => {
    const { challenge } = pkce()
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery("nope", challenge)}&consent=approve&ack=full`,
      { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe("invalid_client")
  })

  it("authorize consent unauthenticated → 401, no code (B3)", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge)}&consent=approve&ack=full`,
      { method: "POST", redirect: "manual" },
    )
    expect(res.status).toBe(401)
  })

  it("authorize consent rejects unregistered redirect_uri", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge, "s", "https://evil.example/cb")}&consent=approve&ack=full`,
      { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
    )
    expect(res.status).toBe(400)
  })

  it("approving an application bound to no agent needs the full-access acknowledgement", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge)}&consent=approve`,
      { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
    )
    expect(res.status).toBe(400)
    expect(((await res.json()) as { redirect?: string }).redirect).toBeUndefined()
  })

  it("the consent page shows the acknowledgement only for an unbound application", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const unbound = await app.request(
      `/mcp/oauth/authorize?${authorizeQuery(client_id, challenge)}`,
    )
    const unboundHtml = await unbound.text()
    expect(unboundHtml).toContain('id="ack"')
    // ...and the step-up the server requires for it (an emailed code only).
    expect(unboundHtml).toContain('id="stepup"')
    const bound = await app.request(
      `/mcp/oauth/authorize?${authorizeQuery(client_id, challenge)}&agent_id=${crypto.randomUUID()}`,
    )
    const boundHtml = await bound.text()
    expect(boundHtml).not.toContain('id="ack"')
    expect(boundHtml).not.toContain('id="stepup"')
  })

  async function getCode(clientId: string, challenge: string, agentId?: string) {
    const res = await app.request(
      `/mcp/oauth/authorize/consent?${authorizeQuery(clientId, challenge, "s")}&consent=approve&ack=full${
        agentId ? `&agent_id=${agentId}` : ""
      }`,
      agentId
        ? { method: "POST", headers: { Authorization: `Bearer ${webToken}` } }
        : await withStepUp(webToken),
    )
    const body = (await res.json()) as { redirect: string }
    return new URL(body.redirect).searchParams.get("code")!
  }

  async function exchange(clientId: string, verifier: string, code: string) {
    return app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: "https://client.example/cb",
      }).toString(),
    })
  }

  it("authorization-code exchange with an agentId creates an agent bound mcp connection", async () => {
    const agentId = "00000000-0000-4000-a000-00000000a010"
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${agentId}, ${ORG}, 'role', '@mcp-oauth-agent', 'OAuth Agent', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    try {
      const { client_id } = await registerClient()
      const { verifier, challenge } = pkce()
      const code = await getCode(client_id, challenge, agentId)
      const res = await exchange(client_id, verifier, code)
      expect(res.status).toBe(200)

      const conns = await sql<{ agent_id: string | null }[]>`
        SELECT agent_id FROM kernel.mcp_connections
        WHERE org_id = ${ORG} AND client_id = ${client_id}`
      expect(conns.length).toBe(1)
      expect(conns[0].agent_id).toBe(agentId)
    } finally {
      await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
  })

  it("authorization-code consent with an agentId from another org is rejected", async () => {
    const foreignOrg = "00000000-0000-4000-a000-00000000a020"
    const foreignAgent = "00000000-0000-4000-a000-00000000a021"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${foreignOrg}, 'Other OAuth Org', 'other-oauth-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${foreignAgent}, ${foreignOrg}, 'role', '@foreign-oauth-agent', 'Foreign', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    try {
      const { client_id } = await registerClient()
      const { challenge } = pkce()
      const res = await app.request(
        `/mcp/oauth/authorize/consent?${authorizeQuery(client_id, challenge, "s")}&consent=approve&agent_id=${foreignAgent}`,
        { method: "POST", headers: { Authorization: `Bearer ${webToken}` } },
      )
      expect(res.status).toBe(400)
      // No code was issued at all, so nothing can be exchanged for a connection
      // carrying the grantor's full scopes.
      const body = (await res.json()) as { redirect?: string; error?: string }
      expect(body.redirect).toBeUndefined()
      expect(body.error).toBe("invalid_request")

      const conns = await sql`SELECT * FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      expect(conns.length).toBe(0)
    } finally {
      await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE id = ${foreignAgent}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${foreignOrg}`
    }
  })

  it("token (auth code + PKCE) mints an mcp connection + access token", async () => {
    const { client_id } = await registerClient()
    const { verifier, challenge } = pkce()
    const code = await getCode(client_id, challenge)
    const res = await app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id,
        redirect_uri: "https://client.example/cb",
      }).toString(),
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.token_type).toBe("Bearer")
    expect(body.expires_in).toBe(900)
    expect(body.access_token).toBeTruthy()
    const conns =
      await sql`SELECT * FROM kernel.mcp_connections WHERE org_id = ${ORG} AND client_id = ${client_id}`
    expect(conns.length).toBe(1)
    expect(conns[0].label).toBe("OAuthTest Client")
  })

  it("token PKCE mismatch → invalid_grant", async () => {
    const { client_id } = await registerClient()
    const { challenge } = pkce()
    const code = await getCode(client_id, challenge)
    const res = await app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "wrong-verifier",
        client_id,
        redirect_uri: "https://client.example/cb",
      }).toString(),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe("invalid_grant")
  })

  it("token redirect_uri mismatch → invalid_grant (N7)", async () => {
    const { client_id } = await registerClient()
    const { verifier, challenge } = pkce()
    const code = await getCode(client_id, challenge)
    const res = await app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id,
        redirect_uri: "https://client.example/OTHER",
      }).toString(),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe("invalid_grant")
  })

  it("token replayed code → invalid_grant", async () => {
    const { client_id } = await registerClient()
    const { verifier, challenge } = pkce()
    const code = await getCode(client_id, challenge)
    const form = () =>
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id,
        redirect_uri: "https://client.example/cb",
      }).toString()
    const first = await app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form(),
    })
    expect(first.status).toBe(200)
    const second = await app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form(),
    })
    expect(second.status).toBe(400)
    expect(((await second.json()) as any).error).toBe("invalid_grant")
  })

  it("concurrent token exchanges for the same code → exactly one succeeds (atomic single-consume)", async () => {
    const { client_id } = await registerClient()
    const { verifier, challenge } = pkce()
    const code = await getCode(client_id, challenge)
    const form = () =>
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id,
        redirect_uri: "https://client.example/cb",
      }).toString()
    const fire = () =>
      app.request("/mcp/oauth/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form(),
      })
    const results = await Promise.all([fire(), fire(), fire(), fire()])
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s === 400)).toHaveLength(3)
  })

  it("token unknown code → invalid_grant", async () => {
    const { client_id } = await registerClient()
    const res = await app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: "does-not-exist",
        code_verifier: "x",
        client_id,
      }).toString(),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as any).error).toBe("invalid_grant")
  })
})
