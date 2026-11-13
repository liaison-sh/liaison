// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one door app code runs through. Every site that runs sandboxed code
// (tools, preflights, webhooks, jobs, event handlers, polls, reconciles,
// search, attention providers, before-disconnect hooks, exports, import kinds,
// import transforms, PDF templates, approval summarizers, app-builder
// previews, the mail send bundle) calls `runApp`, and the choice of executor is
// made here, in `selectExecutor`, and nowhere else (one-door.test.ts fails on a
// site that calls an executor itself):
//
//   inprocess  a site that keeps its QuickJS run in process (`quickjs.inProcess`:
//              a pure function on an empty bridge), on the host's in-process
//              QuickJS pool, only while no remote executor takes it
//   workers    a (non-core) app whose installed version recorded a Worker
//              module (the package's worker.js, install-service.ts), when
//              the app loader is configured (workers/config.ts), in any role
//   workerd    the same run on this instance's own sandbox service
//              (LIAISON_SANDBOX_URL): every such run when no loader is
//              configured (a self-hosted instance), else the loader's
//              fallbacks (workers/fallback.ts)
//   pool       everything else, on the out-of-process worker pool (or the
//              site's own pool, `quickjs.workerPool`)
//   core       a core app's server module (core/registry.ts), called in this
//              process with a typed host ctx (core/run-core.ts); never a sandbox
//
//   LIAISON_APP_RUNTIME=quickjs  every run on QuickJS (this release only)
//   loader + Worker module       workers; a loader fault before any bridge
//                                call, an open breaker or an app fallback:
//                                workerd when the sandbox service is set,
//                                else QuickJS
//   sandbox service + module     workerd
//   no module, or neither set    QuickJS (a version without a Worker module
//                                warns per run)
//
// Code with no installed version (`installed: null`: a draft preview, an
// import transform, a PDF template) gets its module from its site
// (`workerModule`, built by workers/adhoc-module.ts with the builder of every
// package's worker.js) and runs like an installed app, with the same limits.
//
// A run is decided, then its bridge is built for that executor, then it
// runs: a remote run gets a secret-free bridge (the site's `workersBridge`, or a marked copy of
// `bridge`), a QuickJS run `bridge` itself, which runApp never changes. Every
// run raises one run-settled event (workers/run-settled.ts) once it has
// settled, tagged with the executor that ran it; the run timing records
// (workers/timings.ts, kind "run") and the usage rows are its subscribers.
//
// A new executor is one more arm of `selectExecutor` and of the switch in
// `runApp`; no call site changes.

import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { and, eq, isNull, or } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { rootLogger } from "~/lib/logger"
import { flushRunLogs } from "~/modules/app-builder/logs"
import { coreModuleFor } from "~/modules/apps/core/registry"
import { runCoreHandler } from "~/modules/apps/core/run-core"
import { isCustomAppName } from "~/modules/apps/custom-app-name"
import {
  entryKindOf,
  type RunEntryKind,
  runLaneOf,
  runLimits,
  runQueueBoundMs,
} from "~/modules/apps/run-limits"
import {
  forWorkersRun,
  isWorkersRunBridge,
  secretConfigKeysOf,
} from "~/modules/apps/sandbox/bridge/secret-free"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool, type SandboxPool } from "~/modules/apps/sandbox/pool"
import {
  type ExecPriority,
  getWorkerPool,
  initWorkerPool,
  type SandboxWorkerPool,
  type WorkerExecOptions,
} from "~/modules/apps/sandbox/worker-pool"
import { type AdhocModuleRef, readAdhocModule } from "~/modules/apps/workers/adhoc-module"
import {
  quickjsForced,
  readFallbackTarget,
  readSandboxConfig,
  readWorkersConfig,
  type WorkersConfig,
} from "~/modules/apps/workers/config"
import { executeOnWorkers, type WorkersRunInfo } from "~/modules/apps/workers/executor"
import {
  AppFallbacks,
  appFallbacks,
  fallbackTargetRunState,
  loaderBreaker,
} from "~/modules/apps/workers/fallback"
import {
  emitRunSettled,
  runErrorKindOf,
  type WorkersFallback,
} from "~/modules/apps/workers/run-settled"
import { appSandboxRelease } from "~/modules/apps/workers/sandbox-release"
import { deliverRunLogs } from "~/modules/apps/workers/worker-logs"
import { AppWorkerModuleMissingError } from "~/modules/apps/workers/worker-module-missing"
// The run timing records subscribe to the run-settled event (timings.ts).
import "~/modules/apps/workers/timings"

const log = rootLogger.child({ module: "run-app" })

/** The installed version an app runs at, and the sha256 of its package. */
export interface InstalledIdentity {
  version: string
  sha256: string
  /**
   * The sha256 of the version's Worker module recorded at install (the
   * package's worker.js, 0278), null when its package had none. Undefined: not
   * read (a caller-supplied identity); read when a Workers run needs it.
   */
  workerSha256?: string | null
}

export interface RunAppOptions {
  appName: string
  orgId: string
  /**
   * The installed-app record this run belongs to. Omitted: resolved on demand by
   * `resolveInstalledIdentity` (only an executor that needs it asks). `null`: the
   * app is not a runtime install (an in-tree app).
   */
  installed?: InstalledIdentity | null
  /**
   * The Worker module of code that has no installed version (`installed:
   * null`): a draft's preview, an import transform, a PDF template
   * (workers/adhoc-module.ts). Called only once the run is decided for a
   * remote executor; null: no module (the run stays on QuickJS, with a
   * warning). Throws when the code does not build: the run fails.
   */
  workerModule?: () => Promise<AdhocModuleRef | null>
  /** Where the bundle lives. Required when `bundleSource` is not given. */
  bundlePath?: string
  /** The bundle text, when the site has loaded (or reshaped) it already. */
  bundleSource?: string
  exportName: string
  params: unknown
  /** Positional args after `(params, ctx)`, e.g. a webhook's headers. */
  extraArgs?: unknown[]
  /**
   * The run's bridge on QuickJS. runApp never changes it (a custom app's is
   * secret-free on every executor already): a Workers run gets
   * `workersBridge`, or a secret-free copy of it.
   */
  bridge: AppBridge
  /**
   * Builds the bridge of a Workers run, when the site knows its secret
   * refusals better than runApp's marking (a webhook verifier's fixed secret
   * keys). Called only once the run is decided for Workers.
   */
  workersBridge?: () => AppBridge
  timeoutMs?: number
  signal?: AbortSignal
  priority?: ExecPriority
  /** The worker pool's tenant key; set by the sites that set it before. */
  appId?: string
  syncContext?: WorkerExecOptions["syncContext"]
  nested?: boolean
  nestedParentKey?: string
  backgroundGroup?: string
  toolName?: string
  /**
   * What kind of entry point this run is, as `<kind>:<name>` (`job:sync`,
   * `webhook:onOrder`, `event:onCreated`, ...), for the run timing record.
   * Tools need not set it (`tool:<toolName>`).
   */
  entry?: string
  /**
   * This run's own execution token, when the site minted one (tools): a nested
   * run names it as its `nestedParentKey`, which is how its record knows its
   * parent app.
   */
  executionToken?: string
  /**
   * The bridge holds an ambient database transaction open across the whole run
   * (atomic tools, primary webhook delivery, ambient jobs, event handlers, polls).
   * An executor whose bridge calls cannot reach that transaction must not take it.
   */
  holdsTx: boolean
  /**
   * Where this site's QuickJS run goes (the remote executors ignore it):
   * `inProcess` keeps the run on
   * the in-process pool (a pure function on an empty bridge: an approval
   * summarizer, a PDF template), `inProcessPool` names that pool (a bare unit
   * test), `workerPool` is the site's own out-of-process pool (import
   * transforms), with its heap limit and heap report.
   */
  quickjs?: {
    inProcess?: boolean
    inProcessPool?: SandboxPool
    workerPool?: SandboxWorkerPool
    memoryLimitBytes?: number
    onHeapReport?: WorkerExecOptions["onHeapReport"]
  }
}

export type AppBridge = Record<string, (...args: any[]) => any>

/** Which executor runs this call. */
export type AppExecutor = "core" | "inprocess" | "pool" | "workers" | "workerd"

/**
 * THE executor choice (the table at the top of this file). `workersBundleSha`:
 * the loader takes this run (`resolveWorkersTarget`, `planWorkersRun`);
 * `sandboxService`: the instance's sandbox service takes it instead.
 */
export function selectExecutor(opts: {
  /** The site keeps its QuickJS run on the in-process pool. */
  inProcess?: boolean
  workersBundleSha?: string | undefined
  sandboxService?: boolean
  /** LIAISON_APP_RUNTIME=quickjs. */
  quickjsForced?: boolean
}): AppExecutor {
  const quickjs = opts.inProcess ? "inprocess" : "pool"
  if (opts.quickjsForced) return quickjs
  if (opts.workersBundleSha) return "workers"
  return opts.sandboxService ? "workerd" : quickjs
}

/** Where a Workers run goes: the configuration, the installed version and its bundle. */
export interface WorkersTarget {
  config: WorkersConfig
  version: string
  sha256: string
}

/**
 * The remote target of a run, or null (QuickJS): the loader when it is
 * configured, else the instance's sandbox service, on the Worker module the
 * run's installed version recorded (the package's worker.js, recorded at
 * install). A version recorded without one is refused
 * (`AppWorkerModuleMissingError`, app_worker_module_missing): never QuickJS
 * behind the operator's back; the boot and every upkeep give such a version
 * the worker.js of its own package when it has one
 * (workers/worker-module-backfill.ts), and LIAISON_APP_RUNTIME=quickjs runs
 * every app on QuickJS (this release only). Code with no installed version (`installed: null`: a draft
 * preview, an import transform, a PDF template) runs on the module its site
 * builds (`workerModule`, workers/adhoc-module.ts); without one it stays on
 * QuickJS.
 */
export async function resolveWorkersTarget(
  opts: Pick<RunAppOptions, "appName" | "orgId" | "installed" | "bundlePath" | "workerModule">,
): Promise<WorkersTarget | null> {
  if (quickjsForced()) return null
  const config = readWorkersConfig() ?? readSandboxConfig(null)
  if (!config) return null
  if (opts.installed === null) {
    if (!opts.workerModule) return null
    const module = await opts.workerModule()
    if (!module) {
      log.warn(
        { app: opts.appName, orgId: opts.orgId },
        "Code without an installed version has no Worker module; running on QuickJS",
      )
      return null
    }
    return { config, version: module.version, sha256: module.sha256 }
  }
  let identity =
    opts.installed !== undefined
      ? opts.installed
      : await resolveInstalledIdentity(opts.appName, opts.orgId, opts.bundlePath)
  if (identity && identity.workerSha256 === undefined) {
    // A caller-supplied identity carries no module: the row of that version does.
    identity = await readIdentity(opts.appName, opts.orgId, identity.version)
  }
  if (identity && !identity.workerSha256) {
    log.error(
      { app: opts.appName, orgId: opts.orgId, version: identity.version },
      "App has no Worker module for its installed version; run refused",
    )
    throw new AppWorkerModuleMissingError(opts.appName, identity.version)
  }
  if (!identity?.workerSha256) {
    // No installed version at all (an app registered from source, in
    // development): nothing to run remotely.
    log.warn(
      { app: opts.appName, orgId: opts.orgId },
      "App has no installed version; running on QuickJS",
    )
    return null
  }
  return { config, version: identity.version, sha256: identity.workerSha256 }
}

/**
 * Where this run goes, decided once, before the run's bridge is built: the
 * loader (`target`), the instance's sandbox service (`sandboxTarget`), or
 * neither (QuickJS). With the loader configured, `sandboxTarget` is where the
 * run goes when it falls back (workers/fallback.ts), and `fallback` says why
 * the loader does not take it: `app` while this org's app@version is under an
 * app-level fallback, `breaker` while the loader breaker is open (or another
 * run holds the half-open probe). `probe` marks the run the half-open breaker
 * lets through. Without a loader, `sandboxTarget` is simply where it runs.
 */
export interface WorkersPlan {
  target: WorkersTarget | null
  fallback?: WorkersFallback
  probe?: boolean
  sandboxTarget?: WorkersTarget
}

/** The same run on the instance's sandbox service, or none (QuickJS) when it is not configured. */
export function sandboxTargetOf(target: WorkersTarget): WorkersTarget | undefined {
  const fb = readFallbackTarget(target.config)
  return fb.kind === "workerd" ? { ...target, config: fb.config } : undefined
}

export async function planWorkersRun(
  opts: Pick<RunAppOptions, "appName" | "orgId" | "installed" | "bundlePath" | "workerModule">,
): Promise<WorkersPlan> {
  const target = await resolveWorkersTarget(opts)
  if (!target) return { target: null }
  // No loader: the target is the sandbox service itself (a self-hosted instance).
  if (!readWorkersConfig()) return { target: null, sandboxTarget: target }
  const instead = sandboxTargetOf(target)
  const elsewhere = instead ? { sandboxTarget: instead } : {}
  if (appFallbacks.active(AppFallbacks.key(opts.orgId, opts.appName, target.version))) {
    return { target: null, fallback: "app", ...elsewhere }
  }
  const admission = loaderBreaker.admit()
  if (!admission.allow) return { target: null, fallback: "breaker", ...elsewhere }
  return admission.probe ? { target, probe: true } : { target }
}

/**
 * Running executions by token: the app (a nested run's record names its parent
 * app) and how deep the run is in a chain of nested runs (0 top-level).
 */
const runningExecutions = new Map<string, { app: string; depth: number }>()

/** A run's depth: one below its parent's, when it is nested under a running one. */
function runDepthOf(opts: Pick<RunAppOptions, "nested" | "nestedParentKey">): number {
  if (!opts.nested) return 0
  const parent = opts.nestedParentKey ? runningExecutions.get(opts.nestedParentKey) : undefined
  return (parent?.depth ?? 0) + 1
}

export async function runApp(opts: RunAppOptions): Promise<unknown> {
  const started = Date.now()
  const depth = runDepthOf(opts)
  if (opts.executionToken) {
    runningExecutions.set(opts.executionToken, { app: opts.appName, depth })
  }
  let info: WorkersRunInfo = {}
  let ok = false
  let executor: AppExecutor = selectExecutor({
    inProcess: opts.quickjs?.inProcess === true,
  })
  let fallback: WorkersFallback | undefined
  let failure: unknown
  try {
    // A core app's handler is server code: called here, whatever the site asked.
    const core = coreModuleFor(opts.appName, opts.bundlePath)
    if (core) {
      executor = "core"
      const result = await runCoreHandler({
        module: core,
        appName: opts.appName,
        exportName: opts.exportName,
        params: opts.params,
        ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
        bridge: opts.bridge,
        holdsTx: opts.holdsTx,
        approval: opts.syncContext?.approval ?? null,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
      ok = true
      return result
    }
    // Decide, then build the bridge for that executor (runOnExecutor), then run.
    const plan = await planWorkersRun(opts)
    fallback = plan.fallback
    executor = selectExecutor({
      inProcess: opts.quickjs?.inProcess === true,
      workersBundleSha: plan.target?.sha256,
      sandboxService: plan.sandboxTarget !== undefined,
    })
    let result: unknown
    try {
      result = await runOnExecutor(opts, executor, plan, (i) => {
        info = i
      })
    } catch (err) {
      if (executor !== "workers" || !fallsBackAfterLoaderFault(info, opts.signal)) throw err
      // Nothing the app did can have happened (no bridge call): the run goes
      // once to the fallback target (the sandbox service on a secret-free
      // bridge, else QuickJS on the bridge built for it), within what is left
      // of its budget.
      const sandboxTarget = plan.target ? sandboxTargetOf(plan.target) : undefined
      const budget = opts.timeoutMs ?? runLimits(runEntryKind(opts)).wallMs
      const remaining = Math.max(MIN_FALLBACK_BUDGET_MS, budget - (Date.now() - started))
      log.warn(
        {
          err,
          app: opts.appName,
          orgId: opts.orgId,
          kind: info.fault?.kind,
          attempts: info.attempts,
          remainingMs: remaining,
        },
        sandboxTarget
          ? "App loader fault before any bridge call; running this run on the sandbox service"
          : "App loader fault before any bridge call; running this run on QuickJS",
      )
      fallback = "loader_fault"
      executor = selectExecutor({
        inProcess: opts.quickjs?.inProcess === true,
        sandboxService: sandboxTarget !== undefined,
      })
      const loaderAttempts = info
      result = await runOnExecutor(
        { ...opts, timeoutMs: remaining },
        executor,
        { target: null, ...(sandboxTarget ? { sandboxTarget } : {}) },
        // The sandbox service's run (its id, bridge calls, logs) with the
        // loader's attempts and fault, which are why it ran there.
        (i) => {
          info = { ...i, attempts: loaderAttempts.attempts, fault: loaderAttempts.fault }
        },
      )
    }
    ok = true
    return result
  } catch (err) {
    failure = err
    throw err
  } finally {
    if (opts.executionToken) runningExecutions.delete(opts.executionToken)
    if (info.logs || info.logsDropped) {
      deliverRunLogs({
        bridge: opts.bridge,
        app: opts.appName,
        orgId: opts.orgId,
        ...(info.runId ? { runId: info.runId } : {}),
        logs: info.logs ?? [],
        ...(info.logsDropped ? { dropped: info.logsDropped } : {}),
      })
    }
    // A custom app's (or draft preview's) log lines: written in the background,
    // never the run's failure (modules/app-builder/logs.ts).
    void flushRunLogs(opts.bridge)
    const parentApp =
      opts.nested && opts.nestedParentKey
        ? runningExecutions.get(opts.nestedParentKey)?.app
        : undefined
    emitRunSettled({
      ...(info.runId ? { runId: info.runId } : {}),
      app: opts.appName,
      orgId: opts.orgId,
      entry: opts.entry ?? (opts.toolName ? `tool:${opts.toolName}` : `handler:${opts.exportName}`),
      // A core run is server code, recorded as in-process.
      executor: executor === "pool" ? "quickjs" : executor === "core" ? "inprocess" : executor,
      nested: opts.nested === true,
      ...(parentApp ? { parentApp } : {}),
      lane: runLaneOf(opts),
      ms: Date.now() - started,
      ...(info.admissionMs !== undefined ? { admissionMs: info.admissionMs } : {}),
      ok,
      at: started,
      ...(info.bridgeCalls !== undefined ? { bridgeCalls: info.bridgeCalls } : {}),
      ...(info.loader ? { loader: info.loader } : {}),
      ...(info.sleepMs !== undefined ? { sleepMs: info.sleepMs } : {}),
      ...(info.cpuMs !== undefined ? { cpuMs: info.cpuMs } : {}),
      ...(info.sleepExact !== undefined ? { sleepExact: info.sleepExact } : {}),
      ...(fallback ? { fallback } : {}),
      ...(info.attempts !== undefined ? { attempts: info.attempts } : {}),
      ...(info.fault
        ? { errorKind: info.fault.kind, faultClass: info.fault.class }
        : !ok
          ? { errorKind: runErrorKindOf(failure) }
          : {}),
    })
  }
}

/** A QuickJS run after a loader fault never gets less than this, whatever the budget left. */
const MIN_FALLBACK_BUDGET_MS = 1_000

/**
 * A failed Workers run that runs again on QuickJS: its last attempt met a
 * loader-level fault (the retry already made or skipped, executor.ts) and no
 * attempt made a bridge call, and the caller is still waiting.
 */
function fallsBackAfterLoaderFault(info: WorkersRunInfo, signal?: AbortSignal): boolean {
  return info.fault?.class === "loader" && (info.bridgeCalls ?? 0) === 0 && !signal?.aborted
}

/**
 * A secret-free copy of a QuickJS bridge for a Workers run: the same methods
 * and markers (its own properties, symbols included), refusals on the copy
 * only, so the original stays the QuickJS bridge.
 */
function workersCopyOf(bridge: AppBridge): AppBridge {
  const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(bridge)) as AppBridge
  return forWorkersRun(copy, { secretConfigKeys: secretConfigKeysOf(bridge) })
}

/** A background run's own queue bound (run-limits.ts runQueueBoundMs), when it has one. */
function queueBoundOpt(opts: RunAppOptions): { queueMs?: number } {
  const queueMs = runQueueBoundMs(opts)
  return queueMs === undefined ? {} : { queueMs }
}

async function runOnExecutor(
  opts: RunAppOptions,
  executor: AppExecutor,
  plan: WorkersPlan,
  onInfo: (info: WorkersRunInfo) => void,
): Promise<unknown> {
  const workersTarget = executor === "workerd" ? plan.sandboxTarget : plan.target
  // A custom app's code never holds a secret, on any executor. Its bridge
  // is built secret-free (rpc-bridge.ts); one built elsewhere is marked here,
  // before any call.
  if (isCustomAppName(opts.appName) && !isWorkersRunBridge(opts.bridge)) {
    forWorkersRun(opts.bridge, {
      secretConfigKeys: secretConfigKeysOf(opts.bridge),
      reason: "custom_app",
    })
  }
  if ((executor === "workers" || executor === "workerd") && workersTarget) {
    // The isolate lives off this server: no method may hand it a secret. The
    // site may build that bridge itself (workersBridge), or have built a
    // secret-free one already (a custom app's); otherwise a copy is marked
    // here, before any call, in the caller's frame. The refused config keys
    // are the ones the bridge's own config_get decrypts (recorded on it when
    // it was built); a bridge that records none refuses every config_get
    // (fail closed).
    const bridge = opts.workersBridge
      ? opts.workersBridge()
      : isWorkersRunBridge(opts.bridge)
        ? opts.bridge
        : workersCopyOf(opts.bridge)
    if (!isWorkersRunBridge(bridge)) {
      throw new Error(`runApp(${opts.appName}): the Workers bridge is not secret-free`)
    }
    return executeOnWorkers(
      {
        config: workersTarget.config,
        appName: opts.appName,
        orgId: opts.orgId,
        version: workersTarget.version,
        bundleSha256: workersTarget.sha256,
        exportName: opts.exportName,
        params: opts.params,
        ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
        approval: opts.syncContext?.approval ?? null,
        bridge,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        entryKind: runEntryKind(opts),
        lane: runLaneOf(opts),
        ...queueBoundOpt(opts),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        holdsTx: opts.holdsTx,
        nested: opts.nested === true,
        ...(opts.nestedParentKey !== undefined ? { nestedParentKey: opts.nestedParentKey } : {}),
        ...(plan.probe ? { probe: true } : {}),
        runDepth: runDepthOf(opts),
        // The sandbox service's runs leave the loader's breaker and app
        // fallbacks alone, and have nothing further to fall back to. It
        // holds no key to fetch a module: the module is pushed.
        ...(executor === "workerd"
          ? {
              ...fallbackTargetRunState(),
              sandboxRelease: appSandboxRelease(),
              pushModule: async () =>
                (await readRunnableWorkerModule(workersTarget.sha256))?.bytes ?? null,
            }
          : {}),
      },
      onInfo,
    )
  }
  const bundleSource = opts.bundleSource ?? (await loadBundleFor(opts))
  switch (executor) {
    case "inprocess":
      return executeInSandbox({
        pool: opts.quickjs?.inProcessPool ?? getSandboxPool(),
        bundleSource,
        exportName: opts.exportName,
        params: opts.params,
        bridge: opts.bridge,
        ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
    case "pool": {
      const own = opts.quickjs?.workerPool
      if (!own) await initWorkerPool()
      const exec: WorkerExecOptions = {
        bundleSource,
        exportName: opts.exportName,
        params: opts.params,
        bridge: opts.bridge,
      }
      if (opts.extraArgs !== undefined) exec.extraArgs = opts.extraArgs
      if (opts.timeoutMs !== undefined) exec.timeoutMs = opts.timeoutMs
      if (opts.syncContext !== undefined) exec.syncContext = opts.syncContext
      exec.priority = runLaneOf(opts)
      const queue = runQueueBoundMs(opts)
      if (queue !== undefined) exec.queueMs = queue
      if (opts.backgroundGroup !== undefined) exec.backgroundGroup = opts.backgroundGroup
      if (opts.nested !== undefined) exec.nested = opts.nested
      if (opts.nestedParentKey !== undefined) exec.nestedParentKey = opts.nestedParentKey
      if (opts.signal !== undefined) exec.signal = opts.signal
      if (opts.appId !== undefined) exec.appId = opts.appId
      if (opts.toolName !== undefined) exec.toolName = opts.toolName
      if (opts.quickjs?.memoryLimitBytes !== undefined) {
        exec.memoryLimitBytes = opts.quickjs.memoryLimitBytes
      }
      if (opts.quickjs?.onHeapReport !== undefined) exec.onHeapReport = opts.quickjs.onHeapReport
      return (own ?? getWorkerPool()).execute(exec)
    }
    case "core":
    case "workers":
    case "workerd":
      throw new Error(
        `runApp(${opts.appName}:${opts.exportName}): ${executor} run without a target`,
      )
    default: {
      const never: never = executor
      throw new Error(`Unknown app executor: ${String(never)}`)
    }
  }
}

/** The run's row of the limit table: its entry label's kind, a tool's when it names none. */
function runEntryKind(opts: Pick<RunAppOptions, "entry">): RunEntryKind {
  return (opts.entry ? entryKindOf(opts.entry) : null) ?? "tool"
}

function loadBundleFor(opts: RunAppOptions): Promise<string> {
  if (!opts.bundlePath) {
    throw new Error(`runApp(${opts.appName}:${opts.exportName}) needs a bundlePath or bundleSource`)
  }
  return loadBundle(opts.bundlePath)
}

// -- Installed identity --------------------------------------------------------

const identityCache = new Map<string, InstalledIdentity | null>()

/**
 * The installed version and package sha256 an app runs at for an org, from the
 * installed-app record (`kernel.apps_installed`). `null` for an app that is not
 * a runtime install (an in-tree app, or no visible record).
 *
 * With a `bundlePath` under the install layout (`<root>/<app>/<version>/bundle.js`)
 * the version is the bundle's own version directory and the answer is cached per
 * process per version directory (and org): a version directory only ever holds
 * one version. Without one, the org's active version is read, uncached.
 */
export async function resolveInstalledIdentity(
  appName: string,
  orgId: string,
  bundlePath?: string,
): Promise<InstalledIdentity | null> {
  if (bundlePath === undefined) return readActiveIdentity(appName, orgId)
  const versionDir = dirname(bundlePath)
  const key = `${orgId}\0${versionDir}`
  if (identityCache.has(key)) return identityCache.get(key) ?? null
  const version = versionOfInstalledBundle(appName, versionDir)
  const identity = version === null ? null : await readIdentity(appName, orgId, version)
  identityCache.set(key, identity)
  return identity
}

/** Forget every cached identity (an activation, or a test). */
export function clearInstalledIdentityCache(): void {
  identityCache.clear()
}

/** `<root>/<app>/<version>` -> `<version>`; anything else is not an installed bundle. */
function versionOfInstalledBundle(appName: string, versionDir: string): string | null {
  const appDir = dirname(versionDir)
  if (appDir === versionDir || appDir.split(/[\\/]/).pop() !== appName) return null
  const version = versionDir.split(/[\\/]/).pop()
  return version && !version.startsWith(".") ? version : null
}

const visibleTo = (orgId: string) => or(isNull(appsInstalled.orgId), eq(appsInstalled.orgId, orgId))

async function readIdentity(
  appName: string,
  orgId: string,
  version: string,
): Promise<InstalledIdentity | null> {
  const [row] = await withSystemDb("run-app:installed-identity", (db) =>
    db
      .select({
        version: appsInstalled.version,
        sha256: appsInstalled.sha256,
        workerSha256: appsInstalled.workerSha256,
      })
      .from(appsInstalled)
      .where(
        and(eq(appsInstalled.name, appName), eq(appsInstalled.version, version), visibleTo(orgId)),
      )
      .limit(1),
  )
  return row ?? null
}

async function readActiveIdentity(
  appName: string,
  orgId: string,
): Promise<InstalledIdentity | null> {
  const [row] = await withSystemDb("run-app:active-identity", (db) =>
    db
      .select({
        version: appsInstalled.version,
        sha256: appsInstalled.sha256,
        workerSha256: appsInstalled.workerSha256,
      })
      .from(appsActiveVersion)
      .innerJoin(
        appsInstalled,
        and(
          eq(appsInstalled.name, appsActiveVersion.name),
          eq(appsInstalled.version, appsActiveVersion.version),
        ),
      )
      .where(and(eq(appsActiveVersion.name, appName), visibleTo(orgId)))
      .limit(1),
  )
  return row ?? null
}

/**
 * The bytes of any Worker module a run may name: an installed version's
 * (`readInstalledWorkerModule`), else a module the platform built for code
 * with no installed version (workers/adhoc-module.ts). Read by the cell's
 * bundle route for the app loader and pushed to the sandbox service.
 */
export async function readRunnableWorkerModule(
  sha256: string,
): Promise<{ bytes: Uint8Array } | null> {
  const installed = await readInstalledWorkerModule(sha256)
  if (installed) return installed
  const adhoc = await readAdhocModule(sha256)
  return adhoc ? { bytes: adhoc } : null
}

/**
 * The Worker module bytes an installed app version recorded for `sha256` (its
 * package's worker.js, 0278), re-hashed on read, or null: no installed, not
 * disabled version of any app (an instance app or an org's custom app, any org
 * of this cell) names that sha, or its bytes no longer hash to it. Never a
 * draft's bytes: the column is written only by an install.
 */
export async function readInstalledWorkerModule(
  sha256: string,
): Promise<{ appName: string; version: string; bytes: Uint8Array } | null> {
  const rows = await withSystemDb("run-app:installed-worker-module", (db) =>
    db
      .select({
        name: appsInstalled.name,
        version: appsInstalled.version,
        bytes: appsInstalled.workerModule,
      })
      .from(appsInstalled)
      .where(and(eq(appsInstalled.workerSha256, sha256), isNull(appsInstalled.disabledAt)))
      .limit(2),
  )
  for (const row of rows) {
    if (!row.bytes) continue
    if (createHash("sha256").update(row.bytes).digest("hex") !== sha256) {
      log.error(
        { app: row.name, version: row.version, sha256 },
        "Installed Worker module does not match its recorded sha256",
      )
      continue
    }
    return { appName: row.name, version: row.version, bytes: row.bytes }
  }
  return null
}
