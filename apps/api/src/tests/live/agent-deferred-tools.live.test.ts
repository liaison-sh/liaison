// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIVE e2e for the deferred-tool discovery loop with a REAL weak model
// (Gemini Flash-Lite over the Google API — the production auto-select model).
// This is the proof the instruction surface works end-to-end for a weak model:
// the agent starts with only core tools loaded, must read the system prompt's
// deferred catalog, call tool_search, then actually CALL the discovered app
// tool and answer from its real output — all while the per-step input stays
// small (the whole point of deferring the schema catalog).
//
// Skipped when GOOGLE_API_KEY is absent (mirrors real-gitlab.live.test.ts).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { toolRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const GOOGLE_KEY = process.env.GOOGLE_API_KEY

const ORG_ID = "00000000-0000-0000-0000-000000d60001"
const USER_ID = "00000000-0000-0000-0000-000000d60002"
const THREAD_ID = "00000000-0000-0000-0000-000000d60003"
const ITEM_TITLE = "Quantum Flux Capacitor QF-1138"
const MODEL_ID = "gemini-flash-lite-latest"

describe.skipIf(!GOOGLE_KEY)(
  "deferred tools — live weak-model discovery (Gemini Flash-Lite)",
  () => {
    beforeAll(async () => {
      await acquireTestLock()
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'LiveDeferredOrg', 'live-deferred-org')`
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'livedeferred@test.com', 'Live Deferred')`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, agent_model_id) VALUES (${THREAD_ID}, ${ORG_ID}, 'live-deferred-chat', 'agent_chat', ${USER_ID}, ${MODEL_ID})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
      await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')`
      await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('google', ${MODEL_ID}, 'Gemini Flash-Lite (live test)', '0.09', '0.35', 1048576, true, 'starter')
      ON CONFLICT DO NOTHING`
      // The `example` fixture app registers an items_list tool whose sandbox
      // bundle cannot load in this env (broken twin of test:listItems). A model
      // that picks it gets a hard error through no fault of the protocol, so
      // remove it from THIS org's registry. ensureAppsForOrg first (idempotent,
      // per-process) so the later runAgentChat call does not re-register it.
      await ensureAppsForOrg(ORG_ID)
      toolRegistry.deleteByPrefix([ORG_ID, "example"])
    })

    afterAll(async () => {
      await sql`DELETE FROM app_test.items WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.model_pricing WHERE model_id = ${MODEL_ID} AND display_name = 'Gemini Flash-Lite (live test)'`
      await releaseTestLock()
    })

    it("weak model, given a natural task naming NO TOOL, searches, calls the discovered tool, and answers from its output", async () => {
      // Seed the distinctive item the model can only know by CALLING the tool.
      await sql`INSERT INTO app_test.items (org_id, title, status, team, sensitivity)
        VALUES (${ORG_ID}, ${ITEM_TITLE}, 'open', 'alpha', 'public')`

      const msgId = "00000000-0000-0000-0000-000000d60010"
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${msgId}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user',
                'What items do we have in the test app right now? I need their exact titles.', '{}')`

      const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
      const result = await invokeAgentForThread(
        THREAD_ID,
        msgId,
        {
          userId: USER_ID,
          orgId: ORG_ID,
          scopes: ["*"],
          // The test app's RLS dimensions (membership `team`, level `sensitivity`)
          // hide rows from a no-grant actor — grant the seeded item's values.
          dimensionGrants: { "test:team": ["alpha"], "test:sensitivity": ["public"] },
        },
        ORG_ID,
      )
      expect(result.finishReason).not.toBe("error")

      const msgs = await sql`
        SELECT content, metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1
      `
      expect(msgs.length).toBe(1)
      const meta = msgs[0].metadata as any
      const toolNames = (meta.toolCalls ?? []).map((tc: any) => tc.toolName)

      // 1. The weak model followed the protocol: discovery FIRST, then the tool.
      expect(toolNames).toContain("kernel__tool_search")
      expect(toolNames).toContain("test__listItems")
      const searchIdx = toolNames.indexOf("kernel__tool_search")
      const listIdx = toolNames.indexOf("test__listItems")
      expect(searchIdx).toBeLessThan(listIdx)

      // 2. The answer is grounded in the tool's REAL output, not fabricated.
      expect(String(msgs[0].content)).toContain("QF-1138")

      // 3. The context stayed small — the deferred catalog never shipped its
      //    schemas. Pre-fix, prod baselines ran ~150-165k input tokens per
      //    step; post-fix the hot core (kernel conversational tools + system
      //    prompt + catalog names) measures ~41k. The 50k bound pins the
      //    regression class without flaking on prompt-size drift.
      expect(meta.usage.lastStepInputTokens).toBeGreaterThan(0)
      expect(meta.usage.lastStepInputTokens).toBeLessThan(50_000)

      // 4. The discovery persisted for the thread's next turn.
      const threadRows =
        await sql`SELECT agent_discovered_tools FROM kernel.threads WHERE id = ${THREAD_ID}`
      expect(threadRows[0].agent_discovered_tools).toContain("test__listItems")
    }, 120_000)

    it("follow-up turn: the discovered tool stays loaded (persisted per thread) and is called directly", async () => {
      // Flip the item's status BETWEEN turns so the answer cannot come from the
      // previous turn's tool result in history — the model must re-query.
      await sql`UPDATE app_test.items SET status = 'blocked' WHERE org_id = ${ORG_ID}`

      // Two asks, and every structural assertion runs on EACH of them. The
      // subject is the protocol (the tool discovered last turn is still loaded
      // and is called directly), which is deterministic. Flash-Lite's prose is
      // not: measured 2 of 3 over repeated runs, it sometimes re-queries, gets
      // 'blocked', and still narrates the previous turn's 'open' from history.
      // The second ask bounds that flake without tolerating a stale answer, the
      // fresh value still has to appear in the reply.
      const { invokeAgentForThread } = await import("~/modules/agent/runtime/agent-service")
      for (const [attempt, msgId] of [
        "00000000-0000-0000-0000-000000d60011",
        "00000000-0000-0000-0000-000000d60012",
      ].entries()) {
        await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
          VALUES (${msgId}, ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user',
                  'Its status may have just changed. Re-check the live data right now and tell me its current status.', '{}')`

        const result = await invokeAgentForThread(
          THREAD_ID,
          msgId,
          {
            userId: USER_ID,
            orgId: ORG_ID,
            scopes: ["*"],
            dimensionGrants: { "test:team": ["alpha"], "test:sensitivity": ["public"] },
          },
          ORG_ID,
        )
        expect(result.finishReason).not.toBe("error")

        const msgs = await sql`
          SELECT content, metadata FROM kernel.messages
          WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
          ORDER BY created_at DESC LIMIT 1
        `
        const meta = msgs[0].metadata as any
        const toolNames = (meta.toolCalls ?? []).map((tc: any) => tc.toolName)
        // The tool discovered LAST turn is still callable this turn (thread-persisted
        // discovery seeds activeTools at step 0) — the model can call it directly,
        // no tool_search needed: the discovery persisted on the thread.
        expect(toolNames).toContain("test__listItems")
        const content = String(msgs[0].content).toLowerCase()
        if (content.includes("blocked")) break
        if (attempt === 1) expect(content).toContain("blocked")
      }
    }, 120_000)
  },
)
