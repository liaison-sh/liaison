// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one door app code runs through. Every site that runs an app's handler
// (tools, webhooks, jobs, event handlers, polls, search, attention providers,
// before-disconnect hooks, exports) calls `runApp`, and the choice of executor
// is made here, in `selectExecutor`, and nowhere else:
//
//   inprocess  trusted code, on the host's in-process QuickJS pool (executeInSandbox)
//   workers    an untrusted app listed for the remote V8 isolate loader
//              (LIAISON_WORKERS_APPS) whose installed version has a Worker
//              bundle (LIAISON_WORKERS_BUNDLES), or, with
//              LIAISON_WORKERS_CUSTOM_APPS=1, an org's custom app whose
//              installed row carries its Worker module's sha (0278), when
//              Workers is configured and this process has role "all"
//              (workers/config.ts)
//   pool       everything else, on the out-of-process worker pool
//
// A listed app that cannot run on Workers (no bundle for its installed
// version) runs on the pool with a warning per run. Every run of a listed app
// writes one timing record tagged with the executor that ran it
// (workers/timings.ts, kind "run").
//
// A new executor is one more arm of `selectExecutor` and of the switch in
// `runApp`; no call site changes. The sandboxes that do not run app handlers
// (tool summarizers, imports transforms, PDF templates, the mail sync bundle)
// stay outside this door.

import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { and, eq, isNotNull, isNull, or } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { flushRunLogs } from "~/modules/app-builder/logs"
import { isCustomAppName } from "~/modules/apps/custom-app-name"
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
  readWorkersConfig,
  type WorkersConfig,
  workersBundleSha,
  workersSelectsApp,
} from "~/modules/apps/workers/config"
import { executeOnWorkers, type WorkersRunInfo } from "~/modules/apps/workers/executor"
import { recordRunTiming } from "~/modules/apps/workers/timings"

const log = rootLogger.child({ module: "run-app" })

/** The installed version an app runs at, and the sha256 of its package. */
export interface InstalledIdentity {
  version: string
  sha256: string
  /**
   * The sha256 of the version's Worker module recorded at install (an org's
   * custom app built by the app builder, 0278), null when none. Undefined:
   * not read (a caller-supplied identity); read when a custom app needs it.
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
  bridge: Record<string, (...args: any[]) => any>
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

/** Which executor runs this call. */
export type AppExecutor = "inprocess" | "pool" | "workers"

/**
 * THE executor choice: trusted code in-process; an untrusted run with a Workers
 * bundle (resolved by `resolveWorkersTarget`) on Workers; everything else in
 * the worker pool. A further executor is added here (and in `runApp`'s switch)
 * only.
 */
export function selectExecutor(opts: {
  trusted: boolean
  workersBundleSha?: string | undefined
}): AppExecutor {
  if (opts.trusted) return "inprocess"
  return opts.workersBundleSha ? "workers" : "pool"
}

/** Where a Workers run goes: the configuration, the installed version and its bundle. */
export interface WorkersTarget {
  config: WorkersConfig
  version: string
  sha256: string
}

/**
 * The Workers target of a run, or null (QuickJS). Only an untrusted app chosen
 * by a usable Workers configuration is looked at (listed, or a custom app with
 * LIAISON_WORKERS_CUSTOM_APPS): a custom app's Worker module is the one its
 * installed row names (the build its publish pinned), a listed app's the
 * LIAISON_WORKERS_BUNDLES entry. One with no module for its installed version
 * warns (every run) and runs on the pool.
 */
export async function resolveWorkersTarget(
  opts: Pick<RunAppOptions, "trusted" | "appName" | "orgId" | "installed" | "bundlePath">,
): Promise<WorkersTarget | null> {
  if (opts.trusted) return null
  const config = readWorkersConfig()
  if (!config || !workersSelectsApp(config, opts.appName)) return null
  let identity =
    opts.installed !== undefined
      ? opts.installed
      : await resolveInstalledIdentity(opts.appName, opts.orgId, opts.bundlePath)
  const custom = config.customApps && isCustomAppName(opts.appName)
  if (custom && identity && identity.workerSha256 === undefined) {
    // A caller-supplied identity carries no module: the row of that version does.
    identity = await readIdentity(opts.appName, opts.orgId, identity.version)
  }
  const sha = !identity
    ? undefined
    : custom
      ? (identity.workerSha256 ?? workersBundleSha(config, opts.appName, identity.version))
      : workersBundleSha(config, opts.appName, identity.version)
  if (!identity || !sha) {
    log.warn(
      { app: opts.appName, orgId: opts.orgId, version: identity?.version ?? null },
      "App listed for Workers has no Worker bundle for its installed version; running on QuickJS",
    )
    return null
  }
  return { config, version: identity.version, sha256: sha }
}

/** Whether this run would go to Workers (a site that builds a bridge per executor asks). */
export async function appRunsOnWorkers(
  opts: Pick<RunAppOptions, "trusted" | "appName" | "orgId" | "installed" | "bundlePath">,
): Promise<boolean> {
  return (await resolveWorkersTarget(opts)) !== null
}

/**
 * Whether this app's runs write a timing record: listed in LIAISON_WORKERS_APPS
 * (whatever else is set), or a custom app while LIAISON_WORKERS_CUSTOM_APPS is on.
 */
function isTimedApp(appName: string): boolean {
  if (timedApps().has(appName)) return true
  const flag = (env.LIAISON_WORKERS_CUSTOM_APPS ?? "").trim().toLowerCase()
  return (flag === "1" || flag === "true") && isCustomAppName(appName)
}

/** The apps LIAISON_WORKERS_APPS lists. */
function timedApps(): ReadonlySet<string> {
  const raw = env.LIAISON_WORKERS_APPS ?? ""
  if (raw === timedAppsRaw) return timedAppsSet
  timedAppsRaw = raw
  timedAppsSet = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return timedAppsSet
}
let timedAppsRaw = ""
let timedAppsSet: ReadonlySet<string> = new Set()

/** Running executions by token -> app, so a nested run's record names its parent app. */
const runningExecutions = new Map<string, string>()

export async function runApp(opts: RunAppOptions): Promise<unknown> {
  const timed = isTimedApp(opts.appName)
  const started = Date.now()
  if (opts.executionToken) runningExecutions.set(opts.executionToken, opts.appName)
  const workersTarget = await resolveWorkersTarget(opts)
  const executor = selectExecutor({
    trusted: opts.trusted,
    workersBundleSha: workersTarget?.sha256,
  })
  let info: WorkersRunInfo = {}
  let ok = false
  try {
    const result = await runOnExecutor(opts, executor, workersTarget, (i) => {
      info = i
    })
    ok = true
    return result
  } finally {
    if (opts.executionToken) runningExecutions.delete(opts.executionToken)
    // A custom app's (or draft preview's) log lines: written in the background,
    // never the run's failure (modules/app-builder/logs.ts).
    void flushRunLogs(opts.bridge)
    if (timed) {
      const parentApp =
        opts.nested && opts.nestedParentKey
          ? runningExecutions.get(opts.nestedParentKey)
          : undefined
      recordRunTiming({
        kind: "run",
        ...(info.runId ? { runId: info.runId } : {}),
        app: opts.appName,
        entry:
          opts.entry ?? (opts.toolName ? `tool:${opts.toolName}` : `handler:${opts.exportName}`),
        executor: executor === "pool" ? "quickjs" : executor,
        nested: opts.nested === true,
        ...(parentApp ? { parentApp } : {}),
        ms: Date.now() - started,
        ok,
        at: started,
        ...(info.loader ? { loader: info.loader } : {}),
        ...(info.sleepMs !== undefined ? { sleepMs: info.sleepMs } : {}),
        ...(info.sleepExact !== undefined ? { sleepExact: info.sleepExact } : {}),
      })
    }
  }
}

async function runOnExecutor(
  opts: RunAppOptions,
  executor: AppExecutor,
  workersTarget: WorkersTarget | null,
  onInfo: (info: WorkersRunInfo) => void,
): Promise<unknown> {
  // A custom app's code never holds a secret, on any executor (A5). Its bridge
  // is built secret-free (rpc-bridge.ts); one built elsewhere is marked here,
  // before any call.
  if (isCustomAppName(opts.appName) && !isWorkersRunBridge(opts.bridge)) {
    forWorkersRun(opts.bridge, {
      secretConfigKeys: secretConfigKeysOf(opts.bridge),
      reason: "custom_app",
    })
  }
  if (executor === "workers" && workersTarget) {
    // The isolate lives off this server: no method may hand it a secret. The
    // dispatching site may have built the bridge so already (workersRun);
    // otherwise it is marked here, before any call, in the caller's frame. The
    // refused config keys are the ones the bridge's own config_get decrypts
    // (recorded on it when it was built); a bridge that records none refuses
    // every config_get (fail closed).
    const bridge = isWorkersRunBridge(opts.bridge)
      ? opts.bridge
      : forWorkersRun(opts.bridge, { secretConfigKeys: secretConfigKeysOf(opts.bridge) })
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
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        holdsTx: opts.holdsTx,
        nested: opts.nested === true,
        ...(opts.nestedParentKey !== undefined ? { nestedParentKey: opts.nestedParentKey } : {}),
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
    case "workers":
      throw new Error(`runApp(${opts.appName}:${opts.exportName}): Workers run without a target`)
    default: {
      const never: never = executor
      throw new Error(`Unknown app executor: ${String(never)}`)
    }
  }
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
 * The Worker module bytes an installed custom app version recorded for `sha256`
 * (0278), re-hashed on read, or null: no row of an org's custom app (any org of
 * this cell, any installed version, not disabled) names that sha, or its bytes
 * no longer hash to it. Never a draft's bytes: the column is written only by a
 * publish's install. Read by the cell's bundle route for the app loader
 * (workers/bundle-route.ts).
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
      .where(
        and(
          eq(appsInstalled.workerSha256, sha256),
          isNotNull(appsInstalled.orgId),
          isNull(appsInstalled.disabledAt),
        ),
      )
      .limit(2),
  )
  for (const row of rows) {
    if (!row.bytes || !isCustomAppName(row.name)) continue
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
