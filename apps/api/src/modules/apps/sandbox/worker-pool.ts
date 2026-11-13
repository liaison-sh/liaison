// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Worker subprocess pool for untrusted app execution.
 *
 * Each worker is a separate OS process running sandbox-worker.ts.
 * Bridge calls (DB, events, network) are proxied back to the main
 * process over IPC — workers never touch host resources directly.
 *
 * If a worker crashes (OOM, WASM trap), only that worker dies.
 * The pool detects the exit and spawns a replacement automatically.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Subprocess } from "bun"
import { SandboxQueueTimeoutError, sandboxCancelledError } from "~/lib/failure-severity"
import { appsLogger as log } from "~/lib/logger"
import { sandboxTenantKey } from "~/modules/apps/custom-app-name"
import type { RunLane } from "~/modules/apps/run-limits"
import {
  resolveSandboxDefaultTimeoutMs,
  resolveSandboxMemoryLimit,
} from "~/modules/apps/run-limits"
import { typedBridgeFailure } from "./bridge-rejection"
import { QUICKJS_HOST_JSC_ENV } from "./pool"

const WORKER_SCRIPT = join(import.meta.dir, "sandbox-worker.ts")
const STARTUP_TIMEOUT_MS = 15_000
// Env-tunable so a high-concurrency deployment (e.g. the chaos sim's 10-person
// week-run) can provision more sandbox workers — a tool handler holds an open
// Postgres tx for its whole execution (incl. slow external HTTP), so too few
// workers under concurrent load backs up foreground tool calls (read-path tools
// like a Shipments-list `search` time out). NaN/0 → the conservative default.
const DEFAULT_MAX_SIZE = Number(process.env.APP_WORKER_POOL_MAX) || 8
// Eager warm floor: how many workers to spawn at init. A cold pool spawned only
// ~4 workers and grew lazily (~1s bun cold-spawn each) — so a post-deploy burst
// of run-tool + released cron backlog paid a serial spawn tax while under the 5s
// budget, timing calls out ("App execution timed out"). Warming ~8 up front (or
// maxSize, whichever is smaller) absorbs the first burst without lazy growth.
// Env-overridable following pool.ts's resolveSandboxPoolMaxSize convention.
const DEFAULT_WARM_SIZE = 8
export function resolveSandboxPoolWarmSize(
  maxSize: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  // Legacy APP_WORKER_POOL_SIZE still honored as the warm floor if set; the new
  // SANDBOX_POOL_WARM_SIZE wins when both are present.
  const override = Number(env.SANDBOX_POOL_WARM_SIZE ?? env.APP_WORKER_POOL_SIZE)
  const requested =
    Number.isFinite(override) && override > 0 ? Math.floor(override) : DEFAULT_WARM_SIZE
  return Math.max(1, Math.min(requested, maxSize))
}
// Shared QuickJS heap default with the trusted in-process pool (32MB — see
// pool.ts's rationale: 8MB OOM-looped a gmail incremental sync in prod).
const DEFAULT_MEMORY_LIMIT = resolveSandboxMemoryLimit()
// The sandbox default wall clock (run-limits.ts). Outside production it now
// honours LIAISON_SANDBOX_TIMEOUT_MS as the in-process pool always did.
const DEFAULT_TIMEOUT = resolveSandboxDefaultTimeoutMs()
// Workers reserved for INTERACTIVE (user/agent-initiated) executions. Background
// work (webhooks, event handlers, scheduled jobs, routines) may occupy at most
// `maxSize - reserved` workers at once, so a burst of background executions can
// never monopolize the whole pool and starve a foreground tool call (a sandboxed
// handler holds an open Postgres tx for its entire run, incl. slow external HTTP,
// so without this an interactive read-path tool — e.g. a Shipments-list `search`
// under the 10-actor week-run — times out behind background jobs). NaN/0 → 1.
const DEFAULT_RESERVED_INTERACTIVE = Number(process.env.APP_WORKER_POOL_RESERVED_INTERACTIVE) || 1
// Worker recycling thresholds. The worker's shared QuickJS WASM runtime only
// ever GROWS: WASM memory cannot be returned to the OS, and the runtime interns
// atoms across every per-request bundle eval, so a long-lived worker's RSS
// ratchets monotonically (measured: 92MB -> ~1.8GB over 400 varied executions).
// In prod that aggregate tripped the container cgroup OOM-killer repeatedly.
// Once a worker reports an RSS past the cap — or has served enough executions —
// the pool retires it after the response is delivered and spawns a fresh one.
// NaN/0 → defaults; recycling costs one worker startup (~1s), amortized.
const DEFAULT_MAX_WORKER_RSS_BYTES =
  (Number(process.env.APP_WORKER_MAX_RSS_MB) || 512) * 1024 * 1024
const DEFAULT_MAX_WORKER_EXECS = Number(process.env.APP_WORKER_MAX_EXECS) || 500
// The recycle check above only runs once an execution has ENDED, so a single
// long execution could drive a worker far past the cap before the pool looked
// (measured: 2031MB against a 512MB cap). While a worker is busy the pool also
// samples its RSS from the outside and kills it past a hard ceiling of twice the
// cap. Twice, not once: an execution that ends a little over the cap is normal
// and is recycled after its response, never killed mid-flight.
const HARD_RSS_CEILING_FACTOR = 2
const DEFAULT_RSS_SAMPLE_INTERVAL_MS = 250
// Neither check above sees memory that grows while a worker is idle: the
// post-exec check reads the worker's RSS as its result is sent, and the
// in-flight sampler is only armed while it is busy. A background JIT compile
// once grew idle workers by gigabytes that way. Idle workers are sampled too,
// less often, and one past the cap is retired (it runs nothing, so nothing is
// killed mid-flight).
const DEFAULT_IDLE_RSS_SAMPLE_INTERVAL_MS = 2_000

// Observability thresholds. Independent of caller cancellation (Change B):
// these fire on pool pressure alone, so a caller that gives up (aborts) never
// silences the saturation signal that used to arrive only as a queue timeout.
const DEFAULT_QUEUE_WAIT_WARN_MS = Number(process.env.SANDBOX_QUEUE_WAIT_WARN_MS) || 5_000
const DEFAULT_WORKER_HOLD_WARN_MS = Number(process.env.SANDBOX_WORKER_HOLD_WARN_MS) || 10_000
const DEFAULT_POOL_REPORT_INTERVAL_MS =
  Number(process.env.SANDBOX_POOL_REPORT_INTERVAL_MS) || 30_000

/** The worker pool's scheduling class: the run's lane (run-limits.ts runLaneOf). */
export type ExecPriority = RunLane

// TENANT BUDGET (every edition). Every org's custom apps share this pool with
// every other org's apps, and a sandboxed handler holds a worker and an open
// Postgres transaction for its whole run. Without a share, one tenant's busy
// loop (a webhook driven from the internet, a flood of its own events) holds
// every worker and every other org's webhooks, events, jobs and tool calls wait.
// So the executions of one org's custom apps (keyed by the app name's org key,
// custom-app-name.ts) run at most CUSTOM_APP_MAX_CONCURRENT_PER_ORG at once;
// more wait in a short per-org line, and past it are refused at once with
// SandboxTenantBusyError (429). Nested hops (a custom tool calling a tool) are
// not counted: their caller already holds the org's slot, and parking them
// would deadlock it. Catalog, in-tree and instance apps keep their path.
export const CUSTOM_APP_MAX_CONCURRENT_PER_ORG = 2
/** How many more of one org's custom-app executions may wait for its slots. */
export const CUSTOM_APP_MAX_QUEUED_PER_ORG = 8
/** How long one of them waits before it is refused. */
export const CUSTOM_APP_QUEUE_WAIT_MS = 5_000

export const SANDBOX_TENANT_BUSY_CODE = "custom_app_busy"
/** The Retry-After of a SandboxTenantBusyError: one queue wait. */
export const SANDBOX_TENANT_RETRY_AFTER_SECONDS = Math.ceil(CUSTOM_APP_QUEUE_WAIT_MS / 1000)

/** 429: the org's custom apps already use their share of the sandbox. */
export class SandboxTenantBusyError extends Error {
  readonly status = 429
  readonly code = SANDBOX_TENANT_BUSY_CODE
  readonly retryAfterSeconds: number
  constructor(retryAfterSeconds: number) {
    super(
      "This organization's custom apps are using all of their share of the app sandbox. Retry shortly.",
    )
    this.name = "SandboxTenantBusyError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

interface TenantWaiter {
  admit: () => void
}

// How many nested acquires ONE parent execution may hold open at once. A
// sandboxed handler that fans its cross-app hops out with `Promise.all` makes
// every hop a nested acquire, and a nested acquire skips the background
// concurrency cap: unbounded, one background routine's fan-out walks straight
// past a foreground call that queued before it. Past this many, the extra hops
// are ordinary queued work and take their turn.
export const MAX_NESTED_BREADTH_PER_PARENT = 2
/** Parent key used when a nested acquire names no parent execution. */
const UNKEYED_NESTED_PARENT = "(unkeyed parent)"

// Headroom for REENTRANT (nested) dispatches, i.e. how many workers the pool
// may spawn ABOVE `maxSize` to admit them.
//
// A sandboxed handler may call another app's tool through `ctx.executeTool`;
// that nested dispatch travels rpc-bridge -> executeToolCore -> execute-tool's
// runManifest and lands back on THIS pool while the caller still holds a
// worker. Queueing such a request can only deadlock: the slot it waits for is
// held by its own caller. That is what stalled prod: `APP_WORKER_POOL_MAX=6`,
// six concurrent boxtal `print_pack` calls holding every worker while their
// nested `invoicing:*` calls queued behind workers that could never free,
// unwinding only at the 62s kill timer while the HTTP layer had already given
// up at 30s ("Request failed").
//
// The invariant that removes the deadlock is: A NESTED DISPATCH NEVER WAITS ON
// THE QUEUE. It gets an idle worker, or a worker spawned above `maxSize`, or
// it is refused immediately. Refusal is not a deadlock: the error unwinds into
// the calling handler, which finishes and frees ITS worker, so the pool always
// makes progress.
//
// The ceiling keeps the overflow finite rather than unbounded. A depth-derived
// ceiling is NOT enough on its own: executeToolCore caps a chain at
// `callChain.length >= 5`, but N concurrent ROOT calls each one frame deep need
// N overflow workers, not 4, which is precisely the prod shape. So the default
// headroom is a whole extra generation (`maxSize`, floored at the chain-depth
// limit), i.e. the pool may at most double under reentrant load. Overflow
// workers are not replaced when they exit, so the inflation deflates on its
// own. Trading a deadlock for that much bounded extra memory is the intended
// deal. MAX_NESTED_BREADTH_PER_PARENT bounds what ONE parent execution's
// fan-out may contribute to it.
const MAX_NESTED_CHAIN_DEPTH = 4
export function resolveMaxNestedOverflow(
  maxSize: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number(env.APP_WORKER_POOL_NESTED_OVERFLOW)
  if (Number.isFinite(override) && override >= 0) return Math.floor(override)
  return Math.max(MAX_NESTED_CHAIN_DEPTH, maxSize)
}

/**
 * Build the minimal environment handed to a sandbox worker subprocess.
 * Only non-secret vars required to launch `bun` are forwarded; host secrets
 * are deliberately excluded so a sandbox escape cannot read them from
 * `process.env`. The worker runs QuickJS WASM, so it also starts with the
 * QuickJS host JSC options (see QUICKJS_HOST_JSC_ENV in pool.ts).
 */
export function workerEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...QUICKJS_HOST_JSC_ENV,
    NODE_ENV: process.env.NODE_ENV ?? "development",
  }
  if (process.env.PATH) env.PATH = process.env.PATH
  if (process.env.HOME) env.HOME = process.env.HOME
  return env
}

const toMb = (bytes: number) => Math.round(bytes / 1024 / 1024)

/**
 * Rejection for an execution whose worker passed the hard RSS ceiling while it
 * ran. The worker is killed with it and the pool spawns a replacement.
 */
export class SandboxWorkerMemoryError extends Error {
  readonly rssBytes: number
  readonly ceilingBytes: number
  constructor(rssBytes: number, ceilingBytes: number) {
    super(
      `App execution exceeded the sandbox worker memory ceiling: ${toMb(rssBytes)} MB resident, ceiling ${toMb(ceilingBytes)} MB`,
    )
    this.name = "SandboxWorkerMemoryExceeded"
    this.rssBytes = rssBytes
    this.ceilingBytes = ceilingBytes
  }
}

/**
 * Resident set size of a live process in bytes, or null when it cannot be read
 * (the process is gone, or the platform offers no source).
 *
 * Sampled from the host, never self-reported: a worker stuck in a synchronous
 * QuickJS loop never yields its event loop, so it could not report on itself.
 * Linux reads VmRSS from /proc/<pid>/status, one procfs read and no child
 * process, which is what production (a Linux container) and the dev box run.
 * macOS has no procfs and asks `ps`, one short-lived child per sample, paid
 * only while a worker is busy.
 */
export async function readProcessRssBytes(pid: number): Promise<number | null> {
  try {
    if (process.platform === "linux") {
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))
      return match ? Number(match[1]) * 1024 : null
    }
    if (process.platform === "darwin") {
      const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
      })
      const out = (await new Response(ps.stdout).text()).trim()
      await ps.exited
      const kb = Number(out)
      return out !== "" && Number.isFinite(kb) ? kb * 1024 : null
    }
  } catch {
    // The process exited between the check and the read.
  }
  return null
}

// -- Types -------------------------------------------------------------------

export interface WorkerPoolOptions {
  size?: number
  maxSize?: number
  memoryLimitBytes?: number
  timeoutMs?: number
  /** Workers held back for interactive use; background execs cap at maxSize-this. */
  reservedInteractive?: number
  /** Retire a worker whose self-reported RSS exceeds this after an execution. */
  maxWorkerRssBytes?: number
  /** Retire a worker after this many executions (WASM memory high-water bound). */
  maxExecsPerWorker?: number
  /** Kill a busy worker whose sampled RSS passes this mid-execution. Default: twice maxWorkerRssBytes. */
  hardMaxWorkerRssBytes?: number
  /** How often a busy worker's RSS is sampled. */
  rssSampleIntervalMs?: number
  /** How often idle workers' RSS is sampled; one past maxWorkerRssBytes is retired. */
  idleRssSampleIntervalMs?: number
  /** How often the pool emits its saturation report while under pressure. */
  reportIntervalMs?: number
  /**
   * How long a freshly spawned worker has to send its `ready` handshake before
   * the spawn is abandoned. A spawn that passes it is killed and dropped, and
   * the acquire that asked for it is rejected.
   */
  startupTimeoutMs?: number
  /**
   * How many workers the pool may spawn ABOVE `maxSize` to admit reentrant
   * (nested) dispatches. See resolveMaxNestedOverflow.
   */
  maxNestedOverflow?: number
  /** Tenant budget overrides (tests); see CUSTOM_APP_MAX_CONCURRENT_PER_ORG. */
  tenantMaxConcurrent?: number
  tenantMaxQueued?: number
  tenantQueueWaitMs?: number
}

export interface WorkerExecOptions {
  bundleSource: string
  exportName: string
  params: unknown
  /**
   * Extra positional args appended after `(params, __ctx)` when the
   * sandbox-worker invokes the handler. Used to pass webhook `headers`
   * as a third arg to manifest webhook handlers per the SDK signature
   * `(payload, ctx, headers)`.
   */
  extraArgs?: unknown[]
  bridge: Record<string, (...args: any[]) => any>
  timeoutMs?: number
  /**
   * How long the request may wait for a free worker (a background run's own
   * queue bound, run-limits.ts runQueueBoundMs). Unset: its timeout plus 30 s.
   */
  queueMs?: number
  memoryLimitBytes?: number
  /**
   * Called with the worker's QuickJS heap reading when the execution returns a
   * result (`heapBytes` is null when the worker could not read it). Setting it
   * asks the worker to measure (sandbox-worker `measureHeap`).
   */
  onHeapReport?: (report: { heapBytes: number | null }) => void
  /**
   * Synchronous-context pre-bake passed through to the worker.
   *
   * Note: `getUserId`/`getOrgId` are NOT pre-baked in the out-of-process
   * worker — those bridge calls resolve via IPC roundtrip (see sandbox-worker.ts).
   * Only `approval` (the K6 re-entry signal) is baked as a synchronous
   * literal, because `if (ctx.approval)` must branch synchronously in
   * untrusted handler code and cannot tolerate an async IPC call.
   */
  syncContext?: {
    approval?: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  }
  /**
   * Scheduling class. `interactive` (default) = a user/agent-initiated tool
   * call that a human is waiting on. `background` = webhook/event/job/routine
   * work. Background executions are capped at `maxSize - reservedInteractive`
   * concurrent and drain after interactive ones, so they never starve a
   * foreground call.
   */
  priority?: ExecPriority
  /**
   * Background executions of one group (an app's jobs: `job:<app>`) hold at
   * most half the background capacity at once, so a flood of one kind of slow
   * work (mailbox syncs on slow servers) cannot take every background worker.
   * Ignored for interactive and nested executions.
   */
  backgroundGroup?: string
  /**
   * True when this acquire is made from INSIDE another execution of this pool
   * (a cross-app `ctx.executeTool` hop). The caller already holds a worker and
   * is blocked until this one answers, so a nested acquire may never be parked
   * behind the very execution that is waiting for it: it ignores the background
   * concurrency cap and the boot ramp, and it is never parked on the general
   * queue at all. It takes an idle worker, or one spawned above `maxSize` (up
   * to `maxNestedOverflow`), or it is refused outright, because a queued nested
   * call waits on a worker its own caller holds and that is the deadlock.
   *
   * It also supersedes `priority`: a nested dispatch made from a background
   * execution is still nested, because the deadlock does not care which class
   * the outer call belonged to.
   */
  nested?: boolean
  /**
   * Which parent EXECUTION this nested acquire belongs to: a per-execution id,
   * not a name. Every hop of one handler's `Promise.all` fan-out carries the
   * same key, so the pool can bound that fan-out's breadth
   * (MAX_NESTED_BREADTH_PER_PARENT) instead of letting it jump the queue
   * without limit.
   *
   * It must identify the execution, never the chain of tool names that led to
   * it: two concurrent, independent executions of the same chain share a name
   * key, and one of them was being counted against (and queued behind) the
   * other's fan-out. Callers with no parent execution to name leave it unset
   * and share `UNKEYED_NESTED_PARENT`.
   */
  nestedParentKey?: string
  /**
   * Cancellation signal from the caller (e.g. the incoming HTTP request). When
   * provided:
   *  - If already aborted on entry, execute() rejects immediately without
   *    acquiring or queuing a worker.
   *  - If it aborts while the request is queued, the queued entry is removed
   *    and rejected promptly instead of waiting out the queue budget, and it
   *    never later occupies a worker.
   *  - An ALREADY RUNNING execution is never interrupted (the handler may be
   *    mid-mutation); this only stops work that has not started yet.
   */
  signal?: AbortSignal
  /**
   * The app whose code runs. Also decides the tenant budget: an org's custom
   * app counts against its org's share (sandboxTenantKey).
   */
  appId?: string
  /** Tool name, for saturation/hold-time log fields when available. */
  toolName?: string
}

interface WorkerHandle {
  id: number
  proc: Subprocess
  busy: boolean
  pendingExec: PendingExec | null
  execCount: number
  /**
   * True once the worker has been told to shut down for recycling (RSS/exec
   * threshold) but has not yet exited. A retiring worker must never be handed a
   * fresh execution — findFreeWorker/drainQueue exclude it — otherwise a stale
   * in-flight message from its retiring execution could bind to the new one.
   */
  recycling: boolean
  /**
   * True once the worker has sent its `ready` handshake. A worker is pushed on
   * to the pool the instant it is spawned, long before its `bun` process has
   * booted, so without this flag `findFreeWorker` hands a still-booting worker
   * to a CONCURRENT acquire: the execute message is written to a process that
   * has no IPC handler yet, is dropped on the floor, and that execution hangs
   * until the per-tool timeout kills it. That is the cold-spawn shape (a pool
   * warmed to one, several concurrent acquires while the warm worker is held),
   * so a booting worker is never free.
   */
  ready: boolean
  /** RSS sampler, armed only while the worker runs an execution. */
  rssSampler: ReturnType<typeof setInterval> | null
}

interface PendingExec {
  requestId: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  bridge: Record<string, (...args: any[]) => any>
  timer: ReturnType<typeof setTimeout>
  priority: ExecPriority
  /** The exec's background group, counted while it holds a worker. */
  backgroundGroup?: string
  appId?: string
  toolName?: string
  /**
   * How many bridge calls this execution has already made. A bridge call runs
   * host-side in its own short RLS transaction and commits independently, so a
   * non-zero count is the signal that killing this worker mid-handler can leave
   * a half-applied side effect (see dispatch()'s abort path).
   */
  bridgeCallCount: number
  onHeapReport?: (report: { heapBytes: number | null }) => void
}

interface QueuedRequest {
  opts: WorkerExecOptions
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  priority: ExecPriority
  /** A nested acquire: its caller is holding a worker of this same pool. */
  nested: boolean
  enqueuedAtMs: number
}

// -- Pool --------------------------------------------------------------------

/** The runtime's own shape, not a handler's text that happens to say it (any tenant could retire workers). */
function isRuntimeOutOfMemory(error: unknown, errorName: unknown): boolean {
  const message = String(error ?? "")
  return (
    (errorName === "InternalError" && message === "out of memory") ||
    message.endsWith("InternalError: out of memory")
  )
}

export class SandboxWorkerPool {
  private workers: WorkerHandle[] = []
  private queue: QueuedRequest[] = []
  private nextWorkerId = 0
  private nextRequestId = 0
  private shutdownCalled = false
  private backgroundInFlight = 0
  // Background acquires that have decided to dispatch and are waiting on a cold
  // spawn. `backgroundInFlight` only rises inside `dispatch`, so during the
  // second a worker takes to boot the cap read stale and a burst of background
  // acquires all passed it, growing the pool past `maxSize - reservedInteractive`.
  private backgroundClaiming = 0
  // Background execs per group holding a worker, and per group claiming a cold
  // spawn (same reason as `backgroundClaiming`).
  private groupInFlight = new Map<string, number>()
  private groupClaiming = new Map<string, number>()
  private readonly poolSize: number
  private readonly maxSize: number
  private readonly reservedInteractive: number
  private readonly defaultMemoryLimit: number
  private readonly defaultTimeout: number
  private readonly maxWorkerRssBytes: number
  private readonly maxExecsPerWorker: number
  private readonly hardMaxWorkerRssBytes: number
  private readonly rssSampleIntervalMs: number
  private readonly startupTimeoutMs: number
  private readonly maxNestedOverflow: number
  // Saturation-report bookkeeping (Change B). Reset after every emitted
  // report; accumulates the worst queue wait / hold time observed since.
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private maxQueueWaitSinceReportMs = 0
  private maxHoldSinceReportMs = 0
  private readonly nestedOutstanding = new Map<string, number>()
  private readonly idleRssSampleIntervalMs: number
  private idleSampler: ReturnType<typeof setInterval> | null = null
  private idleSampling = false
  private readonly tenantInFlight = new Map<string, number>()
  private readonly tenantWaiters = new Map<string, TenantWaiter[]>()
  private readonly tenantMaxConcurrent: number
  private readonly tenantMaxQueued: number
  private readonly tenantQueueWaitMs: number

  constructor(opts: WorkerPoolOptions = {}) {
    this.tenantMaxConcurrent = opts.tenantMaxConcurrent ?? CUSTOM_APP_MAX_CONCURRENT_PER_ORG
    this.tenantMaxQueued = opts.tenantMaxQueued ?? CUSTOM_APP_MAX_QUEUED_PER_ORG
    this.tenantQueueWaitMs = opts.tenantQueueWaitMs ?? CUSTOM_APP_QUEUE_WAIT_MS
    this.idleRssSampleIntervalMs =
      opts.idleRssSampleIntervalMs ?? DEFAULT_IDLE_RSS_SAMPLE_INTERVAL_MS
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE
    // Warm floor is clamped to maxSize by the resolver; an explicit opts.size
    // (used by tests for tiny pools) still wins verbatim, clamped to >=1.
    this.poolSize =
      opts.size != null
        ? Math.max(1, Math.min(opts.size, this.maxSize))
        : resolveSandboxPoolWarmSize(this.maxSize)
    this.defaultMemoryLimit = opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT
    this.defaultTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT
    this.maxWorkerRssBytes = opts.maxWorkerRssBytes ?? DEFAULT_MAX_WORKER_RSS_BYTES
    this.maxExecsPerWorker = opts.maxExecsPerWorker ?? DEFAULT_MAX_WORKER_EXECS
    this.hardMaxWorkerRssBytes =
      opts.hardMaxWorkerRssBytes ?? this.maxWorkerRssBytes * HARD_RSS_CEILING_FACTOR
    this.rssSampleIntervalMs = opts.rssSampleIntervalMs ?? DEFAULT_RSS_SAMPLE_INTERVAL_MS
    this.startupTimeoutMs = opts.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
    this.maxNestedOverflow = Math.max(
      0,
      opts.maxNestedOverflow ?? resolveMaxNestedOverflow(this.maxSize),
    )
    // Reserve at most maxSize-1 (a 1-worker pool can reserve none, else
    // background never runs). Floor at 0.
    const requested = opts.reservedInteractive ?? DEFAULT_RESERVED_INTERACTIVE
    this.reservedInteractive = Math.max(0, Math.min(requested, this.maxSize - 1))

    // Periodic saturation report (Change B). Fires only when the pool is
    // under pressure (queued > 0 OR busy === total) so a healthy pool stays
    // silent. Independent of caller cancellation: a request that aborts while
    // queued still counted toward `queued` at the time it was observed, so
    // this never silences the real outage signal. Unref'd + cleared on
    // shutdown so it never keeps the process (or a test) alive.
    this.reportTimer = setInterval(
      () => this.emitSaturationReportIfPressured(),
      opts.reportIntervalMs ?? DEFAULT_POOL_REPORT_INTERVAL_MS,
    )
    if (typeof (this.reportTimer as any).unref === "function") (this.reportTimer as any).unref()
  }

  private emitSaturationReportIfPressured(): void {
    const s = this.stats()
    // Pressured means nothing in the pool can serve anything NOW. `busy ===
    // total` missed the state where a worker is present but unusable (still
    // booting, or retiring): the pool then reported itself healthy with zero
    // workers able to take work. `free` is the same predicate findFreeWorker
    // applies, so the report and the dispatcher agree.
    const pressured = s.queued > 0 || s.free === 0
    const maxQueueWaitMs = this.maxQueueWaitSinceReportMs
    const maxHoldMs = this.maxHoldSinceReportMs
    this.maxQueueWaitSinceReportMs = 0
    this.maxHoldSinceReportMs = 0
    if (!pressured) return
    log.warn(
      {
        busy: s.busy,
        total: s.total,
        queued: s.queued,
        backgroundInFlight: s.backgroundInFlight,
        maxQueueWaitMs,
        maxHoldMs,
      },
      "Sandbox worker pool saturated",
    )
  }

  // Boot-ramp state. Right after the BullMQ boot gate opens, the whole
  // accumulated cron backlog is released at once; each backlog job that runs a
  // sandboxed handler competes for a worker + the 5s budget. To avoid the
  // deploy-storm of "App execution timed out" criticals, background execution
  // concurrency is throttled to a small floor at gate-open and linearly ramps
  // to the full cap over `bootRampDurationMs`. Interactive (HTTP run-tool)
  // traffic is NEVER throttled — only `backgroundConcurrencyCap` is ramped, and
  // interactive dispatch does not consult it.
  private bootRampUntilMs = 0
  private bootRampStartMs = 0
  private bootRampFloor = 1
  private bootRampDurationMs = 0

  /**
   * Throttle background sandbox concurrency for `durationMs` after gate-open,
   * starting at `floor` concurrent background execs and ramping linearly to the
   * full cap. Idempotent-safe to call once at boot; a second call re-arms.
   */
  beginBootRamp(durationMs = 60_000, floor = 2): void {
    const now = Date.now()
    this.bootRampStartMs = now
    this.bootRampUntilMs = now + Math.max(0, durationMs)
    this.bootRampFloor = Math.max(1, floor)
    this.bootRampDurationMs = Math.max(0, durationMs)
    // A freshly-widened cap may let a queued background exec dispatch.
    this.drainQueue()
  }

  /** Max workers background work may occupy concurrently (rest reserved for interactive). */
  private get backgroundConcurrencyCap(): number {
    const fullCap = this.maxSize - this.reservedInteractive
    if (this.bootRampDurationMs <= 0) return fullCap
    const now = Date.now()
    if (now >= this.bootRampUntilMs) return fullCap
    // Linear ramp from floor -> fullCap across the boot window.
    const elapsed = now - this.bootRampStartMs
    const progress = elapsed / this.bootRampDurationMs // 0..1
    const floor = Math.min(this.bootRampFloor, fullCap)
    const ramped = Math.floor(floor + (fullCap - floor) * progress)
    return Math.max(floor, Math.min(fullCap, ramped))
  }

  async init(): Promise<void> {
    const spawns = []
    for (let i = 0; i < this.poolSize; i++) {
      spawns.push(this.spawnWorker())
    }
    await Promise.all(spawns)
    if (!this.idleSampler && !this.shutdownCalled) {
      this.idleSampler = setInterval(() => {
        void this.sampleIdleWorkers()
      }, this.idleRssSampleIntervalMs)
      if (typeof (this.idleSampler as any).unref === "function") (this.idleSampler as any).unref()
    }
    log.info({ workers: this.workers.length }, "Sandbox worker pool initialized")
  }

  async execute(opts: WorkerExecOptions): Promise<unknown> {
    if (this.shutdownCalled) throw new Error("Worker pool is shut down")

    // Change A — a caller that is already gone must never acquire or queue a
    // worker in the first place.
    if (opts.signal?.aborted) {
      throw sandboxCancelledError()
    }

    // A reentrant dispatch is downstream of a worker its own caller is holding,
    // so it can never be made to wait on the general queue. Route it to its own
    // admission path BEFORE any capacity check.
    if (opts.nested === true) return this.executeNested(opts)

    const priority: ExecPriority = opts.priority ?? "interactive"
    const tenant = sandboxTenantKey(opts.appId)
    if (!tenant) return this.acquire(opts, priority, false)
    await this.admitTenant(tenant, opts.signal)
    try {
      return await this.acquire(opts, priority, false)
    } finally {
      this.releaseTenant(tenant)
    }
  }

  /** Executions of each tenant holding (or about to take) a worker, and waiting. */
  tenantStats(): Record<string, { inFlight: number; waiting: number }> {
    const out: Record<string, { inFlight: number; waiting: number }> = {}
    for (const [k, n] of this.tenantInFlight) out[k] = { inFlight: n, waiting: 0 }
    for (const [k, w] of this.tenantWaiters) {
      out[k] = { inFlight: out[k]?.inFlight ?? 0, waiting: w.length }
    }
    return out
  }

  /** Take one of the tenant's slots: at once, after a short wait, or a 429. */
  private admitTenant(tenant: string, signal: AbortSignal | undefined): Promise<void> {
    const held = this.tenantInFlight.get(tenant) ?? 0
    if (held < this.tenantMaxConcurrent) {
      this.tenantInFlight.set(tenant, held + 1)
      return Promise.resolve()
    }
    const waiters = this.tenantWaiters.get(tenant) ?? []
    const retryAfter = Math.max(1, Math.ceil(this.tenantQueueWaitMs / 1000))
    if (waiters.length >= this.tenantMaxQueued) {
      log.warn({ tenant, held, waiting: waiters.length }, "custom app sandbox share full: refused")
      return Promise.reject(new SandboxTenantBusyError(retryAfter))
    }
    return new Promise<void>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        const list = this.tenantWaiters.get(tenant)
        const i = list?.indexOf(entry) ?? -1
        if (list && i !== -1) list.splice(i, 1)
        if (list && list.length === 0) this.tenantWaiters.delete(tenant)
      }
      const entry: TenantWaiter = {
        admit: () => {
          leave()
          resolve()
        },
      }
      const onAbort = () => {
        leave()
        reject(new Error("Sandbox request cancelled by caller"))
      }
      const timer = setTimeout(() => {
        leave()
        log.warn({ tenant }, "custom app sandbox share: waited too long, refused")
        reject(new SandboxTenantBusyError(retryAfter))
      }, this.tenantQueueWaitMs)
      signal?.addEventListener("abort", onAbort, { once: true })
      waiters.push(entry)
      this.tenantWaiters.set(tenant, waiters)
    })
  }

  /** Hand the slot to the tenant's next waiter, or give it back. */
  private releaseTenant(tenant: string): void {
    const next = this.tenantWaiters.get(tenant)?.[0]
    if (next) {
      next.admit() // the slot passes on: the count is unchanged
      return
    }
    const held = (this.tenantInFlight.get(tenant) ?? 1) - 1
    if (held > 0) this.tenantInFlight.set(tenant, held)
    else this.tenantInFlight.delete(tenant)
  }

  /**
   * Admission path for a REENTRANT (nested) execution — the load-bearing half
   * of the deadlock fix.
   *
   * The caller of a nested dispatch is a sandboxed handler that is itself
   * holding one of this pool's workers for the whole duration of the nested
   * call. Making that request wait for a free worker therefore makes it wait,
   * transitively, on itself: with `maxSize` such calls in flight the pool can
   * never free a slot and every one of them hangs to the kill timer. So a
   * nested request is admitted, in this order:
   *
   *  1. an idle worker, if there is one (the cheap, common case);
   *  2. otherwise a NEW worker while the pool is still under `maxSize` — the
   *     ordinary growth path, except that the background concurrency cap and
   *     the boot ramp do not apply: its caller is already holding a slot;
   *  3. otherwise a worker spawned ABOVE `maxSize`, up to
   *     `maxSize + maxNestedOverflow` total, and at most
   *     MAX_NESTED_BREADTH_PER_PARENT of them for any ONE parent execution, so
   *     a single handler's `Promise.all` fan-out cannot inflate the pool by
   *     itself;
   *  4. if either bound is reached, an immediate REFUSAL. It is never queued:
   *     a queued nested call waits on a worker its own caller holds, and that
   *     is the deadlock. A refusal unwinds into the calling handler, which then
   *     completes and frees its worker, so the pool always makes progress.
   *
   * Overflow workers are ordinary pool members: the RSS / exec-count recycling
   * thresholds, the crash handler and shutdown all apply to them unchanged.
   * The only difference is that `handleWorkerExit` does not respawn a worker
   * that died while the pool sat at or above `maxSize`, so the inflation is
   * transient.
   */
  private async executeNested(opts: WorkerExecOptions): Promise<unknown> {
    const priority: ExecPriority = opts.priority ?? "interactive"
    const worker = this.findFreeWorker()
    if (worker) return this.dispatch(worker, opts, priority, true)

    if (this.workers.length < this.maxSize) {
      const w = await this.spawnWorker(true)
      return this.dispatch(w, opts, priority, true)
    }

    // Above maxSize: overflow, bounded globally by the ceiling and per parent
    // execution by the breadth cap. A hop that names no parent execution is its
    // own parent: two independent executions must never share one budget (that
    // is what keying on the chain of tool names got wrong), and the ceiling
    // still bounds them together.
    const parentKey = opts.nestedParentKey
    const ceiling = this.maxSize + this.maxNestedOverflow
    const outstanding = parentKey ? (this.nestedOutstanding.get(parentKey) ?? 0) : 0
    if (this.workers.length < ceiling && outstanding < MAX_NESTED_BREADTH_PER_PARENT) {
      if (parentKey) this.nestedOutstanding.set(parentKey, outstanding + 1)
      try {
        const w = await this.spawnWorker(true)
        return await this.dispatch(w, opts, priority, true)
      } finally {
        if (parentKey) this.releaseNested(parentKey)
      }
    }

    // Bound reached. Refuse NOW rather than queue: a queued nested call waits
    // on a worker its own caller is holding, which is the deadlock. Failing the
    // call unwinds the chain instead, the caller's handler completes, and its
    // worker frees. A pool this deep in reentrancy is pathological (runaway
    // fan-out or recursion), so this is loud.
    log.error(
      {
        appId: opts.appId,
        toolName: opts.toolName,
        parentKey: parentKey ?? UNKEYED_NESTED_PARENT,
        outstandingForParent: outstanding,
        total: this.workers.length,
        maxSize: this.maxSize,
        maxNestedOverflow: this.maxNestedOverflow,
      },
      "Nested sandbox dispatch refused: reentrancy ceiling reached",
    )
    const err = new Error(
      `Sandbox reentrancy limit reached: nested tool call refused with ${this.workers.length} workers in use (ceiling ${ceiling} = maxSize ${this.maxSize} + nested headroom ${this.maxNestedOverflow}, per-parent breadth ${MAX_NESTED_BREADTH_PER_PARENT})`,
    )
    err.name = "SandboxReentrancyLimit"
    throw err
  }

  private releaseNested(parentKey: string): void {
    const outstanding = (this.nestedOutstanding.get(parentKey) ?? 0) - 1
    if (outstanding > 0) this.nestedOutstanding.set(parentKey, outstanding)
    else this.nestedOutstanding.delete(parentKey)
  }

  /**
   * A nested acquire skips the background concurrency cap and the boot ramp,
   * because its own caller is holding a worker of this pool and is blocked on
   * it. It never skips the interactive reservation: those workers stay free for
   * foreground calls whatever the nesting depth.
   */
  private nestedMayBypassCap(): boolean {
    return this.workers.filter((w) => w.busy).length < this.maxSize - this.reservedInteractive
  }

  /**
   * Find a worker for one request, grow the pool if the class allows it, and
   * otherwise queue. Background work must leave `reservedInteractive` workers'
   * worth of capacity free for foreground calls: it may dispatch only while
   * fewer than `backgroundConcurrencyCap` background execs are already in
   * flight. When the cap is hit it queues even if a worker is idle (that idle
   * worker is reserved).
   */
  private acquire(
    opts: WorkerExecOptions,
    priority: ExecPriority,
    nested: boolean,
  ): Promise<unknown> {
    const group = priority === "background" && !nested ? opts.backgroundGroup : undefined
    const canDispatchNow =
      priority === "interactive" ||
      (nested && this.nestedMayBypassCap()) ||
      (this.backgroundInFlight + this.backgroundClaiming < this.backgroundConcurrencyCap &&
        this.groupHasRoom(group))

    if (canDispatchNow) {
      const worker = this.findFreeWorker()
      if (worker) return this.dispatch(worker, opts, priority, nested)
      // Grow the pool on demand (interactive may grow to maxSize; background only
      // up to the point that still respects the cap — guaranteed by the check above).
      if (this.workers.length < this.maxSize) {
        // CLAIMED: the spawner marks the new worker busy before it awaits the
        // handshake, so the worker is never a free worker between the handshake
        // and this dispatch. Unclaimed, a queue drain running in that window
        // dispatched a QUEUED execution on to it, this dispatch then overwrote
        // `pendingExec`, and the queued execution's result was dropped by the
        // requestId fence and hung to its timeout.
        if (priority === "background") this.backgroundClaiming++
        if (group) this.adjustGroup(this.groupClaiming, group, 1)
        const unclaim = () => {
          if (priority === "background") {
            this.backgroundClaiming = Math.max(0, this.backgroundClaiming - 1)
          }
          if (group) this.adjustGroup(this.groupClaiming, group, -1)
        }
        return this.spawnWorker(true).then(
          (w) => {
            unclaim()
            return this.dispatch(w, opts, priority, nested)
          },
          (err) => {
            unclaim()
            throw err
          },
        )
      }
    }

    return this.enqueue(opts, priority, nested)
  }

  /**
   * Park a request until a worker frees up. Split out of `execute` so the
   * dispatch guard can send a request that arrived at an already-claimed worker
   * back to the queue instead of overwriting the execution running on it.
   */
  private enqueue(
    opts: WorkerExecOptions,
    priority: ExecPriority,
    nested: boolean,
  ): Promise<unknown> {
    // Queue the request with a timeout so callers are not stranded forever if
    // the pool never frees up (e.g. all workers are hung or respawn is slow).
    // A background run's own queue bound (run-limits.ts runQueueBoundMs), else
    // its timeout plus a margin. Its timeout starts once a worker takes it.
    const queueTimeoutMs = opts.queueMs ?? (opts.timeoutMs ?? this.defaultTimeout) + 30_000
    return new Promise<unknown>((resolve, reject) => {
      // The queue stores `wrappedResolve`/`wrappedReject` (not the raw executor
      // callbacks), so the timeout handler must splice the entry by its *stored*
      // reference. Comparing against the raw `resolve` never matches and would
      // leak the timed-out entry, wasting a worker slot when one later frees up.
      let timer: ReturnType<typeof setTimeout>
      const signal = opts.signal
      const removeAbortListener = () => {
        if (signal) signal.removeEventListener("abort", onAbort)
      }
      const wrappedResolve = (v: unknown) => {
        clearTimeout(timer)
        removeAbortListener()
        resolve(v)
      }
      const wrappedReject = (e: Error) => {
        clearTimeout(timer)
        removeAbortListener()
        reject(e)
      }
      const onAbort = () => {
        // Splice this exact entry out of the queue so it can never later be
        // dequeued and dispatched to a freed worker (Change A). Distinct
        // message/name from the queue-timeout error so callers/logs can tell
        // "caller gave up" apart from "pool never freed a worker" — the
        // latter is the real outage signal (Change B) and must stay intact.
        const idx = this.queue.findIndex((q) => q.resolve === wrappedResolve)
        if (idx !== -1) this.queue.splice(idx, 1)
        const err = sandboxCancelledError()
        wrappedReject(err)
      }
      timer = setTimeout(() => {
        // Remove from queue if still present
        const idx = this.queue.findIndex((q) => q.resolve === wrappedResolve)
        if (idx !== -1) this.queue.splice(idx, 1)
        removeAbortListener()
        reject(new SandboxQueueTimeoutError())
      }, queueTimeoutMs)

      if (signal) signal.addEventListener("abort", onAbort, { once: true })

      this.queue.push({
        opts,
        resolve: wrappedResolve,
        reject: wrappedReject,
        priority,
        nested,
        enqueuedAtMs: Date.now(),
      })
    })
  }

  async shutdown(): Promise<void> {
    this.shutdownCalled = true
    if (this.reportTimer) {
      clearInterval(this.reportTimer)
      this.reportTimer = null
    }
    if (this.idleSampler) {
      clearInterval(this.idleSampler)
      this.idleSampler = null
    }

    // Reject queued requests
    for (const q of this.queue) {
      q.reject(new Error("Worker pool shutting down"))
    }
    this.queue.length = 0

    // Stop all workers
    for (const w of this.workers) {
      this.stopRssSampler(w)
      if (w.pendingExec) {
        clearTimeout(w.pendingExec.timer)
        w.pendingExec.reject(new Error("Worker pool shutting down"))
      }
      try {
        this.sendToWorker(w, { type: "shutdown" })
      } catch {
        /* ok */
      }
    }

    // Wait for exits with a hard kill fallback
    await Promise.allSettled(
      this.workers.map(async (w) => {
        const timeout = setTimeout(() => {
          try {
            w.proc.kill()
          } catch {
            /* ok */
          }
        }, 3000)
        await w.proc.exited
        clearTimeout(timeout)
      }),
    )

    this.workers.length = 0
  }

  stats() {
    return {
      total: this.workers.length,
      busy: this.workers.filter((w) => w.busy).length,
      // The same predicate findFreeWorker uses: a booting or retiring worker is
      // present but cannot be dispatched on to, so it is not free.
      free: this.workers.filter((w) => !w.busy && !w.recycling && w.ready).length,
      queued: this.queue.length,
      backgroundInFlight: this.backgroundInFlight,
      backgroundGroups: Object.fromEntries(this.groupInFlight),
      backgroundGroupCap: this.backgroundGroupCap,
      reservedInteractive: this.reservedInteractive,
      backgroundConcurrencyCap: this.backgroundConcurrencyCap,
      // Hard ceiling on worker count, including the reentrancy headroom. Total
      // must never exceed this, however deep a call chain goes.
      maxTotal: this.maxSize + this.maxNestedOverflow,
    }
  }

  // -- Internal --------------------------------------------------------------

  private findFreeWorker(): WorkerHandle | null {
    // A recycling worker is idle-but-doomed (told to shut down, not yet exited);
    // never dispatch onto it or a stale in-flight message could bind to the new
    // execution. A worker that has not sent `ready` is still booting: its process
    // has no IPC handler yet, so an execute message sent to it is LOST and the
    // execution hangs to its timeout.
    return this.workers.find((w) => !w.busy && !w.recycling && w.ready) ?? null
  }

  /** Decrement the in-flight background counters when a background exec finishes,
   *  times out, or its worker dies. Floored at 0 so a double-release is harmless. */
  private releaseBackgroundSlot(pending: PendingExec | null | undefined): void {
    if (pending?.priority !== "background") return
    this.backgroundInFlight = Math.max(0, this.backgroundInFlight - 1)
    if (pending.backgroundGroup) this.adjustGroup(this.groupInFlight, pending.backgroundGroup, -1)
  }

  private adjustGroup(counts: Map<string, number>, group: string, delta: number): void {
    const next = (counts.get(group) ?? 0) + delta
    if (next > 0) counts.set(group, next)
    else counts.delete(group)
  }

  /**
   * Max workers ONE background group (an app's jobs) may hold at once: half the
   * background capacity, at least one. Many slow executions of one kind (100
   * mailbox syncs waiting on slow IMAP servers) then leave the other half to
   * every other app's background work, on top of the interactive reservation.
   */
  private get backgroundGroupCap(): number {
    return Math.max(1, Math.ceil(this.backgroundConcurrencyCap / 2))
  }

  /** Whether a background exec of this group may take one more worker now. */
  private groupHasRoom(group: string | undefined): boolean {
    if (!group) return true
    const held = (this.groupInFlight.get(group) ?? 0) + (this.groupClaiming.get(group) ?? 0)
    return held < this.backgroundGroupCap
  }

  private dispatch(
    worker: WorkerHandle,
    opts: WorkerExecOptions,
    priority: ExecPriority,
    nested = false,
  ): Promise<unknown> {
    // A worker that is already running an execution must never be dispatched
    // on to: binding a second `pendingExec` orphans the first, whose result the
    // requestId fence then drops. Defence in depth behind the spawner's claim.
    if (worker.pendingExec) {
      log.warn(
        { workerId: worker.id, appId: opts.appId, toolName: opts.toolName },
        "Sandbox dispatch reached a busy worker, requeueing",
      )
      return this.enqueue(opts, priority, nested)
    }
    const requestId = String(this.nextRequestId++)
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeout
    const memoryLimitBytes = opts.memoryLimitBytes ?? this.defaultMemoryLimit
    const backgroundGroup = priority === "background" && !nested ? opts.backgroundGroup : undefined
    if (priority === "background") this.backgroundInFlight++
    if (backgroundGroup) this.adjustGroup(this.groupInFlight, backgroundGroup, 1)
    const dispatchedAtMs = Date.now()
    let holdSettled = false
    // Change B — record worker hold time (queue for this data is currently
    // zero in production). Fires independently of caller cancellation.
    const recordHold = () => {
      if (holdSettled) return
      holdSettled = true
      const holdMs = Date.now() - dispatchedAtMs
      if (holdMs > this.maxHoldSinceReportMs) this.maxHoldSinceReportMs = holdMs
      if (holdMs > DEFAULT_WORKER_HOLD_WARN_MS) {
        log.warn(
          { appId: opts.appId, toolName: opts.toolName, holdMs, workerId: worker.id },
          "Sandbox worker held longer than expected",
        )
      }
    }

    return new Promise<unknown>((resolve, reject) => {
      const signal = opts.signal
      const detachAbort = () => {
        if (signal) signal.removeEventListener("abort", onAbort)
      }
      const wrappedResolve = (v: unknown) => {
        detachAbort()
        recordHold()
        resolve(v)
      }
      const wrappedReject = (e: Error) => {
        detachAbort()
        recordHold()
        reject(e)
      }
      const timer = setTimeout(() => {
        // Kill the worker — it's stuck
        log.warn({ workerId: worker.id, requestId }, "Worker execution timeout — killing worker")
        this.stopRssSampler(worker)
        this.releaseBackgroundSlot(worker.pendingExec)
        worker.pendingExec = null
        worker.busy = false
        // Doomed: never hand a killed-but-not-yet-exited worker fresh work, or a
        // stale in-flight message from this execution could bind to the new one.
        worker.recycling = true
        try {
          worker.proc.kill()
        } catch {
          /* ok */
        }
        wrappedReject(new Error("App execution timed out"))
      }, timeoutMs + 2000) // grace period beyond QuickJS interrupt

      // ---- Caller abort while the execution is ALREADY RUNNING ----------------
      // Without this the worker stayed busy until the kill timer above
      // (timeoutMs + 2000). With the HTTP layer giving up at REQUEST_TIMEOUT_MS
      // (30s) and the sandbox kill timer at 62s, every 504 parked a worker for a
      // further ~32s, so operator re-clicks compounded into a rolling outage.
      //
      // MID-FLIGHT SEMANTICS (deliberate choice): we KILL the worker process.
      // Untrusted QuickJS handler code has no cooperative cancellation point, so
      // killing the process is the only way to get the slot back — it is exactly
      // what the execution-timeout path above already does, with the same
      // consequences. The worker is retired rather than reused: a process killed
      // mid-handler can still have an in-flight bridge_call or result in the IPC
      // pipe, and binding that to the next execution would cross RLS/tx contexts.
      // handleWorkerExit removes it and (while the pool is below maxSize) spawns
      // a clean replacement, then drains the queue.
      //
      // The cost is that the handler can be left HALF-DONE: bridge calls execute
      // host-side in their own short RLS transactions and commit independently,
      // so whatever already committed stays committed while the rest of the
      // handler never runs. Nothing rolls that back. It must therefore never be
      // silent: an abort after at least one bridge call is logged at ERROR with
      // app, tool, worker, elapsed time and bridge-call count, i.e. enough
      // context to become a field bug report.
      const onAbort = () => {
        // Act only on OUR execution. If the worker already settled and was
        // rebound to a different request, there is nothing of ours to cancel.
        const pending = worker.pendingExec
        if (!pending || pending.requestId !== requestId) return
        clearTimeout(timer)
        this.stopRssSampler(worker)
        this.releaseBackgroundSlot(pending)
        const bridgeCalls = pending.bridgeCallCount
        worker.pendingExec = null
        worker.recycling = true
        const fields = {
          appId: opts.appId,
          toolName: opts.toolName,
          workerId: worker.id,
          requestId,
          bridgeCalls,
          elapsedMs: Date.now() - dispatchedAtMs,
        }
        // The caller went away (a closed tab, a cancelled turn): an outcome, not
        // a fault of ours, so warn either way (lib/failure-severity.ts). The
        // mid-handler line still says what was already committed.
        if (bridgeCalls > 0) {
          log.warn(
            { ...fields, reason: "caller_cancelled", sideEffectsCommitted: true },
            "Sandbox execution aborted by caller mid-handler: worker killed, side effects already committed by completed bridge calls are NOT rolled back",
          )
        } else {
          log.warn(
            { ...fields, reason: "caller_cancelled", sideEffectsCommitted: false },
            "Sandbox execution aborted by caller before any bridge call: worker killed, no side effects",
          )
        }
        try {
          worker.proc.kill()
        } catch {
          /* already dead */
        }
        const err = sandboxCancelledError()
        wrappedReject(err)
      }

      worker.busy = true
      worker.pendingExec = {
        requestId,
        resolve: wrappedResolve,
        reject: wrappedReject,
        bridge: opts.bridge,
        timer,
        priority,
        backgroundGroup,
        appId: opts.appId,
        toolName: opts.toolName,
        bridgeCallCount: 0,
        onHeapReport: opts.onHeapReport,
      }
      // Registered only once pendingExec is bound, so onAbort can always
      // identify the execution it owns.
      if (signal) signal.addEventListener("abort", onAbort, { once: true })

      this.sendToWorker(worker, {
        type: "execute",
        id: requestId,
        bundleSource: opts.bundleSource,
        exportName: opts.exportName,
        params: opts.params,
        extraArgs: opts.extraArgs,
        bridgeMethods: Object.keys(opts.bridge),
        timeoutMs,
        memoryLimitBytes,
        syncContext: opts.syncContext,
        ...(opts.onHeapReport ? { measureHeap: true } : {}),
      })
      this.startRssSampler(worker, requestId)
    })
  }

  /**
   * Arm the RSS sampler for one execution. Each tick reads the worker's RSS from
   * the outside and kills it past the hard ceiling. The sampler disarms itself as
   * soon as the worker is no longer running `requestId`, so an idle worker costs
   * nothing.
   */
  private startRssSampler(worker: WorkerHandle, requestId: string): void {
    this.stopRssSampler(worker)
    const pid = worker.proc.pid
    let reading = false
    const timer: ReturnType<typeof setInterval> = setInterval(() => {
      if (worker.pendingExec?.requestId !== requestId) {
        clearInterval(timer)
        if (worker.rssSampler === timer) worker.rssSampler = null
        return
      }
      if (reading) return
      reading = true
      readProcessRssBytes(pid)
        .then((rssBytes) => {
          if (rssBytes === null || rssBytes <= this.hardMaxWorkerRssBytes) return
          if (worker.pendingExec?.requestId !== requestId) return
          this.killForMemory(worker, rssBytes)
        })
        .catch((err) => {
          log.error({ err, workerId: worker.id, requestId }, "Sandbox worker RSS sample failed")
        })
        .finally(() => {
          reading = false
        })
    }, this.rssSampleIntervalMs)
    if (typeof (timer as any).unref === "function") (timer as any).unref()
    worker.rssSampler = timer
  }

  private stopRssSampler(worker: WorkerHandle): void {
    if (worker.rssSampler) {
      clearInterval(worker.rssSampler)
      worker.rssSampler = null
    }
  }

  /**
   * Kill a worker whose RSS passed the hard ceiling mid-execution and reject that
   * execution with the memory error. The worker stays busy and recycling until
   * its exit lands, so nothing is dispatched onto it; handleWorkerExit then
   * removes it and spawns the replacement.
   */
  private killForMemory(worker: WorkerHandle, rssBytes: number): void {
    const pending = worker.pendingExec
    if (!pending) return
    this.stopRssSampler(worker)
    clearTimeout(pending.timer)
    this.releaseBackgroundSlot(pending)
    worker.pendingExec = null
    worker.busy = true
    worker.recycling = true
    const err = new SandboxWorkerMemoryError(rssBytes, this.hardMaxWorkerRssBytes)
    log.error(
      {
        err,
        workerId: worker.id,
        requestId: pending.requestId,
        appId: pending.appId,
        toolName: pending.toolName,
        rssMb: toMb(rssBytes),
        ceilingMb: toMb(this.hardMaxWorkerRssBytes),
      },
      "Sandbox worker passed its memory ceiling mid-execution, killing it",
    )
    try {
      worker.proc.kill("SIGKILL")
    } catch {
      /* already gone */
    }
    pending.reject(err)
  }

  /**
   * Retire every idle worker whose RSS has passed the cap. Idle means not busy,
   * not already recycling and past startup; the state is checked again after
   * the read, since a worker can be handed an execution meanwhile. Retiring
   * follows the post-exec recycle: mark it busy and recycling so nothing is
   * dispatched onto it, ask it to shut down, and handleWorkerExit replaces it.
   */
  private async sampleIdleWorkers(): Promise<void> {
    if (this.idleSampling || this.shutdownCalled) return
    this.idleSampling = true
    try {
      for (const worker of [...this.workers]) {
        const idle = () =>
          !worker.busy &&
          !worker.recycling &&
          worker.ready &&
          !this.shutdownCalled &&
          this.workers.includes(worker)
        if (!idle()) continue
        const rssBytes = await readProcessRssBytes(worker.proc.pid)
        if (rssBytes === null || rssBytes <= this.maxWorkerRssBytes || !idle()) continue
        log.info(
          { workerId: worker.id, rssMb: toMb(rssBytes), execs: worker.execCount },
          "Recycling idle sandbox worker past its RSS cap",
        )
        worker.busy = true
        worker.recycling = true
        try {
          this.sendToWorker(worker, { type: "shutdown" })
        } catch {
          try {
            worker.proc.kill()
          } catch {
            /* already gone */
          }
        }
      }
    } catch (err) {
      log.error({ err }, "Sandbox worker idle RSS sample failed")
    } finally {
      this.idleSampling = false
    }
  }

  /**
   * Spawn a worker and resolve once it has sent its `ready` handshake.
   *
   * `claim` marks it busy from birth, for the caller that is growing the pool
   * for itself: an unclaimed worker becomes a plain free worker the instant the
   * handshake lands, and a queue drain in that window takes it out from under
   * the spawner.
   */
  private async spawnWorker(claim = false): Promise<WorkerHandle> {
    const id = this.nextWorkerId++

    const readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Worker startup timeout")),
        this.startupTimeoutMs,
      )

      const self = this
      // --smol makes Bun collect the worker's own JS heap eagerly. Every bridge
      // result lands in that heap as a host string before it is copied into
      // QuickJS, and under the default heuristics that garbage piles up far
      // past the live set between collections.
      // process.execPath, not "bun" from PATH: the worker must run on the very
      // runtime the pool runs on. IPC is serialized per Bun version, and a PATH
      // bun of another version fails every message ("Unable to deserialize
      // data"): seen with Bun 1.4 tests over a 1.3 PATH bun, 2026-10-01.
      const proc = Bun.spawn([process.execPath, "--smol", "run", WORKER_SCRIPT], {
        ipc(message: any) {
          try {
            // JSON round-trip ensures no QuickJS Lifetime objects leak through IPC
            const safe = JSON.parse(JSON.stringify(message))
            self.handleMessage(id, safe)
          } catch (e: any) {
            log.error({ err: e, workerId: id }, "IPC deserialization error")
            const w = self.workers.find((w) => w.id === id)
            if (w?.pendingExec) {
              clearTimeout(w.pendingExec.timer)
              self.releaseBackgroundSlot(w.pendingExec)
              w.pendingExec.reject(new Error("Worker IPC deserialization error"))
              w.pendingExec = null
              w.busy = false
              self.drainQueue()
            }
          }
        },
        stdio: ["ignore", "pipe", "pipe"],
        // Minimal env allowlist — the worker runs untrusted app code and must
        // never receive host secrets (JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL,
        // provider API keys, …). The worker reads zero env vars at runtime;
        // only NODE_ENV plus PATH/HOME (needed for the `bun` launcher) are
        // forwarded. Never spread `process.env` here.
        env: workerEnv(),
        // The death pipe: this server holds the only write end, so the worker
        // gets EOF on fd 0 the moment this process dies by any means and exits
        // itself (see lib/orphan-exit.ts). Orphaned pools were measured at
        // 4.7 GB of RSS, respawning for over an hour. Nothing is written to it.
        stdin: "pipe",
      })

      // Diagnostic — pipe sandbox-worker stderr to host stderr so
      // `console.error` inside sandbox-worker.ts (where the QuickJS shim
      // executes) is visible in test logs. Without this, the worker is a
      // black box and async-bridge hangs cannot be observed.
      ;(async () => {
        try {
          const reader = proc.stderr.getReader()
          const decoder = new TextDecoder()
          let buffer = ""
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value)
            let nl = buffer.indexOf("\n")
            while (nl >= 0) {
              process.stderr.write(`[sandbox-worker ${id}] ${buffer.slice(0, nl + 1)}`)
              buffer = buffer.slice(nl + 1)
              nl = buffer.indexOf("\n")
            }
          }
        } catch {
          /* ok */
        }
      })()

      const worker: WorkerHandle = {
        id,
        proc,
        busy: claim,
        pendingExec: null,
        execCount: 0,
        recycling: false,
        ready: false,
        rssSampler: null,
      }
      this.workers.push(worker)

      // Handle unexpected exit (including during startup)
      proc.exited.then((code) => {
        clearTimeout(timeout)
        // If still waiting for ready, reject
        if ((worker as any)._onReady) {
          delete (worker as any)._onReady
          reject(new Error(`Worker exited during startup (code ${code})`))
        }
        this.handleWorkerExit(id, code)
      })

      // The ready message routes through handleMessage which calls _onReady
      ;(worker as any)._onReady = () => {
        clearTimeout(timeout)
        worker.ready = true
        resolve()
      }
    })

    try {
      await readyPromise
    } catch (err) {
      // A startup timeout leaves a LIVE process and a handle in the pool that
      // no exit path ever removes: `handleWorkerExit` runs off `proc.exited`,
      // which a worker hung before its handshake never reaches, and nothing
      // else killed it. Claimed, that handle stays busy for ever, so `maxSize`
      // such spawns wedge the pool with `total === maxSize, free === 0` and
      // every later acquire queues to its timeout.
      this.discardFailedSpawn(id)
      throw err
    }
    return this.workers.find((w) => w.id === id)!
  }

  /**
   * Drop a worker that never finished booting: kill the process, take the
   * handle out of the pool, and drain the queue against the capacity that is
   * left. The caller's claim is released by `acquire`'s own rejection path.
   */
  private discardFailedSpawn(workerId: number): void {
    const worker = this.workers.find((w) => w.id === workerId)
    if (worker) {
      delete (worker as any)._onReady
      this.stopRssSampler(worker)
      log.warn({ workerId }, "Sandbox worker never reported ready, killing the spawn")
      try {
        worker.proc.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      this.workers = this.workers.filter((w) => w.id !== workerId)
    }
    if (!this.shutdownCalled) this.drainQueue()
  }

  /** Send a JSON message to a worker via IPC. */
  private sendToWorker(worker: WorkerHandle, msg: Record<string, unknown>): void {
    worker.proc.send(msg)
  }

  private handleMessage(workerId: number, message: any): void {
    const worker = this.workers.find((w) => w.id === workerId)
    if (!worker) return

    try {
      switch (message.type) {
        case "ready": {
          const onReady = (worker as any)._onReady
          if (onReady) {
            delete (worker as any)._onReady
            onReady()
          }
          break
        }

        case "error":
        case "result": {
          const pending = worker.pendingExec
          if (!pending) break
          // Fence by execution id: a `result`/`error` echoes the `id` it was
          // dispatched with. A late message from a PREVIOUS execution (e.g. a
          // stale settle arriving right after this worker was recycled and a
          // fresh execution bound its slot) carries a mismatched id — drop it so
          // it can never resolve/reject the wrong execution's promise.
          if (message.id != null && String(message.id) !== pending.requestId) {
            log.debug(
              { workerId: worker.id, staleId: message.id, currentId: pending.requestId },
              "Dropping stale sandbox message (requestId mismatch)",
            )
            break
          }
          clearTimeout(pending.timer)
          this.releaseBackgroundSlot(pending)
          worker.pendingExec = null
          this.stopRssSampler(worker)
          worker.busy = false
          worker.execCount++

          // Recycle a worker whose QuickJS WASM footprint has ratcheted past the
          // cap (WASM memory never shrinks) — AFTER its response is delivered,
          // BEFORE drainQueue can hand it new work. Marking it busy keeps the
          // dispatcher off it; the shutdown-driven exit flows through
          // handleWorkerExit, which removes it and spawns a fresh replacement.
          const rssBytes = typeof message.rssBytes === "number" ? message.rssBytes : 0
          // Out of memory in the runtime every execution of this worker shares: the next
          // execution would fail the same way, so the worker does not serve another.
          const heapExhausted =
            message.type === "error" && isRuntimeOutOfMemory(message.error, message.errorName)
          if (
            !this.shutdownCalled &&
            (heapExhausted ||
              rssBytes > this.maxWorkerRssBytes ||
              worker.execCount >= this.maxExecsPerWorker)
          ) {
            log[heapExhausted ? "warn" : "info"](
              {
                workerId: worker.id,
                rssMb: Math.round(rssBytes / 1024 / 1024),
                execs: worker.execCount,
                heapExhausted,
              },
              "Recycling sandbox worker (RSS/exec threshold or heap exhausted)",
            )
            worker.busy = true
            worker.recycling = true
            try {
              this.sendToWorker(worker, { type: "shutdown" })
            } catch {
              try {
                worker.proc.kill()
              } catch {
                /* ok */
              }
            }
          }

          if (message.type === "error") {
            // A handler that threw an app-sdk ToolError flagged its message as
            // vetted-safe to surface even for an untrusted app in production.
            // The worker forwarded that intent as plain IPC fields (JSON round-
            // trips fine); reconstruct the ToolError shape so execute-tool's
            // safe-error branch surfaces the real message + code instead of
            // redacting it to "Tool execution failed". Bare throws (no
            // toolErrorSafe) stay plain Errors and keep the no-leak default.
            let e: Error
            if (message.toolErrorSafe === true) {
              e = new Error(String(message.error ?? "Tool execution failed"))
              e.name = "ToolError"
              ;(e as any).safe = true
              ;(e as any).code = String(message.toolErrorCode ?? "tool_error")
              ;(e as any).retryable = message.toolErrorRetryable === true
            } else {
              e = new Error(String(message.error ?? "Unknown sandbox error"))
              // The thrown class name (see sandbox-worker): execute-tool tells
              // an app's own error from a runtime crash by it.
              if (typeof message.errorName === "string" && message.errorName) {
                e.name = message.errorName.slice(0, 64)
              }
            }
            // The throw's HTTP class, when it had one (see sandbox-worker):
            // execute-tool logs a 4xx at warn and returns its status.
            if (typeof message.errorStatus === "number") {
              ;(e as any).status = message.errorStatus
              if (typeof message.errorCode === "string") (e as any).code = message.errorCode
            }
            pending.reject(e)
          } else if (message.error) {
            pending.reject(new Error(String(message.error)))
          } else {
            if (pending.onHeapReport) {
              try {
                pending.onHeapReport({
                  heapBytes: typeof message.heapBytes === "number" ? message.heapBytes : null,
                })
              } catch {
                /* a report callback never changes the outcome */
              }
            }
            pending.resolve(message.data)
          }

          this.drainQueue()
          break
        }

        case "bridge_call": {
          const pending = worker.pendingExec
          // Fence stale bridge calls the same way as result/error: a bridge call
          // from a retired execution must not be serviced against a new one's
          // bridge (wrong RLS/tx context). Reply with an error so the worker's
          // pending promise settles rather than hanging.
          if (pending && message.id != null && String(message.id) !== pending.requestId) {
            log.debug(
              { workerId: worker.id, staleId: message.id, currentId: pending.requestId },
              "Dropping stale sandbox bridge_call (requestId mismatch)",
            )
            try {
              this.sendToWorker(worker, {
                type: "bridge_result",
                callId: message.callId,
                error: "Stale execution context",
              })
            } catch {
              /* worker may be dead */
            }
            break
          }
          if (!pending) {
            try {
              this.sendToWorker(worker, {
                type: "bridge_result",
                callId: message.callId,
                error: "No active execution context",
              })
            } catch {
              /* worker may be dead */
            }
            break
          }

          // Count it before invoking: from here on this execution may have
          // committed host-side state, which is what the caller-abort path in
          // dispatch() reports when it has to kill the worker mid-handler.
          pending.bridgeCallCount++

          const bridgeFn = pending.bridge[message.method]
          if (!bridgeFn) {
            this.sendToWorker(worker, {
              type: "bridge_result",
              callId: message.callId,
              error: `Unknown bridge method: ${message.method}`,
            })
            break
          }

          Promise.resolve()
            .then(() => bridgeFn(...message.args))
            .then((data) => {
              try {
                this.sendToWorker(worker, { type: "bridge_result", callId: message.callId, data })
              } catch {
                /* worker may be dead */
              }
            })
            .catch((err) => {
              // A typed refusal's HTTP class and code (a kernel service 404)
              // cross with the message, so a handler that lets it propagate
              // reaches execute-tool as that 4xx instead of a statusless fault.
              const typed = typedBridgeFailure(err)
              try {
                this.sendToWorker(worker, {
                  type: "bridge_result",
                  callId: message.callId,
                  error: err.message,
                  ...(typed
                    ? {
                        errorStatus: typed.status,
                        ...(typed.code !== undefined ? { errorCode: typed.code } : {}),
                      }
                    : {}),
                })
              } catch {
                /* worker may be dead */
              }
            })
          break
        }
      }
    } catch (e: any) {
      log.error({ err: e, workerId }, "Error handling worker message")
      // If there's a pending request, reject it
      if (worker.pendingExec) {
        clearTimeout(worker.pendingExec.timer)
        this.releaseBackgroundSlot(worker.pendingExec)
        worker.pendingExec.reject(new Error(`Worker message handling failed: ${e?.message ?? e}`))
        worker.pendingExec = null
        worker.busy = false
      }
    }
  }

  private handleWorkerExit(workerId: number, code: number): void {
    const worker = this.workers.find((w) => w.id === workerId)
    if (!worker) return

    log.warn({ workerId, exitCode: code }, "Sandbox worker exited")
    this.stopRssSampler(worker)

    // Reject pending request
    if (worker.pendingExec) {
      clearTimeout(worker.pendingExec.timer)
      this.releaseBackgroundSlot(worker.pendingExec)
      worker.pendingExec.reject(new Error(`Sandbox worker crashed (exit ${code})`))
      worker.pendingExec = null
    }

    // Remove from pool
    this.workers = this.workers.filter((w) => w.id !== workerId)

    // Spawn replacement then drain any queued requests that were waiting for a
    // free worker. Without drainQueue the replacement sits idle while callers
    // that queued before the crash wait forever.
    if (!this.shutdownCalled) {
      // An OVERFLOW worker (one spawned above maxSize to admit a nested
      // dispatch) just exited: do not replace it, or a burst of reentrant calls
      // would leave the pool permanently inflated. The inflation is meant to be
      // transient. Still drain — a queued request may now be servable.
      if (this.workers.length >= this.maxSize) {
        this.drainQueue()
        return
      }
      this.spawnWorker()
        .then(() => this.drainQueue())
        .catch((err) => {
          log.error({ err }, "Failed to respawn sandbox worker")
          // Reject queued requests that can no longer be served.
          const stale = this.queue.splice(0)
          for (const q of stale) {
            q.reject(new Error("Sandbox worker respawn failed — request dropped"))
          }
        })
    }
  }

  private drainQueue(): void {
    // Interactive first (FIFO within class), then background — and background
    // only while under the concurrency cap, so a queued foreground call always
    // wins the next freed worker over waiting background work.
    const nextEligibleIndex = (): number => {
      // Nested acquires first, whatever their class: each one is holding another
      // worker of this pool hostage, so serving it is what frees capacity.
      const nestedIdx = this.nestedMayBypassCap() ? this.queue.findIndex((q) => q.nested) : -1
      if (nestedIdx !== -1) return nestedIdx
      let bgIdx = -1
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].priority === "interactive") return i
        if (
          bgIdx === -1 &&
          this.backgroundInFlight < this.backgroundConcurrencyCap &&
          this.groupHasRoom(this.queue[i].opts.backgroundGroup)
        )
          bgIdx = i
      }
      return bgIdx
    }
    while (this.queue.length > 0) {
      const worker = this.findFreeWorker()
      if (!worker) break
      const idx = nextEligibleIndex()
      if (idx === -1) break // only background queued and the cap is reached
      const queued = this.queue.splice(idx, 1)[0]

      // Change A — a queued entry whose caller already gave up must never
      // consume the worker slot that just freed up. Reject it and keep
      // draining the queue for the next eligible entry instead.
      if (queued.opts.signal?.aborted) {
        const err = sandboxCancelledError()
        queued.reject(err)
        continue
      }

      // Change B — queue wait is measured for every dispatched entry
      // regardless of whether some OTHER queued request later cancels; this
      // keeps the saturation signal intact even when callers abort.
      const queueWaitMs = Date.now() - queued.enqueuedAtMs
      if (queueWaitMs > this.maxQueueWaitSinceReportMs) this.maxQueueWaitSinceReportMs = queueWaitMs
      if (queueWaitMs > DEFAULT_QUEUE_WAIT_WARN_MS) {
        const s = this.stats()
        log.warn(
          {
            appId: queued.opts.appId,
            toolName: queued.opts.toolName,
            queueWaitMs,
            busy: s.busy,
            total: s.total,
            queued: s.queued,
            backgroundInFlight: s.backgroundInFlight,
          },
          "Sandbox request waited long in the pool queue",
        )
      }

      this.dispatch(worker, queued.opts, queued.priority, queued.nested).then(
        queued.resolve,
        queued.reject,
      )
    }
  }
}

// -- Global singleton --------------------------------------------------------

let globalWorkerPool: SandboxWorkerPool | null = null
let workerPoolInitPromise: Promise<void> | null = null

export async function initWorkerPool(opts: WorkerPoolOptions = {}): Promise<void> {
  // Await-idempotent: concurrent callers share ONE init. The old form assigned
  // the global before awaiting init(), so while the first caller waited for the
  // worker spawns every other caller returned immediately, hit execute() on a
  // 0-worker pool, and each grew the pool -- an up-to-maxSize spawn storm on the
  // first burst of tool calls after boot. A failed init resets so a later call
  // can retry instead of being stuck on a rejected promise forever.
  if (!workerPoolInitPromise) {
    const pool = new SandboxWorkerPool(opts)
    globalWorkerPool = pool
    workerPoolInitPromise = pool.init().catch((err) => {
      if (globalWorkerPool === pool) {
        globalWorkerPool = null
        workerPoolInitPromise = null
      }
      throw err
    })
  }
  await workerPoolInitPromise
}

export function getWorkerPool(): SandboxWorkerPool {
  if (!globalWorkerPool)
    throw new Error("Worker pool not initialized — call initWorkerPool() first")
  return globalWorkerPool
}

export async function shutdownWorkerPool(): Promise<void> {
  if (globalWorkerPool) {
    await globalWorkerPool.shutdown()
    globalWorkerPool = null
    workerPoolInitPromise = null
  }
}
