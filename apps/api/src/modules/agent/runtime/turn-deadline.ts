// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * When an agent turn is stopped for taking too long.
 *
 * - `progress` (a foreground turn with no budget of its own): the clock restarts
 *   at every completed step, so the turn is stopped only when ONE step (its
 *   model call and its tool calls) makes no progress for `stepMs`. A turn that
 *   keeps completing steps runs on, up to an absolute `ceilingMs`.
 * - `wall` (an explicit per-invocation `budget.timeoutMs`: routines, sub-agents):
 *   one wall-clock limit for the whole run, as the budget says.
 *
 * Either expiry calls `onExpire` once; `expiredBy` then says which limit it was,
 * so the stop line can name it.
 */

/** A foreground turn's absolute ceiling: 20 minutes, however steadily it progresses. */
export const TURN_PROGRESS_CEILING_MS = 20 * 60_000

export type TurnDeadlineMode = "progress" | "wall"
export type TurnDeadlineExpiry = "step" | "ceiling" | "wall"

/** The timer functions a deadline uses (a test passes a fake clock). */
export interface DeadlineTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: DeadlineTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface TurnDeadline {
  readonly mode: TurnDeadlineMode
  /** A step completed: a progress deadline restarts its step clock. */
  stepCompleted(): void
  /** The turn ended: no limit fires any more. */
  clear(): void
  /** Which limit stopped the turn, once one did. */
  readonly expiredBy: TurnDeadlineExpiry | null
  /** The limit in words, for the stop line ("this run's limit is …"). */
  describe(): string
}

export function createTurnDeadline(opts: {
  mode: TurnDeadlineMode
  /** progress: one step's limit; wall: the whole run's. */
  limitMs: number
  /** progress only: the absolute limit. */
  ceilingMs?: number
  onExpire: () => void
  timers?: DeadlineTimers
}): TurnDeadline {
  const timers = opts.timers ?? realTimers
  let expiredBy: TurnDeadlineExpiry | null = null
  let done = false
  const expire = (by: TurnDeadlineExpiry) => {
    if (done || expiredBy) return
    expiredBy = by
    clear()
    opts.onExpire()
  }
  let stepTimer: unknown = timers.setTimeout(
    () => expire(opts.mode === "progress" ? "step" : "wall"),
    opts.limitMs,
  )
  const ceilingMs = opts.ceilingMs ?? TURN_PROGRESS_CEILING_MS
  const ceilingTimer: unknown =
    opts.mode === "progress" ? timers.setTimeout(() => expire("ceiling"), ceilingMs) : null
  function clear() {
    done = true
    timers.clearTimeout(stepTimer)
    if (ceilingTimer !== null) timers.clearTimeout(ceilingTimer)
  }
  return {
    mode: opts.mode,
    stepCompleted() {
      if (done || opts.mode !== "progress") return
      timers.clearTimeout(stepTimer)
      stepTimer = timers.setTimeout(() => expire("step"), opts.limitMs)
    },
    clear,
    get expiredBy() {
      return expiredBy
    },
    describe() {
      const s = (ms: number) => `${Math.round(ms / 1000)}s`
      if (expiredBy === "ceiling") return `this run's limit is ${s(ceilingMs)}`
      if (opts.mode === "progress") {
        return `this run's limit is ${s(opts.limitMs)} without progress in one step`
      }
      return `this run's limit is ${s(opts.limitMs)}`
    },
  }
}
