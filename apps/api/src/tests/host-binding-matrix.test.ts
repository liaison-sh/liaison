// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Host binding matrix (lib/org-host.ts). With LIAISON_ORG_HOST_TEMPLATE set,
// each org is served on its own host: a credential of org A is refused on B's
// host, on every path that verifies one, and a host that names no org serves
// only the control API, health, diagnostics and webhooks. Each managed row has a
// self-hosted counterpart (template unset) that proves behaviour is unchanged.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import * as jose from "jose"
import { app } from "~/app"
import { sql } from "~/db"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { WebSocketManager } from "~/infra/websocket"
import { hashToken } from "~/lib/crypto"
import { env } from "~/lib/env"
import { bindingCookie } from "~/lib/oauth-browser-binding"
import { forgetOrgHostCache } from "~/lib/org-host"
import { redis } from "~/lib/redis"
import { hostOnlyCookies } from "~/lib/response"
import { createServer, type WsData } from "~/lib/server"
import { CONNECT_BINDING_COOKIE } from "~/modules/apps/connections/service"
import { signUiBundleToken, verifyUiBundleToken } from "~/modules/apps/ui-bundle-token"
import { oauthStateCookieSpec } from "~/modules/auth/oauth-routes"
import { consumeWsTicket } from "~/modules/auth/ws-ticket"
import { signFileDownloadToken } from "~/modules/files/service"
import { createMcpConnection, mintAccessToken } from "~/modules/mcp/connection-service"
import { seedInvitationRow, seedPasswordResetRow } from "~/seed/factories/org/rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const TEMPLATE = "https://{slug}.example.com"

interface Tenant {
  user: minimal.Person
  bearer: string
  slug: string
  host: string
  origin: string
}

let A: Tenant
let B: Tenant
const savedTemplate = env.LIAISON_ORG_HOST_TEMPLATE

function managed() {
  env.LIAISON_ORG_HOST_TEMPLATE = TEMPLATE
  forgetOrgHostCache()
}
function selfHosted() {
  env.LIAISON_ORG_HOST_TEMPLATE = undefined
}

/** A request as it reaches the app on `host`. */
function on(host: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("host", host)
  return app.request(`http://${host}${path}`, { ...init, headers })
}

/** The first tenant comes from the test bootstrap (which truncates); the second from the minimal seed tier. */
async function tenant(first: boolean): Promise<Tenant> {
  const orgId = first
    ? (await createTestOrg()).id
    : (await minimal.secondOrg({ name: "Host binding B" })).orgId
  const user = await minimal.orgAdmin(orgId)
  const [org] = await sql<{ slug: string }[]>`
    SELECT slug FROM kernel.organizations WHERE id = ${user.orgId}`
  const slug = org!.slug
  return {
    user,
    bearer: await minimal.token(user.id),
    slug,
    host: `${slug}.example.com`,
    origin: `https://${slug}.example.com`,
  }
}

beforeAll(async () => {
  await acquireTestLock()
  A = await tenant(true)
  B = await tenant(false)
})

afterEach(() => {
  env.LIAISON_ORG_HOST_TEMPLATE = savedTemplate
})

afterAll(async () => {
  env.LIAISON_ORG_HOST_TEMPLATE = savedTemplate
  await releaseTestLock()
})

const bearer = (t: Tenant) => ({ authorization: `Bearer ${t.bearer}` })

describe("auth middleware (session JWT)", () => {
  it("managed: A's token works on A's host, is 401 on B's host", async () => {
    managed()
    expect((await on(A.host, "/api/auth/totp/status", { headers: bearer(A) })).status).toBe(200)
    expect((await on(B.host, "/api/auth/totp/status", { headers: bearer(A) })).status).toBe(401)
  })
  it("self-hosted: the token works on any host", async () => {
    selfHosted()
    expect(
      (await on("localhost:3000", "/api/auth/totp/status", { headers: bearer(A) })).status,
    ).toBe(200)
    expect((await on(B.host, "/api/auth/totp/status", { headers: bearer(A) })).status).toBe(200)
  })
})

describe("MCP connection token", () => {
  let token: string
  beforeAll(async () => {
    const { connection } = await createMcpConnection({
      orgId: A.user.orgId,
      userId: A.user.id,
      clientId: "host-binding-test",
      label: "host binding",
    })
    token = (await mintAccessToken(connection.id)).token
  })
  const call = (host: string) =>
    on(host, "/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    })
  it("managed: 401 on B's host with B's own metadata URL; accepted on A's host", async () => {
    managed()
    const foreign = await call(B.host)
    expect(foreign.status).toBe(401)
    expect(foreign.headers.get("www-authenticate")).toContain(
      `${B.origin}/.well-known/oauth-protected-resource`,
    )
    expect((await call(A.host)).status).not.toBe(401)
  })
  it("self-hosted: accepted on any host", async () => {
    selfHosted()
    expect((await call(B.host)).status).not.toBe(401)
  })
})

describe("file download token", () => {
  const url = async () =>
    `/api/file-relay-dl/${await signFileDownloadToken({
      orgId: A.user.orgId,
      fileId: randomUUID(),
      storageKey: `${A.user.orgId}/nothing`,
      filename: "x.txt",
      mimeType: "text/plain",
    })}`
  it("managed: 401 on B's host; verified on A's host (the file is gone: 404)", async () => {
    managed()
    expect((await on(B.host, await url())).status).toBe(401)
    expect((await on(A.host, await url())).status).toBe(404)
  })
  it("self-hosted: verified on any host", async () => {
    selfHosted()
    expect((await on(B.host, await url())).status).toBe(404)
  })
})

describe("org export download token", () => {
  const url = async () =>
    `/api/org-export-dl/${await new jose.SignJWT({
      orgId: A.user.orgId,
      exportId: randomUUID(),
      objectKey: "exports/none.zip",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setAudience("org-export-download")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(new TextEncoder().encode(env.JWT_SECRET))}`
  it("managed: 401 on B's host; verified on A's host (no such export: 404)", async () => {
    managed()
    expect((await on(B.host, await url())).status).toBe(401)
    expect((await on(A.host, await url())).status).toBe(404)
  })
  it("self-hosted: verified on any host", async () => {
    selfHosted()
    expect((await on(B.host, await url())).status).toBe(404)
  })
})

describe("UI bundle token", () => {
  it("managed: a token handed out on A's host loads on A's host only", async () => {
    const t = await signUiBundleToken("some-app", "1.0.0", A.host)
    expect(await verifyUiBundleToken(t, "some-app", "1.0.0", A.host)).toBe(true)
    expect(await verifyUiBundleToken(t, "some-app", "1.0.0", B.host)).toBe(false)
    // A token without a host never loads under binding.
    const unbound = await signUiBundleToken("some-app", "1.0.0")
    expect(await verifyUiBundleToken(unbound, "some-app", "1.0.0", A.host)).toBe(false)
  })
  it("self-hosted: no host in play", async () => {
    const t = await signUiBundleToken("some-app", "1.0.0")
    expect(await verifyUiBundleToken(t, "some-app", "1.0.0")).toBe(true)
  })
})

describe("OAuth routes", () => {
  it("managed: sign-in provider list takes the org from the host; a disagreeing slug is 400", async () => {
    managed()
    expect((await on(A.host, "/api/auth/oauth/providers")).status).toBe(200)
    expect((await on(A.host, `/api/auth/oauth/providers?orgSlug=${B.slug}`)).status).toBe(400)
  })
  it("self-hosted: the query slug is honoured", async () => {
    selfHosted()
    expect((await on("localhost:3000", `/api/auth/oauth/providers?orgSlug=${B.slug}`)).status).toBe(
      200,
    )
  })

  async function plantExchange(t: Tenant): Promise<string> {
    const code = randomBytes(16).toString("hex")
    await redis.set(
      `oauth:exchange:${code}`,
      JSON.stringify({ accessToken: t.bearer, refreshToken: "unused" }),
      "EX",
      60,
    )
    return code
  }
  const exchange = (host: string, code: string) =>
    on(host, "/api/auth/oauth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    })
  it("managed: an OAuth sign-in code of A is redeemed on A's host only", async () => {
    managed()
    expect((await exchange(B.host, await plantExchange(A))).status).toBe(401)
    expect((await exchange(A.host, await plantExchange(A))).status).toBe(200)
  })
  it("self-hosted: redeemed on any host", async () => {
    selfHosted()
    expect((await exchange(B.host, await plantExchange(A))).status).toBe(200)
  })

  async function plantConnectState(t: Tenant): Promise<string> {
    const state = randomBytes(16).toString("hex")
    await redis.set(
      `oauth:state:${state}`,
      JSON.stringify({
        orgId: t.user.orgId,
        userId: t.user.id,
        appName: "host-binding-test-app",
        connectionName: "x",
        codeVerifier: "v",
        tokenUrl: "https://provider.invalid/token",
      }),
      "EX",
      60,
    )
    return state
  }
  const callback = async (host: string, state: string) =>
    (await on(host, `/api/connections/callback?code=c&state=${state}`)).headers.get("location") ??
    ""
  it("managed: a connector callback of A completes on A's host only", async () => {
    managed()
    expect(await callback(B.host, await plantConnectState(A))).toContain("oauth_browser_mismatch")
    expect(await callback(A.host, await plantConnectState(A))).not.toContain(
      "oauth_browser_mismatch",
    )
  })
  it("self-hosted: the callback is not host-bound", async () => {
    selfHosted()
    expect(await callback(B.host, await plantConnectState(A))).not.toContain(
      "oauth_browser_mismatch",
    )
  })
})

describe("sign-in takes the org from the host", () => {
  const login = (host: string, body: Record<string, string>) =>
    on(host, "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: A.user.email, password: "Passw0rd!", ...body }),
    })
  it("managed: login on A's host signs into A; on B's host it finds no account", async () => {
    managed()
    const ok = await login(A.host, {})
    expect(ok.status).toBe(200)
    // Every cookie a managed cell sets is __Host-.
    const cookies = ok.headers.getSetCookie()
    expect(cookies.length).toBeGreaterThan(0)
    for (const cookie of cookies) expect(cookie.startsWith("__Host-")).toBe(true)
    expect((await login(B.host, {})).status).toBe(401)
  })
  it("managed: a body orgSlug that disagrees with the host is 400", async () => {
    managed()
    expect((await login(A.host, { orgSlug: B.slug })).status).toBe(400)
    const reset = await on(A.host, "/api/auth/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: A.user.email, orgSlug: B.slug }),
    })
    expect(reset.status).toBe(400)
  })
  it("self-hosted: the body slug decides, cookies keep their names", async () => {
    selfHosted()
    const res = await login("localhost:3000", { orgSlug: A.slug })
    expect(res.status).toBe(200)
    for (const cookie of res.headers.getSetCookie())
      expect(cookie.startsWith("__Host-")).toBe(false)
  })
})

describe("cookies", () => {
  it("managed: the connect-state and OAuth-state cookies are __Host-", () => {
    managed()
    expect(hostOnlyCookies()).toBe(true)
    expect(bindingCookie(CONNECT_BINDING_COOKIE, "/api/connections/callback").name).toStartWith(
      "__Host-",
    )
    expect(oauthStateCookieSpec(hostOnlyCookies()).name).toStartWith("__Host-")
  })
  it("self-hosted (test, http): unchanged plain names", () => {
    selfHosted()
    expect(hostOnlyCookies()).toBe(false)
    expect(bindingCookie(CONNECT_BINDING_COOKIE, "/api/connections/callback").name).toBe(
      CONNECT_BINDING_COOKIE,
    )
  })
})

describe("refresh", () => {
  async function refreshTokenOf(t: Tenant): Promise<string> {
    managed()
    const res = await on(t.host, "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: t.user.email, password: "Passw0rd!" }),
    })
    const body = (await res.json()) as { data: { refreshToken: string } }
    return body.data.refreshToken
  }
  const refresh = (host: string, token: string, origin?: string) =>
    on(host, "/api/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ refreshToken: token }),
    })
  it("managed: A's refresh token is refused on B's host and still works on A's", async () => {
    const token = await refreshTokenOf(A)
    expect((await refresh(B.host, token)).status).toBe(401)
    expect((await refresh(A.host, token)).status).toBe(200)
  })
  it("managed: a refresh from another tenant's origin is refused", async () => {
    const token = await refreshTokenOf(A)
    expect((await refresh(A.host, token, B.origin)).status).toBe(403)
    expect((await refresh(A.host, token, A.origin)).status).toBe(200)
  })
  it("self-hosted: any origin, any host", async () => {
    const token = await refreshTokenOf(A)
    selfHosted()
    expect((await refresh(B.host, token, B.origin)).status).toBe(200)
  })
})

describe("CORS", () => {
  const preflight = (host: string, origin: string) =>
    on(host, "/api/auth/refresh", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST" },
    })
  it("managed: only the request's own org origin is allowed", async () => {
    managed()
    expect((await preflight(A.host, A.origin)).headers.get("access-control-allow-origin")).toBe(
      A.origin,
    )
    expect(
      (await preflight(A.host, B.origin)).headers.get("access-control-allow-origin"),
    ).toBeNull()
    expect(
      (await preflight(A.host, "http://localhost:5173")).headers.get("access-control-allow-origin"),
    ).toBeNull()
  })
  it("self-hosted: the configured allowlist, as before", async () => {
    selfHosted()
    expect(
      (await preflight("localhost:3000", "http://localhost:5173")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("http://localhost:5173")
  })
})

describe("non-org hosts", () => {
  const gated = async (host: string, path: string) => {
    const res = await on(host, path)
    if (res.status !== 404) return false
    const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
    return body?.error?.code === "HOST_NOT_ORG"
  }
  for (const host of [
    "cell-1.example.com",
    "cell-1-origin.example.com",
    "localhost:3000",
    "10.0.0.5",
  ]) {
    it(`managed: ${host} refuses org routes`, async () => {
      managed()
      expect(await gated(host, "/api/auth/bootstrap-state")).toBe(true)
      expect(await gated(host, "/.well-known/oauth-protected-resource")).toBe(true)
      expect((await on(host, "/api/auth/totp/status", { headers: bearer(A) })).status).toBe(404)
    })
    it(`managed: ${host} serves control, health, diagnostics and webhooks`, async () => {
      managed()
      for (const path of ["/api/cloud/orgs", "/healthz", "/readyz", "/diag", "/webhooks/x/y"]) {
        expect(await gated(host, path)).toBe(false)
      }
    })
  }
  it("self-hosted: loopback serves everything", async () => {
    selfHosted()
    expect((await on("localhost:3000", "/api/auth/bootstrap-state")).status).toBe(200)
  })
})

describe("MCP metadata takes its base from the host", () => {
  it("managed: the org host", async () => {
    managed()
    const res = await on(A.host, "/.well-known/oauth-protected-resource")
    expect(((await res.json()) as { resource: string }).resource).toBe(A.origin)
  })
  it("self-hosted: BASE_URL", async () => {
    selfHosted()
    const res = await on("localhost:3000", "/.well-known/oauth-protected-resource")
    expect(((await res.json()) as { resource: string }).resource).toBe(env.BASE_URL)
  })
})

describe("WebSocket ticket", () => {
  let server: Server<WsData>
  const sockets: WebSocket[] = []
  beforeAll(async () => {
    const instanceId = `host-binding-test-${randomUUID()}`
    await redis.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", 60_000)
    const manager = new WebSocketManager(redis, undefined, { instanceId })
    server = await createServer(app, {
      port: 0,
      wsManager: manager,
      publicDir: "/nonexistent",
      onUpgrade: async (req) => {
        const ticket = new URL(req.url).searchParams.get("ticket")
        const payload = ticket ? await consumeWsTicket(redis, ticket, req) : null
        return payload ? { ...payload, authorized: true } : null
      },
    })
  })
  afterAll(() => {
    for (const ws of sockets) ws.close()
    server?.stop(true)
  })
  async function ticketOn(host: string, t: Tenant): Promise<string> {
    const res = await on(host, "/api/auth/ws-ticket", { method: "POST", headers: bearer(t) })
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: { ticket: string } }).data.ticket
  }
  /** The close code, or 0 when the socket is still open after a moment. */
  function openOn(host: string, ticket: string): Promise<number> {
    // Bun's WebSocket client takes extra headers, Host included.
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?ticket=${ticket}`, {
      headers: { host },
    } as unknown as string[])
    sockets.push(ws)
    return new Promise((resolve) => {
      ws.onclose = (ev) => resolve(ev.code)
      setTimeout(() => resolve(0), 1500)
    })
  }
  it("managed: a ticket minted on A's host closes 4001 on B's host", async () => {
    managed()
    expect(await openOn(B.host, await ticketOn(A.host, A))).toBe(4001)
  })
  it("managed: and opens on A's host", async () => {
    managed()
    expect(await openOn(A.host, await ticketOn(A.host, A))).toBe(0)
  })
  it("self-hosted: the ticket opens on any host", async () => {
    selfHosted()
    expect(await openOn(B.host, await ticketOn("localhost:3000", A))).toBe(0)
  })
})

describe("the bundled web app (static serving before the app)", () => {
  let server: Server<WsData>
  let publicDir: string
  beforeAll(async () => {
    publicDir = mkdtempSync(join(tmpdir(), "liaison-host-binding-public-"))
    writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>shell</title>")
    writeFileSync(join(publicDir, "favicon.svg"), "<svg/>")
    server = await createServer(app, {
      port: 0,
      wsManager: new WebSocketManager(redis, undefined, {
        instanceId: `host-binding-static-${randomUUID()}`,
      }),
      publicDir,
    })
  })
  afterAll(() => {
    server?.stop(true)
    rmSync(publicDir, { recursive: true, force: true })
  })
  const get = (host: string, path: string) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { host } })
  for (const host of ["cell-1-origin.example.com", "10.0.0.5"]) {
    it(`managed: ${host} serves neither the shell nor its files`, async () => {
      managed()
      for (const path of ["/", "/settings", "/favicon.svg"]) {
        const res = await get(host, path)
        expect(res.status).toBe(404)
        expect(await res.text()).not.toContain("<title>shell</title>")
      }
      expect((await get(host, "/healthz")).status).not.toBe(404)
    })
  }
  it("managed: an org host serves the shell", async () => {
    managed()
    const res = await get(A.host, "/settings")
    expect(res.status).toBe(200)
    expect(await res.text()).toContain("<title>shell</title>")
  })
  it("self-hosted: any host serves the shell", async () => {
    selfHosted()
    expect((await get("10.0.0.5", "/")).status).toBe(200)
  })
})

describe("a host/slug mismatch at sign-in spends no password allowance", () => {
  it("managed: the 400 counts no failed attempt for the account", async () => {
    managed()
    const email = A.user.email.toLowerCase()
    await redis.del(`bruteforce:account:password:${email}`, `bruteforce:email:${email}`)
    for (let i = 0; i < 3; i++) {
      const res = await on(A.host, "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "wrong-password", orgSlug: B.slug }),
      })
      expect(res.status).toBe(400)
    }
    expect(await redis.get(`bruteforce:account:password:${email}`)).toBeNull()
    expect(await redis.get(`bruteforce:email:${email}`)).toBeNull()
  })
})

describe("invitation and password-reset tokens", () => {
  async function invite(t: Tenant): Promise<string> {
    const token = randomBytes(24).toString("hex")
    const [role] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.roles WHERE org_id = ${t.user.orgId} LIMIT 1`
    await seedInvitationRow({
      orgId: t.user.orgId,
      email: `invitee-${randomBytes(4).toString("hex")}@example.test`,
      roleId: role!.id,
      tokenHash: hashToken(token),
      invitedBy: t.user.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    })
    return token
  }
  async function resetToken(t: Tenant): Promise<string> {
    const token = randomBytes(24).toString("hex")
    await seedPasswordResetRow({
      userId: t.user.id,
      orgId: t.user.orgId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    return token
  }
  const register = (host: string, token: string) =>
    on(host, "/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inviteToken: token, password: "An0ther-Passw0rd!", name: "Invitee" }),
    })
  const confirm = (host: string, token: string) =>
    on(host, "/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: "Passw0rd!" }),
    })
  it("managed: A's invitation is invalid on B's host and is not spent there", async () => {
    managed()
    const token = await invite(A)
    expect((await on(B.host, `/api/auth/invites/${token}/validate`)).status).toBe(404)
    const refused = await register(B.host, token)
    expect(refused.status).toBe(400)
    expect(refused.headers.getSetCookie()).toHaveLength(0)
    expect((await on(A.host, `/api/auth/invites/${token}/validate`)).status).toBe(200)
    expect((await register(A.host, token)).status).toBe(200)
  })
  it("managed: A's reset token is refused on B's host and still works on A's", async () => {
    managed()
    const token = await resetToken(A)
    expect((await confirm(B.host, token)).status).toBe(400)
    expect((await confirm(A.host, token)).status).toBe(200)
  })
  it("self-hosted: both work on any host", async () => {
    selfHosted()
    expect((await on(B.host, `/api/auth/invites/${await invite(A)}/validate`)).status).toBe(200)
    expect((await confirm(B.host, await resetToken(A))).status).toBe(200)
  })
})
