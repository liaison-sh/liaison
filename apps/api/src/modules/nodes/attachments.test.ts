// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-S T3 (S25, A17): agents attached to a node owner's node.
//
// CRUD on the owner's session (the desktop client's routes, node-api.ts);
// attaching a shared role agent needs the allow of an admin (role agents have
// no owner); the route a request takes is decided by the requester allowlist
// (the node owner always, plus the users and agents listed), the daily caps,
// and, when several attachments match, the earliest one.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as eventBusModule from "~/infra/events/event-bus"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { attachmentCapRefusal, findNodeRoute } from "./attachments"

describe("node attachments (P4 T3, A17)", () => {
  let owner: minimal.Session
  let second: minimal.Session
  let requester: minimal.Session
  let admin: minimal.Session
  let roleAgent: string
  let otherRoleAgent: string
  let personalAgent: string
  let askingAgent: string

  const call = (path: string, method: string, session: minimal.Session, body?: unknown) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${session.bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  const data = async (res: Response) => ((await res.json()) as { data: any }).data

  async function enable(session: minimal.Session) {
    const res = await call("/api/nodes", "POST", session, { deviceId: `d.${crypto.randomUUID()}` })
    expect(res.status).toBe(201)
  }

  async function agent(kind: "role" | "personal", ownerUserId: string | null) {
    const [a] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, ${kind}, ${`@att-${crypto.randomUUID().slice(0, 8)}`}, 'Bug Fixer',
              '["kernel:threads:read","kernel:threads:write"]'::jsonb, ${ownerUserId})
      RETURNING id`
    return a.id
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id)
    second = await minimal.session(org.id)
    requester = await minimal.session(org.id)
    admin = await minimal.session(org.id, { role: "admin" })
    roleAgent = await agent("role", null)
    otherRoleAgent = await agent("role", null)
    personalAgent = await agent("personal", owner.userId)
    askingAgent = await agent("role", null)
  })

  beforeEach(async () => {
    await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.node_attachments WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
  })

  afterAll(async () => {
    if (owner) {
      await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.node_attachments WHERE org_id = ${owner.orgId}`
      await sql`DELETE FROM kernel.nodes WHERE org_id = ${owner.orgId}`
    }
    await releaseTestLock()
  })

  it("CRUD: attach with default caps, list with the agent's name, change caps, detach", async () => {
    await enable(owner)
    const created = await call("/api/nodes/me/attachments", "POST", owner, {
      agentId: personalAgent,
    })
    expect(created.status).toBe(201)
    const att = await data(created)
    expect(att).toMatchObject({
      agentId: personalAgent,
      agentName: "Bug Fixer",
      allowedRequesters: [],
      maxJobsPerDay: 10,
      maxTokensPerDay: 2_000_000,
      allowed: true,
      // D18: the settings page suggests a guardrail level from the agent's model (Auto: Strict).
      agentModel: null,
      suggestedGuardrail: "strict",
    })
    const listed = await data(await call("/api/nodes/me/attachments", "GET", owner))
    expect(listed.map((a: { id: string }) => a.id)).toEqual([att.id])
    const patched = await call(`/api/nodes/attachments/${att.id}`, "PATCH", owner, {
      maxJobsPerDay: 3,
      allowedRequesters: [{ type: "user", id: requester.userId }],
    })
    expect(patched.status).toBe(200)
    expect(await data(patched)).toMatchObject({
      maxJobsPerDay: 3,
      allowedRequesters: [{ type: "user", id: requester.userId }],
    })
    // Another user cannot see, change or remove it.
    expect(await data(await call("/api/nodes/me/attachments", "GET", second))).toEqual([])
    expect(
      (await call(`/api/nodes/attachments/${att.id}`, "PATCH", second, { maxJobsPerDay: 50 }))
        .status,
    ).toBe(404)
    expect((await call(`/api/nodes/attachments/${att.id}`, "DELETE", second)).status).toBe(404)
    expect((await call(`/api/nodes/attachments/${att.id}`, "DELETE", owner)).status).toBe(200)
    expect(await data(await call("/api/nodes/me/attachments", "GET", owner))).toEqual([])
  })

  it("attaching an agent publishes change attachment to the owner (S18)", async () => {
    await enable(owner)
    const [node] = await sql<{ id: string }[]>`
      SELECT id FROM kernel.nodes WHERE owner_user_id = ${owner.userId}`
    const spy = spyOn(eventBusModule, "broadcastEphemeral")
    try {
      const created = await call("/api/nodes/me/attachments", "POST", owner, {
        agentId: personalAgent,
      })
      expect(created.status).toBe(201)
      const frames = spy.mock.calls
        .map((c) => c[0])
        .filter((e) => e.app === "kernel" && e.entity === "node")
      expect(frames.map((e) => e.data)).toEqual([
        { ownerUserId: owner.userId, nodeId: node.id, change: "attachment" },
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it("refuses to attach an agent the caller cannot run, or without a node", async () => {
    expect(
      (await call("/api/nodes/me/attachments", "POST", owner, { agentId: personalAgent })).status,
    ).toBe(409)
    await enable(second)
    // Someone else's personal agent.
    expect(
      (await call("/api/nodes/me/attachments", "POST", second, { agentId: personalAgent })).status,
    ).toBe(403)
  })

  it("a shared role agent needs an admin's allow before any request is routed to it", async () => {
    await enable(owner)
    const att = await data(
      await call("/api/nodes/me/attachments", "POST", owner, { agentId: roleAgent }),
    )
    expect(att.allowed).toBe(false)
    const route = () =>
      findNodeRoute({
        orgId: owner.orgId,
        agentId: roleAgent,
        requesterUserId: owner.userId,
        requesterAgentId: null,
      })
    expect(await route()).toBeNull()
    // The node owner (not an admin, not the agent's owner) cannot allow it.
    expect((await call(`/api/nodes/attachments/${att.id}/allow`, "POST", owner)).status).toBe(403)
    expect((await call(`/api/nodes/attachments/${att.id}/allow`, "POST", admin)).status).toBe(200)
    expect((await route())?.attachmentId).toBe(att.id)
  })

  it("an admin attaching a shared agent to their own node allows it at once", async () => {
    await enable(admin)
    const att = await data(
      await call("/api/nodes/me/attachments", "POST", admin, { agentId: otherRoleAgent }),
    )
    expect(att.allowed).toBe(true)
  })

  it("routes only requests from the allowlist: the owner, listed users and listed agents", async () => {
    await enable(owner)
    await data(
      await call("/api/nodes/me/attachments", "POST", owner, {
        agentId: personalAgent,
        allowedRequesters: [
          { type: "user", id: requester.userId },
          { type: "agent", id: askingAgent },
        ],
      }),
    )
    const route = (requesterUserId: string, requesterAgentId: string | null = null) =>
      findNodeRoute({
        orgId: owner.orgId,
        agentId: personalAgent,
        requesterUserId,
        requesterAgentId,
      })
    expect((await route(owner.userId))?.nodeOwnerUserId).toBe(owner.userId)
    expect((await route(requester.userId))?.nodeOwnerUserId).toBe(owner.userId)
    expect((await route(second.userId, askingAgent))?.nodeOwnerUserId).toBe(owner.userId)
    // Neither the person nor the asking agent is listed: the request runs as today.
    expect(await route(second.userId)).toBeNull()
    expect(await route(second.userId, roleAgent)).toBeNull()
  })

  it("when several attachments match, the earliest wins", async () => {
    await enable(owner)
    await enable(second)
    const first = await data(
      await call("/api/nodes/me/attachments", "POST", owner, {
        agentId: roleAgent,
        allowedRequesters: [{ type: "user", id: requester.userId }],
      }),
    )
    await call(`/api/nodes/attachments/${first.id}/allow`, "POST", admin)
    const later = await data(
      await call("/api/nodes/me/attachments", "POST", second, {
        agentId: roleAgent,
        allowedRequesters: [{ type: "user", id: requester.userId }],
      }),
    )
    await call(`/api/nodes/attachments/${later.id}/allow`, "POST", admin)
    const route = await findNodeRoute({
      orgId: owner.orgId,
      agentId: roleAgent,
      requesterUserId: requester.userId,
      requesterAgentId: null,
    })
    expect(route?.attachmentId).toBe(first.id)
    expect(route?.nodeOwnerUserId).toBe(owner.userId)
  })

  it("caps: jobs and tokens per day refuse further routed requests", async () => {
    await enable(owner)
    const att = await data(
      await call("/api/nodes/me/attachments", "POST", owner, {
        agentId: personalAgent,
        maxJobsPerDay: 1,
        maxTokensPerDay: 1000,
      }),
    )
    const route = await findNodeRoute({
      orgId: owner.orgId,
      agentId: personalAgent,
      requesterUserId: owner.userId,
      requesterAgentId: null,
    })
    expect(route).not.toBeNull()
    expect(await attachmentCapRefusal(route!)).toBeNull()
    const threadId = await minimal.thread(owner.orgId, owner.userId)
    const insertJob = (usage: unknown, age = "0 hours") => sql`
      INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, thread_id, source, prompt,
                                    status, usage, created_at)
      VALUES (${owner.orgId}, ${owner.userId}, ${personalAgent}, ${threadId}, 'agent_tag', 'p',
              'done', ${usage === null ? null : JSON.stringify(usage)}::jsonb,
              now() - ${age}::interval)`
    // A job older than a day does not count.
    await insertJob({ inputTokens: 5000, outputTokens: 5000 }, "25 hours")
    expect(await attachmentCapRefusal(route!)).toBeNull()
    await insertJob(null)
    expect(await attachmentCapRefusal(route!)).toMatch(/jobs/)
    await call(`/api/nodes/attachments/${att.id}`, "PATCH", owner, { maxJobsPerDay: 10 })
    const widened = await findNodeRoute({
      orgId: owner.orgId,
      agentId: personalAgent,
      requesterUserId: owner.userId,
      requesterAgentId: null,
    })
    expect(await attachmentCapRefusal(widened!)).toBeNull()
    await insertJob({ inputTokens: 700, outputTokens: 400 })
    expect(await attachmentCapRefusal(widened!)).toMatch(/tokens/)
  })
})
