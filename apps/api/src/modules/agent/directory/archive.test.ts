// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel/agents"
import { routines } from "~/db/schema/kernel/routines"
import { skills } from "~/db/schema/kernel/skills"
import { users } from "~/db/schema/kernel/users"
import {
  ArchiveCrossOrgError,
  ArchiveForbiddenError,
  archiveAgent,
  checkArchiveBlockers,
} from "./archive"

const ORG_ID = "00000000-0000-0000-0000-a25000000001"

async function makeAgent(handle: string): Promise<string> {
  const id = await withPrivilegedDb(ORG_ID, "archive-test-seed-agent", async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({ orgId: ORG_ID, kind: "role", handle, displayName: handle })
      .returning({ id: agents.id })
    return row.id
  })
  return id
}

async function makeUser(): Promise<string> {
  const id = await withSystemDb("archive-test-seed-user", async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({
        orgId: ORG_ID,
        email: `archive-${crypto.randomUUID()}@t.co`,
        passwordHash: "x",
        name: "Owner",
        status: "active",
      })
      .returning({ id: users.id })
    return u.id
  })
  return id
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'Archive Blockers Org', 'archive-blockers-org') ON CONFLICT DO NOTHING`
})

afterAll(async () => {
  for (const orgId of [ORG_ID]) {
    await sql`DELETE FROM kernel.agent_skill_index WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.routines WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.skills WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${orgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${orgId}`
  }
})

describe("ARCHIVE", () => {
  it("an agent owning a shared routine is blocked, the routine is named in the blocking list", async () => {
    const agentId = await makeAgent("archive-routine-owner")
    const userId = await makeUser()

    const routineId = await withPrivilegedDb(ORG_ID, "archive-test-seed-routine", async (tx) => {
      const [row] = await tx
        .insert(routines)
        .values({
          orgId: ORG_ID,
          ownerUserId: userId,
          ownerAgentId: agentId,
          name: "shared-blocking-routine",
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

    const result = await checkArchiveBlockers(agentId, ORG_ID)

    expect(result.blocked).toBe(true)
    expect(
      result.routines.some((r) => r.id === routineId && r.name === "shared-blocking-routine"),
    ).toBe(true)
  })

  it("an agent with only personal, unreferenced skills archives successfully and disables those skills", async () => {
    const agentId = await makeAgent("archive-personal-skills-owner")

    const skillId = await withPrivilegedDb(ORG_ID, "archive-test-seed-skill", async (tx) => {
      const [row] = await tx
        .insert(skills)
        .values({
          orgId: ORG_ID,
          ownerAgentId: agentId,
          name: "archive-personal-skill",
          description: "d",
          body: "b",
          createdByActorType: "user",
        })
        .returning()
      return row.id
    })

    await archiveAgent(ORG_ID, agentId, ["kernel:agents:admin"])

    const [agentRow] = await withSystemDb("archive-test-read-agent", (tx) =>
      tx.select().from(agents).where(eq(agents.id, agentId)),
    )
    const [skillRow] = await withSystemDb("archive-test-read-skill", (tx) =>
      tx.select().from(skills).where(eq(skills.id, skillId)),
    )

    expect(agentRow?.archivedAt).not.toBeNull()
    expect(skillRow?.enabled).toBe(false)
  })

  it("an actor without kernel:agents:admin (or '*') is refused, the agent stays unarchived", async () => {
    const agentId = await makeAgent("archive-refused-no-admin-scope")

    await expect(archiveAgent(ORG_ID, agentId, [])).rejects.toThrow(ArchiveForbiddenError)
    await expect(archiveAgent(ORG_ID, agentId, ["kernel:users:admin"])).rejects.toThrow(
      ArchiveForbiddenError,
    )

    const [agentRow] = await withSystemDb("archive-test-read-refused-agent", (tx) =>
      tx.select().from(agents).where(eq(agents.id, agentId)),
    )
    expect(agentRow?.archivedAt).toBeNull()
  })

  it("an agent belonging to a DIFFERENT org than the caller's is refused, even with admin scope", async () => {
    const otherOrgId = "00000000-0000-0000-0000-a25000000099"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${otherOrgId}, 'Other Archive Org', 'other-archive-org') ON CONFLICT DO NOTHING`
    const foreignAgentId = await withPrivilegedDb(
      otherOrgId,
      "archive-test-seed-foreign-agent",
      async (tx) => {
        const [row] = await tx
          .insert(agents)
          .values({
            orgId: otherOrgId,
            kind: "role",
            handle: "archive-foreign-agent",
            displayName: "Foreign Agent",
          })
          .returning({ id: agents.id })
        return row.id
      },
    )

    await expect(archiveAgent(ORG_ID, foreignAgentId, ["kernel:agents:admin"])).rejects.toThrow(
      ArchiveCrossOrgError,
    )

    const [agentRow] = await withSystemDb("archive-test-read-foreign-agent", (tx) =>
      tx.select().from(agents).where(eq(agents.id, foreignAgentId)),
    )
    expect(agentRow?.archivedAt).toBeNull()

    await sql`DELETE FROM kernel.agents WHERE org_id = ${otherOrgId}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${otherOrgId}`
  })
})
