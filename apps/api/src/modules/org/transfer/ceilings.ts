// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The write gap of a move, step by step (D37): each step inside the freeze has
// a target and a ceiling. The source agent runs every step under its ceiling;
// a step past it before the commit aborts the move (the org goes back to
// serving from the source), so a slow move never becomes a long outage. A step
// after the commit cannot abort anything: past its ceiling it is reported.
//
// The router's pin cache and the client's retry (`Retry-After: 2`) are part of
// the gap the client sees but not of the agent's work, so they are listed for
// the sum only.

export type GapStep =
  | "freeze-acks"
  | "quiesce"
  | "scan-diff"
  | "apply"
  | "verify"
  | "commit"
  | "unfreeze-acks"

export interface StepBudget {
  /** Engineered target, ms. */
  targetMs: number
  /** Hard ceiling, ms: past it the step fails (and, before the commit, the move aborts). */
  ceilingMs: number
  what: string
}

export const GAP_STEPS: Record<GapStep, StepBudget> = {
  "freeze-acks": {
    targetMs: 500,
    ceilingMs: 2_000,
    what: "freeze broadcast, every instance acks",
  },
  quiesce: { targetMs: 500, ceilingMs: 2_000, what: "quiesce probe answers 0" },
  "scan-diff": {
    targetMs: 2_000,
    ceilingMs: 4_000,
    what: "pass 2 (pk, xmin) scan and diff, jobs export",
  },
  apply: {
    targetMs: 2_000,
    ceilingMs: 4_000,
    what: "delta send, target apply and setval (one txn)",
  },
  verify: {
    targetMs: 1_000,
    ceilingMs: 2_000,
    what: "fingerprint re-check, object keys of the delta",
  },
  commit: {
    targetMs: 1_000,
    ceilingMs: 2_500,
    what: "control plane commit (compare-and-set) and pin",
  },
  "unfreeze-acks": {
    targetMs: 500,
    ceilingMs: 1_500,
    what: "target unfreeze broadcast, every instance acks",
  },
}

/** The client side of the gap (router pin cache, `Retry-After: 2`): not the agent's to enforce. */
export const CLIENT_RETRY_MS = { targetMs: 2_000, ceilingMs: 2_000 }

/** Steps before the decision: one past its ceiling aborts the move. */
export const PRE_COMMIT_STEPS: readonly GapStep[] = [
  "freeze-acks",
  "quiesce",
  "scan-diff",
  "apply",
  "verify",
]

export function gapTotals(): { targetMs: number; ceilingMs: number } {
  const steps = Object.values(GAP_STEPS)
  return {
    targetMs: steps.reduce((s, b) => s + b.targetMs, 0) + CLIENT_RETRY_MS.targetMs,
    ceilingMs: steps.reduce((s, b) => s + b.ceilingMs, 0) + CLIENT_RETRY_MS.ceilingMs,
  }
}

export class StepCeilingExceeded extends Error {
  constructor(
    readonly step: GapStep,
    readonly ceilingMs: number,
  ) {
    super(`org move: step ${step} passed its ceiling of ${ceilingMs} ms`)
    this.name = "StepCeilingExceeded"
  }
}

export interface StepTiming {
  step: GapStep
  ms: number
  targetMs: number
  ceilingMs: number
  /** Over the ceiling (a post-commit step that could not abort). */
  over: boolean
}

/**
 * Run `fn` under the step's ceiling. Past it the promise rejects with
 * `StepCeilingExceeded` (the work itself is not interrupted: the caller's
 * abort path undoes it, and the target runs its commands one at a time, so an
 * abort queues behind a late apply). `scale` multiplies every ceiling (tests).
 */
export async function underCeiling<T>(
  step: GapStep,
  fn: () => Promise<T>,
  timings: StepTiming[],
  opts: { scale?: number; enforce?: boolean; now?: () => number } = {},
): Promise<T> {
  const budget = GAP_STEPS[step]
  const ceilingMs = Math.round(budget.ceilingMs * (opts.scale ?? 1))
  const now = opts.now ?? Date.now
  const started = now()
  let timer: ReturnType<typeof setTimeout> | null = null
  const record = (over: boolean) =>
    timings.push({ step, ms: now() - started, targetMs: budget.targetMs, ceilingMs, over })
  try {
    const work = fn()
    if (opts.enforce === false) {
      const v = await work
      record(now() - started > ceilingMs)
      return v
    }
    const v = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StepCeilingExceeded(step, ceilingMs)), ceilingMs)
      }),
    ])
    record(false)
    return v
  } catch (err) {
    if (err instanceof StepCeilingExceeded) record(true)
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}
