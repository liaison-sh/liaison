// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one door app code runs through. Every site that runs an app's handler
// (tools, webhooks, jobs, event handlers, polls, search, attention providers,
// before-disconnect hooks, exports) calls `runApp`, and the choice of executor
// is made here, in `selectExecutor`, and nowhere else:
//
//   inprocess  trusted code, on the host's in-process QuickJS pool (executeInSandbox)
//   workers    an untrusted app whose installed version recorded a Worker
//              module (the package's worker.js, install-service.ts), when
//              the app loader is configured (workers/config.ts), in any role
//   workerd    the same run on this instance's own sandbox service, when the
//              loader cannot take it and that service is configured
//              (workers/config.ts readFallbackTarget)
//   pool       everything else, on the out-of-process worker pool
//   core       a core app's server module (core/registry.ts), called in this
//              process with a typed host ctx (core/run-core.ts); never a sandbox
//
// An app that cannot run on Workers (its installed version came from a
// package without a Worker module) runs on the pool with a warning per run.
// A run is decided, then its bridge is built for that executor, then it
// runs: a Workers run gets a secret-free bridge (the site's `workersBridge`, or a marked copy of
// `bridge`), a QuickJS run `bridge` itself, which runApp never changes. A
// Workers run whose attempts end on a loader-level fault before any bridge
// call runs once more on the fallback target (`fallback: "loader_fault"`,
// workers/fallback.ts): the instance's sandbox service on a secret-free bridge
// when configured, else QuickJS on `bridge`; never after a bridge call. Every run raises one
// run-settled event (workers/run-settled.ts) once it has settled, tagged with
// the executor that ran it; the run timing records (workers/timings.ts, kind
// "run") are one of its subscribers.
//
// A new executor is one more arm of `selectExecutor` and of the switch in
// `runApp`; no call site changes. The sandboxes that do not run app handlers
// (tool summarizers, imports transforms, PDF templates, the mail sync bundle)
// stay outside this door.

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
import { entryKindOf, type RunEntryKind, runLimits } from "~/modules/apps/run-limits"
import {
  forWorkersRun,
  isWorkersRunBridge,
  secretConfigKeysOf,
} from "~/modules/apps/sandbox/bridge/secret-free"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  type ExecPriority,
  getWorkerPool,
  initWorkerPool,
  type WorkerExecOptions,
} from "~/modules/apps/sandbox/worker-pool"
import {
  readFallbackTarget,
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
import { emitRunSettled, type WorkersFallback } from "~/modules/apps/workers/run-settled"
import { deliverRunLogs } from "~/modules/apps/workers/worker-logs"
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
  /** The handler is platform code: it may run in-process. */
  trusted: boolean
  appName: string
  orgId: string
  /**
   * The installed-app record this run belongs to. Omitted: resolved on demand by
   * `resolveInstalledIdentity` (only an executor that needs it asks). `null`: the
   * app is not a runtime install (an in-tree app).
   */
  installed?: InstalledIdentity | null
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
}

export type AppBridge = Record<string, (...args: any[]) => any>

/** Which executor runs this call. */
export type AppExecutor = "core" | "inprocess" | "pool" | "workers" | "workerd"

/**
 * THE executor choice: trusted code in-process; an untrusted run with a Workers
 * bundle (resolved by `resolveWorkersTarget`) on Workers; everything else in
 * the worker pool. A further executor is added here (and in `runApp`'s switch)
 * only.
 */
export function selectExecutor(opts: {
  trusted: boolean
  workersBundleSha?: string | undefined
  /** The loader cannot take this run and the instance's sandbox service is configured. */
  fallbackService?: boolean
}): AppExecutor {
  if (opts.trusted) return "inprocess"
  if (opts.workersBundleSha) return "workers"
  return opts.fallbackService ? "workerd" : "pool"
}

/** Where a Workers run goes: the configuration, the installed version and its bundle. */
export interface WorkersTarget {
  config: WorkersConfig
  version: string
  sha256: string
}

/**
 * The Workers target of a run, or null (QuickJS). Every untrusted app runs
 * there when the loader is configured, on the Worker module its installed row
 * names (the package's worker.js, recorded at install). A version whose
 * package had none warns (every run) and runs on the pool.
 */
export async function resolveWorkersTarget(
  opts: Pick<RunAppOptions, "trusted" | "appName" | "orgId" | "installed" | "bundlePath">,
): Promise<WorkersTarget | null> {
  if (opts.trusted) return null
  const config = readWorkersConfig()
  if (!config) return null
  let identity =
    opts.installed !== undefined
      ? opts.installed
      : await resolveInstalledIdentity(opts.appName, opts.orgId, opts.bundlePath)
  if (identity && identity.workerSha256 === undefined) {
    // A caller-supplied identity carries no module: the row of that version does.
    identity = await readIdentity(opts.appName, opts.orgId, identity.version)
  }
  if (!identity?.workerSha256) {
    log.warn(
      { app: opts.appName, orgId: opts.orgId, version: identity?.version ?? null },
      "App has no Worker module for its installed version; running on QuickJS",
    )
    return null
  }
  return { config, version: identity.version, sha256: identity.workerSha256 }
}

/**
 * Where this run goes, decided once, before the run's bridge is built: the
 * Workers target, or none with the reason it falls back (workers/fallback.ts):
 * `app` while this org's app@version is under an app-level fallback,
 * `breaker` while the loader breaker is open (or another run holds the
 * half-open probe). `probe` marks the run the half-open breaker lets through.
 */
export interface WorkersPlan {
  target: WorkersTarget | null
  fallback?: WorkersFallback
  probe?: boolean
  /** Where the run goes instead, when it falls back and the sandbox service is configured. */
  fallbackTarget?: WorkersTarget
}

/** The same run on the instance's sandbox service, or none (QuickJS) when it is not configured. */
export function fallbackTargetOf(target: WorkersTarget): WorkersTarget | undefined {
  const fb = readFallbackTarget(target.config)
  return fb.kind === "workerd" ? { ...target, config: fb.config } : undefined
}

export async function planWorkersRun(
  opts: Pick<RunAppOptions, "trusted" | "appName" | "orgId" | "installed" | "bundlePath">,
): Promise<WorkersPlan> {
  const target = await resolveWorkersTarget(opts)
  if (!target) return { target: null }
  const instead = fallbackTargetOf(target)
  const elsewhere = instead ? { fallbackTarget: instead } : {}
  if (appFallbacks.active(AppFallbacks.key(opts.orgId, opts.appName, target.version))) {
    return { target: null, fallback: "app", ...elsewhere }
  }
  const admission = loaderBreaker.admit()
  if (!admission.allow) return { target: null, fallback: "breaker", ...elsewhere }
  return admission.probe ? { target, probe: true } : { target }
}

/** Running executions by token -> app, so a nested run's record names its parent app. */
const runningExecutions = new Map<string, string>()

export async function runApp(opts: RunAppOptions): Promise<unknown> {
  const started = Date.now()
  if (opts.executionToken) runningExecutions.set(opts.executionToken, opts.appName)
  let info: WorkersRunInfo = {}
  let ok = false
  let executor: AppExecutor = opts.trusted ? "inprocess" : "pool"
  let fallback: WorkersFallback | undefined
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
      trusted: opts.trusted,
      workersBundleSha: plan.target?.sha256,
      fallbackService: plan.fallbackTarget !== undefined,
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
      const fallbackTarget = plan.target ? fallbackTargetOf(plan.target) : undefined
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
        fallbackTarget
          ? "App loader fault before any bridge call; running this run on the sandbox service"
          : "App loader fault before any bridge call; running this run on QuickJS",
      )
      fallback = "loader_fault"
      executor = selectExecutor({
        trusted: opts.trusted,
        fallbackService: fallbackTarget !== undefined,
      })
      const loaderAttempts = info
      result = await runOnExecutor(
        { ...opts, timeoutMs: remaining },
        executor,
        { target: null, ...(fallbackTarget ? { fallbackTarget } : {}) },
        // The sandbox service's run (its id, bridge calls, logs) with the
        // loader's attempts and fault, which are why it ran there.
        (i) => {
          info = { ...i, attempts: loaderAttempts.attempts, fault: loaderAttempts.fault }
        },
      )
    }
    ok = true
    return result
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
      opts.nested && opts.nestedParentKey ? runningExecutions.get(opts.nestedParentKey) : undefined
    emitRunSettled({
      ...(info.runId ? { runId: info.runId } : {}),
      app: opts.appName,
      orgId: opts.orgId,
      entry: opts.entry ?? (opts.toolName ? `tool:${opts.toolName}` : `handler:${opts.exportName}`),
      // A core run is platform code, recorded like trusted in-process code.
      executor: executor === "pool" ? "quickjs" : executor === "core" ? "inprocess" : executor,
      nested: opts.nested === true,
      ...(parentApp ? { parentApp } : {}),
      ms: Date.now() - started,
      ok,
      at: started,
      ...(info.bridgeCalls !== undefined ? { bridgeCalls: info.bridgeCalls } : {}),
      ...(info.loader ? { loader: info.loader } : {}),
      ...(info.sleepMs !== undefined ? { sleepMs: info.sleepMs } : {}),
      ...(info.sleepExact !== undefined ? { sleepExact: info.sleepExact } : {}),
      ...(fallback ? { fallback } : {}),
      ...(info.attempts !== undefined ? { attempts: info.attempts } : {}),
      ...(info.fault ? { errorKind: info.fault.kind, faultClass: info.fault.class } : {}),
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

async function runOnExecutor(
  opts: RunAppOptions,
  executor: AppExecutor,
  plan: WorkersPlan,
  onInfo: (info: WorkersRunInfo) => void,
): Promise<unknown> {
  const workersTarget = executor === "workerd" ? plan.fallbackTarget : plan.target
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
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        holdsTx: opts.holdsTx,
        nested: opts.nested === true,
        ...(opts.nestedParentKey !== undefined ? { nestedParentKey: opts.nestedParentKey } : {}),
        ...(plan.probe ? { probe: true } : {}),
        // The fallback target's runs leave the loader's breaker and app
        // fallbacks alone, and have nothing further to fall back to.
        ...(executor === "workerd" ? fallbackTargetRunState() : {}),
      },
      onInfo,
    )
  }
  const bundleSource = opts.bundleSource ?? (await loadBundleFor(opts))
  switch (executor) {
    case "inprocess":
      return executeInSandbox({
        pool: getSandboxPool(),
        bundleSource,
        exportName: opts.exportName,
        params: opts.params,
        bridge: opts.bridge,
        ...(opts.extraArgs !== undefined ? { extraArgs: opts.extraArgs } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
    case "pool": {
      await initWorkerPool()
      const exec: WorkerExecOptions = {
        bundleSource,
        exportName: opts.exportName,
        params: opts.params,
        bridge: opts.bridge,
      }
      if (opts.extraArgs !== undefined) exec.extraArgs = opts.extraArgs
      if (opts.timeoutMs !== undefined) exec.timeoutMs = opts.timeoutMs
      if (opts.syncContext !== undefined) exec.syncContext = opts.syncContext
      if (opts.priority !== undefined) exec.priority = opts.priority
      if (opts.backgroundGroup !== undefined) exec.backgroundGroup = opts.backgroundGroup
      if (opts.nested !== undefined) exec.nested = opts.nested
      if (opts.nestedParentKey !== undefined) exec.nestedParentKey = opts.nestedParentKey
      if (opts.signal !== undefined) exec.signal = opts.signal
      if (opts.appId !== undefined) exec.appId = opts.appId
      if (opts.toolName !== undefined) exec.toolName = opts.toolName
      return getWorkerPool().execute(exec)
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
 * The Worker module bytes an installed app version recorded for `sha256` (its
 * package's worker.js, 0278), re-hashed on read, or null: no installed, not
 * disabled version of any app (an instance app or an org's custom app, any org
 * of this cell) names that sha, or its bytes no longer hash to it. Never a
 * draft's bytes: the column is written only by an install. Read by the cell's
 * bundle route for the app loader (workers/bundle-route.ts).
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
