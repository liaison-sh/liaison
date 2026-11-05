// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FX4-2: a ROLE agent's region must actually flush.
//
// The flush resolved an RLS actor from the agent's owning human, and a role or
// system agent has none: it returned false before any write, while the region
// marker advanced all the same. The region was recorded as flushed and its
// facts were never written, for the life of the agent. It runs as a system
// actor instead and writes the AGENT's rows, with the tags still the union of
// the region's own message scopes (no privileged bypass of the tagging).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { CompactionTestAccess } from "~/modules/agent/context/compaction"
import { flushRegion, type RegionMessage } from "~/modules/agent/memory/consolidation"

const ORG_ID = crypto.randomUUID()
const USER_A = crypto.randomUUID()
const ROLE_AGENT_ID = crypto.randomUUID()
const THREAD_ID = crypto.randomUUID()
const tag = ORG_ID.slice(0, 8)
const MODEL_ID = `fx4-flush-${tag}`

const FLUSH_PATH = "project/flushed-by-the-role-agent.md"
let restoreKey: (() => void) | null = null

function region(): RegionMessage[] {
  return [
    {
      id: crypto.randomUUID(),
      content: "The Tuesday pickup window moved to 16:00.",
      createdAt: new Date(),
      requiredScopes: ["boxtal:shipments:read"],
      disclosureList: null,
      authorType: "user",
      authorId: USER_A,
    },
    {
      id: crypto.randomUUID(),
      content: "Noted, I will remember that.",
      createdAt: new Date(),
      requiredScopes: [],
      disclosureList: null,
      authorType: "agent",
      authorId: null,
    },
  ]
}

describe("a role agent's region flushes to its own tree", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG_ID}, 'RoleFlushOrg', ${`role-flush-${tag}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER_A}, ${ORG_ID}, ${`roleflush-${tag}@test.com`}, 'Flush Human', 'x')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${ROLE_AGENT_ID}, ${ORG_ID}, 'role', ${`roleflush${tag}`}, 'Logistics', '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, created_by)
      VALUES (${THREAD_ID}, ${ORG_ID}, ${`roleflushthread${tag}`}, ${USER_A})`
    // The cheapest auto eligible model, so the flush gets past model selection.
    await sql`INSERT INTO kernel.model_pricing
        (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, source)
      VALUES ('openai', ${MODEL_ID}, 'Flush Cheap', 0.00000001, 0.00000001, 100000, true, 'manual')`
    // No provider call is made: the generate seam below replaces it. The key
    // only has to RESOLVE, which is what the credit pre-check asks for.
    if (!process.env.OPENAI_API_KEY) {
      process.env.OPENAI_API_KEY = "sk-fx4-flush-test"
      restoreKey = () => {
        process.env.OPENAI_API_KEY = undefined
      }
    }
    CompactionTestAccess.setMemoryFlushGenerate(async ({ writeFile }) => {
      await writeFile(FLUSH_PATH, "The Tuesday pickup window is 16:00.")
    })
  })

  afterAll(async () => {
    CompactionTestAccess.setMemoryFlushGenerate()
    restoreKey?.()
    await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID}`
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
  })

  it("writes the flushed file into the role agent's tree with the region's tags", async () => {
    const result = await flushRegion(
      { orgId: ORG_ID, agentId: ROLE_AGENT_ID, threadId: THREAD_ID, closeReason: "quiet" },
      region(),
    )
    expect(result.flushed).toBe(true)

    const [row] = await sql<
      Array<{ owner_agent_id: string | null; user_id: string | null; required_scopes: string[] }>
    >`SELECT owner_agent_id, user_id, required_scopes FROM kernel.agent_memory
        WHERE org_id = ${ORG_ID} AND type = 'project' AND name = 'flushed-by-the-role-agent'`
    expect(row).toBeDefined()
    expect(row.owner_agent_id).toBe(ROLE_AGENT_ID)
    expect(row.user_id).toBeNull()
    // The union of the region's own message scopes, sorted: the tagging is the
    // same one every other memory write uses.
    expect(row.required_scopes).toEqual(["boxtal:shipments:read"])
  })
})
