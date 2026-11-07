// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { forgetOrgApps } from "~/modules/apps/org-apps"
import { clearOrgBillingStatusCache } from "~/modules/cloud/billing-status"
import { createMcpConnection, mintAccessToken } from "~/modules/mcp/connection-service"
import { mcpAuthMiddleware } from "~/modules/mcp/mcp-auth-middleware"
import {
  cleanupSeededOrg,
  grantScope,
  seedAgentForOrg,
  seedOrgWithUser,
} from "~/modules/mcp/test-helpers"
import { seedOrgBillingState } from "~/seed/factories/billing/billing"

// A throwaway route behind the real middleware, echoing back the request
// context the middleware populated. The agent binding must reach the Hono
// context so the transport can hand it to the server factory.
function createProbeApp() {
  const app = new Hono<AppEnv>()
  app.use("/probe", mcpAuthMiddleware)
  app.get("/probe", (c) =>
    c.json({
      mcpAgentId: c.get("mcpAgentId") ?? null,
      mcpConnectionId: c.get("mcpConnectionId") ?? null,
    }),
  )
  return app
}

describe("mcpAuthMiddleware agent binding", () => {
  const orgs: string[] = []

  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  it("sets mcpAgentId from an agent bound token", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    await grantScope(orgId, userId, "kernel:threads:read")
    const { agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["kernel:threads:read"] })
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "claude-code",
      label: "Claude Code",
      agentId,
    })
    const { token } = await mintAccessToken(connection.id)

    const res = await createProbeApp().request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mcpAgentId: string | null; mcpConnectionId: string | null }
    expect(body.mcpAgentId).toBe(agentId)
    expect(body.mcpConnectionId).toBe(connection.id)
  }, 30_000)

  it("leaves mcpAgentId undefined for a legacy token", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    const { token } = await mintAccessToken(connection.id)

    const res = await createProbeApp().request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { mcpAgentId: string | null }
    expect(body.mcpAgentId).toBeNull()
  }, 30_000)
})

describe("mcpAuthMiddleware downstream errors", () => {
  const orgs: string[] = []
  afterEach(async () => {
    for (const o of orgs.splice(0)) await cleanupSeededOrg(o)
  })

  // next() used to sit inside the auth try/catch, so a 429 from the limiter
  // behind it (or any transport fault) came back as a 401 re-authentication challenge.
  it("lets a downstream 429 and a downstream fault through as themselves, not as 401", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    const { token } = await mintAccessToken(connection.id)
    const app = new Hono<AppEnv>()
    app.use("/limited", mcpAuthMiddleware)
    app.get("/limited", () => {
      throw new HTTPException(429, { message: "Too many requests" })
    })
    app.use("/broken", mcpAuthMiddleware)
    app.get("/broken", () => {
      throw new HTTPException(503, { message: "transport down" })
    })
    const headers = { Authorization: `Bearer ${token}` }
    const limited = await app.request("/limited", { headers })
    expect(limited.status).toBe(429)
    expect(limited.headers.get("www-authenticate")).toBeNull()
    expect((await app.request("/broken", { headers })).status).toBe(503)
    // A bad token is still a 401 challenge.
    const bad = await app.request("/limited", { headers: { Authorization: "Bearer nope" } })
    expect(bad.status).toBe(401)
    expect(bad.headers.get("www-authenticate")).toContain("resource_metadata")
  }, 30_000)
})

// An org whose deletion has started serves nothing more (S2.5): the MCP
// transport, mounted in the real app with its error handler, answers 410
// ORG_DELETED, not a JSON-RPC error or a 401 re-authentication challenge.
describe("mcpAuthMiddleware: an org being deleted", () => {
  const orgs: string[] = []
  afterEach(async () => {
    for (const o of orgs.splice(0)) {
      await sql`UPDATE kernel.organizations SET deleting_at = NULL WHERE id = ${o}`
      forgetOrgApps(o)
      await cleanupSeededOrg(o)
    }
  })

  it("answers 410 ORG_DELETED on the transport once deleting_at is set", async () => {
    const { app } = await import("~/app")
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    const { token } = await mintAccessToken(connection.id)
    await sql`UPDATE kernel.organizations SET deleting_at = now() WHERE id = ${orgId}`
    forgetOrgApps(orgId)
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    })
    expect(res.status).toBe(410)
    expect(res.headers.get("www-authenticate")).toBeNull()
    const body = (await res.json()) as { error: { code?: string } }
    expect(body.error.code).toBe("ORG_DELETED")
  }, 30_000)
})

// A managed org suspended or closed for billing (cloud/suspension.ts): its MCP
// token is refused 403 `org_suspended` (not a 401 that restarts sign-in), and
// no new token is minted. Self-hosted, the same row changes nothing.
describe("mcpAuthMiddleware: suspended org (managed)", () => {
  const orgs: string[] = []

  afterEach(async () => {
    _setEdition(null)
    clearOrgBillingStatusCache()
    for (const o of orgs.splice(0)) {
      await sql`DELETE FROM kernel.org_billing_state WHERE org_id = ${o}`
      await cleanupSeededOrg(o)
    }
  })

  it("refuses the token and the mint while suspended; self-hosted unaffected", async () => {
    const { orgId, userId } = await seedOrgWithUser()
    orgs.push(orgId)
    const { connection } = await createMcpConnection({
      orgId,
      userId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    const { token } = await mintAccessToken(connection.id)
    await seedOrgBillingState(orgId, {
      plan: "base",
      status: "suspended",
      includedCredits: 0,
      accessUntil: new Date(Date.now() + 20 * 86_400_000),
    })

    _setEdition("managed")
    clearOrgBillingStatusCache()
    const res = await createProbeApp().request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(403)
    await expect(mintAccessToken(connection.id)).rejects.toThrow("mcp org suspended")

    _setEdition("self_hosted")
    clearOrgBillingStatusCache()
    const served = await createProbeApp().request("/probe", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(served.status).toBe(200)
  }, 30_000)
})
