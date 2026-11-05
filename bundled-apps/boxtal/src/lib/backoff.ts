// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Retry pacing for the Boxtal reads that are legitimately "not ready yet"
// (the LABEL document, generated asynchronously after the order).
//
// Before this, the label-import loop retried with a bare `continue`: no pause,
// no jitter, so a degraded Boxtal was hammered as fast as the network allowed
// and the tool burned its whole budget inside the loop.
//
// Full jitter (delay = random() * min(base * 2^n, cap)) rather than plain
// exponential: several operators printing at once must not re-converge on the
// same retry instants.

/** First backoff step, doubled per attempt. */
export const RETRY_BASE_MS = 400
/** Ceiling for one backoff step, so the worst case stays arithmetic. */
export const RETRY_CAP_MS = 1_500

/**
 * Delay before retry number `attemptIndex` (0 = the pause after the FIRST
 * attempt). Full jitter over [0, min(base * 2^n, cap)], so the worst case of
 * one step is exactly RETRY_CAP_MS once the ramp saturates.
 */
export function retryDelayMs(
  attemptIndex: number,
  random: () => number = Math.random,
  baseMs: number = RETRY_BASE_MS,
  capMs: number = RETRY_CAP_MS,
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attemptIndex))
  const r = random()
  const jittered = (Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 1) * ceiling
  return Math.round(jittered)
}

/**
 * Sleep, where sleeping is possible.
 *
 * The bundle runs in a QuickJS sandbox that exposes NO timers (a guest
 * `setTimeout` is "not defined"), so there the pause degrades to a no-op and
 * the pacing comes from the Boxtal round trip itself plus the caller's hard
 * deadline. Anywhere a timer exists (tests, and any future host that bridges
 * one) the backoff is real. Callers inject their own sleep in tests, so no
 * suite ever waits for wall-clock time.
 */
export const defaultSleep = (ms: number): Promise<void> => {
  const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout
  if (typeof timer !== "function" || ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    timer(() => resolve(), ms)
  })
}
