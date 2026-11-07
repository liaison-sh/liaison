// SPDX-License-Identifier: FSL-1.1-ALv2
// The cron fan-out at run time (fanout.ts has the pure parts, fanout-keys.ts
// the Redis keys): the tick that lists the orgs and enqueues one job each, the
// sync of the schedulers from the app catalog, and the cleanup of removed ones.
import { and, sql as drizzleSql, eq, type SQL } from "drizzle-orm"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { apps, organizations } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import { registerSingleton } from "~/infra/leadership"
import { env, isTestEnv } from "~/lib/env"
import { jobsLogger as log } from "~/lib/logger"
import { bullPrefix, redis, redisBullMQ } from "~/lib/redis"
import { isShuttingDown } from "~/lib/shutdown"
import { quoteIdent } from "~/lib/sql-utils"
import { appOwnerOrg, appVisibleToOrg, customAppNameKey } from "~/modules/apps/app-org-scope"
import {
  APP_CRON_FANOUT_JOB,
  fanoutJobId,
  fanoutSchedulerId,
  LEGACY_PER_ORG_SCHEDULER_RE,
  nextGapMs,
  retentionMs,
  spreadDelays,
  spreadWindowMs,
} from "./fanout"
import {
  countFanoutCoalesced,
  countFanoutRunsFor,
  countJobMetrics,
  fanoutErrorRetryKey,
  fanoutMarkerKey,
  fanoutPendingKey,
  fanoutTestState,
  watchFanoutEpoch,
} from "./fanout-keys"
import { type RunsForCheck, runsForCheckOf, runsForWhereOp } from "./fanout-runs-for"
import {
  addFanoutJobs,
  addLegacyTickAsFanoutJob,
  bindCatalogAppQueues,
  type FanoutJobEntry,
  getJobQueue,
  getPhysicalQueue,
  type JobRunContext,
  registerJobWorker,
} from "./jobs"
import { isKernelApp } from "./queue-classes"

/** What a fan-out scheduler's template data carries (and every tick reads). */
export interface FanoutTemplate {
  app: string
  job: string
  /** The manifest pattern; the tick's spread is measured against it. */
  cron: string
  /** Set only by the test seam LIAISON_TEST_FANOUT_EVERY_MS: the interval in place of `cron`. */
  everyMs?: number
  attempts: number
  backoff: { type: string; delay: number }
  /** The manifest's `runsFor` check; absent = every org with the app on. */
  runsFor?: RunsForCheck
}

/** An org as the tick sees it: its app row's status, or null when it has none (= On). */
export interface FanoutOrg {
  orgId: string
  status: "active" | "disabled" | "error" | "removed" | null
}

/** Per-org jobs added per round trip. */
const FANOUT_BATCH = 500
/** An org whose app is in `error` gets one registration retry per this long. */
const ERROR_RETRY_MS = 3_600_000
/** States in which a previous epoch's job has not started yet. */
const NOT_STARTED = new Set(["delayed", "waiting", "prioritized", "waiting-children"])

/**
 * Every org, with its row for `app` in `kernel.apps` (none = On). A system
 * read across orgs, by design: the tick decides which workspaces get a run.
 */
export async function enumerateFanoutOrgs(app: string): Promise<FanoutOrg[]> {
  if (fanoutTestState.listOrgs) return fanoutTestState.listOrgs(app)
  // An org's custom app runs its schedules for that org alone (app-org-scope.ts).
  const owner = await appOwnerOrg(app)
  const orgs = await withSystemDb("app-cron-fanout:enumerate", (db) =>
    db
      .select({ orgId: organizations.id, status: apps.status })
      .from(organizations)
      .leftJoin(apps, and(eq(apps.orgId, organizations.id), eq(apps.name, app)))
      .where(owner === null ? undefined : eq(organizations.id, owner)),
  )
  if (owner === null && customAppNameKey(app) === null) return orgs
  const visible: FanoutOrg[] = []
  for (const o of orgs) if (await appVisibleToOrg(app, o.orgId)) visible.push(o)
  return visible
}

/** A `where` value as SQL on `col`. Assumes a validated manifest (runsForErrors). */
function whereSql(col: SQL, value: unknown): SQL {
  const op = runsForWhereOp(value)
  if (typeof op === "string") throw new Error(`runsFor where: ${op}`)
  if (op.op === "null") return drizzleSql`${col} IS NULL`
  if (op.op === "notNull") return drizzleSql`${col} IS NOT NULL`
  if (op.op === "eq") return drizzleSql`${col} = ${op.value}`
  return drizzleSql`${col} IN (${drizzleSql.join(
    op.values.map((v) => drizzleSql`${v}`),
    drizzleSql.raw(", "),
  )})`
}

const snake = (s: string) => s.replace(/([A-Z])/g, "_$1").toLowerCase()

/**
 * The orgs of `orgIds` that meet a job's `runsFor`: one query per condition for
 * all of them, in the kernel, so an org with nothing to do never takes a
 * sandbox worker. A connection counts when the org has an active connected
 * account for it, not a demo fixture one; a `rows` condition when the app's
 * entity has a matching row (an index probe per org on `org_id`, stopping at
 * the first match).
 */
export async function orgsMeetingRunsFor(
  app: string,
  check: RunsForCheck,
  orgIds: readonly string[],
): Promise<Set<string>> {
  const met = new Set<string>()
  if (orgIds.length === 0) return met
  const orgArray = `{${orgIds.join(",")}}`
  await withSystemDb("app-cron-fanout:runs-for", async (db) => {
    if (check.connections?.length) {
      const pairs = check.connections.map((c) => {
        const i = c.indexOf(":")
        return drizzleSql`(${c.slice(0, i)}, ${c.slice(i + 1)})`
      })
      const res = await db.execute(drizzleSql`
        SELECT DISTINCT org_id::text AS id
        FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.connected_accounts
        WHERE org_id = ANY(${orgArray}::uuid[])
          AND status = 'active'
          AND (app_name, connection_name) IN (${drizzleSql.join(pairs, drizzleSql.raw(", "))})
          AND (metadata->>'demo') IS DISTINCT FROM 'true'
      `)
      for (const r of extractRows<{ id: string }>(res)) met.add(r.id)
    }
    for (const rows of check.rows ?? []) {
      const pending = orgIds.filter((o) => !met.has(o))
      if (pending.length === 0) break
      const table = drizzleSql.raw(
        `${quoteIdent(schemaRef(`app_${app.replace(/-/g, "_")}`))}.${quoteIdent(rows.entity)}`,
      )
      const conds = Object.entries(rows.where ?? {}).map(([k, v]) =>
        whereSql(drizzleSql.raw(`t.${quoteIdent(snake(k))}`), v),
      )
      const res = await db.execute(drizzleSql`
        SELECT o.id::text AS id
        FROM unnest(${`{${pending.join(",")}}`}::uuid[]) AS o(id)
        WHERE EXISTS (
          SELECT 1 FROM ${table} t
          WHERE t.org_id = o.id${conds.length ? drizzleSql` AND ${drizzleSql.join(conds, drizzleSql.raw(" AND "))}` : drizzleSql``}
        )
      `)
      for (const r of extractRows<{ id: string }>(res)) met.add(r.id)
    }
  })
  return met
}

/** What one fan-out did, by outcome. */
export interface FanoutCounts {
  enqueued: number
  deduped: number
  coalesced: number
  skippedOff: number
  skippedError: number
  /** Orgs with the app on that do not meet the job's `runsFor`: no run, no worker. */
  skippedRunsFor: number
}

/**
 * Enqueue one job per org for one epoch on `queueName`: id-deduplicated
 * (a re-run adds nothing), coalesced (an org whose last job has not started
 * gets none), spread over the window from the epoch. `idApp`/`idJob` name the
 * (app, job) in the ids and keys; `jobName` is the per-org job's name.
 */
export async function fanOutEpoch(args: {
  queueName: string
  idApp: string
  idJob: string
  jobName: string
  epoch: number
  gapMs: number
  orgIds: readonly string[]
  attempts: number
  backoff: { type: string; delay: number }
  signal?: AbortSignal
  extraData?: Record<string, unknown>
}): Promise<Omit<FanoutCounts, "skippedOff" | "skippedError" | "skippedRunsFor">> {
  const { queueName, idApp, idJob, jobName, epoch, orgIds } = args
  const counts = { enqueued: 0, deduped: 0, coalesced: 0 }
  if (orgIds.length === 0) return counts
  const windowMs = spreadWindowMs(args.gapMs, orgIds.length)
  const delays = spreadDelays(orgIds, idApp, idJob, windowMs)
  await watchFanoutEpoch(idApp, idJob, orgIds, epoch)
  const retainMs = retentionMs(args.gapMs)
  const queue = getPhysicalQueue(queueName)

  for (let start = 0; start < orgIds.length; start += FANOUT_BATCH) {
    // Stopped by the drain: the job goes back unspent and its re-run adds
    // only what this one did not (the ids say what exists).
    if (args.signal?.aborted) throw new Error("fan-out tick aborted by shutdown")
    const batch = orgIds.slice(start, start + FANOUT_BATCH)
    const keys = batch.flatMap((orgId) => [
      fanoutMarkerKey(idApp, idJob, orgId, epoch),
      fanoutPendingKey(idApp, idJob, orgId),
    ])
    const values = await redis.mget(...keys)
    const candidates: Array<{ orgId: string; pendingEpoch: number | null }> = []
    batch.forEach((orgId, i) => {
      if (values[2 * i] !== null) {
        counts.deduped++
        return
      }
      const pending = values[2 * i + 1]
      candidates.push({ orgId, pendingEpoch: pending === null ? null : Number(pending) })
    })
    // A pending mark is trusted only while its job really waits: one left by a
    // job that started before the mark was written is stale, and ignored.
    const pendingIds = candidates
      .filter((c) => c.pendingEpoch !== null && c.pendingEpoch !== epoch)
      .map((c) => fanoutJobId(idApp, idJob, c.orgId, c.pendingEpoch as number))
    const states = await Promise.all(pendingIds.map((id) => queue.getJobState(id)))
    const waiting = new Set(pendingIds.filter((_, i) => NOT_STARTED.has(String(states[i]))))
    const entries: FanoutJobEntry[] = []
    const coalesced: string[] = []
    for (const c of candidates) {
      if (c.pendingEpoch !== null && c.pendingEpoch !== epoch) {
        if (waiting.has(fanoutJobId(idApp, idJob, c.orgId, c.pendingEpoch))) {
          counts.coalesced++
          coalesced.push(c.orgId)
          continue
        }
      }
      entries.push({
        name: jobName,
        data: { orgId: c.orgId, _fanout: { app: idApp, job: idJob, epoch }, ...args.extraData },
        jobId: fanoutJobId(idApp, idJob, c.orgId, epoch),
        delay: Math.max(0, epoch + (delays.get(c.orgId) ?? 0) - Date.now()),
        attempts: args.attempts,
        backoff: args.backoff,
        retainMs,
      })
    }
    // The job still waits: its pending mark lives as long, or a later tick
    // past its expiry would add a second job for the org.
    if (coalesced.length > 0) {
      await countFanoutCoalesced(idApp, idJob, coalesced, epoch)
      const pipe = redis.pipeline()
      for (const orgId of coalesced) pipe.pexpire(fanoutPendingKey(idApp, idJob, orgId), retainMs)
      await pipe.exec()
    }
    if (entries.length === 0) continue
    await addFanoutJobs(queueName, entries)
    await fanoutTestState.afterAdd?.()
    await exitAfterAddOnce(idApp)
    const pipe = redis.pipeline()
    for (const e of entries) {
      const orgId = e.data.orgId as string
      pipe.set(fanoutMarkerKey(idApp, idJob, orgId, epoch), "1", "PX", retainMs)
      pipe.set(fanoutPendingKey(idApp, idJob, orgId), String(epoch), "PX", retainMs)
    }
    await pipe.exec()
    counts.enqueued += entries.length
  }
  return counts
}

/** Test seam: exit right after the first add, once per arming (a crash between add and markers). */
/** Test seam key: armed for one app, the next tick of that app that adds exits its process. */
export const fanoutExitAfterAddKey = (app: string) => `fanout:test:exit-after-add:${app}`

async function exitAfterAddOnce(app: string): Promise<void> {
  if (!isTestEnv() || !env.LIAISON_TEST_FANOUT_EXIT_AFTER_ADD) return
  const armed = await redis.getdel(fanoutExitAfterAddKey(app))
  if (armed !== null) {
    log.warn({ app }, "LIAISON_TEST_FANOUT_EXIT_AFTER_ADD: exiting after the add")
    process.exit(137)
  }
}

// --- The tick -------------------------------------------------------------

/** The scheduled (app, job) pairs of this process's catalog: a tick for any other enqueues nothing. */
const knownScheduledJobs = new Map<string, Set<string>>()

/** Record the scheduled jobs of one app in this process's catalog (replacing its previous set). */
export function rememberScheduledJobs(app: string, jobs: Iterable<string> | null): void {
  if (jobs === null) knownScheduledJobs.delete(app)
  else knownScheduledJobs.set(app, new Set(jobs))
}

function isKnownScheduledJob(app: string, job: string): boolean {
  return knownScheduledJobs.get(app)?.has(job) === true
}

/**
 * An installed app this process has not seen yet (activated by another
 * process after this one booted): read its active version's manifest now.
 */
async function refreshInstalledApp(app: string): Promise<void> {
  try {
    const desc = await fanoutReconcileSources.installedDescriptor(app)
    if (!desc) return
    rememberScheduledJobs(
      app,
      fanoutTemplatesOf(desc).map((t) => t.job),
    )
    bindCatalogAppQueues([desc])
  } catch (err) {
    log.warn({ err, app }, "Could not read an app's active manifest for its fan-out tick")
  }
}

/**
 * An app another process installed or switched (activation.ts follows it): its
 * queue is consumed here and its scheduled jobs known at once, not at the next
 * tick or upkeep (S1.2).
 */
export async function followInstalledAppJobs(app: string): Promise<void> {
  await refreshInstalledApp(app)
}

/**
 * One tick of an (app, job)'s fan-out scheduler: list the orgs, keep those with
 * the app on (and an `error` one once an hour, so its registration retries),
 * enqueue one job each for this epoch.
 */
export async function runAppCronFanoutTick(
  data: FanoutTemplate,
  ctx?: JobRunContext,
): Promise<FanoutCounts> {
  const { app, job } = data
  const epoch = ctx?.firedAt
  if (epoch === undefined) throw new Error(`fan-out tick ${app}:${job} has no scheduled fire time`)
  const empty = {
    enqueued: 0,
    deduped: 0,
    coalesced: 0,
    skippedOff: 0,
    skippedError: 0,
    skippedRunsFor: 0,
  }
  // An app this process does not run (removed, or not yet seen here): nothing
  // to enqueue. The reconcile removes a scheduler whose app is gone.
  if (!isKnownScheduledJob(app, job)) await refreshInstalledApp(app)
  if (!isKnownScheduledJob(app, job)) {
    await countJobMetrics({ fanout_skip_unknown_app: 1 })
    log.warn({ app, job }, "fan-out tick for an app job this process does not know: skipped")
    return empty
  }
  const orgs = await enumerateFanoutOrgs(app)
  const included: string[] = []
  const errorOrgs: string[] = []
  let skippedOff = 0
  for (const o of orgs) {
    if (o.status === null || o.status === "active") included.push(o.orgId)
    else if (o.status === "error") errorOrgs.push(o.orgId)
    else skippedOff++
  }
  let skippedError = 0
  if (errorOrgs.length > 0) {
    const pipe = redis.pipeline()
    for (const orgId of errorOrgs) {
      pipe.set(fanoutErrorRetryKey(app, orgId), "1", "PX", ERROR_RETRY_MS, "NX")
    }
    const res = (await pipe.exec()) ?? []
    errorOrgs.forEach((orgId, i) => {
      if (res[i]?.[1] === "OK") included.push(orgId)
      else skippedError++
    })
  }
  // The job's precondition, for every org at once. A failed check (a missing
  // table mid-upgrade, a Postgres blip) runs every org, as before runsFor:
  // never a silently skipped run.
  let eligible = included
  if (data.runsFor && included.length > 0) {
    try {
      const met = await orgsMeetingRunsFor(app, data.runsFor, included)
      eligible = included.filter((o) => met.has(o))
    } catch (err) {
      await countJobMetrics({ fanout_runs_for_error: 1 })
      log.warn({ err, app, job }, "fan-out runsFor check failed: running every org this tick")
    }
  }
  const skippedRunsFor = included.length - eligible.length
  if (data.runsFor) {
    const kept = new Set(eligible)
    await countFanoutRunsFor(
      app,
      job,
      included.filter((o) => !kept.has(o)),
      eligible.length,
      epoch,
    )
  }
  const gapMs = data.everyMs ?? nextGapMs(data.cron, epoch)
  const counts = await fanOutEpoch({
    queueName: `app-${app}`,
    idApp: app,
    idJob: job,
    jobName: job,
    epoch,
    gapMs,
    orgIds: eligible,
    attempts: data.attempts,
    backoff: data.backoff,
    signal: ctx?.signal,
  })
  // Totals, and the same per (app, job) for /diag.
  await countJobMetrics({
    fanout_ticks: 1,
    fanout_enqueued: counts.enqueued,
    fanout_deduped: counts.deduped,
    fanout_coalesced: counts.coalesced,
    [`fanout_ticks:${app}:${job}`]: 1,
    [`fanout_enqueued:${app}:${job}`]: counts.enqueued,
    [`fanout_deduped:${app}:${job}`]: counts.deduped,
    [`fanout_coalesced:${app}:${job}`]: counts.coalesced,
    [`fanout_skip_error:${app}:${job}`]: skippedError,
    fanout_skip_runs_for: skippedRunsFor,
    [`fanout_skip_runs_for:${app}:${job}`]: skippedRunsFor,
  })
  if (counts.enqueued > 0) {
    log.info({ app, job, epoch, ...counts, skippedError, skippedRunsFor }, "fan-out tick enqueued")
  } else {
    log.debug(
      { app, job, epoch, ...counts, skippedError, skippedRunsFor },
      "fan-out tick enqueued nothing",
    )
  }
  return { ...counts, skippedOff, skippedError, skippedRunsFor }
}

// --- The schedulers -------------------------------------------------------

/** A descriptor as the sync reads it: its name and its manifest jobs. */
export interface FanoutAppDescriptor {
  name: string
  jobs?: unknown
}

/** A tick that fails (Redis blip, Postgres failover) retries on any worker. */
const TICK_ATTEMPTS = 5
const TICK_BACKOFF = { type: "fixed", delay: 2_000 } as const
/** Every job host re-upserts its catalog's schedulers this often; the leader reconciles as often. */
const UPKEEP_INTERVAL_MS = 10 * 60_000

/** The fan-out templates of an app's scheduled manifest jobs. */
export function fanoutTemplatesOf(desc: FanoutAppDescriptor): FanoutTemplate[] {
  if (isKernelApp(desc.name)) return []
  const jobs = desc.jobs
  if (!jobs || typeof jobs !== "object") return []
  const out: FanoutTemplate[] = []
  for (const [job, raw] of Object.entries(jobs as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue
    const def = raw as {
      schedule?: unknown
      runsFor?: unknown
      retry?: { attempts?: unknown; backoff?: unknown }
    }
    if (typeof def.schedule !== "string" || def.schedule === "") continue
    const attempts = typeof def.retry?.attempts === "number" ? def.retry.attempts : 3
    const backoffType = typeof def.retry?.backoff === "string" ? def.retry.backoff : "exponential"
    const everyMs = isTestEnv() ? env.LIAISON_TEST_FANOUT_EVERY_MS : undefined
    out.push({
      app: desc.name,
      job,
      cron: def.schedule,
      ...(everyMs ? { everyMs } : {}),
      attempts,
      backoff: { type: backoffType, delay: 1000 },
    })
    // Only when declared, so an unchanged manifest leaves its scheduler as it is.
    const runsFor = runsForCheckOf(desc.name, def.runsFor)
    if (runsFor) out[out.length - 1]!.runsFor = runsFor
  }
  return out
}

function kernelCronQueue() {
  return getJobQueue("kernel", APP_CRON_FANOUT_JOB)
}

/** Upsert one (app, job) fan-out scheduler on `kernel-cron` from its template. */
export async function upsertFanoutTemplate(t: FanoutTemplate): Promise<void> {
  const queue = kernelCronQueue()
  const id = fanoutSchedulerId(t.app, t.job)
  // Only when missing or changed: an upsert replaces the scheduler's current
  // tick (BullMQ removes the delayed or waiting `repeat:<id>:<millis>` job and
  // computes the next fire after now), so re-upserting an unchanged scheduler
  // at a boot or upkeep that lands on a fire time would lose that epoch.
  const current = await queue.getJobScheduler(id)
  if (current && sameFanoutScheduler(current, t)) return
  await queue.upsertJobScheduler(id, t.everyMs ? { every: t.everyMs } : { pattern: t.cron }, {
    name: APP_CRON_FANOUT_JOB,
    data: t,
    opts: { attempts: TICK_ATTEMPTS, backoff: { ...TICK_BACKOFF } },
  })
}

/** The stored scheduler already fires `t` as `t` says (repeat, template data and tick options). */
function sameFanoutScheduler(
  s: {
    name?: string
    pattern?: string | null
    every?: number | string | null
    template?: { data?: unknown; opts?: { attempts?: number; backoff?: unknown } }
  },
  t: FanoutTemplate,
): boolean {
  const repeatSame = t.everyMs
    ? Number(s.every) === t.everyMs && !s.pattern
    : s.pattern === t.cron && !s.every
  return (
    repeatSame &&
    s.name === APP_CRON_FANOUT_JOB &&
    stableJson(s.template?.data) === stableJson(t) &&
    s.template?.opts?.attempts === TICK_ATTEMPTS &&
    stableJson(s.template?.opts?.backoff) === stableJson(TICK_BACKOFF)
  )
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  )
}

/** The fan-out scheduler ids on `kernel-cron`, optionally of one app only. */
async function fanoutSchedulerIds(app?: string): Promise<string[]> {
  const prefix = app === undefined ? `${APP_CRON_FANOUT_JOB}:` : `${APP_CRON_FANOUT_JOB}:${app}:`
  const all = await kernelCronQueue().getJobSchedulers(0, -1)
  return all.map((s) => s.key ?? s.id ?? "").filter((id) => id.startsWith(prefix))
}

/**
 * Upsert one fan-out scheduler per scheduled (app, job) of `apps` and record
 * them as this process's catalog. Removes nothing: another process may run a
 * newer catalog (a rolling deploy), so a job missing here is not proof it is
 * gone. Idempotent; every job host runs it at boot.
 */
export async function upsertAppCronFanout(
  apps: ReadonlyArray<FanoutAppDescriptor>,
): Promise<number> {
  let n = 0
  for (const desc of apps) {
    const templates = fanoutTemplatesOf(desc)
    if (isKernelApp(desc.name)) continue
    rememberScheduledJobs(
      desc.name,
      templates.map((t) => t.job),
    )
    for (const t of templates) {
      await upsertFanoutTemplate(t)
      n++
    }
  }
  log.info({ schedulers: n }, "Cron fan-out schedulers upserted")
  return n
}

/**
 * An app switched to another version (or uninstalled, `desc` null): its
 * fan-out schedulers become exactly the ones that version declares. Its own
 * descriptor is authoritative here, so removing the rest is safe.
 */
export async function syncAppCronFanoutForApp(
  name: string,
  desc: FanoutAppDescriptor | null,
): Promise<{ upserted: number; removed: number }> {
  const templates = desc ? fanoutTemplatesOf(desc) : []
  for (const t of templates) await upsertFanoutTemplate(t)
  const keep = new Set(templates.map((t) => fanoutSchedulerId(t.app, t.job)))
  let removed = 0
  for (const id of await fanoutSchedulerIds(name)) {
    if (keep.has(id)) continue
    if (await kernelCronQueue().removeJobScheduler(id)) removed++
  }
  rememberScheduledJobs(name, desc ? templates.map((t) => t.job) : null)
  if (desc) bindCatalogAppQueues([desc])
  if (removed > 0 || templates.length > 0) {
    log.info({ app: name, upserted: templates.length, removed }, "Cron fan-out schedulers synced")
  }
  return { upserted: templates.length, removed }
}

/** Remove every fan-out scheduler of an uninstalled app. Best effort: never throws. */
export async function removeAppCronFanout(name: string): Promise<void> {
  try {
    await syncAppCronFanoutForApp(name, null)
  } catch (err) {
    log.warn({ err, app: name }, "Could not remove an uninstalled app's fan-out schedulers")
  }
}

/** Seams for the reconcile's two sources of truth (tests). */
export const fanoutReconcileSources: {
  inTreeApps: () => Promise<FanoutAppDescriptor[]>
  activeAppNames: () => Promise<Set<string>>
  installedDescriptor: (name: string) => Promise<FanoutAppDescriptor | null>
} = {
  inTreeApps: async () => {
    const { getDefaultApps } = await import("~/modules/apps/init")
    const { discoverInTreeApps } = await import("~/modules/apps/discover-apps")
    const inTree = new Set((await discoverInTreeApps()).map((a) => a.name))
    return (await getDefaultApps()).filter((a) => inTree.has(a.name))
  },
  activeAppNames: async () => {
    const { activeVersionRows } = await import("~/modules/apps/activation")
    const rows = await withSystemDb("app-cron-fanout:reconcile", (db) => activeVersionRows(db))
    return new Set(rows.map((r) => r.name))
  },
  installedDescriptor: async (name) => {
    const { readInstalledAppDescriptor } = await import("~/modules/apps/init")
    return readInstalledAppDescriptor(name)
  },
}

/**
 * The leader's cleanup: remove the fan-out schedulers of an app that is gone,
 * one with no active version in the database and not in-tree for this release.
 * It never removes a job of an app that is still installed: the leader may run
 * an older release than the one that declared the job (a rolling deploy), so
 * a job it does not know is not proof the job is gone. A job dropped by a new
 * version is removed by that version's activation (syncAppCronFanoutForApp).
 * Returns the count removed.
 */
export async function reconcileAppCronFanout(signal?: AbortSignal): Promise<number> {
  const ids = await fanoutSchedulerIds()
  if (ids.length === 0) return 0
  const inTree = new Set((await fanoutReconcileSources.inTreeApps()).map((d) => d.name))
  const active = await fanoutReconcileSources.activeAppNames()
  let removed = 0
  for (const id of ids) {
    if (signal?.aborted) break
    const rest = id.slice(APP_CRON_FANOUT_JOB.length + 1)
    const app = rest.slice(0, rest.indexOf(":"))
    const job = rest.slice(rest.indexOf(":") + 1)
    if (active.has(app) || inTree.has(app)) continue
    if (await kernelCronQueue().removeJobScheduler(id)) {
      removed++
      log.info({ app, job, schedulerId: id }, "Removed a fan-out scheduler no app declares")
    }
  }
  return removed
}

/**
 * Job host upkeep: re-upsert this catalog's schedulers every 10 min, so one an
 * older release's leader removed during a rolling deploy comes back. And the
 * leader's reconcile, on acquire and as often (detached from the hook chain).
 */
export function startAppCronFanoutUpkeep(getCatalog: () => Promise<FanoutAppDescriptor[]>): void {
  const upkeep = setInterval(() => {
    if (isShuttingDown()) return
    void getCatalog()
      .then((apps) => upsertAppCronFanout(apps))
      .catch((err) => log.warn({ err }, "Cron fan-out scheduler upkeep failed"))
  }, UPKEEP_INTERVAL_MS)
  upkeep.unref?.()
  let timer: ReturnType<typeof setInterval> | undefined
  let abort: AbortController | undefined
  const runReconcile = () => {
    const signal = abort?.signal
    void reconcileAppCronFanout(signal).catch((err) =>
      log.warn({ err }, "Cron fan-out scheduler reconcile failed"),
    )
  }
  registerSingleton({
    name: "app-cron-fanout-reconcile",
    onAcquired: async () => {
      abort = new AbortController()
      runReconcile()
      timer = setInterval(runReconcile, UPKEEP_INTERVAL_MS)
      timer.unref?.()
    },
    onLost: async () => {
      abort?.abort()
      if (timer) clearInterval(timer)
      timer = undefined
    },
  })
}

/** Register the tick's handler (every role: enqueueing asserts a local handler). */
export function registerAppCronFanout(): void {
  registerJobWorker<FanoutTemplate>("kernel", "app-cron-fanout", async (data, ctx) => {
    await runAppCronFanoutTick(data, ctx)
  })
}

// --- Upgrade: the pre-fan-out per-org schedulers go -----------------------

/**
 * Remove every pre-fan-out per-org scheduler (`<job>-scheduler-<orgId>`) on
 * every `app-*` queue, found in Redis (a queue this process never bound is
 * covered too). A tick already due is converted to its fan-out job first. Stops between queues when `signal` aborts. Returns the count.
 */
export async function sweepLegacyPerOrgSchedulers(
  opts: { signal?: AbortSignal } = {},
): Promise<number> {
  const repeatSuffix = ":repeat"
  const queueNames = new Set<string>()
  let cursor = "0"
  do {
    const [next, keys] = await redisBullMQ.scan(
      cursor,
      "MATCH",
      `${bullPrefix}:app-*${repeatSuffix}`,
      "COUNT",
      500,
      "TYPE",
      "zset",
    )
    cursor = next
    for (const key of keys) queueNames.add(key.slice(bullPrefix.length + 1, -repeatSuffix.length))
  } while (cursor !== "0" && !opts.signal?.aborted)
  let removed = 0
  for (const queueName of queueNames) {
    if (opts.signal?.aborted) break
    const queue = getPhysicalQueue(queueName)
    for (const s of await queue.getJobSchedulers(0, -1)) {
      const id = s.key ?? s.id ?? ""
      if (!LEGACY_PER_ORG_SCHEDULER_RE.test(id)) continue
      // A tick already due goes with its scheduler: its run becomes the
      // fan-out job of that (org, epoch) first, so the epoch is not lost.
      if (typeof s.next === "number" && s.next <= Date.now()) {
        await addLegacyTickAsFanoutJob({
          queueName,
          app: queueName.slice("app-".length),
          job: s.name,
          schedulerId: id,
          epoch: s.next,
          attempts: s.template?.opts?.attempts,
        })
      }
      if (await queue.removeJobScheduler(id)) removed++
    }
  }
  if (removed > 0) log.info({ removed }, "Removed pre-fan-out per-org app schedulers")
  return removed
}

/**
 * The leader's one sweep per acquire, detached from the singleton hook chain
 * (a long sweep must not delay the next singleton) and stopped on loss.
 */
export function legacySchedulerSweepSingleton(
  sweep: (opts: { signal: AbortSignal }) => Promise<number> = sweepLegacyPerOrgSchedulers,
): { name: string; onAcquired: () => Promise<void>; onLost: () => Promise<void> } {
  let abort: AbortController | undefined
  return {
    name: "legacy-app-scheduler-sweep",
    onAcquired: async () => {
      abort = new AbortController()
      void sweep({ signal: abort.signal }).catch((err) =>
        log.warn({ err }, "Sweeping pre-fan-out per-org schedulers failed"),
      )
    },
    onLost: async () => {
      abort?.abort()
    },
  }
}

/** Register the legacy sweep as a cell singleton (job hosts). */
export function startLegacySchedulerSweep(): void {
  registerSingleton(legacySchedulerSweepSingleton())
}
