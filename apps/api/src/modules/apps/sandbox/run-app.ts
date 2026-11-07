// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one door app code runs through. Every site that runs an app's handler
// (tools, webhooks, jobs, event handlers, polls, search, attention providers,
// before-disconnect hooks, exports) calls `runApp`, and the choice of executor
// is made here, in `selectExecutor`, and nowhere else:
//
//   inprocess  trusted code, on the host's in-process QuickJS pool (executeInSandbox)
//   pool       everything else, on the out-of-process worker pool
//
// A new executor is one more arm of `selectExecutor` and of the switch in
// `runApp`; no call site changes. The sandboxes that do not run app handlers
// (tool summarizers, imports transforms, PDF templates, the mail sync bundle)
// stay outside this door.

import { dirname } from "node:path"
import { and, eq, isNull, or } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { getSandboxPool } from "~/modules/apps/sandbox/pool"
import {
  type ExecPriority,
  getWorkerPool,
  initWorkerPool,
  type WorkerExecOptions,
} from "~/modules/apps/sandbox/worker-pool"

/** The installed version an app runs at, and the sha256 of its package. */
export interface InstalledIdentity {
  version: string
  sha256: string
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
   * The bridge holds an ambient database transaction open across the whole run
   * (atomic tools, primary webhook delivery, ambient jobs, event handlers, polls).
   * An executor whose bridge calls cannot reach that transaction must not take it.
   */
  holdsTx: boolean
}

/** Which executor runs this call. */
export type AppExecutor = "inprocess" | "pool"

/**
 * THE executor choice. Today: trusted code in-process, everything else in the
 * worker pool, exactly as every site chose before the funnel. A further executor
 * is added here (and in `runApp`'s switch) only.
 */
export function selectExecutor(opts: Pick<RunAppOptions, "trusted">): AppExecutor {
  return opts.trusted ? "inprocess" : "pool"
}

export async function runApp(opts: RunAppOptions): Promise<unknown> {
  const bundleSource = opts.bundleSource ?? (await loadBundleFor(opts))
  const executor = selectExecutor(opts)
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
      .select({ version: appsInstalled.version, sha256: appsInstalled.sha256 })
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
      .select({ version: appsInstalled.version, sha256: appsInstalled.sha256 })
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
