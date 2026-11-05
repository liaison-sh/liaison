// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { writeAuditLog } from "~/modules/audit/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("GET /api/audit", () => {
  let adminToken: string
  let orgId: string

  beforeAll(async () => {
    await acquireTestLock()

    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@test.com", password: "testpass123", name: "Admin" }),
    })
    adminToken = ((await res.json()) as any as any).data.accessToken

    const orgs = await sql`SELECT id FROM kernel.organizations LIMIT 1`
    orgId = orgs[0].id

    // Seed audit entries
    await withRlsContext({ actorType: "system", orgId, purpose: "audit" }, (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: null,
        actorType: "system",
        action: "test",
        app: "kernel",
      }),
    )
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("admin can query audit log", async () => {
    const res = await app.request("/api/audit", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(Array.isArray(body.data)).toBe(true)
  })

  it("supports filtering by app", async () => {
    const res = await app.request("/api/audit?app=kernel", {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any as any
    expect(body.data.every((e: any) => e.app === "kernel")).toBe(true)
  })

  it("filters by acting agent, and every returned row names its agent", async () => {
    // "What did the logistics agent do" must be answerable over HTTP, not only
    // through the agent tool (A11). The decoy row is the discriminator: an
    // ignored filter returns it too.
    const [target, decoy] = [crypto.randomUUID(), crypto.randomUUID()]
    for (const [id, handle] of [
      [target, "logistics"],
      [decoy, "billing"],
    ] as const) {
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
        VALUES (${id}, ${orgId}, 'role', ${`@audit-route-${handle}-${id.slice(0, 8)}`}, ${handle})`
    }
    for (const [agentId, action] of [
      [target, "route.target"],
      [decoy, "route.decoy"],
    ] as const) {
      await withRlsContext({ actorType: "system", orgId, purpose: "audit" }, (tx) =>
        writeAuditLog(tx, {
          orgId,
          actorId: null,
          actorType: "agent",
          action,
          app: "kernel",
          agentId,
        }),
      )
    }

    const res = await app.request(`/api/audit?agent_id=${target}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.data.length).toBeGreaterThan(0)
    expect(body.data.map((e: any) => e.action).sort()).toEqual(["route.target"])
    expect(body.data.every((e: any) => e.agentId === target)).toBe(true)
  })

  it("the agent filter is unreachable without kernel:audit:read, and reachable with it", async () => {
    // The audit read by agent was widened without a test that crosses the gate:
    // its harness calls handleAuditSearch directly. This one goes through the
    // real surface, where the gate actually lives (app.ts mounts /api/audit
    // behind requireScope("kernel:audit:read")).
    const agentId = crypto.randomUUID()
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
      VALUES (${agentId}, ${orgId}, 'role', ${`@audit-gate-${agentId.slice(0, 8)}`}, 'Gated')`
    await withRlsContext({ actorType: "system", orgId, purpose: "audit" }, (tx) =>
      writeAuditLog(tx, {
        orgId,
        actorId: null,
        actorType: "agent",
        action: "route.gated",
        app: "kernel",
        agentId,
      }),
    )

    // A member of the same org whose role carries an unrelated scope only.
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    }
    const roleRes = await app.request("/api/admin/roles", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ name: "audit-gate-support", description: "no audit read" }),
    })
    const roleId = ((await roleRes.json()) as any).data.id
    await app.request(`/api/admin/roles/${roleId}/scopes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ scope: "kernel:contacts:read" }),
    })
    const inviteRes = await app.request("/api/admin/invites", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ email: "audit-gate-member@test.com", roleId }),
    })
    const inviteToken = ((await inviteRes.json()) as any).data.inviteToken
    const regRes = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteToken, password: "memberpass1", name: "Audit Gate Member" }),
    })
    const memberToken = ((await regRes.json()) as any).data.accessToken

    // Without the scope the filter is refused, and the refusal carries no rows.
    const denied = await app.request(`/api/audit?agent_id=${agentId}`, {
      headers: { Authorization: `Bearer ${memberToken}` },
    })
    expect(denied.status).toBe(403)
    const deniedBody = (await denied.json()) as any
    expect(deniedBody.data).toBeUndefined()

    // With it, the same request answers, filtered to that agent.
    const allowed = await app.request(`/api/audit?agent_id=${agentId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(allowed.status).toBe(200)
    const allowedBody = (await allowed.json()) as any
    expect(allowedBody.data.map((e: any) => e.action)).toEqual(["route.gated"])
  })

  it("audit entries cannot be modified via API", async () => {
    // No PATCH/DELETE endpoint exists
    const res = await app.request("/api/audit/some-id", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    })
    expect(res.status).toBe(404)
  })
})
