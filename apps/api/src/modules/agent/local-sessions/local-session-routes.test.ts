// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The audit trail for a session that runs on the user's OWN machine. The
// server never sees the folder, the prompt or the answer, so these two routes
// are the only record that the session happened at all, and the one thing they
// must never carry is a path: a folder name is the user's private filesystem
// and an audit row is read by admins.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import { mcpTurnTaintKey } from "~/modules/mcp/connection-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const OTHER_ORG = "00000000-0000-0000-0000-00000000b06a"
const FOLDER_HASH = "a".repeat(64)
const PROMPT_CHECKSUM = "b".repeat(64)

describe("local session audit routes", () => {
  let session: minimal.Session
  let agentId: string
  let foreignAgentId: string

  const post = (path: string, bearer: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  const rowsFor = (action: string) =>
    sql<Array<{ agent_id: string | null; metadata: Record<string, unknown>; actor_type: string }>>`
      SELECT agent_id, metadata, actor_type FROM kernel.audit_log
      WHERE org_id = ${session.orgId} AND action = ${action}`

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    session = await minimal.session(org.id, { role: "admin" })
    // A second org by direct insert: createTestOrg truncates and enforces the
    // single-org invariant, so a second call would delete the first org.
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${OTHER_ORG}, 'OtherLocalSessOrg', ${`other-ls-${OTHER_ORG.slice(0, 8)}`})
      ON CONFLICT DO NOTHING`

    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${session.orgId}, 'personal', '@local-sess', 'Local Sess', '["*"]'::jsonb, ${session.userId})
      RETURNING id`
    agentId = agent.id
    const [foreign] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${OTHER_ORG}, 'role', '@local-sess-foreign', 'Foreign', '["*"]'::jsonb)
      RETURNING id`
    foreignAgentId = foreign.id
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${session.orgId}`
    await sql`DELETE FROM kernel.agents WHERE id IN (${agentId}, ${foreignAgentId})`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${OTHER_ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${OTHER_ORG}`
    await releaseTestLock()
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${session.orgId}`
  })

  it("records a start and hands back a session id, with the hash and no path", async () => {
    const response = await post(`/api/agents/${agentId}/local-sessions`, session.bearer, {
      permissionMode: "manual",
      folderHash: FOLDER_HASH,
      model: "claude-haiku-4-5",
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { data: { sessionId: string } }
    expect(body.data.sessionId).toMatch(/^[0-9a-f-]{36}$/)

    const rows = await rowsFor("agent.local_session.start")
    expect(rows).toHaveLength(1)
    expect(rows[0].agent_id).toBe(agentId)
    expect(rows[0].actor_type).toBe("user")
    expect(rows[0].metadata).toMatchObject({
      folderHash: FOLDER_HASH,
      permissionMode: "manual",
      model: "claude-haiku-4-5",
      runLocation: "local",
      sessionId: body.data.sessionId,
    })
    // The whole point: nothing in the row can be turned back into a folder.
    expect(JSON.stringify(rows[0].metadata)).not.toContain("/")
  })

  it("records a start and a turn in auto, the desktop's default mode", async () => {
    const start = await post(`/api/agents/${agentId}/local-sessions`, session.bearer, {
      permissionMode: "auto",
      folderHash: FOLDER_HASH,
      model: "claude-haiku-4-5",
    })
    expect(start.status).toBe(201)
    const body = (await start.json()) as { data: { sessionId: string } }
    const turn = await post(
      `/api/agents/${agentId}/local-sessions/${body.data.sessionId}/events`,
      session.bearer,
      { kind: "turn", promptChecksum: PROMPT_CHECKSUM, permissionMode: "auto" },
    )
    expect(turn.status).toBeLessThan(300)
    const rows = await rowsFor("agent.local_session.start")
    expect(rows[0].metadata).toMatchObject({ permissionMode: "auto" })
  })

  // 2026-09-23: a start that resumed nothing says why, so a definition change
  // that dropped a session is readable from the trail.
  it("records why a start resumed nothing", async () => {
    const response = await post(`/api/agents/${agentId}/local-sessions`, session.bearer, {
      permissionMode: "manual",
      folderHash: FOLDER_HASH,
      model: "claude-haiku-4-5",
      freshReason: "definition_changed",
    })
    expect(response.status).toBe(201)
    const rows = await rowsFor("agent.local_session.start")
    expect(rows[0].metadata).toMatchObject({ resumed: false, freshReason: "definition_changed" })
  })

  it("refuses a fresh reason it does not know", async () => {
    const response = await post(`/api/agents/${agentId}/local-sessions`, session.bearer, {
      permissionMode: "manual",
      folderHash: FOLDER_HASH,
      model: "claude-haiku-4-5",
      freshReason: "because",
    })
    expect(response.status).toBe(400)
  })

  it("refuses a folder path where a hash belongs, rather than storing it", async () => {
    const response = await post(`/api/agents/${agentId}/local-sessions`, session.bearer, {
      permissionMode: "manual",
      folderHash: "/home/agent/projects/example",
      model: "claude-haiku-4-5",
    })
    expect(response.status).toBe(400)
    expect(await rowsFor("agent.local_session.start")).toHaveLength(0)
  })

  it("refuses a hash that is not 64 hex characters", async () => {
    for (const folderHash of ["a".repeat(63), `${"a".repeat(63)}z`, "A".repeat(64)]) {
      const response = await post(`/api/agents/${agentId}/local-sessions`, session.bearer, {
        permissionMode: "manual",
        folderHash,
        model: "claude-haiku-4-5",
      })
      expect(response.status).toBe(400)
    }
  })

  it("refuses a caller who is not a member of the agent's org", async () => {
    const response = await post(`/api/agents/${foreignAgentId}/local-sessions`, session.bearer, {
      permissionMode: "manual",
      folderHash: FOLDER_HASH,
      model: "claude-haiku-4-5",
    })
    expect(response.status).toBe(403)
    expect(await rowsFor("agent.local_session.start")).toHaveLength(0)
    const foreignRows = await sql`SELECT 1 FROM kernel.audit_log WHERE org_id = ${OTHER_ORG}`
    expect(foreignRows).toHaveLength(0)
  })

  it("refuses to start or log a session for an agent the caller could not have addressed (system agent, another user's personal agent)", async () => {
    const [system] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${session.orgId}, 'system', '@local-sess-system', 'System', '["*"]'::jsonb)
      RETURNING id`
    const [theirs] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${session.orgId}, 'personal', '@local-sess-theirs', 'Theirs', '["*"]'::jsonb,
        ${(await minimal.session(session.orgId, { role: "member" })).userId})
      RETURNING id`
    try {
      for (const id of [system.id, theirs.id]) {
        const start = await post(`/api/agents/${id}/local-sessions`, session.bearer, {
          permissionMode: "manual",
          folderHash: FOLDER_HASH,
          model: "claude-haiku-4-5",
        })
        expect(start.status).toBe(403)
        const event = await post(
          `/api/agents/${id}/local-sessions/00000000-0000-4000-8000-000000000001/events`,
          session.bearer,
          { kind: "turn", promptChecksum: PROMPT_CHECKSUM, permissionMode: "manual" },
        )
        expect(event.status).toBe(403)
      }
      expect(await rowsFor("agent.local_session.start")).toHaveLength(0)
    } finally {
      await sql`DELETE FROM kernel.agents WHERE id IN (${system.id}, ${theirs.id})`
    }
  })

  it("records a turn event and an end event against the same session", async () => {
    const started = await post(`/api/agents/${agentId}/local-sessions`, session.bearer, {
      permissionMode: "plan",
      folderHash: FOLDER_HASH,
      model: "claude-haiku-4-5",
    })
    const { data } = (await started.json()) as { data: { sessionId: string } }

    const turn = await post(
      `/api/agents/${agentId}/local-sessions/${data.sessionId}/events`,
      session.bearer,
      { kind: "turn", promptChecksum: PROMPT_CHECKSUM, permissionMode: "plan" },
    )
    expect(turn.status).toBe(204)

    const turns = await rowsFor("agent.local_session.turn")
    expect(turns).toHaveLength(1)
    expect(turns[0].agent_id).toBe(agentId)
    expect(turns[0].metadata).toMatchObject({
      sessionId: data.sessionId,
      promptChecksum: PROMPT_CHECKSUM,
      permissionMode: "plan",
      runLocation: "local",
    })

    const ended = await post(
      `/api/agents/${agentId}/local-sessions/${data.sessionId}/events`,
      session.bearer,
      { kind: "end" },
    )
    expect(ended.status).toBe(204)
    expect(await rowsFor("agent.local_session.end")).toHaveLength(1)
  })

  it("a session start and each turn open the agent's taint set, so a missing one is a lost one (fix8 M2)", async () => {
    const key = mcpTurnTaintKey(session.orgId, agentId)
    await redis.del(key)
    const started = await post(`/api/agents/${agentId}/local-sessions`, session.bearer, {
      permissionMode: "auto",
      folderHash: FOLDER_HASH,
      model: "claude-haiku-4-5",
    })
    const { data } = (await started.json()) as { data: { sessionId: string } }
    expect(await redis.get(key)).toBe("[]")
    await redis.del(key)
    const turn = await post(
      `/api/agents/${agentId}/local-sessions/${data.sessionId}/events`,
      session.bearer,
      { kind: "turn", promptChecksum: PROMPT_CHECKSUM },
    )
    expect(turn.status).toBe(204)
    expect(await redis.get(key)).toBe("[]")
    // Never over a set a read already wrote.
    await redis.set(key, JSON.stringify(["mail:conversations:read"]), "EX", 60)
    await post(`/api/agents/${agentId}/local-sessions/${data.sessionId}/events`, session.bearer, {
      kind: "turn",
      promptChecksum: PROMPT_CHECKSUM,
    })
    expect(await redis.get(key)).toBe(JSON.stringify(["mail:conversations:read"]))
    await redis.del(key)
  })

  it("refuses a prompt checksum that is not 64 hex characters", async () => {
    const response = await post(
      `/api/agents/${agentId}/local-sessions/${crypto.randomUUID()}/events`,
      session.bearer,
      { kind: "turn", promptChecksum: "the prompt itself" },
    )
    expect(response.status).toBe(400)
    expect(await rowsFor("agent.local_session.turn")).toHaveLength(0)
  })

  it("refuses an event from outside the agent's org", async () => {
    const response = await post(
      `/api/agents/${foreignAgentId}/local-sessions/${crypto.randomUUID()}/events`,
      session.bearer,
      { kind: "end" },
    )
    expect(response.status).toBe(403)
  })

  // The session id goes straight into `audit_log.entity_id`. A client that can
  // put any string there can attribute rows to a session that never existed.
  it("refuses a session id that is not the uuid the server minted", async () => {
    const response = await post(
      `/api/agents/${agentId}/local-sessions/not-a-session/events`,
      session.bearer,
      { kind: "turn", promptChecksum: PROMPT_CHECKSUM },
    )
    expect(response.status).toBe(400)
    expect(await rowsFor("agent.local_session.turn")).toHaveLength(0)
  })
})
