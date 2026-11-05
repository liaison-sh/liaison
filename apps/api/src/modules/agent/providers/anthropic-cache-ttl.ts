// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The lifetime of the Anthropic prompt-cache breakpoints Liaison sets, and
// what writing one costs. One module so the request (context.ts marks the
// breakpoints) and the bill (credit-meter.ts prices the writes) cannot disagree.
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "anthropic-cache-ttl" })

/** Millisecond duration of each supported Anthropic cache TTL, so the default can be
 *  asserted equal to cold-resume.ts's WARM_WINDOW_MS (see cold-resume.test.ts). */
export const ANTHROPIC_CACHE_TTL_MS: Record<"5m" | "1h", number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
}

/**
 * Anthropic's price for WRITING the cache, as a multiple of the base input
 * rate: 1.25x for the 5-minute TTL, 2x for the 1-hour TTL (Anthropic pricing,
 * prompt caching). Reads are 0.1x for both.
 */
export const ANTHROPIC_CACHE_WRITE_RATE_FACTOR: Record<"5m" | "1h", number> = {
  "5m": 1.25,
  "1h": 2,
}

let warnedInvalidCacheTtl = false
/** Test hook: the warning fires once per process, so a test asserting it re-arms it first. */
export function _resetAnthropicCacheTtlWarning(): void {
  warnedInvalidCacheTtl = false
}
/** Read per call (not the cached `env` singleton) so a test can flip it. */
export function resolveAnthropicCacheTtl(): "5m" | "1h" {
  const raw = process.env.LIAISON_ANTHROPIC_CACHE_TTL
  if (raw === undefined || raw === "1h") return "1h"
  if (raw === "5m") return "5m"
  if (!warnedInvalidCacheTtl) {
    warnedInvalidCacheTtl = true
    log.warn(
      { value: raw },
      "LIAISON_ANTHROPIC_CACHE_TTL is not '5m' or '1h' — falling back to the default 1h cache lifetime",
    )
  }
  return "1h"
}
