// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"
import { users } from "~/db/schema/kernel/users"
import { OffboardCrossOrgError, OffboardForbiddenError, offboardUser } from "./offboard"

const ORG_ID = "00000000-0000-0000-0000-a26000000001"

async function makeUser(): Promise<string> {
  const id = await withSystemDb("offboard-test-seed-user", async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        orgId: ORG_ID,
        email: `offboard-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Owner",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  return id
}

async function makePersonalAgent(userId: string): Promise<string> {
  const id = await withPrivilegedDb(ORG_ID, "offboard-test-seed-agent", async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        orgId: ORG_ID,
        kind: "personal",
        handle: `@offboard-${crypto.randomUUID()}`,
        displayName: "Liaison",
        ownerUserId: userId,
      })
      .returning({ id: agents.id })
    return row.id
  })
  return id
}

async function makeRoutine(
  agentId: string,
  userId: string,
  name: string,
  visibility: "personal" | "shared",
): Promise<string> {
  const id = await withPrivilegedDb(ORG_ID, "offboard-test-seed-routine", async (tx) => {
    const [row] = await tx
      .insert(routines)
      .values({
        orgId: ORG_ID,
        ownerUserId: userId,
        ownerAgentId: agentId,
        name,
        description: "d",
        kind: "recurring",
        cron: "*/5 * * * *",
        timezone: "UTC",
        prompt: "do the thing",
        scopes: ["kernel:threads:write"],
        visibility,
        createdByActorType: "user",
      })
      .returning()
    return row.id
  })
  return id
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'Offboard Org', 'offboard-org') ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.routines WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
})

describe("OFFBOARD", () => {
  it("offboarding a user with no blocking assets archives their personal agent and pauses its routines", async () => {
    const userId = await makeUser()
    const agentId = await makePersonalAgent(userId)
    const routineId = await makeRoutine(agentId, userId, "personal-routine", "personal")

    const report = await offboardUser(ORG_ID, userId, ["kernel:users:admin"])

    expect(report.archived).toBe(true)

    const [agentRow] = await withSystemDb("offboard-test-read-agent", (tx) =>
      tx.select().from(agents).where(eq(agents.id, agentId)),
    )
    expect(agentRow?.archivedAt).not.toBeNull()

    const [routineRow] = await withSystemDb("offboard-test-read-routine", (tx) =>
      tx.select().from(routines).where(eq(routines.id, routineId)),
    )
    expect(routineRow).toBeDefined()
    expect(routineRow?.status).toBe("paused_user")
  })

  it("offboarding a user whose personal agent owns a shared routine does NOT archive the agent, and the report names the blocking routine", async () => {
    const userId = await makeUser()
    const agentId = await makePersonalAgent(userId)
    const routineId = await makeRoutine(agentId, userId, "shared-blocking-routine", "shared")

    const report = await offboardUser(ORG_ID, userId, ["kernel:users:admin"])

    expect(report.archived).toBe(false)
    expect(
      report.blockingRoutines.some(
        (r) => r.id === routineId && r.name === "shared-blocking-routine",
      ),
    ).toBe(true)

    const [agentRow] = await withSystemDb("offboard-test-read-agent-2", (tx) =>
      tx.select().from(agents).where(eq(agents.id, agentId)),
    )
    expect(agentRow?.archivedAt).toBeNull()
  })

  it("an actor without kernel:users:admin (or '*') is refused, the agent stays unarchived", async () => {
    const userId = await makeUser()
    const agentId = await makePersonalAgent(userId)

    await expect(offboardUser(ORG_ID, userId, [])).rejects.toThrow(OffboardForbiddenError)
    await expect(offboardUser(ORG_ID, userId, ["kernel:agents:admin"])).rejects.toThrow(
      OffboardForbiddenError,
    )

    const [agentRow] = await withSystemDb("offboard-test-read-refused-agent", (tx) =>
      tx.select().from(agents).where(eq(agents.id, agentId)),
    )
    expect(agentRow?.archivedAt).toBeNull()
  })

  it("a user whose personal agent belongs to a DIFFERENT org than the caller's is refused", async () => {
    const otherOrgId = "00000000-0000-0000-0000-a26000000099"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${otherOrgId}, 'Other Offboard Org', 'other-offboard-org') ON CONFLICT DO NOTHING`
    const foreignUserId = await withSystemDb("offboard-test-seed-foreign-user", async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          orgId: otherOrgId,
          email: `offboard-foreign-${crypto.randomUUID()}@t.co`,
          passwordHash: "x",
          name: "Foreign Owner",
          status: "active",
        })
        .returning({ id: users.id })
      return u.id
    })
    const foreignAgentId = await withPrivilegedDb(
      otherOrgId,
      "offboard-test-seed-foreign-agent",
      async (tx) => {
        const [row] = await tx
          .insert(agents)
          .values({
            orgId: otherOrgId,
            kind: "personal",
            handle: "@offboard-foreign",
            displayName: "Liaison",
            ownerUserId: foreignUserId,
          })
          .returning({ id: agents.id })
        return row.id
      },
    )

    await expect(offboardUser(ORG_ID, foreignUserId, ["kernel:users:admin"])).rejects.toThrow(
      OffboardCrossOrgError,
    )

    const [agentRow] = await withSystemDb("offboard-test-read-foreign-agent", (tx) =>
      tx.select().from(agents).where(eq(agents.id, foreignAgentId)),
    )
    expect(agentRow?.archivedAt).toBeNull()

    await sql`DELETE FROM kernel.agents WHERE org_id = ${otherOrgId}`
    await sql`DELETE FROM kernel.users WHERE id = ${foreignUserId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${otherOrgId}`
  })
})
