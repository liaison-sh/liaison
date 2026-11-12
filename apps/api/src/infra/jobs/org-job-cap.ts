// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-org background-job cap (`caps.jobsPerHour`, modules/org/caps.ts).
//
// Jobs are counted per org per clock hour (UTC) in Redis. Over the cap a job is
// DELAYED, never refused: at enqueue it takes the first hour bucket N, from the
// hour it is due in, that still has room, counts there, and is delayed to the
// start of N. Delayed jobs therefore count in the hour they run, so a backlog
// spreads over the following hours instead of landing in one burst. The search
// is bounded at 24 hours: a job finding no room in a day is enqueued as it was
// and logged (counted in its own hour).
//
// Scheduler-made jobs (BullMQ job schedulers, the cron fan-out's per-org jobs)
// are already periodic: they are counted when they start, in the current hour,
// and never delayed (countScheduledOrgJob, from the dispatch).
//
// Exempt, never counted and never delayed: jobs without an org, and the jobs a
// person triggered and waits on, listed in ORG_JOB_CAP_EXEMPT (by name) and
// ORG_JOB_CAP_EXEMPT_WHEN (by payload, a routine's "Run now"). An org without
// the cap costs nothing here (its cap is read from a 60 s cache, no Redis call).
//
// Accepted overcount: a job is counted before BullMQ adds it, so an
// add that deduplicates onto an existing job id, a delayed job removed before
// it runs, or a retry loop that re-enqueues counts too. An explicit job id
// taken already cannot be told apart from a fresh add without one more Redis
// round trip per job; the overcount only delays later work (bounded at 24 h),
// it never drops any.

import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { organizations } from "~/db/schema/kernel"
import { jobsLogger as log } from "~/lib/logger"
import { redis } from "~/lib/redis"
import {
  capOf,
  hourBucket,
  hourBucketStart,
  jobBucketKey,
  normalizeCaps,
  noteJobHourCount,
} from "~/modules/org/caps"
import { kernelQueueClassOf } from "./queue-classes"

/**
 * Jobs a person triggered and is waiting on: never counted, never delayed.
 * Keyed `<app>:<job name>` (`kernel:` for kernel jobs). Background
 * periodic work stays capped. A job name a person shares with the cron path
 * is in ORG_JOB_CAP_EXEMPT_WHEN instead, decided by its payload.
 */
export const ORG_JOB_CAP_EXEMPT: ReadonlySet<string> = new Set([
  // Interactive agent turns: a person posted, approved or answered and waits
  // for the agent's reply.
  "kernel:agent-subrun", // a sub-agent the person's own turn waits for
  "kernel:agent-reinvoke", // the agent picking up the person's turn again
  "kernel:agent-turn-dispatch", // a posted message handed over by a draining process
  "kernel:agent-turn-resume", // a person's turn resumed after its process died
  "kernel:scope-request-decision-turn", // the turn after a person granted or refused a scope
  "kernel:secret-request-turn", // the turn after a person supplied a secret
  "kernel:setup-kickoff", // the first-run setup conversation a person started
  "kernel:approval-result-turn", // the turn after a person approved or rejected
  // Timers of a person's own request: delaying them changes what they do.
  "kernel:approval-expiry", // a pending approval's expiry
  "kernel:approval-poll-output", // the output of an approved action the person waits for
  "kernel:check-device-flow-expiry", // a sign-in device code's expiry
  "kernel:notify-desktop-fallback", // the fallback notice of a person's desktop request
  // Outbound actions a person triggered.
  "mail:gmail-write-back", // a person's mail action (send, archive, label) written to Gmail
  "calendar:calendar-push", // a person's calendar change pushed to the provider
  // Work a person (or the operator) started and watches the result of.
  "kernel:imports-run", // an import a person started; its progress is on screen
  "kernel:org-export", // the archive an admin asked for; its row says "queued" until it runs
  "kernel:org-delete", // the operator's org deletion, followed by the CLI
  "kernel:mailbox-purge", // the erasure of a disconnected mailbox's mail, a privacy promise
  // An upload's or a pasted link's derivatives, shown right after the upload.
  "kernel:files-thumbnail", // the thumbnail of a file just uploaded
  "kernel:files-link-ingest", // the preview of a link just pasted
  "kernel:files-media-analysis", // the description of an image or audio just uploaded
])

/**
 * Jobs exempt for some payloads only: the same job name runs for a person and
 * for the cron path. Keyed like ORG_JOB_CAP_EXEMPT.
 */
export const ORG_JOB_CAP_EXEMPT_WHEN: ReadonlyMap<string, (data: unknown) => boolean> = new Map([
  // A routine's "Run now" (skills-routines-tools.ts, `manual: true`): the
  // person asked for the agent run now. The scheduled tick stays capped.
  [
    "kernel:routine-tick",
    (data: unknown) => (data as { manual?: unknown } | null | undefined)?.manual === true,
  ],
])

/** The `<app>:<job>` key of a job on a queue. */
export function orgJobKey(queueName: string, jobName: string): string {
  const app =
    kernelQueueClassOf(queueName) !== undefined || queueName === "app-kernel"
      ? "kernel"
      : queueName.startsWith("app-")
        ? queueName.slice(4)
        : queueName
  return `${app}:${jobName}`
}

export function isOrgJobCapExempt(queueName: string, jobName: string, data?: unknown): boolean {
  const key = orgJobKey(queueName, jobName)
  if (ORG_JOB_CAP_EXEMPT.has(key)) return true
  return ORG_JOB_CAP_EXEMPT_WHEN.get(key)?.(data) === true
}

// --- The cap, cached -------------------------------------------------------

const CAP_CACHE_MS = 60_000
const capCache = new Map<string, { limit: number | null; at: number }>()

type CapReader = (orgId: string) => Promise<number | null>

const dbCapReader: CapReader = async (orgId) => {
  const [row] = await withSystemDb("org-job-cap-read", (db) =>
    db
      .select({ caps: organizations.caps })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1),
  )
  return capOf(normalizeCaps(row?.caps), "jobsPerHour")
}
let capReader: CapReader = dbCapReader

/** Test seams of the org job cap. */
export const OrgJobCapTestAccess = {
  /** Read caps from here instead of the database (null restores). */
  setReader(reader: CapReader | null): void {
    capReader = reader ?? dbCapReader
    capCache.clear()
  },
}

/** Forget cached caps (tests; a cap change otherwise applies within 60 s). */
export function resetOrgJobCapCache(): void {
  capCache.clear()
}

async function jobCapOf(orgId: string): Promise<number | null> {
  const hit = capCache.get(orgId)
  const now = Date.now()
  if (hit && now - hit.at < CAP_CACHE_MS) return hit.limit
  try {
    const limit = await capReader(orgId)
    capCache.set(orgId, { limit, at: now })
    return limit
  } catch (err) {
    // Fail open: an unreadable cap never holds work back.
    log.warn({ err, orgId }, "org job cap: could not read the cap; not limiting")
    return hit?.limit ?? null
  }
}

// --- Buckets ---------------------------------------------------------------

/** The search bound: 24 hour buckets, the due hour included. */
export const JOB_CAP_HORIZON_HOURS = 24
const BUCKET_TTL_S = (JOB_CAP_HORIZON_HOURS + 2) * 3600

// KEYS: the candidate buckets in order. ARGV[1] = limit, ARGV[2] = TTL.
// Returns {index, count}: the bucket taken and its count after the add, or
// {-1, count} when none had room (the first bucket is counted then).
const TAKE_BUCKET_LUA = `
local limit = tonumber(ARGV[1])
for i = 1, #KEYS do
  local n = tonumber(redis.call('GET', KEYS[i]) or '0')
  if n < limit then
    n = redis.call('INCR', KEYS[i])
    redis.call('EXPIRE', KEYS[i], tonumber(ARGV[2]))
    return {i - 1, n}
  end
end
local n = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return {-1, n}
`

/**
 * The delay (ms from now) a capped org's job must take, counting it in that
 * hour. `dueMs` is when the job would run without the cap. Null when the job
 * is not limited (no org, exempt, no cap, Redis down).
 */
export async function planOrgJobDelay(input: {
  orgId: string | undefined
  queueName: string
  jobName: string
  /** The job's payload (an exemption may depend on it, ORG_JOB_CAP_EXEMPT_WHEN). */
  data?: unknown
  dueMs: number
  now?: number
}): Promise<number | null> {
  const { orgId } = input
  if (!orgId || isOrgJobCapExempt(input.queueName, input.jobName, input.data)) return null
  const limit = await jobCapOf(orgId)
  if (limit === null) return null
  const now = input.now ?? Date.now()
  const first = hourBucket(Math.max(now, input.dueMs))
  const keys = Array.from({ length: JOB_CAP_HORIZON_HOURS }, (_, i) =>
    jobBucketKey(orgId, first + i),
  )
  let index: number
  let count: number
  try {
    const res = (await redis.eval(
      TAKE_BUCKET_LUA,
      keys.length,
      ...keys,
      String(limit),
      String(BUCKET_TTL_S),
    )) as [number, number]
    index = Number(res[0])
    count = Number(res[1])
  } catch (err) {
    log.warn({ err, orgId }, "org job cap: Redis failed; not limiting")
    return null
  }
  if (first === hourBucket(now)) void noteJobHourCount(orgId, index <= 0 ? count : limit, limit)
  if (index < 0) {
    log.warn(
      { orgId, queue: input.queueName, jobName: input.jobName, limit },
      "org job cap: no room in the next 24 hours; enqueued without delay",
    )
    return null
  }
  if (index === 0) return null
  return Math.max(0, hourBucketStart(first + index) - now)
}

/**
 * Count a scheduler-made job of a capped org in the current hour, at its
 * start. Never delays, never throws.
 */
export async function countScheduledOrgJob(input: {
  orgId: string
  queueName: string
  jobName: string
}): Promise<void> {
  if (isOrgJobCapExempt(input.queueName, input.jobName)) return
  const limit = await jobCapOf(input.orgId)
  if (limit === null) return
  try {
    const key = jobBucketKey(input.orgId, hourBucket(Date.now()))
    const n = await redis.incr(key)
    if (n === 1) await redis.expire(key, BUCKET_TTL_S)
    void noteJobHourCount(input.orgId, n, limit)
  } catch (err) {
    log.warn({ err, orgId: input.orgId }, "org job cap: could not count a scheduled job")
  }
}
