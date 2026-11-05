// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `./_device-grant-test-env` MUST be the first import: it populates
// DEVICE_FLOW_CLIENTS before `~/db` (→ `~/lib/env`) eager-parses the env, so the
// route's import-time `ALLOWED_CLIENTS` allow-list is non-empty under the Strobe
// runner (which does not load `.env.test`). Without it every test 403s.
import "./_device-grant-test-env"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { sql } from "~/db"
import { hashToken } from "~/lib/crypto"
import { redis } from "~/lib/redis"
import { signAccessToken } from "~/modules/auth/jwt"
import { stepUpCodeKey } from "~/modules/auth/step-up"
import { agentBindingKey } from "~/modules/mcp/device-grant-routes"

const TEST_SECRET = "test-secret-at-least-32-chars-long!!"
const PLACEHOLDER_ORG_ID = "00000000-0000-0000-0000-000000000000"
const ORG = "00000000-0000-4000-b000-00000000b001"
const USER = "00000000-0000-4000-b000-00000000b002"
const ROLE = "00000000-0000-4000-b000-00000000b003"

async function createTestApp() {
  const { mcpDeviceGrant } = await import("~/modules/mcp/device-grant-routes")
  const { deviceFlow } = await import("~/modules/auth/device-flow-routes")
  const { authMiddleware } = await import("~/middleware/auth")
  const app = new Hono()
  app.use("/api/auth/device-flow/approve/*", authMiddleware(TEST_SECRET))
  app.route("/api/auth/device-flow", deviceFlow)
  app.route("/mcp/device", mcpDeviceGrant)
  return app
}

/**
 * An approval body confirming full access, with the fresh emailed step-up code
 * a grant bound to no agent needs (full-access-consent-step-up.test.ts covers
 * the refusal without one). A grant bound to an agent ignores the code.
 */
async function fullAccessBody() {
  const code = String(100000 + Math.floor(Math.random() * 900000))
  await redis.set(stepUpCodeKey(USER, "mcp_connect"), hashToken(code), "EX", 600)
  return { confirmFullAccess: true, stepUpCode: code }
}

async function json(res: Response) {
  return (await res.json()) as any
}

describe("mcp device grant", () => {
  let app: Hono
  let token: string

  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${PLACEHOLDER_ORG_ID}, 'Placeholder Org', 'placeholder') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'MCP Device Org', 'mcp-device') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version)
      VALUES (${USER}, ${ORG}, 'mcp-device@test.com', 'Device User', 'active', 1)
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.roles (id, org_id, name, description)
      VALUES (${ROLE}, ${ORG}, 'md-admin', 'mcp device admin') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope)
      VALUES (${ROLE}, 'kernel') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
      VALUES (${USER}, ${ROLE}, ${ORG}) ON CONFLICT DO NOTHING`
    app = await createTestApp()
    token = await signAccessToken(
      { userId: USER, orgId: ORG, name: "Device User", authVersion: 1, permissionVersion: 1 },
      TEST_SECRET,
    )
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.device_flow_requests WHERE client_id LIKE 'mcp:%'`
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.device_flow_requests WHERE client_id LIKE 'mcp:%'`
    await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE id = ${ROLE}`
    await sql`DELETE FROM kernel.users WHERE id = ${USER}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  async function userCodeFor(deviceCode: string): Promise<string> {
    const [row] = await sql<{ user_code: string }[]>`
      SELECT user_code FROM kernel.device_flow_requests WHERE device_code = ${deviceCode}`
    return row!.user_code
  }

  async function initiate(agentId?: string) {
    const res = await app.request("/mcp/device/initiate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "claude-code", ...(agentId ? { agentId } : {}) }),
    })
    expect(res.status).toBe(200)
    return (await json(res)).data as {
      deviceCode: string
      userCode: string
      verificationUri: string
      expiresIn: number
    }
  }

  it("initiate returns deviceCode/userCode/verificationUri/expiresIn", async () => {
    const d = await initiate()
    expect(d.deviceCode).toBeTruthy()
    expect(d.userCode).toBeTruthy()
    expect(d.verificationUri).toContain(d.userCode)
    expect(d.expiresIn).toBe(900)
  })

  it("poll while pending → authorization_pending", async () => {
    const d = await initiate()
    const res = await app.request(`/mcp/device/poll/${d.deviceCode}?client_id=claude-code`)
    expect((await json(res)).data.status).toBe("authorization_pending")
  })

  it("approve via existing device-flow then poll → approved + mcp_connections row, NO session", async () => {
    const d = await initiate()
    const ap = await app.request(`/api/auth/device-flow/approve/${d.userCode}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(await fullAccessBody()),
    })
    expect(ap.status).toBe(200)

    const sessionsBefore =
      await sql`SELECT count(*)::int AS n FROM kernel.sessions WHERE user_id = ${USER}`

    const res = await app.request(`/mcp/device/poll/${d.deviceCode}?client_id=claude-code`)
    const body = (await json(res)).data
    expect(body.status).toBe("approved")
    expect(body.accessToken).toBeTruthy()

    const conns =
      await sql`SELECT * FROM kernel.mcp_connections WHERE user_id = ${USER} AND org_id = ${ORG}`
    expect(conns.length).toBe(1)
    const sessionsAfter =
      await sql`SELECT count(*)::int AS n FROM kernel.sessions WHERE user_id = ${USER}`
    expect(sessionsAfter[0].n).toBe(sessionsBefore[0].n)
  })

  it("double-poll after consume mints exactly one connection", async () => {
    const d = await initiate()
    await app.request(`/api/auth/device-flow/approve/${d.userCode}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(await fullAccessBody()),
    })
    const first = await app.request(`/mcp/device/poll/${d.deviceCode}?client_id=claude-code`)
    expect((await json(first)).data.status).toBe("approved")
    // Expire the 1s/deviceCode poll rate limit (the key the route sets with
    // EX 1) so the second poll actually hits the consume path (not a 429),
    // proving the atomic single-consume.
    await redis.del(`mcp-device-poll:${d.deviceCode}`)
    const second = await app.request(`/mcp/device/poll/${d.deviceCode}?client_id=claude-code`)
    // Row consumed → second poll cannot find/mint again.
    expect(second.status).toBe(404)
    const conns =
      await sql`SELECT * FROM kernel.mcp_connections WHERE user_id = ${USER} AND org_id = ${ORG}`
    expect(conns.length).toBe(1)
  })

  it("expired device code → expired", async () => {
    const d = await initiate()
    await sql`UPDATE kernel.device_flow_requests
      SET expires_at = now() - interval '1 minute'
      WHERE device_code = ${d.deviceCode}`
    const res = await app.request(`/mcp/device/poll/${d.deviceCode}?client_id=claude-code`)
    expect((await json(res)).data.status).toBe("expired")
  })

  it("device-grant approval with an agentId creates an agent bound mcp connection", async () => {
    const agentId = "00000000-0000-4000-b000-00000000b010"
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${agentId}, ${ORG}, 'role', '@mcp-device-agent', 'Device Agent', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    try {
      const d = await initiate(agentId)
      await app.request(`/api/auth/device-flow/approve/${d.userCode}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(await fullAccessBody()),
      })
      const res = await app.request(
        `/mcp/device/poll/${d.deviceCode}?client_id=claude-code&agent_id=${agentId}`,
      )
      expect((await json(res)).data.status).toBe("approved")

      const conns = await sql<{ agent_id: string | null }[]>`
        SELECT agent_id FROM kernel.mcp_connections WHERE user_id = ${USER} AND org_id = ${ORG}`
      expect(conns.length).toBe(1)
      expect(conns[0].agent_id).toBe(agentId)
    } finally {
      await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    }
  })

  it("device-grant approval with an agentId from another org is rejected", async () => {
    const foreignOrg = "00000000-0000-4000-b000-00000000b020"
    const foreignAgent = "00000000-0000-4000-b000-00000000b021"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${foreignOrg}, 'Other Org', 'other-device-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${foreignAgent}, ${foreignOrg}, 'role', '@foreign-agent', 'Foreign', '[]'::jsonb)
      ON CONFLICT (id) DO NOTHING`
    try {
      const d = await initiate(foreignAgent)
      // Refused at approval already: the approver's org has no such agent.
      const ap = await app.request(`/api/auth/device-flow/approve/${d.userCode}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(await fullAccessBody()),
      })
      expect(ap.status).toBe(400)
      // And nothing to redeem at the poll.
      const res = await app.request(
        `/mcp/device/poll/${d.deviceCode}?client_id=claude-code&agent_id=${foreignAgent}`,
      )
      expect((await json(res)).data.status).toBe("authorization_pending")

      const conns = await sql`SELECT * FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      expect(conns.length).toBe(0)
    } finally {
      await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE id = ${foreignAgent}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${foreignOrg}`
    }
  })

  // The parked binding is request state in redis, so it can be lost (eviction,
  // a flush, an expiry at the edge of the window). A lost key used to mean a
  // SILENT downgrade to a legacy, full-scope connection, which is the opposite
  // of what the client asked for. The poll therefore re-states the agent it
  // requested and the two must agree exactly.
  describe("agent binding is re-stated at poll and must match", () => {
    const agentId = "00000000-0000-4000-b000-00000000b030"

    beforeAll(async () => {
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
        VALUES (${agentId}, ${ORG}, 'role', '@mcp-device-bind', 'Bind Agent', '[]'::jsonb)
        ON CONFLICT (id) DO NOTHING`
    })

    afterAll(async () => {
      await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    })

    async function approvedPoll(deviceCode: string, query: string) {
      await app.request(`/api/auth/device-flow/approve/${await userCodeFor(deviceCode)}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(await fullAccessBody()),
      })
      return app.request(`/mcp/device/poll/${deviceCode}?client_id=claude-code${query}`)
    }

    it("a grant that requested an agent is refused when the poll names none", async () => {
      const d = await initiate(agentId)
      const res = await approvedPoll(d.deviceCode, "")
      expect(res.status).toBe(400)
      const conns = await sql`SELECT * FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      expect(conns.length).toBe(0)
    })

    it("a lost parked binding is refused rather than downgraded to legacy", async () => {
      const d = await initiate(agentId)
      await redis.del(agentBindingKey(d.deviceCode))
      const res = await approvedPoll(d.deviceCode, `&agent_id=${agentId}`)
      expect(res.status).toBe(400)
      const conns = await sql`SELECT * FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      expect(conns.length).toBe(0)
    })

    it("a poll naming an agent the grant never requested is refused", async () => {
      const d = await initiate()
      const res = await approvedPoll(d.deviceCode, `&agent_id=${agentId}`)
      expect(res.status).toBe(400)
      const conns = await sql`SELECT * FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      expect(conns.length).toBe(0)
    })

    it("a poll re-stating the same agent binds it", async () => {
      const d = await initiate(agentId)
      const res = await approvedPoll(d.deviceCode, `&agent_id=${agentId}`)
      expect((await json(res)).data.status).toBe("approved")
      const conns = await sql<{ agent_id: string | null }[]>`
        SELECT agent_id FROM kernel.mcp_connections WHERE org_id = ${ORG}`
      expect(conns.length).toBe(1)
      expect(conns[0].agent_id).toBe(agentId)
      await sql`DELETE FROM kernel.mcp_connections WHERE org_id = ${ORG}`
    })
  })

  // P6d-FX7 (SK-7): the desktop's Cancel released nothing. The pending code
  // stayed approvable for its whole window, so cancelling and then following
  // the link already copied completed a flow the window had forgotten.
  describe("a client that gives up on its grant leaves nothing approvable", () => {
    it("cancel makes the code unapprovable and mints nothing", async () => {
      const d = await initiate()
      const cancel = await app.request(`/mcp/device/${d.deviceCode}?client_id=claude-code`, {
        method: "DELETE",
      })
      expect(cancel.status).toBe(200)
      expect((await json(cancel)).data.cancelled).toBe(true)

      // The human follows the link anyway. There is nothing there to approve.
      const approve = await app.request(`/api/auth/device-flow/approve/${d.userCode}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(await fullAccessBody()),
      })
      expect(approve.status).not.toBe(200)

      const poll = await app.request(`/mcp/device/poll/${d.deviceCode}?client_id=claude-code`)
      expect(poll.status).toBe(404)
      const conns =
        await sql`SELECT * FROM kernel.mcp_connections WHERE user_id = ${USER} AND org_id = ${ORG}`
      expect(conns.length).toBe(0)
    })

    it("cancel drops the parked agent binding with the grant", async () => {
      const agentId = "00000000-0000-4000-b000-00000000b0a1"
      const d = await initiate(agentId)
      expect(await redis.get(agentBindingKey(d.deviceCode))).toBe(agentId)
      await app.request(`/mcp/device/${d.deviceCode}?client_id=claude-code`, { method: "DELETE" })
      expect(await redis.get(agentBindingKey(d.deviceCode))).toBeNull()
    })

    it("only the client that initiated the grant may cancel it", async () => {
      const d = await initiate()
      const res = await app.request(`/mcp/device/${d.deviceCode}?client_id=wrong`, {
        method: "DELETE",
      })
      expect(res.status).toBe(403)
      const poll = await app.request(`/mcp/device/poll/${d.deviceCode}?client_id=claude-code`)
      expect((await json(poll)).data.status).toBe("authorization_pending")
    })

    it("cancelling a grant that is already gone is not an error", async () => {
      const res = await app.request("/mcp/device/deadbeef?client_id=claude-code", {
        method: "DELETE",
      })
      expect(res.status).toBe(200)
    })
  })

  it("client mismatch → 403", async () => {
    const d = await initiate()
    const res = await app.request(`/mcp/device/poll/${d.deviceCode}?client_id=wrong`)
    expect(res.status).toBe(403)
  })
})
