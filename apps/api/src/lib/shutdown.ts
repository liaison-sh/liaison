// SPDX-License-Identifier: FSL-1.1-ALv2
// One shutdown sequence for the whole process (S9). A SIGTERM or SIGINT lands
// here and nowhere else: modules register named phases, and the coordinator
// runs them on one clock.
//
//   t0           every `t0` phase starts at once (readiness goes draining, new
//                turns and job fetches are refused).
//   edge         at t0 + SHUTDOWN_EDGE_GRACE_MS (the edge has seen /readyz 503
//                twice by then): the listener stops, local WebSockets close.
//   after-drain  groups by `order`, ascending; the phases of one group run
//                together (the HTTP, turn and job drains share order 0, so
//                their budgets overlap instead of adding up), each group
//                waits for the one before.
//
// Every phase is cut at its own deadline (its signal aborts and the sequence
// moves on) and logs one `shutdown_phase` line. A hard deadline from t0
// (SHUTDOWN_HARD_DEADLINE_MS, under the container's stop grace period) exits
// anyway, so a wedged phase is an error in the log, never a SIGKILL surprise.
// A signal during boot: boot halts at its next step (haltBootIfShuttingDown)
// and a phase registered after its stage ran runs at once.
// The process always exits 0: a deploy stopping it is not a failure. The one
// exception is the watchdog (lib/shutdown-watchdog.ts): a Worker that kills the
// process SHUTDOWN_WATCHDOG_GRACE_MS past the hard deadline, for a main thread
// so wedged that the hard deadline's own timer never fires.
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import {
  AFTER_DRAIN_BUDGET_MS,
  HARD_DEADLINE_SLACK_MS,
  JOB_ABORT_SETTLE_MS,
  JOB_QUEUE_CLOSE_MS,
  requiredHardDeadlineMs,
  TURN_HANDOFF_FIXED_MS,
} from "~/lib/shutdown-budget"

const log = rootLogger.child({ module: "shutdown" })

export type ShutdownStage = "t0" | "edge" | "after-drain"
export type ShutdownOutcome = "ok" | "timeout" | "error"

export interface ShutdownPhase {
  /** Unique; registering the same name again replaces the phase. */
  name: string
  at: ShutdownStage
  /** after-drain only: groups run in ascending order (default 50). */
  order?: number
  /** Cut after this long (default 10 s). The signal aborts at the cut. */
  deadlineMs?: number
  run(signal: AbortSignal): void | Promise<void>
}

export interface ShutdownClock {
  now(): number
  sleep(ms: number): Promise<void>
}

const DEFAULT_PHASE_DEADLINE_MS = 10_000
/**
 * How long past the hard deadline the watchdog waits before it kills the
 * process. Under HARD_DEADLINE_SLACK_MS, so the kill still lands before the
 * container's stop grace period (at least 5 s above the hard deadline) ends.
 */
export const SHUTDOWN_WATCHDOG_GRACE_MS = 3_000
const DEFAULT_ORDER = 50
const realClock: ShutdownClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

function flushThenExit(code: number): void {
  try {
    rootLogger.flush()
  } catch {
    // Best effort: never let a flush block the exit.
  }
  setTimeout(() => process.exit(code), 50)
}

const phases = new Map<string, ShutdownPhase>()
const outcomes = new Map<string, ShutdownOutcome>()
let clock: ShutdownClock = realClock
let exit: (code: number) => void = flushThenExit
let edgeGraceOverride: number | undefined
let hardDeadlineOverride: number | undefined
let budgetOverrides: Partial<Pick<ShutdownBudgets, "httpDrainMs" | "turnDrainMs" | "jobDrainMs">> =
  {}
let devForceExit = env.NODE_ENV !== "production"
/** The stages already run; a phase registered later runs at once (boot raced the signal). */
const stagesRun = new Set<ShutdownStage>()
const groupsRun = new Set<number>()
let running: Promise<void> | null = null
let shutdownT0: number | null = null
/** The edge grace of the shutdown in progress (its budgets are fixed at t0). */
let shutdownEdgeGraceMs: number | null = null
let signalsInstalled = false

export interface ShutdownBudgets {
  edgeGraceMs: number
  httpDrainMs: number
  turnDrainMs: number
  jobDrainMs: number
  /** How long a turn at its cap gets to reach its step boundary (SHUTDOWN_TURN_SETTLE_MS). */
  turnSettleMs: number
  hardDeadlineMs: number
}

/**
 * The shutdown budgets (ms). With SHUTDOWN_HARD_DEADLINE_MS set, every drain
 * is clamped so that the edge grace, the drain, a turn's handoff and the later
 * phases fit under it: the process always exits before the runtime kills it.
 */
export function shutdownBudgets(): ShutdownBudgets {
  const edgeGraceMs = edgeGraceOverride ?? env.SHUTDOWN_EDGE_GRACE_MS
  const wanted = {
    edgeGraceMs,
    httpDrainMs: budgetOverrides.httpDrainMs ?? env.SHUTDOWN_HTTP_DRAIN_MS,
    turnDrainMs: budgetOverrides.turnDrainMs ?? env.SHUTDOWN_TURN_DRAIN_MS,
    jobDrainMs: budgetOverrides.jobDrainMs ?? env.SHUTDOWN_JOB_DRAIN_MS,
    turnSettleMs: env.SHUTDOWN_TURN_SETTLE_MS,
  }
  const hardDeadlineMs =
    hardDeadlineOverride ?? env.SHUTDOWN_HARD_DEADLINE_MS ?? requiredHardDeadlineMs(wanted)
  // The drain group's end, from t0, that leaves the later phases their time.
  const room = Math.max(0, hardDeadlineMs - AFTER_DRAIN_BUDGET_MS - HARD_DEADLINE_SLACK_MS)
  // The turn settle fits the room first; the turn drain fits what its handoff leaves.
  const turnSettleMs = Math.min(wanted.turnSettleMs, Math.max(0, room - TURN_HANDOFF_FIXED_MS))
  return {
    edgeGraceMs,
    httpDrainMs: Math.min(wanted.httpDrainMs, room),
    turnSettleMs,
    turnDrainMs: Math.min(
      wanted.turnDrainMs,
      Math.max(0, room - TURN_HANDOFF_FIXED_MS - turnSettleMs),
    ),
    jobDrainMs: Math.min(
      wanted.jobDrainMs,
      Math.max(0, room - JOB_ABORT_SETTLE_MS - JOB_QUEUE_CLOSE_MS),
    ),
    hardDeadlineMs,
  }
}

export function registerShutdownPhase(phase: ShutdownPhase): void {
  phases.set(phase.name, phase)
  // Registered after its stage ran (boot went on after the signal): run it now,
  // so what boot started is still stopped.
  const passed =
    phase.at === "after-drain"
      ? groupsRun.has(phase.order ?? DEFAULT_ORDER)
      : stagesRun.has(phase.at)
  if (running && passed) void runPhase(phase)
}

/**
 * Boot calls this between its steps: once a shutdown has begun it never
 * resolves, so boot binds no listener, takes no lease and starts no worker
 * after the signal; the coordinator stops what already started and exits.
 */
export function haltBootIfShuttingDown(): Promise<void> {
  if (!running) return Promise.resolve()
  log.info("shutdown began during boot: the remaining boot steps are skipped")
  markBootQuiet()
  return new Promise<void>(() => {})
}

/** Boot parked at a halt or finished: no boot step uses the pools any more. */
let bootIsQuiet = false
let bootQuietWaiters: Array<() => void> = []
function markBootQuiet(): void {
  bootIsQuiet = true
  for (const resolve of bootQuietWaiters) resolve()
  bootQuietWaiters = []
}

/** index.ts calls this once boot is complete. */
export function markBootFinished(): void {
  markBootQuiet()
}

/**
 * Resolves once boot has finished or parked at haltBootIfShuttingDown. The
 * phases that close the pools await it, so a boot step in flight at the
 * signal (it runs to its next halt) is never cut under its query; the phase
 * deadline bounds a step that hangs.
 */
export function bootQuiet(): Promise<void> {
  if (bootIsQuiet) return Promise.resolve()
  return new Promise<void>((resolve) => bootQuietWaiters.push(resolve))
}

/** Whether a shutdown has begun in this process. */
export function isShuttingDown(): boolean {
  return running !== null
}

/**
 * Whether the edge grace of the shutdown in progress has passed: from then on
 * the listener is stopped and the edge routes nothing here, so a request still
 * arriving (on a kept-alive connection) is refused with a retry hint. Before
 * it, the edge may still route here (its probe has not yet seen /readyz 503):
 * such a request is served, or the client sees a 5xx for nothing. False before
 * a shutdown began.
 */
export function edgeGracePassed(): boolean {
  if (shutdownT0 === null || shutdownEdgeGraceMs === null) return false
  return clock.now() - shutdownT0 >= shutdownEdgeGraceMs
}

/** Milliseconds since t0, or 0 before a shutdown began. */
export function msSinceShutdownBegan(): number {
  return shutdownT0 === null ? 0 : clock.now() - shutdownT0
}

async function runPhase(phase: ShutdownPhase): Promise<void> {
  const started = clock.now()
  const deadlineMs = phase.deadlineMs ?? DEFAULT_PHASE_DEADLINE_MS
  const controller = new AbortController()
  let outcome: ShutdownOutcome
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => phase.run(controller.signal))
        .then(() => "ok" as const),
      clock.sleep(deadlineMs).then(() => "timeout" as const),
    ])
    outcome = result
  } catch (err) {
    outcome = "error"
    log.error({ err, phase: phase.name }, "shutdown phase failed")
  }
  if (outcome === "timeout") controller.abort()
  outcomes.set(phase.name, outcome)
  const ms = clock.now() - started
  if (outcome === "timeout") {
    log.error({ phase: phase.name, ms, outcome, deadlineMs }, "shutdown_phase")
  } else {
    log.info({ phase: phase.name, ms, outcome }, "shutdown_phase")
  }
}

async function runSequence(reason: string, budgets: ShutdownBudgets): Promise<void> {
  const t0 = clock.now()
  shutdownT0 = t0
  shutdownEdgeGraceMs = budgets.edgeGraceMs
  log.info({ reason, phases: [...phases.keys()], ...budgets }, "shutdown begins")

  // Each stage reads the phases registered by the time it starts.
  const runStage = (stage: Exclude<ShutdownStage, "after-drain">) => {
    stagesRun.add(stage)
    return Promise.all([...phases.values()].filter((p) => p.at === stage).map(runPhase))
  }
  const t0Done = runStage("t0")
  // The edge stops sending once its probe saw /readyz 503.
  const elapsed = clock.now() - t0
  if (budgets.edgeGraceMs > elapsed) await clock.sleep(budgets.edgeGraceMs - elapsed)
  await runStage("edge")
  await t0Done

  stagesRun.add("after-drain")
  for (;;) {
    const next = [...phases.values()]
      .filter((p) => p.at === "after-drain" && !groupsRun.has(p.order ?? DEFAULT_ORDER))
      .map((p) => p.order ?? DEFAULT_ORDER)
      .sort((a, b) => a - b)[0]
    if (next === undefined) break
    groupsRun.add(next)
    await Promise.all(
      [...phases.values()]
        .filter((p) => p.at === "after-drain" && (p.order ?? DEFAULT_ORDER) === next)
        .map(runPhase),
    )
  }
  log.info({ reason, ms: clock.now() - t0 }, "shutdown complete, exiting")
}

/**
 * Run the shutdown sequence once; a second call (another signal) returns the
 * same promise. Exits the process (0) at the end, or at the hard deadline.
 */
export function beginShutdown(reason: string): Promise<void> {
  if (running) return running
  const budgets = shutdownBudgets()
  // Captured now: the exit in force when this shutdown began is the one it uses.
  const exitFn = exit
  // The real exit only: a test that injects its own exit gets no watchdog.
  if (exitFn === flushThenExit) {
    startWatchdog(budgets.hardDeadlineMs + SHUTDOWN_WATCHDOG_GRACE_MS)
  }
  let exited = false
  const exitOnce = (code: number) => {
    if (exited) return
    exited = true
    exitFn(code)
  }
  let finished = false
  running = Promise.race([
    runSequence(reason, budgets)
      .catch((err) => log.error({ err }, "shutdown sequence failed"))
      .finally(() => {
        finished = true
      }),
    clock.sleep(budgets.hardDeadlineMs).then(() => {
      if (finished) return
      log.error(
        { reason, hardDeadlineMs: budgets.hardDeadlineMs },
        "shutdown hard deadline reached, exiting anyway",
      )
    }),
  ]).then(() => exitOnce(0))
  return running
}

/**
 * Arm the watchdog Worker. Unref'd, so it never keeps an exiting process
 * alive; a failure to start it is logged and the shutdown goes on without it.
 */
function startWatchdog(afterMs: number): void {
  try {
    const worker = new Worker(new URL("./shutdown-watchdog.ts", import.meta.url).href)
    worker.postMessage({ afterMs })
    worker.unref()
  } catch (err) {
    log.warn({ err }, "shutdown watchdog could not start; the hard deadline alone bounds the exit")
  }
}

/**
 * A signal. The first begins the shutdown; a later SIGTERM is ignored (the
 * runtime repeats it). A second SIGINT outside production exits at once, so a
 * developer is never held by a drain.
 */
export function handleShutdownSignal(signal: "SIGTERM" | "SIGINT"): void {
  if (running && signal === "SIGINT" && devForceExit) {
    log.warn("second SIGINT: exiting without finishing the drain")
    exit(130)
    return
  }
  void beginShutdown(signal)
}

/** The one SIGTERM/SIGINT entry of the process. Idempotent. */
export function installShutdownSignals(): void {
  if (signalsInstalled) return
  signalsInstalled = true
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => handleShutdownSignal(signal))
  }
}

/** Test seam: production code never calls it. */
export const ShutdownTestAccess = {
  configure(opts: {
    clock?: ShutdownClock
    exit?: (code: number) => void
    edgeGraceMs?: number
    hardDeadlineMs?: number
    devForceExit?: boolean
    budgets?: Partial<Pick<ShutdownBudgets, "httpDrainMs" | "turnDrainMs" | "jobDrainMs">>
  }) {
    if (opts.budgets) budgetOverrides = { ...budgetOverrides, ...opts.budgets }
    if (opts.clock) clock = opts.clock
    if (opts.exit) exit = opts.exit
    if (opts.edgeGraceMs !== undefined) edgeGraceOverride = opts.edgeGraceMs
    if (opts.hardDeadlineMs !== undefined) hardDeadlineOverride = opts.hardDeadlineMs
    if (opts.devForceExit !== undefined) devForceExit = opts.devForceExit
  },
  outcomes(): ReadonlyMap<string, ShutdownOutcome> {
    return outcomes
  },
  phaseNames(): string[] {
    return [...phases.keys()]
  },
  reset(): void {
    phases.clear()
    outcomes.clear()
    clock = realClock
    exit = flushThenExit
    edgeGraceOverride = undefined
    hardDeadlineOverride = undefined
    budgetOverrides = {}
    devForceExit = env.NODE_ENV !== "production"
    stagesRun.clear()
    groupsRun.clear()
    running = null
    shutdownT0 = null
    shutdownEdgeGraceMs = null
  },
}
