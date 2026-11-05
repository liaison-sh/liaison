// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { AGENT_NOTICE_STORED_LINES, localizeAgentNotice } from "@liaison/shared"
import { sql } from "~/db"
import { AgentServiceTestAccess } from "~/modules/agent/runtime/agent-service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORIG_ANTHROPIC_KEY = process.env.LIAISON_ANTHROPIC_API_KEY

function fakeAgentStreamText() {
  return {
    fullStream: (async function* () {
      yield { type: "text-delta", text: "Agent reply" }
      yield {
        type: "finish-step",
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
    })(),
  } as never
}

const ORG_ID = "00000000-0000-0000-0000-000000ac0091"
const USER_ID = "00000000-0000-0000-0000-000000ac0092"
const THREAD_ID = "00000000-0000-0000-0000-000000ac0093"

describe("agent-service metadata in WS emission", () => {
  beforeAll(async () => {
    await acquireTestLock()
    AgentServiceTestAccess.setStreamText(fakeAgentStreamText as never)
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'MetaAgentOrg', 'meta-agent-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'metaagent@test.com', 'Meta Agent')`
    await sql`INSERT INTO kernel.agents (org_id, kind, handle, display_name, owner_user_id, scope_ceiling)
      VALUES (${ORG_ID}, 'personal', '@metaagent', 'Test agent', ${USER_ID}, '["*"]'::jsonb)`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'meta-agent-chat', 'agent_chat', ${USER_ID})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${USER_ID}, ${ORG_ID})`
    await sql`INSERT INTO kernel.credit_balances (org_id, included_balance, purchased_balance, currency) VALUES (${ORG_ID}, '10.00000000', '0', 'EUR')`
    await sql`INSERT INTO kernel.model_pricing (provider, model_id, display_name, input_cost_per_m, output_cost_per_m, context_window, auto_eligible, tier_minimum) VALUES ('anthropic', 'claude-haiku-4-5-meta', 'Claude Haiku Meta', '1.00', '5.00', 200000, true, 'starter')`
  })

  afterAll(async () => {
    AgentServiceTestAccess.setStreamText()
    await releaseTestLock()
  })

  it("finalize broadcasts message:create with metadata field containing finishReason", async () => {
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
        content: "metadata test",
        actor,
        orgId: ORG_ID,
      })

      // Call finalize with mock data
      await result.finalize({
        usage: { promptTokens: 100, completionTokens: 50 },
        finishReason: "stop",
        text: "Agent reply",
        steps: [],
      })

      // Verify the persisted agent message has metadata
      const msgs = await sql`
        SELECT metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1
      `
      expect(msgs.length).toBeGreaterThanOrEqual(1)
      const meta = msgs[0].metadata as any
      expect(meta).not.toBeNull()
      expect(meta.finishReason).toBe("stop")
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("surfaces a provider error IN THE CHAT MESSAGE when a turn errors with no text (no silent blank turn) — BL-177", async () => {
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
        content: "trigger an errored turn",
        actor,
        orgId: ORG_ID,
      })
      const detail =
        "Your project has exceeded its monthly spending cap. Please go to AI Studio to manage your spend cap."
      // An errored turn with NO text + an errorDetail (the in-band-error terminal path).
      await result.finalize({
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "error",
        text: "",
        errorDetail: detail,
        steps: [],
      })

      const msgs = await sql`
        SELECT content, metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1
      `
      expect(msgs.length).toBeGreaterThanOrEqual(1)
      // The chat shows the failure (production too) — NOT a blank bubble — and never
      // generically: the failure's class line, then its own detail. The row carries the
      // class, which every surface renders in its reader's language; a one-line summary
      // (Home preview, notification row, digest) shows the line alone, the conversation
      // shows the detail under it.
      expect(msgs[0].content).toBe(`${AGENT_NOTICE_STORED_LINES.provider_quota}\n\n${detail}`)
      const t = (key: string) => `<${key}>`
      expect(localizeAgentNotice(String(msgs[0].content), t, msgs[0].metadata as never)).toBe(
        "⚠️ <kernel.agentNotice.providerSpendCap>",
      )
      expect(
        localizeAgentNotice(String(msgs[0].content), t, msgs[0].metadata as never, {
          withDetail: true,
        }),
      ).toBe(`⚠️ <kernel.agentNotice.providerSpendCap>\n\n${detail}`)
      const meta = msgs[0].metadata as any
      expect(meta.finishReason).toBe("error")
      expect(meta.agentNotice).toBe("provider_quota")
      expect(meta.error).toBe(detail) // raw detail rides in metadata, for field debugging only
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("says a failure that came after some text under that text, with its detail", async () => {
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
        content: "fail half way",
        actor,
        orgId: ORG_ID,
      })
      const detail =
        "Upstream returned 400: the request was rejected.\n    at call (provider.ts:1:1)"
      await result.finalize({
        usage: { promptTokens: 0, completionTokens: 0 },
        finishReason: "error",
        text: "Looking at the order now.",
        errorDetail: detail,
        steps: [],
      })
      const msgs = await sql`
        SELECT content FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1
      `
      // The text stays; the failure is said under it, with its detail and without its stack.
      expect(msgs[0].content).toBe(
        `Looking at the order now.\n\n${AGENT_NOTICE_STORED_LINES.provider_error}\n\nUpstream returned 400: the request was rejected.`,
      )
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("persists reasoningLevel + reasoning text + reasoning tokens for a capable model", async () => {
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
        content: "reasoning on",
        modelId: "claude-haiku-4-5-meta",
        reasoningLevel: "high",
        actor,
        orgId: ORG_ID,
      })
      await result.finalize({
        usage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 40 },
        finishReason: "stop",
        text: "Answer",
        reasoning: "Let me think step by step...",
        timeline: [
          { kind: "reasoning", text: "First check the thread." },
          { kind: "tool", toolCallId: "tc1" },
          { kind: "reasoning", text: "Now answer." },
        ],
        steps: [],
      })

      const msgs = await sql`
        SELECT metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1
      `
      const meta = msgs[0].metadata as any
      expect(meta.reasoningLevel).toBe("high")
      expect(meta.reasoning).toBe("Let me think step by step...")
      expect(meta.usage.reasoningTokens).toBe(40)
      // The ordered reasoning/tool interleave round-trips so the UI can anchor
      // the mid-thinking tool call between the two reasoning segments.
      expect(meta.timeline).toEqual([
        { kind: "reasoning", text: "First check the thread." },
        { kind: "tool", toolCallId: "tc1" },
        { kind: "reasoning", text: "Now answer." },
      ])
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })

  it("omits reasoningLevel from metadata when reasoning is off / unset", async () => {
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
        content: "reasoning off",
        modelId: "claude-haiku-4-5-meta",
        actor,
        orgId: ORG_ID,
      })
      await result.finalize({
        usage: { promptTokens: 1, completionTokens: 1 },
        finishReason: "stop",
        text: "Answer",
        steps: [],
      })

      const msgs = await sql`
        SELECT metadata FROM kernel.messages
        WHERE thread_id = ${THREAD_ID} AND author_type = 'agent'
        ORDER BY created_at DESC LIMIT 1
      `
      const meta = msgs[0].metadata as any
      expect(meta.reasoningLevel).toBeUndefined()
      expect(meta.reasoning).toBeUndefined()
    } finally {
      if (ORIG_ANTHROPIC_KEY !== undefined)
        process.env.LIAISON_ANTHROPIC_API_KEY = ORIG_ANTHROPIC_KEY
      else delete process.env.LIAISON_ANTHROPIC_API_KEY
    }
  })
})
