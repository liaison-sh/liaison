// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"

const ORG_A = "00000000-0000-0000-0000-c00000000001"
const ORG_B = "00000000-0000-0000-0000-c00000000002"
const USER_A = "00000000-0000-0000-0000-c00000000003"

const AGENT_A = "00000000-0000-0000-0000-c00000000004"
const AGENT_B = "00000000-0000-0000-0000-c00000000005"
const PERSONAL_AGENT_A = "00000000-0000-0000-0000-c00000000006"

function rlsCtx(userId: string, orgId: string, scopes: string[] = []): UserContext {
  return { actorType: "user", userId, orgId, scopes, dimensionGrants: {} }
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_A}, 'Agents RLS Org A', 'agents-rls-org-a') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_B}, 'Agents RLS Org B', 'agents-rls-org-b') ON CONFLICT DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, auth_version) VALUES (${USER_A}, ${ORG_A}, 'agents-rls-usera@test.com', 'Agents RLS User A', 'active', 1) ON CONFLICT DO NOTHING`

  await withPrivilegedDb(ORG_A, "test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values({
        id: AGENT_A,
        orgId: ORG_A,
        kind: "role",
        handle: "support",
        displayName: "Support Agent A",
      })
      .onConflictDoNothing()
  })

  await withPrivilegedDb(ORG_B, "test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values({
        id: AGENT_B,
        orgId: ORG_B,
        kind: "role",
        handle: "support",
        displayName: "Support Agent B",
      })
      .onConflictDoNothing()
  })

  await withPrivilegedDb(ORG_A, "test-seed", async (tx) => {
    await tx
      .insert(agents)
      .values({
        id: PERSONAL_AGENT_A,
        orgId: ORG_A,
        kind: "personal",
        handle: "personal-user-a",
        displayName: "User A's Personal Agent",
        ownerUserId: USER_A,
      })
      .onConflictDoNothing()
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agents WHERE org_id IN (${ORG_A}, ${ORG_B})`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_A}`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_A}, ${ORG_B})`
})

describe("AGENTS RLS", () => {
  it("org member can select an agent in their own org", async () => {
    const rows = await withRlsContext(rlsCtx(USER_A, ORG_A), async (tx) => {
      return tx.select().from(agents).where(eq(agents.id, AGENT_A))
    })

    expect(rows.length).toBe(1)
  })

  it("org member cannot select an agent from a different org", async () => {
    const rows = await withRlsContext(rlsCtx(USER_A, ORG_A), async (tx) => {
      return tx.select().from(agents).where(eq(agents.id, AGENT_B))
    })

    expect(rows.length).toBe(0)
  })

  it("a non-admin cannot UPDATE a role agent's scopeCeiling", async () => {
    // A bare "non-admin gets 0 rows" does not discriminate: with NO
    // agents_update policy at all, everyone (including an admin) gets 0 rows
    // under FORCE RLS default-deny, so this assertion alone would pass both
    // before and after the fix. Pairing it with the admin-succeeds case makes
    // it a real test of per-kind write authority, not just "nothing works".
    const adminRows = await withRlsContext(
      rlsCtx(USER_A, ORG_A, ["kernel:agents:admin"]),
      async (tx) => {
        return tx
          .update(agents)
          .set({ scopeCeiling: ["kernel:tickets:write"] })
          .where(eq(agents.id, AGENT_A))
          .returning({ id: agents.id })
      },
    )
    expect(adminRows.length).toBe(1)

    // No agents_update policy exists yet (T02 deferred it), so this either
    // throws (WITH CHECK never matches) or silently affects 0 rows (USING
    // excludes the row) - both mean the write did not happen.
    let rows: Array<{ id: string }> = []
    try {
      rows = await withRlsContext(rlsCtx(USER_A, ORG_A, []), async (tx) => {
        return tx
          .update(agents)
          .set({ scopeCeiling: ["kernel:tickets:write", "kernel:tickets:read"] })
          .where(eq(agents.id, AGENT_A))
          .returning({ id: agents.id })
      })
    } catch {
      rows = []
    }

    expect(rows.length).toBe(0)
  })

  it("a personal agent's owner CAN update their own agent's displayName", async () => {
    const rows = await withRlsContext(rlsCtx(USER_A, ORG_A, []), async (tx) => {
      return tx
        .update(agents)
        .set({ displayName: "User A's Renamed Personal Agent" })
        .where(eq(agents.id, PERSONAL_AGENT_A))
        .returning({ id: agents.id })
    })

    expect(rows.length).toBe(1)
  })

  it("a personal agent's owner without kernel:agents:admin CANNOT widen their own agent's scopeCeiling (rename-only); an admin CAN", async () => {
    // 0052's WITH CHECK for the owner branch only pins archived_at — it says
    // nothing about scope_ceiling/system_prompt/tool_allowlist/tool_denylist,
    // so without 0053's BEFORE UPDATE trigger this UPDATE would succeed
    // (matching the USING/WITH CHECK's owner-or-admin org-match) and let an
    // owner holding zero agent scopes independently widen their own ceiling.
    let ownerRows: Array<{ id: string; scopeCeiling: string[] }> = []
    try {
      ownerRows = await withRlsContext(rlsCtx(USER_A, ORG_A, []), async (tx) => {
        return tx
          .update(agents)
          .set({ scopeCeiling: ["*"] })
          .where(eq(agents.id, PERSONAL_AGENT_A))
          .returning({ id: agents.id, scopeCeiling: agents.scopeCeiling })
      })
    } catch {
      ownerRows = []
    }
    expect(ownerRows.length).toBe(0)

    const [unchanged] = await withPrivilegedDb(ORG_A, "test-read-unchanged-ceiling", (tx) =>
      tx.select().from(agents).where(eq(agents.id, PERSONAL_AGENT_A)),
    )
    expect(unchanged?.scopeCeiling).not.toContain("*")

    const adminRows = await withRlsContext(
      rlsCtx(USER_A, ORG_A, ["kernel:agents:admin"]),
      async (tx) => {
        return tx
          .update(agents)
          .set({ scopeCeiling: ["kernel:tickets:write"] })
          .where(eq(agents.id, PERSONAL_AGENT_A))
          .returning({ id: agents.id, scopeCeiling: agents.scopeCeiling })
      },
    )
    expect(adminRows.length).toBe(1)
    expect(adminRows[0]?.scopeCeiling).toContain("kernel:tickets:write")
  })

  it("a personal agent's owner CANNOT archive their OWN agent without kernel:agents:admin", async () => {
    // Archive (setting archivedAt) requires kernel:agents:admin even for the
    // personal agent's own owner - only a rename is self-service. As with
    // the role-agent case above, "owner without admin gets 0 rows" alone
    // does not discriminate from "no policy exists at all" (everyone gets 0
    // rows either way), so this pairs it with the admin-succeeds case: an
    // admin CAN archive/offboard the same personal agent.
    let ownerRows: Array<{ id: string }> = []
    try {
      ownerRows = await withRlsContext(rlsCtx(USER_A, ORG_A, []), async (tx) => {
        return tx
          .update(agents)
          .set({ archivedAt: new Date() })
          .where(eq(agents.id, PERSONAL_AGENT_A))
          .returning({ id: agents.id })
      })
    } catch {
      ownerRows = []
    }
    expect(ownerRows.length).toBe(0)

    const adminRows = await withRlsContext(
      rlsCtx(USER_A, ORG_A, ["kernel:agents:admin"]),
      async (tx) => {
        return tx
          .update(agents)
          .set({ archivedAt: new Date() })
          .where(eq(agents.id, PERSONAL_AGENT_A))
          .returning({ id: agents.id })
      },
    )
    expect(adminRows.length).toBe(1)
  })
})
