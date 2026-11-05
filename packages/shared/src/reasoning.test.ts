// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  canDisableThinking,
  getReasoningCapability,
  REASONING_LEVELS,
  reasoningCapableProvider,
  reasoningLevelSchema,
} from "./reasoning"

describe("reasoning level vocabulary", () => {
  it("exposes the canonical ordered levels", () => {
    expect([...REASONING_LEVELS]).toEqual(["off", "low", "medium", "high"])
  })

  it("validates levels via the zod schema", () => {
    for (const l of REASONING_LEVELS) expect(reasoningLevelSchema.parse(l)).toBe(l)
    expect(reasoningLevelSchema.safeParse("ultra").success).toBe(false)
    expect(reasoningLevelSchema.safeParse("").success).toBe(false)
  })
})

describe("reasoningCapableProvider", () => {
  it("treats anthropic/openai/google as reasoning providers", () => {
    expect(reasoningCapableProvider("anthropic", "claude-opus-4-6")).toBe(true)
    expect(reasoningCapableProvider("openai", "gpt-5.4")).toBe(true)
    expect(reasoningCapableProvider("google", "gemini-flash-latest")).toBe(true)
  })

  it("only treats magistral Mistral models as reasoning-capable", () => {
    expect(reasoningCapableProvider("mistral", "mistral-large-latest")).toBe(false)
    expect(reasoningCapableProvider("mistral", "magistral-medium-latest")).toBe(true)
  })

  it("rejects unknown/system providers", () => {
    expect(reasoningCapableProvider("system", "web_search")).toBe(false)
    expect(reasoningCapableProvider(undefined, "x")).toBe(false)
    expect(reasoningCapableProvider("custom", "x")).toBe(false)
  })
})

describe("getReasoningCapability", () => {
  it("resolves provider from the pricing seed for a known model", () => {
    const cap = getReasoningCapability("claude-sonnet-4-6")
    expect(cap.supportsReasoning).toBe(true)
    expect(cap.allowedLevels).toEqual(["off", "low", "medium", "high"])
    expect(cap.defaultLevel).toBe("off")
  })

  it("reports non-reasoning models with only Off", () => {
    const cap = getReasoningCapability("mistral-large-latest")
    expect(cap.supportsReasoning).toBe(false)
    expect(cap.allowedLevels).toEqual(["off"])
    expect(cap.defaultLevel).toBe("off")
  })

  it("defaults unknown model ids to non-reasoning (safe)", () => {
    expect(getReasoningCapability("some-unseen-model").supportsReasoning).toBe(false)
  })

  it("accepts an explicit provider override (backend has ModelInfo.provider)", () => {
    const cap = getReasoningCapability("magistral-medium-latest", "mistral")
    expect(cap.supportsReasoning).toBe(true)
    expect(cap.allowedLevels).toEqual(["off", "low", "medium", "high"])
  })

  it("reports canDisableThinking true for ordinary reasoning-capable models", () => {
    expect(getReasoningCapability("claude-sonnet-4-6").canDisableThinking).toBe(true)
  })

  it("excludes Off and defaults to an on-level for every Gemini model (thinking is mandatory)", () => {
    for (const modelId of [
      "gemini-pro-latest",
      "gemini-flash-latest",
      "gemini-flash-lite-latest",
    ]) {
      const cap = getReasoningCapability(modelId, "google")
      expect(cap.supportsReasoning).toBe(true)
      expect(cap.canDisableThinking).toBe(false)
      expect(cap.allowedLevels).toEqual(["low", "medium", "high"])
      expect(cap.allowedLevels).not.toContain("off")
      expect(cap.defaultLevel).not.toBe("off")
    }
  })
})

describe("canDisableThinking", () => {
  it("is true for non-google providers regardless of model id", () => {
    expect(canDisableThinking("anthropic", "claude-opus-4-6")).toBe(true)
    expect(canDisableThinking("openai", "gpt-5.4")).toBe(true)
    expect(canDisableThinking(undefined, "gemini-pro-latest")).toBe(true)
  })

  // Gemini rejects thinkingBudget 0 on EVERY current model — Pro, Flash and
  // Flash Lite alike (bare 400 "Request contains an invalid argument.",
  // verified live 2026-07-22 after the pinned 2.5 models were retired and the
  // -latest aliases repointed). This pins the fix for the chat-killing 400 on
  // gemini-flash-lite-latest.
  it("is false for every Gemini model", () => {
    expect(canDisableThinking("google", "gemini-pro-latest")).toBe(false)
    expect(canDisableThinking("google", "gemini-2.5-pro")).toBe(false)
    expect(canDisableThinking("google", "gemini-3-pro")).toBe(false)
    expect(canDisableThinking("google", "gemini-3-pro-preview")).toBe(false)
    expect(canDisableThinking("google", "gemini-flash-latest")).toBe(false)
    expect(canDisableThinking("google", "gemini-flash-lite-latest")).toBe(false)
  })
})

describe("getReasoningCapability for an added model (OpenRouter)", () => {
  it("offers Off plus the three on levels when the model can switch reasoning off", () => {
    const cap = getReasoningCapability("openrouter/deepseek/deepseek-v4.1-flash", "openrouter", {
      reasoningEfforts: ["low", "high"],
      canDisableReasoning: true,
    })
    expect(cap.supportsReasoning).toBe(true)
    expect(cap.allowedLevels).toEqual(["off", "low", "medium", "high"])
    expect(cap.defaultLevel).toBe("off")
  })

  it("removes Off when reasoning is mandatory, as for Gemini", () => {
    const cap = getReasoningCapability("openrouter/x/y", "openrouter", {
      reasoningEfforts: ["low", "medium", "high"],
      canDisableReasoning: false,
    })
    expect(cap.allowedLevels).toEqual(["low", "medium", "high"])
    expect(cap.defaultLevel).toBe("low")
    expect(cap.canDisableThinking).toBe(false)
  })

  it("allows Off only for a model with no reasoning control", () => {
    const cap = getReasoningCapability("openrouter/x/plain", "openrouter", {
      reasoningEfforts: [],
      canDisableReasoning: false,
    })
    expect(cap.supportsReasoning).toBe(false)
    expect(cap.allowedLevels).toEqual(["off"])
    expect(cap.defaultLevel).toBe("off")
  })

  it("treats an OpenRouter or custom model without capabilities as Off only", () => {
    expect(getReasoningCapability("openrouter/x/y", "openrouter").allowedLevels).toEqual(["off"])
    expect(getReasoningCapability("custom/abcd1234/llama", "custom").allowedLevels).toEqual(["off"])
  })
})
