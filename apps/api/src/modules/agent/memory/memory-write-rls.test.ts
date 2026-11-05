// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who may write a shared (role/system) agent's memory at the RLS layer
// (migrations 0057, 0147): a holder of kernel:agents:admin or a scope above it.
// A plain member reads what its scopes cover and writes nothing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { agentMemory } from "~/db/schema/kernel"

const ORG = "00000000-0000-0000-0000-a1e300000001"
const MEMBER = "00000000-0000-0000-0000-a1e300000002"
const ROLE_AGENT = "00000000-0000-0000-0000-a1e300000003"
const OTHER_AGENT = "00000000-0000-0000-0000-a1e300000004"

function member(scopes: string[]) {
  return {
    actorType: "user" as const,
    userId: MEMBER,
    orgId: ORG,
    scopes,
    dimensionGrants: {},
  }
}

const row = (name: string) => ({
  orgId: ORG,
  ownerAgentId: ROLE_AGENT,
  type: "project",
  name,
  description: "d",
  content: "c",
  requiredScopes: [] as string[],
})

describe("agent memory write authority (RLS)", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Mem RLS', 'mem-rls-a1e3') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status) VALUES (${MEMBER}, ${ORG}, 'mem-rls@test.local', 'M', 'active') ON CONFLICT (id) DO NOTHING`
    for (const [id, handle] of [
      [ROLE_AGENT, "@mem-rls-role"],
      [OTHER_AGENT, "@mem-rls-other"],
    ]) {
      await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name)
        VALUES (${id}, ${ORG}, 'role', ${handle}, 'R') ON CONFLICT (id) DO NOTHING`
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("refuses a plain member writing a role agent's memory", async () => {
    await expect(
      withRlsContext(member(["kernel:agent:memory"]), (tx) =>
        tx.insert(agentMemory).values(row("member-write")),
      ),
    ).rejects.toThrow()
  })

  it("lets an agents admin, or a holder of a scope above it, write a role agent's memory", async () => {
    await withRlsContext(member(["kernel:agents:admin"]), (tx) =>
      tx.insert(agentMemory).values(row("admin-write")),
    )
    // Hierarchical, like the route's hasScope: `kernel:agents` covers :admin.
    await withRlsContext(member(["kernel:agents"]), (tx) =>
      tx.insert(agentMemory).values(row("agents-scope-write")),
    )
    // A turn's memory naming the agent changes nothing for a member.
    await expect(
      withRlsContext(member(["kernel:agent:memory"]), async (tx) => {
        await tx.execute(drizzleSql`SELECT set_config('app.current_agent_id', ${ROLE_AGENT}, true)`)
        await tx.insert(agentMemory).values(row("self-claimed-write"))
      }),
    ).rejects.toThrow()
  })

  it("keeps the legacy bridge: a user writes their own owner-less rows", async () => {
    await withRlsContext(member(["kernel:agent:memory"]), (tx) =>
      tx.insert(agentMemory).values({ ...row("legacy"), ownerAgentId: null, userId: MEMBER }),
    )
  })

  it("lets an agents admin edit it; a member's update and delete touch nothing", async () => {
    const touched = await withRlsContext(member(["kernel:agent:memory"]), (tx) =>
      tx
        .update(agentMemory)
        .set({ content: "rewritten" })
        .where(eq(agentMemory.name, "admin-write"))
        .returning({ id: agentMemory.id }),
    )
    expect(touched).toHaveLength(0)
    const deleted = await withRlsContext(member(["kernel:agent:memory"]), (tx) =>
      tx.delete(agentMemory).where(eq(agentMemory.name, "admin-write")).returning(),
    )
    expect(deleted).toHaveLength(0)

    const admin = await withRlsContext(member(["kernel:agents"]), (tx) =>
      tx
        .update(agentMemory)
        .set({ content: "admin edit" })
        .where(eq(agentMemory.name, "admin-write"))
        .returning({ id: agentMemory.id }),
    )
    expect(admin).toHaveLength(1)
  })
})
