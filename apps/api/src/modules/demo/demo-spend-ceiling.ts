// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE RESERVED ORG'S MONEY, WRITTEN DOWN ONCE.
//
// The App Review org is the one demo org that spends the deployment's own keys
// (see demo-spend.ts). Its budget is a TOKEN ceiling over a rolling 24 hours,
// and the promise it keeps is in money: at most 1 EUR per rolling day. This
// file is the bridge between the two, with its sources, so the number in the
// environment can be checked against the price rather than trusted. It imports
// nothing, so env.ts can read its defaults without a cycle.
//
// ── THE MODEL ──────────────────────────────────────────────────────────────
// Every paid model call the reserved org makes is pinned to ONE model id,
// `gemini-flash-lite-latest`: the only Flash-Lite id in the model catalog
// (packages/shared/src/model-pricing-seed.ts), which is what makes it the id
// `preCheck` can resolve. It is an ALIAS that Google hot swaps to the newest
// Flash-Lite release, so the price used below is not the price of the release
// it points at today: it is the most expensive Flash-Lite on the pricing page,
// which is the price the alias can move to without anybody here deciding to.
//
// ── THE PRICE (checked 2026-09-28) ─────────────────────────────────────────
// https://ai.google.dev/gemini-api/docs/pricing, Standard, paid tier, per 1M
// tokens in USD, "Output price (including thinking tokens)":
//   gemini-3.5-flash-lite  2.50 USD   <- the most expensive Flash-Lite, used here
//   gemini-3.1-flash-lite  1.50 USD
//   gemini-2.5-flash-lite  0.40 USD
// Every Flash-Lite input price there (0.10 to 0.50 USD, audio included) is
// lower than 2.50, so billing EVERY token at 2.50 USD per million is the worst
// case for any mix of input and output.
//
// ── THE RATE (checked 2026-09-28) ──────────────────────────────────────────
// ECB euro foreign exchange reference rate, USD, 2026-09-25 (the latest
// published on 2026-09-28): 1 EUR = 1.1403 USD.
// https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
// https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html
//
// ── THE DERIVATION ─────────────────────────────────────────────────────────
//   tokens per EUR = floor(1.1403 USD / (2.50 USD / 1,000,000 tokens))
//                  = floor(456,120)
//                  = 456,120 tokens
//
// ── THE DEFAULT, AND THE STEPS IN FLIGHT ───────────────────────────────────
// The default ceiling is 200,000 tokens, well under 456,120. The ceiling is
// checked before a turn and between steps, and a step that is already running
// finishes, so the ledger can land past the ceiling by what the steps in flight
// at that moment spend (two). A step's input is not limited: the model's own
// context window, 1,048,576 tokens, bounds it, and each direction is billed at
// its own worst price (the most expensive Flash-Lite input on the page, audio
// included, is 0.50 USD per 1M tokens):
//   one step  1,048,576 x 0.50 + 16,000 x 2.50 = 0.524288 + 0.04 = 0.564288 USD
//   ceiling   200,000 x 2.50 / 1,000,000 = 0.50 USD
//   worst day 0.50 + 2 x 0.564288 = 1.628576 USD = 1.4282 EUR
// So the default holds the reserved org at about 0.44 EUR of tokens a rolling
// day, and at most 1.43 EUR once two maximal steps are in flight when it is
// crossed. Prompt caching makes a long context far cheaper than this bound.
//
// ── THE STEP'S OUTPUT, ENFORCED ────────────────────────────────────────────
// For the reserved org only, `resolveModelForPreCheck` (credit-meter.ts) hands
// the agent loop a step cap that `runAgentStream` applies to every request
// (agent/providers/step-token-cap.ts): output at most 16,000 tokens.
//
// ── NON MODEL SPEND ────────────────────────────────────────────────────────
// Web search is Exa, billed per request, and it is counted in the SAME token
// ledger at its worst case converted at the same output price:
// https://exa.ai/pricing (checked 2026-09-28): search 7 USD per 1,000 requests
// up to 10 results, plus 1 USD per 1,000 results above 10, plus contents text
// 1 USD per 1,000 pages. `web_search` asks for at most 20 results, so one call
// costs at most 0.007 + 10 x 0.001 + 20 x 0.001 = 0.037 USD
//   = 0.037 / (2.50 / 1,000,000) = 14,800 tokens, rounded up to 15,000.

/** Output price, USD per 1M tokens, of the most expensive Flash-Lite (gemini-3.5-flash-lite). */
export const RESERVED_WORST_OUTPUT_USD_PER_M = 2.5

/** ECB reference rate, USD per 1 EUR, 2026-09-25. */
export const ECB_USD_PER_EUR = 1.1403

/** floor(ECB_USD_PER_EUR / (RESERVED_WORST_OUTPUT_USD_PER_M / 1e6)): tokens that cost 1 EUR at worst. */
export const RESERVED_TOKENS_PER_EUR = 456_120

/** The default `LIAISON_DEMO_RESERVED_TOKEN_CEILING`. At most `RESERVED_TOKENS_PER_EUR`. */
export const RESERVED_TOKEN_CEILING_DEFAULT = 200_000

/** The one model id every paid model call of the reserved org runs on, unless the env names another. */
export const RESERVED_MODEL_DEFAULT = "gemini-flash-lite-latest"

/** One `web_search`, counted in the ledger as this many tokens (its worst case, see above). */
export const WEB_SEARCH_TOKEN_EQUIVALENT = 15_000

/** The output cap of one step of the reserved org (see THE STEP'S OUTPUT). */
export const RESERVED_STEP_OUTPUT_TOKENS = 16_000

/** Input price, USD per 1M tokens, of the most expensive Flash-Lite input (audio included). */
export const RESERVED_WORST_INPUT_USD_PER_M = 0.5

/** The reserved model's context window, the bound of one step's input (see above). */
export const RESERVED_MODEL_CONTEXT_WINDOW = 1_048_576

/** How many steps can be in flight when the ceiling is crossed (see THE DEFAULT). */
export const RESERVED_STEPS_IN_FLIGHT = 2

// ════════════════════════════════════════════════════════════════════════════
// A VERIFIED VISITOR'S MONEY, WRITTEN DOWN ONCE.
//
// A visitor org whose visitor confirmed an email runs on this box's OpenRouter
// key, inside a budget in integer micro-EUR (µEUR) per email, per client
// network, per box day and per rolling box hour (demo-budget.ts). This block
// derives every price the budget reserves and settles with, from dated
// sources, so a number can be checked rather than trusted.
//
// ── THE MODEL (checked 2026-11-06) ─────────────────────────────────────────
// `deepseek/deepseek-v4.1-flash-1017`, the dated DeepSeek chat snapshot
// OpenRouter lists with tools, `reasoning` and `max_tokens` among its supported
// parameters. From https://openrouter.ai/api/v1/models (public, no key),
// 2026-11-06: per 1M tokens, input 0.15 USD, cached input 0.003 USD, output
// 0.60 USD, with `overrides` doubling all three on weekdays 01:00-04:00 and
// 06:00-10:00 UTC: input 0.30 USD, cached input 0.006 USD, output 1.20 USD.
// The peak row IS the worst price: every box key chat request carries it as
// OpenRouter's `provider.max_price` (openrouter.ts), so no upstream provider
// dearer than this row may serve it.
//
// ── THE RATE (checked 2026-10-23) ──────────────────────────────────────────
// ECB euro foreign exchange reference rate, USD, 2026-10-22 (the latest
// published on 2026-10-23): 1 EUR = 1.1205 USD.
// https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml
//
// ── THE DERIVATION (µEUR per 1M tokens, rounded UP) ────────────────────────
//   input   ceil(0.30  / 1.1205 × 1e6) =   267,739
//   cached  ceil(0.006 / 1.1205 × 1e6) =     5,355
//   output  ceil(1.20  / 1.1205 × 1e6) = 1,070,951
// Each direction at its own price: billing an input-heavy agent turn at the
// output price would overcount it four times.
//
// ── ONE STEP ───────────────────────────────────────────────────────────────
// A visitor step's output is capped at 16,000 tokens (step-token-cap.ts),
// reasoning tokens included (the pin runs at reasoning effort low,
// DEMO_BOX_KEY_REASONING_LEVEL). Its input is not capped: the model's context
// window bounds it, and caching makes a long context cheap. So a step is
// reserved in two parts, each at its worst price:
//  * before the step, its output: ceil(16,000 × 1,070,951 / 1e6) = 17,136 µEUR;
//  * as its request leaves, its input, at the request's own estimate
//    (ASCII chars / 3 + one per non-ASCII code point, an overcount) billed
//    uncached: ceil(estimate × 267,739 / 1e6). A step of 97,000 estimated
//    tokens adds 25,971 µEUR, 43,107 µEUR held in all.
// A request whose input the budget cannot hold is refused before it leaves.
// Every request is held in full before it is sent, so the budget's overshoot
// bound is zero; the step settles at what OpenRouter reports (cached input at
// 5,355 µEUR per 1M).
// (Until 2026-10-29 every step's input was capped at 90,000 estimated tokens
// and reserved at that cap, 41,233 µEUR a step, and the pin ran at effort
// high.)
//
// ── WEB SEARCH ─────────────────────────────────────────────────────────────
// One OpenRouter web-plugin completion (engine Exa, at most 5 results, query
// at most 500 characters) on `google/gemini-3.1-flash-lite`. Measured
// 0.0077 USD for 5 results (live probe 2026-10-22). Its catalogue row lists
// `web_search` at 0.014 USD; the Exa plugin bills 0.004 USD per result, so 5
// results are 0.020 USD, plus at most ~6,500 prompt tokens of cited excerpts
// at 0.25 USD/M (0.0017 USD). Worst case taken: 0.025 USD per search
//   = ceil(0.025 / 1.1205 × 1e6) = 22,312 µEUR.
// (The plan's estimate was 0.010 USD; the catalogue's web_search line is
// higher, so the higher figure is used.)
//
// ── TRANSCRIPTION ──────────────────────────────────────────────────────────
// The dearest OpenRouter transcription model (transcription-models.ts,
// OpenRouter list price 2026-10-23) is 0.0000075 USD per second of audio:
//   ceil(0.0000075 / 1.1205 × 1e6) = 7 µEUR per second.
//
// ── THE BUDGETS (env, in EUR; defaults) ────────────────────────────────────
// 0.20 per email (lifetime), 0.60 per client network per UTC day, 20 per box
// per UTC day, 2.50 per rolling box hour. A real step (about 25,000 input
// tokens, 600 output, measured with reasoning off) settled near 7,300 µEUR and
// held 17,136 + 6,694 µEUR while it ran.

/** Pinned visitor model (OpenRouter id), as the env default names it. */
export const VISITOR_MODEL_UPSTREAM_DEFAULT = "deepseek/deepseek-v4.1-flash-1017"

/** The pinned model's catalogue prices, USD per 1M tokens (see THE MODEL). */
export const VISITOR_INPUT_USD_PER_M = 0.3
export const VISITOR_CACHED_INPUT_USD_PER_M = 0.006
export const VISITOR_OUTPUT_USD_PER_M = 1.2

/** ECB reference rate, USD per 1 EUR, 2026-10-22. */
export const VISITOR_ECB_USD_PER_EUR = 1.1205

/** µEUR per 1M tokens, each rounded up (see THE DERIVATION). */
export const VISITOR_INPUT_MICRO_EUR_PER_M = 267_739
export const VISITOR_CACHED_INPUT_MICRO_EUR_PER_M = 5_355
export const VISITOR_OUTPUT_MICRO_EUR_PER_M = 1_070_951

/** The pinned model's catalogue `context_length` (see THE MODEL): the bound of a step's input. */
export const VISITOR_MODEL_CONTEXT_WINDOW = 1_048_576

/** One web search on the box key, worst case (see WEB SEARCH). */
export const VISITOR_WEB_SEARCH_MICRO_EUR = 22_312

/** OpenRouter's web-plugin model's prices, USD per 1M tokens (its max_price). */
export const WEB_SEARCH_MODEL_INPUT_USD_PER_M = 0.25
export const WEB_SEARCH_MODEL_OUTPUT_USD_PER_M = 1.5

/** Transcription on the box key, µEUR per second of audio, worst case. */
export const VISITOR_TRANSCRIPTION_MICRO_EUR_PER_SECOND = 7

/** µEUR of `tokens` at `microEurPerM`, rounded up. */
export function microEurOfTokens(tokens: number, microEurPerM: number): number {
  return Math.ceil((Math.max(0, tokens) * microEurPerM) / 1_000_000)
}

/** µEUR of a USD amount at the block's rate, rounded up. */
export function microEurOfUsd(usd: number): number {
  return Math.ceil((Math.max(0, usd) / VISITOR_ECB_USD_PER_EUR) * 1_000_000)
}

/** What one visitor step holds before it runs: its capped output, at worst (see ONE STEP). */
export function visitorStepOutputMicroEur(maxOutputTokens: number): number {
  return microEurOfTokens(maxOutputTokens, VISITOR_OUTPUT_MICRO_EUR_PER_M)
}

/** What a visitor request's input adds as it leaves: its estimate, uncached (see ONE STEP). */
export function visitorRequestInputMicroEur(estimatedInputTokens: number): number {
  return microEurOfTokens(estimatedInputTokens, VISITOR_INPUT_MICRO_EUR_PER_M)
}

/** EUR to integer µEUR (budgets come from env in EUR). */
export function eurToMicroEur(eur: number): number {
  return Math.round(eur * 1_000_000)
}
