// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { seedMcpConnection } from "~/modules/mcp/test-helpers"

const ORG = "00000000-0000-4000-d000-00000000d001"
const OWNER = "00000000-0000-4000-d000-00000000d002"
const OTHER = "00000000-0000-4000-d000-00000000d003"

async function tokenFor(userId: string) {
  return signAccessToken(
    { userId, orgId: ORG, name: "U", authVersion: 1, permissionVersion: 1 },
    env.JWT_SECRET,
  )
}

describe("mcp wire-in (assembled app)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'MCP Wire Org', 'mcp-wire') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${OWNER}, ${ORG}, 'mcp-wire-owner@test.com', 'Owner', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${OTHER}, ${ORG}, 'mcp-wire-other@test.com', 'Other', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("/.well-known/oauth-authorization-server is mounted at root → 200", async () => {
    const res = await app.request("/.well-known/oauth-authorization-server")
    expect(res.status).toBe(200)
  })

  it("POST /mcp without auth → 401 + WWW-Authenticate", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.get("WWW-Authenticate")).toContain("/.well-known/oauth-protected-resource")
  })

  it("GET /api/mcp/connections is owner-scoped", async () => {
    const ownerConn = await seedMcpConnection({
      orgId: ORG,
      userId: OWNER,
      clientId: "c",
      label: "Owner Conn",
    })
    await seedMcpConnection({
      orgId: ORG,
      userId: OTHER,
      clientId: "c",
      label: "Other Conn",
    })
    const res = await app.request("/api/mcp/connections", {
      headers: { Authorization: `Bearer ${await tokenFor(OWNER)}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Array<{ id: string; label: string }> }
    const ids = body.data.map((d) => d.id)
    expect(ids).toContain(ownerConn.id)
    expect(body.data.every((d) => d.label !== "Other Conn")).toBe(true)
  })

  it("DELETE /api/mcp/connections/:id owner → 200; non-owner → 404, row untouched", async () => {
    const conn = await seedMcpConnection({
      orgId: ORG,
      userId: OWNER,
      clientId: "c",
      label: "Revoke Me",
    })
    const asOther = await app.request(`/api/mcp/connections/${conn.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await tokenFor(OTHER)}` },
    })
    expect(asOther.status).toBe(404)
    const stillActive =
      await sql`SELECT revoked_at FROM kernel.mcp_connections WHERE id = ${conn.id}`
    expect(stillActive[0].revoked_at).toBeNull()

    const asOwner = await app.request(`/api/mcp/connections/${conn.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await tokenFor(OWNER)}` },
    })
    expect(asOwner.status).toBe(200)
    const revoked = await sql`SELECT revoked_at FROM kernel.mcp_connections WHERE id = ${conn.id}`
    expect(revoked[0].revoked_at).not.toBeNull()
  })
})
