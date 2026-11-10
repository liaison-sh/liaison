// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Trusted-bundle export surface. Every name the manifest references is
// re-exported here: read/internal/post-back tool handlers, the webhook handler +
// verifier, the scheduled job handlers, and the connection-event handlers.
// B5 wires the webhook fast-ack + job handlers; B6 adds post-back, B7 reads +
// internal mutations, B10 the connection lifecycle.

import { facebookAdapter } from "./adapters/facebook"
import { instagramAdapter } from "./adapters/instagram"
import { youtubeAdapter } from "./adapters/youtube"
import type { Platform, PlatformAdapter } from "./adapters/types"
import { computeSocialAttention } from "./attention"
import { onConnectionDisconnected, onConnectionEstablished, resolveAccessToken } from "./connection"
import { clearMissingToken, noteMissingToken } from "./missing-token"
import { metadataObject } from "./quota"
import type { SocialToolCtx } from "./ctx"
import {
  findConversationRow,
  ingestDmMessages,
  laterIso,
  parseWebhookJob,
  repairDmConversationState,
  resolveAuthorContact,
} from "./ingest"
import {
  addMonitorTerm,
  correctTriage,
  dismissFinding,
  removeMonitorTerm,
  setTriage,
  unwatchObject,
  watchObject,
} from "./internal"
import { type SocialWebhookBridge, verifyMetaSignature } from "./lib/hmac"
import {
  likeItem,
  likeItemPreflight,
  reconcileReplyToFinding,
  replyToFinding,
  replyToFindingPreflight,
  sendDm,
  sendDmPreflight,
} from "./post-back"
import {
  countsRead,
  dmGet,
  dmList,
  findingsGet,
  findingsList,
  monitorTermsList,
  watchedList,
} from "./reads"
import { searchHandler } from "./search"
import { runDiscoverySync, runWatchPoller } from "./sync"

const APP_SECRET_KEY = "socialMetaAppSecret"

const ALL_ADAPTERS: Record<Platform, PlatformAdapter> = {
  facebook: facebookAdapter,
  instagram: instagramAdapter,
  youtube: youtubeAdapter,
}

// The kernel invokes every manifest tool handler as `(params, ctx)` (the QuickJS
// worker / execute-tool calls `exportName(validatedParams, ctx)`). The read
// handlers in reads.ts are already authored `(params, ctx)`, so they re-export
// directly. The post-back (post-back.ts) and internal (internal.ts) handlers are
// authored `(ctx, params)` (unit-tested in that shape), so they are WRAPPED here
// to the kernel's `(params, ctx)` order — mirroring boxtal/handlers.ts. Exporting
// a `(ctx, params)` function directly would silently swap ctx and params at the
// tool boundary (ctx becomes the params object → every db/fetch call throws).

// ── Read tools (B7) — already (params, ctx) ───────────────────────────────────
export { findingsList, findingsGet, dmList, dmGet, watchedList, monitorTermsList, countsRead }

// Settings surface reads: per-connection kernel status and per-platform quota.
export { connectionsStatus as connectionsStatusHandler, quotaStatus as quotaStatusHandler } from "./settings-status"

// ── Internal mutations (B7 — ungated, no external effect) — wrapped to (params, ctx)
export const setTriageHandler = (
  params: Parameters<typeof setTriage>[1],
  ctx: SocialToolCtx,
) => setTriage(ctx, params)
export const correctTriageHandler = (
  params: Parameters<typeof correctTriage>[1],
  ctx: SocialToolCtx,
) => correctTriage(ctx, params)
export const dismissFindingHandler = (
  params: Parameters<typeof dismissFinding>[1],
  ctx: SocialToolCtx,
) => dismissFinding(ctx, params)
export const watchObjectHandler = (
  params: Parameters<typeof watchObject>[1],
  ctx: SocialToolCtx,
) => watchObject(ctx, params)
export const unwatchObjectHandler = (
  params: Parameters<typeof unwatchObject>[1],
  ctx: SocialToolCtx,
) => unwatchObject(ctx, params)
export const monitorTermsAddHandler = (
  params: Parameters<typeof addMonitorTerm>[1],
  ctx: SocialToolCtx,
) => addMonitorTerm(ctx, params)
export const monitorTermsRemoveHandler = (
  params: Parameters<typeof removeMonitorTerm>[1],
  ctx: SocialToolCtx,
) => removeMonitorTerm(ctx, params)

// ── Attention provider (B7) ──────────────────────────────────────────────────
// The sandbox executor invokes EVERY bundle export as `(params, ctx)` — params
// first. The testable impl keeps the kernel-provider shape `(ctx, orgId, userId)`,
// so adapt here rather than re-exporting bare (a bare re-export receives the
// params object where it expects ctx → `ctx.db` undefined on every poll).
// The impl MUST NOT share this export's name: the sandbox loader rewrites the
// ESM export block to `globalThis.<name> = <local>`, which clobbers a same-named
// top-level binding — the adapter then late-binds to ITSELF and recurses.
export const computeSocialAttentionItems = (_params: unknown, ctx: SocialToolCtx) =>
  computeSocialAttention(ctx, ctx.orgId ?? "", "")

// ── Gated-tool approval summarizers ─────────────────────────────────────────
export { summarizeLikeItem, summarizeReplyToFinding, summarizeSendDm } from "./summarizers"

// ── External search handler ──────────────────────────────────────────────────
export { searchHandler }

// ── Webhook upstream probe job (already `(params, ctx)`) ────────────────────
export { probeWebhookUpstreamJob } from "./probe-webhook-upstream"

// ── Webhook setup (gated, approval-backed) — authored (params, ctx) ──────────
export { webhooksSetup as webhooksSetupHandler, webhooksSetupPreflight as webhooksSetupPreflightHandler } from "./webhooks-setup"

// ── Connection lifecycle (B10) ───────────────────────────────────────────────
export { onConnectionEstablished, onConnectionDisconnected }

// ── Gated post-back tools (B6) — wrapped to (params, ctx) ────────────────────
export const replyToFindingHandler = (
  params: Parameters<typeof replyToFinding>[1],
  ctx: SocialToolCtx,
) => replyToFinding(ctx, params)
// STAGE-TIME preflight for the gated reply_to_finding (manifest `preflight`). Runs BEFORE the approval
// gate so an unknown finding_id surfaces a typed `not_found` to the agent at the call site: a gated call
// must not be parked for a human when the data it needs is missing. Wrapped to the kernel's (params, ctx) order.
export const replyToFindingPreflightHandler = (
  params: Parameters<typeof replyToFindingPreflight>[1],
  ctx: SocialToolCtx,
) => replyToFindingPreflight(ctx, params)
// Outcome reconciler of reply_to_finding (manifest `reconcileHandler`): the
// approving reaper calls it when an approved reply's outcome is unknown.
export const reconcileReplyToFindingHandler = (
  params: Parameters<typeof reconcileReplyToFinding>[1],
  ctx: SocialToolCtx,
) => reconcileReplyToFinding(ctx, params)
export const sendDmHandler = (
  params: Parameters<typeof sendDm>[1],
  ctx: SocialToolCtx,
) => sendDm(ctx, params)
// STAGE-TIME preflight for the gated send_dm (manifest `preflight`). Runs BEFORE the approval gate so a
// CLOSED reply window (>7 days since the last inbound, or no inbound on record) surfaces a typed
// `dm_window_closed` error to the agent at the call site — it then honestly tells the user the messaging
// window has closed (native app only) instead of staging a send that can never deliver. An open window
// (standard ≤24h or human-agent ≤7d) passes through to the gate. Wrapped to the kernel's (params, ctx) order.
export const sendDmPreflightHandler = (
  params: Parameters<typeof sendDmPreflight>[1],
  ctx: SocialToolCtx,
) => sendDmPreflight(ctx, params)
export const likeItemHandler = (
  params: Parameters<typeof likeItem>[1],
  ctx: SocialToolCtx,
) => likeItem(ctx, params)
// STAGE-TIME preflight for the gated like_item (manifest `preflight`). Runs BEFORE the approval gate so
// an unsupported target (YouTube channel-likes aren't exposed by the API) surfaces a typed
// `like_unsupported_for_target` error to the agent at the call site — it then proposes gated likes only
// where supported (own-Page FB / own-media IG) and honestly declines the rest, rather than staging a
// pending-approval like that can never succeed. Wrapped to the kernel's (params, ctx) order.
export const likeItemPreflightHandler = (
  params: Parameters<typeof likeItemPreflight>[1],
  ctx: SocialToolCtx,
) => likeItemPreflight(ctx, params)

/**
 * Meta webhook handler. The kernel router runs the manifest `verify` handler
 * (`metaWebhookVerifier`) FIRST and only dispatches here on a valid signature,
 * so this fast-ack does not re-verify. The router hands manifest webhook
 * handlers the PARSED JSON body (it has already rejected a non-JSON body with a
 * 400), so `payload` is Meta's envelope itself (`{ object, entry }`). It
 * enqueues the deferred ingest and returns 200 before any DB write (the ingest
 * happens in the `parse-webhook` job, `parseWebhookJob`, declared on-demand in
 * the manifest: the kernel refuses to enqueue a job it has not registered).
 */
export async function metaWebhook(
  payload: unknown,
  ctx: SocialToolCtx,
): Promise<{ status: number }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { status: 400 }
  // M5: derive the platform from the VERIFIED webhook body, not a default. Meta's
  // shared webhook envelope carries an `object` discriminator — `"instagram"` for
  // IG change notifications, `"page"` for Facebook Page events — so an IG event
  // is no longer mis-parsed as Facebook.
  const platform: Platform = platformFromWebhookBody(payload)
  await ctx.enqueueJob?.("parse-webhook", { platform, body: payload })
  return { status: 200 }
}

/** Meta webhook `object` discriminator → platform (defaults to facebook). */
function platformFromWebhookBody(body: unknown): Platform {
  const obj = (body as { object?: unknown } | null)?.object
  return obj === "instagram" ? "instagram" : "facebook"
}

/**
 * Manifest `verify` handler. The kernel webhook router calls this with the
 * serialized request `{ headers, body, method, query }` and a crypto/config
 * bridge (QuickJS has no `node:crypto`). The App Secret is the kernel-stored
 * `socialMetaAppSecret`; the digest is host-computed (hex) and compared in
 * constant time. Meta sends `X-Hub-Signature-256: sha256=<hex>`.
 */
export async function metaWebhookVerifier(
  params: { headers?: Record<string, string>; body: string },
  bridge: SocialWebhookBridge,
): Promise<{ ok: boolean; reason?: string; replayKey?: string }> {
  const secret = (await bridge.config_get?.(APP_SECRET_KEY)) as string | null
  if (!secret) return { ok: false, reason: "missing_secret" }
  const headers = lowercaseHeaderKeys(params.headers ?? {})
  const signature = headers["x-hub-signature-256"] ?? ""
  if (!signature) return { ok: false, reason: "missing_signature" }
  const ok = await verifyMetaSignature(params.body, signature, secret, bridge)
  if (!ok) return { ok: false, reason: "signature_mismatch" }
  // Meta sends no delivery id, so the body's own HMAC is the delivery identity: the kernel's replay
  // guard then drops a captured signed delivery that is sent again (Meta's own retry of the same
  // payload is deduplicated the same way, which is what the idempotent ingest wants anyway). It is
  // recomputed here rather than taken from the header, which a resender could spell differently
  // (with or without the `sha256=` prefix) to get a fresh key for the same body.
  return { ok: true, replayKey: await bridge.crypto_hmacSha256Hex(secret, params.body) }
}

function lowercaseHeaderKeys(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v
  return out
}

/** `parse-webhook` job — the deferred ingest the fast-ack enqueued. */
export async function parseWebhookHandler(
  payload: { platform: Platform; body: unknown },
  ctx: SocialToolCtx,
): Promise<void> {
  await parseWebhookJob(ctx, payload)
}

interface DiscoverySyncRow {
  platform: Platform
  account_external_id: string
  active?: boolean
}

/** Scheduled discovery sync — run one cycle per active discovery sync_state. */
export async function discoverySyncJob(_payload: unknown, ctx: SocialToolCtx): Promise<void> {
  const states = (await ctx.db.findMany("sync_state", {
    where: { source_type: "discovery", active: true },
  })) as DiscoverySyncRow[]
  for (const s of states) {
    const adapter = ALL_ADAPTERS[s.platform]
    if (!adapter) continue
    // Per-platform isolation: one platform's failure (a bad row, a provider
    // hiccup) must not abort the remaining platforms' cycles — an unguarded
    // throw here once let a single malformed facebook insert block instagram
    // AND youtube discovery for the whole org until it was fixed.
    try {
      await runDiscoverySync(ctx, { adapter, accountExternalId: s.account_external_id })
    } catch (err) {
      ctx.logger?.error?.("social: discovery failed for platform — continuing with others", {
        platform: s.platform,
        accountExternalId: s.account_external_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}

/** Scheduled watch poller. */
export async function watchPollerJob(_payload: unknown, ctx: SocialToolCtx): Promise<void> {
  await runWatchPoller(ctx, { adapters: ALL_ADAPTERS })
}

interface DmSyncRow {
  id: string
  platform: Platform
  account_external_id: string
  cursor: string | null
  active?: boolean
  metadata?: Record<string, unknown> | null
}

/**
 * Scheduled DM sync — pulls conversations AND messages for accounts that
 * support it (IG/FB). Conversations upsert by [platform, external_id]; each
 * `result.messages[]` is landed via `ingestDmMessages` (dedup-upsert +
 * `dm:received` emit for new inbound rows), and the per-account `sync_state`
 * cursor advances to `nextCursor` so the next sync resumes (the pre-fix code
 * dropped messages and never advanced the cursor — §I2).
 */
export async function dmSyncJob(_payload: unknown, ctx: SocialToolCtx): Promise<void> {
  const states = (await ctx.db.findMany("sync_state", {
    where: { source_type: "dm", active: true },
  })) as DmSyncRow[]
  for (const s of states) {
    // Per-account isolation (D): one account's failure (a provider hiccup, a
    // DB deadlock on the conversation upsert path — live-observed on
    // staging as a Postgres 40P01) must not abort the remaining accounts'
    // syncs for the tick, mirroring discoverySyncJob's per-platform
    // try/catch above.
    // Bounded repair of stored conversation state (reply window, status),
    // ahead of the sync and isolated from it: a repair failure must not stop
    // new messages landing.
    try {
      await repairDmConversationState(ctx, s)
    } catch (err) {
      ctx.logger?.warn?.("social: DM state repair step failed, retried next tick", {
        platform: s.platform,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    try {
      await syncOneDmAccount(ctx, s)
      await clearDmSyncDeferrals(ctx, s)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A provider that timed out or dropped the connection is a passing
      // upstream condition, not a bug: nothing was stored and the cursor did
      // not move, so the next scheduled sync simply reads the same window
      // again. Warn with the reason; only an unexpected failure is an error.
      if (isTransientUpstreamFailure(message)) {
        ctx.logger?.warn?.("social: DM sync deferred to the next sync — upstream did not answer", {
          platform: s.platform,
          accountExternalId: s.account_external_id,
          reason: "upstream_unavailable",
          error: message,
        })
        await noteDmSyncDeferral(ctx, s, "upstream_unavailable", message)
        continue
      }
      ctx.logger?.error?.("social: DM sync failed for account — continuing with others", {
        platform: s.platform,
        accountExternalId: s.account_external_id,
        error: message,
      })
    }
  }
}

/**
 * The host's sandbox fetch reports an upstream that never answered in these
 * words: "Fetch timed out after <n>ms", "<host> closed the connection before
 * answering" (a dropped connection after its one retry). The error crosses the
 * sandbox boundary as a message only, so the message is what is matched.
 */
const TRANSIENT_UPSTREAM_PATTERNS = [
  /\bfetch timed out\b/i,
  /closed the connection before answering/i,
  /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b/,
  /socket hang up/i,
]

export function isTransientUpstreamFailure(message: string): boolean {
  return TRANSIENT_UPSTREAM_PATTERNS.some((re) => re.test(message))
}

/** sync_state metadata key counting the account's consecutive deferred DM syncs. */
export const DM_SYNC_DEFERRALS_KEY = "dmSyncDeferrals"

/** This many deferrals in a row means the account has stopped syncing: said once, at error. */
export const DM_SYNC_DEFERRAL_ERROR_THRESHOLD = 6

/**
 * Count one more deferred sync on the account's own row (so the count survives
 * ticks). The streak is said at error exactly once, when it reaches the
 * threshold; the kernel offers the app no way to mark a connection unhealthy,
 * so the error line is the signal.
 */
async function noteDmSyncDeferral(
  ctx: SocialToolCtx,
  s: DmSyncRow,
  reason: string,
  lastError: string,
): Promise<void> {
  try {
    const meta = metadataObject(s.metadata)
    const previous = meta[DM_SYNC_DEFERRALS_KEY]
    const count = (typeof previous === "number" && Number.isFinite(previous) ? previous : 0) + 1
    const metadata = { ...meta, [DM_SYNC_DEFERRALS_KEY]: count }
    await ctx.db.update("sync_state", s.id, { metadata })
    s.metadata = metadata
    if (count === DM_SYNC_DEFERRAL_ERROR_THRESHOLD) {
      ctx.logger?.error?.("social: DM sync deferred repeatedly — the account has not synced", {
        platform: s.platform,
        accountExternalId: s.account_external_id,
        reason,
        consecutiveDeferrals: count,
        error: lastError,
      })
    }
  } catch (err) {
    ctx.logger?.warn?.("social: could not record a deferred DM sync", {
      platform: s.platform,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** A sync landed: forget the deferral streak. */
async function clearDmSyncDeferrals(ctx: SocialToolCtx, s: DmSyncRow): Promise<void> {
  const meta = metadataObject(s.metadata)
  if (!(DM_SYNC_DEFERRALS_KEY in meta)) return
  const { [DM_SYNC_DEFERRALS_KEY]: _dropped, ...rest } = meta
  await ctx.db.update("sync_state", s.id, { metadata: rest })
  s.metadata = rest
}

async function syncOneDmAccount(ctx: SocialToolCtx, s: DmSyncRow): Promise<void> {
  const adapter = ALL_ADAPTERS[s.platform]
  const syncDms = adapter?.syncDms
  if (!syncDms) return
  // Resolve the per-account OAuth token before the Messaging API call: an
  // unauthenticated DM sync 401s and never advances the cursor. No token is an
  // expected state (not connected), said once at info and skipped
  // (missing-token.ts).
  const accessToken = await resolveAccessToken(ctx, s.platform, s.account_external_id)
  if (!accessToken) {
    await noteMissingToken(ctx, s, "social: DM sync skipped, no OAuth access token for account", {
      platform: s.platform,
      accountExternalId: s.account_external_id,
    })
    return
  }
  await clearMissingToken(ctx, s)
  // Changed-only fan-out (D): load the STORED last_message_at watermark for
  // this account's already-known conversations, keyed by external_id, so the
  // adapter can skip the (expensive) per-conversation /messages fetch for
  // threads whose API-reported updated_time hasn't moved past it. This is
  // what previously fetched messages for all ~20 conversations/page every
  // tick regardless of change and timed the QuickJS sandbox out.
  // Newest first: the sync reads the newest conversations, and the bridge caps a
  // read at 1000 rows (an unordered read dropped arbitrary threads past that).
  const existingConvs = (await ctx.db.findMany("dm_conversation", {
    where: { platform: s.platform },
    orderBy: { last_message_at: "desc" },
    limit: 1000,
  })) as Array<{ external_id: string; last_message_at?: string | null }>
  const skipMessagesBefore = new Map<string, string>()
  for (const c of existingConvs) {
    if (c.last_message_at) skipMessagesBefore.set(c.external_id, c.last_message_at)
  }

  const result = await syncDms(
    { accountExternalId: s.account_external_id, fetch: ctx.fetch, accessToken, skipMessagesBefore },
    s.cursor,
  )
  // Typed adapter failure (401/429): log it and leave the account's watermark
  // untouched — advancing cursor/last_synced_at on an errored sync records a
  // FALSE watermark over a window that never landed (the same silent-failure
  // class the discovery "watermark not advanced" fix eliminated in sync.ts).
  if (result.error) {
    // RATE_LIMITED self-resolves on the next tick — warn, not a paged error.
    const logFn =
      result.error === "RATE_LIMITED" ? ctx.logger?.warn?.bind(ctx.logger) : ctx.logger?.error?.bind(ctx.logger)
    logFn?.("social: DM sync failed, watermark not advanced", {
      platform: s.platform,
      accountExternalId: s.account_external_id,
      error: result.error,
    })
    return
  }
  const convByExternalId = new Map<string, { id: string }>()
  for (const c of result.conversations) {
    // Per-conversation isolation (D): one conversation's upsert failure
    // (e.g. a DB deadlock on this specific row) must not lose the rest of
    // the batch — log a warn and continue with the remaining conversations.
    try {
      // By thread id, else by participant: a webhook may have created this
      // person's conversation first (ingest.ts findConversationRow).
      const prior = (await findConversationRow(ctx, c.platform, {
        externalId: c.externalId,
        participantExternalId: c.participantExternalId ?? null,
      })) as {
        id: string
        last_inbound_at?: string | null
        last_message_at?: string | null
        participant_handle?: string | null
        participant_external_id?: string | null
        participant_display_name?: string | null
      } | null
      // An unchanged thread is listed with no messages fetched, so the adapter
      // knows nothing new about it: a sync must never move a stored value back
      // to null or to an older time. (Writing the batch-derived value here reset
      // last_inbound_at to null on every unchanged thread, so every reply window
      // read closed.) The message-derived fields (last inbound, snippet, status)
      // are recomputed from stored messages after the ingest below.
      const row = {
        platform: c.platform,
        external_id: c.externalId,
        participant_handle: c.participantHandle ?? prior?.participant_handle ?? null,
        participant_external_id: c.participantExternalId ?? prior?.participant_external_id ?? null,
        participant_display_name: c.participantDisplayName ?? prior?.participant_display_name ?? null,
        last_inbound_at: laterIso(prior?.last_inbound_at, c.lastInboundAt),
        last_message_at: laterIso(prior?.last_message_at, c.lastMessageAt),
        // Facebook's `{ pageId }` (set by facebook.ts's syncDms) so a later
        // send_dm can resolve the owning Page's access token. The DB column
        // already exists (schema `metadata: json default {}`) and is persisted
        // on both the insert and update path since both share this `row`.
        metadata: c.metadata ?? {},
      }
      if (prior) {
        await ctx.db.update("dm_conversation", prior.id, row)
        convByExternalId.set(c.externalId, { id: prior.id })
      } else {
        // §5/§6: link the participant to a kernel contact on first sight.
        const contactId = await resolveAuthorContact(
          ctx,
          c.participantExternalId ?? c.externalId,
          c.participantHandle ?? c.participantDisplayName ?? undefined,
        )
        const inserted = await ctx.db.insert("dm_conversation", {
          ...row,
          contact_id: contactId,
          status: "open",
        })
        convByExternalId.set(c.externalId, { id: inserted.id })
      }
    } catch (err) {
      ctx.logger?.warn?.("social: DM conversation upsert failed — skipping this conversation", {
        platform: c.platform,
        externalId: c.externalId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  // `ingestDmMessages` (ingest.ts) lands the messages, then recomputes each
  // touched conversation's last inbound time, snippet and status from its
  // stored messages. Messages whose conversation lost its upsert above have
  // no entry in convByExternalId and are skipped, picked up again next tick.
  await ingestDmMessages(ctx, result.messages, convByExternalId)
  // Advance the DM watermark (crash-safe: cursor moves only after the batch lands).
  await ctx.db.update("sync_state", s.id, {
    cursor: result.nextCursor,
    last_synced_at: new Date().toISOString(),
  })
}
