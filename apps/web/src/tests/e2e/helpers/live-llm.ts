// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Live-LLM journeys call a real model provider: they cost money, depend on the
 * provider being up, and are not deterministic. They stay out of the default
 * Playwright run and run only when asked for with `PLAYWRIGHT_LIVE_LLM=1`
 * (plus the provider key the journey needs).
 */
export const LIVE_LLM = process.env.PLAYWRIGHT_LIVE_LLM === "1"

export const LIVE_LLM_SKIP_REASON =
  "live-LLM journey: calls a real model provider, run it with PLAYWRIGHT_LIVE_LLM=1"

/**
 * A live run that reaches the REAL OpenRouter (PLAYWRIGHT_REAL_OPENROUTER=1,
 * with PLAYWRIGHT_LIVE_LLM=1): global-setup then starts no OpenRouter stub, so
 * the servers call openrouter.ai with the real key (speech to text, which the
 * stub does not serve). Journeys built on the stub's catalogue skip in it.
 */
export const REAL_OPENROUTER = LIVE_LLM && process.env.PLAYWRIGHT_REAL_OPENROUTER === "1"

export const REAL_OPENROUTER_SKIP_REASON =
  "real-OpenRouter journey: run it with PLAYWRIGHT_LIVE_LLM=1 PLAYWRIGHT_REAL_OPENROUTER=1"

export const NEEDS_OPENROUTER_STUB_REASON =
  "built on the OpenRouter stub, which a PLAYWRIGHT_REAL_OPENROUTER=1 run does not start"
