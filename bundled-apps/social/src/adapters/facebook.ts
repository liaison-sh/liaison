// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Facebook adapter. `discover` backfills COMMENTS on EVERY managed Page's own
// feed posts (mirrors instagram.ts's own-media pattern: fetch the page feed,
// then fetch each post's comments — a post itself is never a finding, only
// the comments under it are); `syncDms` syncs Messenger conversations for
// every managed Page. `verifyWebhook` validates Meta's X-Hub-Signature-256
// HMAC; `parseWebhook` normalizes change notifications into findings/messages
// for the fast-ack ingest path (B5).
//
// PAGE TOKENS (the core fix here): the `facebook` OAuth connection resolves
// the connected account from `/me` — the USER node — so `ctx.accessToken` is
// a USER access token. Page content (feed, comments, Messenger conversations)
// lives on the PAGE node and requires a PAGE access token, obtained via
// `GET /me/accounts` (using the user token), which returns each managed
// Page's own `access_token`. Every read AND write call in this file that
// touches Page-owned content must be authorized with that Page's token, never
// the user token. `/me/accounts` is resolved ONCE per adapter-method
// invocation (not once per page/item) and is not cached across calls — it's
// cheap and self-heals if the Page list changes.

import { facebookCommentUrl } from "../lib/facebook-links"
import { packCursor, parseCursor, parseJsonCursor } from "./cursor"
import {
  type GraphPage,
  type ListError,
  type GraphError,
  graphError,
  graphTime,
  type ListState,
  readListState,
  usageThrottled,
  walkNewestFirst,
} from "./graph-paging"
import type {
  AdapterContext,
  DiscoverResult,
  DmSyncResult,
  NormalizedConversation,
  NormalizedFinding,
  NormalizedMessage,
  OutboundRequest,
  OwnRecentObjectsResult,
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

export const FB_BASE = "https://graph.facebook.com/v26.0"

interface FbPage {
  id: string
  name?: string
  access_token: string
}

interface FbPagesResponse {
  data?: FbPage[]
}

interface ResolvedPages {
  pages: FbPage[]
  error?: "CONNECTION_LOST" | "RATE_LIMITED"
}

/**
 * Resolve the Pages the connected user manages, each with its OWN Page
 * access token (`GET /me/accounts`, authorized with the USER token). Call
 * this ONCE per adapter-method invocation — every page/item within that call
 * reuses the same resolved list, it is never re-fetched per page.
 */
async function resolveManagedPages(ctx: AdapterContext): Promise<ResolvedPages> {
  const url = `${FB_BASE}/me/accounts?fields=id,name,access_token`
  const res = await ctx.fetch(url, {
    headers: ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {},
  })
  const err = graphError(res)
  if (err) return { pages: [], error: err }
  const body = parseBody(res.body) as FbPagesResponse
  return { pages: body.data ?? [] }
}

/** Pick the Page from a resolved list whose id matches `pageId`, if any. */
function findPage(pages: FbPage[], pageId: string): FbPage | undefined {
  return pages.find((p) => p.id === pageId)
}

/**
 * Facebook Graph API convention: a Page-owned post/comment id is prefixed
 * with the owning Page's id, e.g. `<pageId>_<postId>`. Parsing the prefix
 * lets outbound calls (reply/like on a comment, pollObject on a post) pick
 * the right Page's token without a separate lookup. ASSUMPTION: this is the
 * standard Graph API id-prefix convention (not verified against a live call
 * in this fix — flagged for validation against the real API).
 */
function pageIdPrefix(externalId: string): string | null {
  const idx = externalId.indexOf("_")
  return idx > 0 ? externalId.slice(0, idx) : null
}

/**
 * Resolve the Page access token to use for a Page-owned externalId (post or
 * comment). Prefers the id-prefix match; falls back to the first managed
 * page (never falls back to the wrong USER token for a Page POST).
 */
function resolvePageTokenForExternalId(pages: FbPage[], externalId: string): FbPage | undefined {
  const prefix = pageIdPrefix(externalId)
  if (prefix) {
    const matched = findPage(pages, prefix)
    if (matched) return matched
  }
  return pages[0]
}

interface FbComment {
  id: string
  message?: string
  from?: { id?: string; name?: string }
  created_time?: string
  permalink_url?: string
}

/** One post on a managed Page's own feed, with a comment COUNT (not the comments
 *  themselves — `comments.summary(true).limit(0)` asks the Graph API for just the
 *  summary object so the feed page stays cheap; posts with comments get a
 *  follow-up per-post fetch via `fetchPostComments`). */
interface FbPost {
  id: string
  message?: string
  permalink_url?: string
  created_time?: string
  comments?: { summary?: { total_count?: number } }
}

interface FbFeedResponse {
  data?: FbPost[]
  paging?: { cursors?: { after?: string } }
}

interface FbCommentsResponse {
  data?: FbComment[]
}

/** First ~80 code points of a post's caption/message, for the finding's
 *  "on: <post>" context (`metadata.postExcerpt`). Truncates by CODE POINT, not
 *  UTF-16 unit — a `.slice(0, 80)` landing inside a surrogate pair (any emoji)
 *  leaves a lone surrogate that JSON.stringify emits as a bare `\ud83d`, which
 *  Postgres's jsonb parser rejects (22P02); one emoji post then killed the
 *  whole discovery job on staging. */
export function postExcerpt(message: string | undefined | null): string | undefined {
  if (!message) return undefined
  const trimmed = message.trim()
  const points = Array.from(trimmed)
  if (points.length <= 80) return trimmed
  return `${points.slice(0, 80).join("").trimEnd()}…`
}

/** Shape of a Graph API error body (`{ error: { message, type, code, ... } }`). */
interface FbErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number }
}

/**
 * Fetch comments on one Page's own feed post (modest page size — the discovery
 * pass surfaces recent activity, not a full backfill; a hand-watched
 * watched_object handles deep pagination via pollObject), authorized with the
 * SAME Page token used to fetch the feed. Comments authored by the Page itself
 * (our own replies) are skipped — they aren't actionable findings. Errors are
 * swallowed per-post so one bad post doesn't sink the whole discovery page,
 * mirroring instagram.ts's `fetchOwnMediaComments` — but first logged (status +
 * Graph error code/message) so an operator can see WHY a post's comments went
 * missing this cycle instead of it looking like silent data loss. Live-observed:
 * FB reels intermittently 400 with Graph error #100 on `/comments` and
 * self-heal server-side on a later poll — the swallow-and-retry-next-cycle
 * behavior is intentional, only the silence is the bug.
 */
async function fetchPostComments(
  ctx: AdapterContext,
  post: FbPost,
  page: FbPage,
): Promise<NormalizedFinding[] | { error: GraphError }> {
  // Newest comments first: the default order is chronological, so on a busy
  // post the first 25 were the OLDEST and a new comment was never read.
  const url = `${FB_BASE}/${post.id}/comments?fields=id,message,from,created_time,permalink_url&order=reverse_chronological&limit=25`
  const res = await ctx.fetch(url, {
    headers: { Authorization: `Bearer ${page.access_token}` },
  })
  if (graphError(res) === "RATE_LIMITED") return { error: "RATE_LIMITED" }
  if (res.status !== 200) {
    const errBody = parseBody(res.body) as FbErrorBody
    ctx.logger?.warn?.("social: facebook comments fetch failed — post skipped this cycle", {
      postId: post.id,
      status: res.status,
      code: errBody.error?.code,
      message: errBody.error?.message,
    })
    return []
  }
  const body = parseBody(res.body) as FbCommentsResponse
  const excerpt = postExcerpt(post.message)
  const findings: NormalizedFinding[] = []
  for (const c of body.data ?? []) {
    if (c.from?.id === page.id) continue // our own reply — not an actionable finding
    findings.push({
      platform: "facebook",
      externalId: c.id,
      relation: "comment_on_our_content",
      parentExternalId: post.id,
      authorHandle: c.from?.name ?? null,
      authorExternalId: c.from?.id ?? null,
      contentText: c.message ?? null,
      // Graph omits permalink_url on some comments (and then on their post):
      // the comment's web link is built from its ids so it stays openable.
      permalink: c.permalink_url ?? post.permalink_url ?? facebookCommentUrl(c.id, post.id),
      occurredAt: c.created_time ?? null,
      commentCount: 0,
      metadata: {
        siblingsAccessible: true,
        pageId: page.id,
        postPermalink: post.permalink_url ?? null,
        ...(excerpt ? { postExcerpt: excerpt } : {}),
      },
    })
  }
  return findings
}

interface FbConversationParticipant {
  id: string
  name?: string
}

interface FbConversation {
  id: string
  participants?: { data?: FbConversationParticipant[] }
  updated_time?: string
}

interface FbConversationsResponse {
  data?: FbConversation[]
  paging?: { cursors?: { after?: string } }
}

interface FbDmMessage {
  id: string
  from?: { id?: string; name?: string }
  message?: string
  created_time?: string
}

interface FbDmMessagesResponse {
  data?: FbDmMessage[]
  paging?: { cursors?: { after?: string } }
}

/** The other party on a Page DM thread — the participant that isn't the Page itself. */
function nonSelfParticipant(
  conv: FbConversation,
  pageId: string,
): FbConversationParticipant | undefined {
  return conv.participants?.data?.find((p) => p.id !== pageId)
}

/**
 * The literal placeholder string Meta's Graph API returns for a redacted
 * participant identity (users not connected to the Page — a privacy
 * redaction, not a bug). Recognized so the name-fallback (A) knows when the
 * conversation-level name is actually USABLE vs. the generic placeholder.
 */
const FB_REDACTED_PARTICIPANT_NAME = "Facebook user"

/** True when `name` is absent or is Meta's generic redaction placeholder. */
function isMissingOrPlaceholderName(name: string | null | undefined): boolean {
  return !name || name.trim().length === 0 || name === FB_REDACTED_PARTICIPANT_NAME
}

/**
 * Participant-name fallback (A): the conversation-level participant name is
 * often the literal "Facebook user" placeholder (Meta redacts identity for
 * users not connected to the Page) even though the SAME sender's per-message
 * `from.name` frequently carries a real, usable name (live-verified on
 * staging). Falls back to the most recent INBOUND message's `from.name`
 * ONLY when the conversation-level name is missing/placeholder — a real
 * conversation-level name is never overwritten. Messages are assumed sorted
 * newest-first (Graph API's default `/messages` ordering); the first
 * inbound message with a usable `from.name` wins.
 */
function resolveParticipantName(
  conversationLevelName: string | null | undefined,
  participantId: string | undefined,
  pageId: string,
  messages: FbDmMessage[],
): string | null {
  if (!isMissingOrPlaceholderName(conversationLevelName)) return conversationLevelName ?? null
  for (const m of messages) {
    if (m.from?.id === pageId) continue // our own outbound reply — not the participant
    if (participantId && m.from?.id && m.from.id !== participantId) continue
    if (!isMissingOrPlaceholderName(m.from?.name)) return m.from!.name!
  }
  // Platform-generic fallback stays null — the UI's authorLabel already
  // renders "Facebook user" for a null participant handle.
  return null
}

function normalizeConversation(
  conv: FbConversation,
  pageId: string,
  messages: FbDmMessage[] = [],
): NormalizedConversation {
  const participant = nonSelfParticipant(conv, pageId)
  const resolvedName = resolveParticipantName(participant?.name, participant?.id, pageId, messages)
  return {
    platform: "facebook",
    externalId: conv.id,
    participantHandle: resolvedName,
    participantExternalId: participant?.id ?? null,
    participantDisplayName: resolvedName,
    lastMessageAt: conv.updated_time ?? null,
    // Plumbed through to `dm_conversation.metadata` (handlers.ts) so a later
    // `send_dm` can resolve THIS Page's access token — the conversation row
    // otherwise has no way to recover which Page a thread belongs to.
    metadata: { pageId },
  }
}

/**
 * A Meta webhook time as ISO-8601. Deliveries mix units: `messaging[].timestamp`
 * is epoch MILLISECONDS, a feed change's `created_time` and most `entry.time`
 * values are epoch SECONDS, and some fields arrive as ISO strings. Null when
 * absent or unreadable (the ingest then falls back to the arrival time).
 */
export function metaTimeToIso(v: unknown): string | null {
  let n: number | null = null
  if (typeof v === "number" && Number.isFinite(v)) n = v
  else if (typeof v === "string" && /^\d+$/.test(v)) n = Number(v)
  else if (typeof v === "string") {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? null : new Date(ms).toISOString()
  }
  if (n === null || n <= 0) return null
  const ms = n < 1e12 ? n * 1000 : n
  return new Date(ms).toISOString()
}

function normalizeDmMessage(
  conversationExternalId: string,
  pageId: string,
  m: FbDmMessage,
): NormalizedMessage {
  return {
    conversationExternalId,
    externalId: m.id,
    direction: m.from?.id === pageId ? "outbound" : "inbound",
    body: m.message ?? null,
    occurredAt: m.created_time ?? null,
  }
}

/** Per-page message-fetch size and the hard page-count bound (C): caps a
 *  single conversation's per-sync fetch at MESSAGE_PAGE_LIMIT * MESSAGE_PAGE_BOUND
 *  (25 * 4 = 100) messages — bounded backfill, not unlimited history, so one
 *  very long thread can't blow the sandbox's per-tick time budget. */
const MESSAGE_PAGE_LIMIT = 25
const MESSAGE_PAGE_BOUND = 4

/**
 * Fetch a conversation's messages newest first, paginating on
 * `paging.cursors.after` up to `MESSAGE_PAGE_BOUND` pages (C), and stopping
 * once a page reaches `sinceMs` (the stored last-message time: everything
 * older already landed). Downstream dedup (`upsertDmMessage`, keyed on
 * [conversation_id, external_id]) makes overlapping pages idempotent. A
 * failed page ends the fetch with `ok: false` so the caller does not advance
 * the conversation's last-message mark past messages that never landed.
 * Takes an explicit Page access token (not `ctx.accessToken`, which is the
 * user token): each Page's conversations are authorized with THAT page's token.
 */
async function fetchConversationMessages(
  ctx: AdapterContext,
  conversationId: string,
  pageAccessToken: string,
  sinceMs: number,
): Promise<{ messages: FbDmMessage[]; ok: boolean; rateLimited: boolean }> {
  const out: FbDmMessage[] = []
  let after: string | undefined
  for (let page = 0; page < MESSAGE_PAGE_BOUND; page++) {
    const url = `${FB_BASE}/${conversationId}/messages?fields=id,from,message,created_time&limit=${MESSAGE_PAGE_LIMIT}${after ? `&after=${after}` : ""}`
    const res = await ctx.fetch(url, {
      headers: { Authorization: `Bearer ${pageAccessToken}` },
    })
    if (res.status !== 200) return { messages: out, ok: false, rateLimited: graphError(res) === "RATE_LIMITED" }
    const body = parseBody(res.body) as FbDmMessagesResponse
    const data = body.data ?? []
    out.push(...data)
    after = body.paging?.cursors?.after
    if (!after || data.length === 0) break
    const oldest = graphTime(data[data.length - 1]?.created_time)
    if (!Number.isNaN(sinceMs) && !Number.isNaN(oldest) && oldest <= sinceMs) break
  }
  return { messages: out, ok: true, rateLimited: false }
}

/** Head pages (newest first) and history pages read per tick, per Page. */
const CONVERSATION_HEAD_PAGES = 3
const CONVERSATION_BACKFILL_PAGES = 1
const FEED_HEAD_PAGES = 2
const FEED_BACKFILL_PAGES = 1
const CONVERSATION_PAGE_LIMIT = 20
const FEED_PAGE_LIMIT = 25
const FEED_BACKFILL_LIMIT = 10

/** Compound cursor: `{ pages: { [pageId]: ListState } }`. A string value is a
 *  legacy `after` token from the backward walk and reads as "no state". */
interface FbCompoundCursor {
  pages?: Record<string, unknown>
}

function pageStates(cursor: string | null): { fresh: (pageId: string) => boolean; state: (pageId: string) => ListState | null } {
  const pages = (parseJsonCursor(cursor) as FbCompoundCursor).pages ?? {}
  return {
    // A Page the cursor has never seen gets its history backfilled.
    fresh: (pageId) => !(pageId in pages),
    state: (pageId) => readListState(pages[pageId]),
  }
}

function packPageStates(perPage: Record<string, ListState>): string | null {
  return Object.keys(perPage).length > 0 ? packCursor({ pages: perPage }) : null
}

/** One page of a Graph list edge for `walkNewestFirst`. */
async function fetchListPage<T>(
  ctx: AdapterContext,
  url: string,
  token: string,
): Promise<GraphPage<T> | { error: ListError }> {
  const res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const err = graphError(res)
  if (err) return { error: err }
  // Any other failure: skip this source this tick with its state kept,
  // instead of reading an error body as an empty list.
  if (res.status !== 200) return { error: "UNAVAILABLE" }
  const body = parseBody(res.body) as { data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }
  const data = body.data ?? []
  // Graph keeps an `after` cursor on the last page; only `paging.next` says more exist.
  const next = data.length > 0 && body.paging?.cursors?.after && body.paging.next !== undefined
    ? body.paging.cursors.after
    : null
  return { items: data, next, throttled: usageThrottled(res.headers) }
}

export const facebookAdapter: PlatformAdapter = {
  platform: "facebook",

  /**
   * Sync DM conversations + messages via the Page Messaging API
   * (graph.facebook.com, PAGE access tokens — see the file-level comment).
   * Resolves managed pages ONCE, then fans out `/{pageId}/conversations` +
   * per-conversation `/messages` for EACH page, each authorized with that
   * page's own token. Each page's conversations are read NEWEST FIRST down
   * to that page's stored high-water mark, with a bounded history pass for a
   * new page (graph-paging.ts); the cursor packs one `ListState` per page.
   *
   * Crash-safety: if `/me/accounts` OR any single page's `/conversations`
   * call errors (401, 429 or a Graph rate-limit code), the WHOLE syncDms call is treated as errored and
   * `nextCursor` echoes the passed-in cursor unchanged — no partial-page-set
   * advancement (mirrors the pre-fix single-cursor error contract; the spec
   * explicitly asks for this simple all-or-nothing behavior over engineering
   * partial-page recovery).
   *
   * Changed-only fan-out (D): a conversation whose API-reported
   * `updated_time` is NOT strictly newer than its stored watermark
   * (`ctx.skipMessagesBefore`, keyed by conversation externalId — populated
   * by `dmSyncJob` from existing `dm_conversation.last_message_at` rows) is
   * upserted for its metadata only — its `/messages` fetch is skipped. This
   * is what previously fetched messages for every conversation on every
   * tick regardless of change, timing the QuickJS sandbox out at ~20
   * conversations/page.
   */
  async syncDms(ctx: AdapterContext, cursor: string | null): Promise<DmSyncResult> {
    const { pages, error } = await resolveManagedPages(ctx)
    if (error) {
      return { conversations: [], messages: [], nextCursor: cursor, error }
    }
    const states = pageStates(cursor)

    const conversations: NormalizedConversation[] = []
    const messages: NormalizedMessage[] = []
    const nextPerPage: Record<string, ListState> = {}
    let rateLimited = false

    for (const page of pages) {
      const walk = await walkNewestFirst<FbConversation>({
        state: states.state(page.id),
        fresh: states.fresh(page.id),
        mode: "watermark",
        headPages: CONVERSATION_HEAD_PAGES,
        backfillPages: CONVERSATION_BACKFILL_PAGES,
        timeOf: (c) => graphTime(c.updated_time),
        idOf: (c) => c.id,
        fetchPage: (after) =>
          fetchListPage<FbConversation>(
            ctx,
            `${FB_BASE}/${page.id}/conversations?fields=id,participants,updated_time&limit=${CONVERSATION_PAGE_LIMIT}${after ? `&after=${after}` : ""}`,
            page.access_token,
          ),
      })
      if ("error" in walk) {
        if (walk.error === "UNAVAILABLE") {
          ctx.logger?.warn?.("social: facebook list read failed, page skipped this tick", { pageId: page.id, edge: "conversations" })
          const kept = states.state(page.id)
          if (kept) nextPerPage[page.id] = kept
          continue
        }
        return { conversations: [], messages: [], nextCursor: cursor, error: walk.error }
      }
      let held = false
      for (const conv of walk.items) {
        const threshold = ctx.skipMessagesBefore?.get(conv.id)
        const changed =
          !threshold || !conv.updated_time || graphTime(conv.updated_time) > graphTime(threshold)
        let rawMessages: FbDmMessage[] = []
        let complete = true
        if (changed) {
          if (rateLimited) {
            // Throttled earlier this tick: no more message fetches; the held
            // state re-reads this conversation next tick.
            complete = false
            held = true
          } else {
            const fetched = await fetchConversationMessages(ctx, conv.id, page.access_token, graphTime(threshold))
            rawMessages = fetched.messages
            complete = fetched.ok
            if (fetched.rateLimited) {
              rateLimited = true
              held = true
            }
          }
        }
        for (const m of rawMessages) {
          messages.push(normalizeDmMessage(conv.id, page.id, m))
        }
        const normalized = normalizeConversation(conv, page.id, rawMessages)
        // Messages that did not land must not be hidden behind an advanced mark.
        if (!complete) normalized.lastMessageAt = null
        conversations.push(normalized)
      }
      nextPerPage[page.id] = held ? walk.heldState : walk.state
    }

    return {
      conversations,
      messages,
      nextCursor: packPageStates(nextPerPage),
    }
  },

  /**
   * Fans out feed COMMENTS over EVERY managed Page (resolved once via
   * `/me/accounts`), each authorized with that Page's own token — mirrors
   * instagram.ts's own-media discovery: fetch the Page's own feed posts
   * (with a comment-count summary, `comments.summary(true).limit(0)`), then
   * for each post that has comments, fetch that post's comments and ingest
   * THOSE as findings (never the post itself — a post is our own caption,
   * not brand-relevant third-party activity). Comments authored by the Page
   * itself are skipped (see `fetchPostComments`). Findings carry
   * `metadata.pageId`/`postPermalink`/`postExcerpt` (in addition to the
   * existing `siblingsAccessible` marker) so a finding can be traced back to
   * its owning Page and the post it's "on:". Each tick reads the newest feed
   * page (recent posts collect most comments) plus one rotating page of older
   * posts (graph-paging.ts "rotating"); the cursor packs one `ListState` per
   * page. Crash-safety as in `syncDms`: one page's error fails the whole call,
   * cursor unchanged. A rate limit mid-tick keeps that page's prior state.
   */
  async discover(ctx: AdapterContext, cursor: string | null): Promise<DiscoverResult> {
    const { pages, error } = await resolveManagedPages(ctx)
    if (error) {
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error }
    }
    const states = pageStates(cursor)

    const findings: NormalizedFinding[] = []
    const nextPerPage: Record<string, ListState> = {}
    let rateLimited = false

    for (const page of pages) {
      const feedFields = "fields=id,message,permalink_url,created_time,comments.summary(true).limit(0)"
      const walk = await walkNewestFirst<FbPost>({
        state: states.state(page.id),
        fresh: states.fresh(page.id),
        mode: "rotating",
        headPages: FEED_HEAD_PAGES,
        backfillPages: FEED_BACKFILL_PAGES,
        timeOf: (p) => graphTime(p.created_time),
        idOf: (p) => p.id,
        fetchPage: (after) =>
          fetchListPage<FbPost>(
            ctx,
            `${FB_BASE}/${page.id}/feed?${feedFields}&limit=${after ? FEED_BACKFILL_LIMIT : FEED_PAGE_LIMIT}${after ? `&after=${after}` : ""}`,
            page.access_token,
          ),
      })
      if ("error" in walk) {
        if (walk.error === "UNAVAILABLE") {
          ctx.logger?.warn?.("social: facebook list read failed, page skipped this tick", { pageId: page.id, edge: "feed" })
          const kept = states.state(page.id)
          if (kept) nextPerPage[page.id] = kept
          continue
        }
        return { findings: [], nextCursor: cursor, unitsConsumed: 0, error: walk.error }
      }
      let held = false
      const posts = walk.items.filter((p) => (p.comments?.summary?.total_count ?? 0) > 0)
      for (const post of posts) {
        if (rateLimited) {
          held = true
          break
        }
        const comments = await fetchPostComments(ctx, post, page)
        if ("error" in comments) {
          rateLimited = true
          held = true
          break
        }
        findings.push(...comments)
      }
      nextPerPage[page.id] = held ? walk.heldState : walk.state
    }

    return { findings, nextCursor: packPageStates(nextPerPage), unitsConsumed: 0 }
  },

  /**
   * Own-content auto-watch enumeration: the newest `limit` posts of EVERY
   * managed Page (`/{page}/posts`, first page only, each with that Page's own
   * token). Never pages and never touches the `discover` cursor. A Page whose
   * read fails is skipped with a warning; 401 and Graph throttling (429, or
   * error codes 4/17/32/613) abort the call as a typed error.
   */
  async listOwnRecentObjects(ctx: AdapterContext, limit: number): Promise<OwnRecentObjectsResult> {
    const { pages, error } = await resolveManagedPages(ctx)
    if (error) return { objects: [], error }
    const objects: OwnRecentObjectsResult["objects"] = []
    for (const page of pages) {
      const url = `${FB_BASE}/${page.id}/posts?fields=id,message,permalink_url,created_time&limit=${limit}`
      const res = await ctx.fetch(url, { headers: { Authorization: `Bearer ${page.access_token}` } })
      if (res.status === 401) return { objects: [], error: "CONNECTION_LOST" }
      const parsed = parseBody(res.body) as FbFeedResponse & FbErrorBody
      if (graphError(res) === "RATE_LIMITED") return { objects: [], error: "RATE_LIMITED" }
      if (res.status !== 200) {
        ctx.logger?.warn?.("social: facebook own posts read failed, Page skipped this tick", {
          pageId: page.id,
          status: res.status,
          code: parsed.error?.code,
          message: parsed.error?.message,
        })
        continue
      }
      for (const post of parsed.data ?? []) {
        objects.push({
          externalId: post.id,
          objectType: "facebook_post",
          title: postExcerpt(post.message) ?? null,
          permalink: post.permalink_url ?? null,
          createdAt: post.created_time ?? null,
        })
      }
    }
    return { objects }
  },

  /**
   * Polls one watched `facebook_post`. `objectExternalId` follows the
   * `<pageId>_<postId>` Graph API id-prefix convention (see
   * `pageIdPrefix`/ASSUMPTION note above) — the prefix picks the right
   * managed Page's token; falls back to the first managed page if the
   * prefix doesn't match any (never silently falls back to the user token).
   * Resolves `/me/accounts` fresh on every call (stateless, cheap; same
   * posture as `discover`/`syncDms`).
   */
  async pollObject(
    ctx: AdapterContext,
    objectExternalId: string,
    cursor: string | null,
  ): Promise<DiscoverResult> {
    const { pages, error } = await resolveManagedPages(ctx)
    if (error) {
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error }
    }
    const page = resolvePageTokenForExternalId(pages, objectExternalId)
    if (!page) {
      // No managed page at all — nothing we can authorize this call with.
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error: "CONNECTION_LOST" }
    }
    const after = parseCursor(cursor)
    // Newest first: the poller reads one page per poll, and Graph's default
    // chronological order would pin it to a busy post's OLDEST comments.
    const url = `${FB_BASE}/${objectExternalId}/comments?fields=id,message,from,created_time,permalink_url&order=reverse_chronological${after ? `&after=${after}` : ""}`
    const res = await ctx.fetch(url, {
      headers: { Authorization: `Bearer ${page.access_token}` },
    })
    if (res.status === 401) {
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error: "CONNECTION_LOST" }
    }
    // Graph throttles with a 429 or with a 400/403 carrying a rate-limit code.
    if (graphError(res) === "RATE_LIMITED") {
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error: "RATE_LIMITED" }
    }
    const body = parseBody(res.body) as {
      data?: FbComment[]
      paging?: { cursors?: { after?: string } }
    }
    // The Page's own replies are not actionable findings (same skip as
    // `fetchPostComments`).
    const findings: NormalizedFinding[] = (body.data ?? []).filter((c) => c.from?.id !== page.id).map((c) => ({
      platform: "facebook",
      externalId: c.id,
      relation: "comment_on_our_content",
      parentExternalId: objectExternalId,
      authorHandle: c.from?.name ?? null,
      authorExternalId: c.from?.id ?? null,
      contentText: c.message ?? null,
      permalink: c.permalink_url ?? facebookCommentUrl(c.id, objectExternalId),
      occurredAt: c.created_time ?? null,
      commentCount: 0,
      metadata: { siblingsAccessible: true, pageId: page.id },
    }))
    return { findings, nextCursor: body.paging?.cursors?.after ?? null, unitsConsumed: 0 }
  },

  // FB comment reply → Graph API `{comment_id}/comments`. The reply text rides
  // in the `message` body field (never the URL) — injection-safe. The target
  // comment/post id is `<pageId>_<...>` (Graph API convention); resolves the
  // owning Page's token via `/me/accounts` and attaches it as the request's
  // Authorization header — a Page POST authorized with the user token 400s.
  async replyRequest(
    target: { externalId: string },
    text: string,
    ctx?: AdapterContext,
  ): Promise<OutboundRequest> {
    const req: OutboundRequest = {
      url: `${FB_BASE}/${target.externalId}/comments`,
      body: { message: text },
    }
    if (!ctx) return req
    const { pages } = await resolveManagedPages(ctx)
    const page = resolvePageTokenForExternalId(pages, target.externalId)
    if (page) req.headers = { Authorization: `Bearer ${page.access_token}` }
    return req
  },

  // FB DM → Messenger send API `/me/messages`. `tag === human_agent` uses a
  // MESSAGE_TAG send with the HUMAN_AGENT tag (the 7-day window); otherwise a
  // RESPONSE send (within 24h, no tag). Unlike a comment/post id, the
  // recipient id alone doesn't identify the owning Page, so the caller
  // (post-back.ts's `sendDm`) must pass `pageId` — read from the
  // conversation row's `metadata.pageId` (set by `syncDms` above). If
  // `pageId` is missing (a conversation synced before this fix) or unknown,
  // falls back to the first managed page, logging the ambiguity — never
  // silently sends with the wrong (user) token.
  async dmRequest(
    target: { recipientExternalId: string },
    body: string,
    tag: "none" | "human_agent",
    ctx?: AdapterContext,
    pageId?: string | null,
  ): Promise<OutboundRequest> {
    const req: OutboundRequest = {
      url: `${FB_BASE}/me/messages`,
      body: {
        recipient: { id: target.recipientExternalId },
        message: { text: body },
        messaging_type: tag === "human_agent" ? "MESSAGE_TAG" : "RESPONSE",
        ...(tag === "human_agent" ? { tag: "HUMAN_AGENT" } : {}),
      },
    }
    if (!ctx) return req
    const { pages } = await resolveManagedPages(ctx)
    const page = (pageId ? findPage(pages, pageId) : undefined) ?? pages[0]
    if (page) req.headers = { Authorization: `Bearer ${page.access_token}` }
    return req
  },

  // FB own-Page comment like → Graph API `{comment_id}/likes`. Same Page-token
  // resolution as `replyRequest` (comment id carries the `<pageId>_` prefix).
  async likeRequest(
    target: { externalId: string },
    ctx?: AdapterContext,
  ): Promise<OutboundRequest> {
    const req: OutboundRequest = { url: `${FB_BASE}/${target.externalId}/likes`, body: {} }
    if (!ctx) return req
    const { pages } = await resolveManagedPages(ctx)
    const page = resolvePageTokenForExternalId(pages, target.externalId)
    if (page) req.headers = { Authorization: `Bearer ${page.access_token}` }
    return req
  },

  // NOTE: webhook signature verification is HMAC-SHA256, which `node:crypto`
  // would provide — but this adapter is bundled INTO the QuickJS sandbox, which
  // has no `node:crypto` (importing it poisons the whole bundle's evaluation).
  // Verification is therefore done by the host-bridge-backed `verifyMetaSignature`
  // in `../lib/hmac.ts`, called from the manifest `verify` handler. The adapter
  // intentionally does NOT carry a `verifyWebhook` method.

  parseWebhook(body: unknown): { findings: NormalizedFinding[]; messages: NormalizedMessage[] } {
    const findings: NormalizedFinding[] = []
    const messages: NormalizedMessage[] = []
    const payload = body as {
      entry?: Array<{
        id?: unknown
        time?: unknown
        changes?: Array<{ field?: string; value?: Record<string, unknown> }>
        messaging?: Array<Record<string, unknown>>
      }>
    }
    for (const entry of payload.entry ?? []) {
      const ownId = typeof entry.id === "string" ? entry.id : null
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {}
        if (change.field === "feed" && typeof v.comment_id === "string") {
          findings.push({
            platform: "facebook",
            externalId: v.comment_id,
            relation: "comment_on_our_content",
            parentExternalId: typeof v.post_id === "string" ? v.post_id : null,
            contentText: typeof v.message === "string" ? v.message : null,
            authorExternalId: typeof v.from === "object" && v.from ? String((v.from as { id?: string }).id ?? "") : null,
            // Meta's own time for the comment, never the arrival time (a retried
            // or delayed delivery would otherwise date the comment wrongly).
            occurredAt: metaTimeToIso(v.created_time) ?? metaTimeToIso(entry.time),
            commentCount: 0,
            metadata: { siblingsAccessible: true },
          })
        }
      }
      for (const m of entry.messaging ?? []) {
        const sender = (m.sender as { id?: string } | undefined)?.id
        const recipient = (m.recipient as { id?: string } | undefined)?.id
        const msg = m.message as { mid?: string; text?: string; is_echo?: boolean } | undefined
        if (!sender || !msg) continue
        // An echo (a message the Page itself sent, e.g. from the native inbox) has
        // the Page as sender: the other party is then the recipient.
        const outbound = msg.is_echo === true || (ownId !== null && sender === ownId)
        const participant = outbound ? recipient : sender
        if (!participant) continue
        messages.push({
          // No thread id in a delivery: keyed by the participant, which is how the
          // conversation is matched to the polled thread (ingest.ts).
          conversationExternalId: participant,
          participantExternalId: participant,
          ownerExternalId: ownId,
          externalId: msg.mid ?? null,
          direction: outbound ? "outbound" : "inbound",
          body: msg.text ?? null,
          occurredAt: metaTimeToIso(m.timestamp) ?? metaTimeToIso(entry.time),
        })
      }
    }
    return { findings, messages }
  },
}
