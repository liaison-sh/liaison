// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-request and per-call time budgets for the Boxtal HTTP clients.
//
// WHY (prod, 2026-09): operators hit "Request failed" (HTTP 504 at 30s) on the
// shipping tools. The only bound on a Boxtal call used to be the sandbox-wide
// LIAISON_SANDBOX_FETCH_TIMEOUT_MS (10s), so a degraded Boxtal could hold a
// sandbox worker for tens of seconds inside a 60s tool budget: print_pack was
// measured holding a worker for 37 to 39 seconds.
//
// Two bounds now apply, both enforced by the client itself:
//   * PER REQUEST  (BOXTAL_HTTP_TIMEOUT_MS)  one HTTP round trip;
//   * PER CALL     (BOXTAL_CALL_BUDGET_MS)   one logical API call, which may
//     cost a token exchange + the request + one 401 refresh round.
//
// Enforcement, honestly stated: the guest runs in QuickJS with NO timers, so a
// call already in flight cannot be interrupted from inside the bundle. What the
// client CAN do, and does, is
//   a) refuse to START a request once the call budget is spent (a hard, timer
//      free bound on everything after the first hung round trip), and
//   b) hand the fetch layer an AbortSignal (when the runtime has one) plus a
//      plain `timeoutMs` hint, so any fetch implementation that honours either
//      one aborts at OUR deadline instead of the sandbox limit. The real global
//      fetch honours the signal; the sandbox RPC bridge currently ignores both
//      and falls back to its own 10s cap, which is why (a) carries the bound in
//      production today.

/** One HTTP round trip. Deliberately under the sandbox-wide 10s cap so our own
 *  deadline is the one that fires first wherever it can be honoured. */
export const BOXTAL_HTTP_TIMEOUT_MS = 5_000

/** One logical API call: token exchange + request + one 401 refresh round,
 *  each individually capped at BOXTAL_HTTP_TIMEOUT_MS. */
export const BOXTAL_CALL_BUDGET_MS = 10_000

/** A deadline: the wall-clock instant a logical call must be finished by. */
export interface Deadline {
  /** Epoch ms after which no further request may be started. */
  atMs: number
  /** Milliseconds left, never negative. */
  remaining(nowMs: number): number
}

export function makeDeadline(nowMs: number, budgetMs: number): Deadline {
  const atMs = nowMs + budgetMs
  return {
    atMs,
    remaining: (n: number) => Math.max(0, atMs - n),
  }
}

/** Message for the error raised when a call's own budget is spent. The caller
 *  throws it as a BoxtalApiError with status 504, so code branching on 5xx
 *  treats it as the indeterminate upstream condition it is. (Kept here, as a
 *  plain string builder, so this module imports nothing and can never form an
 *  import cycle with the client that owns BoxtalApiError.) */
export const BUDGET_EXHAUSTED_STATUS = 504
export function budgetExhaustedMessage(what: string, budgetMs: number): string {
  return `Boxtal ${what} exceeded its ${budgetMs}ms budget (upstream too slow): nothing further was sent.`
}

/** The per-request opts a timed fetch adds on top of {method, headers, body}.
 *  Both are hints: a fetch implementation may honour either, one, or neither. */
export interface TimedFetchHints {
  signal?: unknown
  timeoutMs?: number
}

/** Build the abort hints for one request, capped by whatever the call has left. */
export function timeoutHints(perRequestMs: number): TimedFetchHints {
  const hints: TimedFetchHints = { timeoutMs: perRequestMs }
  const AS = (globalThis as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal
  if (AS && typeof AS.timeout === "function") {
    try {
      hints.signal = AS.timeout(perRequestMs)
    } catch {
      // No AbortSignal.timeout in this runtime (QuickJS): the timeoutMs hint and
      // the caller's deadline check are the bound.
    }
  }
  return hints
}
