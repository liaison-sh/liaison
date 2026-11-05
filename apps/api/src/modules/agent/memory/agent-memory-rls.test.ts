// SPDX-License-Identifier: FSL-1.1-ALv2
// NOTE: the blueprint names this file agent-memory-rls.test.ex.ts; that
// extension would not be collected by the bun test runner (it only picks up
// *.test.ts), so this is authored as .test.ts instead. Noted as a deviation
// from the blueprint's literal filename.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agentMemory, agents } from "~/db/schema/kernel"

const ORG_A = "00000000-0000-0000-0000-d00000000001"

const USER_A = "00000000-0000-0000-0000-d00000000002"
const USER_B = "00000000-0000-0000-0000-d00000000003"

const PERSONAL_AGENT_A = "00000000-0000-0000-0000-d00000000004"
const PERSONAL_AGENT_B = "00000000-0000-0000-0000-d00000000005"
const ROLE_AGENT = "00000000-0000-0000-0000-d00000000006"

const MEMORY_PERSONAL_A = "00000000-0000-0000-0000-d00000000007"
const MEMORY_ROLE = "00000000-0000-0000-0000-d00000000008"
const MEMORY_LEGACY_A = "00000000-0000-0000-0000-d00000000009"

const REQUIRED_SCOPE = "kernel:logistics:read"
const ADMIN_SCOPE = "kernel:agents:admin"

function rlsCtx(userId: string, scopes: string[] = []): UserContext {
  return { actorType: "user", userId, orgId: ORG_A, scopes, dimensionGrants: {} }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_A}, 'Agent Memory RLS Org', 'agent-memory-rls-org') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_A}, ${ORG_A}, 'amr-usera@test.com', 'Agent Memory RLS User A', 'active', 1) ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_B}, ${ORG_A}, 'amr-userb@test.com', 'Agent Memory RLS User B', 'active', 1) ON CONFLICT DO NOTHING`

  await withPrivilegedDb(ORG_A, "test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values({
        id: PERSONAL_AGENT_A,
        orgId: ORG_A,
        kind: "personal",
        handle: "amr-personal-a",
        displayName: "User A's Personal Agent",
        ownerUserId: USER_A,
      })
      .onConflictDoNothing()
    await tx
      .insert(agents)
      .values({
        id: PERSONAL_AGENT_B,
        orgId: ORG_A,
        kind: "personal",
        handle: "amr-personal-b",
        displayName: "User B's Personal Agent",
        ownerUserId: USER_B,
      })
      .onConflictDoNothing()
    await tx
      .insert(agents)
      .values({
        id: ROLE_AGENT,
        orgId: ORG_A,
        kind: "role",
        handle: "amr-logistics",
        displayName: "Logistics Agent",
      })
      .onConflictDoNothing()

    await tx
      .insert(agentMemory)
      .values({
        id: MEMORY_PERSONAL_A,
        orgId: ORG_A,
        ownerAgentId: PERSONAL_AGENT_A,
        userId: USER_A,
        type: "user",
        name: "memory-personal-a",
        description: "personal memory for user A",
        content: "user A personal memory content",
        requiredScopes: [],
      })
      .onConflictDoNothing()

    await tx
      .insert(agentMemory)
      .values({
        id: MEMORY_ROLE,
        orgId: ORG_A,
        ownerAgentId: ROLE_AGENT,
        type: "reference",
        name: "memory-role",
        description: "role agent memory",
        content: "logistics agent reference memory content",
        requiredScopes: [REQUIRED_SCOPE],
      })
      .onConflictDoNothing()

    // LEGACY row: owner_agent_id IS NULL, user_id = USER_A. This is the
    // pre-0055 row shape every user who existed before personal agents
    // shipped is stuck with (0055's backfill only matches a user who already
    // has a personal agent of kind 'personal'; registration is the only path
    // that creates one, so a pre-existing user's rows are never backfilled).
    await tx
      .insert(agentMemory)
      .values({
        id: MEMORY_LEGACY_A,
        orgId: ORG_A,
        ownerAgentId: null,
        userId: USER_A,
        type: "user",
        name: "memory-legacy-a",
        description: "legacy pre-agent memory for user A",
        content: "legacy user A memory content",
        requiredScopes: [],
      })
      .onConflictDoNothing()
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_A}`
  await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_A}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_A}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_A}`
})

describe("AGENT MEMORY RLS", () => {
  it("AGENT MEMORY RLS: user A CAN select their own personal agent's memory row", async () => {
    const rows = await withRlsContext(rlsCtx(USER_A), async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_PERSONAL_A))
    })
    expect(rows.length).toBe(1)
  })

  it("AGENT MEMORY RLS: user A CANNOT select user B's personal agent's memory row", async () => {
    let memoryPersonalB: string
    await withPrivilegedDb(ORG_A, "test-seed-b", async (tx) => {
      const [row] = await tx
        .insert(agentMemory)
        .values({
          orgId: ORG_A,
          ownerAgentId: PERSONAL_AGENT_B,
          userId: USER_B,
          type: "user",
          name: "memory-personal-b",
          description: "personal memory for user B",
          content: "user B personal memory content",
          requiredScopes: [],
        })
        .onConflictDoNothing()
        .returning({ id: agentMemory.id })
      memoryPersonalB = row?.id ?? MEMORY_PERSONAL_A
    })

    const rows = await withRlsContext(rlsCtx(USER_A), async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.ownerAgentId, PERSONAL_AGENT_B))
    })
    expect(rows.length).toBe(0)
  })

  it("AGENT MEMORY RLS: a caller holding the required scope CAN select a role agent's memory row", async () => {
    const rows = await withRlsContext(rlsCtx(USER_A, [REQUIRED_SCOPE]), async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_ROLE))
    })
    expect(rows.length).toBe(1)
  })

  it("AGENT MEMORY RLS: a caller lacking the required scope CANNOT select a role agent's memory row", async () => {
    const rows = await withRlsContext(rlsCtx(USER_A, ["kernel:tickets:read"]), async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_ROLE))
    })
    expect(rows.length).toBe(0)
  })

  it("AGENT MEMORY RLS: a caller holding the wildcard scope CAN select a role agent's memory row", async () => {
    const rows = await withRlsContext(rlsCtx(USER_A, ["*"]), async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_ROLE))
    })
    expect(rows.length).toBe(1)
  })

  it("AGENT MEMORY RLS: an archived personal agent's owner can no longer select its memory rows", async () => {
    // The exact SELECT that the first test proved worked must now return 0
    // rows once the owning personal agent is archived.
    await withPrivilegedDb(ORG_A, "test-archive", async (tx) => {
      await tx.update(agents).set({ archivedAt: new Date() }).where(eq(agents.id, PERSONAL_AGENT_A))
    })

    const rows = await withRlsContext(rlsCtx(USER_A), async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_PERSONAL_A))
    })
    expect(rows.length).toBe(0)

    // Un-archive so later tests in this file are unaffected.
    await withPrivilegedDb(ORG_A, "test-unarchive", async (tx) => {
      await tx.update(agents).set({ archivedAt: null }).where(eq(agents.id, PERSONAL_AGENT_A))
    })
  })

  it("AGENT MEMORY RLS: the same rows are still readable via the privileged path, proving retention not deletion", async () => {
    await withPrivilegedDb(ORG_A, "test-archive-retain", async (tx) => {
      await tx.update(agents).set({ archivedAt: new Date() }).where(eq(agents.id, PERSONAL_AGENT_A))
    })

    const rows = await withPrivilegedDb(ORG_A, "test-privileged-read", async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_PERSONAL_A))
    })
    expect(rows.length).toBe(1)

    await withPrivilegedDb(ORG_A, "test-unarchive-retain", async (tx) => {
      await tx.update(agents).set({ archivedAt: null }).where(eq(agents.id, PERSONAL_AGENT_A))
    })
  })

  // Regression coverage for the critical defect: migration 0057's legacy
  // bridge clause must restore the pre-0056 predicate for owner_agent_id IS
  // NULL rows. This case FAILS before 0057 is applied (the row is invisible
  // to everyone, owner included) and PASSES after.
  it("AGENT MEMORY RLS: user A CAN select their own legacy (owner_agent_id NULL) memory row", async () => {
    const rows = await withRlsContext(rlsCtx(USER_A), async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_LEGACY_A))
    })
    expect(rows.length).toBe(1)
  })

  it("AGENT MEMORY RLS: user B CANNOT select user A's legacy (owner_agent_id NULL) memory row", async () => {
    const rows = await withRlsContext(rlsCtx(USER_B), async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_LEGACY_A))
    })
    expect(rows.length).toBe(0)
  })

  it("AGENT MEMORY RLS: user A can UPDATE their own legacy memory row", async () => {
    const rows = await withRlsContext(rlsCtx(USER_A), async (tx) => {
      return tx
        .update(agentMemory)
        .set({ content: "legacy user A memory content, updated" })
        .where(eq(agentMemory.id, MEMORY_LEGACY_A))
        .returning({ content: agentMemory.content })
    })
    expect(rows.length).toBe(1)
    expect(rows[0]?.content).toBe("legacy user A memory content, updated")

    // Restore so later assertions (and re-runs) see the original content.
    await withPrivilegedDb(ORG_A, "test-legacy-restore", async (tx) => {
      await tx
        .update(agentMemory)
        .set({ content: "legacy user A memory content" })
        .where(eq(agentMemory.id, MEMORY_LEGACY_A))
    })
  })

  it("AGENT MEMORY RLS: user A can DELETE their own legacy memory row", async () => {
    let legacyId: string
    await withPrivilegedDb(ORG_A, "test-legacy-delete-seed", async (tx) => {
      const [row] = await tx
        .insert(agentMemory)
        .values({
          orgId: ORG_A,
          ownerAgentId: null,
          userId: USER_A,
          type: "user",
          name: "memory-legacy-a-deletable",
          description: "legacy row for delete coverage",
          content: "delete me",
          requiredScopes: [],
        })
        .returning({ id: agentMemory.id })
      legacyId = row.id
    })

    const deleted = await withRlsContext(rlsCtx(USER_A), async (tx) => {
      return tx
        .delete(agentMemory)
        .where(eq(agentMemory.id, legacyId))
        .returning({ id: agentMemory.id })
    })
    expect(deleted.length).toBe(1)

    const remaining = await withPrivilegedDb(ORG_A, "test-legacy-delete-verify", async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, legacyId))
    })
    expect(remaining.length).toBe(0)
  })

  // Fix 2: role/system memory writes require kernel:agents:admin (or the
  // wildcard). Must fail without the guard: a plain org member with no
  // agents-admin scope could otherwise write the logistics agent's memory,
  // which is a prompt-injection surface since that memory is injected into
  // the role agent's turns.
  it("AGENT MEMORY RLS: a non-admin org member CANNOT insert a role agent's memory row", async () => {
    await expect(
      withRlsContext(rlsCtx(USER_A, ["kernel:tickets:read"]), async (tx) => {
        await tx.insert(agentMemory).values({
          orgId: ORG_A,
          ownerAgentId: ROLE_AGENT,
          type: "reference",
          name: "memory-role-injected",
          description: "attempted unauthorized write",
          content: "malicious content",
          requiredScopes: [],
        })
      }),
    ).rejects.toThrow()
  })

  it("AGENT MEMORY RLS: a caller holding kernel:agents:admin CAN insert a role agent's memory row", async () => {
    let insertedId: string
    await withRlsContext(rlsCtx(USER_A, [ADMIN_SCOPE]), async (tx) => {
      const [row] = await tx
        .insert(agentMemory)
        .values({
          orgId: ORG_A,
          ownerAgentId: ROLE_AGENT,
          type: "reference",
          name: "memory-role-admin-write",
          description: "admin-authored role memory",
          content: "admin content",
          requiredScopes: [],
        })
        .returning({ id: agentMemory.id })
      insertedId = row.id
    })

    const rows = await withPrivilegedDb(ORG_A, "test-role-admin-verify", async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, insertedId))
    })
    expect(rows.length).toBe(1)
  })

  it("AGENT MEMORY RLS: a non-admin org member CANNOT update a role agent's memory row", async () => {
    const updated = await withRlsContext(rlsCtx(USER_A, ["kernel:tickets:read"]), async (tx) => {
      return tx
        .update(agentMemory)
        .set({ content: "tampered" })
        .where(eq(agentMemory.id, MEMORY_ROLE))
        .returning({ id: agentMemory.id })
    })
    expect(updated.length).toBe(0)

    const unchanged = await withPrivilegedDb(ORG_A, "test-role-update-verify", async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_ROLE))
    })
    expect(unchanged[0]?.content).toBe("logistics agent reference memory content")
  })

  it("AGENT MEMORY RLS: a non-admin org member CANNOT delete a role agent's memory row", async () => {
    const deleted = await withRlsContext(rlsCtx(USER_A, ["kernel:tickets:read"]), async (tx) => {
      return tx
        .delete(agentMemory)
        .where(eq(agentMemory.id, MEMORY_ROLE))
        .returning({ id: agentMemory.id })
    })
    expect(deleted.length).toBe(0)

    const stillThere = await withPrivilegedDb(ORG_A, "test-role-delete-verify", async (tx) => {
      return tx.select().from(agentMemory).where(eq(agentMemory.id, MEMORY_ROLE))
    })
    expect(stillThere.length).toBe(1)
  })
})
