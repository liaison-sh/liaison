// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Instagram adapter. `discover` backfills comments on the ACCOUNT'S OWN
// recent media (own-post comments), mirroring the Facebook adapter's own-feed
// discovery — otherwise comments under our own IG posts would never surface
// outside a hand-watched media.
//
// Mentions of the connected account are NOT discovered here (see the
// `discover` doc comment below for why — the `mentioned_media` edge does not
// exist under Instagram Login).

import { packCursor, parseCursor, parseJsonCursor } from "./cursor"
import {
  type GraphError,
  type GraphPage,
  type ListError,
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


// Instagram API with Instagram Login is served from graph.instagram.com (the
// business-login token is scoped to this host), not graph.facebook.com. The
// 2025-01-27 deprecation was Instagram Login's OLD scope names (business_basic,
// business_manage_messages, ...), renamed to instagram_business_*; the
// instagram_basic / instagram_manage_* permissions were not retired: they are
// the permissions of Instagram API with Unified login (graph.facebook.com,
// connection `instagram_unified`, not read through this adapter yet).
const IG_BASE = "https://graph.instagram.com/v26.0"

interface IgOwnMedia {
  id: string
  caption?: string
  permalink?: string
  timestamp?: string
  comments_count?: number
}

interface IgOwnMediaResponse {
  data?: IgOwnMedia[]
  paging?: { cursors?: { after?: string } }
}

interface IgComment {
  id: string
  text?: string
  username?: string
  timestamp?: string
}

interface IgCommentsResponse {
  data?: IgComment[]
}

/** First ~80 code points of a caption (code-point safe, see facebook.ts `postExcerpt`). */
function captionExcerpt(caption: string | undefined): string | null {
  if (!caption) return null
  const points = Array.from(caption.trim())
  if (points.length <= 80) return points.join("")
  return `${points.slice(0, 80).join("").trimEnd()}…`
}

function normalizeOwnComment(mediaId: string, c: IgComment): NormalizedFinding {
  return {
    platform: "instagram",
    externalId: c.id,
    relation: "comment_on_our_content",
    parentExternalId: mediaId,
    authorHandle: c.username ?? null,
    contentText: c.text ?? null,
    occurredAt: c.timestamp ?? null,
    commentCount: 0,
    metadata: { siblingsAccessible: true },
  }
}

/**
 * Fetch comments on one owned media item (modest page size — the discovery
 * pass surfaces recent activity, not a full backfill; a hand-watched
 * watched_object handles deep pagination via pollObject). Errors are
 * swallowed per-media so one bad media doesn't sink the whole discovery page
 * — the media's own comments simply don't surface this cycle. Comments
 * authored by the connected account itself (our own replies to commenters
 * on our own media) are skipped — they aren't actionable findings, mirroring
 * facebook.ts's `fetchPostComments` own-reply skip. The `/comments` edge
 * only returns `username` for the author (no id), so the skip goes through
 * the SAME self-matcher (`isSelf`) used for DM identity — comparing against
 * `accountExternalId` alone would miss it exactly like the DM bug did.
 *
 * `commentsCount` is the media's own `comments_count` from the `/media` page
 * — passed in so the caller can detect Meta's "ineffective grant" redaction
 * signature: `comments_count > 0` but this fetch returns 200 with an EMPTY
 * `data` array (as opposed to a genuine zero-comments media, which never
 * reaches this call — see `discover`'s `comments_count > 0` filter). That
 * signature is indistinguishable from "no comments" at the data level, so
 * the caller is told via `redacted: true` and decides whether/how to warn
 * (once per discover cycle, not once per media).
 */
async function fetchOwnMediaComments(
  ctx: AdapterContext,
  mediaId: string,
  commentsCount: number,
  self: SelfIdentity,
): Promise<{ findings: NormalizedFinding[]; redacted: boolean; rateLimited?: boolean }> {
  const url = `${IG_BASE}/${mediaId}/comments?fields=id,text,username,timestamp&limit=25`
  const res = await ctx.fetch(url, {
    headers: ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {},
  })
  if (graphError(res) === "RATE_LIMITED") return { findings: [], redacted: false, rateLimited: true }
  if (res.status !== 200) return { findings: [], redacted: false }
  const body = (parseBody(res.body)) as IgCommentsResponse
  const data = body.data ?? []
  const redacted = commentsCount > 0 && data.length === 0
  const nonSelfComments = data.filter((c) => !isSelf(self, c.username))
  return { findings: nonSelfComments.map((c) => normalizeOwnComment(mediaId, c)), redacted }
}

interface IgConversationParticipant {
  id: string
  username?: string
}

interface IgConversation {
  id: string
  participants?: { data?: IgConversationParticipant[] }
  updated_time?: string
}

interface IgConversationsResponse {
  data?: IgConversation[]
  paging?: { cursors?: { after?: string } }
}

interface IgDmMessage {
  id: string
  from?: { id?: string; username?: string }
  message?: string
  created_time?: string
}

interface IgDmMessagesResponse {
  data?: IgDmMessage[]
  paging?: { cursors?: { after?: string } }
}

/**
 * Instagram has TWO id spaces for the SAME connected account:
 *  - `ctx.accountExternalId` — the Instagram-Login connection identifier
 *    (what the OAuth flow resolved the connection as).
 *  - the professional-account id `GET /me` returns (e.g. the 17-prefixed
 *    id) — what actually shows up as a `participants`/`from.id` value on
 *    conversation and message payloads.
 * Comparing only against `accountExternalId` (the pre-fix bug) NEVER
 * matches the API's self id, so the self-account itself gets treated as
 * "the other party" on every DM thread, and every one of our own replies
 * gets misclassified as inbound. `SelfIdentity` carries BOTH ids (plus the
 * connected username, which also shows up in `from.username`) so callers
 * can build a matcher that recognizes either id space.
 */
export interface SelfIdentity {
  accountExternalId: string
  meId: string | null
  username: string | null
}

/** True when `idOrUsername` refers to the connected account under ANY known
 *  identity for it (login-scoped id, professional-account id, or username). */
function isSelf(self: SelfIdentity, idOrUsername: string | null | undefined): boolean {
  if (!idOrUsername) return false
  return (
    idOrUsername === self.accountExternalId ||
    (self.meId !== null && idOrUsername === self.meId) ||
    (self.username !== null && idOrUsername === self.username)
  )
}

interface IgMeResponse {
  id?: string
  username?: string
}

/**
 * Resolve the connected account's FULL self identity once per adapter-method
 * invocation via `GET /me?fields=id,username` (the same Instagram-Login host
 * as every other call in this file). The response `id` is the 17-prefixed
 * professional-account id — a DIFFERENT id space from `ctx.accountExternalId`
 * (the login-scoped connection identifier) — which is exactly the id that
 * shows up as `participants[].id` / `from.id` on conversation and message
 * payloads. On 401/429 this surfaces as a typed error so the caller can
 * short-circuit the whole sync the same way a 401/429 on any other endpoint
 * does. On any OTHER failure (network error, malformed body, unexpected
 * status) this degrades gracefully to `accountExternalId`-only matching
 * (`meId`/`username` null) rather than throwing — a self-identity hiccup
 * must never take down the whole DM sync, it just means the self-matcher
 * temporarily can't recognize the professional-account id.
 */
async function resolveSelfIdentity(
  ctx: AdapterContext,
): Promise<{ self: SelfIdentity; error?: "CONNECTION_LOST" | "RATE_LIMITED" }> {
  const fallback: SelfIdentity = { accountExternalId: ctx.accountExternalId, meId: null, username: null }
  try {
    const res = await ctx.fetch(`${IG_BASE}/me?fields=id,username`, {
      headers: ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {},
    })
    const err = graphError(res)
    if (err) return { self: fallback, error: err }
    if (res.status !== 200) return { self: fallback }
    const body = parseBody(res.body) as IgMeResponse
    return {
      self: {
        accountExternalId: ctx.accountExternalId,
        meId: body.id ?? null,
        username: body.username ?? null,
      },
    }
  } catch {
    return { self: fallback }
  }
}

/** The other party on a 1:1 IG DM thread — the participant that is not SELF
 *  under any known identity (see `SelfIdentity`/`isSelf`). */
function nonSelfParticipant(
  conv: IgConversation,
  self: SelfIdentity,
): IgConversationParticipant | undefined {
  return conv.participants?.data?.find((p) => !isSelf(self, p.id) && !isSelf(self, p.username))
}

/**
 * Meta's generic redaction placeholder shows up on Facebook conversations as
 * the literal "Facebook user" string; Instagram Login has not been observed
 * to emit an equivalent placeholder for `username`, but a redacted/absent
 * name is still possible (private/deactivated accounts). Treat any
 * empty/whitespace username the same way facebook.ts treats its placeholder:
 * fall back to the most recent inbound message's `from.username`, never
 * overwriting a real conversation-level username.
 */
function isMissingUsername(name: string | null | undefined): boolean {
  return !name || name.trim().length === 0
}

/** Participant-name fallback (A) — mirrors facebook.ts's `resolveParticipantName`. */
function resolveParticipantName(
  conversationLevelUsername: string | null | undefined,
  participantId: string | undefined,
  self: SelfIdentity,
  messages: IgDmMessage[],
): string | null {
  if (!isMissingUsername(conversationLevelUsername)) return conversationLevelUsername ?? null
  for (const m of messages) {
    // Our own outbound reply (self-authored, under ANY known self identity) —
    // never pick a self-authored message's username as the fallback name.
    if (isSelf(self, m.from?.id) || isSelf(self, m.from?.username)) continue
    if (participantId && m.from?.id && m.from.id !== participantId) continue
    if (!isMissingUsername(m.from?.username)) return m.from!.username!
  }
  return null
}

function normalizeConversation(
  conv: IgConversation,
  self: SelfIdentity,
  messages: IgDmMessage[] = [],
): NormalizedConversation {
  const participant = nonSelfParticipant(conv, self)
  const resolvedName = resolveParticipantName(participant?.username, participant?.id, self, messages)
  return {
    platform: "instagram",
    externalId: conv.id,
    participantHandle: resolvedName,
    participantExternalId: participant?.id ?? null,
    participantDisplayName: resolvedName,
    lastMessageAt: conv.updated_time ?? null,
  }
}

function normalizeDmMessage(
  conversationExternalId: string,
  self: SelfIdentity,
  m: IgDmMessage,
): NormalizedMessage {
  return {
    conversationExternalId,
    externalId: m.id,
    direction: isSelf(self, m.from?.id) || isSelf(self, m.from?.username) ? "outbound" : "inbound",
    body: m.message ?? null,
    occurredAt: m.created_time ?? null,
  }
}

/** Per-page message-fetch size and hard page-count bound (C) — mirrors
 *  facebook.ts's identical constants/rationale (25 * 4 = 100 messages/sync). */
const MESSAGE_PAGE_LIMIT = 25
const MESSAGE_PAGE_BOUND = 4

/**
 * Fetch a conversation's messages newest first, paginating on
 * `paging.cursors.after` up to `MESSAGE_PAGE_BOUND` pages (C), and stopping
 * once a page reaches `sinceMs` (the stored last-message time: everything
 * older already landed). Downstream dedup (`upsertDmMessage`) makes
 * overlapping pages idempotent. A failed page ends the fetch with
 * `ok: false` so the caller does not advance the conversation's last-message
 * mark past messages that never landed; they are fetched again next tick.
 */
async function fetchConversationMessages(
  ctx: AdapterContext,
  conversationId: string,
  sinceMs: number,
): Promise<{ messages: IgDmMessage[]; ok: boolean; rateLimited: boolean }> {
  const out: IgDmMessage[] = []
  let after: string | undefined
  for (let page = 0; page < MESSAGE_PAGE_BOUND; page++) {
    const url = `${IG_BASE}/${conversationId}/messages?fields=id,from,message,created_time&limit=${MESSAGE_PAGE_LIMIT}${after ? `&after=${after}` : ""}`
    const res = await ctx.fetch(url, {
      headers: ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {},
    })
    if (res.status !== 200) return { messages: out, ok: false, rateLimited: graphError(res) === "RATE_LIMITED" }
    const body = parseBody(res.body) as IgDmMessagesResponse
    const data = body.data ?? []
    out.push(...data)
    after = body.paging?.cursors?.after
    if (!after || data.length === 0) break
    const oldest = graphTime(data[data.length - 1]?.created_time)
    if (!Number.isNaN(sinceMs) && !Number.isNaN(oldest) && oldest <= sinceMs) break
  }
  return { messages: out, ok: true, rateLimited: false }
}

/** Head pages (newest first) and history pages read per tick. */
const CONVERSATION_HEAD_PAGES = 3
const CONVERSATION_BACKFILL_PAGES = 1
const CONVERSATION_PAGE_LIMIT = 20
const MEDIA_HEAD_PAGES = 2
const MEDIA_BACKFILL_PAGES = 1
const MEDIA_PAGE_LIMIT = 25
const MEDIA_BACKFILL_LIMIT = 10

/** One page of a Graph list edge for `walkNewestFirst`. */
async function fetchListPage<T>(ctx: AdapterContext, url: string): Promise<GraphPage<T> | { error: ListError }> {
  const res = await ctx.fetch(url, {
    headers: ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {},
  })
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

export const instagramAdapter: PlatformAdapter = {
  platform: "instagram",

  /**
   * Sync DM conversations + messages via Instagram Login's Messaging API
   * (graph.instagram.com — the same host/token as `discover`; see the IG_BASE
   * comment above). Reads `/me/conversations` NEWEST FIRST down to the stored
   * high-water mark, with a bounded history pass for a new connection
   * (graph-paging.ts), then fetches each changed conversation's recent
   * messages down to its stored last-message time. Message pages are not
   * tracked in the cursor: `upsertDmMessage`'s [conversation_id, external_id]
   * dedup makes a re-read idempotent.
   *
   * Changed-only fan-out (D): mirrors facebook.ts — a conversation whose
   * API-reported `updated_time` is NOT strictly newer than its stored
   * watermark (`ctx.skipMessagesBefore`) skips the `/messages` fetch; its
   * conversation metadata still upserts.
   */
  async syncDms(ctx: AdapterContext, cursor: string | null): Promise<DmSyncResult> {
    // Resolve the account's full self identity ONCE per sync — see
    // `resolveSelfIdentity`'s doc comment for why `accountExternalId` alone
    // is the wrong id space to compare against conversation/message payloads.
    const { self, error: selfError } = await resolveSelfIdentity(ctx)
    if (selfError) {
      return { conversations: [], messages: [], nextCursor: cursor, error: selfError }
    }

    // Cursor: `{ conversations: ListState }`. A raw string is a legacy `after`
    // token from the backward walk and reads as "no state, no history owed".
    const stored = parseJsonCursor(cursor) as { conversations?: unknown }
    const walk = await walkNewestFirst<IgConversation>({
      state: readListState(stored.conversations),
      fresh: cursor === null,
      mode: "watermark",
      headPages: CONVERSATION_HEAD_PAGES,
      backfillPages: CONVERSATION_BACKFILL_PAGES,
      timeOf: (c) => graphTime(c.updated_time),
      idOf: (c) => c.id,
      fetchPage: (after) =>
        fetchListPage<IgConversation>(
          ctx,
          `${IG_BASE}/me/conversations?platform=instagram&fields=id,participants,updated_time&limit=${CONVERSATION_PAGE_LIMIT}${after ? `&after=${after}` : ""}`,
        ),
    })
    if ("error" in walk) {
      if (walk.error === "UNAVAILABLE") {
        ctx.logger?.warn?.("social: instagram conversations read failed, skipped this tick", {})
        return { conversations: [], messages: [], nextCursor: cursor }
      }
      return { conversations: [], messages: [], nextCursor: cursor, error: walk.error }
    }

    const conversations: NormalizedConversation[] = []
    const messages: NormalizedMessage[] = []
    let rateLimited = false
    for (const conv of walk.items) {
      const threshold = ctx.skipMessagesBefore?.get(conv.id)
      const changed =
        !threshold || !conv.updated_time || graphTime(conv.updated_time) > graphTime(threshold)
      let rawMessages: IgDmMessage[] = []
      let complete = true
      if (changed) {
        if (rateLimited) {
          complete = false
        } else {
          const fetched = await fetchConversationMessages(ctx, conv.id, graphTime(threshold))
          rawMessages = fetched.messages
          complete = fetched.ok
          rateLimited = fetched.rateLimited
        }
      }
      for (const m of rawMessages) {
        messages.push(normalizeDmMessage(conv.id, self, m))
      }
      const normalized = normalizeConversation(conv, self, rawMessages)
      // Messages that did not land must not be hidden behind an advanced mark.
      if (!complete) normalized.lastMessageAt = null
      conversations.push(normalized)
    }

    return {
      conversations,
      messages,
      nextCursor: packCursor({ conversations: rateLimited ? walk.heldState : walk.state }),
    }
  },

  async discover(ctx: AdapterContext, cursor: string | null): Promise<DiscoverResult> {
    // The compound cursor USED to carry a `mentions` member (see below); old
    // persisted cursors may still have it. Tolerate that shape but never read
    // or write `mentions` again — it's simply dropped on the next pack.
    const cursors = parseJsonCursor(cursor) as { mentions?: string; ownMedia?: unknown }

    // ── Mentions of the connected account are NOT discovered here ────────
    // `GET /{igUserId}/mentioned_media` 400s ("Tried accessing nonexisting
    // field (mentioned_media)") on graph.instagram.com — the edge simply does
    // not exist under Instagram Login. Meta deprecated the legacy
    // Facebook-Login Instagram path (instagram_basic, and with it the
    // Business Discovery mentions edges) on 2025-01-27; there is no
    // Instagram-Login equivalent REST edge to poll. Mention coverage would
    // need the `mentions` webhook subscription instead (push, not pull) —
    // left as documented future work, not engineered around here.
    ctx.logger?.info?.(
      "social: instagram mentions discovery unavailable — mentioned_media has no Instagram Login equivalent; mentions webhook subscription would be required",
      { accountExternalId: ctx.accountExternalId },
    )

    // Resolve self identity ONCE per discover cycle — the own-comment skip
    // below (`fetchOwnMediaComments`) needs it to recognize our own replies
    // by username (the `/comments` edge carries no author id), the same
    // id-space mismatch class as the DM sync bug (see `resolveSelfIdentity`).
    const { self, error: selfError } = await resolveSelfIdentity(ctx)
    if (selfError) {
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error: selfError }
    }

    // ── Comments on the account's own recent media ────────────────────────
    // Mirrors the Facebook adapter's own-feed discovery — without this, IG
    // comments under our own posts never surface unless the media is
    // hand-watched.
    // Newest media first, plus one rotating page of older media per tick
    // (graph-paging.ts "rotating"): new comments land on old posts too.
    const ownMediaState = readListState(cursors.ownMedia)
    const mediaFields = "fields=id,caption,permalink,timestamp,comments_count"
    const walk = await walkNewestFirst<IgOwnMedia>({
      state: ownMediaState,
      fresh: cursor === null,
      mode: "rotating",
      headPages: MEDIA_HEAD_PAGES,
      backfillPages: MEDIA_BACKFILL_PAGES,
      timeOf: (m) => graphTime(m.timestamp),
      idOf: (m) => m.id,
      fetchPage: (after) =>
        fetchListPage<IgOwnMedia>(
          ctx,
          `${IG_BASE}/${ctx.accountExternalId}/media?${mediaFields}&limit=${after ? MEDIA_BACKFILL_LIMIT : MEDIA_PAGE_LIMIT}${after ? `&after=${after}` : ""}`,
        ),
    })
    if ("error" in walk) {
      if (walk.error === "UNAVAILABLE") {
        ctx.logger?.warn?.("social: instagram media read failed, skipped this tick", {})
        return { findings: [], nextCursor: cursor, unitsConsumed: 0 }
      }
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error: walk.error }
    }
    const ownMedia = walk.items.filter((m) => (m.comments_count ?? 0) > 0)

    const seenExternalIds = new Set<string>()
    const ownCommentFindings: NormalizedFinding[] = []
    // The redaction warning fires at most once per discover cycle — one flag
    // shared across every media in this pass, not one log line per media.
    let redactionWarned = false
    let rateLimited = false
    for (const media of ownMedia) {
      const { findings: comments, redacted, rateLimited: limited } = await fetchOwnMediaComments(
        ctx,
        media.id,
        media.comments_count ?? 0,
        self,
      )
      if (limited) {
        rateLimited = true
        break
      }
      if (redacted && !redactionWarned) {
        redactionWarned = true
        ctx.logger?.warn?.(
          "social: instagram comments read returned empty despite nonzero comments_count — the instagram_business_manage_comments grant is likely ineffective; re-authorize the instagram connection",
          { mediaId: media.id, commentsCount: media.comments_count ?? 0 },
        )
      }
      for (const f of comments) {
        // Dedup across own-media batches by externalId.
        if (seenExternalIds.has(f.externalId)) continue
        seenExternalIds.add(f.externalId)
        ownCommentFindings.push(f)
      }
    }

    return {
      findings: ownCommentFindings,
      nextCursor: packCursor({ ownMedia: rateLimited ? walk.heldState : walk.state }),
      unitsConsumed: 0,
    }
  },

  /**
   * Own-content auto-watch enumeration: the account's newest `limit` media
   * (`/{igUserId}/media`, first page only). Never pages and never touches
   * the `discover` cursor.
   */
  async listOwnRecentObjects(ctx: AdapterContext, limit: number): Promise<OwnRecentObjectsResult> {
    const url = `${IG_BASE}/${ctx.accountExternalId}/media?fields=id,caption,permalink,timestamp&limit=${limit}`
    const res = await ctx.fetch(url, {
      headers: ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {},
    })
    if (res.status === 401) return { objects: [], error: "CONNECTION_LOST" }
    const body = parseBody(res.body) as IgOwnMediaResponse & { error?: { code?: number } }
    if (graphError(res) === "RATE_LIMITED") return { objects: [], error: "RATE_LIMITED" }
    if (res.status !== 200) {
      ctx.logger?.warn?.("social: instagram own media read failed, skipped this tick", {
        status: res.status,
        code: body.error?.code,
      })
      return { objects: [] }
    }
    return {
      objects: (body.data ?? []).map((m) => ({
        externalId: m.id,
        objectType: "instagram_media" as const,
        title: captionExcerpt(m.caption),
        permalink: m.permalink ?? null,
        createdAt: m.timestamp ?? null,
      })),
    }
  },

  async pollObject(
    ctx: AdapterContext,
    objectExternalId: string,
    cursor: string | null,
  ): Promise<DiscoverResult> {
    const after = parseCursor(cursor)
    const url = `${IG_BASE}/${objectExternalId}/comments?fields=id,text,username,timestamp${after ? `&after=${after}` : ""}`
    const res = await ctx.fetch(url, {
      headers: ctx.accessToken ? { Authorization: `Bearer ${ctx.accessToken}` } : {},
    })
    if (res.status === 401) {
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error: "CONNECTION_LOST" }
    }
    // Graph throttles with a 429 or with a 400/403 carrying a rate-limit code.
    if (graphError(res) === "RATE_LIMITED") {
      return { findings: [], nextCursor: cursor, unitsConsumed: 0, error: "RATE_LIMITED" }
    }
    const body = (parseBody(res.body)) as {
      data?: Array<{ id: string; text?: string; username?: string; timestamp?: string }>
      paging?: { cursors?: { after?: string } }
    }
    let data = body.data ?? []
    if (data.length > 0) {
      // Our own replies are not actionable findings (same skip as
      // `fetchOwnMediaComments`); the edge only carries the username, so
      // resolve self identity, and only when there is something to filter.
      const { self } = await resolveSelfIdentity(ctx)
      data = data.filter((c) => !isSelf(self, c.username))
    }
    const findings: NormalizedFinding[] = data.map((c) => ({
      platform: "instagram",
      externalId: c.id,
      relation: "comment_on_our_content",
      parentExternalId: objectExternalId,
      authorHandle: c.username ?? null,
      contentText: c.text ?? null,
      occurredAt: c.timestamp ?? null,
      commentCount: 0,
      metadata: { siblingsAccessible: true },
    }))
    return { findings, nextCursor: body.paging?.cursors?.after ?? null, unitsConsumed: 0 }
  },

  // IG comment reply → Graph API `{ig_comment_id}/replies`. (IG shares the
  // graph.facebook.com host with FB but uses the `/replies` edge for comments.)
  // The reply text rides in the `message` body field — injection-safe.
  replyRequest(target: { externalId: string }, text: string): OutboundRequest {
    return { url: `${IG_BASE}/${target.externalId}/replies`, body: { message: text } }
  },

  // IG DM → Messaging API `/me/messages` (same envelope as Messenger). The
  // HUMAN_AGENT tag legitimizes the 7-day window send (§4.3).
  dmRequest(
    target: { recipientExternalId: string },
    body: string,
    tag: "none" | "human_agent",
  ): OutboundRequest {
    return {
      url: `${IG_BASE}/me/messages`,
      body: {
        recipient: { id: target.recipientExternalId },
        message: { text: body },
        messaging_type: tag === "human_agent" ? "MESSAGE_TAG" : "RESPONSE",
        ...(tag === "human_agent" ? { tag: "HUMAN_AGENT" } : {}),
      },
    }
  },

  // IG own-media comment like → Graph API `{comment_id}/likes`.
  likeRequest(target: { externalId: string }): OutboundRequest {
    return { url: `${IG_BASE}/${target.externalId}/likes`, body: {} }
  },
}
