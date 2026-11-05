// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agentSkillIndex } from "~/db/schema/kernel/agent-skill-index"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"
import { skills } from "~/db/schema/kernel/skills"
import { users } from "~/db/schema/kernel/users"
import { resolveRoute } from "./routing"

const ORG_ID = "00000000-0000-0000-0000-e20000000001"
const AGENT_ID = "00000000-0000-0000-0000-e20000000002"
const USER_ID = "00000000-0000-0000-0000-e20000000003"
const TIE_AGENT_A_ID = "00000000-0000-0000-0000-e20000000004"
const TIE_AGENT_B_ID = "00000000-0000-0000-0000-e20000000005"
const UNRELATED_AGENT_ID = "00000000-0000-0000-0000-e20000000006"
const ROUTINE_OWNER_AGENT_ID = "00000000-0000-0000-0000-e20000000007"
const ARCHIVED_SKILL_AGENT_ID = "00000000-0000-0000-0000-e20000000008"
const MIXED_TIE_ROUTINE_AGENT_ID = "00000000-0000-0000-0000-e20000000009"

async function makeRoutineOwnerUser(): Promise<string> {
  return withSystemDb("routing-test-seed-user", async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        orgId: ORG_ID,
        email: `routing-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Routine Owner",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'Routing Org', 'routing-org') ON CONFLICT DO NOTHING`
  await withPrivilegedDb(ORG_ID, "routing-test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values({
        id: AGENT_ID,
        orgId: ORG_ID,
        kind: "role",
        handle: "routing-agent",
        displayName: "Routing Agent",
      })
      .onConflictDoNothing()
    const [skillRow] = await tx
      .insert(skills)
      .values({
        orgId: ORG_ID,
        ownerAgentId: AGENT_ID,
        name: "routing-test-capability",
        description: "d",
        body: "b",
        createdByActorType: "user",
      })
      .returning()
    await tx.insert(agentSkillIndex).values({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      skillId: skillRow.id,
      skillName: skillRow.name,
    })

    await tx
      .insert(agents)
      .values([
        {
          id: TIE_AGENT_A_ID,
          orgId: ORG_ID,
          kind: "role",
          handle: "routing-tie-agent-a",
          displayName: "Routing Tie Agent A",
        },
        {
          id: TIE_AGENT_B_ID,
          orgId: ORG_ID,
          kind: "role",
          handle: "routing-tie-agent-b",
          displayName: "Routing Tie Agent B",
        },
        {
          id: UNRELATED_AGENT_ID,
          orgId: ORG_ID,
          kind: "role",
          handle: "routing-unrelated-agent",
          displayName: "Routing Unrelated Agent",
        },
      ])
      .onConflictDoNothing()

    const [tieSkillA] = await tx
      .insert(skills)
      .values({
        orgId: ORG_ID,
        ownerAgentId: TIE_AGENT_A_ID,
        name: "routing-tie-capability",
        description: "d",
        body: "b",
        createdByActorType: "user",
      })
      .returning()
    const [tieSkillB] = await tx
      .insert(skills)
      .values({
        orgId: ORG_ID,
        ownerAgentId: TIE_AGENT_B_ID,
        name: "routing-tie-capability",
        description: "d",
        body: "b",
        createdByActorType: "user",
      })
      .returning()
    const [unrelatedSkill] = await tx
      .insert(skills)
      .values({
        orgId: ORG_ID,
        ownerAgentId: UNRELATED_AGENT_ID,
        name: "routing-unrelated-capability",
        description: "d",
        body: "b",
        createdByActorType: "user",
      })
      .returning()

    await tx.insert(agentSkillIndex).values([
      {
        orgId: ORG_ID,
        agentId: TIE_AGENT_A_ID,
        skillId: tieSkillA.id,
        skillName: tieSkillA.name,
      },
      {
        orgId: ORG_ID,
        agentId: TIE_AGENT_B_ID,
        skillId: tieSkillB.id,
        skillName: tieSkillB.name,
      },
      {
        orgId: ORG_ID,
        agentId: UNRELATED_AGENT_ID,
        skillId: unrelatedSkill.id,
        skillName: unrelatedSkill.name,
      },
    ])
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agent_skill_index WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.skills WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("ROUTING", () => {
  it("a capability name owned by exactly one agent resolves to that agent with kind single", async () => {
    const result = await resolveRoute(ORG_ID, USER_ID, "routing-test-capability")
    expect(result).toEqual({ kind: "single", agentId: AGENT_ID })
  })

  it("a capability name owned by zero agents resolves to kind none", async () => {
    const result = await resolveRoute(ORG_ID, USER_ID, "routing-test-capability-does-not-exist")
    expect(result).toEqual({ kind: "none" })
  })

  it("two agents each owning a skill of the same name resolves to kind tie with both agent ids present, no others", async () => {
    const result = await resolveRoute(ORG_ID, USER_ID, "routing-tie-capability")
    expect(result.kind).toBe("tie")
    if (result.kind !== "tie") throw new Error("expected kind tie")
    expect(result.candidateAgentIds).toHaveLength(2)
    expect(new Set(result.candidateAgentIds)).toEqual(new Set([TIE_AGENT_A_ID, TIE_AGENT_B_ID]))
    expect(result.candidateAgentIds).not.toContain(UNRELATED_AGENT_ID)
  })

  it("a capability name owned by exactly one agent's routine resolves to that agent with kind single", async () => {
    const ownerUserId = await makeRoutineOwnerUser()
    await withPrivilegedDb(ORG_ID, "routing-test-seed-routine-owner-agent", async (tx) => {
      await tx
        .insert(agents)
        .values({
          id: ROUTINE_OWNER_AGENT_ID,
          orgId: ORG_ID,
          kind: "role",
          handle: "routing-routine-owner-agent",
          displayName: "Routing Routine Owner Agent",
        })
        .onConflictDoNothing()
      await tx.insert(routines).values({
        orgId: ORG_ID,
        ownerUserId,
        ownerAgentId: ROUTINE_OWNER_AGENT_ID,
        name: "routing-test-routine-capability",
        description: "d",
        kind: "recurring",
        cron: "*/5 * * * *",
        timezone: "UTC",
        prompt: "do the thing",
        scopes: [],
        visibility: "shared",
        createdByActorType: "user",
      })
    })

    const result = await resolveRoute(ORG_ID, USER_ID, "routing-test-routine-capability")
    expect(result).toEqual({ kind: "single", agentId: ROUTINE_OWNER_AGENT_ID })
  })

  it("a routine whose owner_agent_id is still NULL (pre-backfill) never resolves: kind none", async () => {
    const ownerUserId = await makeRoutineOwnerUser()
    await withPrivilegedDb(ORG_ID, "routing-test-seed-null-owner-routine", async (tx) => {
      await tx.insert(routines).values({
        orgId: ORG_ID,
        ownerUserId,
        ownerAgentId: null,
        name: "routing-null-owner-routine-capability",
        description: "d",
        kind: "recurring",
        cron: "*/5 * * * *",
        timezone: "UTC",
        prompt: "do the thing",
        scopes: [],
        visibility: "shared",
        createdByActorType: "user",
      })
    })

    const result = await resolveRoute(ORG_ID, USER_ID, "routing-null-owner-routine-capability")
    expect(result).toEqual({ kind: "none" })
  })

  it("a skill match and a NULL-owner routine match never tie — the NULL-owner side is excluded", async () => {
    const ownerUserId = await makeRoutineOwnerUser()
    await withPrivilegedDb(ORG_ID, "routing-test-seed-mixed-null-tie", async (tx) => {
      const [mixedSkill] = await tx
        .insert(skills)
        .values({
          orgId: ORG_ID,
          ownerAgentId: AGENT_ID,
          name: "routing-mixed-null-capability",
          description: "d",
          body: "b",
          createdByActorType: "user",
        })
        .returning()
      await tx.insert(agentSkillIndex).values({
        orgId: ORG_ID,
        agentId: AGENT_ID,
        skillId: mixedSkill.id,
        skillName: mixedSkill.name,
      })
      await tx.insert(routines).values({
        orgId: ORG_ID,
        ownerUserId,
        ownerAgentId: null,
        name: "routing-mixed-null-capability",
        description: "d",
        kind: "recurring",
        cron: "*/5 * * * *",
        timezone: "UTC",
        prompt: "do the thing",
        scopes: [],
        visibility: "shared",
        createdByActorType: "user",
      })
    })

    const result = await resolveRoute(ORG_ID, USER_ID, "routing-mixed-null-capability")
    expect(result).toEqual({ kind: "single", agentId: AGENT_ID })
  })

  it("a skill match and a routine match on different agents ties, both candidates present", async () => {
    const ownerUserId = await makeRoutineOwnerUser()
    await withPrivilegedDb(ORG_ID, "routing-test-seed-mixed-tie", async (tx) => {
      await tx
        .insert(agents)
        .values({
          id: MIXED_TIE_ROUTINE_AGENT_ID,
          orgId: ORG_ID,
          kind: "role",
          handle: "routing-mixed-tie-routine-agent",
          displayName: "Routing Mixed Tie Routine Agent",
        })
        .onConflictDoNothing()
      const [mixedTieSkill] = await tx
        .insert(skills)
        .values({
          orgId: ORG_ID,
          ownerAgentId: AGENT_ID,
          name: "routing-mixed-tie-capability",
          description: "d",
          body: "b",
          createdByActorType: "user",
        })
        .returning()
      await tx.insert(agentSkillIndex).values({
        orgId: ORG_ID,
        agentId: AGENT_ID,
        skillId: mixedTieSkill.id,
        skillName: mixedTieSkill.name,
      })
      await tx.insert(routines).values({
        orgId: ORG_ID,
        ownerUserId,
        ownerAgentId: MIXED_TIE_ROUTINE_AGENT_ID,
        name: "routing-mixed-tie-capability",
        description: "d",
        kind: "recurring",
        cron: "*/5 * * * *",
        timezone: "UTC",
        prompt: "do the thing",
        scopes: [],
        visibility: "shared",
        createdByActorType: "user",
      })
    })

    const result = await resolveRoute(ORG_ID, USER_ID, "routing-mixed-tie-capability")
    expect(result.kind).toBe("tie")
    if (result.kind !== "tie") throw new Error("expected kind tie")
    expect(new Set(result.candidateAgentIds)).toEqual(
      new Set([AGENT_ID, MIXED_TIE_ROUTINE_AGENT_ID]),
    )
  })

  it("an archived agent's skill never resolves: kind none", async () => {
    await withPrivilegedDb(ORG_ID, "routing-test-seed-archived-agent", async (tx) => {
      await tx
        .insert(agents)
        .values({
          id: ARCHIVED_SKILL_AGENT_ID,
          orgId: ORG_ID,
          kind: "role",
          handle: "routing-archived-agent",
          displayName: "Routing Archived Agent",
          archivedAt: new Date(),
        })
        .onConflictDoNothing()
      const [archivedSkill] = await tx
        .insert(skills)
        .values({
          orgId: ORG_ID,
          ownerAgentId: ARCHIVED_SKILL_AGENT_ID,
          name: "routing-archived-agent-capability",
          description: "d",
          body: "b",
          createdByActorType: "user",
        })
        .returning()
      await tx.insert(agentSkillIndex).values({
        orgId: ORG_ID,
        agentId: ARCHIVED_SKILL_AGENT_ID,
        skillId: archivedSkill.id,
        skillName: archivedSkill.name,
      })
    })

    const result = await resolveRoute(ORG_ID, USER_ID, "routing-archived-agent-capability")
    expect(result).toEqual({ kind: "none" })
  })
})
