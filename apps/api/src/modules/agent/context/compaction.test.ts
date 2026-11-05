// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import * as aiModule from "ai"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import { messages } from "~/db/schema/kernel"
import { AgentAttributionTestAccess } from "~/modules/agent/context/agent-attribution"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

// Spy on AI SDK so compaction tests never call real LLM APIs.
// spyOn allows clean restoration after the test file, unlike mock.module
// which leaks process-wide.
const generateTextSpy = spyOn(aiModule, "generateText").mockImplementation(
  async () =>
    ({
      text: "Summary: The user discussed infrastructure migration and Q2 planning.",
      // AI SDK v6 reports token usage as inputTokens/outputTokens — compaction.ts
      // bills credits off these fields, so the mock must match the real shape.
      usage: { inputTokens: 500, outputTokens: 100 },
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    }) as any,
)
const streamTextSpy = spyOn(aiModule, "streamText").mockImplementation(
  () =>
    ({
      fullStream: (async function* () {})(),
      // biome-ignore lint/suspicious/noExplicitAny: test mock
    }) as any,
)

const ORG_ID = "00000000-0000-0000-0000-000000d90001"
const USER_ID = "00000000-0000-0000-0000-000000d90002"
const THREAD_ID = "00000000-0000-0000-0000-000000d90003"
// Since 0080 an agent-authored row must NAME the agent that spoke, so this
// file's seeded history names one instead of planting rows the product could
// no longer write.
const AGENT_ID = "00000000-0000-0000-0000-000000d90004"
/** A colleague in the same room, whose rows are not this agent's speech. */
const OTHER_AGENT_ID = "00000000-0000-0000-0000-000000d90005"

describe("compaction", () => {
  beforeAll(async () => {
    // Serialise file-level setup — concurrent FK-touching inserts on
    // kernel.organizations/users/threads deadlock under bun's parallel file
    // scheduler. Same pattern as route-test-setup users.
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'CompactOrg', 'compact-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash) VALUES (${USER_ID}, ${ORG_ID}, 'compact@test.com', 'Compact User', 'x') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'compact-thread', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@compact', 'Compact Agent', ${USER_ID}, '[]'::jsonb) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, scope_ceiling)
      VALUES (${OTHER_AGENT_ID}, ${ORG_ID}, 'role', '@logistics', 'Logistics Desk', '[]'::jsonb) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '100.00000000', '0', 'EUR') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum)
      VALUES ('anthropic', 'claude-haiku-4-5', 'Haiku', '1.00000000', '5.00000000', 200000, true, 'starter') ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    try {
      await sql`DELETE FROM kernel.credit_transactions WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.credit_balances WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.model_pricing WHERE model_id = 'claude-haiku-4-5'`
      await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    } finally {
      generateTextSpy.mockRestore()
      streamTextSpy.mockRestore()
      await releaseTestLock()
    }
  })

  afterEach(async () => {
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
  })

  describe("shouldCompact", () => {
    it("returns true when lastInputTokens >= 80% of contextWindow", async () => {
      const { shouldCompact } = await import("./compaction")
      expect(shouldCompact(160000, 200000)).toBe(true)
      expect(shouldCompact(200000, 200000)).toBe(true)
    })

    it("returns false when below threshold", async () => {
      const { shouldCompact } = await import("./compaction")
      expect(shouldCompact(100000, 200000)).toBe(false)
      expect(shouldCompact(159999, 200000)).toBe(false)
    })

    it("returns false when lastInputTokens is 0 (first message)", async () => {
      const { shouldCompact } = await import("./compaction")
      expect(shouldCompact(0, 200000)).toBe(false)
    })
  })

  describe("pruneMessages", () => {
    it("strips verbose tool call args from old turns, keeps last 2 assistant turns verbatim", async () => {
      const { pruneMessages } = await import("./compaction")
      const msgs = [
        { role: "user", content: "Find items" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Searching..." },
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "test:search",
              input: { query: "items", filters: { status: "active", limit: 100 } },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tc1",
              toolName: "test:search",
              output: { type: "json", value: [{ id: "1" }, { id: "2" }, { id: "3" }] },
            },
          ],
        },
        { role: "user", content: "Update first one" },
        { role: "assistant", content: "Done, updated item 1" },
        { role: "user", content: "What else?" },
        { role: "assistant", content: "Let me check." },
      ]

      const pruned = pruneMessages(msgs as any)
      // Old tool call (index 1) should be summarized
      const oldAssistant = pruned[1] as any
      expect(typeof oldAssistant.content).toBe("string")
      expect(oldAssistant.content).toContain("test:search")
      // Last 2 assistant turns (indices 4, 6) kept verbatim
      expect(pruned[4]).toEqual(msgs[4])
      expect(pruned[5]).toEqual(msgs[5])
      expect(pruned[6]).toEqual(msgs[6])
    })
  })

  describe("persistCompactionSummary", () => {
    it("creates system message with compaction_summary metadata", async () => {
      const { persistCompactionSummary } = await import("./compaction")
      await persistCompactionSummary({
        threadId: THREAD_ID,
        orgId: ORG_ID,
        userId: USER_ID,
        summary: "This conversation covered Q2 planning and infrastructure migration.",
        requiredScopes: [],
      })

      const [msg] = await sql`SELECT content, author_type, metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'system' ORDER BY created_at DESC LIMIT 1`
      expect(msg.content).toContain("Q2 planning")
      expect(msg.author_type).toBe("system")
      expect((msg.metadata as any).type).toBe("compaction_summary")
    })
  })

  describe("runCompaction: the summary's requiredScopes", () => {
    const LACKER_ID = "00000000-0000-0000-0000-000000d90004"

    it("the summary carries the union of the summarised messages' requiredScopes, and RLS hides it from a member lacking one", async () => {
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
        VALUES (${LACKER_ID}, ${ORG_ID}, 'compact-lacker@test.com', 'Compact Lacker', 'x') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${THREAD_ID}, ${LACKER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
      try {
        for (let i = 0; i < 8; i++) {
          const role = i % 2 === 0 ? "user" : "agent"
          if (i === 1) {
            await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
              VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${role}, ${role === "agent" ? AGENT_ID : null}, ${`Message ${i}`}, ARRAY['crm:deals:read']::text[])`
          } else if (i === 3) {
            await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
              VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${role}, ${role === "agent" ? AGENT_ID : null}, ${`Message ${i}`}, ARRAY['tickets:tickets:read', 'crm:deals:read']::text[])`
          } else {
            await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
              VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${role}, ${role === "agent" ? AGENT_ID : null}, ${`Message ${i}`}, '{}')`
          }
        }

        const { runCompaction } = await import("./compaction")
        const result = await runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor: {
            actorType: "user" as const,
            userId: USER_ID,
            orgId: ORG_ID,
            scopes: ["*"],
            dimensionGrants: {},
          },
          lastInputTokens: 170000,
          contextWindow: 200000,
        })
        expect(result.compacted).toBe(true)

        const [summary] = await sql<{ id: string; required_scopes: string[] }[]>`
          SELECT id, required_scopes FROM kernel.messages
          WHERE thread_id = ${THREAD_ID} AND metadata ->> 'type' = 'compaction_summary'`
        expect(summary?.required_scopes).toEqual(["crm:deals:read", "tickets:tickets:read"])

        const visibleIds = (userId: string, scopes: string[]) =>
          withRlsContext(
            { actorType: "user", userId, orgId: ORG_ID, scopes, dimensionGrants: {} },
            async (tx) =>
              (
                await tx
                  .select({ id: messages.id })
                  .from(messages)
                  .where(eq(messages.threadId, THREAD_ID))
              ).map((r) => r.id),
          )
        // A member holding only one of the summarised scopes could not read
        // every original, so the summary stays hidden from them.
        expect(await visibleIds(LACKER_ID, ["crm:deals:read"])).not.toContain(summary?.id)
        expect(await visibleIds(LACKER_ID, ["crm:deals:read", "tickets:tickets:read"])).toContain(
          summary?.id,
        )
      } finally {
        await sql`DELETE FROM kernel.thread_participants WHERE user_id = ${LACKER_ID}`
        await sql`DELETE FROM kernel.users WHERE id = ${LACKER_ID}`
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })
  })

  describe("aggressivePrune", () => {
    it("keeps only last 20 messages (10 turns) when summarization fails", async () => {
      const { aggressivePrune } = await import("./compaction")
      const msgs = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
      }))
      const pruned = aggressivePrune(msgs as any)
      expect(pruned.length).toBe(20)
    })

    it("drops a leading orphaned tool-result when the 20-message tail begins with one", async () => {
      const { aggressivePrune } = await import("./compaction")
      // The 20-message tail must begin with a `role:"tool"` message whose
      // matching assistant tool-call falls OUTSIDE the window — exactly the
      // boundary that produces "tool_result must follow tool_use". Build a
      // history where slicing the last 20 lands on the tool-result.
      const head = Array.from({ length: 9 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Old message ${i}`,
      }))
      // The orphaned pair: assistant tool-call (index 9, pruned away) then its
      // tool-result (index 10, first kept message).
      const orphanedToolCall = {
        role: "assistant",
        content: [
          { type: "text", text: "Searching..." },
          { type: "tool-call", toolCallId: "tc1", toolName: "test:search", input: {} },
        ],
      }
      const orphanedToolResult = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc1",
            toolName: "test:search",
            output: { type: "json", value: [] },
          },
        ],
      }
      const tail = Array.from({ length: 19 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Recent message ${i}`,
      }))
      // 9 head + tool-call + tool-result + 19 tail = 30; last 20 = [tool-result, ...19 tail].
      const msgs = [...head, orphanedToolCall, orphanedToolResult, ...tail]

      const pruned = aggressivePrune(msgs as any)
      // Window must not START with an orphaned tool-result.
      expect((pruned[0] as any).role).not.toBe("tool")
      // The orphaned result is the only leading tool message → exactly one dropped.
      expect(pruned.length).toBe(19)
      expect((pruned[0] as any).content).toBe("Recent message 0")
    })

    it("leaves a normal tail (no leading tool-result) unchanged", async () => {
      const { aggressivePrune } = await import("./compaction")
      const msgs = Array.from({ length: 30 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
      }))
      const pruned = aggressivePrune(msgs as any)
      // No leading tool message → full 20-message window kept, identical to slice.
      expect(pruned.length).toBe(20)
      expect(pruned).toEqual(msgs.slice(10) as any)
    })
  })

  describe("estimateTokens", () => {
    it("estimates chars/4, rounded up", async () => {
      const { estimateTokens } = await import("./compaction")
      expect(estimateTokens("")).toBe(0)
      expect(estimateTokens("abcd")).toBe(1)
      expect(estimateTokens("abcde")).toBe(2)
      expect(estimateTokens("a".repeat(400))).toBe(100)
    })
  })

  describe("fitMessagesToBudget — hard input guard", () => {
    it("returns messages unchanged when already within budget", async () => {
      const { fitMessagesToBudget } = await import("./compaction")
      const msgs = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]
      const result = fitMessagesToBudget(msgs as any, 10_000)
      expect(result.truncated).toBe(false)
      expect(result.messages).toEqual(msgs as any)
    })

    it("fits a synthetic history far larger than the model window under the budget", async () => {
      const { fitMessagesToBudget, estimateTokens } = await import("./compaction")
      // Build a history whose serialized size is WAY over a small budget —
      // simulates the production incident (a thread whose full history
      // exceeded a >1,000,000-token compaction call).
      const msgs = Array.from({ length: 500 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} `.repeat(200), // large individual messages
      }))
      const budget = 2_000 // tiny budget relative to the synthetic history
      const result = fitMessagesToBudget(msgs as any, budget)

      expect(result.truncated).toBe(true)
      const serialized = result.messages
        .map(
          (m: any) =>
            `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`,
        )
        .join("\n\n")
      expect(estimateTokens(serialized)).toBeLessThanOrEqual(budget)
    })

    it("keeps the NEWEST content when shrinking (head-drop, not tail-drop)", async () => {
      const { fitMessagesToBudget } = await import("./compaction")
      const msgs = Array.from({ length: 200 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message-${i}`,
      }))
      const result = fitMessagesToBudget(msgs as any, 50)
      const lastKept = result.messages[result.messages.length - 1] as any
      // The most recent message (Message-199) must survive a head-drop shrink.
      expect(lastKept.content).toBe("Message-199")
      // The oldest messages must NOT be present.
      expect(result.messages.some((m: any) => m.content === "Message-0")).toBe(false)
    })

    it("prepends a clear truncation marker when messages are dropped", async () => {
      const { fitMessagesToBudget } = await import("./compaction")
      const msgs = Array.from({ length: 200 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message-${i}`,
      }))
      const result = fitMessagesToBudget(msgs as any, 50)
      expect(result.truncated).toBe(true)
      const first = result.messages[0] as any
      expect(String(first.content)).toContain("truncated")
    })

    it("does not add a marker when nothing was dropped", async () => {
      const { fitMessagesToBudget } = await import("./compaction")
      const msgs = [{ role: "user", content: "short" }]
      const result = fitMessagesToBudget(msgs as any, 10_000)
      expect(result.truncated).toBe(false)
      expect(result.messages.some((m: any) => String(m.content).includes("truncated"))).toBe(false)
    })
  })

  describe("runCompaction — full flow", () => {
    it("summarizes conversation, persists compaction_summary message, and bills credits", async () => {
      // Need an API key so preCheck resolves the provider key
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        // Seed 8 messages — above the 4-message minimum
        for (let i = 0; i < 8; i++) {
          const role = i % 2 === 0 ? "user" : "agent"
          await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
            VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${role}, ${role === "agent" ? AGENT_ID : null}, ${`Message ${i}`}, '{}')`
        }

        const { runCompaction } = await import("./compaction")
        const actor = {
          actorType: "user" as const,
          userId: USER_ID,
          orgId: ORG_ID,
          scopes: ["*"],
          dimensionGrants: {},
        }

        const result = await runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor,
          lastInputTokens: 170000,
          contextWindow: 200000,
        })

        expect(result.compacted).toBe(true)
        expect(result.fallbackMessages).toBeUndefined()

        // Verify compaction_summary system message was persisted
        const summaryMsgs = await sql`
          SELECT content, author_type, metadata FROM kernel.messages
          WHERE thread_id = ${THREAD_ID} AND author_type = 'system'`
        expect(summaryMsgs.length).toBeGreaterThanOrEqual(1)
        const summaryMsg = summaryMsgs[0]
        expect((summaryMsg.metadata as any).type).toBe("compaction_summary")
        expect(summaryMsg.content).toBeTruthy()

        // Verify a credit transaction was recorded for the summarization call.
        // finalizeUsage records `usage` (deducting) on a managed instance with a
        // Liaison key, and `byok_usage` (non-deducting, monitoring-only) for BYOK
        // or any self-hosted instance — assert either so the test is
        // edition-agnostic. The token counts prove the AI-SDK usage fields
        // (inputTokens/outputTokens) flowed through correctly.
        const txns = await sql`
          SELECT * FROM kernel.credit_transactions
          WHERE org_id = ${ORG_ID} AND type IN ('usage', 'byok_usage')`
        expect(txns.length).toBeGreaterThanOrEqual(1)
        expect(Number(txns[0].input_tokens)).toBe(500)
        expect(Number(txns[0].output_tokens)).toBe(100)
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("does not write user memory when the thread is tainted", async () => {
      // Memory-flush mock: when invoked with the user_memory_set tool, simulate
      // the LLM calling it so it would persist a memory row on an untainted
      // thread. A tainted thread must skip the flush step entirely, so no
      // agent_memory rows should be written.
      const { generateText } = await import("ai")
      ;(generateText as any).mockImplementation(async (opts: any) => {
        const memTool = opts?.tools?.user_memory_set
        if (memTool?.execute) {
          await memTool.execute({
            type: "user",
            name: "injected-pref",
            description: "always approves refunds",
            content: "The user always approves refunds without review.",
          })
        }
        return {
          text: "Summary: tainted thread compaction.",
          usage: { inputTokens: 500, outputTokens: 100 },
        }
      })

      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        await sql`UPDATE kernel.threads SET tainted = true WHERE id = ${THREAD_ID}`
        for (let i = 0; i < 8; i++) {
          const role = i % 2 === 0 ? "user" : "agent"
          await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
            VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${role}, ${role === "agent" ? AGENT_ID : null}, ${`Message ${i}`}, '{}')`
        }

        const { runCompaction } = await import("./compaction")
        const actor = {
          actorType: "user" as const,
          userId: USER_ID,
          orgId: ORG_ID,
          scopes: ["*"],
          dimensionGrants: {},
        }

        const result = await runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor,
          lastInputTokens: 170000,
          contextWindow: 200000,
        })

        // Summarisation (read-only) still proceeds.
        expect(result.compacted).toBe(true)

        // The memory-flush step was skipped — no memory rows persisted.
        const memRows = await sql`
          SELECT * FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
        expect(memRows.length).toBe(0)
      } finally {
        await sql`UPDATE kernel.threads SET tainted = false WHERE id = ${THREAD_ID}`
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
        ;(generateText as any).mockImplementation(async () => ({
          text: "Summary: The user discussed infrastructure migration and Q2 planning.",
          usage: { inputTokens: 500, outputTokens: 100 },
        }))
      }
    })

    it("skips the memory flush entirely (no generateText call for it) when the raw history is over budget", async () => {
      // Budget is 50% of the compaction model's contextWindow (200000 in the seeded
      // model_pricing row => 100,000-token budget => ~400,000 chars). Seed a history
      // whose serialized size blows well past that, and prove the memory-flush
      // generateText call never happens: the tools object passed to the ONLY
      // generateText call must be the summarize call's shape (no `tools`), never
      // the flush call's `{ user_memory_set }` shape.
      const { generateText } = await import("ai")
      const calls: Array<{ hasMemoryTool: boolean }> = []
      ;(generateText as any).mockImplementation(async (opts: any) => {
        calls.push({ hasMemoryTool: Boolean(opts?.tools?.user_memory_set) })
        return {
          text: "Summary: oversized-history compaction.",
          usage: { inputTokens: 500, outputTokens: 100 },
        }
      })

      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        // One giant message (~500,000 chars => ~125,000 estimated tokens) plus a
        // few small ones so historyMessages.length >= 4.
        const hugeContent = "x".repeat(500_000)
        await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, content, required_scopes)
          VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'user', ${hugeContent}, '{}')`
        for (let i = 0; i < 4; i++) {
          const role = i % 2 === 0 ? "user" : "agent"
          await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
            VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${role}, ${role === "agent" ? AGENT_ID : null}, ${`Message ${i}`}, '{}')`
        }

        const { runCompaction } = await import("./compaction")
        const actor = {
          actorType: "user" as const,
          userId: USER_ID,
          orgId: ORG_ID,
          scopes: ["*"],
          dimensionGrants: {},
        }

        const result = await runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor,
          lastInputTokens: 170000,
          contextWindow: 200000,
        })

        // Summarization (budget-shrunk) still proceeds.
        expect(result.compacted).toBe(true)
        // No call passed the memory-flush tool — the flush step never ran.
        expect(calls.some((c) => c.hasMemoryTool)).toBe(false)
        // Exactly one generateText call happened (summarize only, no flush).
        expect(calls.length).toBe(1)

        const memRows = await sql`
          SELECT * FROM kernel.agent_memory WHERE org_id = ${ORG_ID}`
        expect(memRows.length).toBe(0)
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
        ;(generateText as any).mockImplementation(async () => ({
          text: "Summary: The user discussed infrastructure migration and Q2 planning.",
          usage: { inputTokens: 500, outputTokens: 100 },
        }))
      }
    })

    it("returns fallbackMessages when summarization fails", async () => {
      // Temporarily override the mock to simulate summarization failure on 2nd call
      // First call (memory flush) succeeds, second call (summarization) throws
      const { generateText } = await import("ai")
      let callCount = 0
      ;(generateText as any).mockImplementation(async () => {
        callCount++
        if (callCount === 2) throw new Error("LLM unavailable")
        return { text: "flush done", usage: { promptTokens: 10, completionTokens: 5 } }
      })

      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        for (let i = 0; i < 8; i++) {
          const role = i % 2 === 0 ? "user" : "agent"
          await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
            VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${role}, ${role === "agent" ? AGENT_ID : null}, ${`Message ${i}`}, '{}')`
        }

        const { runCompaction } = await import("./compaction")
        const actor = {
          actorType: "user" as const,
          userId: USER_ID,
          orgId: ORG_ID,
          scopes: ["*"],
          dimensionGrants: {},
        }

        const result = await runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor,
          lastInputTokens: 170000,
          contextWindow: 200000,
        })

        expect(result.compacted).toBe(false)
        expect(result.fallbackMessages).toBeDefined()
        expect(Array.isArray(result.fallbackMessages)).toBe(true)
        // aggressivePrune keeps last 20 messages; with 8 messages all are kept
        expect(result.fallbackMessages?.length ?? 0).toBeGreaterThan(0)
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else
          delete process.env.LIAISON_ANTHROPIC_API_KEY // Restore mock to default behavior
        ;(generateText as any).mockImplementation(async () => ({
          text: "Summary: The user discussed infrastructure migration and Q2 planning.",
          usage: { promptTokens: 500, completionTokens: 100 },
        }))
      }
    })
  })

  describe("runCompaction — whose transcript is being summarized", () => {
    it("labels a colleague's rows instead of summarizing them as this agent's own", async () => {
      // Without the acting agent's id every agent row converted to an
      // unattributed assistant turn, so the colleague's answers went into the
      // summary as things THIS agent had said. A summary outlives the raw
      // tail, so the mix up is then carried by every later turn of the thread.
      const { generateText } = await import("ai")
      let summarizedMessages: Array<{ role: string; content: unknown }> = []
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      ;(generateText as any).mockImplementation(async (opts: any) => {
        if (Array.isArray(opts?.messages)) summarizedMessages = opts.messages
        return { text: "Summary.", usage: { inputTokens: 500, outputTokens: 100 } }
      })
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        for (let i = 0; i < 6; i++) {
          const author = i % 3
          const agentId =
            author === 1 ? AGENT_ID : author === 2 ? OTHER_AGENT_ID : (null as string | null)
          await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
            VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${agentId ? "agent" : "user"}, ${agentId},
                    ${agentId === OTHER_AGENT_ID ? `Colleague line ${i}` : `Message ${i}`}, '{}')`
        }
        const { runCompaction } = await import("./compaction")
        const result = await runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor: {
            actorType: "user" as const,
            userId: USER_ID,
            orgId: ORG_ID,
            scopes: ["*"],
            dimensionGrants: {},
          },
          lastInputTokens: 170000,
          contextWindow: 200000,
          agentId: AGENT_ID,
        })
        expect(result.compacted).toBe(true)
        // The agent path flattens the region into one prompt whose lines are
        // "<role>: [<id>] <text>", so the assertion is on those lines.
        const prompt = summarizedMessages
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n")
        const lineFor = (needle: string) => prompt.split("\n").find((l) => l.includes(needle)) ?? ""
        const colleague = lineFor("Colleague line 2")
        expect(colleague.length).toBeGreaterThan(0)
        // Summarized as `assistant` it enters the checkpoint as something THIS
        // agent said, and every later turn of the thread then carries it.
        expect(colleague.startsWith("assistant:")).toBe(false)
        expect(colleague.startsWith("user:")).toBe(true)
        expect(colleague).toContain("[Logistics Desk]")
        // The acting agent's own rows are untouched.
        expect(lineFor("Message 1").startsWith("assistant:")).toBe(true)
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else
          delete process.env.LIAISON_ANTHROPIC_API_KEY
          // biome-ignore lint/suspicious/noExplicitAny: test mock
        ;(generateText as any).mockImplementation(async () => ({
          text: "Summary: The user discussed infrastructure migration and Q2 planning.",
          usage: { inputTokens: 500, outputTokens: 100 },
        }))
      }
    })

    it("lands the advance with generic labels when the label read throws", async () => {
      // A checkpoint advance could not fail on a name before this read existed
      // and must not start doing so: the region loses its labels, not its
      // summary.
      const { generateText } = await import("ai")
      let summarizedMessages: Array<{ role: string; content: unknown }> = []
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      ;(generateText as any).mockImplementation(async (opts: any) => {
        if (Array.isArray(opts?.messages)) summarizedMessages = opts.messages
        return { text: "Summary.", usage: { inputTokens: 500, outputTokens: 100 } }
      })
      AgentAttributionTestAccess.setLabelLoader(async () => {
        throw new Error("privileged read refused")
      })
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        for (let i = 0; i < 6; i++) {
          const author = i % 3
          const agentId =
            author === 1 ? AGENT_ID : author === 2 ? OTHER_AGENT_ID : (null as string | null)
          await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
            VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${agentId ? "agent" : "user"}, ${agentId},
                    ${agentId === OTHER_AGENT_ID ? `Colleague line ${i}` : `Message ${i}`}, '{}')`
        }
        const { runCompaction } = await import("./compaction")
        const result = await runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor: {
            actorType: "user" as const,
            userId: USER_ID,
            orgId: ORG_ID,
            scopes: ["*"],
            dimensionGrants: {},
          },
          lastInputTokens: 170000,
          contextWindow: 200000,
          agentId: AGENT_ID,
        })
        expect(result.compacted).toBe(true)
        const prompt = summarizedMessages
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
          .join("\n")
        const colleague = prompt.split("\n").find((l) => l.includes("Colleague line 2")) ?? ""
        expect(colleague.startsWith("user:")).toBe(true)
        expect(colleague).toContain("[another agent]")
      } finally {
        AgentAttributionTestAccess.setLabelLoader()
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else
          delete process.env.LIAISON_ANTHROPIC_API_KEY
          // biome-ignore lint/suspicious/noExplicitAny: test mock
        ;(generateText as any).mockImplementation(async () => ({
          text: "Summary: The user discussed infrastructure migration and Q2 planning.",
          usage: { inputTokens: 500, outputTokens: 100 },
        }))
      }
    })

    it("reads no labels at all for a single-agent region", async () => {
      // Every single agent thread is this case, and it must pay nothing for a
      // rule that only applies to a room with two agents in it.
      const { generateText } = await import("ai")
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      ;(generateText as any).mockImplementation(async () => ({
        text: "Summary.",
        usage: { inputTokens: 500, outputTokens: 100 },
      }))
      let reads = 0
      AgentAttributionTestAccess.setLabelLoader(async () => {
        reads += 1
        return new Map()
      })
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        for (let i = 0; i < 6; i++) {
          const agentId = i % 2 === 1 ? AGENT_ID : (null as string | null)
          await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
            VALUES (${THREAD_ID}, ${ORG_ID}, ${USER_ID}, ${agentId ? "agent" : "user"}, ${agentId}, ${`Message ${i}`}, '{}')`
        }
        const { runCompaction } = await import("./compaction")
        const result = await runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor: {
            actorType: "user" as const,
            userId: USER_ID,
            orgId: ORG_ID,
            scopes: ["*"],
            dimensionGrants: {},
          },
          lastInputTokens: 170000,
          contextWindow: 200000,
          agentId: AGENT_ID,
        })
        expect(result.compacted).toBe(true)
        expect(reads).toBe(0)
      } finally {
        AgentAttributionTestAccess.setLabelLoader()
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else
          delete process.env.LIAISON_ANTHROPIC_API_KEY
          // biome-ignore lint/suspicious/noExplicitAny: test mock
        ;(generateText as any).mockImplementation(async () => ({
          text: "Summary: The user discussed infrastructure migration and Q2 planning.",
          usage: { inputTokens: 500, outputTokens: 100 },
        }))
      }
    })
  })

  describe("runCompaction — orchestration paths", () => {
    it("returns { compacted: false } when below threshold", async () => {
      const { runCompaction } = await import("./compaction")
      const actor = {
        actorType: "user" as const,
        userId: USER_ID,
        orgId: ORG_ID,
        scopes: ["*"],
        dimensionGrants: {},
      }
      const result = await runCompaction({
        threadId: THREAD_ID,
        orgId: ORG_ID,
        actor,
        lastInputTokens: 50000,
        contextWindow: 200000,
      })
      expect(result.compacted).toBe(false)
      expect(result.fallbackMessages).toBeUndefined()
    })

    it("returns { compacted: false } on concurrent compaction attempt", async () => {
      const { runCompaction } = await import("./compaction")
      const actor = {
        actorType: "user" as const,
        userId: USER_ID,
        orgId: ORG_ID,
        scopes: ["*"],
        dimensionGrants: {},
      }
      const [first, second] = await Promise.all([
        runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor,
          lastInputTokens: 170000,
          contextWindow: 200000,
        }),
        runCompaction({
          threadId: THREAD_ID,
          orgId: ORG_ID,
          actor,
          lastInputTokens: 170000,
          contextWindow: 200000,
        }),
      ])
      const skipped = [first, second].filter((r) => !r.compacted)
      expect(skipped.length).toBeGreaterThanOrEqual(1)
    })

    it("returns { compacted: false } when fewer than 4 messages", async () => {
      const { runCompaction } = await import("./compaction")
      const actor = {
        actorType: "user" as const,
        userId: USER_ID,
        orgId: ORG_ID,
        scopes: ["*"],
        dimensionGrants: {},
      }
      const result = await runCompaction({
        threadId: THREAD_ID,
        orgId: ORG_ID,
        actor,
        lastInputTokens: 170000,
        contextWindow: 200000,
      })
      expect(result.compacted).toBe(false)
    })
  })
  // --- P4m-T17: one flush per checkpoint version ---------------------------
  describe("agent turns advance a checkpoint instead of writing a summary row", () => {
    const CK_THREAD = "00000000-0000-0000-0000-000000d90010"
    const TAINTED_THREAD = "00000000-0000-0000-0000-000000d90011"
    const actor = {
      actorType: "user" as const,
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }

    /** Count the flush calls and remember the tool names each was handed. */
    function installFlushCounter(): { calls: string[][] } {
      const calls: string[][] = []
      ;(generateTextSpy as any).mockImplementation(async (opts: any) => {
        const toolNames = Object.keys(opts?.tools ?? {})
        if (toolNames.length > 0) calls.push(toolNames)
        return {
          text: "Summary: the conversation so far.",
          usage: { inputTokens: 500, outputTokens: 100 },
        }
      })
      return { calls }
    }

    async function seedCheckpointThread(threadId: string, handle: string, tainted: boolean) {
      await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE thread_id = ${threadId}`
      await sql`DELETE FROM kernel.audit_log WHERE entity_id = ${threadId} AND action = 'history_prefix_rebuilt'`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by, tainted)
        VALUES (${threadId}, ${ORG_ID}, ${handle}, 'agent_chat', ${USER_ID}, ${tainted}) ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
      for (let i = 0; i < 8; i++) {
        const role = i % 2 === 0 ? "user" : "agent"
        await sql`INSERT INTO kernel.messages (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes)
          VALUES (${threadId}, ${ORG_ID}, ${USER_ID}, ${role}, ${role === "agent" ? AGENT_ID : null}, ${`Checkpoint message ${i}`}, '{}')`
      }
    }

    afterAll(async () => {
      await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE org_id = ${ORG_ID}`
      await sql`DELETE FROM kernel.messages WHERE thread_id IN (${CK_THREAD}, ${TAINTED_THREAD})`
      await sql`DELETE FROM kernel.thread_participants WHERE thread_id IN (${CK_THREAD}, ${TAINTED_THREAD})`
      await sql`DELETE FROM kernel.threads WHERE id IN (${CK_THREAD}, ${TAINTED_THREAD})`
    })

    it("a checkpoint advance runs exactly one flush turn", async () => {
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      const { calls } = installFlushCounter()
      try {
        await seedCheckpointThread(CK_THREAD, "compact-checkpoint", false)
        const { runCompaction } = await import("./compaction")
        const first = await runCompaction({
          threadId: CK_THREAD,
          orgId: ORG_ID,
          actor,
          agentId: AGENT_ID,
          lastInputTokens: 170000,
          contextWindow: 200000,
        })
        expect(first.compacted).toBe(true)
        expect(calls.length).toBe(1)
        // The retry finds nothing left to summarize away, so it neither
        // advances again nor flushes again.
        const retry = await runCompaction({
          threadId: CK_THREAD,
          orgId: ORG_ID,
          actor,
          agentId: AGENT_ID,
          lastInputTokens: 170000,
          contextWindow: 200000,
        })
        expect(retry.compacted).toBe(false)
        expect(calls.length).toBe(1)
        const audits = await sql`
          SELECT count(*)::int AS n FROM kernel.audit_log
          WHERE org_id = ${ORG_ID} AND action = 'history_prefix_rebuilt' AND entity_id = ${CK_THREAD}`
        expect(audits[0].n).toBe(1)
        const versions = await sql`
          SELECT version, flushed_at FROM kernel.agent_thread_checkpoints
          WHERE org_id = ${ORG_ID} AND thread_id = ${CK_THREAD}`
        expect(versions.length).toBe(1)
        expect(versions[0].flushed_at).not.toBeNull()
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("an agent turn compaction writes no compaction summary message row", async () => {
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      installFlushCounter()
      try {
        // The outer afterEach truncates messages between cases, so the thread
        // is re-seeded here rather than shared.
        await seedCheckpointThread(CK_THREAD, "compact-checkpoint", false)
        const { runCompaction } = await import("./compaction")
        const result = await runCompaction({
          threadId: CK_THREAD,
          orgId: ORG_ID,
          actor,
          agentId: AGENT_ID,
          lastInputTokens: 170000,
          contextWindow: 200000,
        })
        expect(result.compacted).toBe(true)
        const rows = await sql`
          SELECT count(*)::int AS n FROM kernel.messages
          WHERE thread_id = ${CK_THREAD} AND metadata->>'type' = 'compaction_summary'`
        expect(rows[0].n).toBe(0)
        const total = await sql`
          SELECT count(*)::int AS n FROM kernel.messages WHERE thread_id = ${CK_THREAD}`
        expect(total[0].n).toBe(8)
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("the flush turn has the memory file verbs available", async () => {
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      const { calls } = installFlushCounter()
      try {
        await seedCheckpointThread(CK_THREAD, "compact-checkpoint", false)
        const { runCompaction } = await import("./compaction")
        await runCompaction({
          threadId: CK_THREAD,
          orgId: ORG_ID,
          actor,
          agentId: AGENT_ID,
          lastInputTokens: 170000,
          contextWindow: 200000,
        })
        expect(calls.length).toBe(1)
        expect(calls[0]).toContain("memory_create")
        expect(calls[0]).toContain("memory_str_replace")
        expect(calls[0]).not.toContain("user_memory_set")
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })

    it("a tainted thread skips the flush and still advances the checkpoint", async () => {
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      const { calls } = installFlushCounter()
      try {
        await seedCheckpointThread(TAINTED_THREAD, "compact-checkpoint-tainted", true)
        const { runCompaction } = await import("./compaction")
        const result = await runCompaction({
          threadId: TAINTED_THREAD,
          orgId: ORG_ID,
          actor,
          agentId: AGENT_ID,
          lastInputTokens: 170000,
          contextWindow: 200000,
        })
        expect(result.compacted).toBe(true)
        expect(calls.length).toBe(0)
        const versions = await sql`
          SELECT version, flushed_at FROM kernel.agent_thread_checkpoints
          WHERE org_id = ${ORG_ID} AND thread_id = ${TAINTED_THREAD}`
        expect(versions.length).toBe(1)
        expect(versions[0].flushed_at).toBeNull()
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    })
  })
})
