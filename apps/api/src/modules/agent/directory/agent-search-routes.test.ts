// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/agents/search: the agents sidebar's one search box, across agents,
// skills, routines and memory entries. What it must never do is widen anything:
// the agents are the directory's own predicate, the skills and routines are the
// caller's own RLS, and a memory row whose `requiredScopes` the caller lacks is
// absent rather than redacted.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("GET /api/agents/search", () => {
  let admin: minimal.Session
  let member: minimal.Session
  let roleAgentId: string
  let otherPersonalAgentId: string

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    admin = await minimal.session(org.id, { role: "admin" })
    member = await minimal.session(org.id, { role: "member" })

    const [role] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${org.id}, 'role', '@srch-logistics', 'Search Logistics', '["*"]'::jsonb) RETURNING id`
    roleAgentId = role.id

    // Another colleague's personal agent: never this member's to see, whatever
    // it happens to own.
    const [theirs] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${org.id}, 'personal', '@srch-theirs', 'Their Agent', '["*"]'::jsonb, ${admin.userId}) RETURNING id`
    otherPersonalAgentId = theirs.id

    await sql`INSERT INTO kernel.skills (org_id, owner_agent_id, name, description, body, created_by_actor_type)
      VALUES (${org.id}, ${roleAgentId}, 'srch-refund-triage', 'How refunds are triaged', 'BODY', 'user')`
    await sql`INSERT INTO kernel.skills (org_id, owner_agent_id, name, description, body, created_by_actor_type)
      VALUES (${org.id}, ${otherPersonalAgentId}, 'srch-refund-private', 'A private refund note', 'BODY', 'user')`

    await sql`INSERT INTO kernel.routines (org_id, owner_user_id, owner_agent_id, name, description, prompt, scopes, visibility, created_by_actor_type, kind, cron, timezone)
      VALUES (${org.id}, ${admin.userId}, ${roleAgentId}, 'srch-refund-sweep', 'Sweeps the refund queue', 'do it', '{}'::text[], 'shared', 'user', 'recurring', '0 9 * * *', 'UTC')`

    await sql`INSERT INTO kernel.agent_memory (org_id, owner_agent_id, type, name, description, content, required_scopes)
      VALUES (${org.id}, ${roleAgentId}, 'reference', 'srch-refund-rule', 'Refund window is 30 days', 'CONTENT', '{}'::text[])`
    // Scope-gated: present for a caller holding the scope, absent for one who
    // does not, never a redacted stub.
    await sql`INSERT INTO kernel.agent_memory (org_id, owner_agent_id, type, name, description, content, required_scopes)
      VALUES (${org.id}, ${roleAgentId}, 'reference', 'srch-refund-secret', 'Refund escalation ladder', 'CONTENT', ${["billing:admin"]}::text[])`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE owner_agent_id IN (${roleAgentId}, ${otherPersonalAgentId})`
    await sql`DELETE FROM kernel.routines WHERE owner_agent_id IN (${roleAgentId}, ${otherPersonalAgentId})`
    await sql`DELETE FROM kernel.skills WHERE owner_agent_id IN (${roleAgentId}, ${otherPersonalAgentId})`
    await sql`DELETE FROM kernel.agents WHERE id IN (${roleAgentId}, ${otherPersonalAgentId})`
    await releaseTestLock()
  })

  const search = (bearer: string, q: string) =>
    app.request(`/api/agents/search?q=${encodeURIComponent(q)}`, {
      headers: { Authorization: `Bearer ${bearer}` },
    })

  it("one query answers across agents, skills, routines and memory", async () => {
    const res = await search(admin.bearer, "refund")
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    const data = body.data ?? body
    expect(data.skills.map((s: any) => s.name)).toContain("srch-refund-triage")
    expect(data.routines.map((r: any) => r.name)).toContain("srch-refund-sweep")
    expect(data.memories.map((m: any) => m.name)).toContain("srch-refund-rule")
    // Every hit names the agent it belongs to: the sidebar navigates to that
    // agent's tab with the item selected.
    const skill = data.skills.find((s: any) => s.name === "srch-refund-triage")
    expect(skill.agentHandle).toBe("@srch-logistics")
    expect(skill.agentId).toBe(roleAgentId)
  })

  it("an agent hit comes back for a query naming the agent", async () => {
    const res = await search(admin.bearer, "Search Logistics")
    const data = ((await res.json()) as any).data
    expect(data.agents.map((a: any) => a.handle)).toContain("@srch-logistics")
  })

  it("an empty query answers empty rather than everything", async () => {
    const res = await search(admin.bearer, "   ")
    const data = ((await res.json()) as any).data
    expect(data).toEqual({ agents: [], skills: [], routines: [], memories: [] })
  })

  it("a member never sees another colleague's personal agent's skills", async () => {
    const res = await search(member.bearer, "refund")
    const data = ((await res.json()) as any).data
    expect(data.skills.map((s: any) => s.name)).not.toContain("srch-refund-private")
    expect(data.agents.map((a: any) => a.handle)).not.toContain("@srch-theirs")
  })

  it("a memory row the caller's scopes do not reach is absent", async () => {
    const res = await search(member.bearer, "Refund")
    const data = ((await res.json()) as any).data
    expect(data.memories.map((m: any) => m.name)).toContain("srch-refund-rule")
    expect(data.memories.map((m: any) => m.name)).not.toContain("srch-refund-secret")
  })

  it("an unauthenticated caller is refused", async () => {
    const res = await app.request("/api/agents/search?q=refund")
    expect(res.status).toBe(401)
  })
})
