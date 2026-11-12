// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Gated post-back (§4.3 / §4.5 / §7). reply_to_finding / send_dm / like_item are
// always-approve tools that follow the invoicing re-entry pattern:
//   - first entry (ctx.approval unset): file an approval, return pending_approval
//   - re-entry (ctx.approval set): perform the external post EXACTLY ONCE
//
// Idempotency: a target already `handled` makes ZERO external calls (re-entry
// can't double-post, §9 #4). send_dm recomputes the DM reply window AT SEND TIME
// (§9 #2) — a window that closed between draft and approve makes no send, no
// outbound row, and returns a native-app fallback. like_item consults a support
// matrix (own-Page FB comments + own-media IG comments only) and returns
// `unsupported` with no fetch otherwise.
//
// Injection (L5): the request URL is built SOLELY from the target's externalId
// (`${base}/${externalId}/comments`); the reply text rides in the POST body
// field (`message`), never concatenated into the path/query. A body with `../`
// or `?x=1` cannot redirect the call.

import { facebookAdapter } from "./adapters/facebook"
import { instagramAdapter } from "./adapters/instagram"
import type {
  AdapterContext,
  OutboundRequest,
  OwnReplyLookup,
  Platform,
  PlatformAdapter,
} from "./adapters/types"
import { youtubeAdapter } from "./adapters/youtube"
import { resolveAccessToken } from "./connection"
import type { SocialToolCtx } from "./ctx"
import { dmReplyWindow, dmWindowTag } from "./dm-window"
import { refreshConversationState } from "./ingest"
import { pendingFindingApprovals } from "./pending"

/** Per-platform adapters — post-back dispatches on the finding/conversation
 *  platform so a YouTube reply hits googleapis.com, FB/IG hit graph.facebook.com
 *  (§2.3 / §4.1). Hardcoding one host for all platforms was the §C3 bug. */
const ADAPTERS: Record<Platform, PlatformAdapter> = {
  facebook: facebookAdapter,
  instagram: instagramAdapter,
  youtube: youtubeAdapter,
}

export type PostBackStatus =
  | "pending_approval"
  | "completed"
  | "noop"
  | "failed"
  | "window_closed"
  | "unsupported"

interface FindingRow {
  id: string
  platform: Platform
  external_id: string
  relation: string
  status: string
  /** The third party's handle on the finding's own post/comment — approval-card
   *  display only (never used to build the outbound request URL). */
  author_handle?: string | null
  /** The third party's original post/comment text — approval-card display only,
   *  never re-sent (fenced as untrusted content everywhere else it's read). */
  content_text?: string | null
  /** When the original post/comment/finding was observed on-platform (the manifest's
   *  `occurred_at` field) — the most operator-useful date on a reply/like approval card. */
  occurred_at?: string | null
  metadata?: Record<string, unknown> | null
}

interface ConversationRow {
  id: string
  platform: Platform
  external_id: string
  /** The other party's platform-scoped id (PSID / IGSID): the Send API recipient. */
  participant_external_id?: string | null
  last_inbound_at: string | null
  status: string
  /** Platform extras from `NormalizedConversation.metadata` (e.g. Facebook's
   *  `{ pageId }`, set by `syncDms` — see facebook.ts). `sendDm` reads
   *  `metadata?.pageId` to resolve the correct Page access token for a
   *  Facebook DM send. */
  metadata?: Record<string, unknown> | null
  /** The DM participant's handle/display name — approval-card display only. */
  participant_handle?: string | null
  participant_display_name?: string | null
}

/** Truncate a verbatim text line to the approval-card summary_detail line cap
 *  (200 chars, incl. an ellipsis marker when cut). Used for the reply/DM body
 *  text and the third party's original post/comment — never re-encoded, just
 *  clipped for display. */
function clipLine(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Slice an ISO-8601 date/date-time value to `YYYY-MM-DD` for a reviewer-legible approval-card
 *  line — degrades to null on anything malformed/absent (never throws, never shows the reviewer
 *  an "Invalid Date"). */
function dateOnly(v: string | null | undefined): string | null {
  if (!v) return null
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1]! : null
}

function classifyHttp(status: number): "ok" | "gone" | "rate_limited" | "blocked" {
  if (status >= 200 && status < 300) return "ok"
  if (status === 404 || status === 410) return "gone"
  if (status === 429) return "rate_limited"
  return "blocked"
}

/** Format an ISO-8601 date/date-time value as `YYYY-MM-DD HH:MM` (24h, UTC) for a reviewer-
 *  legible DM-window line — time-of-day matters here (the reply window is hours-scoped, not
 *  day-scoped). Degrades to null on anything malformed/absent. */
function dateTime(v: string | null | undefined): string | null {
  if (!v) return null
  const ms = Date.parse(v)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ")
}

/**
 * POST a JSON body through the host fetch. The host (sandbox) fetch bridge sends
 * `init.body` verbatim as the request body, so it MUST be a serialized STRING —
 * an object would be coerced to `"[object Object]"` on the wire. We stringify
 * here and set the content-type, mirroring boxtal's post-back. The body field is
 * the ONLY place the user-controlled text rides (never the URL/path) — injection-safe.
 *
 * `headers` (from the adapter's `OutboundRequest.headers`) are merged OVER the
 * default content-type — this is how a Page-scoped Facebook call carries its
 * `Authorization: Bearer <page-token>` header. The host sandbox-fetch bridge
 * does NOT inject per-connection OAuth headers on POSTs (only sync.ts's GETs
 * build their own `Authorization` header explicitly); without this merge a
 * Page POST would go out with no credentials at all.
 */
async function postJson(
  ctx: SocialToolCtx,
  url: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>,
  timeoutMs?: number,
): Promise<{ status: number; body?: string }> {
  return ctx.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...(timeoutMs ? { timeoutMs } : {}),
  })
}

async function loadFinding(ctx: SocialToolCtx, id: string): Promise<FindingRow | null> {
  const [row] = (await ctx.db.findMany("finding", { where: { id }, limit: 1 })) as FindingRow[]
  return row ?? null
}

async function loadConversation(ctx: SocialToolCtx, id: string): Promise<ConversationRow | null> {
  const [row] = (await ctx.db.findMany("dm_conversation", {
    where: { id },
    limit: 1,
  })) as ConversationRow[]
  return row ?? null
}

interface SyncStateAccountRow {
  account_external_id: string
}

/**
 * Build an `AdapterContext` for an outbound (post-back) call: resolves the
 * platform's connected-account external id from any active `sync_state` row
 * (mirroring sync.ts's `accountIdForPlatform`; post-back has no watch/finding
 * row carrying it) and the corresponding OAuth token via `resolveAccessToken`.
 * Adapters that need an async page-token lookup (Facebook's `replyRequest`/
 * `dmRequest`/`likeRequest`) use this `ctx.accessToken` (the connected USER
 * token) to call `/me/accounts` themselves and resolve the correct PAGE
 * token — see facebook.ts. `accountExternalId` is left blank; the outbound
 * adapters here don't use it (they resolve Page ids from the target's own
 * externalId or explicit `pageId`), only `fetch`/`accessToken` matter.
 */
async function resolveOutboundAdapterContext(
  ctx: SocialToolCtx,
  platform: Platform,
): Promise<AdapterContext> {
  const [state] = (await ctx.db.findMany("sync_state", {
    where: { platform, active: true },
    limit: 1,
  })) as SyncStateAccountRow[]
  const accessToken = state
    ? ((await resolveAccessToken(ctx, platform, state.account_external_id)) ?? undefined)
    : undefined
  return { accountExternalId: state?.account_external_id ?? "", fetch: ctx.fetch, accessToken }
}

/**
 * reply_to_finding STAGE-TIME preflight (manifest `preflight`). Runs BEFORE the approval gate, for the
 * same reason as its send_dm / like_item siblings: a gated call must not be parked for a human when the
 * data it needs is missing. reply_to_finding is `gated:true`, so without this the kernel files a
 * `pending_approval` for a finding_id that matches no finding, and the handler's own `not_found`
 * short-circuit only fires post-approval, far too late for the agent to correct the id. Read-only: one
 * finding lookup, no writes and no outbound post.
 */
export async function replyToFindingPreflight(
  ctx: SocialToolCtx,
  params: { finding_id: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const finding = await loadFinding(ctx, params.finding_id)
  if (!finding) {
    return {
      error: { code: "not_found", message: `No finding found for id ${params.finding_id}.` },
    }
  }
  // One reply request per finding at a time. A second staged reply would be a
  // second public post once both are approved (a reviewer clearing the queue
  // approves both), and after a failed reply it would stack a retry on a retry.
  // The live pending set is the kernel's own (`approvals.pendingFor`), so a
  // denied or expired request frees the finding again.
  const pending = await pendingFindingApprovals(ctx)
  const existing = pending?.get(finding.id)
  if (existing?.action === "reply") {
    return {
      error: {
        code: "reply_already_pending",
        message:
          `A reply to finding ${finding.id} is already awaiting approval (approval ${existing.approval_id}). ` +
          "Edit that request (kernel__approval_update_payload) instead of staging another one.",
      },
    }
  }
  return { ok: true }
}

/** The provider's own error text from a failed post-back response body, clipped:
 *  Graph and YouTube both answer `{ error: { message } }` (YouTube adds
 *  `errors[0].reason`, e.g. `quotaExceeded`). Null when the body says nothing usable. */
function providerError(body: string | undefined): string | null {
  if (!body) return null
  try {
    const err = (JSON.parse(body) as { error?: unknown }).error
    if (err && typeof err === "object") {
      const e = err as { message?: unknown; errors?: Array<{ reason?: unknown }>; code?: unknown }
      const reason = typeof e.errors?.[0]?.reason === "string" ? e.errors[0].reason : null
      const message = typeof e.message === "string" ? e.message : null
      const text = [reason, message].filter(Boolean).join(": ")
      if (text) return clipLine(text, 300)
    }
    if (typeof err === "string" && err) return clipLine(err, 300)
  } catch {
    // not JSON: fall through to the raw text
  }
  const raw = body.trim()
  return raw ? clipLine(raw, 300) : null
}

/**
 * reply_to_finding — gated reply on the finding's target comment/post. The URL
 * is built from the finding's externalId; the reply text is a body field.
 */
export async function replyToFinding(
  ctx: SocialToolCtx,
  params: { finding_id: string; reply_text: string },
): Promise<{
  status: PostBackStatus
  approval_id?: string
  reason?: string
  http_status?: number
  provider_error?: string | null
  reply_external_id?: string | null
  already_posted?: boolean
}> {
  const finding = await loadFinding(ctx, params.finding_id)
  if (!finding) return { status: "failed", reason: "not_found" }
  // Idempotency: never act on an already-handled finding (even on re-entry).
  if (finding.status === "handled") return { status: "noop", reason: "already_handled" }
  if (!ctx.approval) {
    const requested = (await ctx.requestApproval?.({
      tool_name: "social:reply_to_finding",
      summary: `Reply publicly on ${finding.platform}: ${clipLine(params.reply_text)}`,
      summary_detail: {
        subtitle: `Posts publicly on ${finding.platform}`,
        lines: [
          `Platform: ${finding.platform}`,
          `Author: ${finding.author_handle ?? "unknown"}`,
          ...(dateOnly(finding.occurred_at) ? [`Posted: ${dateOnly(finding.occurred_at)}`] : []),
          ...(finding.content_text ? [`Original: ${clipLine(finding.content_text)}`] : []),
          `Reply: ${clipLine(params.reply_text)}`,
        ],
      },
      current_payload: { finding_id: params.finding_id, reply_text: params.reply_text },
    })) ?? { approval_id: "" }
    // Granted inline (`auto_approved`): post now, exactly as on re-entry.
    if (!requested.auto_approved) {
      // Nothing is written on the finding: reads derive "awaiting approval", the
      // draft and the approval id from the pending request itself (pending.ts),
      // exactly as for a call the kernel gate parked before this handler ran. A
      // stored status would stay stuck once the request is denied or expires.
      return { status: "pending_approval", approval_id: requested.approval_id ?? "" }
    }
  }

  // Re-entry: post exactly once, dispatched on the finding's platform so the
  // request hits the correct API host. URL is built only from externalId.
  // The adapter context lets Facebook resolve the owning Page's access token
  // (via `/me/accounts`, using the connected user's token); other adapters
  // ignore the extra `ctx` argument.
  const approvalRequestId = ctx.approval?.approvalRequestId ?? null
  const adapterCtx = await resolveOutboundAdapterContext(ctx, finding.platform)
  const adapter = ADAPTERS[finding.platform]
  const topLevel = finding.relation === "keyword_match"

  // Never post the same public reply twice. Our reply may already be there: an
  // earlier run of this approval whose post timed out on our side but went
  // through, or the same answer posted natively. Look before posting.
  const priorIntent = finding.metadata?.reply_intent as ReplyIntent | undefined
  const retry = approvalRequestId !== null && priorIntent?.approval_request_id === approvalRequestId
  const existing = topLevel
    ? null
    : await lookupOwnReply(adapter, finding, params.reply_text, adapterCtx)
  if (existing?.status === "found") {
    await markReplied(ctx, finding, {
      approvalRequestId,
      replyText: params.reply_text,
      replyExternalId: existing.externalId,
    })
    const ref = {
      provider: finding.platform,
      reply_external_id: existing.externalId,
      already_posted: true,
    }
    if (ctx.approval) {
      await ctx.approval_recordStarted?.(REPLY_TOOL)
      await ctx.approval_recordSucceeded?.(REPLY_TOOL, JSON.stringify(ref))
    }
    ctx.logger?.info?.(
      "social: reply_to_finding found its reply already posted, not posting again",
      {
        findingId: finding.id,
        approvalRequestId,
        retry,
      },
    )
    return { status: "completed", reply_external_id: existing.externalId, already_posted: true }
  }
  // A retry that cannot see whether the earlier post went through must not post
  // again: the outcome stays unknown and the approval waits for its reconciler
  // or a person.
  if (retry && existing?.status !== "absent") {
    await ctx.db.update("finding", finding.id, {
      metadata: {
        ...(finding.metadata ?? {}),
        reply_intent: { ...priorIntent, outcome: "unknown", needs_check: true },
      },
    })
    ctx.logger?.warn?.(
      "social: reply_to_finding retry found an unconfirmed reply, not posting again",
      {
        findingId: finding.id,
        approvalRequestId,
        lookup: existing?.status === "unknown" ? existing.reason : "unsupported",
      },
    )
    await ctx.approval_recordStarted?.(REPLY_TOOL)
    throw new Error(
      "send_outcome_unknown: an earlier attempt of this reply may have been posted and it cannot be checked now",
    )
  }

  // A `keyword_match` finding is a VIDEO match, not a comment — its
  // `external_id` is a video id, so `replyRequest` (which shapes a reply to an
  // existing COMMENT, via `parentId`) would post an invalid/nonsensical
  // request. When the adapter supports it, shape a TOP-LEVEL comment instead
  // (YouTube: commentThreads.insert with `snippet.videoId`). No fallback to
  // `replyRequest` for keyword_match — that would silently misfile the comment
  // as a reply to a nonexistent parent.
  const req =
    topLevel && adapter.topLevelCommentRequest
      ? await adapter.topLevelCommentRequest(
          { externalId: finding.external_id },
          params.reply_text,
          adapterCtx,
        )
      : await adapter.replyRequest(
          { externalId: finding.external_id },
          params.reply_text,
          adapterCtx,
        )
  // The protocol's `started` and the reply intent go down before the POST: a run
  // cut off after it (a timeout, a dead worker) is then known to be unknown,
  // never mistaken for a reply that was not sent.
  if (ctx.approval) await ctx.approval_recordStarted?.(REPLY_TOOL)
  await ctx.db.update("finding", finding.id, {
    metadata: {
      ...(finding.metadata ?? {}),
      reply_intent: {
        approval_request_id: approvalRequestId,
        reply_text: params.reply_text,
        at: new Date().toISOString(),
      },
    },
  })
  const res = await postJson(ctx, req.url, req.body, req.headers, REPLY_POST_TIMEOUT_MS)
  const verdict = classifyHttp(res.status)
  if (verdict !== "ok") {
    // §4.3/§7: a gone (404/410) or blocked parent is a terminal `failed` state
    // (observable), not a silent revert to triaged.
    const failStatus = verdict === "rate_limited" ? "triaged" : "failed"
    // Record WHY on the finding itself: the HTTP status and the provider's own
    // error text outlive the container logs, so a failed reply stays diagnosable.
    // The same detail rides in the result, which the kernel keeps on the approval's
    // execution record.
    const failure = {
      reason: verdict,
      http_status: res.status,
      provider_error: providerError(res.body),
      approval_request_id: approvalRequestId,
      at: new Date().toISOString(),
    }
    // Spreading the metadata read before the intent drops the intent: the
    // platform refused the reply, so a retry may post.
    await ctx.db.update("finding", finding.id, {
      status: failStatus,
      metadata: { ...(finding.metadata ?? {}), last_reply_failure: failure },
    })
    ctx.logger?.warn?.("social: reply_to_finding failed", {
      findingId: finding.id,
      platform: finding.platform,
      ...failure,
    })
    // The platform refused it: nothing was posted. A gone or blocked parent refuses
    // the same reply again, so the approval closes (`final`) instead of waiting to be
    // approved again; a rate limit leaves it pending for a later approval.
    if (ctx.approval) {
      await ctx.approval_recordFailedNoEffect?.(
        REPLY_TOOL,
        JSON.stringify({
          code: `reply_${verdict}`,
          message: `The platform refused the reply (HTTP ${res.status})${failure.provider_error ? `: ${failure.provider_error}` : ""}`,
          ...(verdict === "rate_limited" ? {} : { final: true }),
        }),
      )
    }
    return {
      status: "failed",
      reason: verdict,
      http_status: res.status,
      provider_error: failure.provider_error,
    }
  }
  const replyExternalId = createdId(res.body)
  const ref = { provider: finding.platform, reply_external_id: replyExternalId }
  // Landed first, before any bookkeeping that could still be cut off.
  if (ctx.approval) await ctx.approval_recordEffectLanded?.(REPLY_TOOL, JSON.stringify(ref))
  await markReplied(ctx, finding, {
    approvalRequestId,
    replyText: params.reply_text,
    replyExternalId,
  })
  if (ctx.approval) await ctx.approval_recordSucceeded?.(REPLY_TOOL, JSON.stringify(ref))
  return { status: "completed", reply_external_id: replyExternalId }
}

const REPLY_TOOL = "social:reply_to_finding"

/** The reply POST may wait this long for the platform's answer (a write may ask
 *  the host for up to 30 s; the tool's budget is 30 s). A Graph comment post
 *  that took 11 s used to be cut off at the 10 s default although it went through. */
export const REPLY_POST_TIMEOUT_MS = 20_000

interface ReplyIntent {
  approval_request_id?: string | null
  reply_text?: string | null
  outcome?: string
  [k: string]: unknown
}

/** The id the platform gave a created object (`{ id }` from Graph, YouTube). */
function createdId(body: string | undefined): string | null {
  if (!body) return null
  try {
    const id = (JSON.parse(body) as { id?: unknown }).id
    return typeof id === "string" && id ? id : null
  } catch {
    return null
  }
}

async function lookupOwnReply(
  adapter: PlatformAdapter,
  finding: FindingRow,
  text: string,
  adapterCtx: AdapterContext,
): Promise<OwnReplyLookup | null> {
  if (!adapter.findOwnReply) return null
  try {
    return await adapter.findOwnReply({ externalId: finding.external_id }, text, adapterCtx)
  } catch (err) {
    return {
      status: "unknown",
      reason: err instanceof Error ? err.message.slice(0, 200) : "lookup_failed",
    }
  }
}

/** The finding was answered with this reply: `handled`, with the reply intent
 *  recorded as landed. */
async function markReplied(
  ctx: SocialToolCtx,
  finding: FindingRow,
  reply: { approvalRequestId: string | null; replyText: string; replyExternalId: string | null },
): Promise<void> {
  const metadata = finding.metadata ?? {}
  await ctx.db.update("finding", finding.id, {
    status: "handled",
    metadata: {
      ...metadata,
      reply_intent: {
        ...((metadata.reply_intent as ReplyIntent | undefined) ?? {}),
        approval_request_id: reply.approvalRequestId,
        reply_text: reply.replyText,
        outcome: "landed",
        reply_external_id: reply.replyExternalId,
      },
    },
  })
}

/**
 * reply_to_finding's outcome reconciler (manifest `reconcileHandler`). The
 * approving reaper calls it when an approved reply's outcome is unknown: the
 * POST timed out on our side, or the worker died after it. Read-only.
 *  - executed: the finding records this approval's reply as landed (the
 *    platform's echo of our comment did, ingest.ts `recordOwnReply`), or the
 *    target's replies show ours with this text;
 *  - not_executed: the replies were read and ours is not among them;
 *  - unknown: neither could be established.
 */
export async function reconcileReplyToFinding(
  ctx: SocialToolCtx,
  params: { approval_request_id: string; payload: unknown },
): Promise<{
  outcome: "executed" | "not_executed" | "unknown"
  ref?: Record<string, unknown>
  reason?: string
}> {
  const payload = (params.payload ?? {}) as { finding_id?: unknown; reply_text?: unknown }
  if (typeof payload.finding_id !== "string" || typeof payload.reply_text !== "string") {
    return { outcome: "unknown", reason: "payload_unreadable" }
  }
  const finding = await loadFinding(ctx, payload.finding_id)
  if (!finding) return { outcome: "unknown", reason: "finding_not_found" }
  const intent = finding.metadata?.reply_intent as
    | (ReplyIntent & { reply_external_id?: string | null })
    | undefined
  if (intent?.approval_request_id === params.approval_request_id && intent.outcome === "landed") {
    return {
      outcome: "executed",
      ref: {
        provider: finding.platform,
        reply_external_id: intent.reply_external_id ?? null,
        source: "recorded",
      },
    }
  }
  if (finding.relation === "keyword_match")
    return { outcome: "unknown", reason: "top_level_comment_not_checkable" }
  const adapter = ADAPTERS[finding.platform]
  const adapterCtx = await resolveOutboundAdapterContext(ctx, finding.platform)
  const found = await lookupOwnReply(adapter, finding, payload.reply_text, adapterCtx)
  if (!found) return { outcome: "unknown", reason: "platform_cannot_check" }
  if (found.status === "unknown") return { outcome: "unknown", reason: found.reason }
  if (found.status === "absent") {
    // Not posted: a later approval may post it, so the intent no longer blocks.
    if (intent?.approval_request_id === params.approval_request_id) {
      const { reply_intent: _dropped, ...rest } = finding.metadata ?? {}
      await ctx.db.update("finding", finding.id, { metadata: rest })
    }
    return { outcome: "not_executed", reason: "the reply is not among the target's replies" }
  }
  await markReplied(ctx, finding, {
    approvalRequestId: params.approval_request_id,
    replyText: payload.reply_text,
    replyExternalId: found.externalId,
  })
  return {
    outcome: "executed",
    ref: {
      provider: finding.platform,
      reply_external_id: found.externalId,
      source: "platform_read",
    },
  }
}

/**
 * send_dm — gated DM reply. Recomputes the reply window at SEND TIME: `closed`
 * (or no inbound) ⇒ no API send, no outbound row, native-app fallback. Within
 * the window we tag the send (`none` ≤24h, `human_agent` ≤7d).
 */
export async function sendDm(
  ctx: SocialToolCtx,
  params: { conversation_id: string; body: string },
): Promise<{
  status: PostBackStatus
  approval_id?: string
  sent_via_tag?: string
  reason?: string
}> {
  const convo = await loadConversation(ctx, params.conversation_id)
  if (!convo) return { status: "failed", reason: "not_found" }
  // Idempotent re-entry: an approval whose message already went out sends
  // nothing again. (A `handled` conversation is NOT a reason to refuse: it only
  // means our side had the last word, and a follow-up is a legitimate send.)
  // The outbound row is written as a `pending` send intent BEFORE the POST, so
  // a retry after a POST whose outcome was never recorded (the call threw, or
  // the write after it failed) finds that row: the message may well have gone
  // out, so it is flagged for a person to check and never sent a second time.
  if (ctx.approval?.approvalRequestId) {
    const prior = (await ctx.db.findMany("dm_message", {
      where: { conversation_id: convo.id, approval_request_id: ctx.approval.approvalRequestId },
      limit: 1,
    })) as Array<{
      id: string
      delivery_status?: string | null
      metadata?: Record<string, unknown> | null
    }>
    const row = prior[0]
    if (row && row.delivery_status === "pending") {
      await ctx.db.update("dm_message", row.id, {
        metadata: { ...(row.metadata ?? {}), send_outcome: "unknown", needs_check: true },
      })
      ctx.logger?.warn?.("social: send_dm retry found an unconfirmed send, not sending again", {
        conversationId: convo.id,
        approvalRequestId: ctx.approval.approvalRequestId,
      })
      return { status: "failed", reason: "send_outcome_unknown" }
    }
    if (row) return { status: "noop", reason: "already_sent" }
  }

  if (!ctx.approval) {
    const recipient =
      convo.participant_display_name ?? convo.participant_handle ?? convo.external_id
    const requested = (await ctx.requestApproval?.({
      tool_name: "social:send_dm",
      summary: `Send DM in conversation ${params.conversation_id}: ${clipLine(params.body)}`,
      summary_detail: {
        subtitle: "Sends a direct message",
        lines: [
          `Platform: ${convo.platform}`,
          `Recipient: ${recipient}`,
          ...(dateTime(convo.last_inbound_at)
            ? [`Last message from them: ${dateTime(convo.last_inbound_at)}`]
            : []),
          `Message: ${clipLine(params.body)}`,
        ],
      },
      current_payload: { conversation_id: params.conversation_id, body: params.body },
    })) ?? { approval_id: "" }
    // Granted inline (`auto_approved`): send now, exactly as on re-entry.
    if (!requested.auto_approved) {
      return { status: "pending_approval", approval_id: requested.approval_id ?? "" }
    }
  }

  // Recompute the window AT SEND TIME.
  const tag = dmWindowTag(convo.last_inbound_at)
  if (tag === "closed") {
    return { status: "window_closed", reason: "reply_window_closed" }
  }
  // §4.6: the recorded tag enum is (none · human_agent) — NEVER "standard".
  const sentViaTag: "none" | "human_agent" = tag === "human_agent" ? "human_agent" : "none"
  const adapter = ADAPTERS[convo.platform]
  if (!adapter.dmRequest) return { status: "unsupported", reason: "dm_unsupported_for_platform" }
  // Facebook needs the owning Page's access token, which isn't derivable
  // from the recipient id alone — read it from the conversation's stored
  // `metadata.pageId` (set by facebook.ts's `syncDms`). Missing for a
  // conversation synced before this fix; `dmRequest` falls back to the
  // first managed page in that case (documented there), never the user token.
  const pageId = typeof convo.metadata?.pageId === "string" ? convo.metadata.pageId : null
  const adapterCtx = await resolveOutboundAdapterContext(ctx, convo.platform)
  // The Send API addresses the PERSON, not the thread: a synced conversation's
  // external_id is the Graph conversation id, the participant id is the PSID /
  // IGSID. (A webhook-created conversation is keyed on the sender id itself.)
  const req = await adapter.dmRequest(
    { recipientExternalId: convo.participant_external_id ?? convo.external_id },
    params.body,
    sentViaTag,
    adapterCtx,
    pageId,
  )
  // Send intent first (see the re-entry guard above): if this write fails,
  // nothing has been sent and a retry starts clean.
  const intent = await ctx.db.insert("dm_message", {
    conversation_id: convo.id,
    direction: "outbound",
    body: params.body,
    sent_via_tag: sentViaTag,
    delivery_status: "pending",
    approval_request_id: ctx.approval?.approvalRequestId ?? null,
    occurred_at: new Date().toISOString(),
  })
  const res = await postJson(ctx, req.url, req.body, req.headers)
  const verdict = classifyHttp(res.status)
  if (verdict !== "ok") {
    // The platform refused the message: nothing went out, so the intent goes
    // and a later retry of the same approval may send.
    await ctx.db.delete("dm_message", intent.id)
    return { status: "failed", reason: verdict }
  }
  await ctx.db.update("dm_message", intent.id, { delivery_status: "sent" })
  // Our reply is now the latest message: the conversation reads `handled`.
  await refreshConversationState(ctx, convo.id)
  return { status: "completed", sent_via_tag: sentViaTag }
}

/**
 * send_dm STAGE-TIME preflight (manifest `preflight`). Runs BEFORE the approval gate so the reply
 * window is recomputed at the CALL SITE and the agent learns the window state up front — not after a
 * human approves a doomed send. send_dm is `gated:true`, so without this the kernel files a
 * `pending_approval` for EVERY call (incl. a >7-day CLOSED window) before the handler runs; the
 * handler's own send-time recompute (which returns `window_closed`, no send) only fires post-approval,
 * far too late for the agent to know the window is shut. This preflight returns a typed
 * `dm_window_closed` error for a closed window (no inbound on record, or >7 days since the last inbound),
 * so the agent honestly tells the user the messaging window has closed and the message must go via the
 * native app — instead of staging a send that can never deliver. An OPEN window (standard ≤24h or the
 * extended human-agent ≤7d) passes the preflight; the agent proposes the gated send while surfacing the
 * window state (the human-agent tag is on the conversation's `reply_window` from dm_get/dm_list).
 * (Analogous to like_item's stage-time preflight and boxtal's create_shipment preflight.)
 */
export async function sendDmPreflight(
  ctx: SocialToolCtx,
  params: { conversation_id: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const convo = await loadConversation(ctx, params.conversation_id)
  if (!convo) {
    return {
      error: {
        code: "not_found",
        message: `No conversation found for id ${params.conversation_id}.`,
      },
    }
  }
  const window = dmReplyWindow(convo.last_inbound_at)
  if (!window.canSend) {
    return {
      error: {
        code: "dm_window_closed",
        message:
          `The platform reply window for this conversation is CLOSED. ${window.explanation} ` +
          `No DM send can be staged here; do not propose a send_dm. Tell the user the messaging ` +
          `window has closed and the follow-up must go via the native app or another channel.`,
      },
    }
  }
  return { ok: true }
}

/** Like support matrix: only own-Page FB comments + own-media IG comments. Exported so the
 *  supported-vs-unsupported premise of the like-honesty chaos scenario is regression-tested against
 *  the GENUINE matrix (FB/IG own-content likeable, YouTube unsupported), not a copy. */
export function likeSupported(platform: Platform, relation: string): boolean {
  if (relation !== "comment_on_our_content") return false
  return platform === "facebook" || platform === "instagram"
}

/**
 * like_item STAGE-TIME preflight (manifest `preflight`). Runs BEFORE the approval gate so the
 * supported-vs-unsupported verdict surfaces to the agent at the CALL SITE, not after a human approves
 * a doomed like. Without it, `like_item` is `gated:true` so the kernel files a `pending_approval` for
 * EVERY call (incl. YouTube) before the handler runs — the handler's own `likeSupported` short-circuit
 * (which returns `unsupported`) only fires post-approval, far too late for the agent to know YouTube
 * likes are unsupported. This preflight returns a typed `like_unsupported` error for any target the
 * platform API can't like (YouTube channel-likes aren't exposed; only own-Page FB + own-media IG
 * comments are), so the agent gets the genuine "unsupported on this platform" signal up front, proposes
 * gated likes only where supported, and honestly declines the rest — no phantom approval card for an
 * action that can never succeed. (Analogous to boxtal's create_shipment stage-time preflight.)
 */
export async function likeItemPreflight(
  ctx: SocialToolCtx,
  params: { finding_id: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const finding = await loadFinding(ctx, params.finding_id)
  if (!finding) {
    return {
      error: { code: "not_found", message: `No finding found for id ${params.finding_id}.` },
    }
  }
  if (!likeSupported(finding.platform, finding.relation)) {
    return {
      error: {
        code: "like_unsupported_for_target",
        message:
          `Liking is not supported for this ${finding.platform} item: the platform API does not expose ` +
          `a like action for it (likes work only on own-Page Facebook comments and own-media Instagram ` +
          `comments). No like can be placed here; offer a gated reply as an alternative if engagement is wanted.`,
      },
    }
  }
  return { ok: true }
}

/**
 * like_item — gated like. Returns `unsupported` (no external call) where the
 * platform/relation can't be liked via the API; otherwise posts a like.
 */
export async function likeItem(
  ctx: SocialToolCtx,
  params: { finding_id: string },
): Promise<{ status: PostBackStatus; approval_id?: string; reason?: string }> {
  const finding = await loadFinding(ctx, params.finding_id)
  if (!finding) return { status: "failed", reason: "not_found" }
  if (!likeSupported(finding.platform, finding.relation)) {
    return { status: "unsupported", reason: "like_unsupported_for_target" }
  }
  if (finding.status === "handled") return { status: "noop", reason: "already_handled" }

  if (!ctx.approval) {
    const requested = (await ctx.requestApproval?.({
      tool_name: "social:like_item",
      summary: "Like a post or comment",
      summary_detail: {
        subtitle: `Likes an item on ${finding.platform}`,
        lines: [
          `Platform: ${finding.platform}`,
          `Author: ${finding.author_handle ?? "unknown"}`,
          ...(dateOnly(finding.occurred_at) ? [`Posted: ${dateOnly(finding.occurred_at)}`] : []),
          ...(finding.content_text ? [`Original: ${clipLine(finding.content_text)}`] : []),
        ],
      },
      current_payload: { finding_id: params.finding_id },
    })) ?? { approval_id: "" }
    // Granted inline (`auto_approved`): like now, exactly as on re-entry.
    if (!requested.auto_approved) {
      return { status: "pending_approval", approval_id: requested.approval_id ?? "" }
    }
  }

  const adapter = ADAPTERS[finding.platform]
  const adapterCtx = await resolveOutboundAdapterContext(ctx, finding.platform)
  const req: OutboundRequest | null =
    (await adapter.likeRequest?.({ externalId: finding.external_id }, adapterCtx)) ?? null
  if (!req) return { status: "unsupported", reason: "like_unsupported_for_target" }
  const res = await postJson(ctx, req.url, req.body, req.headers)
  const verdict = classifyHttp(res.status)
  if (verdict !== "ok") return { status: "failed", reason: verdict }
  return { status: "completed" }
}
