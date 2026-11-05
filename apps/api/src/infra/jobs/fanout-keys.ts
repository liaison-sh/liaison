// SPDX-License-Identifier: FSL-1.1-ALv2
// The Redis side of the cron fan-out (fanout.ts): marker and pending keys, the
// cell-wide counters, the per-org job options. Imported by the dispatcher
// (jobs.ts) and the tick (fanout-runtime.ts); imports neither.
import type { JobsOptions } from "bullmq"
import { env, isTestEnv } from "~/lib/env"
import { anyLoadOrg, isLoadOrg, loadHarnessEnabled } from "~/lib/load-harness"
import { jobsLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import { parseFanoutJobId } from "./fanout"

/** Written after an epoch's job was added for an org: a re-run skips the add. */
export const fanoutMarkerKey = (app: string, job: string, orgId: string, epoch: number) =>
  `fanout:done:${app}:${job}:${orgId}:${epoch}`
/** The epoch of an org's job not started yet: the next tick coalesces into it. */
export const fanoutPendingKey = (app: string, job: string, orgId: string) =>
  `fanout:pending:${app}:${job}:${orgId}`
/** One registration retry per hour for an org whose app is in `error`. */
export const fanoutErrorRetryKey = (app: string, orgId: string) => `fanout:errretry:${app}:${orgId}`
/**
 * The load harness's per-org run counters (load orgs only, 24 h): how many
 * times the (org, epoch) job started a first attempt, when the first one
 * started, and whether the tick coalesced the org instead of adding a job.
 * The harness's fan-out report (fanout-report.ts) reads them.
 */
export const fanoutRunsKey = (app: string, job: string, orgId: string, epoch: number) =>
  `fanout:runs:${app}:${job}:${orgId}:${epoch}`
export const fanoutRunAtKey = (app: string, job: string, orgId: string, epoch: number) =>
  `fanout:runat:${app}:${job}:${orgId}:${epoch}`
export const fanoutCoalescedKey = (app: string, job: string, orgId: string, epoch: number) =>
  `fanout:coalesced:${app}:${job}:${orgId}:${epoch}`
/** The tick skipped this load org for `epoch`: its `runsFor` precondition did not hold. */
export const fanoutSkippedKey = (app: string, job: string, orgId: string, epoch: number) =>
  `fanout:skipped:${app}:${job}:${orgId}:${epoch}`
/** How many orgs the tick spread `epoch` over (its spread window is sized on them). */
export const fanoutSpreadOrgsKey = (app: string, job: string, epoch: number) =>
  `fanout:spreadorgs:${app}:${job}:${epoch}`
/** How long the per-org run counters live. */
/** A tick that ran at least one load org: the org count it sized its spread window on. */
export const fanoutWatchKey = (app: string, job: string, epoch: number) =>
  `fanout:watch:${app}:${job}:${epoch}`
/** A watched epoch's first-attempt starts, every org's (load or not): org -> ms. */
export const fanoutStartsKey = (app: string, job: string, epoch: number) =>
  `fanout:starts:${app}:${job}:${epoch}`
export const FANOUT_RUN_COUNTER_TTL_S = 24 * 3600
/** Cell-wide job counters (one hash: every process adds to it, /diag reads it). */
export const JOBS_METRICS_KEY = "jobs:metrics"

/** Add to the cell-wide job counters. Best effort: a Redis error is logged, never thrown. */
export async function countJobMetrics(fields: Record<string, number>): Promise<void> {
  const entries = Object.entries(fields).filter(([, n]) => n !== 0)
  if (entries.length === 0) return
  try {
    const pipe = redis.pipeline()
    for (const [field, n] of entries) pipe.hincrby(JOBS_METRICS_KEY, field, n)
    await pipe.exec()
  } catch (err) {
    log.warn({ err, fields }, "Could not record job counters")
  }
}

/** The cell-wide job counters, for /diag and tests. */
export async function readJobMetrics(): Promise<Record<string, number>> {
  const raw = await redis.hgetall(JOBS_METRICS_KEY)
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = Number(v)
  return out
}

// Compare-and-delete: only the job of the epoch the key names frees it.
const RELEASE_PENDING_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`

/**
 * A fan-out job started: its org may get the next epoch's job. Decided from
 * the BullMQ id alone (`fo.…`), which an app cannot choose. Best effort: a
 * pending key left behind is checked against the job's state by the next tick.
 */
export async function releaseFanoutPending(jobId: string | undefined): Promise<void> {
  if (!jobId?.startsWith("fo.")) return
  const parts = parseFanoutJobId(jobId)
  if (!parts) return
  try {
    await redis.eval(
      RELEASE_PENDING_LUA,
      1,
      fanoutPendingKey(parts.app, parts.job, parts.orgId),
      String(parts.epoch),
    )
  } catch (err) {
    log.warn({ err, jobId }, "Could not release a fan-out job's pending mark")
  }
}

/** The load-org check of the run counters (a test's, or the harness's). */
function loadOrgCheck(orgId: string): Promise<boolean> {
  return (fanoutTestState.isLoadOrg ?? isLoadOrg)(orgId)
}

/** Is the run counter on at all: the harness key set (or a test's check). */
function anyLoadOrgCheck(orgIds: readonly string[]): Promise<boolean> {
  const check = fanoutTestState.isLoadOrg
  if (!check) return anyLoadOrg(orgIds)
  return Promise.all(orgIds.map((o) => check(o).catch(() => false))).then((f) => f.some(Boolean))
}

// Records a first-attempt start in a watched epoch, once per org.
const RECORD_START_LUA = `if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('HSETNX', KEYS[2], ARGV[1], ARGV[2])
  redis.call('EXPIRE', KEYS[2], ARGV[3])
end
return 0`

function runCountersOn(): boolean {
  return fanoutTestState.isLoadOrg !== undefined || loadHarnessEnabled()
}

/**
 * A fan-out job's first attempt started: for a load org, count the run of its
 * (org, epoch) and keep the first start time. Decided from the BullMQ id alone
 * (`fo.…`), like the pending release; a retry after a failure is the same run
 * and is not counted, a second start of a first attempt (a stalled job run
 * again) is. Best effort: never throws.
 */
export async function countFanoutRun(
  jobId: string | undefined,
  attemptsMade: number | undefined,
): Promise<void> {
  if (!jobId?.startsWith("fo.") || (attemptsMade ?? 0) > 0 || !runCountersOn()) return
  const parts = parseFanoutJobId(jobId)
  if (!parts) return
  const { app, job, orgId, epoch } = parts
  try {
    const now = Date.now()
    // The spread (S16) is judged on every run of a tick that ran a load org,
    // not on the load orgs alone: they are a sample of the tick's evenly
    // spaced ranks, and a sample clumps where the whole tick does not.
    await redis.eval(
      RECORD_START_LUA,
      2,
      fanoutWatchKey(app, job, epoch),
      fanoutStartsKey(app, job, epoch),
      orgId,
      String(now),
      String(FANOUT_RUN_COUNTER_TTL_S),
    )
    if (!(await loadOrgCheck(orgId))) return
    await redis
      .multi()
      .incr(fanoutRunsKey(app, job, orgId, epoch))
      .expire(fanoutRunsKey(app, job, orgId, epoch), FANOUT_RUN_COUNTER_TTL_S)
      .set(
        fanoutRunAtKey(app, job, orgId, epoch),
        String(now),
        "EX",
        FANOUT_RUN_COUNTER_TTL_S,
        "NX",
      )
      .exec()
  } catch (err) {
    log.debug({ err, jobId }, "Could not count a load org's fan-out run")
  }
}

/**
 * A fan-out job was handed back at a drain or shutdown (jobs.ts) and will run
 * again with the same attempt count: take back the run it counted when it
 * started, so the rerun is not read as a double. Same guards as
 * `countFanoutRun`; best effort, never throws.
 */
export async function uncountFanoutRun(
  jobId: string | undefined,
  attemptsMade: number | undefined,
): Promise<void> {
  if (!jobId?.startsWith("fo.") || (attemptsMade ?? 0) > 0 || !runCountersOn()) return
  const parts = parseFanoutJobId(jobId)
  if (!parts) return
  const { app, job, orgId, epoch } = parts
  try {
    if (!(await loadOrgCheck(orgId))) return
    const key = fanoutRunsKey(app, job, orgId, epoch)
    if (Number(await redis.get(key)) > 0) await redis.decr(key)
  } catch (err) {
    log.debug({ err, jobId }, "Could not take back a handed-back fan-out run")
  }
}

/** The tick coalesced these orgs for `epoch`: mark the load orgs among them. Never throws. */
export async function countFanoutCoalesced(
  app: string,
  job: string,
  orgIds: readonly string[],
  epoch: number,
): Promise<void> {
  if (orgIds.length === 0 || !runCountersOn()) return
  try {
    const flags = await Promise.all(orgIds.map((o) => loadOrgCheck(o).catch(() => false)))
    const load = orgIds.filter((_, i) => flags[i])
    if (load.length === 0) return
    const pipe = redis.pipeline()
    for (const orgId of load) {
      pipe.set(fanoutCoalescedKey(app, job, orgId, epoch), "1", "EX", FANOUT_RUN_COUNTER_TTL_S)
    }
    await pipe.exec()
  } catch (err) {
    log.debug({ err, app, job }, "Could not mark coalesced load orgs")
  }
}

/**
 * The tick ran `epoch` for `eligibleCount` orgs and skipped `skippedOrgIds` on
 * the job's `runsFor` precondition: mark the load orgs among the skipped ones
 * and the count the spread window was sized on, for the fan-out report. Never
 * throws.
 */
export async function countFanoutRunsFor(
  app: string,
  job: string,
  skippedOrgIds: readonly string[],
  eligibleCount: number,
  epoch: number,
): Promise<void> {
  if (!runCountersOn()) return
  try {
    const flags = await Promise.all(skippedOrgIds.map((o) => loadOrgCheck(o).catch(() => false)))
    const pipe = redis.pipeline()
    pipe.set(
      fanoutSpreadOrgsKey(app, job, epoch),
      String(eligibleCount),
      "EX",
      FANOUT_RUN_COUNTER_TTL_S,
    )
    skippedOrgIds.forEach((orgId, i) => {
      if (flags[i])
        pipe.set(fanoutSkippedKey(app, job, orgId, epoch), "1", "EX", FANOUT_RUN_COUNTER_TTL_S)
    })
    await pipe.exec()
  } catch (err) {
    log.debug({ err, app, job }, "Could not mark the load orgs runsFor skipped")
  }
}

/**
 * A tick about to run `orgIds` for `epoch`: when one of them is a load org,
 * mark the epoch watched (with the org count its spread window is sized on),
 * so every org's start is recorded for the report. Harness boxes only; never
 * throws.
 */
export async function watchFanoutEpoch(
  app: string,
  job: string,
  orgIds: readonly string[],
  epoch: number,
): Promise<void> {
  if (orgIds.length === 0 || !runCountersOn()) return
  try {
    if (!(await anyLoadOrgCheck(orgIds))) return
    await redis.set(
      fanoutWatchKey(app, job, epoch),
      String(orgIds.length),
      "EX",
      FANOUT_RUN_COUNTER_TTL_S,
    )
  } catch (err) {
    log.debug({ err, app, job }, "Could not watch a fan-out epoch for the load report")
  }
}

/** The fan-out ids in use: the BullMQ job id, or (test seam only) a deduplication id. */
function fanoutIdMode(): "job-id" | "deduplication" {
  return isTestEnv()
    ? (fanoutTestState.idMode ?? env.LIAISON_TEST_FANOUT_ID_MODE ?? "job-id")
    : "job-id"
}

/** BullMQ options of one per-org fan-out job. */
export function fanoutJobOptions(j: {
  jobId: string
  delay: number
  attempts: number
  backoff: { type: string; delay: number }
  retainMs: number
}): JobsOptions {
  const retainS = Math.ceil(j.retainMs / 1000)
  return {
    ...(fanoutIdMode() === "deduplication"
      ? { deduplication: { id: j.jobId } }
      : { jobId: j.jobId }),
    delay: Math.max(0, Math.floor(j.delay)),
    attempts: j.attempts,
    backoff: j.backoff,
    removeOnComplete: { age: retainS },
    removeOnFail: { age: 86_400 },
  }
}

/** Mutable test seams (tests only; production never sets them). */
export const fanoutTestState: {
  idMode?: "job-id" | "deduplication"
  /** Replaces the org enumeration (fanout-runtime.ts `enumerateFanoutOrgs`). */
  listOrgs?: (
    app: string,
  ) => Promise<Array<{ orgId: string; status: "active" | "disabled" | "error" | "removed" | null }>>
  /** Replaces the load-org check of the harness's run counters. */
  isLoadOrg?: (orgId: string) => Promise<boolean>
  /** Called between the add and the marker writes: a throw there is a crash. */
  afterAdd?: () => void | Promise<void>
} = {}
