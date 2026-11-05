// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Service-level E2E round trip through the real agents-kernel code against a
 * live test database: bootstrap, skill creation, scope-grant ceiling
 * recompute, and the two archive branches (purely personal vs. shared
 * asset). No mocked DB, no mocked services -- only `queueEvent`/`transaction`
 * are monkey-patched on the privileged connection, mirroring
 * personal-agent.test.ts, because this suite never boots the outbox worker.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { type RlsClient, sql } from "~/db"
import { __privileged_db__ as privilegedDb } from "~/db/connection"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agentSkillIndex } from "~/db/schema/kernel/agent-skill-index"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"
import { skills } from "~/db/schema/kernel/skills"
import { users } from "~/db/schema/kernel/users"
import { ArchiveBlockedError, archiveAgent } from "~/modules/agent/directory/archive"
import { createPersonalAgent } from "~/modules/agent/directory/personal-agent"
import { handleCreateSkill } from "~/modules/agent/tools/skills-routines-tools"
import { createAppContext } from "~/modules/apps/context"
import { bootstrapRegister } from "~/modules/auth/auth"
import { grantUserScope } from "~/modules/permissions/roles"
import { createScope } from "~/modules/permissions/types"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// Mirrors personal-agent.test.ts's setup: grantUserScope/archiveAgent run
// against the real privileged connection, whose `queueEvent` would otherwise
// try to talk to the real outbox this suite never boots.
const rlsDb = privilegedDb as unknown as RlsClient
;(rlsDb as any).queueEvent = async () => {}
const originalTransaction = (rlsDb as any).transaction.bind(rlsDb)
;(rlsDb as any).transaction = async (fn: any) => {
  return originalTransaction(async (tx: any) => {
    tx.queueEvent = async () => {}
    return fn(tx)
  })
}

const scopes = (...s: string[]) => s.map(createScope)

async function ctxFor(userId: string, orgId: string) {
  return withRlsContext(
    { actorType: "user", userId, orgId, scopes: [], dimensionGrants: {} },
    async (tx) => ({
      ...createAppContext("kernel", userId, orgId, tx, "user", userId),
      scopes: [] as string[],
    }),
  )
}

describe("AGENTS KERNEL E2E", () => {
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  let orgId: string
  let userId: string
  let personalAgentId: string
  let skillId: string
  let secondAgentId: string
  let routineId: string

  it("1: bootstrapRegister creates exactly one personal agent for the user and one @base system agent for the org", async () => {
    const admin = await bootstrapRegister(
      "kernel-e2e-bootstrap@test.com",
      "Passw0rd!",
      "Kernel E2E Admin",
    )
    orgId = admin.orgId
    userId = admin.userId

    const personalRows = await withSystemDb("kernel-e2e-read-personal", (tx) =>
      tx
        .select()
        .from(agents)
        .where(eq(agents.orgId, orgId))
        .then((rows) => rows.filter((r) => r.kind === "personal" && r.ownerUserId === userId)),
    )
    expect(personalRows.length).toBe(1)
    personalAgentId = personalRows[0]!.id

    const baseRows = await withSystemDb("kernel-e2e-read-base", (tx) =>
      tx
        .select()
        .from(agents)
        .where(eq(agents.orgId, orgId))
        .then((rows) => rows.filter((r) => r.kind === "system" && r.handle === "@base")),
    )
    expect(baseRows.length).toBe(1)
  })

  it("2: creating a skill through handleCreateSkill gives agent_skill_index exactly one row", async () => {
    const ctx = await ctxFor(userId, orgId)

    const result = await handleCreateSkill(
      {
        name: "kernel-e2e-skill",
        description: "d",
        body: "b",
        visibility: "personal",
        requiredScopes: [],
      },
      ctx,
    )
    if (!("skill" in result)) throw new Error(`expected success, got ${JSON.stringify(result)}`)
    expect(result.skill.ownerAgentId).toBe(personalAgentId)
    skillId = result.skill.id

    const rows = await withPrivilegedDb(orgId, "kernel-e2e-read-index", (tx) =>
      tx.select().from(agentSkillIndex).where(eq(agentSkillIndex.skillId, skillId)),
    )
    expect(rows.length).toBe(1)
    expect(rows[0]?.agentId).toBe(personalAgentId)
  })

  it("3: granting the user a new scope updates the personal agent's scopeCeiling with no explicit agent update from the test", async () => {
    await grantUserScope(rlsDb, {
      userId,
      orgId,
      scope: "test:kernel-e2e:granted",
      actorId: userId,
      actorScopes: scopes("*"),
      actorDimensionGrants: {},
    })

    const [row] = await sql`
      SELECT scope_ceiling FROM kernel.agents WHERE id = ${personalAgentId}
    `
    expect(row?.scope_ceiling as string[]).toContain("test:kernel-e2e:granted")
  })

  it("4: archiving the personal agent while it owns only an unreferenced skill succeeds and disables that skill", async () => {
    await archiveAgent(orgId, personalAgentId, ["kernel:agents:admin"])

    const [agentRow] = await withSystemDb("kernel-e2e-read-archived-agent", (tx) =>
      tx.select().from(agents).where(eq(agents.id, personalAgentId)),
    )
    expect(agentRow?.archivedAt).not.toBeNull()

    const [skillRow] = await withSystemDb("kernel-e2e-read-archived-skill", (tx) =>
      tx.select().from(skills).where(eq(skills.id, skillId)),
    )
    expect(skillRow?.enabled).toBe(false)
  })

  it("5: a second agent's shared routine owned by the first agent blocks re-archiving it, naming the routine", async () => {
    const secondUserId = await withSystemDb("kernel-e2e-seed-second-user", async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          orgId,
          email: `kernel-e2e-second-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Kernel E2E Second User",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })

    secondAgentId = await withSystemDb("kernel-e2e-seed-second-agent", async (tx) => {
      const agent = await createPersonalAgent(tx, {
        orgId,
        userId: secondUserId,
        email: `kernel-e2e-second-${secondUserId}@t.co`,
      })
      return agent.id
    })

    const secondPersonalRows = await withSystemDb("kernel-e2e-read-second-personal", (tx) =>
      tx
        .select()
        .from(agents)
        .where(eq(agents.orgId, orgId))
        .then((rows) =>
          rows.filter((r) => r.kind === "personal" && r.ownerUserId === secondUserId),
        ),
    )
    expect(secondPersonalRows.length).toBe(1)
    expect(secondPersonalRows[0]!.id).toBe(secondAgentId)

    routineId = await withPrivilegedDb(orgId, "kernel-e2e-seed-routine", async (tx) => {
      const [row] = await tx
        .insert(routines)
        .values({
          orgId,
          ownerUserId: secondUserId,
          ownerAgentId: personalAgentId,
          name: "kernel-e2e-shared-routine",
          description: "d",
          kind: "recurring",
          cron: "*/5 * * * *",
          timezone: "UTC",
          prompt: "do the thing",
          scopes: ["kernel:threads:write"],
          visibility: "shared",
          createdByActorType: "user",
        })
        .returning()
      return row.id
    })

    try {
      await archiveAgent(orgId, personalAgentId, ["kernel:agents:admin"])
      throw new Error("expected archiveAgent to reject")
    } catch (err) {
      expect(err).toBeInstanceOf(ArchiveBlockedError)
      const blocked = err as ArchiveBlockedError
      expect(
        blocked.routines.some((r) => r.id === routineId && r.name === "kernel-e2e-shared-routine"),
      ).toBe(true)
    }
  })
})
