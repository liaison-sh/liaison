// SPDX-License-Identifier: FSL-1.1-ALv2
// The shutdown budget arithmetic (lib/shutdown.ts), with no imports, so the
// compose budget test can check deploy/docker-compose.yml against the same
// numbers the process uses.

/**
 * A turn asked to hand off at its cap gets this long to reach its step
 * boundary (S10, M2): SHUTDOWN_TURN_SETTLE_MS, this by default. The default
 * keeps the whole handoff at 5 s, so the 58 s hard deadline and the 65 s stop
 * grace period hold; a longer settle lengthens the derived hard deadline.
 */
export const TURN_HANDOFF_SETTLE_DEFAULT_MS = 2_500
/** Then its model call is cut, and its running tools get this long to finish. */
export const TURN_HANDOFF_TOOL_SETTLE_MS = 2_000
/** The handoff write and its resume enqueue. */
const TURN_HANDOFF_WRITE_MS = 500
/** What a turn cut at its cap needs to hand off: settle, tools, the handoff write. */
export function turnHandoffMs(settleMs: number = TURN_HANDOFF_SETTLE_DEFAULT_MS): number {
  return settleMs + TURN_HANDOFF_TOOL_SETTLE_MS + TURN_HANDOFF_WRITE_MS
}
/** The handoff with the default settle. */
export const TURN_HANDOFF_MS = turnHandoffMs()
/** The handoff's own time besides its settle (tools, write). */
export const TURN_HANDOFF_FIXED_MS = TURN_HANDOFF_TOOL_SETTLE_MS + TURN_HANDOFF_WRITE_MS
/** What an aborted job's processor gets to settle, after the job drain budget. */
export const JOB_ABORT_SETTLE_MS = 2_000
/** The job drain's queue closes, after that. */
export const JOB_QUEUE_CLOSE_MS = 2_000
/** Slack between the last phase's deadline and the hard deadline. */
export const HARD_DEADLINE_SLACK_MS = 5_000

/**
 * The after-drain groups, in order, with each group's deadline. The drains
 * (order 0) are bounded by their own budgets; every later group by the
 * deadline here, so their sum is the time the sequence needs after the drains.
 */
export const SHUTDOWN_ORDER = {
  drain: 0,
  listenerClose: 5,
  eventFlush: 10,
  outbox: 20,
  rebuildLock: 40,
  sandboxPool: 50,
  transformPool: 55,
  heartbeat: 60,
  internalListener: 90,
  pgPool: 95,
  jobHandBack: 97,
  pools: 100,
} as const

export const AFTER_DRAIN_DEADLINE_MS: Record<
  Exclude<keyof typeof SHUTDOWN_ORDER, "drain">,
  number
> = {
  listenerClose: 1_000,
  eventFlush: 2_000,
  outbox: 3_000,
  rebuildLock: 2_000,
  // A sandbox handler finishes within its exec timeout (5 s), then the pool ends.
  sandboxPool: 6_000,
  transformPool: 2_000,
  heartbeat: 2_000,
  internalListener: 1_000,
  // sql.end({ timeout: 5 }).
  pgPool: 6_000,
  // One moveToWait per job still running.
  jobHandBack: 2_000,
  // The Redis disconnects.
  pools: 1_000,
}

/** The time the sequence needs after the drains: the sum of the later groups' deadlines. */
export const AFTER_DRAIN_BUDGET_MS = Object.values(AFTER_DRAIN_DEADLINE_MS).reduce(
  (a, b) => a + b,
  0,
)

/**
 * The leadership phase at t0 (singletons stop, the lease is released). The
 * after-drain groups wait for every t0 phase, so it bounds the drain group too.
 */
export const LEADERSHIP_STOP_MS = 10_000

export interface DrainBudgets {
  edgeGraceMs: number
  httpDrainMs: number
  turnDrainMs: number
  jobDrainMs: number
  /** SHUTDOWN_TURN_SETTLE_MS; absent = the default. */
  turnSettleMs?: number
}

/**
 * When the drain group (after-drain order 0) is over, in ms from t0. Every
 * drain counts its budget from t0, so they overlap the edge grace and each
 * other; the group ends at its slowest member: the edge stage, the leadership
 * stop, the HTTP drain, a turn plus its handoff, or the job drain plus the
 * aborted jobs' settle and the queue close.
 */
export function drainGroupMs(b: DrainBudgets): number {
  return Math.max(
    b.edgeGraceMs,
    LEADERSHIP_STOP_MS,
    b.httpDrainMs,
    b.turnDrainMs + turnHandoffMs(b.turnSettleMs),
    b.jobDrainMs + JOB_ABORT_SETTLE_MS + JOB_QUEUE_CLOSE_MS,
  )
}

/**
 * The hard deadline a set of budgets needs: the drain group, then the later
 * phases, plus slack. The default when SHUTDOWN_HARD_DEADLINE_MS is unset;
 * the container's stop grace period must sit at least 5 s above it.
 */
export function requiredHardDeadlineMs(b: DrainBudgets): number {
  return drainGroupMs(b) + AFTER_DRAIN_BUDGET_MS + HARD_DEADLINE_SLACK_MS
}

/**
 * The SHUTDOWN_*_MS defaults (lib/env.ts reads them from here). They give a
 * 58 s hard deadline: 25 s drain group (a turn's 20 s + its 5 s handoff),
 * 28 s of later phases, 5 s slack. A stop grace period of 65 s covers it.
 * Longer drains need a longer grace period, set in the orchestrator.
 */
export const SHUTDOWN_BUDGET_DEFAULTS = {
  edgeGraceMs: 2_000,
  httpDrainMs: 20_000,
  turnDrainMs: 20_000,
  jobDrainMs: 20_000,
  turnSettleMs: TURN_HANDOFF_SETTLE_DEFAULT_MS,
} as const
