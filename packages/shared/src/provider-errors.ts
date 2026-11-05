// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Provider-error classification shared by the agent runtime (apps/api) and the
// QA harnesses. Dependency-free string matching on the error
// message an LLM provider surfaces.

/**
 * Is this error the provider CREDIT / SPEND-CAP / QUOTA-EXHAUSTION class — i.e. the
 * key/project is funded-out and EVERY call will fail until a human raises the cap or
 * the quota resets? This is distinct from a transient 429 rate-limit (retryable) and
 * from a per-request error: it is a standing, account-level HARD block.
 *
 * Why it matters: when the agent-under-test's provider hits its monthly spend cap
 * mid-session, every agent call fails after the SDK's internal retries with an
 * `AI_RetryError` whose last error is "exceeded its monthly spending cap"
 * (Gemini) / "insufficient_quota" (OpenAI) / `RESOURCE_EXHAUSTED`. If that is
 * swallowed into a blank agent turn, it reads as a scenario failure and the loop
 * grinds every scenario into the cap, burning quota (the l289 / BL-177 incident).
 * Detecting it lets the runtime SURFACE the real cause and the loop HARD-BLOCK.
 *
 * Deliberately matches the funded-out phrasings, NOT a bare 429/"rate limit"
 * (which is transient and should be retried, not hard-blocked).
 */
export function isProviderCreditBlockError(err: unknown): boolean {
  const m = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase()
  if (!m) return false
  return (
    m.includes("spending cap") ||
    m.includes("spend cap") ||
    m.includes("resource_exhausted") ||
    m.includes("insufficient_quota") ||
    m.includes("insufficient quota") ||
    m.includes("exceeded your current quota") ||
    m.includes("monthly spending") ||
    // OpenAI billing hard-limit phrasing
    (m.includes("billing") && m.includes("hard limit")) ||
    // generic quota exhaustion (NOT a bare rate-limit): quota + exhausted/exceeded
    (m.includes("quota") && (m.includes("exhaust") || m.includes("exceeded")))
  )
}
