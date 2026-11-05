// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Canonical model pricing seed — single source of truth for dev, QA, and E2E.
 *
 * Model IDs MUST match the LiteLLM model_prices_and_context_window.json database
 * (https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json).
 * The syncModelPricing job uses LiteLLM as the authoritative source for live pricing;
 * this seed provides bootstrap data so the app works before the first sync.
 *
 * Costs are in EUR per 1M tokens (converted from USD at ~1.15 ECB rate).
 */

export interface ModelPricingSeedEntry {
  provider: string
  modelId: string
  displayName: string
  inputCostPerM: string
  outputCostPerM: string
  contextWindow: number
  autoEligible: boolean
  tierMinimum: string
  source: string
}

export const MODEL_PRICING_SEED: ModelPricingSeedEntry[] = [
  // ── Anthropic ──────────────────────────────────────────────────────────────
  {
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    displayName: "Claude Opus 4.6",
    inputCostPerM: "4.35000000",
    outputCostPerM: "21.74000000",
    contextWindow: 1000000,
    autoEligible: false,
    tierMinimum: "team",
    source: "manual",
  },
  {
    provider: "anthropic",
    modelId: "claude-sonnet-4-6",
    displayName: "Claude Sonnet 4.6",
    inputCostPerM: "2.61000000",
    outputCostPerM: "13.04000000",
    contextWindow: 1000000,
    autoEligible: false,
    tierMinimum: "starter",
    source: "manual",
  },
  {
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    inputCostPerM: "0.87000000",
    outputCostPerM: "4.35000000",
    contextWindow: 200000,
    // Anthropic's auto model, so an org with only an Anthropic key has auto
    // mode too (migration 0139 sets the same on existing catalogs).
    autoEligible: true,
    tierMinimum: "starter",
    source: "manual",
  },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  {
    provider: "openai",
    modelId: "gpt-5.4",
    displayName: "GPT-5.4",
    inputCostPerM: "2.17000000",
    outputCostPerM: "13.04000000",
    contextWindow: 1048576,
    autoEligible: false,
    tierMinimum: "starter",
    source: "manual",
  },
  {
    provider: "openai",
    modelId: "gpt-5.4-nano",
    displayName: "GPT-5.4 Nano",
    inputCostPerM: "0.17000000",
    outputCostPerM: "1.09000000",
    contextWindow: 1048576,
    autoEligible: true,
    tierMinimum: "starter",
    source: "manual",
  },
  {
    // Medium tier — sits between -nano (weak floor) and the full -5.4. Not
    // auto-eligible (an explicit "stronger model" choice, e.g. the chaos agent
    // override for proven-model-blocked scenarios — the OpenAI analog of
    // gemini-flash). Cost is the published mid-tier estimate; refine if billed
    // rates differ.
    provider: "openai",
    modelId: "gpt-5.4-mini",
    displayName: "GPT-5.4 Mini",
    inputCostPerM: "0.43000000",
    outputCostPerM: "3.48000000",
    contextWindow: 1048576,
    autoEligible: false,
    tierMinimum: "starter",
    source: "manual",
  },

  // ── Google ─────────────────────────────────────────────────────────────────
  {
    provider: "google",
    modelId: "gemini-pro-latest",
    displayName: "Gemini Pro",
    inputCostPerM: "1.09000000",
    outputCostPerM: "8.70000000",
    contextWindow: 1048576,
    autoEligible: false,
    tierMinimum: "starter",
    source: "manual",
  },
  {
    provider: "google",
    modelId: "gemini-flash-latest",
    displayName: "Gemini Flash",
    inputCostPerM: "0.26000000",
    outputCostPerM: "2.17000000",
    contextWindow: 1048576,
    autoEligible: true,
    tierMinimum: "starter",
    source: "manual",
  },
  {
    provider: "google",
    modelId: "gemini-flash-lite-latest",
    displayName: "Gemini Flash-Lite",
    inputCostPerM: "0.09000000",
    outputCostPerM: "0.35000000",
    contextWindow: 1048576,
    autoEligible: true,
    tierMinimum: "starter",
    source: "manual",
  },

  // ── Mistral ────────────────────────────────────────────────────────────────
  {
    provider: "mistral",
    modelId: "mistral-large-latest",
    displayName: "Mistral Large 3",
    inputCostPerM: "0.43000000",
    outputCostPerM: "1.30000000",
    contextWindow: 128000,
    autoEligible: false,
    tierMinimum: "starter",
    source: "manual",
  },
  {
    provider: "mistral",
    modelId: "mistral-small-latest",
    displayName: "Mistral Small 4",
    inputCostPerM: "0.13000000",
    outputCostPerM: "0.52000000",
    contextWindow: 262144,
    autoEligible: true,
    tierMinimum: "starter",
    source: "manual",
  },

  // ── System ─────────────────────────────────────────────────────────────────
  {
    provider: "system",
    modelId: "web_search",
    displayName: "Web Search (Exa)",
    inputCostPerM: "0.00000000",
    outputCostPerM: "0.00000000",
    contextWindow: 0,
    autoEligible: false,
    tierMinimum: "starter",
    source: "manual",
  },
]

/** Bootstrap ECB rate value for seeding (USD → EUR). */
export const BOOTSTRAP_ECB_RATE = { rate: 1.15, fetchedAt: "2026-04-06T00:00:00Z" }
