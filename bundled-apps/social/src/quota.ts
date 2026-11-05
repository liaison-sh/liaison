// SPDX-License-Identifier: FSL-1.1-ALv2
//
// YouTube daily-unit budget (§2.3 / §9 #3). The YouTube Data API meters every
// call in "units" (search.list = 100, commentThreads.list = 1) against a daily
// cap B. The sync engine reserves a discovery slice first, then spends the
// remainder on watch polls highest-priority-first — deferring the lowest-
// priority watches when the projected spend would exceed B, and reporting the
// deferred count so the Settings surface can raise a quota banner. Nothing is
// silently capped: a deferral is always counted and logged.

/** A mutable per-org/day unit counter. */
export class QuotaBudget {
  private spent = 0
  constructor(private readonly cap: number) {}

  /** Units consumed so far today. */
  consumed(): number {
    return this.spent
  }

  /** Units left before the cap. */
  remaining(): number {
    return Math.max(0, this.cap - this.spent)
  }

  /** Record `units` as spent. */
  consume(units: number): void {
    this.spent += Math.max(0, units)
  }
}

export interface WatchCandidate {
  id: string
  priority: number
}

export interface WatchBudgetPlan<T extends WatchCandidate> {
  /** Watches that fit in the remaining budget, highest priority first. */
  toPoll: T[]
  /** Watches deferred because the budget would be exceeded, lowest priority first. */
  deferred: T[]
  deferredCount: number
}

/**
 * Decide which watches to poll given the remaining unit budget. Watches are
 * sorted by descending priority; we admit as many as fit at `perWatchUnits`
 * each without exceeding `remaining`, deferring the rest (the lowest-priority
 * tail). A zero budget defers every watch.
 */
export function planWatchBudget<T extends WatchCandidate>(input: {
  remaining: number
  perWatchUnits: number
  watches: T[]
}): WatchBudgetPlan<T> {
  const { remaining, perWatchUnits, watches } = input
  const sorted = [...watches].sort((a, b) => b.priority - a.priority)
  const maxFit =
    perWatchUnits <= 0 ? sorted.length : Math.floor(Math.max(0, remaining) / perWatchUnits)
  const toPoll = sorted.slice(0, maxFit)
  const deferred = sorted.slice(maxFit)
  return { toPoll, deferred, deferredCount: deferred.length }
}

// ---------------------------------------------------------------------------
// YouTube quota day, budget split and the persisted read shape.
//
// Google meters the YouTube Data API per project per day and resets the
// counter at midnight America/Los_Angeles, not UTC. Everything below keys the
// day on that clock. The sandbox has no Intl time zones, so the US daylight
// saving rule (second Sunday of March 02:00 local -> first Sunday of November
// 02:00 local) is computed by hand.

/** Google's default YouTube Data API v3 project quota (units per day). */
export const YT_GOOGLE_DAILY_LIMIT = 10_000
/** Our self-imposed daily cap: the 1,000 units under Google's limit are the
 *  headroom for replies (comments.insert / commentThreads.insert, 50 units
 *  each) and any spend we do not meter. */
export const DEFAULT_YT_DAILY_BUDGET = 9_000
/** The most keyword + own-channel discovery may spend in one quota day. The
 *  rest of the cap (6,000+) belongs to watched-video comment polls, which
 *  matter more: a watched video is a known conversation, a search is a guess. */
export const YT_DISCOVERY_DAILY_SHARE = 3_000
/** Minimum spacing between two YouTube discovery runs. The discovery-sync job
 *  ticks every 15 minutes for every platform; YouTube runs every 2 hours, so
 *  with 2 terms a day costs about 12 x 230 = 2,760 units (inside the share). */
export const YT_DISCOVERY_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000

/** sync_state.metadata key carrying the YouTube quota fields of a ledger row. */
export const YT_QUOTA_METADATA_KEY = "youtube_quota"

function secondSundayOfMarchUtc(year: number): number {
  const firstDow = new Date(Date.UTC(year, 2, 1)).getUTCDay()
  const firstSunday = 1 + ((7 - firstDow) % 7)
  return Date.UTC(year, 2, firstSunday + 7, 10) // 02:00 PST = 10:00 UTC
}

function firstSundayOfNovemberUtc(year: number): number {
  const firstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay()
  const firstSunday = 1 + ((7 - firstDow) % 7)
  return Date.UTC(year, 10, firstSunday, 9) // 02:00 PDT = 09:00 UTC
}

/** Hours Pacific time is behind UTC at `ms` (7 in daylight time, else 8). */
function pacificOffsetHours(ms: number): number {
  const year = new Date(ms).getUTCFullYear()
  return ms >= secondSundayOfMarchUtc(year) && ms < firstSundayOfNovemberUtc(year) ? 7 : 8
}

/** The YouTube quota day (Pacific calendar date, YYYY-MM-DD) containing `now`. */
export function youtubeQuotaDay(now: Date): string {
  const ms = now.getTime()
  return new Date(ms - pacificOffsetHours(ms) * 3_600_000).toISOString().slice(0, 10)
}

/** The instant Google next resets the YouTube quota (the next Pacific midnight). */
export function nextYoutubeQuotaReset(now: Date): Date {
  const ms = now.getTime()
  const local = new Date(ms - pacificOffsetHours(ms) * 3_600_000)
  const nextLocalMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1)
  // Midnight sits before the 02:00 switch, so it carries the previous day's
  // offset: probe one hour before midnight-as-PDT (07:00 UTC).
  const offset = pacificOffsetHours(nextLocalMidnight + 7 * 3_600_000 - 1)
  return new Date(nextLocalMidnight + offset * 3_600_000)
}

/** One ledger row (the YouTube `discovery` or `watch` sync_state row). */
export interface YoutubeLedgerRow {
  units_consumed_today?: number | null
  units_window_date?: string | null
  last_synced_at?: string | null
  metadata?: unknown
}

/** The fields this module keeps under `metadata.youtube_quota`. */
export interface YoutubeQuotaMetadata {
  /** Google answered quotaExceeded / dailyLimitExceeded: nothing is spent
   *  until this instant (the next Pacific midnight). */
  exhausted_until?: string | null
  /** Watch polls deferred on the poller's latest tick (watch row only). */
  deferred?: number
  /** Why the latest discovery run was skipped, if it was (discovery row only). */
  discovery_skipped?: "quota_exhausted" | "budget" | null
}

export function metadataObject(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {}
}

export function youtubeQuotaMetadata(row: YoutubeLedgerRow | undefined): YoutubeQuotaMetadata {
  const q = metadataObject(row?.metadata)[YT_QUOTA_METADATA_KEY]
  return q && typeof q === "object" ? (q as YoutubeQuotaMetadata) : {}
}

/** Units a ledger row spent in the quota day containing `now` (0 on rollover). */
export function unitsSpentToday(row: YoutubeLedgerRow | undefined, now: Date): number {
  return row && row.units_window_date === youtubeQuotaDay(now) ? (row.units_consumed_today ?? 0) : 0
}

/**
 * The stable read shape of the YouTube quota (what a Settings quota box shows).
 * Built from the two ledger rows; pure, so a `quota_status` tool can call it on
 * the rows it reads.
 */
export interface YoutubeQuotaStatus {
  /** Quota day (Pacific calendar date, YYYY-MM-DD). */
  day: string
  /** ISO instant of the next reset (Pacific midnight). */
  resetsAt: string
  /** Google's project limit (default 10,000 units/day). */
  googleDailyLimit: number
  /** Our cap under that limit (default 9,000). */
  cap: number
  /** Units spent today, discovery + watch polls. */
  consumed: number
  /** cap - consumed, never below 0 (0 while exhausted). */
  remaining: number
  discovery: { consumed: number; share: number; skipped: "quota_exhausted" | "budget" | null }
  watch: { consumed: number; deferred: number }
  /** Set while Google reports the quota as exhausted; ISO instant, else null. */
  exhaustedUntil: string | null
}

export function youtubeQuotaStatus(input: {
  discovery: YoutubeLedgerRow | undefined
  watch: YoutubeLedgerRow | undefined
  now: Date
  cap?: number
}): YoutubeQuotaStatus {
  const { discovery, watch, now } = input
  const cap = input.cap ?? DEFAULT_YT_DAILY_BUDGET
  const discoveryUsed = unitsSpentToday(discovery, now)
  const watchUsed = unitsSpentToday(watch, now)
  const consumed = discoveryUsed + watchUsed
  const dq = youtubeQuotaMetadata(discovery)
  const wq = youtubeQuotaMetadata(watch)
  const exhaustedUntil = [dq.exhausted_until, wq.exhausted_until]
    .filter((v): v is string => typeof v === "string" && Date.parse(v) > now.getTime())
    .sort()
    .pop() ?? null
  return {
    day: youtubeQuotaDay(now),
    resetsAt: nextYoutubeQuotaReset(now).toISOString(),
    googleDailyLimit: YT_GOOGLE_DAILY_LIMIT,
    cap,
    consumed,
    remaining: exhaustedUntil ? 0 : Math.max(0, cap - consumed),
    discovery: { consumed: discoveryUsed, share: YT_DISCOVERY_DAILY_SHARE, skipped: dq.discovery_skipped ?? null },
    watch: { consumed: watchUsed, deferred: wq.deferred ?? 0 },
    exhaustedUntil,
  }
}

/** Decide whether a YouTube discovery run may spend `estimatedUnits` now. */
export function youtubeDiscoveryGate(input: {
  status: YoutubeQuotaStatus
  estimatedUnits: number
  lastRunAt: string | null | undefined
  now: Date
}): "run" | "quota_exhausted" | "budget" | "cadence" {
  const { status, estimatedUnits, lastRunAt, now } = input
  if (status.exhaustedUntil) return "quota_exhausted"
  if (lastRunAt && now.getTime() - Date.parse(lastRunAt) < YT_DISCOVERY_MIN_INTERVAL_MS) return "cadence"
  if (status.discovery.consumed + estimatedUnits > status.discovery.share) return "budget"
  if (status.consumed + estimatedUnits > status.cap) return "budget"
  return "run"
}
