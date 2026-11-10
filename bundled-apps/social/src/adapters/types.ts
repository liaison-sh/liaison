// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Platform-adapter interface + normalized shapes. Each platform (YouTube,
// Instagram, Facebook) implements `PlatformAdapter` against its raw payloads,
// normalizing to these shapes so the sync/triage/post-back engine is
// platform-agnostic.

import type { SocialLogger } from "../ctx"

export type Platform = "facebook" | "instagram" | "youtube"

export type FindingRelation =
  | "mention"
  | "mention_in_post"
  | "mention_in_comment"
  | "comment_on_our_content"
  | "keyword_match"
  | "tagged"
  | "reply"

/** A normalized brand-relevant item (comment, mention, keyword hit). */
export interface NormalizedFinding {
  platform: Platform
  externalId: string
  relation: FindingRelation
  parentExternalId?: string | null
  authorHandle?: string | null
  authorExternalId?: string | null
  contentText?: string | null
  permalink?: string | null
  occurredAt?: string | null
  commentCount?: number
  metadata?: Record<string, unknown>
  /** Written by the org's own connected account (the Page itself, the own IG
   *  account or channel): a reply we posted, from Liaison or natively. Never a
   *  finding; it is evidence that the finding it answers was replied to
   *  (ingest.ts `ingestFinding`). */
  authoredByOwner?: boolean
  /** For a reply comment: the comment or post it answers (Meta's `parent_id`). */
  replyToExternalId?: string | null
}

/** What a read of a target's replies found about a reply of ours with a given
 *  text (`PlatformAdapter.findOwnReply`): it is there (with its id), it is not,
 *  or the read could not tell. */
export type OwnReplyLookup =
  | { status: "found"; externalId: string | null }
  | { status: "absent" }
  | { status: "unknown"; reason: string }

export interface NormalizedConversation {
  platform: Platform
  externalId: string
  participantHandle?: string | null
  participantExternalId?: string | null
  participantDisplayName?: string | null
  lastInboundAt?: string | null
  lastMessageAt?: string | null
  /** Platform-specific extras a later post-back call may need (mirrors
   *  `NormalizedFinding.metadata`). Facebook sets `{ pageId }` here so
   *  `send_dm` can resolve the owning Page's access token — the conversation
   *  row has no other way to recover which Page a DM thread belongs to. */
  metadata?: Record<string, unknown>
}

export interface NormalizedMessage {
  conversationExternalId: string
  externalId?: string | null
  direction: "inbound" | "outbound"
  body?: string | null
  occurredAt?: string | null
  /** The other party's platform id (FB PSID / IG IGSID). Set by the webhook
   *  parser, whose delivery carries no thread id: the conversation is found by
   *  this id, the same `participant_external_id` the DM poller stores. */
  participantExternalId?: string | null
  /** The own Page / IG account the delivery was addressed to (`entry.id`). */
  ownerExternalId?: string | null
}

/**
 * A platform-specific outbound request descriptor (URL + JSON body). The
 * post-back layer (post-back.ts) owns idempotency, the DM reply-window
 * recompute, and the gated re-entry; each adapter only knows how to SHAPE the
 * call for its platform — crucially the correct API host (YouTube →
 * googleapis.com, FB/IG → graph.facebook.com). Returning a descriptor (not
 * performing the fetch) keeps the gated DB/idempotency logic centralized and
 * makes the host assertion (§C3 regression) unit-testable.
 */
export interface OutboundRequest {
  url: string
  body: Record<string, unknown>
  /** Extra headers the adapter needs on the outbound POST (e.g.
   *  `Authorization: Bearer <page-token>` for Facebook Page-scoped calls).
   *  `postJson` in post-back.ts merges these over its own default headers —
   *  the host sandbox-fetch bridge does not inject per-connection OAuth
   *  headers on POSTs, so a Page-scoped call needs the token resolved by the
   *  adapter itself and carried here. */
  headers?: Record<string, string>
}

/** A paged discover/poll result. `unitsConsumed` is a deliberate extension
 *  over the spec §4.1 interface so the quota budget (B5) can sum YouTube's
 *  100-unit search / 1-unit comment costs. IG/FB report 0 or a cheap count. */
export interface DiscoverResult {
  findings: NormalizedFinding[]
  nextCursor: string | null
  unitsConsumed: number
  /** Typed failure signal: 401 → CONNECTION_LOST; 429 sets `retryAfter`. */
  error?: "CONNECTION_LOST" | "RATE_LIMITED"
  retryAfter?: number
  /** The provider reported its daily quota as spent (YouTube 403
   *  quotaExceeded / dailyLimitExceeded). Findings gathered before the refusal
   *  are still valid; the caller stops spending until the quota resets. */
  quotaExhausted?: boolean
}

export interface DmSyncResult {
  conversations: NormalizedConversation[]
  messages: NormalizedMessage[]
  nextCursor: string | null
  /** Typed failure signal, mirroring `DiscoverResult`: 401 → CONNECTION_LOST; 429
   *  sets `retryAfter`. On either, `nextCursor` MUST echo the passed-in cursor
   *  unchanged — the caller (`dmSyncJob`) persists `nextCursor` unconditionally,
   *  so an adapter that advanced it on a failed sync would silently skip the
   *  unsynced window on the next tick. */
  error?: "CONNECTION_LOST" | "RATE_LIMITED"
  retryAfter?: number
}

/** Minimal fetch shape the adapters use (provided by ctx). This is the SANDBOX
 *  SDK fetch contract — the bridge returns a plain serialized `{status, headers,
 *  body}` record (body is the raw response STRING), NOT a browser Response.
 *  Writing adapters against `res.json()` compiles (the old type lied) but throws
 *  "not a function" on every live call — the exact bug that made the whole
 *  social app inert on staging while its Response-shaped test mocks stayed green. */
export type AdapterFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Record<string, unknown> },
) => Promise<{
  status: number
  headers?: Record<string, string>
  body: string
}>

/** A monitor term as loaded for discovery — the search text (`value`, with a
 *  leading `@` on `handle`-kind terms already stripped) plus the term's row
 *  id so a match can be attributed back to it. */
export interface DiscoveryTerm {
  id: string
  kind: "keyword" | "handle" | "hashtag"
  value: string
}

export interface AdapterContext {
  accountExternalId: string
  fetch: AdapterFetch
  /** OAuth access token for the platform (resolved by the host). */
  accessToken?: string
  /** Enabled monitor terms scoped to this platform (platform IS NULL or the
   *  adapter's own platform). Only consulted by adapters that support
   *  keyword-search discovery (currently YouTube); absent/empty means "no
   *  terms configured" — the adapter should skip the search rather than
   *  issue an unqueried call. */
  terms?: DiscoveryTerm[]
  /** Optional operator-visible logger (host-provided, same `SocialLogger`
   *  shape as `SocialToolCtx.logger`). Adapters use this to surface
   *  API-behavior anomalies that are otherwise invisible (e.g. a silently
   *  redacted comments read) without failing the call. Optional so adapters
   *  and their tests keep working with no logger wired up. */
  logger?: SocialLogger
  /** Clock for time-windowed searches (YouTube publishedAfter); defaults to now. */
  now?: Date
  /**
   * Changed-only DM sync (D): maps a conversation's `externalId` to the
   * STORED `dm_conversation.last_message_at` watermark (populated by
   * `dmSyncJob` from the existing rows before calling `syncDms`). When a
   * conversation's API-reported `updated_time` is NOT strictly newer than
   * its stored watermark, the adapter skips that conversation's
   * `/messages` fan-out entirely (conversation metadata still upserts —
   * only the messages fetch is skipped). A conversation absent from this
   * map (new, or dmSyncJob didn't supply one) is always fetched. This is
   * what kills the QuickJS sandbox timeout from re-fetching all 20
   * conversations' messages every tick even when nothing changed.
   */
  skipMessagesBefore?: Map<string, string>
}

/** One of the connected account's own recent posts/media, as enumerated for
 *  own-content auto-watch (`listOwnRecentObjects`). */
export interface OwnRecentObject {
  externalId: string
  objectType: "facebook_post" | "instagram_media"
  title?: string | null
  permalink?: string | null
  /** Creation time (ISO); drives the watch's age-decayed cadence. */
  createdAt: string | null
}

export interface OwnRecentObjectsResult {
  objects: OwnRecentObject[]
  error?: "CONNECTION_LOST" | "RATE_LIMITED"
}

export interface PlatformAdapter {
  readonly platform: Platform
  /** Discover new brand-relevant items since `cursor`. */
  discover(ctx: AdapterContext, cursor: string | null): Promise<DiscoverResult>
  /** Poll one watched object for new child activity (comments/replies). */
  pollObject(ctx: AdapterContext, objectExternalId: string, cursor: string | null): Promise<DiscoverResult>
  /**
   * List the connected account's own most recent posts/media (newest first,
   * first page only, at most `limit` per Page/account). Used by the watch
   * poller to auto-watch our own new content; never pages, so it shares no
   * cursor with `discover`. Platforms without own-content watching omit it.
   */
  listOwnRecentObjects?(ctx: AdapterContext, limit: number): Promise<OwnRecentObjectsResult>
  /** Sync DM conversations + messages (Messaging API). */
  syncDms?(ctx: AdapterContext, cursor: string | null): Promise<DmSyncResult>
  /**
   * Shape a comment/finding reply for this platform's API (correct host +
   * body). The post-back layer performs the fetch + idempotency. Optionally
   * async and given `ctx` — Facebook uses this to resolve the owning Page's
   * access token (via `/me/accounts`) and attach it as an `Authorization`
   * header on the returned request, since Page content requires a Page
   * token, not the connected user's token. Platforms with no such
   * distinction (Instagram, YouTube) stay synchronous and ignore `ctx`.
   */
  replyRequest(
    target: { externalId: string },
    text: string,
    ctx?: AdapterContext,
  ): OutboundRequest | Promise<OutboundRequest>
  /**
   * Shape a TOP-LEVEL comment (not a reply to an existing comment) for this
   * platform's API — used when a human wants to comment on a `keyword_match`
   * finding (a VIDEO match with no parent comment to reply to). Currently only
   * YouTube implements this (commentThreads.insert vs. comments.insert for
   * replies); platforms without a distinct top-level-comment API omit it and
   * post-back falls back to `replyRequest` (or `unsupported` if that also
   * doesn't fit the target).
   */
  topLevelCommentRequest?(
    target: { externalId: string },
    text: string,
    ctx?: AdapterContext,
  ): OutboundRequest | Promise<OutboundRequest>
  /**
   * Shape a DM send for this platform's Messaging API. `tag` is the
   * already-computed reply-window tag (`none` | `human_agent`); the adapter
   * encodes the platform's messaging_type/tag fields. Platforms without a DM
   * API (YouTube) do not implement this. `pageId`, when supplied (Facebook,
   * from the conversation row's `metadata.pageId`), lets the adapter resolve
   * that specific Page's access token rather than guessing.
   */
  dmRequest?(
    target: { recipientExternalId: string },
    body: string,
    tag: "none" | "human_agent",
    ctx?: AdapterContext,
    pageId?: string | null,
  ): OutboundRequest | Promise<OutboundRequest>
  /**
   * Shape a like for this platform's API, or `null` when liking the target is
   * unsupported (YouTube has no like-comment-as-channel API).
   */
  likeRequest?(
    target: { externalId: string },
    ctx?: AdapterContext,
  ): OutboundRequest | null | Promise<OutboundRequest | null>
  /**
   * Read the replies on `target` and look for one the org's own account wrote
   * with exactly `text`. Post-back calls it before posting a reply (never post
   * the same public reply twice) and to reconcile a reply whose outcome is
   * unknown (the post timed out on our side). Absent = this platform cannot
   * check, which reads as `unknown`.
   */
  findOwnReply?(target: { externalId: string }, text: string, ctx: AdapterContext): Promise<OwnReplyLookup>
  /** Parse a verified webhook body into normalized findings/messages. */
  parseWebhook?(body: unknown): { findings: NormalizedFinding[]; messages: NormalizedMessage[] }
  /** Verify a webhook signature (HMAC). */
  verifyWebhook?(rawBody: string, signature: string, secret: string): boolean
}
