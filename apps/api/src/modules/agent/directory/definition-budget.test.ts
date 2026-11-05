// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE COMPOSED DEFINITION'S BUDGET, measured through the HTTP route the
// desktop actually calls.
//
// What this exists to catch: a local session appended the composed definition
// to the system prompt of EVERY turn, and the composition shipped two kinds of
// content whole. Every skill body the agent owned, and the ENTIRE MCP catalog
// with each tool's full description (478 tools, about 60,000 tokens, on a
// personal agent holding `*`). The in-app turn stopped paying for either: it
// carries the hot tool set with tool search for the rest, and a skills index
// with `skill_read` for the rest. This pins that the definition carries the
// same shape, and the second assertion is the red half: it composes what the
// OLD composition would have been, from the same live registry and the same
// seeded skills, and shows it does not fit.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { estimateTokens } from "~/modules/agent/context/compaction"
import {
  AGENT_DEFINITION_TOKEN_CAP,
  type AgentDefinition,
  estimateAgentDefinitionTokens,
} from "~/modules/agent/context/context"
import { registerKernelAgentTools } from "~/modules/agent/tools/kernel-tools"
import { ALL_DEFERRED_TOOLS_UNLOCKED } from "~/modules/agent/tools/tool-bridge"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { listMcpTools } from "~/modules/mcp/tool-projection"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

/** A realistic personal agent's playbook shelf: many skills, none of them short. */
const SKILL_COUNT = 30
const SKILL_BODY_CHARS = 4000
const BODY_MARKER = "SKILL_BODY_MARKER"

describe("GET /api/agents/:agentId/definition budget", () => {
  let session: minimal.Session
  let agentId: string
  let actor: UserContext

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    session = await minimal.session(org.id, { role: "admin" })
    // The tools have to be REAL: a budget measured against an empty registry
    // would pass whatever the composition did with a catalog.
    await ensureAppsForOrg(session.orgId)
    await registerKernelAgentTools(session.orgId)

    const [agent] =
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id, system_prompt)
      VALUES (${session.orgId}, 'personal', '@budget', 'Budget Agent', '["*"]'::jsonb, ${session.userId}, 'BUDGET_AGENT_PROMPT')
      RETURNING id`
    agentId = agent.id
    for (let i = 0; i < SKILL_COUNT; i++) {
      const name = `budget-skill-${String(i).padStart(2, "0")}`
      const body = `${BODY_MARKER}-${i}-`.padEnd(SKILL_BODY_CHARS, "x").slice(0, SKILL_BODY_CHARS)
      await sql`INSERT INTO kernel.skills (org_id, owner_agent_id, name, description, body, created_by_actor_type)
        VALUES (${session.orgId}, ${agentId}, ${name}, ${`what ${name} is for`}, ${body}, 'user')`
    }
    actor = {
      actorType: "user",
      userId: session.userId,
      orgId: session.orgId,
      scopes: ["*"],
      dimensionGrants: {},
    }
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.skills WHERE org_id = ${session.orgId}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${session.orgId}`
    await releaseTestLock()
  })

  async function fetchDefinition(): Promise<AgentDefinition> {
    const res = await app.request(`/api/agents/${agentId}/definition`, {
      headers: { Authorization: `Bearer ${session.bearer}` },
    })
    expect(res.status).toBe(200)
    return ((await res.json()) as { data: AgentDefinition }).data
  }

  it("composes a definition under the token cap, as an index of skills and the hot tool set", async () => {
    const def = await fetchDefinition()

    expect(def.skillIndex.length).toBe(SKILL_COUNT)
    // An INDEX: every skill is named, no body rides anywhere in the payload.
    expect(def.skillIndex.map((s) => s.name)).toContain("budget-skill-00")
    expect(JSON.stringify(def)).not.toContain(BODY_MARKER)

    // The hot set only. `kernel__tool_search` is the door to the rest and is
    // itself hot, so a session that lost the catalog lost nothing reachable.
    expect(def.mcpToolList.map((t) => t.name)).toContain("kernel__tool_search")
    const gateway = await listMcpTools(
      { orgId: session.orgId, actor, agentId },
      ALL_DEFERRED_TOOLS_UNLOCKED,
    )
    expect(gateway.length).toBeGreaterThan(100)
    expect(def.mcpToolList.length).toBeLessThan(gateway.length / 4)
    for (const tool of def.mcpToolList) {
      expect(gateway.some((g) => g.name === tool.name)).toBe(true)
    }

    expect(estimateAgentDefinitionTokens(def)).toBeLessThanOrEqual(AGENT_DEFINITION_TOKEN_CAP)
  })

  it("the composition this replaced does not fit the cap", async () => {
    // The old shape, rebuilt from the same live registry and the same seeded
    // rows: every own skill body whole, plus every tool with its full
    // description. This is the assertion that fails if the route ever goes back
    // to shipping content instead of indexes.
    const gateway = await listMcpTools(
      { orgId: session.orgId, actor, agentId },
      ALL_DEFERRED_TOOLS_UNLOCKED,
    )
    const bodies =
      await sql`SELECT name, body FROM kernel.skills WHERE org_id = ${session.orgId} AND owner_agent_id = ${agentId}`
    const old = [
      ...bodies.map((r) => `## Skill: ${r.name as string}\n${r.body as string}`),
      ...gateway.map((t) => `${t.name}: ${t.description}`),
    ].join("\n\n")
    expect(estimateTokens(old)).toBeGreaterThan(AGENT_DEFINITION_TOKEN_CAP)
  })
})
