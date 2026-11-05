// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agentSkillIndex } from "~/db/schema/kernel/agent-skill-index"
import { agents } from "~/db/schema/kernel/agents"
import { users } from "~/db/schema/kernel/users"
import { handleCreateSkill, handleDeleteSkill } from "~/modules/agent/tools/skills-routines-tools"
import { createAppContext } from "~/modules/apps/context"

const ORG_ID = "00000000-0000-0000-0000-e10000000001"

async function makeUser(): Promise<string> {
  // Distinct `name` per call: createPersonalAgent derives the agent handle
  // from it, and the same handle for two users in this org would collide on
  // agents_org_handle_idx — an unrelated unique violation that handleCreateSkill's
  // broad `isUniqueViolation` catch would otherwise mislabel as a skill
  // name_conflict.
  const suffix = crypto.randomUUID()
  return withSystemDb("skill-index-test-seed-user", async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        orgId: ORG_ID,
        email: `skill-index-${suffix}@t.co`,
        passwordHash: "x",
        name: `Skill Index User ${suffix}`,
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
}

async function ctxFor(userId: string) {
  return withRlsContext(
    { actorType: "user", userId, orgId: ORG_ID, scopes: [], dimensionGrants: {} },
    async (tx) => ({
      ...createAppContext("kernel", userId, ORG_ID, tx, "user", userId),
      scopes: [] as string[],
    }),
  )
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'Skill Index Org', 'skill-index-org') ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agent_skill_index WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("SKILL INDEX", () => {
  it("handleCreateSkill inserts exactly one agent_skill_index row, keyed to the creator's personal agent", async () => {
    const userId = await makeUser()
    const ctx = await ctxFor(userId)

    const result = await handleCreateSkill(
      {
        name: "skill-index-create-test",
        description: "d",
        body: "b",
        visibility: "personal",
        requiredScopes: [],
      },
      ctx,
    )
    if (!("skill" in result)) throw new Error(`expected success, got ${JSON.stringify(result)}`)
    const ownerAgentId = result.skill.ownerAgentId
    if (!ownerAgentId) throw new Error("expected a resolved ownerAgentId")

    const [personalAgent] = await withPrivilegedDb(ORG_ID, "skill-index-test-read-agent", (tx) =>
      tx.select().from(agents).where(eq(agents.ownerUserId, userId)),
    )
    expect(personalAgent?.id).toBe(ownerAgentId)

    const rows = await withPrivilegedDb(ORG_ID, "skill-index-test-read", (tx) =>
      tx.select().from(agentSkillIndex).where(eq(agentSkillIndex.skillId, result.skill.id)),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.agentId).toBe(ownerAgentId)
    expect(rows[0]?.skillName).toBe("skill-index-create-test")
  })

  it("handleDeleteSkill removes its agent_skill_index row", async () => {
    const userId = await makeUser()
    const ctx = await ctxFor(userId)

    const created = await handleCreateSkill(
      {
        name: "skill-index-delete-test",
        description: "d",
        body: "b",
        visibility: "personal",
        requiredScopes: [],
      },
      ctx,
    )
    if (!("skill" in created)) throw new Error(`expected success, got ${JSON.stringify(created)}`)

    await handleDeleteSkill({ id: created.skill.id }, ctx)

    const rows = await withPrivilegedDb(ORG_ID, "skill-index-test-read-2", (tx) =>
      tx.select().from(agentSkillIndex).where(eq(agentSkillIndex.skillId, created.skill.id)),
    )
    expect(rows.length).toBe(0)
  })
})
