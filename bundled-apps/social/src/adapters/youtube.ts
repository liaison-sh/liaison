// SPDX-License-Identifier: FSL-1.1-ALv2
//
// YouTube adapter. `discover` runs TWO independent sweeps each cycle:
//  1. Keyword search (search.list, 100-unit) — brand-keyword VIDEO matches,
//     gated through `termMatchesVerbatim` (search.list's `q` match is
//     fuzzy/semantic — e.g. term "tessera touch" can hit a "tessellation" video
//     with zero textual relationship; only a case-insensitive substring-PHRASE
//     match in the title/description keeps a hit), then a batched videos.list
//     (statistics) pass so each surviving keyword_match finding's
//     `commentCount` is real (not hardcoded 0) — the signal auto-watch's
//     ≥20-comment promotion needs to ever fire (§9 #6).
//  2. Own-channel comment discovery (channels.list mine=true → playlistItems.list
//     uploads → commentThreads.list per recent upload) — surfaces comments
//     under OUR OWN videos even though watched_object starts empty and nothing
//     has been auto-watched yet. This sweep is stateless-recent (always reads
//     the latest ~25 uploads) and relies on finding dedup by [platform,
//     external_id] rather than a cursor — simplest correct approach (§ build spec A).
// `pollObject` uses commentThreads.list (1-unit) to pull comments on a watched
// video. Multiple matched terms for the same video dedupe to a single finding
// (§8). Unit costs are reported so the quota budget (B5) can sum them against
// the daily cap.

import { decodeHtmlEntities } from "../lib/html-entities"
import { packCursor, parseCursor, parseJsonCursor } from "./cursor"
import type {
  AdapterContext,
  DiscoverResult,
  DiscoveryTerm,
  NormalizedFinding,
  OutboundRequest,
  PlatformAdapter,
} from "./types"

/** Parse the sandbox fetch body string (empty body → empty object). */
function parseBody(body: string): unknown {
  if (!body) return {}
  try {
    return JSON.parse(body)
  } catch {
    return {}
  }
}


const YT_BASE = "https://www.googleapis.com/youtube/v3"

/** YouTube Data API v3 quota unit costs (§2.3). */
export const YT_SEARCH_UNITS = 100
export const YT_COMMENT_THREADS_UNITS = 1
/** channels.list / playlistItems.list / videos.list are all 1-unit "list" calls. */
export const YT_CHANNELS_UNITS = 1
export const YT_PLAYLIST_ITEMS_UNITS = 1
export const YT_VIDEOS_UNITS = 1

/** How many recent uploads the own-channel sweep walks each cycle. */
const OWN_CHANNEL_RECENT_UPLOADS = 25
/** How many comment threads are pulled per recent upload. */
const OWN_CHANNEL_COMMENTS_PER_VIDEO = 25
/** videos.list accepts up to 50 comma-joined ids per call (API limit). */
const VIDEOS_BATCH_SIZE = 50

/** Lookback overlap on each term's publishedAfter window: search indexing
 *  lags publication, so a video published just before the previous run can
 *  surface only later. Re-reading the overlap costs nothing extra (one call per
 *  term either way); findings dedupe on upsert. */
const KEYWORD_WINDOW_OVERLAP_MS = 12 * 60 * 60 * 1000

/** Upper bound on one discovery run's units, so the sync engine can gate the
 *  run on the remaining budget BEFORE spending: one search.list per term, one
 *  videos.list statistics batch per 50 hits, and the own-channel sweep
 *  (channels + playlistItems + one commentThreads per recent upload). */
export function estimateYoutubeDiscoveryUnits(termCount: number): number {
  const keyword = termCount > 0 ? termCount * YT_SEARCH_UNITS + Math.ceil((termCount * 50) / VIDEOS_BATCH_SIZE) * YT_VIDEOS_UNITS : 0
  const ownChannel = YT_CHANNELS_UNITS + YT_PLAYLIST_ITEMS_UNITS + OWN_CHANNEL_RECENT_UPLOADS * YT_COMMENT_THREADS_UNITS
  return keyword + ownChannel
}

/** Did Google refuse this call because the project's daily quota is spent?
 *  YouTube answers 403 with error.errors[].reason quotaExceeded (or the older
 *  dailyLimitExceeded). Such a call is not charged, and every further call
 *  fails the same way until the Pacific-midnight reset. */
export function isYoutubeQuotaRefusal(res: { status: number; body: string }): boolean {
  if (res.status !== 403) return false
  const body = parseBody(res.body) as { error?: { errors?: Array<{ reason?: string }> } }
  return (body.error?.errors ?? []).some((e) => e.reason === "quotaExceeded" || e.reason === "dailyLimitExceeded")
}

/** Per-term keyword-search state, packed into sync_state.cursor:
 *  `after` is the term's publishedAfter watermark, `pageToken` is set only
 *  while more than one page of new videos is being drained for that window. */
interface KeywordTermCursor {
  after?: string
  pageToken?: string
}
interface KeywordCursor {
  v: 2
  terms: Record<string, KeywordTermCursor>
}

function readKeywordCursor(cursor: string | null): KeywordCursor {
  const raw = parseJsonCursor(cursor)
  // A legacy cursor (one raw pageToken shared by every term) decodes to junk:
  // start fresh rather than replay another term's token.
  if (raw.v !== 2 || !raw.terms || typeof raw.terms !== "object") return { v: 2, terms: {} }
  return raw as unknown as KeywordCursor
}

/** Search text for a monitor term: keyword/hashtag values are used as-is; a
 *  handle's leading `@` (if present) is stripped since YouTube's search `q`
 *  matches the bare channel/handle name, not the `@`-prefixed display form. */
function searchText(term: DiscoveryTerm): string {
  if (term.kind === "handle" && term.value.startsWith("@")) {
    return term.value.slice(1)
  }
  return term.value
}

/** Whitespace-normalize (collapse runs of whitespace to a single space, trim)
 *  so a multi-word term matches as a PHRASE regardless of incidental
 *  formatting differences in the source text. */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/**
 * VERBATIM phrase match: does `term` appear as a case-insensitive SUBSTRING
 * PHRASE somewhere in `text`? Multi-word terms must match as the full phrase —
 * not as a word-set scattered across the text — so "tessera touch" does NOT
 * match text that merely contains "tessera" and "touch" separately. Exported so
 * both the search-relevance gate (this file) and the watch-poller's
 * auto_hot-comment classification (sync.ts) share identical matching
 * semantics.
 */
export function termAppearsIn(term: DiscoveryTerm, text: string | null | undefined): boolean {
  const needle = normalizeWhitespace(searchText(term)).toLowerCase()
  if (!needle || !text) return false
  return normalizeWhitespace(text).toLowerCase().includes(needle)
}

/**
 * VERBATIM relevance gate (incident fix): YouTube's `search.list` `q` param is
 * a fuzzy/semantic match — a term like "tessera touch" can hit videos about
 * "tessellation" with zero textual relationship to the term. Before a
 * search-matched video is kept as a `keyword_match` finding, require the term
 * to actually appear as a case-insensitive SUBSTRING PHRASE in the video's
 * title or description (search.list's snippet carries both).
 */
function termMatchesVerbatim(term: DiscoveryTerm, title: string | null, description: string | null): boolean {
  return termAppearsIn(term, title) || termAppearsIn(term, description)
}

interface YtSearchItem {
  id?: { videoId?: string }
  snippet?: {
    title?: string
    description?: string
    channelTitle?: string
    channelId?: string
    publishedAt?: string
  }
}

interface YtCommentThreadItem {
  id?: string
  snippet?: {
    topLevelComment?: {
      id?: string
      snippet?: {
        textDisplay?: string
        authorDisplayName?: string
        authorChannelId?: { value?: string }
        publishedAt?: string
      }
    }
  }
}

/** Normalize one commentThreads.list page into findings on `videoId`, optionally
 *  skipping comments authored by `ownChannelId` (own replies aren't "found"
 *  brand mentions) and carrying `videoTitle` into metadata when known (the
 *  own-channel sweep knows it from playlistItems; a bare watched-object poll
 *  does not). Shared by `pollObject` (watched videos) and the own-channel
 *  discovery sweep so both stay in lockstep on shape/relation/permalink. */
function normalizeCommentThreads(
  items: YtCommentThreadItem[],
  videoId: string,
  opts: { ownChannelId?: string | null; videoTitle?: string | null } = {},
): NormalizedFinding[] {
  const out: NormalizedFinding[] = []
  for (const t of items) {
    const c = t.snippet?.topLevelComment
    const authorChannelId = c?.snippet?.authorChannelId?.value ?? null
    if (opts.ownChannelId && authorChannelId && authorChannelId === opts.ownChannelId) continue
    const commentId = c?.id ?? t.id ?? ""
    out.push({
      platform: "youtube",
      externalId: commentId,
      relation: "comment_on_our_content",
      parentExternalId: videoId,
      authorHandle: decodeHtmlEntities(c?.snippet?.authorDisplayName ?? null),
      authorExternalId: authorChannelId,
      // textDisplay is HTML-encoded by the Data API (don't -> don&#39;t). Decode
      // at ingest so both the findings UI and the search index store the real
      // text, not the entity form.
      contentText: decodeHtmlEntities(c?.snippet?.textDisplay ?? null),
      permalink: commentId ? `https://www.youtube.com/watch?v=${videoId}&lc=${commentId}` : null,
      occurredAt: c?.snippet?.publishedAt ?? null,
      commentCount: 0,
      metadata: {
        siblingsAccessible: true,
        ...(opts.videoTitle ? { videoTitle: opts.videoTitle, postExcerpt: opts.videoTitle } : {}),
      },
    })
  }
  return out
}

interface YtChannelsResponse {
  items?: Array<{ id?: string; contentDetails?: { relatedPlaylists?: { uploads?: string } } }>
}

interface YtPlaylistItemsResponse {
  items?: Array<{
    contentDetails?: { videoId?: string }
    snippet?: { title?: string; resourceId?: { videoId?: string } }
  }>
}

interface YtCommentThreadsResponse {
  items?: YtCommentThreadItem[]
}

interface YtVideosStatisticsResponse {
  items?: Array<{ id?: string; statistics?: { commentCount?: string } }>
}

function authHeaders(ctx: AdapterContext): Record<string, string> {
  return ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {}
}

/**
 * Keyword-search discovery: ONE search.list (100 units) per term per run,
 * sorted by date and windowed by the term's own publishedAfter watermark, so a
 * run reads only what was published since the previous one. Each term keeps
 * its own pageToken (never replayed on another term); a token is kept only
 * when a window holds more than one page of new videos, and the next run reads
 * that next page instead of a fresh window. The first run of a term (no
 * watermark) reads the newest page and starts the window there: older history
 * is never paged through. Hits are deduped by video and passed through
 * `termMatchesVerbatim` (search.list's `q` match is fuzzy). A quota refusal
 * stops the sweep: terms already read keep their advance, the refused term and
 * the rest keep their previous state.
 */
async function discoverKeywordMatches(
  ctx: AdapterContext,
  terms: DiscoveryTerm[],
  cursor: string | null,
): Promise<DiscoverResult> {
  const now = ctx.now ?? new Date()
  const prior = readKeywordCursor(cursor)
  const next: KeywordCursor = { v: 2, terms: {} }
  for (const term of terms) {
    const t = prior.terms[term.id]
    if (t) next.terms[term.id] = t
  }
  const byVideo = new Map<string, NormalizedFinding>()
  let unitsConsumed = 0
  let quotaExhausted = false

  for (const term of terms) {
    const state = prior.terms[term.id] ?? {}
    const q = encodeURIComponent(searchText(term))
    const after = state.after ? `&publishedAfter=${encodeURIComponent(state.after)}` : ""
    const page = state.pageToken ? `&pageToken=${encodeURIComponent(state.pageToken)}` : ""
    const url = `${YT_BASE}/search?part=snippet&type=video&order=date&maxResults=50&q=${q}${after}${page}`
    const res = await ctx.fetch(url, { headers: authHeaders(ctx) })
    if (res.status === 401) {
      return { findings: [], nextCursor: cursor, unitsConsumed, error: "CONNECTION_LOST" }
    }
    if (res.status === 429) {
      return { findings: [], nextCursor: cursor, unitsConsumed, error: "RATE_LIMITED" }
    }
    if (isYoutubeQuotaRefusal(res)) {
      quotaExhausted = true
      break
    }
    unitsConsumed += YT_SEARCH_UNITS
    const body = (parseBody(res.body)) as { items?: YtSearchItem[]; nextPageToken?: string }
    // Advance this term's window. Only a windowed read keeps paging: without a
    // watermark the "next page" is older history, which is never wanted.
    next.terms[term.id] =
      state.after && body.nextPageToken
        ? { after: state.after, pageToken: body.nextPageToken }
        : { after: new Date(now.getTime() - KEYWORD_WINDOW_OVERLAP_MS).toISOString() }
    // Dedup by videoId: a video matching multiple terms (within this page or
    // across terms) is one finding, with every matching term id surfaced in
    // metadata (§8). VERBATIM GATE: search.list's `q` match is fuzzy/semantic
    // (it can surface e.g. a "tessellation" video for the term "tessera touch") —
    // only terms that actually appear as a substring phrase in the title or
    // description count as a real match; the units are still spent (the search
    // call already happened) but a video passing for NO term is dropped
    // entirely rather than surfaced as a false keyword_match.
    for (const item of body.items ?? []) {
      const videoId = item.id?.videoId
      if (!videoId) continue
      if (!termMatchesVerbatim(term, item.snippet?.title ?? null, item.snippet?.description ?? null)) continue
      const existing = byVideo.get(videoId)
      if (existing) {
        const matched = (existing.metadata?.matchedTerms as string[] | undefined) ?? []
        if (!matched.includes(term.id)) {
          existing.metadata = { ...existing.metadata, matchedTerms: [...matched, term.id] }
        }
        continue
      }
      byVideo.set(videoId, {
        platform: "youtube",
        externalId: videoId,
        relation: "keyword_match",
        authorHandle: decodeHtmlEntities(item.snippet?.channelTitle ?? null),
        authorExternalId: item.snippet?.channelId ?? null,
        // Video titles are HTML-encoded by the Data API (Q & A -> Q &amp; A).
        contentText: decodeHtmlEntities(item.snippet?.title ?? null),
        permalink: `https://www.youtube.com/watch?v=${videoId}`,
        occurredAt: item.snippet?.publishedAt ?? null,
        commentCount: 0,
        metadata: { matchedTerms: [term.id], siblingsAccessible: true },
      })
    }
  }

  return {
    findings: Array.from(byVideo.values()),
    nextCursor: packCursor(next as unknown as Record<string, unknown>),
    unitsConsumed,
    ...(quotaExhausted ? { quotaExhausted: true } : {}),
  }
}

/**
 * Batch-fetch statistics.commentCount for the given video ids (videos.list,
 * 1 unit per call, up to 50 ids/call) and set it onto each matching finding —
 * so auto-watch's ≥20-comment promotion (auto-watch.ts) can actually fire for
 * keyword-match videos (search.list's response carries no statistics; §9 build
 * spec B). A 401/429 here does not fail the whole discover: keyword findings
 * still land with commentCount 0 (safe — just not auto-watch-eligible this
 * cycle), the caller only spends the units actually consumed.
 */
async function populateKeywordCommentCounts(
  ctx: AdapterContext,
  findings: NormalizedFinding[],
): Promise<{ unitsConsumed: number; quotaExhausted?: boolean }> {
  const videoIds = findings.filter((f) => f.relation === "keyword_match").map((f) => f.externalId)
  if (videoIds.length === 0) return { unitsConsumed: 0 }
  let quotaExhausted = false

  const countsByVideoId = new Map<string, number>()
  let unitsConsumed = 0
  for (let i = 0; i < videoIds.length; i += VIDEOS_BATCH_SIZE) {
    const batch = videoIds.slice(i, i + VIDEOS_BATCH_SIZE)
    const url = `${YT_BASE}/videos?part=statistics&id=${batch.map(encodeURIComponent).join(",")}`
    const res = await ctx.fetch(url, { headers: authHeaders(ctx) })
    if (isYoutubeQuotaRefusal(res)) {
      quotaExhausted = true
      break
    }
    if (res.status === 401 || res.status === 429) break
    unitsConsumed += YT_VIDEOS_UNITS
    const body = (parseBody(res.body)) as YtVideosStatisticsResponse
    for (const item of body.items ?? []) {
      if (!item.id) continue
      const raw = item.statistics?.commentCount
      const n = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
      if (!Number.isNaN(n)) countsByVideoId.set(item.id, n)
    }
  }
  for (const f of findings) {
    const count = countsByVideoId.get(f.externalId)
    if (count !== undefined) f.commentCount = count
  }
  return { unitsConsumed, ...(quotaExhausted ? { quotaExhausted: true } : {}) }
}

/**
 * Own-channel comment discovery (§ build spec A): resolve the connected
 * channel's uploads playlist (channels.list mine=true, 1 unit), read its
 * recent uploads (playlistItems.list, 1 unit), then pull comment threads per
 * recent upload (commentThreads.list, 1 unit each) — surfacing comments
 * under OUR OWN videos regardless of whether anything has been watched yet
 * (watched_object starts empty; auto-watch can only promote a video AFTER a
 * qualifying finding already landed — this sweep is the bootstrap). Stateless-
 * recent: always reads the latest `OWN_CHANNEL_RECENT_UPLOADS` uploads and
 * relies on finding dedup by [platform, external_id] rather than a cursor —
 * simplest correct approach. A per-video comments failure (e.g. 403 comments
 * disabled) is swallowed for that video only, not surfaced as CONNECTION_LOST
 * (comments-disabled is a per-video state, not an auth failure). Own-channel
 * comments (author's channel id === our channel id) are skipped — the
 * channel's own replies aren't a "found" brand mention.
 */
async function discoverOwnChannelComments(
  ctx: AdapterContext,
): Promise<{ findings: NormalizedFinding[]; unitsConsumed: number; quotaExhausted?: boolean }> {
  let unitsConsumed = 0

  const channelsRes = await ctx.fetch(
    `${YT_BASE}/channels?part=contentDetails&mine=true`,
    { headers: authHeaders(ctx) },
  )
  if (isYoutubeQuotaRefusal(channelsRes)) return { findings: [], unitsConsumed, quotaExhausted: true }
  if (channelsRes.status === 401 || channelsRes.status === 429) {
    // No channel resolvable this cycle — the caller's overall discover() still
    // surfaces the typed error from the keyword sweep if that also failed;
    // here we simply contribute zero findings/units.
    return { findings: [], unitsConsumed }
  }
  unitsConsumed += YT_CHANNELS_UNITS
  const channelsBody = (parseBody(channelsRes.body)) as YtChannelsResponse
  const ownChannelId = channelsBody.items?.[0]?.id ?? null
  const uploadsPlaylistId = channelsBody.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null
  if (!uploadsPlaylistId) return { findings: [], unitsConsumed }

  const playlistRes = await ctx.fetch(
    `${YT_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=${OWN_CHANNEL_RECENT_UPLOADS}`,
    { headers: authHeaders(ctx) },
  )
  if (isYoutubeQuotaRefusal(playlistRes)) return { findings: [], unitsConsumed, quotaExhausted: true }
  if (playlistRes.status === 401 || playlistRes.status === 429) {
    return { findings: [], unitsConsumed }
  }
  unitsConsumed += YT_PLAYLIST_ITEMS_UNITS
  const playlistBody = (parseBody(playlistRes.body)) as YtPlaylistItemsResponse
  const recentVideos = (playlistBody.items ?? [])
    .map((it) => ({
      videoId: it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId ?? null,
      // Own-channel video title feeds the finding's postExcerpt/videoTitle
      // context line — decode entities here too so it renders cleanly.
      title: decodeHtmlEntities(it.snippet?.title ?? null),
    }))
    .filter((v): v is { videoId: string; title: string | null } => !!v.videoId)

  const findings: NormalizedFinding[] = []
  for (const video of recentVideos) {
    const url = `${YT_BASE}/commentThreads?part=snippet&videoId=${video.videoId}&maxResults=${OWN_CHANNEL_COMMENTS_PER_VIDEO}&order=time`
    let res: { status: number; body: string }
    try {
      res = await ctx.fetch(url, { headers: authHeaders(ctx) })
    } catch {
      // Network/adapter-level throw for one video — swallow and continue with
      // the rest of the recent uploads (per build spec: "a per-video comments
      // failure swallows per-video").
      continue
    }
    // commentThreads on a video with comments disabled returns 403 — swallow
    // (not CONNECTION_LOST: it's a per-video state, not an auth failure).
    // 401/429 on a SINGLE video call is likewise swallowed per-video here;
    // the keyword sweep is the one that surfaces a typed adapter-level error
    // for a genuinely dead connection. A quota refusal is not per-video: stop.
    if (isYoutubeQuotaRefusal(res)) return { findings, unitsConsumed, quotaExhausted: true }
    if (res.status !== 200) continue
    unitsConsumed += YT_COMMENT_THREADS_UNITS
    const body = (parseBody(res.body)) as YtCommentThreadsResponse
    findings.push(
      ...normalizeCommentThreads(body.items ?? [], video.videoId, {
        ownChannelId,
        videoTitle: video.title,
      }),
    )
  }

  return { findings, unitsConsumed }
}

export const youtubeAdapter: PlatformAdapter = {
  platform: "youtube",

  async discover(ctx: AdapterContext, cursor: string | null): Promise<DiscoverResult> {
    const terms = ctx.terms ?? []

    // Sweep 1: keyword search — inert (and skipped entirely, 0 units) with no
    // monitor terms configured.
    let keywordResult: DiscoverResult = { findings: [], nextCursor: cursor, unitsConsumed: 0 }
    if (terms.length > 0) {
      keywordResult = await discoverKeywordMatches(ctx, terms, cursor)
      if (keywordResult.error) {
        // A dead connection (401/429) on the keyword sweep is a genuine
        // CONNECTION_LOST/RATE_LIMITED for the whole discover() call — the
        // cursor must not advance, and there is no live token to run the
        // own-channel sweep with either.
        return keywordResult
      }
      const stats = await populateKeywordCommentCounts(ctx, keywordResult.findings)
      keywordResult.unitsConsumed += stats.unitsConsumed
      if (stats.quotaExhausted) keywordResult.quotaExhausted = true
    }
    // Quota spent: keep what the keyword sweep found, spend nothing more.
    if (keywordResult.quotaExhausted) return keywordResult

    // Sweep 2: own-channel comment discovery — independent of monitor terms,
    // always runs (own comments are worth finding even with zero keywords
    // configured). Uses ctx.accountExternalId for nothing (channels.list
    // mine=true resolves the channel from the token), so it's safe to run
    // even when discoverKeywordMatches was skipped.
    const ownChannel = await discoverOwnChannelComments(ctx)

    return {
      findings: [...keywordResult.findings, ...ownChannel.findings],
      nextCursor: keywordResult.nextCursor,
      unitsConsumed: keywordResult.unitsConsumed + ownChannel.unitsConsumed,
      ...(ownChannel.quotaExhausted ? { quotaExhausted: true } : {}),
    }
  },

  async pollObject(
    ctx: AdapterContext,
    objectExternalId: string,
    cursor: string | null,
  ): Promise<DiscoverResult> {
    const pageToken = parseCursor(cursor)
    const url = `${YT_BASE}/commentThreads?part=snippet&videoId=${objectExternalId}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`
    const res = await ctx.fetch(url, { headers: authHeaders(ctx) })
    if (res.status === 401) {
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error: "CONNECTION_LOST" }
    }
    if (isYoutubeQuotaRefusal(res)) {
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, quotaExhausted: true }
    }
    const body = (parseBody(res.body)) as YtCommentThreadsResponse & { nextPageToken?: string }
    const findings = normalizeCommentThreads(body.items ?? [], objectExternalId)
    return {
      findings,
      nextCursor: body.nextPageToken ?? null,
      unitsConsumed: YT_COMMENT_THREADS_UNITS,
    }
  },

  // YouTube comment REPLY → comments.insert on the YouTube Data API
  // (googleapis.com), NOT the Graph API. The parent comment id rides in the
  // body's snippet.parentId — never the URL — so the reply text is injection-safe.
  // Used for `comment_on_our_content` findings (target.externalId is a comment id).
  replyRequest(target: { externalId: string }, text: string): OutboundRequest {
    return {
      url: `${YT_BASE}/comments?part=snippet`,
      body: { snippet: { parentId: target.externalId, textOriginal: text } },
    }
  },

  // A TOP-LEVEL comment on a `keyword_match` VIDEO finding — there is no parent
  // comment to reply to (comments.insert requires `parentId`), so this shapes a
  // commentThreads.insert instead (snippet.videoId + snippet.topLevelComment.
  // snippet.textOriginal). target.externalId is the VIDEO id here, never a
  // comment id — post-back dispatches on the finding's relation (see
  // post-back.ts's `replyRequest` call), so a keyword_match finding's
  // externalId (the video id) rides safely in the body, not the URL.
  topLevelCommentRequest(target: { externalId: string }, text: string): OutboundRequest {
    return {
      url: `${YT_BASE}/commentThreads?part=snippet`,
      body: {
        snippet: {
          videoId: target.externalId,
          topLevelComment: { snippet: { textOriginal: text } },
        },
      },
    }
  },

  // No like-comment-as-channel API exists on YouTube (§4.5) → liking is
  // unsupported; post-back returns `unsupported` without a call.
  likeRequest(): OutboundRequest | null {
    return null
  },
}
