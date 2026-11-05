// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The environment variable holding the deployment's own key for each provider:
// the platform fallback for an org that has not brought its own key. Kept free
// of imports so deployment checks can read it without loading the server env.
export const ENV_KEY_MAP: Record<string, string> = {
  anthropic: "LIAISON_ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  exa: "EXA_API_KEY",
}
