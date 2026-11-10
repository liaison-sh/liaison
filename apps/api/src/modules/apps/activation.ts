// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Activating an app version without a restart (S6, S7, S9, A10, A14, A15).
 *
 * The server keeps two versions of an installed app: the active one and the one
 * before it (`apps_active_version.previous_version`, install-service.ts prunes the
 * rest). Activating a version, whether an install, an upgrade, a catalog
 * reconcile or a rollback, does this:
 *
 *  1. Refuse to go below a version marked `noRollback` (a security release).
 *  2. Point `apps_active_version` at the version, in one transaction.
 *  3. Switch every org already initialized in this process to it
 *     (`switchAppRegistration`: the new version registers over the old one, then
 *     the old version's leftovers go, so no reader sees a gap), and drop the job
 *     handlers only the old version had.
 *  4. Health gate, 30 s: the handler bundle and the UI bundle load from disk,
 *     registration succeeds in every initialized org where the app is on, and
 *     every declared tool is registered there. Failures in orgs where the app is
 *     off are recorded as that org's app state, never a switch-back (A10).
 *  5. On failure (or a gate that crashes or times out), switch back to the
 *     version that ran before, the same way, and record why. The reason stored is
 *     a code and a redacted message; the full detail goes to the server log (A14).
 *  6. Tell the other server processes to re-read the active versions (Redis,
 *     payload-free: each one reads the database, A15).
 *
 * Every activation leaves a row in `kernel.app_activation_events`.
 */
import { readFileSync, rmSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { and, desc as descOrder, sql as drizzleSql, eq, inArray } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { advisoryLockKey, advisoryXactLock, assertTransactionScoped } from "~/db/advisory-lock"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { apps } from "~/db/schema/kernel"
import {
  appActivationEvents,
  appsActiveVersion,
  appsInstalled,
  type InstalledPdfTemplate,
} from "~/db/schema/kernel/apps-installed"
import { organizations } from "~/db/schema/kernel/organizations"
import { unregisterAppJobHandlers } from "~/infra/jobs/jobs"
import { appsLogger as log } from "~/lib/logger"
import { publishRedis, REDIS_PREFIX, redisSub } from "~/lib/redis"
import { appOwnerOrg, appVisibleToOrg } from "~/modules/apps/app-org-scope"
import {
  initializedOrgRuntimes,
  registeredAppVersions,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { bumpCatalogGeneration } from "~/modules/apps/catalog-generation"
import { getInstallRoot } from "~/modules/apps/discover-apps"
import { resetInstallTrustCache } from "~/modules/apps/install-trust"
import { registerTemplate, unregisterApp } from "~/modules/pdf/registry"

/** Who asked for an activation: an instance operator, or the server itself. */
export interface ActivationActor {
  id: string | null
  kind: "operator" | "system"
}

export type ActivationOutcome = "activated" | "switched_back" | "refused"

/** Why an activation did not take, as stored on the event row. */
export type ActivationReasonCode =
  | "version_missing"
  | "module_missing"
  | "module_invalid"
  | "ui_missing"
  | "manifest_invalid"
  | "registration_failed"
  | "tools_missing"
  | "timeout"
  | "gate_crashed"
  | "no_rollback"

/** An activation that did not take. `runningVersion` is what serves now (null: none). */
export class AppActivationError extends Error {
  constructor(
    readonly code: ActivationReasonCode,
    message: string,
    readonly runningVersion: string | null,
  ) {
    super(message)
    this.name = "AppActivationError"
  }
}

/** The health gate's time limit. A test may shorten it. */
export const activationGate: {
  timeoutMs: number
  /** Test seam: runs before each org's switch (a slow or crashing registration). */
  beforeOrgSwitch?: (orgId: string, version: string) => Promise<void>
  /** Test seam: runs after each org's switch, before its tools are judged. */
  afterOrgSwitch?: (orgId: string, version: string) => Promise<void>
} = { timeoutMs: 30_000 }

/** "Re-read the active versions": carries nothing, each process reads the database. */
export const ACTIVE_VERSIONS_CHANNEL = `${REDIS_PREFIX}apps:active-versions`

const MAX_REASON = 500

/**
 * The reason as stored and shown: no URLs, file paths, email addresses or long
 * tokens, whitespace collapsed, at most 500 characters. The server log keeps the
 * full text.
 */
export function redactReason(message: string, max = MAX_REASON): string {
  const m = message
    // Postgres detail: the offending key's values, and every quoted identifier
    // (constraint, relation, column), which can name another org's data model.
    .replace(/\bKey \([^)]*\)=\([^)]*\)/g, "Key (<columns>)=(<values>)")
    .replace(/\bparams:[\s\S]*$/, "params: <redacted>")
    .replace(/"[^"]*"/g, '"<name>"')
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"`)]+/gi, "<url>")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@~-]+){2,}[\\/]?/g, "<path>")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
  return m.length > max ? `${m.slice(0, max - 1)}…` : m
}

interface Pointer {
  version: string
  previousVersion: string | null
}

async function readPointer(name: string): Promise<Pointer | null> {
  const [row] = await withSystemDb("app-activation-pointer", (db) =>
    db
      .select({
        version: appsActiveVersion.version,
        previousVersion: appsActiveVersion.previousVersion,
      })
      .from(appsActiveVersion)
      .where(eq(appsActiveVersion.name, name))
      .limit(1),
  )
  return row ?? null
}

async function writePointer(name: string, pointer: Pointer): Promise<void> {
  await withSystemDb("app-activation-swap", async (db) => {
    // The owner of an org-private app comes with its version's row (0267):
    // NULL for an instance app.
    const [owned] = await db
      .select({ orgId: appsInstalled.orgId })
      .from(appsInstalled)
      .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, pointer.version)))
      .limit(1)
    const orgId = owned?.orgId ?? null
    await db
      .insert(appsActiveVersion)
      .values({ name, version: pointer.version, previousVersion: pointer.previousVersion, orgId })
      .onConflictDoUpdate({
        target: appsActiveVersion.name,
        set: {
          version: pointer.version,
          previousVersion: pointer.previousVersion,
          orgId,
          updatedAt: new Date(),
        },
      })
  })
  // The version this process registers changed: getDefaultApps reads the catalog again.
  bumpCatalogGeneration()
}

/** The manifest of an installed version as written on disk, or null. */
export function readInstalledManifest(
  name: string,
  version: string,
): Record<string, unknown> | null {
  try {
    return JSON.parse(
      readFileSync(join(getInstallRoot(), name, version, "app.manifest.json"), "utf8"),
    ) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Semver precedence (semver.org, section 11): <0 when `a` is older than `b`,
 * 0 when they rank the same, >0 when newer. major.minor.patch compare
 * numerically; a pre-release ranks below its release (1.2.0-rc1 < 1.2.0) and
 * pre-releases compare identifier by identifier (numeric ones numerically and
 * below alphanumeric ones, a longer set above its prefix: rc.2 < rc.10,
 * rc1 < rc2). Build metadata (`+...`) is ignored: 1.2.0+b1 ranks as 1.2.0+b2.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const noBuild = v.split("+")[0] ?? ""
    const dash = noBuild.indexOf("-")
    const core = dash === -1 ? noBuild : noBuild.slice(0, dash)
    const pre = dash === -1 ? [] : noBuild.slice(dash + 1).split(".")
    return { core: core.split(".").map((n) => Number(n) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  // A release ranks above its own pre-releases.
  if (x.pre.length === 0 || y.pre.length === 0) {
    if (x.pre.length === y.pre.length) return 0
    return x.pre.length === 0 ? 1 : -1
  }
  const numeric = /^\d+$/
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = numeric.test(p)
    const qn = numeric.test(q)
    if (pn && qn) return Math.sign(Number(p) - Number(q))
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

/** Semver precedence: `candidate` is newer than `current` (build metadata ignored). */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

/**
 * A security release: a first-party package (the image's own catalog artifact,
 * by its recorded sha256) whose manifest says `noRollback`. An outside package
 * cannot pin itself on a server this way; signed publishers come with P3.
 */
async function isNoRollback(name: string, version: string): Promise<boolean> {
  if (readInstalledManifest(name, version)?.noRollback !== true) return false
  const [row] = await withSystemDb("app-activation-no-rollback", (db) =>
    db
      .select({ sha256: appsInstalled.sha256 })
      .from(appsInstalled)
      .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, version)))
      .limit(1),
  )
  if (!row) return false
  const { isCatalogArtifact } = await import("~/modules/apps/catalog")
  return isCatalogArtifact(name, version, row.sha256)
}

async function recordEvent(row: {
  app: string
  fromVersion: string | null
  toVersion: string
  outcome: ActivationOutcome
  reasonCode?: ActivationReasonCode
  reasonMessage?: string
  actor: ActivationActor
}): Promise<void> {
  try {
    await withSystemDb("app-activation-event", (db) =>
      db.insert(appActivationEvents).values({
        app: row.app,
        fromVersion: row.fromVersion,
        toVersion: row.toVersion,
        outcome: row.outcome,
        reasonCode: row.reasonCode ?? null,
        reasonMessage: row.reasonMessage ? redactReason(row.reasonMessage) : null,
        actorId: row.actor.id,
        actorKind: row.actor.kind,
      }),
    )
  } catch (err) {
    log.error({ err, app: row.app, outcome: row.outcome }, "Recording an app activation failed")
  }
}

/**
 * Replace the app's PDF templates with the version's persisted ones (instance
 * wide, no org loop). The app's previous kinds are evicted first, so a version
 * that dropped a template no longer serves it.
 */
async function registerPdfTemplates(name: string, version: string): Promise<void> {
  const [row] = await withSystemDb("app-activation-pdf", (db) =>
    db
      .select({ pdfTemplates: appsInstalled.pdfTemplates })
      .from(appsInstalled)
      .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, version)))
      .limit(1),
  )
  const templates: InstalledPdfTemplate[] = row?.pdfTemplates ?? []
  unregisterApp(name)
  for (const tpl of templates) registerTemplate(name, tpl.kind, tpl.source)
}

/**
 * Orgs whose failure does not judge the switch (A10): every org where the app is
 * not running (Off, removed, or already failing to load). Their failures are
 * that org's app state, never a switch-back. An org with no row yet gets the app
 * as new and does judge it.
 */
async function orgsNotJudging(name: string, orgIds: string[]): Promise<Set<string>> {
  if (orgIds.length === 0) return new Set()
  const rows = await withSystemDb("app-activation-judging-orgs", (db) =>
    db
      .select({ orgId: apps.orgId, status: apps.status })
      .from(apps)
      .where(and(eq(apps.name, name), inArray(apps.orgId, orgIds))),
  )
  return new Set(rows.filter((r) => r.status !== "active").map((r) => r.orgId))
}

/**
 * The orgs a switch registers in: every org initialized in this process that
 * still exists. An org deleted after it was initialized (an expired demo
 * workspace collected here or by another process) is forgotten: registering in
 * it would hit the org foreign key and fail a healthy version. A process with
 * none (the boot catalog reconcile runs before the server registers any org)
 * probes one instead, so the gate still proves the version registers: an org
 * where the app is on, else the instance operator's org.
 */
async function gateOrgs(name: string): Promise<string[]> {
  // An org's custom app runs in that org alone: it is judged there.
  const owner = await appOwnerOrg(name)
  if (owner !== null) return [owner]
  const live = await liveInitializedOrgs()
  if (live.length > 0) return live
  const [on] = await withSystemDb("app-activation-probe-org", (db) =>
    db
      .select({ orgId: apps.orgId })
      .from(apps)
      .where(and(eq(apps.name, name), eq(apps.status, "active")))
      .limit(1),
  )
  if (on) return [on.orgId]
  const { resolveOperatorOrgId } = await import("~/modules/apps/operator-org")
  // Uncached: the cached first org may have been deleted since, and registering in
  // it would hit the org foreign key.
  const operator = await resolveOperatorOrgId({ fresh: true })
  return operator ? [operator] : []
}

/**
 * The orgs initialized in this process whose `organizations` row still exists.
 * The ones gone are dropped from `initializedOrgRuntimes`, so no later switch
 * tries to register in them either.
 */
async function liveInitializedOrgs(): Promise<string[]> {
  const initialized = [...initializedOrgRuntimes]
  if (initialized.length === 0) return []
  const rows = await withSystemDb("app-activation-live-orgs", (db) =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(inArray(organizations.id, initialized)),
  )
  const existing = new Set(rows.map((r) => r.id))
  const gone = initialized.filter((orgId) => !existing.has(orgId))
  if (gone.length > 0) {
    for (const orgId of gone) initializedOrgRuntimes.delete(orgId)
    log.info({ orgIds: gone }, "Forgot the runtimes of deleted orgs before an app switch")
  }
  return initialized.filter((orgId) => existing.has(orgId))
}

interface GateFailure {
  code: ActivationReasonCode
  message: string
}

/**
 * Register the active version in every initialized org and judge it. Returns the
 * first failure, or null when the version is healthy.
 */
async function switchAndJudge(
  name: string,
  signal?: AbortSignal,
  candidate?: string,
): Promise<GateFailure | null> {
  const { readInstalledAppDescriptor } = await import("~/modules/apps/init")
  const { switchAppRegistration } = await import("~/modules/apps/runtime")
  const desc = await readInstalledAppDescriptor(name, candidate)
  if (!desc) {
    return { code: "module_missing", message: `${name}: the active version is not on disk` }
  }
  const bundlePath = (desc as { _bundlePath?: string })._bundlePath
  if (bundlePath) {
    const loaded = await loadsAsBundle(bundlePath)
    if (loaded !== true)
      return { code: loaded.code, message: `${name} ${desc.version}: ${loaded.message}` }
  }
  const uiBundlePath = (desc as { _uiBundlePath?: string })._uiBundlePath
  if (uiBundlePath && !readableFile(uiBundlePath)) {
    return {
      code: "ui_missing",
      message: `${name} ${desc.version}: its interface bundle is missing`,
    }
  }
  // An org's custom app is switched (and judged) in its own org only.
  const orgIds: string[] = []
  for (const orgId of await gateOrgs(name)) {
    if (await appVisibleToOrg(name, orgId)) orgIds.push(orgId)
  }
  const off = await orgsNotJudging(name, orgIds)
  const tools = Object.keys(((desc as { tools?: Record<string, unknown> }).tools ?? {}) as object)
  let failure: GateFailure | null = null
  for (const orgId of orgIds) {
    await activationGate.beforeOrgSwitch?.(orgId, desc.version)
    // A gate that timed out stops here: the switch-back owns the registrations now.
    if (signal?.aborted) return null
    const result = await switchAppRegistration(desc, orgId)
    await activationGate.afterOrgSwitch?.(orgId, desc.version)
    if (off.has(orgId)) continue
    if (!result.ok) {
      failure ??= { code: result.problem.code, message: result.problem.message }
      continue
    }
    const missing = tools.filter((t) => !toolRegistry.has([orgId, name, t]))
    if (missing.length > 0) {
      failure ??= {
        code: "tools_missing",
        message: `${name} ${desc.version}: tools not registered: ${missing.join(", ")}`,
      }
    }
  }
  if (signal?.aborted) return null
  // Job handlers are process-wide: keep the ones this version declares, drop the rest.
  unregisterAppJobHandlers(name, Object.keys(((desc as { jobs?: object }).jobs ?? {}) as object))
  return failure
}

/**
 * The handler bundle loads the way a tool call loads it (`loadBundle`, the
 * dispatch path) and parses as JavaScript. Registration itself never evaluates
 * the bundle (handlers run later, in the sandbox), so without this a version
 * whose bundle is broken passes registration and fails on its first call.
 * Parsing does not run it: a bundle carrying an import attribute (a macro import
 * would run during the parse) is refused before it, so no app code executes in
 * the host.
 */
async function loadsAsBundle(
  bundlePath: string,
): Promise<true | { code: "module_missing" | "module_invalid"; message: string }> {
  let source: string
  try {
    const { loadBundle } = await import("~/modules/apps/sandbox/bundle-loader")
    source = await loadBundle(bundlePath)
  } catch (err) {
    return {
      code: "module_missing",
      message: `its handler bundle does not load: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  // Refused before the host parses it: Bun runs a macro import (`with { type: "macro" }`)
  // while it transforms the text, so the parse below would run the app's code here, outside
  // the sandbox. No sandboxed bundle needs an import attribute (it cannot import at all).
  const { importAttributeIssue } = await import("~/modules/apps/sandbox/import-attributes")
  const issue = await importAttributeIssue(source)
  if (issue !== null) {
    return {
      code: "module_invalid",
      message: `its handler bundle cannot be checked safely: ${issue}; a handler bundle may carry no import attribute`,
    }
  }
  try {
    new Bun.Transpiler({ loader: "js" }).transformSync(source)
    return true
  } catch (err) {
    return {
      code: "module_invalid",
      message: `its handler bundle does not parse: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function readableFile(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Run the switch with the gate's time limit. On a timeout the switch is told to
 * stop and awaited (its current org step finishes, no later one starts) before
 * the caller switches back, so a slow registration never lands afterwards.
 */
async function gate(name: string, candidate: string): Promise<GateFailure | null> {
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), activationGate.timeoutMs)
  })
  const run = switchAndJudge(name, abort.signal, candidate).catch(
    (err): GateFailure => ({
      code: "gate_crashed",
      message: err instanceof Error ? err.message : String(err),
    }),
  )
  try {
    const first = await Promise.race([run, timedOut])
    if (first !== "timeout") return first
    abort.abort()
    await run
    return {
      code: "timeout",
      message: `${name}: the health gate did not finish within ${activationGate.timeoutMs} ms`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Register whatever version the pointer names (a switch-back), best effort. */
async function reRegisterActive(name: string): Promise<void> {
  try {
    const failure = await switchAndJudge(name)
    if (failure)
      log.error({ app: name, failure }, "The version switched back to does not load either")
  } catch (err) {
    log.error({ err, app: name }, "Re-registering the version switched back to failed")
  }
}

async function finishSwitch(name: string, version: string): Promise<void> {
  await finishLocalSwitch(name, version)
  // The app's cron fan-out schedulers follow the version now active (a
  // switch-back included): its own manifest is authoritative here.
  try {
    const { readInstalledAppDescriptor } = await import("~/modules/apps/init")
    const desc = await readInstalledAppDescriptor(name)
    if (desc) {
      const { syncAppCronFanoutForApp } = await import("~/infra/jobs/fanout-runtime")
      await syncAppCronFanoutForApp(name, desc)
    }
  } catch (err) {
    log.warn({ err, app: name }, "Syncing the app's cron fan-out schedulers after a switch failed")
  }
  // The files policy and the search settings follow the catalog that now holds
  // this version, whichever orgs this process has registered (none included).
  try {
    const { rebuildFilesSelectPolicy } = await import("~/infra/boot-phase10")
    await rebuildFilesSelectPolicy()
  } catch (err) {
    log.warn({ err, app: name }, "Rebuilding the files policy after an app switch failed")
  }
  try {
    const { ensureSearchSettingsCoverCatalog } = await import("~/modules/search/drift")
    await ensureSearchSettingsCoverCatalog()
  } catch (err) {
    log.warn({ err, app: name }, "Extending the search settings after an app switch failed")
  }
  // This process already runs it in every org it has: its own announcement
  // (sent once the activation's lock is released) needs no follow here.
  noteFollowed(name, version, [...initializedOrgRuntimes])
}

/**
 * Tell the other server processes to re-read the active versions: after an
 * activation, a switch-back, an uninstall. Payload-free (A15): each process
 * reads the database.
 */
export function announceActiveVersions(app: string): void {
  void publishRedis(ACTIVE_VERSIONS_CHANNEL, "{}").catch((err) =>
    log.warn({ err, app }, "Announcing the app change to other server processes failed"),
  )
}

/**
 * Make `version` (already installed: files on disk and an `apps_installed` row)
 * the active version of `name`, health-gated, and switch back when it fails.
 * Resolves with the active version; throws `AppActivationError` when the version
 * was refused or switched back from.
 */
export async function activateAppVersion(
  name: string,
  version: string,
  actor: ActivationActor,
  opts: {
    /** Runs first, inside the lock (an install places its files and records its row). */
    beforeActivate?: () => Promise<void>
    afterSwitch?: () => Promise<void>
  } = {},
): Promise<{ version: string; previousVersion: string | null }> {
  let ran = false
  try {
    return await withAppActivationLock(name, async () => {
      await opts.beforeActivate?.()
      ran = true
      try {
        return await activateLocked(name, version, actor)
      } finally {
        await opts.afterSwitch?.()
      }
    })
  } finally {
    // Only once the lock's transaction has committed: a process told earlier
    // would find the lock still held and skip the follow (K1).
    if (ran) announceActiveVersions(name)
  }
}

/**
 * One activation of an app at a time, across every server process: a
 * transaction-scoped advisory lock held from the pointer read through the gate,
 * the switch-back and the caller's prune (`afterSwitch`). A process following
 * another's activation (`syncActiveVersionsFromDb`) only tries it and skips the
 * app while it is held.
 */
export async function withAppActivationLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withActivationLockTx("app-activation-lock", async (tx) => {
    assertTransactionScoped(tx, "app activation")
    await tx.execute(advisoryXactLock(`app-activate:${name}`))
    inFlight.add(name)
    try {
      return await fn()
    } finally {
      inFlight.delete(name)
    }
  })
}

/**
 * The transaction that holds an app's activation advisory lock. It stays open
 * for the whole activation, follow or uninstall, and everything it guards takes
 * its own privileged transactions, so it runs on the privileged-jobs pool: a
 * privileged-pool slot held across that work would make each of those a nested
 * acquisition, the shape that deadlocks a full pool.
 */
function withActivationLockTx<T>(reason: string, fn: (tx: PrivilegedDb) => Promise<T>): Promise<T> {
  return withPrivilegedDb(NIL_ORG_ID, reason, fn, { pool: "jobs" })
}

const NIL_ORG_ID = "00000000-0000-0000-0000-000000000000"

/** Apps whose activation runs in this process. */
const inFlight = new Set<string>()

async function activateLocked(
  name: string,
  version: string,
  actor: ActivationActor,
): Promise<{ version: string; previousVersion: string | null }> {
  const before = await readPointer(name)
  const fromVersion = before?.version ?? null

  if (before && before.version !== version && isNewerVersion(before.version, version)) {
    if (await isNoRollback(name, before.version)) {
      const message = `${name} ${before.version} is a security release (noRollback): it cannot be replaced by the older ${version}.`
      await recordEvent({
        app: name,
        fromVersion,
        toVersion: version,
        outcome: "refused",
        reasonCode: "no_rollback",
        reasonMessage: message,
        actor,
      })
      throw new AppActivationError("no_rollback", message, before.version)
    }
  }
  if (!readInstalledManifest(name, version)) {
    const message = `${name} ${version} is not installed on this server.`
    await recordEvent({
      app: name,
      fromVersion,
      toVersion: version,
      outcome: "refused",
      reasonCode: "version_missing",
      reasonMessage: message,
      actor,
    })
    throw new AppActivationError("version_missing", message, fromVersion)
  }

  const next: Pointer = {
    version,
    previousVersion:
      before && before.version !== version ? before.version : (before?.previousVersion ?? null),
  }
  // The candidate is judged before the pointer names it: another process, an
  // org registering now, or a sync of this one, only ever sees a vetted version.
  const failure = await gate(name, version)
  if (!failure) {
    await writePointer(name, next)
    await finishSwitch(name, version)
    await recordEvent({ app: name, fromVersion, toVersion: version, outcome: "activated", actor })
    log.info({ app: name, from: fromVersion, to: version }, "App version activated")
    return next
  }

  log.error(
    { app: name, from: fromVersion, to: version, failure },
    "App version failed its health gate",
  )
  const switchTo = before && before.version !== version ? before : null
  if (switchTo) {
    await reRegisterActive(name)
    await finishSwitch(name, switchTo.version)
    await recordEvent({
      app: name,
      fromVersion,
      toVersion: version,
      outcome: "switched_back",
      reasonCode: failure.code,
      reasonMessage: failure.message,
      actor,
    })
    throw new AppActivationError(
      failure.code,
      `${name} ${version} failed its health gate and was switched back; still running ${switchTo.version}. Reason: ${redactReason(failure.message)}`,
      switchTo.version,
    )
  }
  if (before) {
    // The same version reinstalled in place: it was already the running version,
    // so it stays, failed in the orgs where it did not load (their app state says
    // why). Taking it away here would turn a transient gate failure during a
    // catalog repair into a missing app.
    await finishSwitch(name, version)
    await recordEvent({
      app: name,
      fromVersion,
      toVersion: version,
      outcome: "refused",
      reasonCode: failure.code,
      reasonMessage: failure.message,
      actor,
    })
    throw new AppActivationError(
      failure.code,
      `${name} ${version} was reinstalled but failed its health gate. Reason: ${redactReason(failure.message)}`,
      version,
    )
  }
  // A first install: nothing to switch back to, so the version does not run.
  const { unregisterAppEverywhere } = await import("~/modules/apps/runtime")
  await unregisterAppEverywhere(name)
  await recordEvent({
    app: name,
    fromVersion,
    toVersion: version,
    outcome: "refused",
    reasonCode: failure.code,
    reasonMessage: failure.message,
    actor,
  })
  throw new AppActivationError(
    failure.code,
    `${name} ${version} failed its health gate and was not activated. Reason: ${redactReason(failure.message)}`,
    null,
  )
}

/**
 * Roll an app back to its previous version (S9), through the same health gate.
 * The instance-operator scope is the caller's to check (install-routes, CLI).
 */
export async function rollbackApp(
  name: string,
  actor: ActivationActor,
): Promise<{ version: string; previousVersion: string | null }> {
  const pointer = await readPointer(name)
  if (!pointer) {
    throw new AppActivationError(
      "version_missing",
      `${name} is not installed on this server.`,
      null,
    )
  }
  if (!pointer.previousVersion) {
    throw new AppActivationError(
      "version_missing",
      `${name} has no previous version to roll back to.`,
      pointer.version,
    )
  }
  return activateAppVersion(name, pointer.previousVersion, actor)
}

/** One installed app's versions and its last failed activation, for the App store and the CLI. */
export interface AppVersionState {
  name: string
  version: string
  previousVersion: string | null
  /** The previous version's files are still on disk (a rollback can run). */
  previousOnDisk: boolean
  /** The active version is a first-party security release: no rollback below it. */
  noRollback: boolean
  /** The last activation that did not take, when it is the latest one. */
  upgradeFailed: {
    version: string
    reasonCode: string | null
    reasonMessage: string | null
    at: Date
  } | null
}

export async function listAppVersionStates(names?: string[]): Promise<AppVersionState[]> {
  const pointers = await withSystemDb("app-version-states", (db) =>
    db
      .select()
      .from(appsActiveVersion)
      .where(names ? inArray(appsActiveVersion.name, names) : undefined),
  )
  if (pointers.length === 0) return []
  const events = await withSystemDb("app-version-events", (db) =>
    db
      .select()
      .from(appActivationEvents)
      .where(
        inArray(
          appActivationEvents.app,
          pointers.map((p) => p.name),
        ),
      )
      .orderBy(descOrder(appActivationEvents.at)),
  )
  const latest = new Map<string, (typeof events)[number]>()
  for (const e of events) if (!latest.has(e.app)) latest.set(e.app, e)
  const noRollback = new Map<string, boolean>()
  for (const p of pointers) noRollback.set(p.name, await isNoRollback(p.name, p.version))
  return pointers.map((p) => {
    const last = latest.get(p.name)
    return {
      name: p.name,
      version: p.version,
      previousVersion: p.previousVersion,
      previousOnDisk: !!p.previousVersion && !!readInstalledManifest(p.name, p.previousVersion),
      noRollback: noRollback.get(p.name) === true,
      upgradeFailed:
        last && last.outcome !== "activated" && last.toVersion !== p.version
          ? {
              version: last.toVersion,
              reasonCode: last.reasonCode,
              reasonMessage: last.reasonMessage,
              at: last.at,
            }
          : null,
    }
  })
}

/**
 * The active version of every app (or of `name`), with the source it was
 * installed from: a `catalog:` source is a release's catalog install, which an
 * old process during a rolling deploy may keep at its own catalog's version
 * (`versionForThisRelease`); any other source is the one every process runs.
 */
export async function activeVersionRows(
  db: PrivilegedDb,
  name?: string,
): Promise<Array<{ name: string; version: string; sourceUrl: string | null }>> {
  return db
    .select({
      name: appsActiveVersion.name,
      version: appsActiveVersion.version,
      sourceUrl: appsInstalled.sourceUrl,
    })
    .from(appsActiveVersion)
    .leftJoin(
      appsInstalled,
      and(
        eq(appsInstalled.name, appsActiveVersion.name),
        eq(appsInstalled.version, appsActiveVersion.version),
      ),
    )
    .where(name === undefined ? undefined : eq(appsActiveVersion.name, name))
}

/**
 * The active version of each installed app as this process last followed it
 * (the version it runs, `versionForThisRelease`). An app that leaves this map's
 * names in the database was uninstalled by another process.
 */
const followed = new Map<string, string>()

/**
 * Follow the installed apps as another process left them (S1.1, S1.2):
 *
 * - an app with no active version any more (uninstalled elsewhere) is
 *   unregistered from every org, its job handlers and fan-out jobs dropped, and
 *   its local files deleted;
 * - an active version this process does not run in an org it has initialized
 *   (an upgrade, a rollback, or a first install it never registered) is put on
 *   disk from the package store when missing (package-store.ts), then
 *   registered in every such org;
 * - a new or changed active version gets its job queue bound here at once.
 *
 * The version followed is the active one or, in an old process during a rolling
 * deploy (a newer release's catalog moved the row past this image's catalog),
 * the version its own catalog carries (`versionForThisRelease`): an old process
 * keeps the code it has loaded. No gate and no event: the process that activated
 * recorded both. A version that cannot be put on disk is logged and retried on
 * the next announcement or upkeep; the process keeps serving what it had.
 *
 * `reconcile` (the upkeep, A7, with no announcement to go by) also unregisters
 * any installed app registered here whose active version is gone, followed or not.
 */
export function syncActiveVersionsFromDb(opts: { reconcile?: boolean } = {}): Promise<void> {
  // One sync at a time per process (K10). A request during a run is folded into
  // one more run after it, so every caller's change is read.
  if (!syncRunning) {
    syncRunning = runSync(opts).finally(() => {
      syncRunning = null
    })
    return syncRunning
  }
  if (!syncQueued) {
    const queued = { reconcile: !!opts.reconcile, promise: Promise.resolve() }
    queued.promise = syncRunning
      .catch(() => {})
      .then(() => {
        syncQueued = null
        return syncActiveVersionsFromDb({ reconcile: queued.reconcile })
      })
    syncQueued = queued
  } else if (opts.reconcile) {
    syncQueued.reconcile = true
  }
  return syncQueued.promise
}

let syncRunning: Promise<void> | null = null
let syncQueued: { reconcile: boolean; promise: Promise<void> } | null = null

/**
 * The orgs each app's followed version was registered in by this process, and
 * when. An org where it failed is not tried again on every announcement (K5),
 * only once the version changes or the record is an hour old.
 */
const attempted = new Map<string, { version: string; orgs: Set<string>; at: number }>()
const FAILED_ORG_RETRY_MS = 60 * 60_000

function noteFollowed(name: string, version: string, orgIds: string[]): void {
  followed.set(name, version)
  attempted.set(name, { version, orgs: new Set(orgIds), at: Date.now() })
}

/**
 * An org initialized here does not run `version` and was not already tried
 * with it. One pass over the orgs, set lookups only.
 */
function hasStaleOrg(name: string, version: string): boolean {
  const tried = attempted.get(name)
  const fresh =
    tried !== undefined && tried.version === version && Date.now() - tried.at < FAILED_ORG_RETRY_MS
  for (const orgId of initializedOrgRuntimes) {
    if (registeredAppVersions.get(`${orgId}:${name}`) === version) continue
    if (fresh && tried.orgs.has(orgId)) continue
    return true
  }
  return false
}

/** Test access: make this process forget it ever followed an app (a fresh peer). */
export const ActivationSyncTestAccess = {
  forget(name: string): void {
    followed.delete(name)
    attempted.delete(name)
  },
  /**
   * Resolve once every announcement published so far has been handled here,
   * the sync it started included. A no-op when this process does not follow
   * announcements (`initAppActivationSync` never ran). A test that plays an
   * old process after an install calls it first: the install's own
   * announcement, delivered late, would otherwise follow under it.
   */
  async settle(): Promise<void> {
    if (!subscription) return
    await subscription
    // One publisher connection, one subscriber: delivery keeps publish order,
    // and the follower's listener (registered first) has run for every
    // earlier announcement by the time this marker reaches the one below.
    const marker = `settle:${crypto.randomUUID()}`
    const seen = new Promise<void>((resolve, reject) => {
      const onMessage = (channel: string, message: string) => {
        if (channel !== ACTIVE_VERSIONS_CHANNEL || message !== marker) return
        clearTimeout(timer)
        redisSub.off("message", onMessage)
        resolve()
      }
      const timer = setTimeout(() => {
        redisSub.off("message", onMessage)
        reject(new Error("The app activation announcements did not settle within 10 s"))
      }, 10_000)
      redisSub.on("message", onMessage)
    })
    await publishRedis(ACTIVE_VERSIONS_CHANNEL, marker)
    await seen
    await (syncQueued?.promise ?? syncRunning)
  },
}

/** Delay of the follow retry when an activation still held an app's lock. */
export const followRetry = { delayMs: 1_000, max: 5 }
let followRetries = 0
let followRetryTimer: ReturnType<typeof setTimeout> | null = null

/** Follow again shortly: the app's lock was held (an activation finishing elsewhere). */
function scheduleFollowRetry(): void {
  if (followRetryTimer || followRetries >= followRetry.max) return
  followRetries++
  followRetryTimer = setTimeout(() => {
    followRetryTimer = null
    void syncActiveVersionsFromDb().catch((err) =>
      log.warn({ err }, "Retrying to follow app versions activated elsewhere failed"),
    )
  }, followRetry.delayMs)
  followRetryTimer.unref?.()
}

async function runSync(opts: { reconcile?: boolean }): Promise<void> {
  const pointers = await withSystemDb("app-version-sync", (db) => activeVersionRows(db))
  const { versionForThisRelease } = await import("~/modules/apps/catalog")
  const active = new Set(pointers.map((p) => p.name))
  let lockBusy = false

  const gone = new Set([...followed.keys()].filter((name) => !active.has(name)))
  if (opts.reconcile)
    for (const name of await registeredInstalledApps()) {
      if (!active.has(name)) gone.add(name)
    }
  for (const name of gone) {
    if (inFlight.has(name)) continue
    if (!(await followUninstall(name))) lockBusy = true
  }

  for (const p of pointers) {
    if (inFlight.has(p.name)) continue
    const target = versionForThisRelease(p.name, p.version, p.sourceUrl)
    const changed = followed.get(p.name) !== target
    const stale = hasStaleOrg(p.name, target)
    if (!changed && !stale) continue
    try {
      const { ensureBundleMaterialised } = await import("~/modules/apps/package-store")
      await ensureBundleMaterialised(p.name, target)
    } catch (err) {
      log.error(
        { err, app: p.name, version: target },
        "An app version activated elsewhere is not on disk here and could not be fetched; keeping the previous state",
      )
      continue
    }
    let orgsTried: string[] = []
    if (stale) {
      // An activation in flight anywhere holds the lock: it announces its result
      // once released, and a short retry covers a lock still held now.
      const followedNow = await withActivationLockTx("app-activation-follow", async (tx) => {
        const [held] = extractRows<{ ok: boolean }>(
          await tx.execute(
            drizzleSql`SELECT pg_try_advisory_xact_lock(${advisoryLockKey(`app-activate:${p.name}`)}) AS ok`,
          ),
        )
        if (!held?.ok) return false
        log.info({ app: p.name, version: target }, "Following an app version activated elsewhere")
        orgsTried = [...initializedOrgRuntimes]
        await reRegisterActive(p.name)
        await finishLocalSwitch(p.name, target)
        return true
      })
      if (!followedNow) {
        lockBusy = true
        continue
      }
    } else {
      orgsTried = [...(attempted.get(p.name)?.orgs ?? [])]
    }
    // Its job queue is consumed here at once, not at the next fan-out upkeep.
    try {
      const { followInstalledAppJobs } = await import("~/infra/jobs/fanout-runtime")
      await followInstalledAppJobs(p.name)
    } catch (err) {
      log.warn({ err, app: p.name }, "Binding an app's job queue after following it failed")
    }
    noteFollowed(p.name, target, orgsTried)
  }
  if (lockBusy) scheduleFollowRetry()
  else followRetries = 0
}

/**
 * Installed (not in-tree) apps registered in an org of this process. In-tree
 * apps have no active-version row by design, so they are never counted.
 */
async function registeredInstalledApps(): Promise<Set<string>> {
  const names = new Set<string>()
  for (const key of registeredAppVersions.keys()) {
    const at = key.indexOf(":")
    if (at > 0) names.add(key.slice(at + 1))
  }
  if (names.size === 0) return names
  const { discoverInTreeApps } = await import("~/modules/apps/discover-apps")
  for (const app of await discoverInTreeApps()) names.delete(app.name)
  return names
}

/** Another process uninstalled `name`: drop it here, then its local files. */
async function followUninstall(name: string): Promise<boolean> {
  return withActivationLockTx("app-uninstall-follow", async (tx) => {
    // A reinstall in flight holds the lock: it announces, and this process follows then.
    const [held] = extractRows<{ ok: boolean }>(
      await tx.execute(
        drizzleSql`SELECT pg_try_advisory_xact_lock(${advisoryLockKey(`app-activate:${name}`)}) AS ok`,
      ),
    )
    if (!held?.ok) return false
    log.info({ app: name }, "Following an app uninstalled elsewhere")
    const { unregisterAppEverywhere } = await import("~/modules/apps/runtime")
    await unregisterAppEverywhere(name)
    resetInstallTrustCache(name)
    unregisterApp(name)
    try {
      const { rememberScheduledJobs } = await import("~/infra/jobs/fanout-runtime")
      rememberScheduledJobs(name, null)
    } catch (err) {
      log.warn({ err, app: name }, "Forgetting an uninstalled app's scheduled jobs failed")
    }
    // Its files go too (A8), unless it is being installed again: an install
    // writes its row before it activates, so a row means files someone needs.
    const [row] = await tx
      .select({ version: appsInstalled.version })
      .from(appsInstalled)
      .where(eq(appsInstalled.name, name))
      .limit(1)
    if (!row) removeLocalAppDir(name)
    followed.delete(name)
    attempted.delete(name)
    return true
  })
}

function removeLocalAppDir(name: string): void {
  const root = resolve(getInstallRoot())
  const dir = resolve(join(root, name))
  if (!dir.startsWith(root + sep)) return
  rmSync(dir, { recursive: true, force: true })
}

async function finishLocalSwitch(name: string, version: string): Promise<void> {
  resetInstallTrustCache(name)
  try {
    await registerPdfTemplates(name, version)
  } catch (err) {
    log.warn({ err, app: name }, "Warming the PDF registry after an app switch failed")
  }
}

/**
 * The upkeep (A7): with or without an announcement, every process converges on
 * the installed apps in the database every `APP_UPKEEP_INTERVAL_MS`: missing
 * versions put on disk, gone apps unregistered, new ones registered and bound.
 */
export async function runInstalledAppsUpkeep(): Promise<void> {
  bumpCatalogGeneration()
  const { materialiseActiveVersions } = await import("~/modules/apps/package-store")
  await materialiseActiveVersions()
  await syncActiveVersionsFromDb({ reconcile: true })
}

/** How often every process runs the upkeep (the cron fan-out upkeep's period). */
export const APP_UPKEEP_INTERVAL_MS = 10 * 60_000

/** The channel subscription, once `initAppActivationSync` ran. */
let subscription: Promise<unknown> | null = null

/** Follow activations made by other server processes. Idempotent; called once at startup. */
export async function initAppActivationSync(): Promise<void> {
  if (subscription) return
  redisSub.on("message", (channel) => {
    if (channel !== ACTIVE_VERSIONS_CHANNEL) return
    // Another process changed the catalog: drop this process's cached catalog first.
    bumpCatalogGeneration()
    void syncActiveVersionsFromDb().catch((err) =>
      log.warn({ err }, "Following app versions activated elsewhere failed"),
    )
  })
  subscription = redisSub.subscribe(ACTIVE_VERSIONS_CHANNEL)
  await subscription
  // What this process starts with: an app uninstalled from now on is one it knew.
  try {
    const pointers = await withSystemDb("app-version-seed", (db) => activeVersionRows(db))
    const { versionForThisRelease } = await import("~/modules/apps/catalog")
    for (const p of pointers) {
      if (!followed.has(p.name)) {
        followed.set(p.name, versionForThisRelease(p.name, p.version, p.sourceUrl))
      }
    }
  } catch (err) {
    log.warn({ err }, "Reading the installed apps at startup failed; the upkeep will")
  }
  const upkeep = setInterval(() => {
    void runInstalledAppsUpkeep().catch((err) => log.warn({ err }, "Installed apps upkeep failed"))
  }, APP_UPKEEP_INTERVAL_MS)
  upkeep.unref?.()
}

/** An org's persisted app problems (S8): what the App store shows after a restart. */
export async function orgAppProblems(
  orgId: string,
): Promise<Map<string, { code: string; message: string }>> {
  const rows = await withPrivilegedDb(orgId, "app-problems", (db) =>
    db
      .select({ name: apps.name, code: apps.problemCode, message: apps.problemMessage })
      .from(apps)
      .where(eq(apps.orgId, orgId)),
  )
  const out = new Map<string, { code: string; message: string }>()
  for (const r of rows) {
    if (r.code && (await appVisibleToOrg(r.name, orgId))) {
      out.set(r.name, { code: r.code, message: r.message ?? "" })
    }
  }
  return out
}
