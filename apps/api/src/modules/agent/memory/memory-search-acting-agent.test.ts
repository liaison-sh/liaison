// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX3-1: memory_search and memory_open as TOOLS must key on the ACTING AGENT.
//
// The auto recall path (memory-recall.ts) already passes the turn's agent, so
// every turn recalls its own tree. The TOOL path did not: `executeToolHandler`
// put no acting agent id on the tool ctx, so `memorySearch` fell through to
// `eq(agent_memory.user_id, ctx.userId)` and a ROLE agent calling memory_search
// from its own turn searched the HUMAN's files and never its own. The tail it
// reads MEMORY.md from is keyed by `owner_agent_id`, so the two halves of one
// turn disagreed about whose memory the agent has.
//
// The fix is one field: `ctx.actingAgentId`, resolved by execute-tool exactly
// as every audit and approval row already resolves it, read by the two tools.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import type { ActorContext } from "~/db/rls"
import { executeTool } from "~/modules/apps/execute-tool"

const ORG_ID = crypto.randomUUID()
const HUMAN_ID = crypto.randomUUID()
const ROLE_AGENT_ID = crypto.randomUUID()
const PERSONAL_AGENT_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)

/** One word that appears in BOTH trees, so only the key can tell them apart. */
const SHARED_TERM = "kryptonite"
const ROLE_PATH = "reference/role-carrier.md"
const HUMAN_PATH = "reference/human-carrier.md"

const actor: ActorContext = {
  actorType: "user",
  userId: HUMAN_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function writeMemoryRow(params: {
  ownerAgentId: string
  userId: string | null
  name: string
  path: string
  description: string
}): Promise<void> {
  await sql`INSERT INTO kernel.agent_memory
      (org_id, user_id, owner_agent_id, type, name, description, content, required_scopes, path, source_kind)
    VALUES (${ORG_ID}, ${params.userId}, ${params.ownerAgentId}, 'reference', ${params.name},
            ${params.description}, ${`The ${SHARED_TERM} carrier account is on file.`}, '{}'::text[],
            ${params.path}, 'agent')`
}

async function searchAs(agentId: string | undefined): Promise<string[]> {
  const result = await executeTool<{ hits: Array<{ path?: string }> }>({
    toolName: "kernel:memory_search",
    orgId: ORG_ID,
    actor,
    params: { query: SHARED_TERM },
    ...(agentId ? { agentId } : {}),
  })
  return (result.data.hits ?? []).map((h) => h.path ?? "").filter(Boolean)
}

describe("memory search keys on the acting agent", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'ActingAgentOrg', ${`acting-agent-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${HUMAN_ID}, ${ORG_ID}, ${`acting-${tag}@test.com`}, 'Acting Human', 'x')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${PERSONAL_AGENT_ID}, ${ORG_ID}, 'personal', ${`actingpersonal${tag}`}, 'Liaison', ${HUMAN_ID}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${ROLE_AGENT_ID}, ${ORG_ID}, 'role', ${`actingrole${tag}`}, 'Logistics', '["*"]'::jsonb)`

    // The role agent's own file: no owning human at all, which is what a role
    // agent's memory looks like.
    await writeMemoryRow({
      ownerAgentId: ROLE_AGENT_ID,
      userId: null,
      name: "role-carrier",
      path: ROLE_PATH,
      description: "The role agent's own carrier note",
    })
    // The human's file, reachable only by the legacy user_id key.
    await writeMemoryRow({
      ownerAgentId: PERSONAL_AGENT_ID,
      userId: HUMAN_ID,
      name: "human-carrier",
      path: HUMAN_PATH,
      description: "The human's own carrier note",
    })

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

  it("a role agent calling memory_search finds its own file and not the human's", async () => {
    const paths = await searchAs(ROLE_AGENT_ID)
    expect(paths).toContain(ROLE_PATH)
    expect(paths).not.toContain(HUMAN_PATH)
  })

  it("a call with no acting agent still reads the caller's own tree", async () => {
    const paths = await searchAs(undefined)
    expect(paths).toContain(HUMAN_PATH)
    expect(paths).not.toContain(ROLE_PATH)
  })
})
