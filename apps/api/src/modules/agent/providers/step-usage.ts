// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Token counts of one model step, read from the AI SDK's `LanguageModelUsage`
// (a stream `finish-step` part, an `onStepEnd` step, a result).
//
// AI SDK 7 removed the flat `cachedInputTokens` / `reasoningTokens` fields and
// Anthropic's `providerMetadata.anthropic.cacheCreationInputTokens`; the counts
// live in `inputTokenDetails` / `outputTokenDetails`. Reading the old names
// returned undefined, which counted every cache hit as uncached (the runaway
// guard's budget) and dropped cache reads and writes from usage accounting.
// Every reader goes through here so the shape is named once.

interface SdkUsage {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number }
  outputTokenDetails?: { reasoningTokens?: number }
  /** The provider's own usage object. Anthropic's carries the write split by
   *  TTL: `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`. */
  raw?: { cache_creation?: { ephemeral_5m_input_tokens?: unknown } | null }
}

export interface StepUsage {
  inputTokens: number | undefined
  outputTokens: number | undefined
  /** Input tokens served from the provider's prompt cache. */
  cacheReadTokens: number
  reasoningTokens: number
  /**
   * Input tokens written to the provider's cache (Anthropic reports it).
   * Undefined when the provider reported nothing: not the same as a measured 0.
   */
  cacheWriteTokens: number | undefined
  /**
   * The part of cacheWriteTokens written with the 5-minute TTL (Anthropic's
   * `cache_creation.ephemeral_5m_input_tokens`), priced at 1.25x instead of the
   * 1h rate. Undefined when the provider did not break the writes down.
   */
  cacheWrite5mTokens: number | undefined
}

export function readStepUsage(usage: unknown): StepUsage {
  const u = (usage ?? {}) as SdkUsage
  const write = u.inputTokenDetails?.cacheWriteTokens
  const write5m = u.raw?.cache_creation?.ephemeral_5m_input_tokens
  return {
    inputTokens: typeof u.inputTokens === "number" ? u.inputTokens : undefined,
    outputTokens: typeof u.outputTokens === "number" ? u.outputTokens : undefined,
    cacheReadTokens: u.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? 0,
    cacheWriteTokens: typeof write === "number" ? write : undefined,
    cacheWrite5mTokens: typeof write5m === "number" ? write5m : undefined,
  }
}

/**
 * Input tokens of one step that the provider did NOT serve from its cache: what
 * the runaway guards (agent loop and sub-runs) budget. Every provider counts
 * cache reads inside inputTokens (AI SDK 6 and 7 alike), so they are subtracted.
 */
export function uncachedInputTokens(usage: unknown): number {
  const u = readStepUsage(usage)
  return Math.max(0, (u.inputTokens ?? 0) - u.cacheReadTokens)
}

/**
 * What the provider says one step cost, in USD, when it says so: OpenRouter's usage
 * accounting (`providerMetadata.openrouter.usage.cost`, in USD credits, cache discounts and
 * the upstream's own rates applied). Undefined for every other provider and for a step that
 * reported none, which is not the same as a measured 0.
 */
export function readProviderCostUsd(providerMetadata: unknown): number | undefined {
  const cost = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)
    ?.openrouter?.usage?.cost
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined
}

/**
 * The upstream that served one step through OpenRouter (`providerMetadata.openrouter.provider`,
 * e.g. "DeepInfra"), or undefined for every other provider. Each upstream keeps its own prompt
 * cache, so a step served elsewhere than the step before reads nothing from cache.
 */
export function readUpstreamProvider(providerMetadata: unknown): string | undefined {
  const provider = (providerMetadata as { openrouter?: { provider?: unknown } } | undefined)
    ?.openrouter?.provider
  return typeof provider === "string" && provider !== "" ? provider : undefined
}

/**
 * A turn's reported cost so far, one step added: `undefined` before the first step, the USD
 * sum while every step reported its cost, and `null` from the first step that did not, after
 * which the turn's cost is unknown and the meter estimates it from the tokens instead.
 */
export function addProviderCostUsd(
  acc: number | null | undefined,
  providerMetadata: unknown,
): number | null {
  const cost = readProviderCostUsd(providerMetadata)
  if (acc === null || cost === undefined) return null
  return (acc ?? 0) + cost
}
