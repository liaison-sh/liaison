// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"
import { MODEL_PRICING_SEED } from "./model-pricing-seed"

/**
 * Canonical reasoning-level vocabulary + per-model capability, shared between the
 * web model picker (which level rows to show) and the API (validation + whether to
 * request reasoning). The provider-specific `providerOptions` mapping lives
 * server-side in `apps/api/.../modules/agent/providers/reasoning.ts`.
 */

export const REASONING_LEVELS = ["off", "low", "medium", "high"] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/** Zod schema for validating a level on the wire (request body / PATCH). */
export const reasoningLevelSchema = z.enum(REASONING_LEVELS)

export interface ModelReasoningCapability {
  supportsReasoning: boolean
  allowedLevels: ReasoningLevel[]
  defaultLevel: ReasoningLevel
  /**
   * Whether thinking/reasoning can be turned OFF for this model. False for
   * every Google/Gemini model (their API rejects `thinkingBudget: 0` with an
   * HTTP 400 — see `canDisableThinking`). Everything else defaults true.
   */
  canDisableThinking: boolean
}

const seedProviderById = new Map(MODEL_PRICING_SEED.map((m) => [m.modelId, m.provider]))

/**
 * Whether a provider+model can reason. All Anthropic/OpenAI/Google chat models
 * do; Mistral only for `magistral-*`; everything else (system, custom, unknown)
 * does not. Keyed on provider so a newly-synced model of a known provider is
 * covered without a registry edit.
 */
export function reasoningCapableProvider(provider: string | undefined, modelId: string): boolean {
  switch (provider) {
    case "anthropic":
    case "openai":
    case "google":
      return true
    case "mistral":
      return /^magistral/i.test(modelId)
    default:
      return false
  }
}

/**
 * Whether a given Google model allows `thinkingBudget: 0` / disabling thinking
 * entirely. As of 2026-07, the answer is NO for every Google chat model: the
 * pinned Gemini 2.5 models (the last ones that accepted budget 0) were retired
 * (404), and the `-latest` aliases now serve Gemini 3 era models — Pro, Flash
 * AND Flash Lite — which all reject `thinkingBudget: 0` with a bare HTTP 400
 * "Request contains an invalid argument." (verified against the live API per
 * model). Sending budget 0 therefore kills the whole turn on any Gemini model.
 * Non-Google providers are unaffected by this quirk and always report `true`
 * here — `buildReasoning` gates the Google-specific behavior on
 * `provider === "google"` regardless.
 */
export function canDisableThinking(provider: string | undefined, _modelId: string): boolean {
  return provider !== "google"
}

/**
 * Resolve a model's reasoning capability. `provider` may be passed explicitly
 * (the backend has it on `ModelInfo`); otherwise it is resolved from the pricing
 * seed. Unknown models degrade to non-reasoning (Off only) — safe by default.
 */
/**
 * What an ADDED model (OpenRouter, an org's own server) can do with reasoning,
 * read from the model's entry in org settings: the efforts its provider
 * accepts among low/medium/high, and whether reasoning can be switched off.
 */
export interface AddedModelReasoningCaps {
  reasoningEfforts: readonly ("low" | "medium" | "high")[]
  canDisableReasoning: boolean
}

export function getReasoningCapability(
  modelId: string,
  provider?: string,
  addedCaps?: AddedModelReasoningCaps,
): ModelReasoningCapability {
  if (provider === "openrouter" || provider === "custom") {
    // An added model reasons only when its entry says so. Every on level is
    // offered: a level the model lacks is clamped to its nearest effort when the
    // call is built (providers/reasoning.ts), so the picker rows never change
    // with the model.
    const efforts = addedCaps?.reasoningEfforts ?? []
    if (provider === "custom" || efforts.length === 0) {
      return {
        supportsReasoning: false,
        allowedLevels: ["off"],
        defaultLevel: "off",
        canDisableThinking: true,
      }
    }
    const disableable = addedCaps?.canDisableReasoning ?? false
    return {
      supportsReasoning: true,
      allowedLevels: disableable ? [...REASONING_LEVELS] : ["low", "medium", "high"],
      defaultLevel: disableable ? "off" : "low",
      canDisableThinking: disableable,
    }
  }
  const resolvedProvider = provider ?? seedProviderById.get(modelId)
  const supportsReasoning = reasoningCapableProvider(resolvedProvider, modelId)
  const disableable = canDisableThinking(resolvedProvider, modelId)
  const allowedLevels: ReasoningLevel[] = supportsReasoning ? [...REASONING_LEVELS] : ["off"]
  return {
    supportsReasoning,
    allowedLevels:
      supportsReasoning && !disableable ? allowedLevels.filter((l) => l !== "off") : allowedLevels,
    // Models that can't disable thinking must default to an ON level, never "off".
    defaultLevel: supportsReasoning && !disableable ? "low" : "off",
    canDisableThinking: disableable,
  }
}

/** The level a turn runs at when Auto picked its model. */
export const AUTO_REASONING_LEVEL: ReasoningLevel = "high"

/**
 * The level a demo box runs its visitor pin at on the box's own key (Auto on a
 * demo): low, so a visitor does not wait. The server sends it (the box-key
 * guard forces it on the request) and serves it as Auto's level, which the
 * model menu shows. Off the box key, Auto stays at `AUTO_REASONING_LEVEL`.
 */
export const DEMO_BOX_KEY_REASONING_LEVEL: ReasoningLevel = "low"

/**
 * THE LEVEL A TURN RUNS AT. A turn whose model Auto picked (nothing chosen by
 * the person, the conversation, the agent or the routine, or a demo's Auto
 * pin) runs at Auto's level, whatever level was asked: `autoLevel` (a demo box
 * key's Low), else the organization's default level (`orgDefault`, an admin's
 * `settings.ai.models.defaultReasoningLevel`), else High. Auto is sent an
 * explicit effort rather than nothing, so the provider's own default never
 * decides. Any other turn runs at the level asked for (the conversation's,
 * else the routine's), else the organization's default level, else the
 * model's default. Either way a level the model does not allow falls back to
 * its default (a model that cannot reason runs Off); `buildReasoning` then
 * clamps an on level to the efforts the model takes (DeepSeek V4.1 Flash: low
 * and high). The web model menu shows the level this returns, so the two
 * cannot disagree.
 */
export function resolveTurnReasoningLevel(input: {
  capability: Pick<ModelReasoningCapability, "allowedLevels" | "defaultLevel">
  requested: ReasoningLevel | null | undefined
  autoPicked: boolean
  /** The level Auto runs this model at, when not `AUTO_REASONING_LEVEL` (the server says). */
  autoLevel?: ReasoningLevel | null
  /** The organization's default level for a turn that asks for none. */
  orgDefault?: ReasoningLevel | null
}): ReasoningLevel {
  const { capability } = input
  const wanted = input.autoPicked
    ? (input.autoLevel ?? input.orgDefault ?? AUTO_REASONING_LEVEL)
    : (input.requested ?? input.orgDefault ?? capability.defaultLevel)
  return capability.allowedLevels.includes(wanted) ? wanted : capability.defaultLevel
}
