// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A LOCAL SESSION IS HANDED IS BOUNDED BY THE ROOM FLOOR.
//
// A cloud turn reads its context through the room's viewer: the floor (every
// human member's grants intersected) ∩ the agent's ceiling ∩ the requester's
// grants. The routes that hand a desktop or node session its context (the
// turn context, the message it runs, the agent's definition) must apply the
// same bound: in a room with a member who lacks a scope, an admin's local turn
// is not handed content requiring that scope; in the admin's own DM it is.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const KPI_READ = "kpi:metrics:read"

describe("a local session in a room is handed only what the room floor covers", () => {
  let admin: minimal.Session
  let member: minimal.Session
  let agentId: string
  let roomId: string
  let dmId: string
  const kpiMessage: Record<string, string> = {}

  const get = (path: string) =>
    app.request(path, { headers: { Authorization: `Bearer ${admin.bearer}` } })

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    admin = await minimal.session(org.id, { role: "admin" })
    // The kernel member preset carries no kpi scope.
    member = await minimal.session(org.id, { role: "member" })

    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${org.id}, 'role', '@floor-agent', 'Floor Agent', '["*"]'::jsonb)
      RETURNING id`
    agentId = agent.id
    await sql`INSERT INTO kernel.agent_memory (org_id, owner_agent_id, type, name, description, content, required_scopes)
      VALUES (${org.id}, ${agentId}, 'reference', 'kpi-fact', 'KPI_MEMORY_LINE', 'body', ARRAY[${KPI_READ}]::text[])`

    const [room] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${org.id}, 'floor-room', 'thread', ${admin.userId}) RETURNING id`
    roomId = room.id
    const [dm] = await sql<{ id: string }[]>`
      INSERT INTO kernel.threads (org_id, handle, type, created_by)
      VALUES (${org.id}, 'floor-dm', 'agent_chat', ${admin.userId}) RETURNING id`
    dmId = dm.id
    for (const [thread, users] of [
      [roomId, [admin.userId, member.userId]],
      [dmId, [admin.userId]],
    ] as const) {
      for (const user of users) {
        await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
          VALUES (${thread}, ${user}, ${org.id}, 'member') ON CONFLICT DO NOTHING`
      }
      const [kpi] = await sql<{ id: string }[]>`
        INSERT INTO kernel.messages (org_id, thread_id, author_type, author_id, content, required_scopes, created_at)
        VALUES (${org.id}, ${thread}, 'user', ${admin.userId}, 'SECRET_KPI_FIGURES', ARRAY[${KPI_READ}]::text[], now() - interval '2 minutes')
        RETURNING id`
      kpiMessage[thread] = kpi.id
      await sql`INSERT INTO kernel.messages (org_id, thread_id, author_type, author_id, content, required_scopes, created_at)
        VALUES (${org.id}, ${thread}, 'user', ${admin.userId}, 'what about it?', '{}'::text[], now() - interval '1 minute')`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE owner_agent_id = ${agentId}`
    await sql`DELETE FROM kernel.messages WHERE thread_id IN (${roomId}, ${dmId})`
    await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (${roomId}, ${dmId})`
    await sql`DELETE FROM kernel.threads WHERE id IN (${roomId}, ${dmId})`
    await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    await releaseTestLock()
  })

  it("the turn context of a room leaves out a message the other member may not read; the DM keeps it", async () => {
    const room = await get(`/api/agents/${agentId}/local-claims/${roomId}/turn-context?fresh=1`)
    expect(room.status).toBe(200)
    const roomText = await room.text()
    expect(roomText).toContain("what about it?")
    expect(roomText).not.toContain("SECRET_KPI_FIGURES")

    const dm = await get(`/api/agents/${agentId}/local-claims/${dmId}/turn-context?fresh=1`)
    expect(dm.status).toBe(200)
    expect(await dm.text()).toContain("SECRET_KPI_FIGURES")
  })

  it("the message route will not hand the room's session a message beyond the floor; the DM's it will", async () => {
    const room = await get(
      `/api/agents/${agentId}/local-claims/${roomId}/messages/${kpiMessage[roomId]}`,
    )
    expect(room.status).toBe(404)
    expect(await room.text()).not.toContain("SECRET_KPI_FIGURES")

    const dm = await get(`/api/agents/${agentId}/local-claims/${dmId}/messages/${kpiMessage[dmId]}`)
    expect(dm.status).toBe(200)
    expect(await dm.text()).toContain("SECRET_KPI_FIGURES")
  })

  it("the definition composed for the room leaves out a memory line beyond the floor; the DM's keeps it", async () => {
    const room = await get(`/api/agents/${agentId}/definition?threadId=${roomId}`)
    expect(room.status).toBe(200)
    expect(await room.text()).not.toContain("KPI_MEMORY_LINE")

    const dm = await get(`/api/agents/${agentId}/definition?threadId=${dmId}`)
    expect(dm.status).toBe(200)
    expect(await dm.text()).toContain("KPI_MEMORY_LINE")
  })

  it("the definition route refuses a room the caller cannot read (mutation 9)", async () => {
    const asMember = (path: string) =>
      app.request(path, { headers: { Authorization: `Bearer ${member.bearer}` } })
    // The agent itself is the member's to run: without a room it answers.
    expect((await asMember(`/api/agents/${agentId}/definition`)).status).toBe(200)
    // The admin's own DM is not the member's room: no definition composed for it.
    const res = await asMember(`/api/agents/${agentId}/definition?threadId=${dmId}`)
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain("KPI_MEMORY_LINE")
    // A room id that does not exist answers the same.
    const none = await asMember(`/api/agents/${agentId}/definition?threadId=${crypto.randomUUID()}`)
    expect(none.status).toBe(404)
  })

  it("the definition route refuses a room id that is not a uuid", async () => {
    const res = await get(`/api/agents/${agentId}/definition?threadId=not-a-uuid`)
    expect(res.status).toBe(400)
  })
})
