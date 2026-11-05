// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { skills } from "~/db/schema/kernel/skills"

const ORG_A = "00000000-0000-0000-0000-d00000000001"
const USER_ADMIN = "00000000-0000-0000-0000-d00000000002"
const USER_OWNER = "00000000-0000-0000-0000-d00000000003"
const USER_OTHER = "00000000-0000-0000-0000-d00000000004"

const ROLE_AGENT = "00000000-0000-0000-0000-d00000000005"
const PERSONAL_AGENT_OWNER = "00000000-0000-0000-0000-d00000000006"
const PERSONAL_AGENT_OTHER = "00000000-0000-0000-0000-d00000000007"

function rlsCtx(userId: string, scopes: string[] = []): UserContext {
  return { actorType: "user", userId, orgId: ORG_A, scopes, dimensionGrants: {} }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_A}, 'Skills Ownership RLS Org', 'skills-ownership-rls-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_ADMIN}, ${ORG_A}, 'skills-rls-admin@test.com', 'Skills RLS Admin', 'active', 1) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_OWNER}, ${ORG_A}, 'skills-rls-owner@test.com', 'Skills RLS Owner', 'active', 1) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_OTHER}, ${ORG_A}, 'skills-rls-other@test.com', 'Skills RLS Other', 'active', 1) ON CONFLICT DO NOTHING`

  await withPrivilegedDb(ORG_A, "test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values({
        id: ROLE_AGENT,
        orgId: ORG_A,
        kind: "role",
        handle: "support-rls",
        displayName: "Support Agent RLS",
      })
      .onConflictDoNothing()
    await tx
      .insert(agents)
      .values({
        id: PERSONAL_AGENT_OWNER,
        orgId: ORG_A,
        kind: "personal",
        handle: "owner-agent-rls",
        displayName: "Owner Personal Agent RLS",
        ownerUserId: USER_OWNER,
      })
      .onConflictDoNothing()
    await tx
      .insert(agents)
      .values({
        id: PERSONAL_AGENT_OTHER,
        orgId: ORG_A,
        kind: "personal",
        handle: "other-agent-rls",
        displayName: "Other Personal Agent RLS",
        ownerUserId: USER_OTHER,
      })
      .onConflictDoNothing()
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_A}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_A}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_A}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_A}`
})

describe("SKILLS RLS", () => {
  it("a non-admin cannot INSERT a skill owned by a role agent", async () => {
    await expect(
      withRlsContext(rlsCtx(USER_OWNER, ["kernel:skills:write"]), async (tx) => {
        return tx
          .insert(skills)
          .values({
            orgId: ORG_A,
            ownerAgentId: ROLE_AGENT,
            name: "role-owned-skill-non-admin",
            description: "d",
            body: "b",
            createdByActorType: "user",
          })
          .returning({ id: skills.id })
      }),
    ).rejects.toThrow()
  })

  it("a personal agent's owner can INSERT a skill owned by their own personal agent", async () => {
    const rows = await withRlsContext(rlsCtx(USER_OWNER, ["kernel:skills:write"]), async (tx) => {
      return tx
        .insert(skills)
        .values({
          orgId: ORG_A,
          ownerAgentId: PERSONAL_AGENT_OWNER,
          name: "owner-owned-skill",
          description: "d",
          body: "b",
          createdByActorType: "user",
        })
        .returning({ id: skills.id })
    })

    expect(rows.length).toBe(1)
  })

  it("a personal agent's owner cannot INSERT a skill owned by SOMEONE ELSE's personal agent", async () => {
    await expect(
      withRlsContext(rlsCtx(USER_OWNER, ["kernel:skills:write"]), async (tx) => {
        return tx
          .insert(skills)
          .values({
            orgId: ORG_A,
            ownerAgentId: PERSONAL_AGENT_OTHER,
            name: "other-owned-skill",
            description: "d",
            body: "b",
            createdByActorType: "user",
          })
          .returning({ id: skills.id })
      }),
    ).rejects.toThrow()
  })
})
