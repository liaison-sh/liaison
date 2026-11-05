// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The model and the usage of a SIDE call: the model calls made outside the
// agent loop (compaction, checkpoint briefs, memory consolidation, auto-title,
// ticket summaries, proofreading, web extraction). One factory so each gets
// what the loop gets:
//   - the per-step size limit preCheck sets for the reserved demo org
//     (withStepTokenCap); side calls used to resolve a bare model and bypass it;
//   - its usage read the AI SDK 7 way (readStepUsage), cache reads and writes
//     included, so a call that is metered is priced with the cache split.
//
// Prompt-cache breakpoints are deliberately NOT set on side calls (decision,
// 2026-10-01): their only stable prefix is a system prompt of 0.3-2 k chars,
// under Anthropic's minimum cacheable size (1,024 tokens, 2,048 on Haiku), and
// the rest of each request (the brief so far + a new region, one episode, one
// page, one ticket) is never re-sent. A breakpoint written and not read again
// costs the write premium (2x on the 1h TTL) for nothing. Gemini and OpenAI,
// the likely cheapest auto models, cache the system prefix implicitly.
import type { LanguageModel } from "ai"
import { resolveModelFromCredit } from "~/modules/agent/providers/provider"
import { type StepTokenCap, withStepTokenCap } from "~/modules/agent/providers/step-token-cap"
import { readProviderCostUsd, readStepUsage } from "~/modules/agent/providers/step-usage"

export async function resolveSideCallModel(
  credit: {
    model: {
      provider: string
      modelId: string
      upstreamId?: string
      baseURL?: string
      stepTokenCap?: StepTokenCap | null
    }
    providerKey: string
    /** The org the credit check ran for: its OpenRouter blocked hosts apply. */
    orgId?: string
  },
  opts: {
    /** The thread the call works on: an OpenRouter call stays on that thread's upstream host. */
    threadId?: string | null
  } = {},
): Promise<LanguageModel> {
  const model = await resolveModelFromCredit(
    credit,
    opts.threadId ? { providerThreadId: opts.threadId } : {},
  )
  return withStepTokenCap(model, credit.model.stepTokenCap ?? null)
}

/**
 * A side call's usage in finalizeUsage's terms (a result's total usage). Pass the result's
 * `providerMetadata` too: the cost the provider reported for the call (OpenRouter) is then
 * what the call is metered at, instead of an estimate from its tokens.
 */
export function sideCallUsage(
  usage: unknown,
  providerMetadata?: unknown,
): {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteTokens?: number
  cacheWrite5mTokens?: number
  providerCostUsd?: number
} {
  const u = readStepUsage(usage)
  const cost = readProviderCostUsd(providerMetadata)
  return {
    ...(cost !== undefined ? { providerCostUsd: cost } : {}),
    inputTokens: u.inputTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    cachedInputTokens: u.cacheReadTokens,
    ...(u.cacheWriteTokens !== undefined ? { cacheWriteTokens: u.cacheWriteTokens } : {}),
    ...(u.cacheWrite5mTokens !== undefined ? { cacheWrite5mTokens: u.cacheWrite5mTokens } : {}),
  }
}
