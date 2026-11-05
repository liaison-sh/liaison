// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Discovery + watch sync engine (§4.2 / §4.7). `runDiscoverySync` advances the
// per-account watermark in `sync_state.cursor` ONLY after every finding in the
// batch upserts — a crash mid-batch leaves the cursor untouched so the next run
// re-fetches from the same point (crash-safe, §9 #5). `runWatchPoller` polls due
// `watched_object`s, ingests their child activity, and adapts each watch's
// cadence (hot/warm/cool/decayed) via `adaptCadence`.

import {
  adaptCadence,
  META_POLLS_PER_TICK,
  OWN_POST_MAX_AGE_DAYS,
  OWN_WATCH_CAP_PER_PLATFORM,
  ownPostCadence,
  shouldAutoWatch,
  type WatchStatus,
} from "./auto-watch"
import { estimateYoutubeDiscoveryUnits, termAppearsIn, YT_COMMENT_THREADS_UNITS } from "./adapters/youtube"
import type { DiscoveryTerm, NormalizedFinding, PlatformAdapter, Platform } from "./adapters/types"
import { resolveAccessToken } from "./connection"
import type { SocialToolCtx } from "./ctx"
import { emitFindingCreated, upsertFinding } from "./ingest"
import { clearMissingToken, noteMissingToken } from "./missing-token"
import { watchObject } from "./internal"
import {
  DEFAULT_YT_DAILY_BUDGET,
  metadataObject,
  nextYoutubeQuotaReset,
  planWatchBudget,
  QuotaBudget,
  YT_QUOTA_METADATA_KEY,
  youtubeDiscoveryGate,
  youtubeQuotaDay,
  youtubeQuotaMetadata,
  youtubeQuotaStatus,
  type YoutubeQuotaMetadata,
  type YoutubeQuotaStatus,
} from "./quota"

export { DEFAULT_YT_DAILY_BUDGET }

interface MonitorTermRow {
  id: string
  kind: "keyword" | "handle" | "hashtag"
  value: string
  platform: Platform | null
  enabled: boolean
}

/**
 * Load the enabled monitor terms usable for a platform's keyword-search
 * discovery: rows scoped to this platform explicitly, plus the
 * `platform: null` ("all platforms") rows. Only `keyword`/`handle` kinds are
 * search text (`hashtag` terms are for a future hashtag-search surface, not
 * YouTube's free-text `q`).
 */
async function loadDiscoveryTerms(ctx: SocialToolCtx, platform: Platform): Promise<DiscoveryTerm[]> {
  const rows = (await ctx.db.findMany("monitor_term", {
    where: { enabled: true },
  })) as MonitorTermRow[]
  return rows
    .filter((r) => (r.platform === null || r.platform === undefined || r.platform === platform))
    .filter((r) => r.kind === "keyword" || r.kind === "handle")
    .map((r) => ({ id: r.id, kind: r.kind, value: r.value }))
}

/**
 * RELATION HONESTY for watched-video comments (incident fix, §ledger): the org
 * does NOT own an `auto_hot` (keyword-promoted) video, so its comments are not
 * "comments on our content." Comments pulled from an `auto_hot` watch are kept
 * ONLY when the comment text itself contains an enabled monitor term as a
 * verbatim phrase — reclassified to `mention_in_comment` — every other comment
 * on that video is dropped (it is just ambient chatter on a video that happens
 * to have matched a fuzzy keyword search once). A `manual` watch keeps today's
 * behavior unchanged: the operator explicitly asked to watch that video, so
 * every comment is kept as `comment_on_our_content`.
 */
function classifyWatchedComments(
  findings: NormalizedFinding[],
  reason: WatchedRow["reason"],
  terms: DiscoveryTerm[],
): NormalizedFinding[] {
  if (reason !== "auto_hot") return findings
  const out: NormalizedFinding[] = []
  for (const f of findings) {
    if (f.relation !== "comment_on_our_content") {
      out.push(f)
      continue
    }
    const matchedTerm = terms.find((t) => termAppearsIn(t, f.contentText))
    if (!matchedTerm) continue // ambient chatter on a keyword-promoted video — drop
    out.push({
      ...f,
      relation: "mention_in_comment",
      metadata: { ...f.metadata, matchedTerms: [matchedTerm.id] },
    })
  }
  return out
}

interface SyncStateRow {
  id: string
  platform: string
  account_external_id: string
  source_type: string
  cursor: string | null
  active?: boolean
  units_consumed_today?: number | null
  units_window_date?: string | null
  last_synced_at?: string | null
  metadata?: unknown
}

/** A sync_state metadata patch that merges `patch` into the row's
 *  `youtube_quota` object, keeping every other metadata key. */
function quotaMetadataPatch(row: SyncStateRow, patch: YoutubeQuotaMetadata): Record<string, unknown> {
  const meta = metadataObject(row.metadata)
  return { ...meta, [YT_QUOTA_METADATA_KEY]: { ...youtubeQuotaMetadata(row), ...patch } }
}

async function youtubeLedgerRows(
  ctx: SocialToolCtx,
): Promise<{ discovery: SyncStateRow | undefined; watch: SyncStateRow | undefined }> {
  const [discovery] = (await ctx.db.findMany("sync_state", {
    where: { platform: "youtube", source_type: "discovery" },
    limit: 1,
  })) as SyncStateRow[]
  if (!discovery) return { discovery: undefined, watch: undefined }
  const [watch] = (await ctx.db.findMany("sync_state", {
    where: { platform: "youtube", source_type: "watch", account_external_id: discovery.account_external_id },
    limit: 1,
  })) as SyncStateRow[]
  return { discovery, watch }
}

/**
 * The YouTube quota as a quota view reads it: units spent today (Pacific quota
 * day) split discovery / watch polls, remaining under the cap, the deferred
 * watch count and, when Google refused for quota, the reset instant. `null`
 * when YouTube is not connected. See `YoutubeQuotaStatus` for the shape.
 */
export async function readYoutubeQuotaStatus(
  ctx: SocialToolCtx,
  now: Date = new Date(),
): Promise<YoutubeQuotaStatus | null> {
  const { discovery, watch } = await youtubeLedgerRows(ctx)
  if (!discovery) return null
  return youtubeQuotaStatus({ discovery, watch, now })
}

interface WatchedRow {
  id: string
  platform: Platform
  external_id: string
  status: WatchStatus
  cadence_seconds: number
  priority: number
  next_poll_at: string | null
  last_activity_at: string | null
  reason?: "auto_hot" | "auto_own" | "manual" | null
  metadata?: { postedAt?: string | null; retiredReason?: string } | null
}

/** Own-content platforms: our Facebook Page posts and Instagram media. */
const OWN_CONTENT_PLATFORMS: ReadonlyArray<Platform> = ["facebook", "instagram"]

/**
 * Own-content auto-watch enrollment: list each own-content platform's newest
 * posts/media and enroll the ones younger than OWN_POST_MAX_AGE_DAYS as
 * `auto_own` watches (due immediately, cadence from the post's age). An
 * existing row of any status is left alone, so an operator's unwatch or a
 * retirement is never undone. Then enforce OWN_WATCH_CAP_PER_PLATFORM: the
 * oldest active `auto_own` watches beyond the cap are retired.
 */
async function enrollOwnPosts(
  ctx: SocialToolCtx,
  adapters: Partial<Record<Platform, PlatformAdapter>>,
  now: Date,
  accountFor: (platform: Platform) => Promise<{ accountExternalId: string; accessToken: string } | null>,
): Promise<{ enrolled: number; retired: number }> {
  let enrolled = 0
  let retired = 0
  const cutoffMs = now.getTime() - OWN_POST_MAX_AGE_DAYS * 86_400_000
  for (const platform of OWN_CONTENT_PLATFORMS) {
    const adapter = adapters[platform]
    if (!adapter?.listOwnRecentObjects) continue
    const account = await accountFor(platform)
    if (!account) continue
    const listed = await adapter.listOwnRecentObjects(
      { accountExternalId: account.accountExternalId, fetch: ctx.fetch, accessToken: account.accessToken, logger: ctx.logger },
      OWN_WATCH_CAP_PER_PLATFORM,
    )
    if (listed.error) {
      ctx.logger?.warn?.("social: own posts listing failed, no auto-watch enrollment this tick", {
        platform,
        error: listed.error,
      })
    }
    const fresh = listed.objects
      .filter((o) => o.createdAt && Date.parse(o.createdAt) > cutoffMs)
      .sort((a, b) => Date.parse(b.createdAt as string) - Date.parse(a.createdAt as string))
      .slice(0, OWN_WATCH_CAP_PER_PLATFORM)
    for (const o of fresh) {
      const [existing] = await ctx.db.findMany("watched_object", {
        where: { platform, external_id: o.externalId },
        limit: 1,
      })
      if (existing) continue
      await watchObject(ctx, {
        platform,
        external_id: o.externalId,
        object_type: o.objectType,
        reason: "auto_own",
        title: o.title ?? null,
        permalink: o.permalink ?? null,
        metadata: { postedAt: o.createdAt },
        cadence_seconds: ownPostCadence(o.createdAt, false, now) ?? undefined,
      })
      enrolled += 1
    }

    const own = ((await ctx.db.findMany("watched_object", {
      where: { platform, reason: "auto_own", status: "active" },
    })) as WatchedRow[]).sort(
      (a, b) => postedAtMs(b) - postedAtMs(a),
    )
    for (const w of own.slice(OWN_WATCH_CAP_PER_PLATFORM)) {
      await retireOwnWatch(ctx, w, "cap")
      retired += 1
    }
  }
  return { enrolled, retired }
}

function postedAtMs(w: WatchedRow): number {
  const t = w.metadata?.postedAt ? Date.parse(w.metadata.postedAt) : Number.NaN
  return Number.isNaN(t) ? 0 : t
}

async function retireOwnWatch(ctx: SocialToolCtx, w: WatchedRow, why: "age" | "cap"): Promise<void> {
  await ctx.db.update("watched_object", w.id, {
    status: "stopped",
    metadata: { ...(w.metadata ?? {}), retiredReason: why },
  })
}

/**
 * Run one discovery cycle for a connected account: load the watermark, discover
 * since it, upsert every finding, emit `finding:created` per new row, then
 * advance the cursor. The cursor advance is the LAST write — if any upsert
 * throws, the function rejects with the cursor untouched. A typed CONNECTION_LOST
 * / RATE_LIMITED result also leaves the cursor alone (no advance past a failed
 * page).
 */
export async function runDiscoverySync(
  ctx: SocialToolCtx,
  opts: { adapter: PlatformAdapter; accountExternalId: string; now?: Date },
): Promise<{ ingested: number; unitsConsumed: number }> {
  const { adapter, accountExternalId } = opts
  const now = opts.now ?? new Date()
  const [state] = (await ctx.db.findMany("sync_state", {
    where: {
      platform: adapter.platform,
      account_external_id: accountExternalId,
      source_type: "discovery",
    },
    limit: 1,
  })) as SyncStateRow[]
  if (state && state.active === false) return { ingested: 0, unitsConsumed: 0 }

  const cursor = state?.cursor ?? null
  // Resolve the per-account OAuth token BEFORE the call: an unauthenticated
  // discover would 401 and never advance the watermark. No token is an expected
  // state (not connected), said once at info and skipped (missing-token.ts).
  const accessToken = await resolveAccessToken(ctx, adapter.platform, accountExternalId)
  if (!accessToken) {
    await noteMissingToken(ctx, state, "social: discovery skipped, no OAuth access token for account", {
      platform: adapter.platform,
      accountExternalId,
    })
    return { ingested: 0, unitsConsumed: 0 }
  }
  await clearMissingToken(ctx, state)
  // Monitor terms scope keyword-search discovery (currently only consulted by
  // the YouTube adapter); loading is cheap so it happens unconditionally
  // rather than gating on adapter.platform === "youtube" here (keeps the
  // adapter, not the sync engine, the source of truth for which platforms
  // use search text).
  const terms = await loadDiscoveryTerms(ctx, adapter.platform)

  // YouTube budget gate: discovery spends only from its daily share, never
  // past the cap, at most once per YT_DISCOVERY_MIN_INTERVAL_MS, and nothing
  // at all while Google reports the quota as spent. Watch polls get the rest.
  if (adapter.platform === "youtube" && state) {
    const { watch } = await youtubeLedgerRows(ctx)
    const status = youtubeQuotaStatus({ discovery: state, watch, now })
    const gate = youtubeDiscoveryGate({
      status,
      estimatedUnits: estimateYoutubeDiscoveryUnits(terms.length),
      lastRunAt: state.last_synced_at,
      now,
    })
    if (gate !== "run") {
      if (gate !== "cadence") {
        ctx.logger?.warn?.("social: youtube discovery skipped, daily quota budget", {
          reason: gate,
          consumed: status.consumed,
          discoveryConsumed: status.discovery.consumed,
          exhaustedUntil: status.exhaustedUntil,
        })
        if (youtubeQuotaMetadata(state).discovery_skipped !== gate) {
          await ctx.db.update("sync_state", state.id, {
            metadata: quotaMetadataPatch(state, { discovery_skipped: gate }),
          })
        }
      }
      return { ingested: 0, unitsConsumed: 0 }
    }
  }

  const result = await adapter.discover(
    { accountExternalId, fetch: ctx.fetch, accessToken, terms, logger: ctx.logger, now },
    cursor,
  )
  if (result.error) {
    // Do NOT advance the watermark on a failed page — but NEVER silently: an
    // unlogged CONNECTION_LOST leaves sync_state.last_synced_at NULL forever
    // with zero operator trace (the "social is inoperant" failure shape).
    // RATE_LIMITED is an expected, self-resolving upstream condition (the next
    // sync tick retries after the window) — warn keeps the operator trace
    // without paging as a critical. Everything else stays error.
    const logFn =
      result.error === "RATE_LIMITED" ? ctx.logger?.warn?.bind(ctx.logger) : ctx.logger?.error?.bind(ctx.logger)
    logFn?.("social: discovery page failed, watermark not advanced", {
      platform: adapter.platform,
      accountExternalId,
      error: result.error,
      ...(result.retryAfter !== undefined ? { retryAfter: result.retryAfter } : {}),
    })
    return { ingested: 0, unitsConsumed: result.unitsConsumed }
  }

  let ingested = 0
  for (const f of result.findings) {
    const res = await upsertFinding(ctx, {
      platform: f.platform,
      externalId: f.externalId,
      relation: f.relation,
      parentExternalId: f.parentExternalId,
      authorHandle: f.authorHandle,
      authorExternalId: f.authorExternalId,
      contentText: f.contentText,
      permalink: f.permalink,
      occurredAt: f.occurredAt,
      commentCount: f.commentCount,
      metadata: f.metadata,
    })
    if (res.created) {
      ingested += 1
      await emitFindingCreated(ctx, res.id)
      // Auto-watch (§4.7 / §9 #6): a YouTube keyword-match video with a
      // qualifying signal (≥20 comments, or ≥1 brand-relevant comment finding)
      // is promoted to a watched_object WITHIN this discovery cycle — and its
      // already-ingested sibling findings are backfill-linked (§8). The poller
      // then polls the new watch on the hot cadence next tick.
      if (
        f.platform === "youtube" &&
        f.relation === "keyword_match" &&
        shouldAutoWatch({
          relation: f.relation,
          commentCount: f.commentCount,
        })
      ) {
        await watchObject(ctx, {
          platform: "youtube",
          external_id: f.externalId,
          object_type: "youtube_video",
          reason: "auto_hot",
          // A keyword_match finding's contentText IS the video title
          // (discoverKeywordMatches sets it from search.list's snippet.title)
          // — carry it onto the watch so operators can tell what's being
          // watched (titles were previously always blank).
          title: f.contentText,
        })
      }
    }
  }

  // Watermark advance is the LAST write — crash-safe. For YouTube, also fold the
  // discovery search.list cost into the same per-day unit counter the watch
  // poller budgets against (§4.2 "reserves a slice for discovery") so the daily
  // total spans discovery + watch polls and never overruns B.
  if (state) {
    const patch: Record<string, unknown> = {
      cursor: result.nextCursor,
      last_synced_at: now.toISOString(),
    }
    if (adapter.platform === "youtube") {
      const today = youtubeQuotaDay(now)
      const sameDay = state.units_window_date === today
      const prior = sameDay ? (state.units_consumed_today ?? 0) : 0
      patch.units_consumed_today = prior + result.unitsConsumed
      patch.units_window_date = today
      const exhaustedUntil = result.quotaExhausted ? nextYoutubeQuotaReset(now).toISOString() : null
      if (exhaustedUntil) {
        ctx.logger?.warn?.("social: youtube daily quota exhausted, discovery and polls stop until reset", {
          exhaustedUntil,
        })
      }
      patch.metadata = quotaMetadataPatch(state, { exhausted_until: exhaustedUntil, discovery_skipped: null })
    }
    await ctx.db.update("sync_state", state.id, patch)
  }
  return { ingested, unitsConsumed: result.unitsConsumed }
}

function isDue(row: WatchedRow, now: Date): boolean {
  if (!row.next_poll_at) return true
  return Date.parse(row.next_poll_at) <= now.getTime()
}

/**
 * The connected-account external id for a platform — the OAuth-token identifier
 * the watch poller resolves a token against (watch rows don't carry it). Read
 * from any active sync_state row for the platform; `null` when none is connected.
 */
async function accountIdForPlatform(ctx: SocialToolCtx, platform: Platform): Promise<string | null> {
  const [state] = (await ctx.db.findMany("sync_state", {
    where: { platform, active: true },
    limit: 1,
  })) as SyncStateRow[]
  return state?.account_external_id ?? null
}

/**
 * Load (or lazily construct) the per-org YouTube unit budget for `now`'s quota
 * day (Pacific, Google's reset clock).
 *
 * The day's spend is split across TWO ledgers, one per writer, so the two
 * scheduled jobs never contend for the same row:
 *   * the YouTube `discovery` sync_state row carries discovery's own
 *     search.list cost (written by `syncSource`, i.e. the discovery-sync job);
 *   * the YouTube `watch` sync_state row (same account) carries the watch
 *     poller's comment-poll cost (written ONLY here, by the watch-poller job).
 * Both jobs fire on the same cron second every quarter hour, and a job runs
 * inside one ambient transaction, so a shared counter row meant the poller's
 * UPDATE waited on discovery's row lock for the rest of discovery's run and
 * was killed by statement_timeout (prod: one failed poller tick per quarter
 * hour, each a critical alert). Separate rows: reads never block, and each
 * writer only ever locks its own row.
 *
 * On a day rollover (or first use) each counter reads as 0. Returns the
 * budget (seeded with discovery + poller spend), the poller ledger row to
 * persist the poller's running total onto, that total's prior value, and the
 * quota status (exhaustion included). `null` when YouTube isn't connected.
 */
async function loadYoutubeBudget(
  ctx: SocialToolCtx,
  cap: number,
  now: Date,
): Promise<{ budget: QuotaBudget; ledger: SyncStateRow; pollerPrior: number; status: YoutubeQuotaStatus } | null> {
  const rows = await youtubeLedgerRows(ctx)
  const discovery = rows.discovery
  if (!discovery) return null
  const today = youtubeQuotaDay(now)
  let ledger = rows.watch
  if (!ledger) {
    // Connections made before the `watch` row joined CONNECTION_SYNC_PLAN have
    // no ledger row yet; create it once (the unique constraint keeps it single).
    const inserted = (await ctx.db.insert("sync_state", {
      platform: "youtube",
      account_external_id: discovery.account_external_id,
      source_type: "watch",
      cursor: null,
      active: true,
      units_consumed_today: 0,
      units_window_date: today,
    })) as { id: string }
    ledger = { id: inserted.id, units_consumed_today: 0, units_window_date: today } as SyncStateRow
  }

  const status = youtubeQuotaStatus({ discovery, watch: ledger, now, cap })
  const pollerPrior = status.watch.consumed
  const budget = new QuotaBudget(cap)
  budget.consume(status.consumed)
  return { budget, ledger, pollerPrior, status }
}

/**
 * Poll every due, active watched object: pull child activity, ingest it, and
 * adapt the watch's cadence. Decayed watches are skipped (only a manual Resume
 * or fresh discovery resurrects them).
 *
 * YouTube quota (§4.2 / §9 #3 — no silent caps): YouTube watch polls meter 1
 * unit each against the per-org daily budget `B`. Before polling, the due
 * YouTube watches are run through `planWatchBudget` against the remaining
 * budget; the lowest-priority watches that wouldn't fit are deferred (NOT
 * polled, cadence untouched), the deferred count is logged, and the running
 * `units_consumed_today` total is persisted so the next tick continues from it.
 * Total YouTube units consumed in a day therefore never exceeds `B`. FB/IG
 * watches have no unit budget but are capped at META_POLLS_PER_TICK polls per
 * platform per tick (Graph rate limits); own new posts are enrolled first (see
 * `enrollOwnPosts`) and own-post watches past the age cutoff are retired.
 */
export async function runWatchPoller(
  ctx: SocialToolCtx,
  opts: {
    adapters: Partial<Record<Platform, PlatformAdapter>>
    now?: Date
    dailyBudget?: number
  },
): Promise<{ polled: number; ingested: number; deferred: number }> {
  const now = opts.now ?? new Date()
  const cap = opts.dailyBudget ?? DEFAULT_YT_DAILY_BUDGET

  // Resolve the per-platform OAuth token once per tick (cache by platform). The
  // token identifier is the platform's connected account (from its sync_state),
  // NOT the watched object's external id. `null` = resolved-and-absent (skip
  // that platform's watches with an explicit auth error).
  const accountByPlatform = new Map<Platform, { accountExternalId: string; accessToken: string } | null>()
  async function accountFor(platform: Platform): Promise<{ accountExternalId: string; accessToken: string } | null> {
    if (accountByPlatform.has(platform)) return accountByPlatform.get(platform) ?? null
    const accountExternalId = await accountIdForPlatform(ctx, platform)
    const token = accountExternalId ? await resolveAccessToken(ctx, platform, accountExternalId) : null
    const account = accountExternalId && token ? { accountExternalId, accessToken: token } : null
    accountByPlatform.set(platform, account)
    return account
  }
  async function tokenFor(platform: Platform): Promise<string | null> {
    return (await accountFor(platform))?.accessToken ?? null
  }

  await enrollOwnPosts(ctx, opts.adapters, now, accountFor)

  const rows = (await ctx.db.findMany("watched_object", {
    where: { status: "active" },
  })) as WatchedRow[]

  const due = rows.filter((w) => w.status === "active" && isDue(w, now))
  const ytDue = due.filter((w) => w.platform === "youtube")

  // Own-post watches past the age cutoff are retired before polling (the feed
  // sync still covers their late comments), so they cost no Graph call.
  const metaCandidates: WatchedRow[] = []
  for (const w of due) {
    if (w.platform === "youtube") continue
    if (w.reason === "auto_own" && ownPostCadence(w.metadata?.postedAt, false, now) === null) {
      await retireOwnWatch(ctx, w, "age")
      continue
    }
    metaCandidates.push(w)
  }
  // Graph rate limits: at most META_POLLS_PER_TICK comment polls per platform
  // per tick, highest priority then most overdue first. The rest stay due
  // (cadence untouched) and lead the next tick.
  const otherDue: WatchedRow[] = []
  let metaDeferred = 0
  for (const platform of OWN_CONTENT_PLATFORMS) {
    const queue = metaCandidates
      .filter((w) => w.platform === platform)
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          (a.next_poll_at ? Date.parse(a.next_poll_at) : 0) - (b.next_poll_at ? Date.parse(b.next_poll_at) : 0),
      )
    otherDue.push(...queue.slice(0, META_POLLS_PER_TICK))
    metaDeferred += Math.max(0, queue.length - META_POLLS_PER_TICK)
  }
  if (metaDeferred > 0) {
    ctx.logger?.warn?.("social: facebook/instagram watch polls deferred, per-tick Graph cap reached", {
      deferred: metaDeferred,
      capPerPlatform: META_POLLS_PER_TICK,
    })
  }

  // Quota-plan the YouTube watches: highest-priority-first, deferring the tail
  // that wouldn't fit in the remaining daily budget.
  const yt = await loadYoutubeBudget(ctx, cap, now)
  let ytToPoll = ytDue
  let deferred = 0
  if (yt?.status.exhaustedUntil && ytDue.length > 0) {
    // Google already refused for quota today: every call would fail until the
    // reset, so poll nothing and leave each watch's cadence untouched.
    ytToPoll = []
    deferred = ytDue.length
    ctx.logger?.warn?.("youtube watch polls deferred — Google daily quota exhausted", {
      deferred,
      exhaustedUntil: yt.status.exhaustedUntil,
    })
  } else if (yt && ytDue.length > 0) {
    const plan = planWatchBudget({
      remaining: yt.budget.remaining(),
      perWatchUnits: YT_COMMENT_THREADS_UNITS,
      watches: ytDue.map((w) => ({ id: w.id, priority: w.priority, row: w })),
    })
    ytToPoll = plan.toPoll.map((c) => c.row)
    deferred = plan.deferredCount
    if (deferred > 0) {
      ctx.logger?.warn?.("youtube watch polls deferred — daily quota budget reached", {
        deferred,
        remaining: yt.budget.remaining(),
        cap,
      })
    }
  }

  let polled = 0
  let ingested = 0
  // Units this tick spent on YouTube polls (the poller's own share of the day).
  let pollerSpent = 0
  // YouTube monitor terms, loaded once, for classifying auto_hot watched-video
  // comments (see `classifyWatchedComments`) — cheap and only actually
  // consulted when a due YouTube watch is polled.
  const ytTerms = ytDue.length > 0 ? await loadDiscoveryTerms(ctx, "youtube") : []
  let ytExhaustedUntil: string | null = null
  // Platforms whose watches were skipped for want of a token this tick, and how
  // many: one debug line per platform after the loop, never a line per watch.
  const skippedNoToken = new Map<Platform, number>()
  for (const w of [...ytToPoll, ...otherDue]) {
    if (w.platform === "youtube" && ytExhaustedUntil) {
      // Quota refused mid-tick: the remaining YouTube watches wait for the reset.
      deferred += 1
      continue
    }
    const adapter = opts.adapters[w.platform]
    if (!adapter) continue
    const accessToken = await tokenFor(w.platform)
    if (!accessToken) {
      // No live token: do NOT poll unauthenticated (that would 401 and churn the
      // cadence on a CONNECTION_LOST); leave the watch untouched. Not connected
      // is an expected state, and the account's discovery sync is what says so
      // (once, at info); here it is counted for one debug line per platform.
      skippedNoToken.set(w.platform, (skippedNoToken.get(w.platform) ?? 0) + 1)
      continue
    }
    const result = await adapter.pollObject(
      { accountExternalId: w.external_id, fetch: ctx.fetch, accessToken, logger: ctx.logger },
      w.external_id,
      null,
    )
    if (w.platform === "youtube" && result.quotaExhausted) {
      // Not a poll: nothing was read, so the watch keeps its cadence (a
      // refused poll must not read as "no activity" and cool the watch).
      ytExhaustedUntil = nextYoutubeQuotaReset(now).toISOString()
      deferred += 1
      ctx.logger?.warn?.("youtube daily quota exhausted, watch polls stop until reset", {
        exhaustedUntil: ytExhaustedUntil,
      })
      continue
    }
    polled += 1
    if (result.error) {
      // Surface the typed failure (401 CONNECTION_LOST / 429 RATE_LIMITED) —
      // silently skipping leaves the watch stuck with no operator trace.
      ctx.logger?.error?.("social: watch poll failed for object", {
        platform: w.platform,
        externalId: w.external_id,
        error: result.error,
      })
    }
    if (w.platform === "youtube" && yt) {
      yt.budget.consume(result.unitsConsumed)
      pollerSpent += result.unitsConsumed
    }
    // Relation-honesty reclassification (incident fix): the org does not own
    // an auto_hot keyword-promoted video, so its comments only count as
    // brand-relevant findings when the comment text itself mentions a
    // monitor term — everything else is dropped rather than mislabeled
    // `comment_on_our_content`. Manual watches are untouched (own-content
    // discovery does not go through this path at all — see youtube.ts).
    const classified =
      w.platform === "youtube" ? classifyWatchedComments(result.findings, w.reason, ytTerms) : result.findings
    // Activity = NEW findings. A poll returns the latest comments every time,
    // so "any comments returned" kept every watch on the 5-minute hot cadence
    // forever (90 watches x 288 polls a day, far past the YouTube quota).
    let created = 0
    for (const f of classified) {
      const res = await upsertFinding(ctx, {
        platform: f.platform,
        externalId: f.externalId,
        relation: f.relation,
        parentExternalId: f.parentExternalId ?? w.external_id,
        authorHandle: f.authorHandle,
        authorExternalId: f.authorExternalId,
        contentText: f.contentText,
        permalink: f.permalink,
        occurredAt: f.occurredAt,
        commentCount: f.commentCount,
        watchedObjectId: w.id,
        metadata: f.metadata,
      })
      if (res.created) {
        ingested += 1
        created += 1
        await emitFindingCreated(ctx, res.id)
      }
    }
    const activitySeen = created > 0
    // Own posts follow their age band (tightened by fresh activity); every
    // other watch keeps the activity-driven hot/warm/cool/decayed cadence.
    const ownCadence = w.reason === "auto_own" ? ownPostCadence(w.metadata?.postedAt, activitySeen, now) : null
    const decision =
      ownCadence !== null
        ? { status: "active" as const, cadenceSeconds: ownCadence }
        : adaptCadence(w.status, activitySeen, w.last_activity_at ?? null, now)
    const nextPollAt = new Date(now.getTime() + decision.cadenceSeconds * 1000).toISOString()
    await ctx.db.update("watched_object", w.id, {
      status: decision.status,
      cadence_seconds: decision.cadenceSeconds,
      last_polled_at: now.toISOString(),
      last_activity_at: activitySeen ? now.toISOString() : (w.last_activity_at ?? null),
      next_poll_at: nextPollAt,
    })
  }
  for (const [platform, watches] of skippedNoToken) {
    ctx.logger?.debug?.("social: watch polls skipped, no OAuth access token for platform", { platform, watches })
  }

  // Persist the poller's running YouTube unit total for the day onto ITS OWN
  // ledger row (never the discovery row -- see loadYoutubeBudget) so the budget
  // carries across ticks (and resets tomorrow).
  if (yt) {
    const quota: YoutubeQuotaMetadata = { deferred }
    if (ytExhaustedUntil) quota.exhausted_until = ytExhaustedUntil
    else if (!yt.status.exhaustedUntil) quota.exhausted_until = null
    await ctx.db.update("sync_state", yt.ledger.id, {
      units_consumed_today: yt.pollerPrior + pollerSpent,
      units_window_date: youtubeQuotaDay(now),
      metadata: quotaMetadataPatch(yt.ledger, quota),
    })
  }

  return { polled, ingested, deferred }
}
