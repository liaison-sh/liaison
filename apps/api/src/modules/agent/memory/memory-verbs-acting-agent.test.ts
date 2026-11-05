// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX4-1: the six memory VERBS and the three user_memory_* aliases as TOOLS must
// key on the ACTING AGENT, exactly as memory_search does since FX3-1.
//
// The verbs resolved the owner from the CALLER's personal agent, so a role
// agent writing its own memory from its own turn dropped the file into the
// human operator's tree: invisible to the agent on the next turn (the tail
// reads MEMORY.md by owner_agent_id) and visible to the human, who never wrote
// it. One key for the whole turn is the invariant.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"

const ORG_ID = crypto.randomUUID()
const HUMAN_ID = crypto.randomUUID()
const ROLE_AGENT_ID = crypto.randomUUID()
const PERSONAL_AGENT_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

const ROLE_PATH = "project/role-written.md"

const actor: ActorContext = {
  actorType: "user",
  userId: HUMAN_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function callAs<T>(
  toolName: string,
  params: Record<string, unknown>,
  agentId?: string,
): Promise<T> {
  const result = await executeTool<T>({
    toolName,
    orgId: ORG_ID,
    actor,
    params,
    ...(agentId ? { agentId } : {}),
  })
  return result.data
}

async function topicRows(): Promise<
  Array<{ name: string; owner_agent_id: string | null; user_id: string | null }>
> {
  return await sql<Array<{ name: string; owner_agent_id: string | null; user_id: string | null }>>`
    SELECT name, owner_agent_id, user_id FROM kernel.agent_memory
    WHERE org_id = ${ORG_ID} AND type = 'project'`
}

describe("memory verbs key on the acting agent", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'VerbActingOrg', ${`verb-acting-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${HUMAN_ID}, ${ORG_ID}, ${`verbacting-${tag}@test.com`}, 'Verb Human', 'x')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${PERSONAL_AGENT_ID}, ${ORG_ID}, 'personal', ${`verbpersonal${tag}`}, 'Liaison', ${HUMAN_ID}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${ROLE_AGENT_ID}, ${ORG_ID}, 'role', ${`verbrole${tag}`}, 'Logistics', '["*"]'::jsonb)`

    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(ORG_ID)
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("memory_create from a role agent lands in the role agent tree, not the human one", async () => {
    await callAs(
      "kernel:memory_create",
      { path: ROLE_PATH, body: "Pickups move to Tuesday." },
      ROLE_AGENT_ID,
    )

    const rows = await topicRows()
    expect(rows.length).toBe(1)
    expect(rows[0].owner_agent_id).toBe(ROLE_AGENT_ID)
    // The human's tree is untouched: no row keyed on the operator at all.
    expect(rows[0].user_id).toBeNull()
  })

  it("memory_view in the same turn lists the file the role agent just wrote", async () => {
    const viewed = await callAs<{ entries: string[] }>(
      "kernel:memory_view",
      { path: "project" },
      ROLE_AGENT_ID,
    )
    expect(viewed.entries.some((entry) => entry.endsWith("role-written.md"))).toBe(true)
  })

  it("a call with no acting agent still writes the caller's own tree", async () => {
    await callAs("kernel:memory_create", { path: "project/human-written.md", body: "Mine." })
    const [row] = await sql<Array<{ owner_agent_id: string | null; user_id: string | null }>>`
      SELECT owner_agent_id, user_id FROM kernel.agent_memory
      WHERE org_id = ${ORG_ID} AND type = 'project' AND name = 'human-written'`
    expect(row.owner_agent_id).toBe(PERSONAL_AGENT_ID)
    expect(row.user_id).toBe(HUMAN_ID)
  })
})
