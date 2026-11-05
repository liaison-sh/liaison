// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { getReasoningCapability } from "@liaison/shared"
import {
  ANTHROPIC_BUDGET_TOKENS,
  AUTO_REASONING_LEVEL,
  buildReasoning,
  REASONING_LEVELS,
  resolveTurnReasoningLevel,
} from "./reasoning"

// buildReasoning(provider, level) is the single source of truth that maps the
// user-facing Off/Low/Medium/High vocabulary onto each provider's quirky
// AI-SDK providerOptions shape, AND declares how that provider emits reasoning
// (full text vs summary vs nothing) so the capture pipeline + UI can adapt.
// "Support everything": every provider must REQUEST maximum reasoning visibility.

describe("buildReasoning — Anthropic (full streamed thinking)", () => {
  it("enables extended thinking with a budget + sendReasoning for on-levels", () => {
    for (const level of ["low", "medium", "high"] as const) {
      const plan = buildReasoning("anthropic", level)
      expect(plan.streamMode).toBe("full")
      expect(plan.providerOptions).toEqual({
        anthropic: {
          thinking: { type: "enabled", budgetTokens: ANTHROPIC_BUDGET_TOKENS[level] },
          sendReasoning: true,
        },
      })
    }
  })

  it("explicitly disables thinking on Off (respects the user's choice)", () => {
    const plan = buildReasoning("anthropic", "off")
    expect(plan.streamMode).toBe("none")
    expect(plan.providerOptions).toEqual({ anthropic: { thinking: { type: "disabled" } } })
  })

  it("uses ascending, API-valid (>=1024) budgets", () => {
    expect(ANTHROPIC_BUDGET_TOKENS.low).toBeGreaterThanOrEqual(1024)
    expect(ANTHROPIC_BUDGET_TOKENS.low).toBeLessThan(ANTHROPIC_BUDGET_TOKENS.medium)
    expect(ANTHROPIC_BUDGET_TOKENS.medium).toBeLessThan(ANTHROPIC_BUDGET_TOKENS.high)
  })
})

describe("buildReasoning — OpenAI (summary only; raw CoT is encrypted)", () => {
  it("maps level to reasoningEffort and requests an auto summary", () => {
    expect(buildReasoning("openai", "low")).toEqual({
      providerOptions: { openai: { reasoningEffort: "low", reasoningSummary: "auto" } },
      streamMode: "summary",
    })
    expect(buildReasoning("openai", "high").providerOptions).toEqual({
      openai: { reasoningEffort: "high", reasoningSummary: "auto" },
    })
  })

  it("maps Off to reasoningEffort none with no reasoning emission", () => {
    const plan = buildReasoning("openai", "off")
    expect(plan.streamMode).toBe("none")
    expect(plan.providerOptions).toEqual({ openai: { reasoningEffort: "none" } })
  })
})

describe("buildReasoning — Google (thought summaries; gated by includeThoughts)", () => {
  it("sets thinkingLevel + includeThoughts so thoughts actually stream", () => {
    expect(buildReasoning("google", "medium")).toEqual({
      providerOptions: {
        google: { thinkingConfig: { thinkingLevel: "medium", includeThoughts: true } },
      },
      streamMode: "summary",
    })
  })

  // Regression: EVERY current Gemini model rejects `thinkingBudget: 0` with a
  // bare HTTP 400 ("Request contains an invalid argument.") — including Flash
  // and Flash Lite since the Gemini 3 era alias repoint (verified live
  // 2026-07-22; this 400 killed every agent turn in a flash-lite chat with
  // reasoning Off). `agent-service` is expected to clamp the effective level
  // away from "off" via `getReasoningCapability`, but this asserts the
  // defense-in-depth: even if "off" reaches here — with or without a modelId —
  // we must never emit `thinkingBudget: 0`.
  it("never sends thinkingBudget 0 for any Gemini model, even if Off is requested", () => {
    for (const modelId of [
      undefined,
      "gemini-pro-latest",
      "gemini-2.5-pro",
      "gemini-3-pro",
      "gemini-3-pro-preview",
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
    ]) {
      const plan = buildReasoning("google", "off", modelId)
      expect(plan.providerOptions).toBeUndefined()
      expect(plan.streamMode).toBe("summary")
    }
  })
})

describe("buildReasoning — Mistral (magistral binary effort)", () => {
  it("collapses every on-level to high (enum is none|high) and streams full", () => {
    for (const level of ["low", "medium", "high"] as const) {
      expect(buildReasoning("mistral", level)).toEqual({
        providerOptions: { mistral: { reasoningEffort: "high" } },
        streamMode: "full",
      })
    }
  })

  it("maps Off to none", () => {
    expect(buildReasoning("mistral", "off")).toEqual({
      providerOptions: { mistral: { reasoningEffort: "none" } },
      streamMode: "none",
    })
  })
})

describe("buildReasoning — unknown providers degrade safely", () => {
  it("never sends providerOptions and reports streamMode none", () => {
    for (const level of REASONING_LEVELS) {
      const plan = buildReasoning("custom", level)
      expect(plan.providerOptions).toBeUndefined()
      expect(plan.streamMode).toBe("none")
    }
  })

  it("exposes the canonical level vocabulary", () => {
    expect([...REASONING_LEVELS]).toEqual(["off", "low", "medium", "high"])
  })
})

describe("resolveTurnReasoningLevel — Auto runs at High", () => {
  // DeepSeek V4.1 Flash on OpenRouter: low and high, and it can be switched off.
  const deepseek = { reasoningEfforts: ["low", "high"] as const, canDisableReasoning: true }
  const deepseekCap = getReasoningCapability(
    "openrouter/deepseek/deepseek-v4.1-flash",
    "openrouter",
    {
      reasoningEfforts: [...deepseek.reasoningEfforts],
      canDisableReasoning: true,
    },
  )

  it("an Auto turn on DeepSeek sends effort high, whatever level was asked", () => {
    expect(AUTO_REASONING_LEVEL).toBe("high")
    for (const requested of [undefined, null, "off", "low", "medium", "high"] as const) {
      const level = resolveTurnReasoningLevel({
        capability: deepseekCap,
        requested,
        autoPicked: true,
      })
      expect(level).toBe("high")
      expect(
        buildReasoning("openrouter", level, "deepseek/deepseek-v4.1-flash", {
          reasoningEfforts: [...deepseek.reasoningEfforts],
          canDisableReasoning: true,
        }).providerOptions,
      ).toEqual({ openrouter: { reasoning: { effort: "high" } } })
    }
  })

  it("an explicitly picked model keeps the level asked for, Off included", () => {
    expect(
      resolveTurnReasoningLevel({ capability: deepseekCap, requested: "off", autoPicked: false }),
    ).toBe("off")
    expect(
      resolveTurnReasoningLevel({ capability: deepseekCap, requested: "low", autoPicked: false }),
    ).toBe("low")
    // Nothing asked: the model's default (Off for a model that can switch it off).
    expect(
      resolveTurnReasoningLevel({ capability: deepseekCap, requested: null, autoPicked: false }),
    ).toBe("off")
  })

  it("Auto on a model that cannot reason runs Off", () => {
    const none = getReasoningCapability("some-model", "openrouter")
    expect(resolveTurnReasoningLevel({ capability: none, requested: null, autoPicked: true })).toBe(
      "off",
    )
  })

  it("Auto on a native reasoning model runs at High too", () => {
    const cap = getReasoningCapability("claude-haiku-4-5", "anthropic")
    expect(resolveTurnReasoningLevel({ capability: cap, requested: "off", autoPicked: true })).toBe(
      "high",
    )
  })
})

describe("resolveTurnReasoningLevel — the organization's default level", () => {
  const deepseekCap = getReasoningCapability(
    "openrouter/deepseek/deepseek-v4.1-flash",
    "openrouter",
    { reasoningEfforts: ["low", "high"], canDisableReasoning: true },
  )

  it("a chosen model with no level asked runs at the org default, not its own Off", () => {
    for (const requested of [undefined, null] as const) {
      expect(
        resolveTurnReasoningLevel({
          capability: deepseekCap,
          requested,
          autoPicked: false,
          orgDefault: "high",
        }),
      ).toBe("high")
    }
  })

  it("a level asked for (conversation or routine) beats the org default, Off included", () => {
    expect(
      resolveTurnReasoningLevel({
        capability: deepseekCap,
        requested: "off",
        autoPicked: false,
        orgDefault: "high",
      }),
    ).toBe("off")
    expect(
      resolveTurnReasoningLevel({
        capability: deepseekCap,
        requested: "low",
        autoPicked: false,
        orgDefault: "high",
      }),
    ).toBe("low")
  })

  it("Auto runs at the org default instead of High, but a demo box key's level wins", () => {
    expect(
      resolveTurnReasoningLevel({
        capability: deepseekCap,
        requested: "high",
        autoPicked: true,
        orgDefault: "low",
      }),
    ).toBe("low")
    expect(
      resolveTurnReasoningLevel({
        capability: deepseekCap,
        requested: null,
        autoPicked: true,
        autoLevel: "low",
        orgDefault: "high",
      }),
    ).toBe("low")
  })

  it("an org default the model cannot run falls back to the model's default", () => {
    // A Gemini model cannot switch reasoning off: an org default of Off runs its Low.
    const gemini = getReasoningCapability("gemini-3-flash", "google")
    expect(
      resolveTurnReasoningLevel({
        capability: gemini,
        requested: null,
        autoPicked: false,
        orgDefault: "off",
      }),
    ).toBe("low")
    // A model that cannot reason runs Off whatever the org default.
    const none = getReasoningCapability("some-model", "custom")
    expect(
      resolveTurnReasoningLevel({
        capability: none,
        requested: null,
        autoPicked: false,
        orgDefault: "high",
      }),
    ).toBe("off")
    // DeepSeek takes low and high: an org default of Medium is clamped to an
    // effort it takes when the call is built.
    const level = resolveTurnReasoningLevel({
      capability: deepseekCap,
      requested: null,
      autoPicked: false,
      orgDefault: "medium",
    })
    expect(level).toBe("medium")
    expect(
      buildReasoning("openrouter", level, "deepseek/deepseek-v4.1-flash", {
        reasoningEfforts: ["low", "high"],
        canDisableReasoning: true,
      }).providerOptions,
    ).toBeDefined()
  })
})
