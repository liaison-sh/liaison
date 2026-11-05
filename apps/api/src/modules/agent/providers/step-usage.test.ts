// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  addProviderCostUsd,
  readProviderCostUsd,
  readStepUsage,
  readUpstreamProvider,
} from "./step-usage"

describe("readStepUsage reads AI SDK 7's LanguageModelUsage", () => {
  it("takes cache reads, cache writes and reasoning from the detail objects", () => {
    expect(
      readStepUsage({
        inputTokens: 1000,
        outputTokens: 50,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 850, cacheWriteTokens: 50 },
        outputTokenDetails: { textTokens: 20, reasoningTokens: 30 },
      }),
    ).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 850,
      reasoningTokens: 30,
      cacheWriteTokens: 50,
      cacheWrite5mTokens: undefined,
    })
  })

  it("reads the 5-minute part of the writes from Anthropic's raw usage", () => {
    const u = readStepUsage({
      inputTokens: 1000,
      outputTokens: 5,
      inputTokenDetails: { cacheReadTokens: 600, cacheWriteTokens: 300 },
      raw: {
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 120, ephemeral_1h_input_tokens: 180 },
      },
    })
    expect(u.cacheWriteTokens).toBe(300)
    expect(u.cacheWrite5mTokens).toBe(120)
  })

  it("keeps an unreported cache write absent, not zero", () => {
    const u = readStepUsage({ inputTokens: 10, outputTokens: 1, inputTokenDetails: {} })
    expect(u.cacheWriteTokens).toBeUndefined()
    expect(u.cacheReadTokens).toBe(0)
  })

  it("survives a missing usage", () => {
    expect(readStepUsage(undefined).inputTokens).toBeUndefined()
  })
})

describe("the cost a provider reports for a step", () => {
  const openrouter = (cost: unknown) => ({ openrouter: { usage: { promptTokens: 10, cost } } })

  it("reads OpenRouter's usage accounting cost (USD) off the step's providerMetadata", () => {
    expect(readProviderCostUsd(openrouter(0.0123))).toBe(0.0123)
    expect(readProviderCostUsd(openrouter(0))).toBe(0)
  })

  it("is undefined when the provider reported none", () => {
    expect(readProviderCostUsd(undefined)).toBeUndefined()
    expect(readProviderCostUsd({ openrouter: { usage: { promptTokens: 10 } } })).toBeUndefined()
    expect(readProviderCostUsd({ anthropic: { cacheCreationInputTokens: 3 } })).toBeUndefined()
    expect(readProviderCostUsd(openrouter("0.01"))).toBeUndefined()
    expect(readProviderCostUsd(openrouter(-1))).toBeUndefined()
    expect(readProviderCostUsd(openrouter(Number.NaN))).toBeUndefined()
  })

  it("sums across steps, and one step without a cost makes the turn's cost unknown", () => {
    let acc = addProviderCostUsd(undefined, openrouter(0.01))
    acc = addProviderCostUsd(acc, openrouter(0.0023))
    expect(acc).toBeCloseTo(0.0123, 10)
    expect(addProviderCostUsd(acc, undefined)).toBeNull()
    expect(addProviderCostUsd(null, openrouter(0.5))).toBeNull()
    expect(addProviderCostUsd(undefined, undefined)).toBeNull()
  })
})

describe("the upstream that served a step", () => {
  it("reads OpenRouter's upstream provider off the step's providerMetadata", () => {
    expect(readUpstreamProvider({ openrouter: { provider: "DeepInfra" } })).toBe("DeepInfra")
  })

  it("is undefined for any other provider or a step without one", () => {
    expect(readUpstreamProvider(undefined)).toBeUndefined()
    expect(readUpstreamProvider({ openrouter: { usage: { cost: 0.1 } } })).toBeUndefined()
    expect(readUpstreamProvider({ openrouter: { provider: "" } })).toBeUndefined()
    expect(readUpstreamProvider({ anthropic: { provider: "x" } })).toBeUndefined()
  })
})
