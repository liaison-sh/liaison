// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agentSkillIndex } from "~/db/schema/kernel/agent-skill-index"
import { agents } from "~/db/schema/kernel/agents"
import { skills } from "~/db/schema/kernel/skills"
import { resolveEffectiveSkillIndex } from "./effective-skills"

const ORG_ID = "00000000-0000-0000-0000-e20000000001"
const BASE_AGENT_ID = "00000000-0000-0000-0000-e20000000002"
const TARGET_AGENT_ID = "00000000-0000-0000-0000-e20000000003"
const OTHER_AGENT_ID = "00000000-0000-0000-0000-e20000000004"

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'Effective Skills Org', 'effective-skills-org') ON CONFLICT DO NOTHING`
  await withPrivilegedDb(ORG_ID, "effective-skills-test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values([
        {
          id: BASE_AGENT_ID,
          orgId: ORG_ID,
          kind: "system",
          handle: "@base",
          displayName: "Base",
        },
        {
          id: TARGET_AGENT_ID,
          orgId: ORG_ID,
          kind: "role",
          handle: "effective-skills-target",
          displayName: "Target Agent",
        },
        {
          id: OTHER_AGENT_ID,
          orgId: ORG_ID,
          kind: "role",
          handle: "effective-skills-other",
          displayName: "Other Agent",
        },
      ])
      .onConflictDoNothing()

    const [ownSkill] = await tx
      .insert(skills)
      .values({
        orgId: ORG_ID,
        ownerAgentId: TARGET_AGENT_ID,
        name: "effective-skills-own",
        description: "d",
        body: "b",
        createdByActorType: "user",
      })
      .returning()
    const [baseSkill] = await tx
      .insert(skills)
      .values({
        orgId: ORG_ID,
        ownerAgentId: BASE_AGENT_ID,
        name: "effective-skills-base",
        description: "d",
        body: "b",
        createdByActorType: "user",
      })
      .returning()
    const [otherSkill] = await tx
      .insert(skills)
      .values({
        orgId: ORG_ID,
        ownerAgentId: OTHER_AGENT_ID,
        name: "effective-skills-unrelated",
        description: "d",
        body: "b",
        createdByActorType: "user",
      })
      .returning()

    await tx.insert(agentSkillIndex).values([
      {
        orgId: ORG_ID,
        agentId: TARGET_AGENT_ID,
        skillId: ownSkill.id,
        skillName: ownSkill.name,
      },
      {
        orgId: ORG_ID,
        agentId: BASE_AGENT_ID,
        skillId: baseSkill.id,
        skillName: baseSkill.name,
      },
      {
        orgId: ORG_ID,
        agentId: OTHER_AGENT_ID,
        skillId: otherSkill.id,
        skillName: otherSkill.name,
      },
    ])
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agent_skill_index WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("EFFECTIVE SKILLS", () => {
  it("an agent's effective skill index includes both its own skill and @base's common-base skills", async () => {
    const result = await resolveEffectiveSkillIndex(TARGET_AGENT_ID, ORG_ID)
    const skillNames = result.map((r) => r.skillName).sort()
    expect(skillNames).toContain("effective-skills-own")
    expect(skillNames).toContain("effective-skills-base")
  })

  it("an agent's effective skill index does NOT include a skill owned by an unrelated third agent", async () => {
    const result = await resolveEffectiveSkillIndex(TARGET_AGENT_ID, ORG_ID)
    const skillNames = result.map((r) => r.skillName)
    expect(skillNames).not.toContain("effective-skills-unrelated")
  })
})
