// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4b-D5: archiving an agent from the admin surface, and handing its work to
// another agent first.
//
// `checkArchiveBlockers` and `archiveAgent` have existed since 1a with no
// route; the reassign half had none at all, so an agent that owned a shared
// routine could never be archived from the product.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const ADMIN = crypto.randomUUID()
const LEAVING = crypto.randomUUID()
const KEEPER = crypto.randomUUID()
const OTHER_ORG_AGENT = crypto.randomUUID()
const OTHER_ORG_KEEPER = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const OTHER_USER = crypto.randomUUID()
const FOREIGN_ROUTINE = crypto.randomUUID()
const FOREIGN_SKILL = crypto.randomUUID()
const ROUTINE = crypto.randomUUID()
const SKILL = crypto.randomUUID()
const SPARE = crypto.randomUUID()
const MEMBER = crypto.randomUUID()
const MEMBER_AGENT = crypto.randomUUID()
const MEMBER_ROUTINE = crypto.randomUUID()
const ADMIN_AGENT2 = crypto.randomUUID()
const ADMIN_ROUTINE2 = crypto.randomUUID()
const tag = crypto.randomUUID().slice(0, 8)

let adminToken: string
let memberToken: string

const archive = (agentId: string) =>
  app.request(`/api/agents/${agentId}/archive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
    body: "{}",
  })

const reassignAs = (
  token: () => string,
  kind: "routines" | "skills",
  id: string,
  ownerAgentId: string,
) =>
  app.request(`/api/agent/${kind}/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ownerAgentId }),
  })

const reassign = (kind: "routines" | "skills", id: string, ownerAgentId: string) =>
  reassignAs(() => adminToken, kind, id, ownerAgentId)

describe("archive and reassign routes", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'AR Org', ${`ar-${tag}`})`
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${OTHER_ORG}, 'AR Other', ${`ar2-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN}, ${ORG}, ${`ar-admin-${tag}@t.com`}, 'Admin')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER_USER}, ${OTHER_ORG}, ${`ar-o-${tag}@t.com`}, 'Other')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${LEAVING}, ${ORG}, 'personal', ${`@ar-leaving-${tag}`}, 'Leaving', ${ADMIN}, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${KEEPER}, ${ORG}, 'role', ${`@ar-keeper-${tag}`}, 'Keeper', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${SPARE}, ${ORG}, 'role', ${`@ar-spare-${tag}`}, 'Spare', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${OTHER_ORG_AGENT}, ${OTHER_ORG}, 'role', ${`@ar-foreign-${tag}`}, 'Foreign', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${OTHER_ORG_KEEPER}, ${OTHER_ORG}, 'role', ${`@ar-foreign-keeper-${tag}`}, 'Foreign Keeper', NULL, '[]'::jsonb)`
    await sql`INSERT INTO kernel.routines (id, org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone, prompt, visibility, scopes, created_by_actor_type)
      VALUES (${ROUTINE}, ${ORG}, ${ADMIN}, ${LEAVING}, ${`ar-routine-${tag}`}, 'digest', 'recurring', '0 9 * * *', 'UTC', 'do it', 'shared', '{}'::text[], 'user')`
    await sql`INSERT INTO kernel.skills (id, org_id, author_user_id, owner_agent_id, name, description, body, created_by_actor_type)
      VALUES (${SKILL}, ${ORG}, ${ADMIN}, ${LEAVING}, ${`ar-skill-${tag}`}, 'how to', 'body text', 'user')`
    await sql`INSERT INTO kernel.agent_skill_index (agent_id, skill_id, org_id, skill_name)
      VALUES (${KEEPER}, ${SKILL}, ${ORG}, ${`ar-skill-${tag}`})`

    // A plain member holding kernel:routines:write, their own personal agent,
    // and one routine each: theirs and the admin's.
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${MEMBER}, ${ORG}, ${`ar-member-${tag}@t.com`}, 'Member')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${MEMBER_AGENT}, ${ORG}, 'personal', ${`@ar-member-${tag}`}, 'Member Agent', ${MEMBER}, '[]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${ADMIN_AGENT2}, ${ORG}, 'personal', ${`@ar-admin2-${tag}`}, 'Admin Second', ${ADMIN}, '[]'::jsonb)`
    await sql`INSERT INTO kernel.routines (id, org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone, prompt, visibility, scopes, created_by_actor_type)
      VALUES (${MEMBER_ROUTINE}, ${ORG}, ${MEMBER}, ${MEMBER_AGENT}, ${`ar-member-routine-${tag}`}, 'digest', 'recurring', '0 9 * * *', 'UTC', 'do it', 'shared', '{}'::text[], 'user')`
    await sql`INSERT INTO kernel.routines (id, org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone, prompt, visibility, scopes, created_by_actor_type)
      VALUES (${ADMIN_ROUTINE2}, ${ORG}, ${ADMIN}, ${ADMIN_AGENT2}, ${`ar-admin-routine2-${tag}`}, 'digest', 'recurring', '0 9 * * *', 'UTC', 'do it', 'shared', '{}'::text[], 'user')`

    // The foreign agent OWNS work, so a blocker check that forgets the org
    // would have both names to hand back.
    await sql`INSERT INTO kernel.routines (id, org_id, owner_user_id, owner_agent_id, name, description, kind, cron, timezone, prompt, visibility, scopes, created_by_actor_type)
      VALUES (${FOREIGN_ROUTINE}, ${OTHER_ORG}, ${OTHER_USER}, ${OTHER_ORG_AGENT}, ${`ar-foreign-routine-${tag}`}, 'digest', 'recurring', '0 9 * * *', 'UTC', 'do it', 'shared', '{}'::text[], 'user')`
    await sql`INSERT INTO kernel.skills (id, org_id, author_user_id, owner_agent_id, name, description, body, created_by_actor_type)
      VALUES (${FOREIGN_SKILL}, ${OTHER_ORG}, ${OTHER_USER}, ${OTHER_ORG_AGENT}, ${`ar-foreign-skill-${tag}`}, 'how to', 'body text', 'user')`
    await sql`INSERT INTO kernel.agent_skill_index (agent_id, skill_id, org_id, skill_name)
      VALUES (${OTHER_ORG_KEEPER}, ${FOREIGN_SKILL}, ${OTHER_ORG}, ${`ar-foreign-skill-${tag}`})`

    adminToken = await signAccessToken(
      {
        userId: ADMIN,
        orgId: ORG,
        name: "Admin",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
      },
      env.JWT_SECRET,
    )
    memberToken = await signAccessToken(
      {
        userId: MEMBER,
        orgId: ORG,
        name: "Member",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["kernel:routines:write", "kernel:routines:read", "kernel:skills:write"],
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.agent_skill_index WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.skills WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.routines WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.agents WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
    await releaseTestLock()
  })

  it("names what blocks the archive instead of archiving", async () => {
    const res = await archive(LEAVING)
    expect(res.status).toBe(409)
    const body: any = await res.json()
    const details = body?.error?.details
    expect(details.blocked).toBe(true)
    expect(details.routines).toEqual([{ id: ROUTINE, name: `ar-routine-${tag}` }])
    expect(details.skills).toEqual([{ id: SKILL, name: `ar-skill-${tag}` }])
    const [row] = await sql<{ archived_at: string | null }[]>`
      SELECT archived_at FROM kernel.agents WHERE id = ${LEAVING}`
    expect(row.archived_at).toBe(null)
  })

  it("refuses a reassign to an agent of another org", async () => {
    const res = await reassign("routines", ROUTINE, OTHER_ORG_AGENT)
    expect(res.status).toBe(404)
    const [row] = await sql<{ owner_agent_id: string }[]>`
      SELECT owner_agent_id FROM kernel.routines WHERE id = ${ROUTINE}`
    expect(row.owner_agent_id).toBe(LEAVING)
  })

  it("hands the routine and the skill to another agent, and records both", async () => {
    expect((await reassign("routines", ROUTINE, SPARE)).status).toBe(200)
    expect((await reassign("skills", SKILL, SPARE)).status).toBe(200)
    const [routine] = await sql<{ owner_agent_id: string }[]>`
      SELECT owner_agent_id FROM kernel.routines WHERE id = ${ROUTINE}`
    const [skill] = await sql<{ owner_agent_id: string }[]>`
      SELECT owner_agent_id FROM kernel.skills WHERE id = ${SKILL}`
    expect(routine.owner_agent_id).toBe(SPARE)
    expect(skill.owner_agent_id).toBe(SPARE)
    const audits = await sql<{ action: string }[]>`
      SELECT action FROM kernel.audit_log WHERE org_id = ${ORG} AND action = 'asset_owner_agent_changed'`
    expect(audits.length).toBe(2)
  })

  it("archives once nothing blocks it", async () => {
    const res = await archive(LEAVING)
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect((body.data ?? body).blocked).toBe(false)
    const [row] = await sql<{ archived_at: string | null }[]>`
      SELECT archived_at FROM kernel.agents WHERE id = ${LEAVING}`
    expect(row.archived_at).not.toBe(null)
  })

  it("a routines:write holder cannot retarget another user's routine", async () => {
    const res = await reassignAs(() => memberToken, "routines", ADMIN_ROUTINE2, MEMBER_AGENT)
    expect(res.status).toBe(403)
    const [row] = await sql<{ owner_agent_id: string }[]>`
      SELECT owner_agent_id FROM kernel.routines WHERE id = ${ADMIN_ROUTINE2}`
    expect(row.owner_agent_id).toBe(ADMIN_AGENT2)
  })

  it("a routines:write holder cannot hand their own routine to a role agent", async () => {
    const res = await reassignAs(() => memberToken, "routines", MEMBER_ROUTINE, SPARE)
    expect(res.status).toBe(403)
    const [row] = await sql<{ owner_agent_id: string }[]>`
      SELECT owner_agent_id FROM kernel.routines WHERE id = ${MEMBER_ROUTINE}`
    expect(row.owner_agent_id).toBe(MEMBER_AGENT)
  })

  it("an agents:admin holder can hand their own routine to a role agent", async () => {
    const res = await reassign("routines", ADMIN_ROUTINE2, SPARE)
    expect(res.status).toBe(200)
    const [row] = await sql<{ owner_agent_id: string }[]>`
      SELECT owner_agent_id FROM kernel.routines WHERE id = ${ADMIN_ROUTINE2}`
    expect(row.owner_agent_id).toBe(SPARE)
  })

  it("an agent of another org is not archivable from here", async () => {
    const res = await archive(OTHER_ORG_AGENT)
    expect(res.status).toBe(404)
  })

  it("never names another org's routines or skills when refusing", async () => {
    const res = await archive(OTHER_ORG_AGENT)
    expect(res.status).toBe(404)
    const text = await res.text()
    expect(text).not.toContain(`ar-foreign-routine-${tag}`)
    expect(text).not.toContain(`ar-foreign-skill-${tag}`)
    expect(text).not.toContain(FOREIGN_ROUTINE)
    expect(text).not.toContain(FOREIGN_SKILL)
  })
})
