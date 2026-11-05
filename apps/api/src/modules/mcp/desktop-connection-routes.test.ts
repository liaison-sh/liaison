// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { sql } from "~/db"
import { signAccessToken } from "~/modules/auth/jwt"

const TEST_SECRET = "test-secret-at-least-32-chars-long!!"
const ORG = "00000000-0000-4000-b000-00000000d001"
const USER = "00000000-0000-4000-b000-00000000d002"
const ROLE = "00000000-0000-4000-b000-00000000d003"
const AGENT = "00000000-0000-4000-b000-00000000d010"
const FOREIGN_ORG = "00000000-0000-4000-b000-00000000d020"
const FOREIGN_AGENT = "00000000-0000-4000-b000-00000000d021"

async function createTestApp() {
  const { mcpDesktopConnection } = await import("~/modules/mcp/desktop-connection-routes")
  const { mcpOAuth } = await import("~/modules/mcp/oauth-server-routes")
  const { authMiddleware } = await import("~/middleware/auth")
  const app = new Hono()
  app.use("/mcp/desktop/*", authMiddleware(TEST_SECRET))
  app.route("/mcp/desktop", mcpDesktopConnection)
  app.route("/mcp/oauth", mcpOAuth)
  return app
}

describe("mcp desktop connection from the signed in session", () => {
  let app: Hono
  let userToken: string

  beforeAll(async () => {
    for (const [id, slug] of [
      [ORG, "mcp-desktop"],
      [FOREIGN_ORG, "mcp-desktop-foreign"],
    ]) {
      await sql`INSERT INTO kernel.organizations (id, name, slug)
        VALUES (${id}, ${slug}, ${slug}) ON CONFLICT (id) DO NOTHING`
    }
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${USER}, ${ORG}, 'mcp-desktop@test.com', 'Desktop User', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${ROLE}, ${ORG}, 'mdc-admin', 'mcp desktop admin') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${ROLE}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${USER}, ${ROLE}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'role', '@mcp-desktop-agent', 'Desktop Agent', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${FOREIGN_AGENT}, ${FOREIGN_ORG}, 'role', '@mcp-desktop-foreign', 'Foreign', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    app = await createTestApp()
    userToken = await signAccessToken(
      { userId: USER, orgId: ORG, name: "Desktop User", authVersion: 1, permissionVersion: 1 },
      TEST_SECRET,
    )
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE id IN (${AGENT}, ${FOREIGN_AGENT})`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE id = ${ROLE}`
    await sql`DELETE FROM kernel.users WHERE id = ${USER}`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${FOREIGN_ORG})`
  })

  function connect(bearer: string | null, agentId: string) {
    return app.request("/mcp/desktop/connection", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ agentId }),
    })
  }

  it("the signed in user gets an agent bound connection with no device approval", async () => {
    const res = await connect(userToken, AGENT)
    expect(res.status).toBe(200)
    const body = ((await res.json()) as any).data
    expect(body.accessToken).toBeTruthy()
    expect(body.refreshToken).toBeTruthy()
    const conns = await sql<{ agent_id: string | null; client_id: string }[]>`
      SELECT agent_id, client_id FROM kernel.mcp_connections WHERE user_id = ${USER}`
    expect(conns.length).toBe(1)
    expect(conns[0].agent_id).toBe(AGENT)
    expect(conns[0].client_id).toBe("liaison-desktop")
    const claims = JSON.parse(Buffer.from(body.accessToken.split(".")[1], "base64url").toString())
    expect(claims.agentId).toBe(AGENT)
  })

  it("its refresh token renews through the ordinary token route", async () => {
    const body = ((await (await connect(userToken, AGENT)).json()) as any).data
    const res = await app.request("/mcp/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: body.refreshToken,
      }).toString(),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).access_token).toBeTruthy()
  })

  it("an anonymous caller is refused", async () => {
    expect((await connect(null, AGENT)).status).toBe(401)
  })

  it("an MCP token cannot mint a connection for another agent", async () => {
    const mcp = ((await (await connect(userToken, AGENT)).json()) as any).data.accessToken
    expect((await connect(mcp, AGENT)).status).toBe(401)
    const conns = await sql`SELECT id FROM kernel.mcp_connections WHERE user_id = ${USER}`
    expect(conns.length).toBe(1)
  })

  it("an agent of another org is refused and nothing is created", async () => {
    expect((await connect(userToken, FOREIGN_AGENT)).status).toBe(400)
    const conns = await sql`SELECT id FROM kernel.mcp_connections WHERE user_id = ${USER}`
    expect(conns.length).toBe(0)
  })

  it("another member's personal agent, the system agent and the caller's own personal agent", async () => {
    const other = "00000000-0000-4000-b000-00000000d030"
    const othersPersonal = "00000000-0000-4000-b000-00000000d031"
    const system = "00000000-0000-4000-b000-00000000d032"
    const ownPersonal = "00000000-0000-4000-b000-00000000d033"
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${other}, ${ORG}, 'mcp-desktop-other@test.com', 'Other', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${othersPersonal}, ${ORG}, 'personal', '@mcp-desktop-others', 'Others', '[]'::jsonb, ${other}),
             (${ownPersonal}, ${ORG}, 'personal', '@mcp-desktop-own', 'Own', '[]'::jsonb, ${USER})
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${system}, ${ORG}, 'system', '@mcp-desktop-system', 'System', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    try {
      // Not an agent this person may act as: refused, and nothing is created.
      expect((await connect(userToken, othersPersonal)).status).toBe(400)
      expect((await connect(userToken, system)).status).toBe(400)
      expect(
        (await sql`SELECT id FROM kernel.mcp_connections WHERE user_id = ${USER}`).length,
      ).toBe(0)
      // Their own personal agent is theirs to run.
      expect((await connect(userToken, ownPersonal)).status).toBe(200)
    } finally {
      await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE id IN (${othersPersonal}, ${system}, ${ownPersonal})`
      await sql`DELETE FROM kernel.users WHERE id = ${other}`
    }
  })
})
