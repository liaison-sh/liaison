// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { _setEdition } from "~/lib/edition"
import { TurnHandoffTestAccess } from "~/modules/agent/runtime/turn-handoff"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

const ORG_ID = "00000000-0000-0000-0000-000000ac0001"
const USER_ID = "00000000-0000-0000-0000-000000ac0002"
const THREAD_ID = "00000000-0000-0000-0000-000000ac0003"

// The speaking agent: an agent-authored row names it (0080).
const AGENT_ID = "00000000-0000-0000-0000-00000000aa90"

describe("agent-service", () => {
  beforeAll(async () => {
    await acquireTestLock()
    // Agent billing (402 on zero balance) is managed-edition behaviour.
    _setEdition("managed")
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'AgentOrg', 'agent-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'agent@test.com', 'Agent User')`
    await sql`INSERT INTO kernel.agents (id, org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${AGENT_ID}, ${ORG_ID}, 'personal', '@agent', 'Test agent', ${USER_ID}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'agent-chat-test', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '5.00000000', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', '1.00000000', '5.00000000', 200000, true, 'starter')`
  })

  // Several tests start a turn and never drive its stream: it stays registered
  // as running in this process, where a later file's drain would wait on it.
  afterEach(() => {
    TurnHandoffTestAccess.clear()
  })

  afterAll(async () => {
    _setEdition(null)
    await releaseTestLock()
  })

  it("persists user message and returns userMessageId", async () => {
    const { runAgentChat } = await import("./agent-service")
    const actor = {
      actorType: "user" as const,
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"

    try {
      const result = await runAgentChat({
        threadId: THREAD_ID,
        content: "Hello from orchestrator test",
        actor,
        orgId: ORG_ID,
      })

      expect(result.userMessageId).toBeDefined()
      expect(typeof result.userMessageId).toBe("string")
      expect(result.fullStream).toBeDefined()
      expect(typeof result.finalize).toBe("function")

      // Verify user message persisted in DB
      const msgs =
        await sql`SELECT * FROM kernel.messages WHERE thread_id = ${THREAD_ID} AND author_type = 'user' ORDER BY created_at DESC LIMIT 1`
      expect(msgs.length).toBeGreaterThanOrEqual(1)
      expect(msgs[0].content).toBe("Hello from orchestrator test")
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("finalize persists agent message with authorType:agent and metadata, and deducts credits", async () => {
    const { runAgentChat } = await import("./agent-service")
    const actor = {
      actorType: "user" as const,
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"

    try {
      const chatResult = await runAgentChat({
        threadId: THREAD_ID,
        content: "Finalize test message",
        actor,
        orgId: ORG_ID,
      })

      // Call finalize directly with mock usage data (no actual LLM needed)
      const finalResult = await chatResult.finalize({
        usage: { promptTokens: 100, completionTokens: 50 },
        finishReason: "stop",
        text: "Agent response text",
        steps: [
          {
            toolCalls: [{ toolCallId: "tc1", toolName: "test:tool", args: { x: 1 } }],
            toolResults: [{ toolCallId: "tc1", result: { ok: true } }],
          },
        ],
      })

      expect(finalResult.messageId).toBeDefined()
      expect(typeof finalResult.creditCost).toBe("string")
      expect(finalResult.finishReason).toBe("stop")

      // Verify agent message in DB with correct authorType
      const agentMsgs = await sql`SELECT * FROM kernel.messages WHERE id = ${finalResult.messageId}`
      expect(agentMsgs.length).toBe(1)
      expect(agentMsgs[0].author_type).toBe("agent")
      expect(agentMsgs[0].content).toBe("Agent response text")

      // Verify metadata contains toolCalls
      const metadata = agentMsgs[0].metadata as any
      expect(metadata.toolCalls).toBeDefined()
      expect(metadata.toolCalls.length).toBe(1)
      expect(metadata.toolCalls[0].toolCallId).toBe("tc1")
      expect(metadata.toolCalls[0].result).toEqual({ ok: true })

      // Verify credit_transactions row was created
      const txns =
        await sql`SELECT * FROM kernel.credit_transactions WHERE org_id = ${ORG_ID} ORDER BY created_at DESC LIMIT 1`
      expect(txns.length).toBeGreaterThanOrEqual(1)
      expect(txns[0].type).toBe("usage")
      expect(Number(txns[0].input_tokens)).toBe(100)
      expect(Number(txns[0].output_tokens)).toBe(50)
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  // Error reporting (apps/api/CLAUDE.md, BINDING): a failed tool call used to land as
  // `{ result: null, status: "error" }` — no message, no code, nothing anywhere to say
  // WHAT failed. The AI SDK emits a `tool-error` chunk and no matching tool result, so
  // the step carries the detail in `toolErrors` and it must survive into the turn's
  // toolCalls metadata (never the upstream `body`, which stays log-only).
  it("a failing app tool persists its message and code in the turn's tool call metadata", async () => {
    const { runAgentChat } = await import("./agent-service")
    const actor = {
      actorType: "user" as const,
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }
    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const chatResult = await runAgentChat({
        threadId: THREAD_ID,
        content: "Tool error test message",
        actor,
        orgId: ORG_ID,
      })
      const failure = Object.assign(new Error("Boxtal rejected the shipment: invalid postcode"), {
        code: "invalid_params",
        status: 400,
        body: { upstream: "must never be persisted" },
      })
      const finalResult = await chatResult.finalize({
        usage: { promptTokens: 10, completionTokens: 5 },
        finishReason: "stop",
        text: "I could not do that.",
        steps: [
          {
            toolCalls: [
              { toolCallId: "tcErr", toolName: "boxtal__create_shipment", args: { orderId: "1" } },
            ],
            toolResults: [],
            toolErrors: [{ toolCallId: "tcErr", error: failure }],
          },
        ],
      })
      const rows =
        await sql`SELECT metadata FROM kernel.messages WHERE id = ${finalResult.messageId}`
      const call = (rows[0].metadata as any).toolCalls[0]
      expect(call.status).toBe("error")
      expect(call.error).toBeDefined()
      expect(call.error.message).toBe("Boxtal rejected the shipment: invalid postcode")
      expect(call.error.code).toBe("invalid_params")
      expect(call.error.status).toBe(400)
      // The safe envelope only: the upstream body never reaches the persisted row.
      expect(JSON.stringify(call)).not.toContain("must never be persisted")
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("throws 403 when user is not a participant", async () => {
    const { runAgentChat } = await import("./agent-service")
    const nonParticipant = {
      actorType: "user" as const,
      userId: "00000000-0000-0000-0000-000000ac9999",
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      await expect(
        runAgentChat({
          threadId: THREAD_ID,
          content: "Should fail",
          actor: nonParticipant,
          orgId: ORG_ID,
        }),
      ).rejects.toThrow()
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("throws 402 when balance is zero and persists system message", async () => {
    const zeroOrgId = "00000000-0000-0000-0000-000000ac0004"
    const zeroUserId = "00000000-0000-0000-0000-000000ac0005"
    const zeroThreadId = "00000000-0000-0000-0000-000000ac0006"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${zeroOrgId}, 'ZeroAgentOrg', 'zero-agent-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${zeroUserId}, ${zeroOrgId}, 'zero-agent@test.com', 'Zero User')`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${zeroOrgId}, 'personal', '@zero-agent', 'Test agent', ${zeroUserId}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${zeroThreadId}, ${zeroOrgId}, 'zero-agent-chat', 'agent_chat', ${zeroUserId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${zeroThreadId}, ${zeroUserId}, ${zeroOrgId})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${zeroOrgId}, '0.00000000', '0.00000000', 'EUR')`

    const { runAgentChat } = await import("./agent-service")
    const actor = {
      actorType: "user" as const,
      userId: zeroUserId,
      orgId: zeroOrgId,
      scopes: ["*"],
      dimensionGrants: {},
    }

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      await expect(
        runAgentChat({
          threadId: zeroThreadId,
          content: "Should fail with credits",
          actor,
          orgId: zeroOrgId,
        }),
      ).rejects.toThrow(/402|usage|credits/i)

      // System message must be persisted (402 = billing failure)
      const msgs =
        await sql`SELECT * FROM kernel.messages WHERE thread_id = ${zeroThreadId} AND author_type = 'system'`
      expect(msgs.length).toBeGreaterThanOrEqual(1)
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  describe("compaction integration", () => {
    it("retrieves lastInputTokens from previous agent message metadata", async () => {
      const { getLastInputTokens } = await import("./agent-service")
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, author_agent_id, content, metadata, required_scopes)
        VALUES ('00000000-0000-0000-0000-aaaaaaaaa001', ${THREAD_ID}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, 'Previous response',
                '{"usage":{"inputTokens":150000,"outputTokens":1000}}'::jsonb, '{}')`
      try {
        const tokens = await getLastInputTokens(THREAD_ID, ORG_ID)
        expect(tokens).toBe(150000)
      } finally {
        await sql`DELETE FROM kernel.messages WHERE id = '00000000-0000-0000-0000-aaaaaaaaa001'`
      }
    })

    it("returns 0 when no previous agent message exists", async () => {
      const { getLastInputTokens } = await import("./agent-service")
      const EMPTY_THREAD = "00000000-0000-0000-0000-000000ac0099"
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${EMPTY_THREAD}, ${ORG_ID}, 'empty-agent-thread', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
      try {
        const tokens = await getLastInputTokens(EMPTY_THREAD, ORG_ID)
        expect(tokens).toBe(0)
      } finally {
        await sql`DELETE FROM kernel.threads WHERE id = ${EMPTY_THREAD}`
      }
    })
  })

  // A turn whose model is not available to the org (unknown, switched off, key
  // removed) runs on the org's Auto model instead of failing (AI models spec
  // S4 and A6; resolveModelForPreCheck with `turn: true` in credit-meter.ts).
  it("runs a turn on an unknown model on Auto, persisting no system message", async () => {
    const modelOrgId = "00000000-0000-0000-0000-000000ac0007"
    const modelUserId = "00000000-0000-0000-0000-000000ac0008"
    const modelThreadId = "00000000-0000-0000-0000-000000ac0009"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${modelOrgId}, 'ModelAgentOrg', 'model-agent-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${modelUserId}, ${modelOrgId}, 'model-agent@test.com', 'Model Agent User')`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${modelOrgId}, 'personal', '@model-agent', 'Test agent', ${modelUserId}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${modelThreadId}, ${modelOrgId}, 'model-agent-chat', 'agent_chat', ${modelUserId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${modelThreadId}, ${modelUserId}, ${modelOrgId})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${modelOrgId}, '5.00000000', '0.00000000', 'EUR')`

    const { runAgentChat } = await import("./agent-service")
    const actor = {
      actorType: "user" as const,
      userId: modelUserId,
      orgId: modelOrgId,
      scopes: ["*"],
      dimensionGrants: {},
    }

    process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
    try {
      const result = await runAgentChat({
        threadId: modelThreadId,
        content: "Hello with bad model",
        actor,
        orgId: modelOrgId,
        modelId: "nonexistent-model-xyz",
      })
      expect(typeof result.userMessageId).toBe("string")
      await result.finalize({
        usage: { promptTokens: 10, completionTokens: 2 },
        finishReason: "stop",
        text: "Hi.",
        steps: [],
      })

      // The turn was metered on the org's Auto model, not the unknown one.
      const { selectAutoModelForOrg } = await import("~/modules/agent/credits/credit-meter")
      const auto = await selectAutoModelForOrg(modelOrgId, "test")
      if (!auto) throw new Error("the org has no Auto model to fall back to")
      const usage = await sql<{ model: string }[]>`
        SELECT model FROM kernel.credit_transactions WHERE org_id = ${modelOrgId} AND model IS NOT NULL`
      expect(usage.map((r) => r.model)).toEqual([auto.modelId])
      // No model error was written to the thread.
      const sysMsgs =
        await sql`SELECT * FROM kernel.messages WHERE thread_id = ${modelThreadId} AND author_type = 'system'`
      expect(sysMsgs.length).toBe(0)
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  describe("invokeAgentForThread", () => {
    const INVOKE_ORG_ID = "00000000-0000-0000-0000-000000ac1001"
    const INVOKE_USER_ID = "00000000-0000-0000-0000-000000ac1002"
    const INVOKE_THREAD_ID = "00000000-0000-0000-0000-000000ac1003"

    beforeAll(async () => {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${INVOKE_ORG_ID}, 'InvokeOrg', 'invoke-org')`
      await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${INVOKE_USER_ID}, ${INVOKE_ORG_ID}, 'invoke@test.com', 'Invoke User')`
      await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
        VALUES (${INVOKE_ORG_ID}, 'personal', '@invoke', 'Test agent', ${INVOKE_USER_ID}, '["*"]'::jsonb)`
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${INVOKE_THREAD_ID}, ${INVOKE_ORG_ID}, 'invoke-chat', 'agent_chat', ${INVOKE_USER_ID})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${INVOKE_THREAD_ID}, ${INVOKE_USER_ID}, ${INVOKE_ORG_ID})`
      await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${INVOKE_ORG_ID}, '10.00000000', '0.00000000', 'EUR')`
    })

    it("does not throw when stream fails (error is caught internally)", async () => {
      const { invokeAgentForThread } = await import("./agent-service")
      const actor = {
        userId: INVOKE_USER_ID,
        orgId: INVOKE_ORG_ID,
        scopes: ["*"] as string[],
      }

      // Insert a user message to use as the trigger
      const msgId = "00000000-0000-0000-0000-000000ac1010"
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${msgId}, ${INVOKE_THREAD_ID}, ${INVOKE_ORG_ID}, ${INVOKE_USER_ID}, 'user', 'Hello from invoke test', '{}')`

      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        // With a fake API key, the LLM stream fails — invokeAgentForThread must
        // CATCH it internally and resolve (never throw). Since the supervisor
        // work it returns a finalized turn descriptor; a caught stream error
        // surfaces as finishReason "error" (turnsAdded counts the attempted turn).
        const out = await invokeAgentForThread(INVOKE_THREAD_ID, msgId, actor, INVOKE_ORG_ID)
        expect(out.finishReason).toBe("error")
        expect(typeof out.turnsAdded).toBe("number")
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
        await sql`DELETE FROM kernel.messages WHERE id = ${msgId}`
      }
    })

    it("throws 403 when actor is not a thread participant", async () => {
      const { invokeAgentForThread } = await import("./agent-service")
      const nonParticipant = {
        userId: "00000000-0000-0000-0000-000000ac9998",
        orgId: INVOKE_ORG_ID,
        scopes: ["*"] as string[],
      }

      const msgId = "00000000-0000-0000-0000-000000ac1011"
      await sql`INSERT INTO kernel.messages (id, thread_id, org_id, author_id, author_type, content, required_scopes)
        VALUES (${msgId}, ${INVOKE_THREAD_ID}, ${INVOKE_ORG_ID}, ${INVOKE_USER_ID}, 'user', 'Unauthorized invoke', '{}')`

      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        await expect(
          invokeAgentForThread(INVOKE_THREAD_ID, msgId, nonParticipant, INVOKE_ORG_ID),
        ).rejects.toThrow()
      } finally {
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
        await sql`DELETE FROM kernel.messages WHERE id = ${msgId}`
      }
    })
  })

  // --- P4c-T23: the cold resume advance at turn start -----------------------

  describe("P4c-T23 the cold resume advance at turn start", () => {
    const COLD_HOT = "00000000-0000-0000-0000-000000ac2001"
    const COLD_WARM = "00000000-0000-0000-0000-000000ac2002"
    const COLD_SHORT = "00000000-0000-0000-0000-000000ac2003"
    const COLD_ROUTINE = "00000000-0000-0000-0000-000000ac2004"
    /** The agent's last turn, and the clock every case is measured from. */
    const LAST_TURN = new Date("2026-03-01T12:00:00.000Z")
    const FAT_CHARS = 2_000

    const actor = {
      actorType: "user" as const,
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }

    /**
     * A thread whose tail is `count` fat messages, the LAST of them written by
     * the agent at LAST_TURN: that row is what the cold rule measures from.
     */
    async function seedColdThread(threadId: string, handle: string, count: number): Promise<void> {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${threadId}, ${ORG_ID}, ${handle}, 'agent_chat', ${USER_ID})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${USER_ID}, ${ORG_ID})`
      for (let i = 1; i <= count; i++) {
        const isLast = i === count
        const content = `Message ${i}`.padEnd(FAT_CHARS, "x")
        const at = new Date(LAST_TURN.getTime() - (count - i) * 1000).toISOString()
        if (isLast) {
          await sql`INSERT INTO kernel.messages
            (thread_id, org_id, author_id, author_type, author_agent_id, content, created_at, required_scopes)
            VALUES (${threadId}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, ${content}, ${at}, '{}')`
        } else {
          await sql`INSERT INTO kernel.messages
            (thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
            VALUES (${threadId}, ${ORG_ID}, ${USER_ID}, 'user', ${content}, ${at}, '{}')`
        }
      }
    }

    async function rebuildRows(threadId: string): Promise<Array<{ cause: string }>> {
      const rows = await sql`
        SELECT metadata FROM kernel.audit_log
        WHERE org_id = ${ORG_ID} AND entity_id = ${threadId}
          AND action = 'history_prefix_rebuilt'`
      return rows.map((r) => r.metadata as { cause: string })
    }

    beforeAll(async () => {
      // 40 fat messages: 20,000 estimated tokens, under the 48,000 budget, so
      // only the cold rule can compress them.
      await seedColdThread(COLD_HOT, "cold-hot", 40)
      await seedColdThread(COLD_WARM, "cold-warm", 40)
      // 10 fat messages: 5,000 tokens, already inside the cold tail budget.
      await seedColdThread(COLD_SHORT, "cold-short", 10)
      await seedColdThread(COLD_ROUTINE, "cold-routine", 40)
    })

    afterAll(async () => {
      const { CheckpointTestAccess } = await import("~/modules/agent/context/checkpoint")
      CheckpointTestAccess.setSummarizer()
    })

    it("a turn 61 minutes after the last agent turn with a 20000 token tail advances once with cause cold_resume", async () => {
      const { coldResumeAdvanceForTurn } = await import("./agent-service")
      const { CheckpointTestAccess } = await import("~/modules/agent/context/checkpoint")
      CheckpointTestAccess.setSummarizer(async () => "Cold resume summary.")
      try {
        const decision = await coldResumeAdvanceForTurn({
          agentId: AGENT_ID,
          threadId: COLD_HOT,
          orgId: ORG_ID,
          actor,
          contextWindow: 200_000,
          now: new Date(LAST_TURN.getTime() + 61 * 60_000),
        })
        expect(decision.cold).toBe(true)
        expect(decision.advanced).toBe(true)
        expect(decision.sinceLastTurnSeconds).toBe(61 * 60)
        const causes = await rebuildRows(COLD_HOT)
        expect(causes.length).toBe(1)
        expect(causes[0].cause).toBe("cold_resume")

        // ONCE. The tail it left is inside the cold tail budget, so the next
        // cold turn finds nothing to compress and rebuilds nothing.
        const again = await coldResumeAdvanceForTurn({
          agentId: AGENT_ID,
          threadId: COLD_HOT,
          orgId: ORG_ID,
          actor,
          contextWindow: 200_000,
          now: new Date(LAST_TURN.getTime() + 121 * 60_000),
        })
        expect(again.cold).toBe(true)
        expect(again.advanced).toBe(false)
        expect((await rebuildRows(COLD_HOT)).length).toBe(1)
      } finally {
        CheckpointTestAccess.setSummarizer()
      }
    })

    it("a turn 59 minutes after does not advance", async () => {
      const { coldResumeAdvanceForTurn } = await import("./agent-service")
      const decision = await coldResumeAdvanceForTurn({
        agentId: AGENT_ID,
        threadId: COLD_WARM,
        orgId: ORG_ID,
        actor,
        contextWindow: 200_000,
        now: new Date(LAST_TURN.getTime() + 59 * 60_000),
      })
      expect(decision.cold).toBe(false)
      expect(decision.advanced).toBe(false)
      expect(await rebuildRows(COLD_WARM)).toEqual([])
    })

    it("a cold turn with a 5000 token tail does not advance", async () => {
      const { coldResumeAdvanceForTurn } = await import("./agent-service")
      const decision = await coldResumeAdvanceForTurn({
        agentId: AGENT_ID,
        threadId: COLD_SHORT,
        orgId: ORG_ID,
        actor,
        contextWindow: 200_000,
        now: new Date(LAST_TURN.getTime() + 61 * 60_000),
      })
      expect(decision.cold).toBe(true)
      expect(decision.advanced).toBe(false)
      expect(await rebuildRows(COLD_SHORT)).toEqual([])
    })

    it("a routine tick never cold resumes", async () => {
      const { coldResumeAdvanceForTurn } = await import("./agent-service")
      const decision = await coldResumeAdvanceForTurn({
        agentId: AGENT_ID,
        threadId: COLD_ROUTINE,
        orgId: ORG_ID,
        actor,
        contextWindow: 200_000,
        isRoutineTick: true,
        now: new Date(LAST_TURN.getTime() + 61 * 60_000),
      })
      expect(decision.cold).toBe(false)
      expect(decision.advanced).toBe(false)
      expect(await rebuildRows(COLD_ROUTINE)).toEqual([])
    })
  })

  // --- P4c-G2: one recall per turn ------------------------------------------
  //
  // A cold turn already recalls memory inside `assembleContext` (P4c-T25),
  // against the reconstructed conversation and inside its budget, and that is
  // the block the prompt carries. The pre-turn warm recall therefore ran a
  // second vector search on every cold turn whose result was thrown away.

  describe("P4c-G2 the warm auto recall on a cold turn", () => {
    const G2_COLD = "00000000-0000-0000-0000-000000ac2011"
    const G2_WARM = "00000000-0000-0000-0000-000000ac2012"

    const actor = {
      actorType: "user" as const,
      userId: USER_ID,
      orgId: ORG_ID,
      scopes: ["*"],
      dimensionGrants: {},
    }

    /** A conversation this agent last answered `minutes` ago, measured live. */
    async function seedAnswered(threadId: string, handle: string, minutes: number): Promise<void> {
      await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
        VALUES (${threadId}, ${ORG_ID}, ${handle}, 'agent_chat', ${USER_ID})`
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
        VALUES (${threadId}, ${USER_ID}, ${ORG_ID})`
      await sql`INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, content, created_at, required_scopes)
        VALUES (${threadId}, ${ORG_ID}, ${USER_ID}, 'user', 'Where did we land?',
          ${new Date(Date.now() - (minutes + 1) * 60_000).toISOString()}, '{}')`
      await sql`INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, author_agent_id, content, created_at, required_scopes)
        VALUES (${threadId}, ${ORG_ID}, ${USER_ID}, 'agent', ${AGENT_ID}, 'We landed here.',
          ${new Date(Date.now() - minutes * 60_000).toISOString()}, '{}')`
    }

    beforeAll(async () => {
      await seedAnswered(G2_COLD, "g2-cold", 61)
      await seedAnswered(G2_WARM, "g2-warm", 5)
    })

    /**
     * Counts the pre-turn recall calls one `runAgentChat` makes. The module is
     * restored afterwards, so nothing else in this file sees the counter.
     */
    async function recallCallsFor(threadId: string): Promise<number> {
      const { mock } = await import("bun:test")
      // Eager snapshot, taken BEFORE the mock: `await import(...)` is a LIVE
      // namespace view that mock.module patches in place, so spreading it in
      // the restore factory below would re-install the fake for every later
      // file in the flat unit run.
      const real = { ...(await import("~/modules/agent/memory/memory-recall")) }
      let calls = 0
      mock.module("~/modules/agent/memory/memory-recall", () => ({
        ...real,
        autoRecall: async () => {
          calls += 1
          return null
        },
      }))
      process.env.LIAISON_ANTHROPIC_API_KEY = "sk-test-key"
      try {
        const { runAgentChat } = await import("./agent-service")
        await runAgentChat({
          threadId,
          content: "And now?",
          actor,
          orgId: ORG_ID,
          actingAgentId: AGENT_ID,
        })
        return calls
      } finally {
        mock.module("~/modules/agent/memory/memory-recall", () => real)
        if (ORIG_ANTHROPIC_KEY !== undefined)
          process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
        else delete process.env.LIAISON_ANTHROPIC_API_KEY
      }
    }

    it("a cold turn runs no warm auto recall", async () => {
      expect(await recallCallsFor(G2_COLD)).toBe(0)
    })

    it("a warm turn still runs auto recall", async () => {
      expect(await recallCallsFor(G2_WARM)).toBe(1)
    })
  })
})
