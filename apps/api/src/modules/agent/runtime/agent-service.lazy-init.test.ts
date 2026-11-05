// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { runAgentChat } from "~/modules/agent/runtime/agent-service"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const ORG_ID = "00000000-0000-0000-0000-000000ac1001"
const USER_ID = "00000000-0000-0000-0000-000000ac1002"
const THREAD_ID = "00000000-0000-0000-0000-000000ac1003"

describe("agent-service lazy org init", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'LazyInitOrg', 'lazy-init-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'lazy-init@test.com', 'Lazy Init User')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'lazy-init-thread', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0.00000000', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter')`
  })

  beforeEach(() => {
    resetAppRegistries()
  })

  afterAll(async () => {
    resetAppRegistries()
    await releaseTestLock()
  })

  it("initializes org tools lazily on the first agent request", async () => {
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"

    try {
      const actor = {
        actorType: "user" as const,
        userId: USER_ID,
        orgId: ORG_ID,
        scopes: ["*"],
        dimensionGrants: {},
      }

      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "Check my tools",
        actor,
        orgId: ORG_ID,
      })

      expect(result.userMessageId).toBeDefined()
      expect(toolRegistry.get([ORG_ID, "kernel", "threads_list"])).toBeDefined()
      expect(toolRegistry.get([ORG_ID, "kernel", "threads_search"])).toBeDefined()
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })
})
