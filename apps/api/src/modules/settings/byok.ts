// SPDX-License-Identifier: FSL-1.1-ALv2
// The model providers an organization can bring its own key for, and their
// names as people read them. One list for the key routes and the secret card.

export const BYOK_PROVIDERS = ["anthropic", "openai", "google", "mistral", "openrouter"] as const
export type ByokProvider = (typeof BYOK_PROVIDERS)[number]

export const BYOK_PROVIDER_NAMES: Record<ByokProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
  openrouter: "OpenRouter",
}
