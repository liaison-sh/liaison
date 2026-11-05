// SPDX-License-Identifier: FSL-1.1-ALv2
// A `GET /credits/models` answer for tests: the native catalogue an org with
// every provider keyed is served, in the S6 shape. Tests install it with
// `setServedModels(parseServedModels(SERVED_MODELS_FIXTURE))` (or a variant)
// instead of relying on a static list the web app no longer has.
import type { ReasoningLevel } from "@liaison/shared"

const ALL: ReasoningLevel[] = ["off", "low", "medium", "high"]
const NO_OFF: ReasoningLevel[] = ["low", "medium", "high"]
const OFF_ONLY: ReasoningLevel[] = ["off"]

function entry(
  key: string,
  provider: string,
  providerLabel: string,
  displayName: string,
  levels: ReasoningLevel[],
  tierMinimum = "starter",
) {
  return {
    key,
    modelId: key,
    provider,
    providerLabel,
    displayName,
    tierMinimum,
    contextWindow: 200_000,
    inputCostPerM: "1.00",
    outputCostPerM: "5.00",
    reasoning: { allowedLevels: levels, defaultLevel: levels[0] },
    tools: true,
  }
}

export const SERVED_MODELS_FIXTURE = {
  autoModelKey: null,
  // Unresolved, so the Auto entry reads plain "Auto" in tests that are not
  // about it; the Auto label has its own test with a resolved key.
  autoResolvedKey: null as string | null,
  autoReasoningLevel: null,
  defaultReasoningLevel: null,
  models: [
    entry("claude-opus-4-6", "anthropic", "Anthropic", "Claude Opus 4.6", ALL, "team"),
    entry("claude-sonnet-4-6", "anthropic", "Anthropic", "Claude Sonnet 4.6", ALL),
    entry("claude-haiku-4-5", "anthropic", "Anthropic", "Claude Haiku 4.5", ALL),
    entry("gpt-5.4", "openai", "OpenAI", "GPT-5.4", ALL),
    entry("gpt-5.4-nano", "openai", "OpenAI", "GPT-5.4 Nano", ALL),
    entry("gemini-pro-latest", "google", "Google", "Gemini Pro", NO_OFF),
    entry("gemini-flash-latest", "google", "Google", "Gemini Flash", NO_OFF),
    entry("gemini-flash-lite-latest", "google", "Google", "Gemini Flash-Lite", NO_OFF),
    entry("mistral-large-latest", "mistral", "Mistral", "Mistral Large 3", OFF_ONLY),
    entry("mistral-small-latest", "mistral", "Mistral", "Mistral Small 4", OFF_ONLY),
  ],
}

/** A served OpenRouter model, with reasoning that cannot be switched off. */
export const SERVED_OPENROUTER_MODEL = {
  ...entry(
    "openrouter/deepseek/deepseek-v4.1-flash",
    "openrouter",
    "OpenRouter",
    "DeepSeek V4.1 Flash",
    ["low", "high"],
  ),
  contextWindow: 1_000_000,
}

/** A served model on an org's own server. */
export const SERVED_CUSTOM_MODEL = {
  ...entry("custom/ab12cd34/qwen3.5-32b", "custom", "GPU box", "qwen3.5-32b", OFF_ONLY),
  inputCostPerM: null,
  outputCostPerM: null,
}
