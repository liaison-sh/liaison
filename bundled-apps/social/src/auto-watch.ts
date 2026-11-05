// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Auto-watch promotion rule + adaptive polling cadence (§4.7). When a discovery
// finding shows signs of an active conversation worth following, we promote its
// parent object to a watched_object and poll it on a hot/warm/cool cadence that
// decays after a week of silence and resurrects on fresh activity.

import type { FindingRelation } from "./adapters/types"

/** Thresholds — exported so a Settings surface can override them later. */
export const AUTO_WATCH_COMMENT_THRESHOLD = 20
export const CADENCE_HOT_SECONDS = 300 // 5m — active conversation
export const CADENCE_WARM_SECONDS = 3600 // 1h — recently active / resurrected
export const CADENCE_COOL_SECONDS = 86_400 // 24h — quiet
export const DECAY_IDLE_DAYS = 7

export interface AutoWatchInput {
  relation: FindingRelation
  commentCount?: number
  brandRelevant?: boolean
}

/**
 * Promote to a watch when a keyword-match post has ≥ threshold comments (a live
 * thread) OR when there is ≥ 1 brand-relevant comment on it. A bare praise
 * mention with no engagement is not auto-watched.
 */
export function shouldAutoWatch(f: AutoWatchInput): boolean {
  const comments = f.commentCount ?? 0
  if (f.relation === "keyword_match" && comments >= AUTO_WATCH_COMMENT_THRESHOLD) return true
  if (f.brandRelevant === true && f.relation === "comment_on_our_content") return true
  if (f.brandRelevant === true && comments >= 1) return true
  return false
}

export type WatchStatus = "active" | "decayed" | "stopped"

export interface CadenceDecision {
  status: WatchStatus
  cadenceSeconds: number
}

/**
 * Decide a watch's next status + cadence from whether activity was just seen and
 * how long since the last activity:
 *  - activity seen → active + hot (5m)        (or resurrect a decayed watch to warm)
 *  - no activity, idle ≥ 7d → decayed         (poller skips decayed unless resumed)
 *  - no activity, idle < 7d → active + warm/cool by recency
 */
export function adaptCadence(
  currentStatus: WatchStatus,
  activitySeen: boolean,
  lastActivityAt: string | null,
  now: Date = new Date(),
): CadenceDecision {
  if (activitySeen) {
    // A decayed watch that sees fresh activity resurrects to WARM (not straight
    // to hot) so a single late comment doesn't over-poll a long-dead thread.
    if (currentStatus === "decayed") return { status: "active", cadenceSeconds: CADENCE_WARM_SECONDS }
    return { status: "active", cadenceSeconds: CADENCE_HOT_SECONDS }
  }
  const last = lastActivityAt ? Date.parse(lastActivityAt) : Number.NaN
  const idleMs = Number.isNaN(last) ? Number.POSITIVE_INFINITY : now.getTime() - last
  const idleDays = idleMs / (24 * 3600_000)
  if (idleDays >= DECAY_IDLE_DAYS) return { status: "decayed", cadenceSeconds: CADENCE_COOL_SECONDS }
  if (idleDays >= 1) return { status: "active", cadenceSeconds: CADENCE_COOL_SECONDS }
  return { status: "active", cadenceSeconds: CADENCE_WARM_SECONDS }
}

// ── Own-content auto-watch (Facebook Page posts, Instagram media) ────────────
// Our own new posts are enrolled as `auto_own` watches by the watch poller, so
// their comments are caught within minutes instead of waiting for the feed
// sync to reach them. The poll cadence follows the POST'S AGE (comment traffic
// on a post is front-loaded), and a watch is retired once the post is older
// than OWN_POST_MAX_AGE_DAYS: the feed sync still covers late comments.

/** Posts older than this are never enrolled and their watches are retired. */
export const OWN_POST_MAX_AGE_DAYS = 14
/** Most `auto_own` watches kept active per platform (newest posts win). */
export const OWN_WATCH_CAP_PER_PLATFORM = 20
/** Most Facebook or Instagram comment polls per poller tick, per platform.
 *  The poller ticks every 5 minutes, so this bounds the comment reads at
 *  120 per hour per platform, well inside Graph's per-Page / per-account
 *  business-use-case limits; the overflow stays due and goes first next tick. */
export const META_POLLS_PER_TICK = 10

/** Age bands (upper bound in hours, cadence in seconds), youngest first. */
export const OWN_POST_CADENCE_BANDS: ReadonlyArray<{ maxAgeHours: number; cadenceSeconds: number }> = [
  { maxAgeHours: 6, cadenceSeconds: 300 }, // 5 min while the post is fresh
  { maxAgeHours: 24, cadenceSeconds: 900 }, // 15 min on day one
  { maxAgeHours: 72, cadenceSeconds: 3600 }, // hourly to day three
  { maxAgeHours: 7 * 24, cadenceSeconds: 6 * 3600 }, // every 6 h to day seven
  { maxAgeHours: OWN_POST_MAX_AGE_DAYS * 24, cadenceSeconds: 86_400 }, // daily to the cutoff
]

/**
 * Poll cadence for an own post of the given creation time, or `null` when the
 * post is past the cutoff (retire the watch). Fresh activity on an older post
 * tightens the cadence to at most hourly, never looser than the age band. An
 * unknown creation time is treated as past the cutoff: without it the watch
 * could never age out.
 */
export function ownPostCadence(postedAt: string | null | undefined, activitySeen: boolean, now: Date): number | null {
  const posted = postedAt ? Date.parse(postedAt) : Number.NaN
  if (Number.isNaN(posted)) return null
  const ageHours = Math.max(0, now.getTime() - posted) / 3600_000
  const band = OWN_POST_CADENCE_BANDS.find((b) => ageHours < b.maxAgeHours)
  if (!band) return null
  return activitySeen ? Math.min(band.cadenceSeconds, CADENCE_WARM_SECONDS) : band.cadenceSeconds
}
