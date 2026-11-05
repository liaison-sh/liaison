// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  AUTO_REASONING_LEVEL,
  canDisableThinking,
  REASONING_LEVELS,
  type ReasoningLevel,
  resolveTurnReasoningLevel,
} from "@liaison/shared"
import type { streamText } from "ai"

/**
 * The `providerOptions` shape `streamText` accepts. Derived from the SDK function
 * signature so we don't depend on the deep `@ai-sdk/provider-utils` type path
 * (which isn't a direct dependency and won't resolve under TS).
 */
export type AgentProviderOptions = NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>

export type { ReasoningLevel }
// Re-export the shared vocabulary so server-side callers can import it alongside
// the provider mapping from one module.
// The turn's level rule is shared with the web, whose model menu shows the
// level a turn really runs at (packages/shared/src/reasoning.ts).
export { AUTO_REASONING_LEVEL, REASONING_LEVELS, resolveTurnReasoningLevel }

/**
 * Reasoning level + provider-quirk mapping.
 *
 * The product exposes ONE discrete vocabulary — Off / Low / Medium / High — but
 * every provider wires reasoning differently, and they differ in what they emit:
 *   - Anthropic streams the FULL thinking text (deltas) when enabled.
 *   - OpenAI streams only a SUMMARY (raw chain-of-thought is encrypted) and only
 *     when `reasoningSummary` is requested.
 *   - Google streams "thought" SUMMARY parts, and only when `includeThoughts` is set.
 *   - Some models / redacted blocks emit NO readable text — just reasoning tokens.
 *
 * `buildReasoning` is the single source of truth that (a) translates a level into
 * each provider's AI-SDK `providerOptions` shape, always REQUESTING maximum
 * reasoning visibility, and (b) declares the resulting `streamMode` so the capture
 * pipeline + the thinking-block UI can adapt (full body / summary body / none).
 */

/** How a provider surfaces reasoning for a given plan. */
export type ReasoningStreamMode = "full" | "summary" | "none"

export interface ReasoningPlan {
  /**
   * Per-provider `providerOptions` fragment to merge into the `streamText` call.
   * `undefined` when nothing should be sent (unknown provider).
   */
  providerOptions?: AgentProviderOptions
  streamMode: ReasoningStreamMode
}

/**
 * Anthropic extended-thinking token budgets per on-level. The API floor is 1024;
 * these are deliberate, ascending buckets that the High tier can afford to spend.
 */
export const ANTHROPIC_BUDGET_TOKENS: Record<Exclude<ReasoningLevel, "off">, number> = {
  low: 4096,
  medium: 10240,
  high: 24576,
}

type OnLevel = Exclude<ReasoningLevel, "off">

/** What an added model's entry says about reasoning (org settings `ai.models.added`). */
export interface AddedModelReasoningCaps {
  reasoningEfforts: readonly OnLevel[]
  canDisableReasoning: boolean
}

const ON_LEVELS: readonly OnLevel[] = ["low", "medium", "high"]

/**
 * The effort to send for `level` to a model that accepts only `efforts`: the
 * level itself when the model has it, else the nearest LOWER effort it has,
 * else the nearest higher one. Null when the model has no effort at all.
 * (DeepSeek V4.1 Flash takes low and high: medium is sent as low.)
 */
export function clampReasoningEffort(level: OnLevel, efforts: readonly OnLevel[]): OnLevel | null {
  if (efforts.includes(level)) return level
  const at = ON_LEVELS.indexOf(level)
  for (let i = at - 1; i >= 0; i--) {
    const lower = ON_LEVELS[i] as OnLevel
    if (efforts.includes(lower)) return lower
  }
  for (let i = at + 1; i < ON_LEVELS.length; i++) {
    const higher = ON_LEVELS[i] as OnLevel
    if (efforts.includes(higher)) return higher
  }
  return null
}

export function buildReasoning(
  provider: string,
  level: ReasoningLevel,
  modelId?: string,
  addedCaps?: AddedModelReasoningCaps,
): ReasoningPlan {
  switch (provider) {
    case "openrouter": {
      // The effort travels as the `reasoning` field only. The routing options
      // (data policy, parameter routing) are model settings of the provider
      // (provider.ts), which this fragment merges beside and never replaces.
      const efforts = addedCaps?.reasoningEfforts ?? []
      if (efforts.length === 0) return { providerOptions: undefined, streamMode: "none" }
      if (level === "off") {
        // Off is offered only when the model can switch reasoning off
        // (getReasoningCapability); a stale Off on a mandatory reasoner sends
        // nothing and the model's own default applies.
        if (!addedCaps?.canDisableReasoning)
          return { providerOptions: undefined, streamMode: "full" }
        return {
          providerOptions: { openrouter: { reasoning: { effort: "none" } } },
          streamMode: "none",
        }
      }
      const effort = clampReasoningEffort(level, efforts)
      if (!effort) return { providerOptions: undefined, streamMode: "none" }
      return { providerOptions: { openrouter: { reasoning: { effort } } }, streamMode: "full" }
    }

    case "anthropic":
      if (level === "off") {
        return {
          providerOptions: { anthropic: { thinking: { type: "disabled" } } },
          streamMode: "none",
        }
      }
      return {
        providerOptions: {
          anthropic: {
            thinking: { type: "enabled", budgetTokens: ANTHROPIC_BUDGET_TOKENS[level] },
            // Echo reasoning back across tool-loop steps so multi-step runs keep it.
            sendReasoning: true,
          },
        },
        streamMode: "full",
      }

    case "openai":
      if (level === "off") {
        return { providerOptions: { openai: { reasoningEffort: "none" } }, streamMode: "none" }
      }
      return {
        // Raw CoT is never exposed; request the auto summary so the block has text.
        providerOptions: { openai: { reasoningEffort: level, reasoningSummary: "auto" } },
        streamMode: "summary",
      }

    case "google":
      if (level === "off") {
        // Defense in depth: every current Gemini model rejects
        // `thinkingBudget: 0` with a bare HTTP 400 ("Request contains an
        // invalid argument." — the Pro family used to say "This model only
        // works in thinking mode"; since the Gemini 3 era alias repoint, Flash
        // and Flash Lite reject it too). The caller (agent-service) is expected
        // to have already clamped `level` away from "off" via
        // `getReasoningCapability`, but if an "off" request reaches here for a
        // model that can't disable thinking, omit thinkingConfig entirely
        // rather than send a budget the API will reject — the provider default
        // (thinking enabled) applies instead of a hard failure.
        if (!canDisableThinking(provider, modelId ?? "")) {
          return { providerOptions: undefined, streamMode: "summary" }
        }
        return {
          providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
          streamMode: "none",
        }
      }
      return {
        // includeThoughts is required for thought-summary parts to appear at all.
        providerOptions: {
          google: { thinkingConfig: { thinkingLevel: level, includeThoughts: true } },
        },
        streamMode: "summary",
      }

    case "mistral":
      if (level === "off") {
        return { providerOptions: { mistral: { reasoningEffort: "none" } }, streamMode: "none" }
      }
      // The Mistral effort enum is binary (none | high); every on-level maps to high.
      return { providerOptions: { mistral: { reasoningEffort: "high" } }, streamMode: "full" }

    default:
      // Unknown / custom providers: never send reasoning options, surface nothing.
      return { providerOptions: undefined, streamMode: "none" }
  }
}
