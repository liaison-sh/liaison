// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Upstream-activity reports for the webhook-health signals (see ingest-health.ts).
//
// An app's upstream probe (manifest `webhookHealth.probe`) runs as a scheduled job, and jobs may run in a different
// process from the one serving /diag and the webhook routes. The report therefore
// lives in Redis, not in ingest-health's in-process counters: one hash per app,
// one field per org, so two installs of the same app never overwrite each other's
// view of their sender.
import { redis } from "~/lib/redis"
import type { UpstreamActivity, UpstreamProbeFailure } from "~/modules/webhooks/ingest-health"

const KEY_PREFIX = "webhook-upstream:"
/**
 * Why each org's probe last could not look (`{ probed: false, reason }`), kept apart
 * from the reports so a failure never reads as a quiet sender. Cleared by the next
 * report. Without it a probe refused by its provider (a token missing a permission)
 * reached the operator only as "no report on record", every hour, with the one fact
 * that says what to do left in the app logs.
 */
const FAILURE_KEY_PREFIX = "webhook-upstream-failure:"
/** Reports older than this are garbage; ingest-health judges freshness itself. */
const KEY_TTL_SEC = 7 * 86_400
/** An org's field this old belongs to a probe that stopped (app removed): ignore it. */
const FIELD_MAX_AGE_MS = 86_400_000

interface StoredReport {
  activityAt: number | null
  probedAt: number
}

/**
 * Parse a probe job's return value. The contract is `{ upstreamActivityAt }`: an
 * ISO timestamp of the newest change the sender knows about, or null when it has
 * nothing at all. Anything else is not a report (a probe that could not reach its
 * sender must not claim the sender is quiet), so it returns undefined.
 */
export function parseUpstreamProbeResult(
  result: unknown,
): { activityAtMs: number | null } | undefined {
  if (!result || typeof result !== "object" || !("upstreamActivityAt" in result)) return undefined
  const raw = (result as { upstreamActivityAt: unknown }).upstreamActivityAt
  if (raw === null) return { activityAtMs: null }
  if (typeof raw !== "string") return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? { activityAtMs: ms } : undefined
}

export async function reportUpstreamActivity(
  appName: string,
  orgId: string,
  activityAtMs: number | null,
  now = Date.now(),
): Promise<void> {
  const key = KEY_PREFIX + appName
  const report: StoredReport = { activityAt: activityAtMs, probedAt: now }
  await redis
    .multi()
    .hset(key, orgId, JSON.stringify(report))
    .expire(key, KEY_TTL_SEC)
    .hdel(FAILURE_KEY_PREFIX + appName, orgId)
    .exec()
}

/** Record why an org's probe could not look; the newest failure per org wins. */
export async function reportUpstreamProbeFailure(
  appName: string,
  orgId: string,
  reason: string,
  now = Date.now(),
): Promise<void> {
  const key = FAILURE_KEY_PREFIX + appName
  const failure: UpstreamProbeFailure = { reason: reason.slice(0, 300), failedAtMs: now }
  await redis.multi().hset(key, orgId, JSON.stringify(failure)).expire(key, KEY_TTL_SEC).exec()
}

/** The newest recorded probe failure per app, across orgs (same age cut as the reports). */
export async function readUpstreamProbeFailures(
  appNames: readonly string[],
  now = Date.now(),
): Promise<Map<string, UpstreamProbeFailure>> {
  const out = new Map<string, UpstreamProbeFailure>()
  for (const app of appNames) {
    const fields = await redis.hgetall(FAILURE_KEY_PREFIX + app)
    for (const raw of Object.values(fields)) {
      let f: UpstreamProbeFailure
      try {
        f = JSON.parse(raw) as UpstreamProbeFailure
      } catch {
        continue
      }
      if (typeof f.failedAtMs !== "number" || typeof f.reason !== "string") continue
      if (now - f.failedAtMs > FIELD_MAX_AGE_MS) continue
      const prev = out.get(app)
      if (!prev || f.failedAtMs > prev.failedAtMs) out.set(app, f)
    }
  }
  return out
}

/**
 * Combine every org's report into one per app: the newest activity and the newest
 * probe time across the orgs that reported. The ingest counters are per app, not
 * per org, so this is as precise as the comparison it feeds; taking the newest
 * probe time keeps an uninstalled org's leftover field from holding the whole app
 * stale for the key's lifetime.
 */
export async function readUpstreamActivity(
  appNames: readonly string[],
  now = Date.now(),
): Promise<Map<string, UpstreamActivity>> {
  const out = new Map<string, UpstreamActivity>()
  for (const app of appNames) {
    const fields = await redis.hgetall(KEY_PREFIX + app)
    let activityAtMs: number | null = null
    let probedAtMs = 0
    let any = false
    for (const raw of Object.values(fields)) {
      let r: StoredReport
      try {
        r = JSON.parse(raw) as StoredReport
      } catch {
        continue
      }
      if (typeof r.probedAt !== "number" || now - r.probedAt > FIELD_MAX_AGE_MS) continue
      any = true
      probedAtMs = Math.max(probedAtMs, r.probedAt)
      if (typeof r.activityAt === "number") {
        activityAtMs = Math.max(activityAtMs ?? 0, r.activityAt)
      }
    }
    if (any) out.set(app, { activityAtMs, probedAtMs })
  }
  return out
}
