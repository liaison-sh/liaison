// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { resolveModel } from "~/modules/agent/providers/provider"
import { AgentServiceTestAccess, runAgentStream } from "~/modules/agent/runtime/agent-service"

// The single shared stream chokepoint must forward reasoning providerOptions to
// streamText so chat, shared-thread agents, and sub-runs all request reasoning
// the same way. The streamText swap seam lets us assert what reaches the SDK.

describe("runAgentStream — reasoning providerOptions", () => {
  it("forwards providerOptions to streamText verbatim", async () => {
    const model = await resolveModel({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      apiKey: "test-key",
    })
    let captured: { providerOptions?: unknown } | undefined
    AgentServiceTestAccess.setStreamText(((params: { providerOptions?: unknown }) => {
      captured = params
      return { fullStream: (async function* () {})() }
    }) as never)
    try {
      const providerOptions = {
        anthropic: { thinking: { type: "enabled", budgetTokens: 4096 }, sendReasoning: true },
      }
      runAgentStream({
        model,
        stepTokenCap: null,
        system: "you are a test",
        messages: [],
        tools: {},
        providerOptions,
      })
      expect(captured?.providerOptions).toEqual(providerOptions)
    } finally {
      AgentServiceTestAccess.setStreamText()
    }
  })

  it("leaves providerOptions undefined when none are supplied", async () => {
    const model = await resolveModel({ provider: "openai", modelId: "gpt-5.4", apiKey: "test-key" })
    let captured: { providerOptions?: unknown } | undefined
    AgentServiceTestAccess.setStreamText(((params: { providerOptions?: unknown }) => {
      captured = params
      return { fullStream: (async function* () {})() }
    }) as never)
    try {
      runAgentStream({ model, stepTokenCap: null, system: "s", messages: [], tools: {} })
      expect(captured?.providerOptions).toBeUndefined()
    } finally {
      AgentServiceTestAccess.setStreamText()
    }
  })
})

// ROUTINE-TICK MODEL/REASONING OVERRIDE (deep-week-sim runtime-execution gate ladder). The operator
// escalation ladder env (`LIAISON_CHAOS_AGENT_MODEL` / `LIAISON_CHAOS_REASONING_LEVEL`) is threaded into
// the CONDUCTOR conversation but did NOT reach a routine TICK, so a runtime-execution gate whose tick is a
// flash-lite floor could not be re-gated up the ladder. `resolveRoutineTickModelOverride` lets a background
// tick honor the same pinned model + reasoning, scoped to background + gated on the env (no-op in prod).
describe("resolveRoutineTickModelOverride — routine-tick ladder env override", () => {
  it("applies the env model + reasoning ONLY for a background routine tick", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    const out = resolveRoutineTickModelOverride({
      background: true,
      threadModelId: undefined,
      threadReasoningLevel: null,
      env: {
        LIAISON_CHAOS_AGENT_MODEL: "gemini-flash-lite-latest",
        LIAISON_CHAOS_REASONING_LEVEL: "medium",
      },
    })
    expect(out.modelId).toBe("gemini-flash-lite-latest")
    expect(out.reasoningLevel).toBe("medium")
  })

  it("is a NO-OP for a foreground (non-background) run even when the env is set", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    const out = resolveRoutineTickModelOverride({
      background: false,
      threadModelId: "claude-sonnet-4-6",
      threadReasoningLevel: "off",
      env: {
        LIAISON_CHAOS_AGENT_MODEL: "gemini-flash-lite-latest",
        LIAISON_CHAOS_REASONING_LEVEL: "high",
      },
    })
    // Foreground keeps the thread's own model + reasoning — the chaos env never affects a live user run.
    expect(out.modelId).toBe("claude-sonnet-4-6")
    expect(out.reasoningLevel).toBe("off")
  })

  it("is a NO-OP for a background tick when the env is unset (production default)", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    const out = resolveRoutineTickModelOverride({
      background: true,
      threadModelId: "gemini-flash-latest",
      threadReasoningLevel: "low",
      env: {},
    })
    expect(out.modelId).toBe("gemini-flash-latest")
    expect(out.reasoningLevel).toBe("low")
  })

  it("ignores an UNKNOWN reasoning env value (keeps the thread level), still applies the model", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    const out = resolveRoutineTickModelOverride({
      background: true,
      threadModelId: undefined,
      threadReasoningLevel: "off",
      env: {
        LIAISON_CHAOS_AGENT_MODEL: "gemini-flash-latest",
        LIAISON_CHAOS_REASONING_LEVEL: "ultra", // not a valid level → ignored
      },
    })
    expect(out.modelId).toBe("gemini-flash-latest")
    expect(out.reasoningLevel).toBe("off")
  })
})

// PER-ROUTINE MODEL/REASONING PIN — precedence: chaos env (background-only, top) > routine's own
// agentModelId/agentReasoningLevel > thread's setting > org auto-select / off (undefined/null).
describe("resolveRoutineTickModelOverride — per-routine model/reasoning pin precedence", () => {
  it("routine set, thread NOT set → routine wins", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    const out = resolveRoutineTickModelOverride({
      background: true,
      threadModelId: undefined,
      threadReasoningLevel: null,
      routineModelId: "gemini-flash-latest",
      routineReasoningLevel: "medium",
      env: {},
    })
    expect(out.modelId).toBe("gemini-flash-latest")
    expect(out.reasoningLevel).toBe("medium")
  })

  it("thread set, routine NOT set → thread wins (unchanged pre-existing behavior)", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    const out = resolveRoutineTickModelOverride({
      background: true,
      threadModelId: "claude-sonnet-4-6",
      threadReasoningLevel: "low",
      routineModelId: null,
      routineReasoningLevel: null,
      env: {},
    })
    expect(out.modelId).toBe("claude-sonnet-4-6")
    expect(out.reasoningLevel).toBe("low")
  })

  it("both set → routine overrides the thread", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    const out = resolveRoutineTickModelOverride({
      background: true,
      threadModelId: "claude-sonnet-4-6",
      threadReasoningLevel: "low",
      routineModelId: "gemini-flash-latest",
      routineReasoningLevel: "medium",
      env: {},
    })
    expect(out.modelId).toBe("gemini-flash-latest")
    expect(out.reasoningLevel).toBe("medium")
  })

  it("neither set → falls through to undefined/null (org auto-select / off)", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    const out = resolveRoutineTickModelOverride({
      background: true,
      threadModelId: undefined,
      threadReasoningLevel: null,
      routineModelId: null,
      routineReasoningLevel: null,
      env: {},
    })
    expect(out.modelId).toBeUndefined()
    expect(out.reasoningLevel).toBeNull()
  })

  it("chaos env still wins over a routine's own pin (top precedence preserved)", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    const out = resolveRoutineTickModelOverride({
      background: true,
      threadModelId: undefined,
      threadReasoningLevel: null,
      routineModelId: "gemini-flash-latest",
      routineReasoningLevel: "medium",
      env: {
        LIAISON_CHAOS_AGENT_MODEL: "gemini-flash-lite-latest",
        LIAISON_CHAOS_REASONING_LEVEL: "high",
      },
    })
    expect(out.modelId).toBe("gemini-flash-lite-latest")
    expect(out.reasoningLevel).toBe("high")
  })

  it("routine pin is a NO-OP for a foreground (non-background) run's chaos precedence, but still applies", async () => {
    const { resolveRoutineTickModelOverride } = await import(
      "~/modules/agent/runtime/agent-service"
    )
    // Foreground runs never pass routine* fields in practice (routineId is routine-tick-only), but the
    // helper itself is generic — verify a routine pin still applies even when background=false, since a
    // future re-invocation path could theoretically carry both.
    const out = resolveRoutineTickModelOverride({
      background: false,
      threadModelId: "claude-sonnet-4-6",
      threadReasoningLevel: "off",
      routineModelId: "gemini-flash-latest",
      routineReasoningLevel: "medium",
      env: {
        LIAISON_CHAOS_AGENT_MODEL: "gemini-flash-lite-latest",
        LIAISON_CHAOS_REASONING_LEVEL: "high",
      },
    })
    // Routine pin applies (it's not gated on `background`); chaos env does NOT (gated on background).
    expect(out.modelId).toBe("gemini-flash-latest")
    expect(out.reasoningLevel).toBe("medium")
  })
})
