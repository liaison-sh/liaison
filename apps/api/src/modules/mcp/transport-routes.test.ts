// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { orgRateLimiter } from "~/middleware/rate-limiter"
import { signAccessToken } from "~/modules/auth/jwt"
import { mintAccessToken } from "~/modules/mcp/connection-service"
import { ensureConnectionThread } from "~/modules/mcp/connection-thread"
import { mcpAuthMiddleware } from "~/modules/mcp/mcp-auth-middleware"
import {
  cleanupSeededOrg,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithUser,
} from "~/modules/mcp/test-helpers"
import { mcpTransport } from "~/modules/mcp/transport-routes"

function createTestApp() {
  const app = new Hono()
  app.use("/mcp", mcpAuthMiddleware)
  app.use("/mcp", orgRateLimiter(redis))
  app.route("/mcp", mcpTransport)
  return app
}

function initBody(id = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  })
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
}

describe("mcp transport", () => {
  let app: Hono
  const orgs: string[] = []

  beforeAll(() => {
    app = createTestApp()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) {
      await redis.del(`ratelimit:config:limit:${o}`)
      await cleanupSeededOrg(o)
    }
  })

  afterAll(async () => {
    // no-op
  })

  it("no Authorization → 401 with WWW-Authenticate metadata URL", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: initBody(),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource")
  })

  it("garbage bearer → 401", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: "Bearer not-a-jwt" },
      body: initBody(),
    })
    expect(res.status).toBe(401)
  })

  it("expired token → 401", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const conn = await seedMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    const expired = await signAccessToken(
      {
        userId,
        orgId,
        name: "mcp",
        authVersion: 1,
        permissionVersion: 1,
        mcpConnectionId: conn.id,
      },
      env.JWT_SECRET,
      -1, // already expired
    )
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${expired}` },
      body: initBody(),
    })
    expect(res.status).toBe(401)
  })

  it("valid token + initialize → JSON-RPC result", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const conn = await seedMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    const { token } = await mintAccessToken(conn.id)

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
      body: initBody(7),
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // The web transport may stream as SSE; the JSON-RPC payload is embedded.
    expect(text).toContain('"jsonrpc":"2.0"')
    expect(text).toContain('"id":7')
    expect(text).toContain('"result"')

    // Two sequential initializes both succeed (stateless, no affinity).
    const res2 = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
      body: initBody(8),
    })
    expect(res2.status).toBe(200)
  })

  it("a reconnect handshake (initialize) leaves the connection thread's mark as it is", async () => {
    // The transport is stateless: an `initialize` is any reconnect of the client, whose own
    // conversation may still hold the outside text it read. Nothing in it names a new one.
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const conn = await seedMcpConnection({ orgId, userId, clientId: "c", label: "L" })
    const threadId = await ensureConnectionThread(conn.id, orgId, userId)
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}`
    const { token } = await mintAccessToken(conn.id)
    const tainted = async () =>
      (await sql`SELECT tainted FROM kernel.threads WHERE id = ${threadId}`)[0].tainted
    const post = (body: string) =>
      app.request("/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
        body,
      })
    const inSession = await post(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }))
    expect(inSession.status).toBe(200)
    expect(await tainted()).toBe(true)
    const init = await post(initBody(4))
    expect(init.status).toBe(200)
    expect(await tainted()).toBe(true)
  })

  it("a handshake after the connection was quiet for hours starts unmarked; a first request that is not a handshake does not", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const conn = await seedMcpConnection({ orgId, userId, clientId: "c", label: "L" })
    const threadId = await ensureConnectionThread(conn.id, orgId, userId)
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}`
    const { token } = await mintAccessToken(conn.id)
    const tainted = async () =>
      (await sql`SELECT tainted FROM kernel.threads WHERE id = ${threadId}`)[0].tainted
    const post = (body: string) =>
      app.request("/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
        body,
      })
    // Quiet connection, first request is a plain call: the mark stays.
    await redis.del(`mcp:active:${conn.id}`)
    expect((await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }))).status).toBe(200)
    expect(await tainted()).toBe(true)
    // Quiet connection, first request is the handshake: a new conversation, unmarked.
    await redis.del(`mcp:active:${conn.id}`)
    expect((await post(initBody(2))).status).toBe(200)
    expect(await tainted()).toBe(false)
    // Marked again inside that conversation, a reconnect right after keeps it.
    await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${threadId}`
    expect((await post(initBody(3))).status).toBe(200)
    expect(await tainted()).toBe(true)
  })

  it("a connection bound to an agent carries that agent's owner skills whole in its instructions", async () => {
    // An MCP client has no per-turn system prompt: the connect instructions are where the
    // bound agent's `auto_attach.owner` playbooks must ride (third QA walk, @oracle).
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${userId}, ${orgId}, '*') ON CONFLICT DO NOTHING`
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["*"] })
    const { agentId: otherAgentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["*"] })
    await sql`INSERT INTO kernel.skills (org_id, owner_agent_id, name, description, body, auto_attach, created_by_actor_type)
      VALUES (${orgId}, ${agentId}, 'warehouse-procedure', 'How I read the warehouse',
              'OWNER_SKILL_BODY_MARKER population first, then the metric.', '{"owner":true}'::jsonb, 'user'),
             (${orgId}, ${otherAgentId}, 'other-procedure', 'Not mine',
              'OTHER_AGENT_BODY_MARKER', '{"owner":true}'::jsonb, 'user')`
    // Another person's PERSONAL skill on the same bound agent reaches only its author
    // (security review F2).
    const colleague = crypto.randomUUID()
    await sql`INSERT INTO kernel.users (id, org_id, email, name)
      VALUES (${colleague}, ${orgId}, ${`colleague-${colleague.slice(0, 8)}@test.com`}, 'Colleague')`
    await sql`INSERT INTO kernel.skills (org_id, owner_agent_id, name, description, body, auto_attach,
        author_user_id, created_by_actor_type)
      VALUES (${orgId}, ${agentId}, 'colleague-private', 'Theirs', 'COLLEAGUE_PERSONAL_BODY',
              '{"owner":true}'::jsonb, ${colleague}, 'user')`
    try {
      const bound = await seedMcpConnection({
        orgId,
        userId,
        clientId: "c",
        label: "Bound",
        agentId,
      })
      const { token } = await mintAccessToken(bound.id)
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
        body: initBody(11),
      })
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(text).toContain("OWNER_SKILL_BODY_MARKER")
      expect(text).not.toContain("OTHER_AGENT_BODY_MARKER")
      expect(text).not.toContain("COLLEAGUE_PERSONAL_BODY")

      // An unbound connection carries no agent's own playbook.
      const plain = await seedMcpConnection({ orgId, userId, clientId: "c", label: "Plain" })
      const plainToken = (await mintAccessToken(plain.id)).token
      const plainRes = await app.request("/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${plainToken}` },
        body: initBody(12),
      })
      expect(await plainRes.text()).not.toContain("OWNER_SKILL_BODY_MARKER")
    } finally {
      await sql`DELETE FROM kernel.agent_skill_index WHERE org_id = ${orgId}`.catch(() => {})
      await sql`DELETE FROM kernel.skills WHERE org_id = ${orgId}`
    }
  })

  it("valid token + per-org rate limit exceeded → 429 with Retry-After", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const conn = await seedMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    const { token } = await mintAccessToken(conn.id)
    // Drive the org limiter: configure a tiny limit for this org.
    await redis.set(`ratelimit:config:limit:${orgId}`, "1")

    let sawRateLimit = false
    for (let i = 0; i < 6; i++) {
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
        body: initBody(100 + i),
      })
      if (res.status === 429) {
        expect(res.headers.get("Retry-After")).toBeTruthy()
        sawRateLimit = true
        break
      }
    }
    expect(sawRateLimit).toBe(true)
  })

  it("revoked connection: client cannot refresh, and a stale token → transport 401 (criterion 8)", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const conn = await seedMcpConnection({ orgId, userId, clientId: "c", label: "L" })
    const { token } = await mintAccessToken(conn.id)
    // Pre-revoke token works on the transport.
    const ok = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
      body: initBody(1),
    })
    expect(ok.status).toBe(200)

    // Revoke, then the client tries to refresh (mint a fresh token) → blocked.
    const { revokeConnection } = await import("~/modules/mcp/connection-service")
    await revokeConnection(conn.id, userId)
    await expect(mintAccessToken(conn.id)).rejects.toThrow(/revoked|not found/i)

    // Once the pre-revoke token's 15-min TTL elapses the client has no valid
    // token (refresh is blocked above) — any token it can still present is
    // stale/expired → the transport returns 401. Asserts the criterion-8
    // guarantee deterministically without waiting out the real TTL.
    const stale = await signAccessToken(
      {
        userId,
        orgId,
        name: "mcp",
        authVersion: 1,
        permissionVersion: 1,
        mcpConnectionId: conn.id,
      },
      env.JWT_SECRET,
      -1,
    )
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${stale}` },
      body: initBody(2),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource")
  })

  it("transport refuses a request that bypassed mcpAuthMiddleware (P12-M4 defense-in-depth)", async () => {
    // Mount the transport WITHOUT the auth middleware — simulates a
    // trailing-slash / future-subpath / mount-order bypass.
    const bare = new Hono()
    bare.route("/mcp", mcpTransport)
    const res = await bare.request("/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: initBody(),
    })
    expect(res.status).toBe(401)
  })

  it("malformed JSON-RPC body → JSON-RPC error envelope, not a crash", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const conn = await seedMcpConnection({
      orgId,
      userId,
      clientId: "c",
      label: "L",
    })
    const { token } = await mintAccessToken(conn.id)
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
      body: "{ not valid json",
    })
    // Transport must not throw to the client; it returns an HTTP-level error
    // or a JSON-RPC error envelope (never a 5xx unhandled crash).
    expect(res.status).toBeLessThan(500)
  })
})
