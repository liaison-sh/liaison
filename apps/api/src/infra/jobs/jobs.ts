// SPDX-License-Identifier: FSL-1.1-ALv2
// Job infrastructure: logical jobs `(appName, jobName)` on BullMQ queues.
//
// ROUTING. A logical job runs on the physical queue `resolveJobQueue` names:
// kernel jobs on their class queue (queue-classes.ts is the one table), every
// app on its own `app-<name>` queue. Handlers are keyed by the logical pair,
// so a worker on any queue (a class queue, or the legacy `app-kernel` drain)
// runs a job by its name.
//
// HOSTING IS OPT-IN. Only a process that declares itself a job host with
// `hostJobWorkers()` (the API server; test harnesses) ever creates a BullMQ
// Worker. Everything else (the `liaison` CLI, seeds, one-shot boot scripts)
// may import the whole app graph and register handlers, but owns no worker, so
// the jobs it enqueues stay in Redis for the server. It used to be opt-out,
// and a CLI run that forgot to opt out became a production `app-kernel`
// worker, took the server's jobs and failed them "No handler registered".
//
// ENQUEUE IS ONE ROUND TRIP. A jobId is a BullMQ deduplication id: an add whose
// id is still waiting, delayed or running is dropped inside the add script, and
// a finished one never blocks a new add. The old get-state-then-add cost three
// round trips per enqueue. Backpressure (backpressure.ts) is checked against a
// sample, without a round trip.
import { DelayedError, type Job, type JobsOptions, Queue, Worker } from "bullmq"
import { withPrivilegedDb } from "~/db/privileged"
import { poolPlan } from "~/db/process-pool-plan"
import { INSTANCE_ID } from "~/infra/instance-id"
import { dispatchAppJobWithContext, type JobTxMode } from "~/infra/jobs/job-context"
import { env, isTestEnv } from "~/lib/env"
import { JobRetryLaterError } from "~/lib/failure-severity"
import { jobsLogger as log } from "~/lib/logger"
import { redis as appRedis, bullPrefix, redisBullMQ as redis } from "~/lib/redis"
import {
  isShuttingDown,
  msSinceShutdownBegan,
  registerShutdownPhase,
  shutdownBudgets,
} from "~/lib/shutdown"
import {
  AFTER_DRAIN_DEADLINE_MS,
  JOB_ABORT_SETTLE_MS,
  JOB_QUEUE_CLOSE_MS,
  SHUTDOWN_ORDER,
} from "~/lib/shutdown-budget"
import { isOrgUnderMaintenance } from "~/middleware/org-maintenance"
import { isNoConnectedAccountError } from "~/modules/apps/connections/no-connected-account"
import { awaitOrgApps, type OrgSetupTrigger } from "~/modules/apps/init"
import {
  assertAppActive,
  isAppActiveForOrgAsync,
  isOrgDeletingAsync,
  isOrgMissingAsync,
} from "~/modules/apps/org-apps"
import { AppDayCapHeldJobError } from "~/modules/apps/usage/app-day-cap"
import { orgSuspendedOrClosed } from "~/modules/cloud/billing-status"
import { beginOrgActivity, orgTransferStateOf } from "~/modules/org/transfer-state/state"
import { assertEnqueueAllowed, bindBackpressureClient } from "./backpressure"
import {
  type FairEntry,
  fairEnqueue,
  forgetFairJob,
  isFairQueue,
  recordJobWait,
  releaseToken,
  schedulerPriority,
  setLocalJobSlots,
  startTokenRenewal,
  stopTokenRenewal,
  tryAdmit,
} from "./fairness"
import {
  FANOUT_MIN_RETENTION_MS,
  fanoutEpochOrUndefined,
  fanoutJobId,
  LEGACY_PER_ORG_SCHEDULER_RE,
} from "./fanout"
import {
  countFanoutRun,
  countJobMetrics,
  fanoutJobOptions,
  releaseFanoutPending,
  uncountFanoutRun,
} from "./fanout-keys"
import { type JobFairFrame, jobOriginRef, runAsJob } from "./job-origin"
import { encodeLegacyJobId } from "./legacy-job-ids"
import { countScheduledOrgJob } from "./org-job-cap"
import {
  isKernelApp,
  type JobRoute,
  type KernelQueueClass,
  kernelSlotsWanted,
  LEGACY_DRAIN_CONCURRENCY,
  LEGACY_KERNEL_QUEUE,
  parseConcurrencyOverrides,
  planKernelSlots,
  resolveJobQueue,
} from "./queue-classes"
import { diagQueueNames, type QueueHealth, readQueueHealth } from "./queue-health"

/** Thrown when a job for an org under the migration maintenance gate reaches the worker. BullMQ retries it like any other handler error. */
export class OrgUnderMaintenanceJobError extends Error {
  constructor(orgId: string, queueName: string, jobName: string) {
    super(`org ${orgId} is under maintenance; refusing to run ${queueName}:${jobName}`)
    this.name = "OrgUnderMaintenanceJobError"
  }
}

/**
 * The job of an org that is moving to another instance (modules/org/
 * transfer-state/): never run here and never completed. The worker puts it
 * back as delayed with its data (`moveToDelayed`), so it runs once the move is
 * over, here if the move was aborted, or on the target after the export.
 */
export class OrgTransferHeldJobError extends Error {
  constructor(
    readonly orgId: string,
    readonly delayMs: number,
    queueName: string,
    jobName: string,
  ) {
    super(`org ${orgId} is moving; ${queueName}:${jobName} is held`)
    this.name = "OrgTransferHeldJobError"
  }
}

/** The longest one hop of a long timer waits (the delay an app job may ask for). */
export const TIMER_HOP_MAX_MS = 15 * 60 * 1000
/** A timer due within this is run now rather than held again. */
const TIMER_DUE_TOLERANCE_MS = 1_000

/**
 * A long timer's job (`ctx.timers.wakeIn` past 15 min, bridge/platform.ts)
 * carries its wake time as `_wakeAt`: until then the worker puts it back as
 * delayed, 15 min at a time, unrun and without spending an attempt, so it
 * keeps its id (and its deduplication) through every hop. Returns when to look
 * at it again, or null once it is due.
 */
export function timerHoldUntil(data: unknown, now: number): number | null {
  const wakeAt = (data as { _wakeAt?: unknown } | null | undefined)?._wakeAt
  if (typeof wakeAt !== "number" || !Number.isFinite(wakeAt)) return null
  if (wakeAt - now <= TIMER_DUE_TOLERANCE_MS) return null
  return Math.min(wakeAt, now + timerHopMaxMs)
}

/** One hop's length; a test shortens it (JobsTestAccess.setTimerHopMaxMs). */
let timerHopMaxMs = TIMER_HOP_MAX_MS

/** How long a held job waits before it is looked at again. */
export const TRANSFER_HELD_JOB_DELAY_MS = 5_000
/** Once the org has moved away its jobs only wait for the export to take them. */
export const TRANSFER_MOVED_JOB_DELAY_MS = 30_000

let jobsHeldAppDayCap = 0
/** Org jobs put back because their org reached an app day cap. */
export function jobsHeldAppDayCapCount(): number {
  return jobsHeldAppDayCap
}

let jobsHeldOrgTransfer = 0
/** Org jobs put back because their org was moving. */
export function jobsHeldOrgTransferCount(): number {
  return jobsHeldOrgTransfer
}

/**
 * The delay to hold the org's job for, or null to run it. A state that cannot
 * be read holds it too (fail closed, nothing is run or lost).
 */
async function transferHoldMs(orgId: string): Promise<number | null> {
  try {
    const rec = await orgTransferStateOf(orgId)
    if (rec === null) return null
    return rec.state === "moved" ? TRANSFER_MOVED_JOB_DELAY_MS : TRANSFER_HELD_JOB_DELAY_MS
  } catch {
    return TRANSFER_HELD_JOB_DELAY_MS
  }
}

bindBackpressureClient(redis)

const queues = new Map<string, Queue>()
const workers = new Map<string, Worker>()
// Registered handler + how it receives its DB context (see job-context.ts),
// keyed by the LOGICAL pair `${appName}:${jobName}`.
/** What a running job is told besides its payload. */
export interface JobRunContext {
  /**
   * Aborts when the shutdown's job drain budget is spent (lib/shutdown.ts): a
   * handler that can stop early throws on it, and the job goes back to its
   * queue, unspent, for another worker. One that ignores it runs on until the
   * process exits, and BullMQ's stalled-job check re-runs it later.
   */
  signal: AbortSignal
  /**
   * The scheduled fire time of a job a scheduler minted (BullMQ's
   * `opts.prevMillis`, else read from its `repeat:<id>:<millis>` id). Absent
   * on an enqueued job. The cron fan-out's epoch (fanout.ts).
   */
  firedAt?: number
  /** When this worker took the job (BullMQ `processedOn`, ms). */
  activeAt?: number
}

interface RegisteredHandler {
  handler: (payload: any, ctx?: JobRunContext) => Promise<void>
  txMode: JobTxMode
}
const jobHandlers = new Map<string, RegisteredHandler>()
// Every physical queue that has at least one registered handler: which
// logical app its jobs belong to, and the worker slots it gets. A job host
// creates one Worker per entry.
const queueBindings = new Map<string, { appName: string; concurrency: number }>()

const handlerKey = (appName: string, jobName: string) => `${appName}:${jobName}`

// Boot gate for job processing. The production entrypoint registers kernel job
// workers BEFORE per-org app registration (`ensureAppsForOrg`), but jobs left
// in Redis from before a restart (routine-tick, agent-reinvoke, agent-subrun,
// knowledge indexing…) drive agent tool calls into the sandbox — and until
// registration completes the in-memory app registries (manifests, tools,
// bridge schemas) are empty, so those calls fail with cross-app schema errors
// ("Entity X not found in app schema"). Closing the gate makes workers start
// paused (`autorun: false`); `startDeferredJobWorkers()` resumes them once the
// registries are warm. Test/E2E harnesses never close the gate, so their
// workers autorun exactly as before.
let deferWorkerAutorun = false

// Two gates decide whether the BullMQ workers actually process jobs:
//   bootComplete -- app registries are warm (the existing boot-defer, above), and
//   jobsLeader   -- this node is the Patroni leader (HA singleton gate, off by
//                   default so it does not change single-active behavior).
// Workers run iff BOTH are true; otherwise they are paused / left unstarted.
let bootComplete = false
let jobsLeader = true

/** Test runs opt their process in as a job host through this env var (bunfig preload). */
export const TEST_JOB_HOST_ENV = "LIAISON_TEST_JOB_HOST"

/** The `liaison` CLI marks its process with this (cli/cli-env.ts): never a job host. */
function isCliProcess(): boolean {
  return process.env.LIAISON_CLI === "1"
}

// Is this process a job host (see header)? Off unless an entrypoint calls
// `hostJobWorkers()`; a `bun test` run is a host through its preload env.
let hosting = !isCliProcess() && isTestEnv() && process.env[TEST_JOB_HOST_ENV] === "1"

// HARD gate, above hosting. `disableJobWorkers()` makes a process permanently
// incapable of owning a worker, even if something later asks it to host:
// `registerJobWorker` records the handler (so in-process bookkeeping like
// `isJobWorkerRegistered` still works) but creates no Worker, so everything the
// script enqueues stays in Redis for the app process to handle.
let workersDisabled = false

function workersShouldRun(): boolean {
  return hosting && bootComplete && jobsLeader && !workersDisabled
}

/**
 * Publish the worker slots this process runs per queue with its instance
 * record (fairness.ts sums them over the cell): its workers' concurrency while
 * they run, none while they are paused, gated or stopping.
 */
function publishJobSlots(): void {
  // The gates each job start checks (a test harness never closes the boot gate).
  const running = jobsMayStart()
  setLocalJobSlots(
    running
      ? Object.fromEntries(
          [...workers.keys()].map((q) => [q, queueBindings.get(q)?.concurrency ?? 0]),
        )
      : {},
  )
}

/**
 * Drive every worker to the desired run/pause state for the current gates.
 * Handles the three lifecycles: never-started (autorun:false -> `run()`),
 * started-then-paused (`resume()`), and running (`pause()`).
 */
function reconcileJobWorkers(): void {
  const shouldRun = workersShouldRun()
  for (const [queueName, worker] of workers) {
    if (shouldRun) {
      if (worker.isPaused()) {
        // BullMQ 6: resume() is async; a rejection must not go unhandled.
        Promise.resolve(worker.resume()).catch((err) => {
          log.error({ worker: queueName, err }, "Job worker failed to resume")
        })
      } else if (!worker.isRunning()) {
        worker.run().catch((err) => {
          log.error({ worker: queueName, err }, "Job worker failed to run")
        })
      }
    } else if (worker.isRunning() && !worker.isPaused()) {
      worker.pause().catch((err) => {
        log.error({ worker: queueName, err }, "Job worker failed to pause")
      })
    }
  }
  publishJobSlots()
}

/**
 * Close the boot gate: workers created after this call start paused, and any
 * worker already created (autorun) is paused too. A running worker drains the
 * Redis backlog against a half-empty handler map: every job grabbed before the
 * app registries are warm fails "No handler registered" and burns a retry
 * attempt. The server calls this BEFORE `hostJobWorkers()`, so its workers are
 * born paused; module-scope registrations in the import graph (spawn-agent)
 * create no worker at all, because the process is not a host yet.
 */
export function deferJobWorkersUntilBootComplete(): void {
  deferWorkerAutorun = true
  bootComplete = false
  reconcileJobWorkers()
}

/** Open the boot gate and start every worker (subject to the leadership gate). */
export function startDeferredJobWorkers(): void {
  if (workersDisabled) {
    log.warn("Job workers are disabled in this process — startDeferredJobWorkers() ignored")
    return
  }
  if (!hosting) {
    log.warn("This process is not a job host — startDeferredJobWorkers() ignored")
    return
  }
  deferWorkerAutorun = false
  bootComplete = true
  reconcileJobWorkers()
}

/**
 * Disable job workers for the WHOLE process, permanently: no Worker is created
 * from here on, any worker already created is paused and closed, and
 * `startDeferredJobWorkers()` becomes a no-op so nothing downstream can re-arm
 * them. For processes that pull the app import graph only to write rows —
 * `scripts/seed-qa.ts` — where becoming a worker
 * means STEALING jobs from the running app: the seed process registered as an
 * `app-kernel` worker, grabbed the `search-index-upsert` jobs it had just
 * enqueued for the tickets and knowledge documents it seeded, failed them with
 * "No handler registered" and exhausted their retries, so those items never
 * reached the search index.
 *
 * Must be armed BEFORE the import graph evaluates (ES imports hoist, and
 * spawn-agent creates the `app-kernel` worker at module scope): scripts arm it
 * through the bare first import of `scripts/lib/no-job-workers`.
 */
export function disableJobWorkers(): void {
  workersDisabled = true
  hosting = false
  deferWorkerAutorun = true
  bootComplete = false
  // Pause anything that slipped through (a worker created before this call),
  // then drop it entirely so it cannot be resumed by any later reconcile.
  reconcileJobWorkers()
  for (const [queueName, worker] of workers) {
    worker.close(true).catch((err) => log.warn({ worker: queueName, err }, "Worker close failed"))
  }
  workers.clear()
}

/**
 * Declare this process a job host: create a Worker for every queue that has a
 * handler, now and for every later registration, subject to the boot and
 * leadership gates. Only the API server entrypoint (index.ts) and the test
 * harness entrypoints call it. The `liaison` CLI can never host: it refuses
 * loudly, because a CLI worker steals and fails the server's jobs.
 */
export function hostJobWorkers(): void {
  if (isCliProcess()) {
    throw new Error("The liaison CLI must never host job workers (LIAISON_CLI=1)")
  }
  if (workersDisabled) {
    log.warn("Job workers are disabled in this process — hostJobWorkers() ignored")
    return
  }
  hosting = true
  for (const queueName of queueBindings.keys()) ensureWorker(queueName)
}

/** True when this process has been told it must never run job workers. */
export function areJobWorkersDisabled(): boolean {
  return workersDisabled
}

/** How many BullMQ workers this process currently owns (0 when disabled). */
export function jobWorkerCount(): number {
  return workers.size
}

/**
 * HA singleton gate. Called by the leadership monitor (infra/leadership.ts) on
 * every leadership transition. When this node loses leadership the workers are
 * paused so a warm standby never double-processes scheduled jobs; when it gains
 * leadership they resume. No-op semantics when leadership gating is off (the
 * monitor announces `true` once).
 */
export function setJobsLeadership(isLeader: boolean): void {
  jobsLeader = isLeader
  reconcileJobWorkers()
}

function scopeAllows(granted: string, requested: string): boolean {
  if (granted === "*" || granted === requested) return true
  if (requested.startsWith(`${granted}:`)) return true
  if (granted.endsWith(":*")) {
    const prefix = granted.slice(0, -2)
    return requested === prefix || requested.startsWith(`${prefix}:`)
  }
  return false
}

/**
 * Decide what scopes a user-attributed app job actually runs with.
 *
 * `_callerScopes` is a snapshot of the TURN actor's scopes at enqueue time. For
 * an agent or routine turn that actor is the agent/routine, not the owning
 * user, so the snapshot can legitimately contain scopes the user does not hold
 * (this is what killed prod's `mail:gmail-incremental-sync` jobs: the worker
 * threw rather than running). A snapshot broader than the user is not an
 * attack, it is an over-broad snapshot, so the job runs with the INTERSECTION
 * of the two. Every retained scope is allowed by the snapshot AND by the user,
 * which preserves the security property the snapshot exists for: a job never
 * runs with MORE than was snapshotted. Only a fully disjoint snapshot fails.
 */
function resolveJobScopes(args: {
  appName: string
  jobName: string
  hasDeclaredScopes: boolean
  snapshotScopes: string[]
  userScopes: string[]
}): { scopes: string[]; droppedScopes: string[] } {
  const { appName, jobName, hasDeclaredScopes, snapshotScopes, userScopes } = args
  // When the enqueuer did not supply a caller-scope snapshot, fall back to the
  // app's own scope namespace rather than the user's full permission set —
  // this is the minimal safe default.
  if (!hasDeclaredScopes || snapshotScopes.length === 0) {
    return { scopes: [`${appName}:*`], droppedScopes: [] }
  }
  const allowedVerbatim = snapshotScopes.filter((scope) =>
    userScopes.some((granted) => scopeAllows(granted, scope)),
  )
  // A user holding a narrower child of a snapshot scope (user has `mail:read`,
  // snapshot says `mail:*`) keeps that child rather than losing the branch.
  const narrowedFromUser = userScopes.filter(
    (granted) =>
      !allowedVerbatim.includes(granted) &&
      snapshotScopes.some((scope) => scopeAllows(scope, granted)),
  )
  const intersection = [...new Set([...allowedVerbatim, ...narrowedFromUser])]
  if (intersection.length === 0) {
    throw new Error(`Job requested scopes not held by user: ${appName}:${jobName}`)
  }
  return {
    scopes: intersection,
    droppedScopes: snapshotScopes.filter((scope) => !allowedVerbatim.includes(scope)),
  }
}

// Retention defaults for EVERY queue created here. `enqueueAppJob` already
// passes its own `removeOnComplete: 100, removeOnFail: 1000` per-call, which
// wins over these queue-level defaults (BullMQ: per-job opts override
// `defaultJobOptions`) — so its tuning is untouched. The gap this closes is
// the two scheduler paths (`registerScheduledJob`'s upsert and the exported
// `upsertJobScheduler`), which upsert scheduler *templates* with no
// removeOnComplete/removeOnFail of their own: every cron tick they produce
// left a completed (or failed) job in Redis forever, unbounded growth across
// every recurring job in the system. BullMQ v5 applies `defaultJobOptions`
// (incl. KeepJobs-shaped removeOnComplete/removeOnFail) to jobs produced by a
// job scheduler's template when the template itself doesn't specify them, so
// this single fix point covers both scheduler call sites without touching
// their call-site opts.
const DEFAULT_QUEUE_JOB_OPTIONS = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
}

/** The BullMQ queue object for a physical queue name, created once per process. */
function getQueue(queueName: string): Queue {
  const existing = queues.get(queueName)
  if (existing) return existing
  const queue = new Queue(queueName, {
    connection: redis,
    prefix: bullPrefix,
    defaultJobOptions: DEFAULT_QUEUE_JOB_OPTIONS,
  })
  queues.set(queueName, queue)
  return queue
}

/**
 * The queue of an APP (`app-<name>`). The kernel has no single queue any more:
 * use `getJobQueue("kernel", jobName)`, which resolves the job's class.
 */
export function createAppQueue(appName: string): Queue {
  if (isKernelApp(appName)) {
    throw new Error('The kernel has one queue per class: use getJobQueue("kernel", jobName)')
  }
  return getQueue(`app-${appName}`)
}

/** The queue a logical job runs on (its kernel class queue, or its app's queue). */
export function getJobQueue(appName: string, jobName: string): Queue {
  return getQueue(resolveJobQueue(appName, jobName).queueName)
}

/** The queue object of a physical queue name (a kernel class queue or `app-<name>`). */
export function getPhysicalQueue(queueName: string): Queue {
  return getQueue(queueName)
}

/** The legacy shared kernel queue, for the boot migration that empties it. */
export function getLegacyKernelQueue(): Queue {
  return getQueue(LEGACY_KERNEL_QUEUE)
}

/**
 * Returns true when a handler is already registered for the (appName, jobName)
 * pair. Used by placeholder registrations (spawn-agent's pre-Task-4 stub) to
 * avoid blowing away a real worker registered later by a hot-reloaded module.
 */
export function isJobWorkerRegistered(appName: string, jobName: string): boolean {
  return jobHandlers.has(handlerKey(appName, jobName))
}

/**
 * Forget an app's job handlers, except the jobs named in `keep`. Handlers are
 * process-wide (keyed app + job, not per org), so an app version switch keeps
 * the jobs the new version registered and drops the ones only the old version
 * had: a job of the old version must not stay callable after the switch. An
 * uninstall keeps none. The app's queue and worker stay (a job left in Redis
 * for a dropped handler fails as an unknown job).
 */
export function unregisterAppJobHandlers(appName: string, keep: Iterable<string> = []): void {
  const kept = new Set([...keep].map((jobName) => handlerKey(appName, jobName)))
  const prefix = `${appName}:`
  for (const key of [...jobHandlers.keys()]) {
    if (key.startsWith(prefix) && !kept.has(key)) jobHandlers.delete(key)
  }
}

// Kernel worker slots per class, planned once against the privileged pool
// (queue-classes.ts, THE SLOT BUDGET).
let kernelSlotPlan: ReturnType<typeof planKernelSlots> | null = null

function kernelClassConcurrency(cls: KernelQueueClass): number {
  if (!kernelSlotPlan) {
    const overrides = parseConcurrencyOverrides(env.JOB_QUEUE_CONCURRENCY)
    // The privileged pool's planned size (db/pool-plan.ts), the one source.
    kernelSlotPlan = planKernelSlots(overrides, poolPlan.pools.privileged)
    if (kernelSlotPlan.scaledDown) {
      log.warn(
        {
          slots: kernelSlotPlan.slots,
          budget: kernelSlotPlan.budget,
          wanted: kernelSlotsWanted(overrides).total,
          privilegedPool: poolPlan.pools.privileged,
        },
        "kernel slots scaled down: the privileged pool is too small for every kernel slot plus its headroom",
      )
    }
  }
  return kernelSlotPlan.slots[cls]
}

function bindQueue(queueName: string, appName: string, concurrency: number): void {
  if (!queueBindings.has(queueName)) queueBindings.set(queueName, { appName, concurrency })
  if (hosting && !workersDisabled) ensureWorker(queueName)
}

/**
 * Bind a Worker to every catalog app queue (A3): a worker-capable process
 * consumes `app-<name>` for each app whose manifest declares jobs from boot,
 * before (and without) any org being registered here. The dispatcher sets the
 * job's org up first, which registers the handler (`processJob`). Kernel jobs
 * bind through their own registrations. Idempotent: the org's later
 * `registerJobWorker` finds the queue bound (same default concurrency, 5).
 */
export function bindCatalogAppQueues(apps: ReadonlyArray<{ name: string; jobs?: unknown }>): void {
  for (const app of apps) {
    if (isKernelApp(app.name)) continue
    const jobs = app.jobs
    if (!jobs || typeof jobs !== "object" || Object.keys(jobs).length === 0) continue
    bindQueue(`app-${app.name}`, app.name, 5)
  }
}

/**
 * Register a BullMQ worker handler for an (appName, jobName) pair. The handler
 * receives the job's payload directly — same shape as what was passed to
 * `enqueueAppJob`. The framework spreads `{ ...job.data, _tx }` into the
 * payload when the job carries an `orgId` (privileged + RLS paths above), so
 * declare TPayload accordingly if your handler reads `_tx`.
 *
 * A kernel job must be classified in queue-classes.ts (this throws otherwise);
 * its class decides its queue and worker slots. Registration only records the
 * handler: the Worker exists only in a job host (`hostJobWorkers`).
 */
export function registerJobWorker<TPayload = unknown>(
  appName: string,
  jobName: string,
  handler: (payload: TPayload, ctx?: JobRunContext) => Promise<void>,
  opts?: {
    /**
     * `ambient` (default, legacy): one RLS transaction around the whole run,
     * handed over as `_tx`. `session`: no ambient transaction; the handler gets
     * an RlsSession as `_session` and opens short per-call transactions itself
     * (the sandbox session bridge does this for manifest jobs). See job-context.ts.
     */
    txMode?: JobTxMode
    /** Worker concurrency for an APP queue; honoured by the first registration
     *  on that queue (default 5). Kernel classes take theirs from queue-classes.ts. */
    concurrency?: number
  },
): void {
  const route = resolveJobQueue(appName, jobName)
  jobHandlers.set(handlerKey(appName, jobName), {
    handler: handler as (payload: any, ctx?: JobRunContext) => Promise<void>,
    txMode: opts?.txMode ?? "ambient",
  })
  if (route.queueClass) {
    bindQueue(route.queueName, appName, kernelClassConcurrency(route.queueClass))
    // Jobs enqueued before the class split still sit in `app-kernel`: a job
    // host drains them by name (see queue-classes.ts, LEGACY).
    bindQueue(LEGACY_KERNEL_QUEUE, appName, LEGACY_DRAIN_CONCURRENCY)
  } else {
    bindQueue(route.queueName, appName, opts?.concurrency ?? 5)
  }
}

/** Set while closeAllQueues runs: no job may start then. */
let closingQueues = false
/** How long a job fetched past a closed gate waits before it is offered again. */
const GATED_JOB_REQUEUE_MS = 1_000
/** See the Worker's maxStalledCount (ensureWorker). */
const JOB_MAX_STALLED_COUNT = 3

/** The gates reconcileJobWorkers applies to the workers, checked again as each job starts. */
function jobsMayStart(): boolean {
  return hosting && !workersDisabled && jobsLeader && !deferWorkerAutorun && !closingQueues
}

/** A job this process is running, with the lock token BullMQ handed it (see handBackInFlightJobs). */
interface InFlightJob {
  job: Job
  token: string
  abort: AbortController
  settled: Promise<void>
  /** The processor's promise settled (the worker callback finishes the job). */
  done: boolean
  /** Moved back to wait by this process: the processor's result is dropped. */
  handedBack: boolean
  /** The fairness token the run holds (fairness.ts), released on every exit. */
  fair?: HeldFairToken
}

/** A fairness token held by a run: its org and the member it was admitted with. */
interface HeldFairToken {
  orgId: string
  member: string | null
}

/**
 * Give a run's fairness token back and promote its org's oldest parked job
 * (fairness.ts). Idempotent: a second release of the same member does nothing.
 */
function releaseFairToken(queueName: string, fair: HeldFairToken | undefined): Promise<void> {
  if (!fair?.member) return Promise.resolve()
  return releaseToken(queueName, fair.orgId, fair.member, async (jobId) => {
    const parked = await getQueue(queueName).getJob(jobId)
    if (!parked || !(await parked.isDelayed())) return false
    await parked.promote()
    return true
  })
}

function orgOfJobData(data: unknown): string | undefined {
  const orgId = (data as { orgId?: unknown } | null | undefined)?.orgId
  return typeof orgId === "string" && orgId !== "" ? orgId : undefined
}
const inFlightJobs = new Map<string, InFlightJob>()
/** Jobs whose handler started after the drain began: the gate keeps it 0 (A16). */
let claimedWhileDraining = 0
export function jobsClaimedWhileDraining(): number {
  return claimedWhileDraining
}
/** Jobs a fetch already in flight at the drain's start brought in; each went back unrun. */
let bouncedWhileDraining = 0
export function jobsBouncedWhileDraining(): number {
  return bouncedWhileDraining
}

/**
 * Shutdown: put every job this process is still running back on its queue.
 * The workers are force-closed below, which leaves such a job ACTIVE under a
 * lock nobody renews: BullMQ recovers it only after two stalled-job checks
 * (about a minute), and until then its deduplication id stays taken, so the
 * next boot's request for the same job (a search rebuild after a restart) is
 * silently merged into the dead one. Handed back, it waits for the next worker
 * and runs as soon as that boot opens its queues. Jobs are already written to
 * survive a re-run (stalled recovery re-runs them the same way). Never throws.
 */
async function handBackInFlightJobs(): Promise<void> {
  if (inFlightJobs.size === 0) return
  const running = [...inFlightJobs.values()]
  inFlightJobs.clear()
  const handed: string[] = []
  await Promise.all(
    running.map(async (entry) => {
      const { job, token } = entry
      try {
        entry.handedBack = true
        // A negative result is BullMQ's error code (job gone, lock not ours).
        const code = await job.moveToWait(token)
        if (code < 0) throw new Error(`moveJobFromActiveToWait returned ${code}`)
        handed.push(job.name)
      } catch (err) {
        log.warn({ jobId: job.id, jobName: job.name, err }, "Could not hand a running job back")
      }
      await releaseFairToken(job.queueName, entry.fair)
    }),
  )
  if (handed.length > 0) log.info({ jobs: handed }, "Handed running jobs back to their queues")
}

/** Create the Worker for a bound queue, once. Only ever reached in a job host. */
function ensureWorker(queueName: string): void {
  if (workers.has(queueName) || workersDisabled || !hosting) return
  // No new worker once the process is shutting down (a SIGTERM during boot).
  if (isShuttingDown()) return
  const binding = queueBindings.get(queueName)
  if (!binding) return
  const worker = new Worker(
    queueName,
    async (job, token) => {
      // Pausing a worker does not cancel the fetch it already has in flight:
      // a job can arrive here after this node lost leadership, while the boot
      // gate is closed, or during shutdown. It goes back on the queue, unrun
      // and without spending an attempt, for whichever worker may run it.
      if (!jobsMayStart() && token) {
        // Draining: back at once, for a live worker; otherwise after a beat.
        if (closingQueues) bouncedWhileDraining++
        await job.moveToDelayed(Date.now() + (closingQueues ? 0 : GATED_JOB_REQUEUE_MS), token)
        throw new DelayedError()
      }
      // A long timer not yet due hops again (timerHoldUntil).
      const holdUntil = token ? timerHoldUntil(job.data, Date.now()) : null
      if (holdUntil !== null && token) {
        await job.moveToDelayed(holdUntil, token)
        throw new DelayedError()
      }
      // An org moving to another instance (modules/org/transfer-state/): its
      // job is put back, kept, unrun and without spending an attempt.
      const movingOrg = orgOfJobData(job.data)
      if (movingOrg && token) {
        const holdMs = await transferHoldMs(movingOrg)
        if (holdMs !== null) {
          jobsHeldOrgTransfer++
          await job.moveToDelayed(Date.now() + holdMs, token)
          throw new DelayedError()
        }
      }
      // Fairness (fairness.ts): an org's job over its share of the queue is
      // parked, unrun and without spending an attempt; its org's next
      // release promotes it, and its timer is the safety net.
      const orgId = orgOfJobData(job.data)
      let fair: HeldFairToken | undefined
      if (token && orgId && job.id && isFairQueue(queueName)) {
        const verdict = await tryAdmit(queueName, orgId, job.id, token)
        if (!verdict.admitted) {
          await job.moveToDelayed(Date.now() + verdict.parkMs, token)
          throw new DelayedError()
        }
        fair = { orgId, member: verdict.member }
        if (verdict.first) {
          void recordJobWait(queueName, orgId, Date.now() - (job.timestamp + (job.opts.delay ?? 0)))
        }
      }
      if (closingQueues) claimedWhileDraining++
      const key = `${queueName}:${job.id}`
      const abort = new AbortController()
      const run = processJob(
        queueName,
        binding.appName,
        job,
        abort.signal,
        fair?.member && orgId && job.id
          ? { queue: queueName, orgId, jobId: job.id, admitted: true }
          : undefined,
      )
      const entry: InFlightJob | undefined = token
        ? {
            job,
            token,
            abort,
            settled: run.then(noop, noop),
            done: false,
            handedBack: false,
            fair,
          }
        : undefined
      if (entry) {
        void entry.settled.then(() => {
          entry.done = true
        })
        inFlightJobs.set(key, entry)
      }
      try {
        await run
        // Handed back at exit (registerJobShutdownPhases) while it still ran:
        // the job is no longer this process's, so leave it as it is.
        if (entry?.handedBack) {
          await uncountFanoutRun(job.id, job.attemptsMade)
          throw new DelayedError()
        }
      } catch (err) {
        if (err instanceof DelayedError) throw err
        // The org started moving between the check above and the dispatch's.
        if (err instanceof OrgTransferHeldJobError && token) {
          jobsHeldOrgTransfer++
          await job.moveToDelayed(Date.now() + err.delayMs, token)
          await uncountFanoutRun(job.id, job.attemptsMade)
          throw new DelayedError()
        }
        // The org reached an app day cap (modules/apps/usage/app-day-cap.ts):
        // back as delayed until the next UTC day, its data and attempts kept.
        if (err instanceof AppDayCapHeldJobError && token) {
          jobsHeldAppDayCap++
          await job.moveToDelayed(Date.now() + err.delayMs, token)
          await uncountFanoutRun(job.id, job.attemptsMade)
          throw new DelayedError()
        }
        if (entry?.handedBack) {
          await uncountFanoutRun(job.id, job.attemptsMade)
          throw new DelayedError()
        }
        // Stopped by the drain (registerJobShutdownPhases): back on its queue
        // now, unspent, for another worker. Its processor has settled, so the
        // job is visible to another worker only once this run is over.
        if (abort.signal.aborted && token) {
          await job.moveToDelayed(Date.now(), token)
          await uncountFanoutRun(job.id, job.attemptsMade)
          throw new DelayedError()
        }
        throw err
      } finally {
        inFlightJobs.delete(key)
        await releaseFairToken(queueName, fair)
      }
    },
    {
      connection: redis,
      prefix: bullPrefix,
      // Named after this process, so Queue.getWorkers() says which process
      // holds a Worker on the queue (and job.processedBy names it).
      name: INSTANCE_ID,
      concurrency: binding.concurrency,
      // A job whose process died without handing it back (a SIGKILL, a crash)
      // stalls, and BullMQ fails it past this count. A rolling deploy can stop
      // two or three processes in turn under one long job: each such stop may
      // cost it a stall, never the job.
      maxStalledCount: JOB_MAX_STALLED_COUNT,
      // autorun only when BOTH gates are open: boot complete AND this node is the
      // leader. A worker registered after boot (per-org app install) on a standby
      // node therefore starts paused, and reconcileJobWorkers() resumes it if/when
      // this node becomes leader.
      autorun: !deferWorkerAutorun && jobsLeader,
    },
  )

  worker.on("failed", (job, err) => {
    if (job && job.attemptsMade >= (job.opts?.attempts ?? 3)) {
      log.error(
        { worker: queueName, jobId: job.id, jobName: job.name, err },
        "Job exhausted all retries",
      )
    }
  })

  // A BullMQ Worker is an EventEmitter and re-emits its blocking-connection's
  // errors as its own `'error'` event (worker.js: `blockingConnection.on(
  // 'error', err => this.emit('error', err))`). EventEmitter semantics make
  // an `'error'` emission with NO listener *throw* — so a transient Redis
  // blip, or the blocking client being torn down with a pending BZPOPMIN
  // during `closeAllQueues()`, surfaces as an unhandled error ("Connection is
  // closed", flushed by ioredis's close handler). In the flat unit run that
  // floats *between tests* and fails the whole suite ("Unhandled error
  // between tests" → `1 error`, exit 1); in production it can crash the
  // process on any Redis reconnect. Attaching a listener makes the worker's
  // connection errors handled (logged) instead of fatal. Operational job
  // failures still flow through `'failed'` above; this is the connection/
  // infrastructure error channel.
  worker.on("error", (err) => {
    log.error({ worker: queueName, err }, "Job worker connection error")
  })

  workers.set(queueName, worker)
  publishJobSlots()
  startTokenRenewal()
}

export type EnqueueOptions = {
  attempts?: number
  backoff?: { type: string; delay: number }
  /**
   * Logical id: while a job with this id is waiting, delayed or running, a
   * second enqueue is dropped (BullMQ deduplication, inside the add script).
   * Once it has completed or failed, the id is free again.
   */
  jobId?: string
  delay?: number
  /** Re-arm a still-DELAYED job with the same id instead of being deduplicated
   *  by it, so a caller that re-arms a sliding deadline on every event (the
   *  episode quiet close) moves the deadline to the newest arm. */
  replaceDelayed?: boolean
  /**
   * `jobId` deduplicates for this long from the enqueue, whatever the job's
   * state (BullMQ throttle mode), instead of until the job finishes: a timer
   * deduplicates while it is pending, and the job it wakes may re-arm itself
   * under the same id.
   */
  dedupTtlMs?: number
}

function buildJobOptions(route: { priority?: number }, opts?: EnqueueOptions): JobsOptions {
  return {
    ...(opts?.jobId
      ? {
          deduplication: {
            id: opts.jobId,
            ...(opts.replaceDelayed ? { replace: true } : {}),
            ...(typeof opts.dedupTtlMs === "number" && opts.dedupTtlMs > 0
              ? { ttl: Math.round(opts.dedupTtlMs) }
              : {}),
          },
        }
      : {}),
    ...(route.priority ? { priority: route.priority } : {}),
    attempts: opts?.attempts ?? 3,
    backoff: opts?.backoff ?? { type: "exponential", delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 1000,
    ...(typeof opts?.delay === "number" ? { delay: Math.max(0, opts.delay) } : {}),
  }
}

function assertRegistered(appName: string, jobName: string): void {
  if (!jobHandlers.has(handlerKey(appName, jobName))) {
    throw new Error(`No handler registered for job "${appName}:${jobName}"`)
  }
}

/** Jobs skipped at start because their app is Off for the org (S19); read by metrics/tests. */
let jobsSkippedAppDisabled = 0
export function jobsSkippedAppDisabledCount(): number {
  return jobsSkippedAppDisabled
}

/**
 * An app turned Off (or removed) for the payload's org enqueues nothing (S19):
 * refused with the typed `app_disabled` error. Kernel jobs and payloads that
 * name no org are not app work of one workspace and pass.
 */
async function assertAppOnForPayload(appName: string, payload: unknown): Promise<void> {
  if (isKernelApp(appName)) return
  const orgId = (payload as { orgId?: unknown } | null | undefined)?.orgId
  if (typeof orgId !== "string" || orgId.length === 0) return
  await assertAppActive(orgId, appName)
}

/**
 * Enqueue one job: a single Redis round trip. Returns the logical id when one
 * was given, else BullMQ's id. Throws `QueueBackpressureError` when Redis
 * memory or the queue's backlog is past its bound (backpressure.ts).
 */
export async function enqueueAppJob(
  appName: string,
  jobName: string,
  payload: unknown,
  opts?: EnqueueOptions,
): Promise<string> {
  assertRegistered(appName, jobName)
  await assertAppOnForPayload(appName, payload)
  const route = resolveJobQueue(appName, jobName)
  assertEnqueueAllowed(route.queueName)
  const [job] = await fairEnqueue(getQueue(route.queueName), [
    { name: jobName, data: payload, opts: buildJobOptions(route, opts) },
  ])
  log.debug({ queue: route.queueName, jobName, jobId: opts?.jobId ?? job?.id }, "Job enqueued")
  return opts?.jobId ?? job?.id ?? ""
}

/**
 * Enqueue a job whose handler THIS process does not host: the `liaison` CLI
 * (never a job host) handing work to the server's worker, e.g. the routine
 * event reconciler's one shot backfill. Same queue, options and backpressure as
 * `enqueueAppJob`; only the local registration check is skipped, because the
 * handler lives in the server process.
 */
export async function enqueueAppJobForServer(
  appName: string,
  jobName: string,
  payload: unknown,
  opts?: EnqueueOptions,
): Promise<string> {
  const route = resolveJobQueue(appName, jobName)
  assertEnqueueAllowed(route.queueName)
  const [job] = await fairEnqueue(getQueue(route.queueName), [
    { name: jobName, data: payload, opts: buildJobOptions(route, opts) },
  ])
  return opts?.jobId ?? job?.id ?? ""
}

/**
 * Enqueue many jobs of one app, one round trip per target queue (BullMQ
 * `addBulk`, a MULTI). Same per-job semantics as `enqueueAppJob`, including
 * the jobId deduplication. For callers that produce a batch at once.
 */
export async function enqueueAppJobs(
  appName: string,
  jobs: ReadonlyArray<{ jobName: string; payload: unknown; opts?: EnqueueOptions }>,
): Promise<void> {
  const byQueue = new Map<string, FairEntry[]>()
  for (const j of jobs) {
    assertRegistered(appName, j.jobName)
    await assertAppOnForPayload(appName, j.payload)
    const route = resolveJobQueue(appName, j.jobName)
    const list = byQueue.get(route.queueName) ?? []
    list.push({ name: j.jobName, data: j.payload, opts: buildJobOptions(route, j.opts) })
    byQueue.set(route.queueName, list)
  }
  for (const queueName of byQueue.keys()) assertEnqueueAllowed(queueName)
  await Promise.all([...byQueue].map(([queueName, list]) => fairEnqueue(getQueue(queueName), list)))
  log.debug({ app: appName, count: jobs.length }, "Jobs enqueued in bulk")
}

/** One per-org job of a cron fan-out tick (fanout-runtime.ts). */
export interface FanoutJobEntry {
  name: string
  data: Record<string, unknown>
  /** The BullMQ id itself (`fo.…`), not a deduplication id: an add whose id
   *  exists in any state, finished included, adds nothing. */
  jobId: string
  delay: number
  attempts: number
  backoff: { type: string; delay: number }
  /** How long a finished job (and so its id) is kept. */
  retainMs: number
}

/**
 * Add a fan-out tick's per-org jobs to one queue, in one round trip. No local
 * handler is required: the dispatcher registers an org's app handlers when the
 * job starts (`processJob`). Same backpressure as `enqueueAppJob`. Returns the
 * ids BullMQ answered with (an existing id answers with itself).
 */
export async function addFanoutJobs(
  queueName: string,
  jobs: ReadonlyArray<FanoutJobEntry>,
): Promise<string[]> {
  if (jobs.length === 0) return []
  assertEnqueueAllowed(queueName)
  const added = await fairEnqueue(
    getQueue(queueName),
    jobs.map((j) => ({
      name: j.name,
      data: j.data,
      opts: fanoutJobOptions(j),
    })),
    // Cron runs: counted against the org's job cap when they start, never delayed.
    { scheduled: true },
  )
  return added.map((j) => j.id ?? "")
}

/**
 * A pre-fan-out per-org tick (scheduler `<job>-scheduler-<orgId>`) that fired
 * for `epoch`: its run becomes the fan-out job of that (org, epoch), id
 * `fo.<app>.<job>.<org>.<epoch>`, so the fan-out tick of the same epoch adds
 * nothing more and the epoch is never lost across the upgrade. Returns false
 * when the tick cannot be named that way (no org in the id, a job name the id
 * cannot carry): the caller drops it.
 */
export async function addLegacyTickAsFanoutJob(args: {
  queueName: string
  app: string
  job: string
  schedulerId: string
  epoch: number
  attempts?: number
  backoff?: { type: string; delay: number }
}): Promise<boolean> {
  const orgId = /([0-9a-f-]{36})$/i.exec(args.schedulerId)?.[1]
  if (!orgId) return false
  let jobId: string
  try {
    jobId = fanoutJobId(args.app, args.job, orgId, args.epoch)
  } catch {
    return false
  }
  await addFanoutJobs(args.queueName, [
    {
      name: args.job,
      data: { orgId, _fanout: { app: args.app, job: args.job, epoch: args.epoch } },
      jobId,
      delay: 0,
      attempts: args.attempts ?? 3,
      backoff: args.backoff ?? { type: "exponential", delay: 1000 },
      retainMs: FANOUT_MIN_RETENTION_MS,
    },
  ])
  return true
}

/**
 * Run one job on `queueName`, whose jobs belong to the logical app `appName`.
 * The handler is looked up by `(appName, job.name)`, so the same function
 * serves a class queue, an app queue and the legacy `app-kernel` drain.
 */
/** The part of a BullMQ job the dispatch reads. */
type DispatchedJob = Pick<Job, "id" | "name" | "data" | "attemptsMade" | "repeatJobKey"> &
  Partial<Pick<Job, "timestamp" | "opts" | "processedOn">>

/** Jobs dropped at start because their org was deleted or is being deleted; read by metrics/tests. */
/**
 * The org jobs that still run while a managed org is suspended or closed:
 * its exports (the admins' 30-day window), its deletion and purges,
 * and the cloud billing and reporting jobs. Pinned by a test.
 */
export const SUSPENDED_ORG_EXEMPT_JOBS: ReadonlySet<string> = new Set([
  "org-export",
  "org-export-sweep",
  "org-delete",
  "mailbox-purge",
  "files-delete-object",
  "files-orphan-gc",
  "cloud-usage-report",
  "org-storage-estimate",
  "control-plane-outbox",
  "control-plane-heartbeat",
])

let jobsSkippedOrgSuspended = 0
/** Org jobs skipped because the org was suspended or closed for billing. */
export function jobsSkippedOrgSuspendedCount(): number {
  return jobsSkippedOrgSuspended
}

let jobsDroppedOrgMissing = 0
export function jobsDroppedOrgMissingCount(): number {
  return jobsDroppedOrgMissing
}

/**
 * The scheduler a dropped job came from, removed: a deleted org's routine
 * (or a pre-fan-out per-org cron) would otherwise fire for ever. Its id is BullMQ's `repeatJobKey`.
 * Best-effort: never throws.
 */
async function removeSchedulerOfJob(queueName: string, job: DispatchedJob): Promise<void> {
  const schedulerId = job.repeatJobKey
  if (!schedulerId) return
  try {
    await getQueue(queueName).removeJobScheduler(schedulerId)
  } catch (err) {
    log.warn({ err, queue: queueName, schedulerId }, "Could not remove a deleted org's scheduler")
  }
}

/** Sets a job's org up before its handler is looked up; a seam for tests (`JobsTestAccess.setOrgEnsure`). */
let ensureOrgApps: (orgId: string, trigger?: OrgSetupTrigger) => Promise<void> = awaitOrgApps

/** The registered handler of a dispatched job; throws (BullMQ retries/dead-letters, M-13) when none. */
function lookUpHandler(queueName: string, appName: string, jobName: string): RegisteredHandler {
  const registered = jobHandlers.get(handlerKey(appName, jobName))
  if (!registered) {
    throw new Error(`No handler registered for job: ${queueName}:${jobName}`)
  }
  return registered
}

function processJob(
  queueName: string,
  appName: string,
  job: DispatchedJob,
  signal: AbortSignal = new AbortController().signal,
  fair?: JobFairFrame,
): Promise<void> {
  // The turns the job runs are recorded against it (job-origin.ts, S10), and
  // the fairness token it holds frames the jobs it enqueues (fairness.ts).
  // An org's running job is counted until it settles: a move's freeze waits
  // for the org's to reach zero on every process.
  const orgId = orgOfJobData(job.data)
  const end = orgId ? beginOrgActivity(orgId, "jobs") : null
  return runAsJob(
    jobOriginRef(queueName, job),
    () => processJobInOrigin(queueName, appName, job, signal),
    fair,
  ).finally(() => end?.())
}

/**
 * Test servers only: while this key is set (under the server's REDIS_PREFIX), a
 * scheduler's tick does nothing. A test lane sets it while it builds and
 * snapshots its world (packages/test-helpers/src/e2e-lane.ts), so the world it
 * resets every file to is what the bootstrap and the seed wrote, never also
 * whichever minute sweeps happened to fire before the snapshot (an expiry, the
 * attention materializer, a digest). Every scheduler is a periodic sweep: its
 * next tick does the skipped one's work. Per-request delayed jobs still run.
 */
export const SCHEDULED_TICKS_HELD_KEY = "test:scheduled-ticks-held"

async function scheduledTickHeld(job: DispatchedJob): Promise<boolean> {
  if (!job.repeatJobKey || !isTestEnv()) return false
  return (await appRedis.exists(SCHEDULED_TICKS_HELD_KEY)) === 1
}

async function processJobInOrigin(
  queueName: string,
  appName: string,
  job: DispatchedJob,
  signal: AbortSignal,
): Promise<void> {
  if (await scheduledTickHeld(job)) {
    log.debug(
      { queue: queueName, job: job.name, schedulerId: job.repeatJobKey },
      "scheduled tick held by the test lane",
    )
    return
  }
  // A job without an org looks its handler up now. An org's job looks it up
  // only once the org is set up below (A3): the org's setup registers its app
  // handlers, so a job for an org this process has not registered yet runs.
  // A fan-out job (fanout.ts) frees its org's slot for the next epoch the
  // moment it starts, before any check that may skip it. Read from the BullMQ
  // id only, which no app can choose; job data is never trusted for it.
  await releaseFanoutPending(job.id)
  // A load org's run of the epoch is counted for the load harness's fan-out
  // report (load orgs only, from the same id).
  await countFanoutRun(job.id, job.attemptsMade)
  // A pre-fan-out per-org scheduler's tick (left from before the upgrade, or
  // re-created by an older release during a rolling deploy): its scheduler is
  // removed and its run becomes the fan-out job of the same (org, epoch), which
  // the fan-out tick of that epoch dedups against. Never lost, never doubled.
  if (
    queueName.startsWith("app-") &&
    job.repeatJobKey &&
    LEGACY_PER_ORG_SCHEDULER_RE.test(job.repeatJobKey)
  ) {
    const epoch = fanoutEpochOrUndefined(job)
    const converted =
      epoch !== undefined &&
      (await addLegacyTickAsFanoutJob({
        queueName,
        app: appName,
        job: job.name,
        schedulerId: job.repeatJobKey,
        epoch,
        attempts: job.opts?.attempts,
        backoff:
          typeof job.opts?.backoff === "object" && job.opts.backoff
            ? { type: String(job.opts.backoff.type), delay: Number(job.opts.backoff.delay ?? 1000) }
            : undefined,
      }))
    await removeSchedulerOfJob(queueName, job)
    const legacyField = converted ? "legacy_tick_converted" : "legacy_tick_dropped"
    await countJobMetrics({ [legacyField]: 1, [`${legacyField}:${appName}:${job.name}`]: 1 })
    log.info(
      { queue: queueName, jobId: job.id, schedulerId: job.repeatJobKey, converted },
      "legacy per-org scheduler tick replaced by its fan-out job",
    )
    return
  }
  const firedAt = fanoutEpochOrUndefined(job)
  const orgScoped = typeof job.data?.orgId === "string" && job.data.orgId !== ""
  const orglessHandler = orgScoped ? undefined : lookUpHandler(queueName, appName, job.name)

  log.debug({ worker: queueName, jobId: job.id, jobName: job.name }, "Processing job")

  try {
    const orgId = job.data?.orgId
    if (orgId && typeof orgId === "string") {
      // The per-org migration gate (armOrgMaintenance/disarmOrgMaintenance)
      // must stop every write for this org, not just HTTP traffic: a
      // routine tick, webhook delivery or event-routine job all reach
      // this same chokepoint before any transaction opens, and every one
      // of them writes rows the migration is rekeying. Refuse and let
      // BullMQ retry (with backoff) rather than silently dropping the job
      // or letting it race the migration.
      if (isOrgUnderMaintenance(orgId)) {
        throw new OrgUnderMaintenanceJobError(orgId, queueName, job.name)
      }
      // An org moving to another instance (draining, frozen, incoming or
      // moved): the job is held, never run nor completed (the worker puts it
      // back as delayed). No exemption: unlike a suspended org, every job of
      // a moving org writes rows the move is copying.
      const holdMs = await transferHoldMs(orgId)
      if (holdMs !== null) throw new OrgTransferHeldJobError(orgId, holdMs, queueName, job.name)
      // A deleted org's job can do nothing but fail: dropped quietly, and the
      // scheduler behind it removed. So is the job of an org whose deletion
      // has started (`deleting_at`, modules/org/purge/): it would write into
      // rows the purge is deleting. Fail-closed: an unreadable state throws
      // and BullMQ retries.
      const missing = await isOrgMissingAsync(orgId)
      if (missing || (await isOrgDeletingAsync(orgId))) {
        jobsDroppedOrgMissing++
        log.info(
          { queue: queueName, jobId: job.id, jobName: job.name, app: appName, orgId },
          missing
            ? "job dropped: its org no longer exists"
            : "job dropped: its org is being deleted",
        )
        await removeSchedulerOfJob(queueName, job)
        return
      }
      // A managed org suspended or closed for billing (modules/cloud/
      // suspension.ts): its job is skipped and counted, its scheduler
      // KEPT, so a routine fires again on its next tick after the org pays.
      // Export, deletion, purge and billing jobs still run. A no-op, without
      // a query, on a self-hosted instance. Fail-closed: an unreadable status
      // throws and BullMQ retries.
      if (!SUSPENDED_ORG_EXEMPT_JOBS.has(job.name) && (await orgSuspendedOrClosed(orgId))) {
        jobsSkippedOrgSuspended++
        log.info(
          { queue: queueName, jobId: job.id, jobName: job.name, app: appName, orgId },
          "job skipped: the org is suspended",
        )
        return
      }
      // The workers start before every org's apps are registered (index.ts):
      // a job for an org still registering waits for it, ahead of the others,
      // so it runs with the org's full app state. A failure throws and BullMQ
      // retries the job.
      // A scheduler-made job (a BullMQ job scheduler's tick, or a cron
      // fan-out's per-org job `fo.…`) counts against the org's job cap in the
      // hour it starts; it is never delayed (org-job-cap.ts). First attempt only.
      if ((job.repeatJobKey || job.id?.startsWith("fo.")) && (job.attemptsMade ?? 0) === 0) {
        await countScheduledOrgJob({ orgId, queueName, jobName: job.name })
      }
      // An app turned Off (or removed) for the org runs no job or cron (S19,
      // A6): a queued or due run is skipped here, at its start; one already
      // executing finishes. The scheduler stays, so re-enabling resumes the
      // cron with no re-registration. Fail-closed: an unreadable state throws
      // and BullMQ retries rather than running the job. Checked from the
      // org's persisted app rows (already loaded by the gates above) BEFORE
      // the org is set up: a skipped job must not set an idle org up in this
      // process (its apps, handlers and sandbox state stay unloaded).
      const isKernelQueue = isKernelApp(appName)
      if (!isKernelQueue && !(await isAppActiveForOrgAsync(orgId, appName))) {
        jobsSkippedAppDisabled++
        log.info(
          { queue: queueName, jobId: job.id, jobName: job.name, app: appName, orgId },
          "job skipped: the app is Off for the org",
        )
        return
      }
      // The job is the setup's trigger when its queue time is known.
      await ensureOrgApps(
        orgId,
        job.timestamp != null
          ? { kind: "job", id: `${queueName}:${job.id}`, queuedAt: job.timestamp }
          : undefined,
      )
      const registered = lookUpHandler(queueName, appName, job.name)
      const handlerFn = registered.handler
      // Re-checked after the setup: registering the org's apps may write the
      // app's first row (an app off by default for the org).
      if (!isKernelQueue && !(await isAppActiveForOrgAsync(orgId, appName))) {
        jobsSkippedAppDisabled++
        log.info(
          { queue: queueName, jobId: job.id, jobName: job.name, app: appName, orgId },
          "job skipped: the app is Off for the org",
        )
        return
      }
      if (isKernelQueue) {
        // Kernel jobs manage their own DB access — no handler reads the
        // previously injected `_tx` (verified across kernel-jobs.ts,
        // webhook-worker, subrun-worker, files jobs, search drift), so
        // wrapping the whole handler in withPrivilegedDb only pinned a
        // pool connection "idle in transaction" for the handler's entire
        // duration. For routine ticks (≤15 min) and agent sub-runs that
        // meant one starved slot per concurrent agent — the recurring
        // staging pool-exhaustion outages. Handlers open short-lived
        // withRlsContext/withPrivilegedDb transactions themselves as
        // needed.
        await handlerFn(job.data, { signal, firedAt, activeAt: job.processedOn })
      } else {
        const jobAppName = appName
        const actingUserId: string | undefined = job.data?._userId

        if (actingUserId) {
          // Job was triggered by a user action — run with that user's scopes
          const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
          const perms = await withPrivilegedDb(orgId, `job-load-perms:${job.name}`, (pdb) =>
            loadEffectivePermissions(pdb, actingUserId, orgId),
          )
          // `_callerScopes` must be explicitly provided by the enqueueing
          // call — a missing or non-array value is treated as "no scopes
          // declared", not as "full user permissions". This prevents an
          // absent snapshot from silently granting the job the user's
          // entire permission set (which would be broader than intended
          // for an app-scoped background job).
          const hasDeclaredScopes = Array.isArray(job.data?._callerScopes)
          const snapshotScopes = hasDeclaredScopes
            ? (job.data._callerScopes as unknown[]).filter(
                (scope): scope is string => typeof scope === "string",
              )
            : []
          const { scopes, droppedScopes } = resolveJobScopes({
            appName: jobAppName,
            jobName: job.name,
            hasDeclaredScopes,
            snapshotScopes,
            userScopes: perms.scopes,
          })
          if (droppedScopes.length > 0) {
            log.warn(
              {
                worker: queueName,
                jobId: job.id,
                jobName: job.name,
                userId: actingUserId,
                droppedScopes,
                runningWith: scopes,
              },
              "Job scope snapshot narrowed to the user's effective scopes",
            )
          }
          // Background `jobs` pool either way: an ambient transaction stays
          // open for the whole handler run (incl. sandboxed network I/O);
          // a session opens short per-call transactions on that same pool.
          await dispatchAppJobWithContext(
            handlerFn,
            job.data,
            {
              actorType: "user",
              userId: actingUserId,
              orgId,
              scopes,
              dimensionGrants: perms.dimensionGrants,
            },
            registered.txMode,
            undefined,
            signal,
          )
        } else {
          // System-initiated job (cron, etc.) — app scopes only
          await dispatchAppJobWithContext(
            handlerFn,
            job.data,
            { actorType: "system", orgId, purpose: "job", scopes: [`${jobAppName}:*`] },
            registered.txMode,
            undefined,
            signal,
          )
        }
      }
    } else {
      const { handler } = orglessHandler ?? lookUpHandler(queueName, appName, job.name)
      await handler(job.data, { signal, firedAt, activeAt: job.processedOn })
    }
  } catch (err) {
    // The workspace has no connected account for a connection the job needs
    // (never connected, or disconnected): there is nothing to do until one is
    // connected, and a retry cannot change that. A quiet no-op, not an error
    // logged and retried on every tick in every such workspace. A failure with
    // an account (an expired token, a provider error) is not this error and
    // still fails loudly below.
    if (isNoConnectedAccountError(err)) {
      log.info(
        {
          queue: queueName,
          jobId: job.id,
          jobName: job.name,
          app: appName,
          orgId: job.data?.orgId,
          reason: err instanceof Error ? err.message : String(err),
        },
        "job skipped: no connected account for its connection",
      )
      return
    }
    // A handler that asked to run later (a lock held by another run) did nothing
    // wrong: warn, and still throw so the queue retries it. Its last attempt
    // failing logs at error ("Job exhausted all retries").
    if (err instanceof JobRetryLaterError) {
      log.warn(
        {
          worker: queueName,
          jobId: job.id,
          jobName: job.name,
          attempt: job.attemptsMade,
          reason: "retry_later",
          waitingOn: err.waitingOn,
          message: err.message,
        },
        "Job deferred: retrying later",
      )
      throw err
    }
    log.error(
      { err, worker: queueName, jobId: job.id, attempt: job.attemptsMade },
      "Job handler error",
    )
    throw err // Let BullMQ handle retry
  }
}

/** A scheduler template's priority option: the class priority at its fairness tier start. */
function schedulerPriorityOpt(route: JobRoute): { priority?: number } {
  const priority = schedulerPriority(route.queueName, route.priority)
  return priority ? { priority } : {}
}

/** Scheduled jobs whose payload carries no org: cross-org sweeps (the transfer hold cannot key on them). */
const orglessScheduledJobs = new Set<string>()

/** `app:job` keys of the registered scheduled jobs without an org in their payload. */
export function listOrglessScheduledJobs(): string[] {
  return [...orglessScheduledJobs].sort()
}

export async function registerScheduledJob(
  appName: string,
  jobName: string,
  cron: string,
  handler: (payload: any) => Promise<void>,
  opts?: {
    attempts?: number
    backoff?: { type: string; delay: number }
    /** IANA timezone for the cron pattern (e.g. "America/Toronto"). */
    tz?: string
    /** Explicit scheduler id; defaults to `${jobName}-scheduler`. Used for
     *  per-instance schedulers (e.g. one per routine). */
    schedulerId?: string
    /** Additional payload merged into the scheduled job's `data`. */
    data?: Record<string, unknown>
    /** DB-context mode for the handler — see registerJobWorker / job-context.ts. */
    txMode?: JobTxMode
  },
): Promise<string> {
  registerJobWorker(appName, jobName, handler, { txMode: opts?.txMode })
  const scheduledOrgId = opts?.data?.orgId
  if (typeof scheduledOrgId !== "string" || scheduledOrgId === "") {
    orglessScheduledJobs.add(handlerKey(appName, jobName))
  }
  const route = resolveJobQueue(appName, jobName)
  const queue = getQueue(route.queueName)

  const data: Record<string, unknown> = { ...(opts?.data ?? {}) }
  // One scheduler per id: a kernel cron, or one per routine. An app's manifest
  // schedule is never one per org: it fans out (fanout.ts).
  const schedulerId = opts?.schedulerId ?? `${jobName}-scheduler`

  await queue.upsertJobScheduler(
    schedulerId,
    { pattern: cron, ...(opts?.tz ? { tz: opts.tz } : {}) },
    {
      name: jobName,
      data,
      opts: {
        attempts: opts?.attempts ?? 3,
        backoff: opts?.backoff ?? { type: "exponential", delay: 1000 },
        ...schedulerPriorityOpt(route),
      },
    },
  )

  log.info(
    {
      app: appName,
      jobName,
      cron,
      tz: opts?.tz,
      schedulerId,
    },
    "Scheduled job registered",
  )
  return schedulerId
}

const ORG_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Remove every job scheduler that belongs to `orgId`, on every queue: the ones
 * whose id carries the org's uuid (per-routine ids, pre-fan-out per-org ids) and
 * the ones whose job data names the org. For an org being deleted: its
 * schedulers would otherwise keep firing jobs for an org that no longer
 * exists. The queues are found in Redis (a scheduler's queue has a `repeat`
 * set), so a queue this process never bound is covered too. The uuid is
 * unique, so no other tenant's scheduler matches. Returns the count removed.
 */
export async function removeOrgJobSchedulers(orgId: string): Promise<number> {
  if (!ORG_UUID_RE.test(orgId)) throw new Error("removeOrgJobSchedulers: not an org uuid")
  let removed = 0
  for (const { queue, id } of await listOrgJobSchedulers(orgId)) {
    if (await getQueue(queue).removeJobScheduler(id)) removed += 1
  }
  if (removed > 0) log.info({ orgId, removed }, "Removed a deleted org's job schedulers")
  return removed
}

/** Every queue that has a key of `suffix` (`repeat` zset, `meta` hash) in Redis. */
async function queueNamesWith(
  suffix: ":repeat" | ":meta",
  type: "zset" | "hash",
): Promise<string[]> {
  const queueNames = new Set<string>()
  let cursor = "0"
  do {
    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      `${bullPrefix}:*${suffix}`,
      "COUNT",
      // A whole-keyspace walk (an org purge runs it once per org): see
      // PURGE_SCAN_COUNT in org/purge/external.ts for why it is large.
      5000,
      "TYPE",
      type,
    )
    cursor = next
    for (const key of keys) queueNames.add(key.slice(bullPrefix.length + 1, -suffix.length))
  } while (cursor !== "0")
  return [...queueNames]
}

/**
 * The org's job schedulers on every queue (see `removeOrgJobSchedulers`): an id
 * carrying the org uuid, or a template whose data names the org.
 */
export async function listOrgJobSchedulers(
  orgId: string,
): Promise<Array<{ queue: string; id: string }>> {
  if (!ORG_UUID_RE.test(orgId)) throw new Error("listOrgJobSchedulers: not an org uuid")
  const out: Array<{ queue: string; id: string }> = []
  for (const queueName of await queueNamesWith(":repeat", "zset")) {
    for (const s of await getQueue(queueName).getJobSchedulers(0, -1)) {
      const id = s.key ?? s.id ?? ""
      const data = s.template?.data as { orgId?: unknown } | undefined
      if (id.includes(orgId) || data?.orgId === orgId) out.push({ queue: queueName, id })
    }
  }
  return out
}

/** At most this many waiting jobs per queue are read by `listOrgQueuedJobs`. */
const ORG_QUEUED_JOBS_SCAN = 1000

/**
 * Jobs still queued (waiting, delayed, prioritized) whose data names the
 * org, on every queue. Diagnostic (the org purge's residue scan): they are not
 * removed, the dispatch drops them (a job hash removed from under a queue
 * leaves its id dangling for every other tenant). Reads at most
 * `ORG_QUEUED_JOBS_SCAN` jobs per queue.
 */
export async function listOrgQueuedJobs(
  orgId: string,
  opts: { scan?: number } = {},
): Promise<{
  jobs: Array<{ queue: string; id: string; name: string }>
  /** Queues whose page came back full: the org may have more jobs there. */
  truncatedQueues: string[]
}> {
  if (!ORG_UUID_RE.test(orgId)) throw new Error("listOrgQueuedJobs: not an org uuid")
  const scan = opts.scan ?? ORG_QUEUED_JOBS_SCAN
  const jobs: Array<{ queue: string; id: string; name: string }> = []
  const truncatedQueues: string[] = []
  for (const queueName of await queueNamesWith(":meta", "hash")) {
    const page = await getQueue(queueName).getJobs(
      ["waiting", "delayed", "prioritized"],
      0,
      scan - 1,
    )
    if (page.length >= scan) truncatedQueues.push(queueName)
    for (const job of page) {
      if ((job?.data as { orgId?: unknown } | undefined)?.orgId === orgId) {
        jobs.push({ queue: queueName, id: String(job.id), name: job.name })
      }
    }
  }
  if (truncatedQueues.length > 0) {
    log.warn(
      { orgId, truncatedQueues, scan },
      "listOrgQueuedJobs: some queues hold more waiting jobs than were read; the org's list may be incomplete",
    )
  }
  return { jobs, truncatedQueues }
}

// ── Org jobs on a move (modules/org/transfer/) ────────────────────

/** One queued job of an org as a move carries it to the target. */
export interface TransferredJob {
  queue: string
  id: string
  name: string
  data: unknown
  /** Ms until it is due (0: due now). */
  delayMs: number
  attempts: number | null
  backoff: unknown
  priority: number | null
  /** Its logical (deduplication) id, kept so the target dedups as the source did. */
  dedupId: string | null
}

/** One job scheduler of an org as a move carries it. */
export interface TransferredScheduler {
  queue: string
  id: string
  name: string
  pattern: string | null
  every: number | null
  tz: string | null
  data: unknown
  opts: Record<string, unknown>
}

/** Above this many queued jobs the org's move is refused (paged to the end, never cut). */
export const TRANSFER_MAX_JOBS = 50_000
/**
 * Every list and set a queued job sits in. BullMQ moves a job between them in
 * one script, so at any instant each job id is in exactly one of them.
 */
const TRANSFER_JOB_LISTS = [
  "wait",
  "paused",
  "prioritized",
  "delayed",
  "active",
  "waiting-children",
]
/** One script call returns every id of the queue's lists, read in one atomic step. */
const QUEUE_IDS_SCRIPT = `
local out = {}
for _, k in ipairs(KEYS) do
  local t = redis.call('TYPE', k)['ok']
  if t == 'list' then
    for _, id in ipairs(redis.call('LRANGE', k, 0, -1)) do out[#out + 1] = id end
  elseif t == 'zset' then
    for _, id in ipairs(redis.call('ZRANGE', k, 0, -1)) do out[#out + 1] = id end
  end
end
return out`
const TRANSFER_JOB_FETCH = 1000

export class TransferJobsRefused extends Error {
  constructor(message: string) {
    super(`org transfer jobs: ${message}`)
    this.name = "TransferJobsRefused"
  }
}

/**
 * Every queued job (waiting, paused, prioritized, delayed, active, waiting
 * for children; every queue, read whole) and every job scheduler of the org, for the target to re-add after
 * the commit. Jobs a scheduler made are left out (the scheduler makes them
 * again on the target). Read only. Refuses past `TRANSFER_MAX_JOBS` rather
 * than carry a cut list.
 */
export async function exportOrgJobs(
  orgId: string,
  opts: { now?: number; maxJobs?: number } = {},
): Promise<{ jobs: TransferredJob[]; schedulers: TransferredScheduler[] }> {
  if (!ORG_UUID_RE.test(orgId)) throw new Error("exportOrgJobs: not an org uuid")
  const now = opts.now ?? Date.now()
  const max = opts.maxJobs ?? TRANSFER_MAX_JOBS
  const queueNames = await queueNamesWith(":meta", "hash")
  // A moving org's jobs churn (a worker picks each one up and puts it back as
  // delayed every few seconds), so a paged read of the lists one after another
  // can miss a job in transit. The ids of each queue are read in ONE script
  // instead: BullMQ moves a job between its lists atomically too, so that read
  // holds every job of the queue exactly once. A job's payload never changes,
  // so the org's jobs are then picked out and read outside the script.
  const found = new Map<string, TransferredJob>()
  for (const queueName of queueNames) {
    const ids = (await redis.eval(
      QUEUE_IDS_SCRIPT,
      TRANSFER_JOB_LISTS.length,
      ...TRANSFER_JOB_LISTS.map((l) => `${bullPrefix}:${queueName}:${l}`),
    )) as string[]
    const queue = getQueue(queueName)
    for (let i = 0; i < ids.length; i += TRANSFER_JOB_FETCH) {
      const chunk = ids.slice(i, i + TRANSFER_JOB_FETCH)
      const pipe = redis.pipeline()
      for (const id of chunk) pipe.hget(`${bullPrefix}:${queueName}:${id}`, "data")
      const datas = (await pipe.exec()) ?? []
      for (let j = 0; j < chunk.length; j++) {
        const raw = datas[j]?.[1]
        // A cheap filter first: only a payload naming the org is parsed.
        if (typeof raw !== "string" || !raw.includes(orgId)) continue
        const id = chunk[j] as string
        const job = await queue.getJob(id)
        if (!job || (job.data as { orgId?: unknown } | undefined)?.orgId !== orgId) continue
        const key = `${queueName}\u0000${job.id}`
        if (found.has(key)) continue
        let due = (job.timestamp ?? now) + (job.delay ?? 0)
        if (job.repeatJobKey) {
          // A job a scheduler made. The tick the scheduler already made for
          // the future is left out: the target's scheduler makes it again.
          // A tick that fell due while the org was moving (held, never run)
          // is carried and runs once on the target: its fire time is the
          // last part of its id.
          const fire = Number(String(job.id).split(":").pop())
          if (!Number.isFinite(fire) || fire > now) continue
          due = now
        }
        if (found.size >= max) {
          throw new TransferJobsRefused(`the org has more than ${max} queued jobs`)
        }
        const dedup = (job.opts as { deduplication?: { id?: unknown } }).deduplication?.id
        found.set(key, {
          queue: queueName,
          id: String(job.id),
          name: job.name,
          data: job.data,
          delayMs: Math.max(0, due - now),
          attempts: job.opts.attempts ?? null,
          backoff: job.opts.backoff ?? null,
          priority: job.opts.priority ?? null,
          dedupId: typeof dedup === "string" ? dedup : null,
        })
      }
    }
  }
  const jobs = [...found.values()]
  const schedulers: TransferredScheduler[] = []
  for (const queueName of await queueNamesWith(":repeat", "zset")) {
    for (const s of await getQueue(queueName).getJobSchedulers(0, -1)) {
      const id = s.key ?? s.id ?? ""
      const data = s.template?.data as { orgId?: unknown } | undefined
      if (!id.includes(orgId) && data?.orgId !== orgId) continue
      schedulers.push({
        queue: queueName,
        id,
        name: s.name,
        pattern: s.pattern ?? null,
        every: s.every ?? null,
        tz: s.tz ?? null,
        data: s.template?.data ?? {},
        opts: (s.template?.opts ?? {}) as Record<string, unknown>,
      })
    }
  }
  return { jobs, schedulers }
}

/** The BullMQ id a carried job gets on the target (no ':' allowed in custom ids). */
export function transferredJobId(transferId: string, id: string): string {
  return `xfer-${transferId}-${id.replace(/[^A-Za-z0-9_.-]/g, "_")}`
}

/**
 * Re-add the carried jobs and schedulers on this instance (the target, after
 * the commit). Every job keeps an id derived from the transfer and its source
 * id (an add whose id exists adds nothing). A job can still be added twice
 * once it ran and was evicted, and a re-upsert brings back a deleted
 * scheduler, so a caller that may call again passes `track`: what an earlier
 * call added is skipped.
 */
export async function readdOrgJobs(
  transferId: string,
  carried: { jobs: TransferredJob[]; schedulers: TransferredScheduler[] },
  track: {
    /** Keys (`readdedKey`) an earlier call already added: skipped. */
    added?: ReadonlySet<string>
    /** Told the keys of what was just added, before the next is added. */
    onAdded?: (keys: string[]) => Promise<void>
  } = {},
): Promise<{ jobs: number; schedulers: number }> {
  const skip = (key: string) => track.added?.has(key) === true
  let schedulers = 0
  for (const s of carried.schedulers) {
    const key = readdedKey("scheduler", s.queue, s.id)
    if (skip(key)) continue
    schedulers += 1
    await getQueue(s.queue).upsertJobScheduler(
      s.id,
      {
        ...(s.pattern ? { pattern: s.pattern } : {}),
        ...(s.every ? { every: s.every } : {}),
        ...(s.tz ? { tz: s.tz } : {}),
      },
      { name: s.name, data: s.data, opts: s.opts as JobsOptions },
    )
    await track.onAdded?.([key])
  }
  const byQueue = new Map<string, FairEntry[]>()
  const keysOf = new Map<string, string[]>()
  let jobs = 0
  for (const j of carried.jobs) {
    const key = readdedKey("job", j.queue, j.id)
    if (skip(key)) continue
    jobs += 1
    keysOf.set(j.queue, [...(keysOf.get(j.queue) ?? []), key])
    const list = byQueue.get(j.queue) ?? []
    list.push({
      name: j.name,
      data: j.data,
      opts: {
        jobId: transferredJobId(transferId, j.id),
        ...(j.dedupId ? { deduplication: { id: j.dedupId } } : {}),
        ...(j.priority ? { priority: j.priority } : {}),
        attempts: j.attempts ?? 3,
        backoff: (j.backoff as JobsOptions["backoff"]) ?? { type: "exponential", delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 1000,
        ...(j.delayMs > 0 ? { delay: j.delayMs } : {}),
      },
    })
    byQueue.set(j.queue, list)
  }
  for (const [queueName, list] of byQueue) {
    // Re-added jobs already passed the cap where they were made: never delayed again.
    await fairEnqueue(getQueue(queueName), list, { scheduled: true })
    await track.onAdded?.(keysOf.get(queueName) ?? [])
  }
  log.info({ transferId, jobs, schedulers }, "org transfer: jobs and schedulers re-added")
  return { jobs, schedulers }
}

/** What `readdOrgJobs` reports as added, to skip it on a later call. */
export function readdedKey(kind: "job" | "scheduler", queue: string, id: string): string {
  return `${kind}:${queue}:${id}`
}

/**
 * Remove the carried jobs and the org's schedulers from this instance (the
 * source, after the commit: they run on the target now). A job no longer
 * there is skipped; a job of the org enqueued after the export is left (the
 * `moved` org holds it and the hold's purge drops it).
 */
export async function removeTransferredJobs(
  orgId: string,
  carried: { jobs: Array<Pick<TransferredJob, "queue" | "id">> },
): Promise<{ jobs: number; schedulers: number }> {
  // Schedulers first: BullMQ refuses to remove a job a scheduler made while
  // its scheduler exists (a carried, held tick).
  const schedulers = await removeOrgJobSchedulers(orgId)
  let jobs = 0
  for (const j of carried.jobs) {
    const queue = getQueue(j.queue)
    const job = await queue.getJob(j.id)
    if (!job || (job.data as { orgId?: unknown } | undefined)?.orgId !== orgId) continue
    await job.remove()
    await forgetFairJob(queue.name, orgId, job.id)
    jobs += 1
  }
  return { jobs, schedulers }
}

/** Remove a previously-registered scheduler by its id. Safe to call for
 *  non-existent ids (BullMQ no-ops). A kernel scheduler is also removed from
 *  the legacy `app-kernel` queue, in case the boot migration has not moved it. */
export async function removeScheduledJob(
  appName: string,
  jobName: string,
  schedulerId: string,
): Promise<void> {
  await getJobQueue(appName, jobName).removeJobScheduler(schedulerId)
  if (isKernelApp(appName)) await getLegacyKernelQueue().removeJobScheduler(schedulerId)
  log.info({ app: appName, jobName, schedulerId }, "Scheduled job removed")
}

/**
 * Upsert a BullMQ scheduler without (re)registering a worker handler.
 *
 * Used by routines: the routine worker handler is owned by Phase 5's boot
 * registration (one shared `registerJobWorker("kernel","routine-tick", …)`),
 * but per-routine scheduler upserts happen at CRUD time. Mixing those via
 * `registerScheduledJob` would re-set the handler each time and would race
 * with the boot registration.
 */
export async function upsertJobScheduler(
  appName: string,
  jobName: string,
  cron: string,
  opts: {
    attempts?: number
    backoff?: { type: string; delay: number }
    orgId?: string
    tz?: string
    schedulerId: string
    data?: Record<string, unknown>
  },
): Promise<void> {
  const route = resolveJobQueue(appName, jobName)
  const queue = getQueue(route.queueName)
  const data: Record<string, unknown> = {
    ...(opts.orgId ? { orgId: opts.orgId } : {}),
    ...(opts.data ?? {}),
  }
  await queue.upsertJobScheduler(
    opts.schedulerId,
    { pattern: cron, ...(opts.tz ? { tz: opts.tz } : {}) },
    {
      name: jobName,
      data,
      opts: {
        attempts: opts.attempts ?? 3,
        backoff: opts.backoff ?? { type: "exponential", delay: 1000 },
        ...schedulerPriorityOpt(route),
      },
    },
  )
  log.info(
    { app: appName, jobName, cron, tz: opts.tz, schedulerId: opts.schedulerId },
    "Scheduler upserted (handler unchanged)",
  )
}

/**
 * The live job holding a logical id, if any: the one its deduplication key
 * names, or one enqueued before deduplication under the id itself (older
 * builds used the id, base64-wrapped when it held a ':', as the BullMQ id).
 */
async function findJobByLogicalId(queue: Queue, jobId: string): Promise<Job | undefined> {
  const current = await queue.getDeduplicationJobId(jobId)
  const job = current ? await queue.getJob(current) : undefined
  return job ?? (await queue.getJob(encodeLegacyJobId(jobId)))
}

/**
 * Remove a single app job by its (logical) job id — used to tear down a
 * one-shot delayed job before re-enqueuing it for a new `runAt`, or when the
 * routine is deleted / disabled / flipped to recurring. Safe to call for a
 * non-existent id (no-ops). A kernel job is looked for in the legacy queue too.
 */
export async function removeAppJob(appName: string, jobName: string, jobId: string): Promise<void> {
  const candidates = [getJobQueue(appName, jobName)]
  if (isKernelApp(appName)) candidates.push(getLegacyKernelQueue())
  for (const queue of candidates) {
    const existing = await findJobByLogicalId(queue, jobId)
    if (existing) {
      await existing.remove()
      await forgetFairJob(queue.name, orgOfJobData(existing.data), existing.id)
      log.debug({ queue: queue.name, jobId }, "App job removed")
    }
  }
}

/**
 * Backlog and oldest-runnable age of every kernel class queue, the legacy
 * drain and every app queue this process knows, for /diag (queue-health.ts).
 */
export async function getQueueHealth(): Promise<QueueHealth[]> {
  return readQueueHealth(redis, diagQueueNames([...queues.keys(), ...queueBindings.keys()]))
}

/** Every job scheduler on the queues this process knows (S15: one per kernel cron, routine and fan-out (app, job)). */
export async function getJobSchedulerTotal(): Promise<number> {
  const names = diagQueueNames([...queues.keys(), ...queueBindings.keys()])
  const counts = await Promise.all(names.map((n) => getQueue(n).getJobSchedulersCount()))
  return counts.reduce((a, b) => a + b, 0)
}

/**
 * The job drain (lib/shutdown.ts, S9 step 5, A16):
 *   t0         no job starts any more (a fetch already in flight goes back
 *              unrun) and every worker stops fetching while its active jobs
 *              run on;
 *   drain      those jobs get SHUTDOWN_JOB_DRAIN_MS from t0. Past it, each one
 *              still running is aborted (ctx.signal); a processor that settles
 *              within 2 s puts its job back on the queue (the worker callback);
 *   hand-back  a job whose processor ignored the abort stays active under the
 *              lock this process keeps renewing, so no other worker runs it
 *              while it still runs here. Once Postgres is closed (the job can
 *              no longer write) and just before Redis closes and the process
 *              exits, it is moved back to wait: no attempt spent, no stall.
 */
export function registerJobShutdownPhases(): void {
  let closes: Promise<unknown>[] = []
  registerShutdownPhase({
    name: "jobs-stop-fetching",
    at: "t0",
    run: () => {
      closingQueues = true
      publishJobSlots()
      // Worker.close resolves once the worker's active jobs have finished; a
      // later close returns the same promise, so this is the only one.
      closes = [...workers.entries()].map(([name, worker]) =>
        worker.close(false).catch((err) => log.warn({ worker: name, err }, "Worker close failed")),
      )
    },
  })
  const { jobDrainMs } = shutdownBudgets()
  registerShutdownPhase({
    name: "jobs-drain",
    at: "after-drain",
    order: SHUTDOWN_ORDER.drain,
    deadlineMs: jobDrainMs + JOB_ABORT_SETTLE_MS + JOB_QUEUE_CLOSE_MS + 1_000,
    run: async () => {
      const budget = Math.max(0, shutdownBudgets().jobDrainMs - msSinceShutdownBegan())
      const drained = await raceTimeout(Promise.all(closes), budget)
      const running = [...inFlightJobs.values()]
      if (!drained && running.length > 0) {
        for (const r of running) r.abort.abort()
        await raceTimeout(Promise.all(running.map((r) => r.settled)), JOB_ABORT_SETTLE_MS)
        const stillRunning = [...inFlightJobs.values()].map((r) => r.job.name)
        log.warn(
          { aborted: running.map((r) => r.job.name), stillRunning, budgetMs: budget },
          "Job drain budget spent: running jobs aborted; those still running go back at exit",
        )
      }
      await raceTimeout(
        Promise.all([...queues.values()].map((q) => q.close().catch(() => {}))),
        JOB_QUEUE_CLOSE_MS,
      )
      log.info({ claimedWhileDraining, bouncedWhileDraining }, "Job drain done")
    },
  })
  registerShutdownPhase({
    name: "jobs-hand-back",
    at: "after-drain",
    order: SHUTDOWN_ORDER.jobHandBack,
    deadlineMs: AFTER_DRAIN_DEADLINE_MS.jobHandBack,
    run: async () => {
      // Only processors that have not settled: a settled one's callback is
      // finishing (or delaying) its job itself.
      const unsettled = [...inFlightJobs.entries()].filter(([, r]) => !r.done)
      for (const [key] of unsettled) inFlightJobs.delete(key)
      const handed: string[] = []
      await Promise.all(
        unsettled.map(async ([, entry]) => {
          entry.handedBack = true
          try {
            const code = await entry.job.moveToWait(entry.token)
            if (code < 0) throw new Error(`moveJobFromActiveToWait returned ${code}`)
            handed.push(entry.job.name)
          } catch (err) {
            log.warn(
              { jobId: entry.job.id, jobName: entry.job.name, err },
              "Could not hand a running job back; BullMQ's stalled check recovers it",
            )
          }
          // Before Redis closes: the token goes with the job.
          await releaseFairToken(entry.job.queueName, entry.fair)
        }),
      )
      stopTokenRenewal()
      if (handed.length > 0) {
        log.warn({ jobs: handed }, "Jobs still running at exit handed back to their queues")
      }
    },
  })
}

function raceTimeout(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function noop(): void {}

export async function closeAllQueues(): Promise<void> {
  // Close in PARALLEL under a hard deadline. A worker's close — graceful OR
  // force — can stall 13-14s on its blocking Redis poll (measured with the
  // app fleet registered), so the old sequential `await worker.close()` loop
  // made shutdown O(workers): 50s+ in tests (every 5s afterAll hook timed
  // out) and past any container stop-timeout in prod, where the process gets
  // SIGKILLed mid-drain anyway. Racing the whole close against a deadline
  // formalizes that reality: stragglers keep their connections until the
  // process exits. A job they were running was handed back to its queue first
  // (handBackInFlightJobs), so the next boot runs it at once; one this process
  // could not hand back (killed, Redis gone) is recovered by BullMQ's
  // stalled-job detection, the guarantee a container stop already provides. Tests get a short deadline because their teardown
  // hooks also drop schemas and sandbox pools inside the same 5s budget.
  const DEADLINE_MS = isTestEnv() ? 2_000 : 20_000
  closingQueues = true
  publishJobSlots()
  const closes = [
    ...[...workers.entries()].map(([name, worker]) =>
      worker.close(true).catch((err) => log.warn({ worker: name, err }, "Worker close failed")),
    ),
    ...[...queues.values()].map((queue) =>
      queue.close().catch((err) => log.warn({ err }, "Queue close failed")),
    ),
  ]
  const finished = await Promise.race([
    Promise.all(closes).then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), DEADLINE_MS)),
  ])
  if (!finished) {
    log.warn(
      { workers: workers.size, queues: queues.size, deadlineMs: DEADLINE_MS },
      "Queue shutdown exceeded deadline — leaving stragglers to die with the process",
    )
  }
  // After the close, so no worker of this process fetches the job again.
  await handBackInFlightJobs()
  stopTokenRenewal()
  closingQueues = false
  workers.clear()
  queues.clear()
  jobHandlers.clear()
  queueBindings.clear()
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const JobsTestAccess = {
  /** Shorten a long timer's hop (default TIMER_HOP_MAX_MS) so a test sees several. */
  setTimerHopMaxMs(ms: number = TIMER_HOP_MAX_MS): void {
    timerHopMaxMs = ms
  },

  /** Run one job through the worker's dispatch (gates included), as a BullMQ worker would.
   *  `repeatJobKey`: the scheduler the job came from, as BullMQ sets it; `id`: its BullMQ id. */
  processJob(
    appName: string,
    jobName: string,
    data: unknown,
    queueName = "test",
    repeatJobKey?: string,
    id = `test-${Date.now()}`,
  ): Promise<void> {
    return processJob(queueName, appName, {
      id,
      name: jobName,
      data,
      attemptsMade: 0,
      repeatJobKey,
    })
  },

  /** The handler registered for (app, job), exactly as a worker would run it. */
  getHandler(appName: string, jobName: string): ((payload: any) => Promise<void>) | undefined {
    return jobHandlers.get(handlerKey(appName, jobName))?.handler
  },

  /** The live job holding a logical id on a logical job's queue (see `enqueueAppJob`). */
  findJob(appName: string, jobName: string, jobId: string): Promise<Job | undefined> {
    return findJobByLogicalId(getJobQueue(appName, jobName), jobId)
  },

  /**
   * The worker's caller-scope resolution (snapshot x the user's effective
   * scopes). Exposed so the intersection rules can be asserted without standing
   * up Redis, a BullMQ worker and the permissions tables. Not part of the
   * public API.
   */
  resolveJobScopes(args: {
    appName: string
    jobName: string
    hasDeclaredScopes: boolean
    snapshotScopes: string[]
    userScopes: string[]
  }): { scopes: string[]; droppedScopes: string[] } {
    return resolveJobScopes(args)
  },

  /**
   * Test-only accessor for the live BullMQ `Worker` instance backing an app's
   * queue. Used to assert the worker has its `'error'` connection-error listener
   * attached (an `'error'` emission with no listener throws under EventEmitter
   * semantics and floats as an unhandled error). Not part of the public API.
   */
  getWorker(appName: string, jobName?: string): Worker | undefined {
    return workers.get(jobName ? resolveJobQueue(appName, jobName).queueName : `app-${appName}`)
  },

  /** Whether this process consumes a physical queue (bound, hosted or not). */
  isQueueBound(queueName: string): boolean {
    return queueBindings.has(queueName)
  },

  /**
   * Plan the kernel slots against a privileged pool of `poolMax` instead of
   * this process's planned one (`undefined` replans from the pool plan).
   * Applies to queues bound after the call. A test of a nested sub-run chain
   * needs the default plan's agent slots, which the sharded unit runner's
   * small pool (DB_POOL_MAX=8) scales down to one.
   */
  setKernelSlotPool(poolMax: number | undefined): void {
    kernelSlotPlan =
      poolMax === undefined
        ? null
        : planKernelSlots(parseConcurrencyOverrides(env.JOB_QUEUE_CONCURRENCY), poolMax)
  },

  /** Forget one queue binding, as a process that never bound it (no Worker is closed). */
  forgetQueueBinding(queueName: string): void {
    queueBindings.delete(queueName)
  },

  /** The live Worker of a physical queue (a kernel class queue, the legacy drain). */
  getWorkerForQueue(queueName: string): Worker | undefined {
    return workers.get(queueName)
  },

  /** Replace the dispatcher's org setup (`awaitOrgApps`); `undefined` restores it. */
  setOrgEnsure(fn: ((orgId: string) => Promise<void>) | undefined): void {
    ensureOrgApps = fn ?? awaitOrgApps
  },

  /**
   * Forget this process's workers, queues and running jobs without closing or
   * handing back anything, as an exit leaves them in Redis, so the next
   * registration acts as a new process. The forgotten workers keep running.
   */
  forgetProcess(): void {
    workers.clear()
    queues.clear()
    inFlightJobs.clear()
    jobHandlers.clear()
    queueBindings.clear()
    closingQueues = false
  },

  /** Make this process a non-host again (as a CLI or seed process starts). */
  stopHosting(): void {
    hosting = false
  },

  /**
   * Undo `disableJobWorkers()`. Production never re-arms workers inside a
   * process that disabled them (that is the whole point of the hard gate), so
   * this exists only so a test can restore the module's default state for the
   * tests that run after it.
   */
  reenableJobWorkers(): void {
    workersDisabled = false
    hosting = true
    deferWorkerAutorun = false
    bootComplete = true
    jobsLeader = true
  },
}
