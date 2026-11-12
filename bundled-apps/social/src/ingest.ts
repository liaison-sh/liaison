// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Finding ingest (§4.2). Both the webhook fast-ack parse job and the poller
// land here. `upsertFinding` dedups on [platform, external_id] (the same key
// the `finding` table's UNIQUE constraint enforces) so a webhook + a poll of the
// same item collapse to one row, and an edit updates the row's content.
// `emitFindingCreated` publishes the declared `finding:created` event, which
// drives the Component-A event-triage routine (Task A7). `parseWebhookJob` is
// the deferred work the webhook handler enqueues after its fast-ack 200.

import { facebookAdapter, sameReplyText } from "./adapters/facebook"
import type { NormalizedFinding, NormalizedMessage, Platform } from "./adapters/types"
import type { SocialToolCtx } from "./ctx"
import { livePagesOnly, META_PAGE_IDS_KEY } from "./meta-pages"

/** Adapters that can parse a verified webhook body. */
const WEBHOOK_PARSERS: Partial<
  Record<
    Platform,
    (body: unknown) => { findings: NormalizedFinding[]; messages: NormalizedMessage[] }
  >
> = {
  facebook: (body) => facebookAdapter.parseWebhook?.(body) ?? { findings: [], messages: [] },
  // IG webhook change-notifications share Meta's envelope; reuse the FB parser
  // shape for comment events (the relation is overridden to the IG platform).
  instagram: (body) => {
    const parsed = facebookAdapter.parseWebhook?.(body) ?? { findings: [], messages: [] }
    return {
      findings: parsed.findings.map((f) => ({ ...f, platform: "instagram" as Platform })),
      messages: parsed.messages,
    }
  },
}

/** A normalized finding ready to upsert (camelCase normalized shape). */
export interface FindingUpsert {
  platform: Platform
  externalId: string
  relation: NormalizedFinding["relation"]
  parentExternalId?: string | null
  authorHandle?: string | null
  authorExternalId?: string | null
  contentText?: string | null
  permalink?: string | null
  occurredAt?: string | null
  commentCount?: number
  brandRelevant?: boolean
  watchedObjectId?: string | null
  metadata?: Record<string, unknown>
  /** Written by the org's own account (see `NormalizedFinding.authoredByOwner`). */
  authoredByOwner?: boolean
  /** For a reply comment: the comment or post it answers. */
  replyToExternalId?: string | null
}

export type UpsertResult =
  | { id: string; created: true }
  /** `id` is null for one of our own replies, which is never stored as a finding
   *  (`ownReply` then names the finding it answered, if one is stored). */
  | { id: string | null; created: false; ownReply?: { repliedFindingId: string | null } }

function toRow(f: FindingUpsert): Record<string, unknown> {
  return {
    platform: f.platform,
    external_id: f.externalId,
    relation: f.relation,
    parent_external_id: f.parentExternalId ?? null,
    author_handle: f.authorHandle ?? null,
    author_external_id: f.authorExternalId ?? null,
    content_text: f.contentText ?? null,
    permalink: f.permalink ?? null,
    occurred_at: f.occurredAt ?? null,
    comment_count: f.commentCount ?? 0,
    brand_relevant: f.brandRelevant ?? false,
    watched_object_id: f.watchedObjectId ?? null,
    metadata: f.metadata ?? {},
  }
}

interface ExistingFindingRow {
  id: string
  status: string
  content_text?: string | null
  permalink?: string | null
  metadata?: unknown
  watched_object_id?: string | null
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/**
 * Resolve-or-create a kernel contact for an external author/participant and
 * return its id (or null). Best-effort: a resolution failure (or an app build
 * without the bridge) must never block ingest — the finding/conversation
 * simply lands with a null contact_id.
 */
export async function resolveAuthorContact(
  ctx: SocialToolCtx,
  externalId: string,
  name?: string,
): Promise<string | null> {
  if (!ctx.resolveContact) return null
  try {
    const resolved = await ctx.resolveContact({ externalId, name })
    return resolved?.id ?? null
  } catch {
    return null
  }
}

/**
 * Upsert a finding keyed on [platform, external_id]. The generic-CRUD bridge has
 * no native ON CONFLICT, so we read-then-write under the dedup key: if a row
 * already exists we UPDATE the mutable content columns (content_text, permalink,
 * comment_count, occurred_at, metadata) — leaving triage/status untouched — and
 * report `created:false`; otherwise we INSERT with the default `status:'new'`.
 *
 * Edited-after-reply (§8): when the upsert changes `content_text` on a finding a
 * human already `handled`, set `edited_after_reply` and emit `finding:updated`
 * so the surface can flag it.
 *
 * Race (M1): a true webhook+poll race could have both readers see "absent" and
 * both INSERT. The `finding` UNIQUE [platform, external_id] makes the second
 * INSERT throw; we catch that, re-read the now-present row, and report
 * `created:false` instead of propagating (which would abort the whole batch /
 * the poller watermark advance).
 */
export async function upsertFinding(ctx: SocialToolCtx, f: FindingUpsert): Promise<UpsertResult> {
  // One of our own replies, echoed back by the platform or read by a poll: it
  // is never a finding, only evidence that we answered.
  if (await isOwnAuthored(ctx, f)) {
    return { id: null, created: false, ownReply: await recordOwnReply(ctx, f) }
  }
  const found = await ctx.db.findMany("finding", {
    where: { platform: f.platform, external_id: f.externalId },
    limit: 1,
  })
  const existing = found[0] as ExistingFindingRow | undefined
  const row = toRow(f)
  if (existing) {
    return updateExisting(ctx, existing, row)
  }
  // §5/§6: resolve-or-create a kernel contact for the author and link it so a
  // contact's social history is joinable (best-effort — never block ingest on
  // a contact-resolution failure).
  if (f.authorExternalId && row.contact_id == null) {
    row.contact_id = await resolveAuthorContact(
      ctx,
      f.authorExternalId,
      f.authorHandle ?? undefined,
    )
  }
  try {
    const inserted = await ctx.db.insert("finding", { ...row, status: "new" })
    return { id: inserted.id, created: true }
  } catch (err) {
    // Lost the insert race (UNIQUE violation) — re-read and update instead.
    const reread = (await ctx.db.findMany("finding", {
      where: { platform: f.platform, external_id: f.externalId },
      limit: 1,
    })) as ExistingFindingRow[]
    if (reread[0]) return updateExisting(ctx, reread[0], row)
    throw err // a different error — propagate
  }
}

async function updateExisting(
  ctx: SocialToolCtx,
  existing: ExistingFindingRow,
  row: Record<string, unknown>,
): Promise<UpsertResult> {
  const newContent = row.content_text as string | null
  const contentChanged = newContent != null && newContent !== (existing.content_text ?? null)
  const patch: Record<string, unknown> = {
    content_text: row.content_text,
    // A source that does not know the link (a webhook delivery) never erases
    // the one a poll stored, and a poll's post context (postExcerpt,
    // postPermalink) survives a later delivery that carries less.
    permalink: row.permalink ?? existing.permalink ?? null,
    comment_count: row.comment_count,
    occurred_at: row.occurred_at,
    metadata: { ...asRecord(existing.metadata), ...asRecord(row.metadata) },
  }
  // Backfill-link a watched_object_id but never clobber an existing link with null.
  if (row.watched_object_id != null && existing.watched_object_id == null) {
    patch.watched_object_id = row.watched_object_id
  }
  // Edited-after-reply (§8): flag + emit only when content actually changed on a
  // finding a human already handled.
  const editedAfterReply = contentChanged && existing.status === "handled"
  if (editedAfterReply) patch.edited_after_reply = true
  await ctx.db.update("finding", existing.id, patch)
  if (contentChanged) {
    await ctx.emit?.({ entity: "finding", action: "updated", entityId: existing.id })
  }
  return { id: existing.id, created: false }
}

/** Statuses of a finding that still waits for an answer from us. */
const OPEN_FINDING_STATUSES = new Set(["new", "triaged", "drafted", "awaiting_approval", "failed"])

/** The ids the org's own accounts on `platform` are known by: the connected
 *  account of each `sync_state` row and, for Facebook, the Page ids it routes. */
async function ownAccountIds(
  ctx: SocialToolCtx,
  platform: FindingUpsert["platform"],
): Promise<Set<string>> {
  // Read once per invocation (a sync batch checks every finding it lands).
  let perCtx = OWN_IDS_CACHE.get(ctx)
  if (!perCtx) {
    perCtx = new Map()
    OWN_IDS_CACHE.set(ctx, perCtx)
  }
  let ids = perCtx.get(platform)
  if (!ids) {
    ids = readOwnAccountIds(ctx, platform)
    perCtx.set(platform, ids)
  }
  return ids
}

const OWN_IDS_CACHE = new WeakMap<object, Map<string, Promise<Set<string>>>>()

async function readOwnAccountIds(
  ctx: SocialToolCtx,
  platform: FindingUpsert["platform"],
): Promise<Set<string>> {
  const rows = (await ctx.db.findMany("sync_state", { where: { platform } })) as Array<{
    account_external_id?: string | null
    metadata?: unknown
  }>
  const ids = new Set<string>()
  for (const r of rows) {
    if (r.account_external_id) ids.add(r.account_external_id)
    const pageIds = asRecord(r.metadata)[META_PAGE_IDS_KEY]
    if (Array.isArray(pageIds)) for (const id of pageIds) if (typeof id === "string") ids.add(id)
  }
  return ids
}

/**
 * True when the item was written by the org's own account. The adapter says so
 * when its source names the owner (a webhook delivery's `entry.id`); otherwise
 * the author is checked against the connected accounts, and, for a comment on a
 * Facebook post of ours, against the Page whose id prefixes the post id.
 */
export async function isOwnAuthored(ctx: SocialToolCtx, f: FindingUpsert): Promise<boolean> {
  if (f.authoredByOwner === true) return true
  const author = f.authorExternalId
  if (!author) return false
  if (
    f.platform === "facebook" &&
    f.relation === "comment_on_our_content" &&
    f.parentExternalId &&
    f.parentExternalId.indexOf("_") > 0 &&
    f.parentExternalId.slice(0, f.parentExternalId.indexOf("_")) === author
  ) {
    return true
  }
  return (await ownAccountIds(ctx, f.platform)).has(author)
}

interface ReplyIntent {
  approval_request_id?: string | null
  reply_text?: string | null
  outcome?: string
  reply_external_id?: string | null
  [k: string]: unknown
}

/**
 * Land one of our own replies as evidence, never as a finding:
 *  - a finding row stored for it before this rule existed is dismissed;
 *  - the finding it answers (`replyToExternalId`), when still open, is marked
 *    `handled` with the reply recorded in `metadata.own_reply`;
 *  - a reply intent of a gated `reply_to_finding` on that finding with the same
 *    text is marked landed: the post went through even if its call timed out,
 *    which is what the approval's reconciler reads (post-back.ts).
 */
export async function recordOwnReply(
  ctx: SocialToolCtx,
  f: FindingUpsert,
): Promise<{ repliedFindingId: string | null }> {
  const [stale] = (await ctx.db.findMany("finding", {
    where: { platform: f.platform, external_id: f.externalId },
    limit: 1,
  })) as Array<{ id: string; status: string; metadata?: unknown }>
  if (stale && stale.status !== "dismissed") {
    await ctx.db.update("finding", stale.id, {
      status: "dismissed",
      metadata: { ...asRecord(stale.metadata), own_reply: true },
    })
    await ctx.emit?.({ entity: "finding", action: "updated", entityId: stale.id })
  }
  if (!f.replyToExternalId) return { repliedFindingId: null }
  const [target] = (await ctx.db.findMany("finding", {
    where: { platform: f.platform, external_id: f.replyToExternalId },
    limit: 1,
  })) as Array<{ id: string; status: string; metadata?: unknown }>
  if (!target) return { repliedFindingId: null }
  const metadata = asRecord(target.metadata)
  const intent = asRecord(metadata.reply_intent) as ReplyIntent
  const intentLanded =
    metadata.reply_intent !== undefined &&
    intent.outcome !== "landed" &&
    sameReplyText(intent.reply_text, f.contentText)
  const open = OPEN_FINDING_STATUSES.has(target.status)
  if (!open && !intentLanded) return { repliedFindingId: target.id }
  const patch: Record<string, unknown> = {
    metadata: {
      ...metadata,
      own_reply: { external_id: f.externalId, at: f.occurredAt ?? new Date().toISOString() },
      ...(intentLanded
        ? { reply_intent: { ...intent, outcome: "landed", reply_external_id: f.externalId } }
        : {}),
    },
  }
  if (open) patch.status = "handled"
  await ctx.db.update("finding", target.id, patch)
  await ctx.emit?.({ entity: "finding", action: "updated", entityId: target.id })
  ctx.logger?.info?.("social: own reply recorded on the finding it answers", {
    findingId: target.id,
    replyExternalId: f.externalId,
    intentLanded,
  })
  return { repliedFindingId: target.id }
}

/** Publish `social:finding:created` so the event-triage routine (A7) fires. */
export async function emitFindingCreated(ctx: SocialToolCtx, findingId: string): Promise<void> {
  await ctx.emit?.({ entity: "finding", action: "created", entityId: findingId })
}

interface ConvRow {
  id: string
  last_inbound_at?: string | null
}

/**
 * Dedup-upsert one inbound/outbound DM message into `dm_message`, keyed on
 * `[conversation_id, external_id]` (the table's UNIQUE constraint). Returns
 * whether a NEW inbound row was created (so the caller can emit `dm:received`
 * and refresh the conversation's last_inbound_at). §1 #6 / §4.1: inbound
 * messages must land so the Messages thread is readable — the pre-fix code
 * dropped `result.messages` entirely.
 */
export async function upsertDmMessage(
  ctx: SocialToolCtx,
  conversationId: string,
  m: NormalizedMessage,
): Promise<{ created: boolean; inbound: boolean; changed?: boolean }> {
  const inbound = m.direction === "inbound"
  if (m.externalId) {
    const existing = (await ctx.db.findMany("dm_message", {
      where: { conversation_id: conversationId, external_id: m.externalId },
      limit: 1,
    })) as Array<{ id: string; direction?: string }>
    if (existing[0]) {
      // Repair-on-resync: a re-fetched message whose classification CHANGED
      // (the IG self-identity bug mislabelled our own replies as inbound)
      // updates the stored direction instead of being frozen by dedup — a
      // corrupted row would otherwise stay wrong forever.
      if (existing[0].direction !== m.direction) {
        await ctx.db.update("dm_message", existing[0].id, { direction: m.direction })
        return { created: false, inbound, changed: true }
      }
      return { created: false, inbound }
    }
  }
  try {
    await ctx.db.insert("dm_message", {
      conversation_id: conversationId,
      external_id: m.externalId ?? null,
      direction: m.direction,
      // Graph API omits `message` on attachment/sticker-only messages (empty
      // string, not absent) — stored as-is (null-coalesced), NOT collapsed to
      // "no content" here; `dmSnippet`/the UI's thread rendering are what
      // decide how an empty body READS (§B: "[attachment]", not a blank bubble
      // or "No message yet" on a thread that has real content).
      body: m.body ?? null,
      occurred_at: m.occurredAt ?? new Date().toISOString(),
      delivery_status: inbound ? "received" : "sent",
    })
  } catch (err) {
    // Two parses of the same delivery (a Meta redelivery, or the webhook and
    // the poller) both saw no row: the one that lost the unique-key race has
    // nothing left to write.
    if (m.externalId && isUniqueViolation(err)) {
      const reread = await ctx.db.findMany("dm_message", {
        where: { conversation_id: conversationId, external_id: m.externalId },
        limit: 1,
      })
      if (reread[0]) return { created: false, inbound }
    }
    throw err
  }
  return { created: true, inbound }
}

/**
 * Snippet honesty (B): a message that genuinely has no body (Graph API omits
 * `message` on attachment/sticker-only messages — an EMPTY string, not an
 * absent one) must not read as "no content" in the conversation-list
 * preview. `last_message_snippet` becomes the literal `[attachment]` marker
 * for a real message with an empty body; `null` is reserved for "no message
 * landed at all" (the list UI's own fallback text, e.g. "No message yet",
 * stays scoped to that case). A genuinely present, non-empty body is
 * truncated to 120 chars as before.
 */
export function dmSnippet(body: string | null | undefined): string | null {
  if (body == null) return null
  if (body.length === 0) return "[attachment]"
  return body.slice(0, 120)
}

/**
 * Land a batch of DM messages against their conversations: dedup-upsert each,
 * emit `dm:received` for each NEW inbound row, then recompute each touched
 * conversation's derived state from its stored messages
 * (`refreshConversationState`). `convByExternalId` maps the message's
 * `conversationExternalId` to the persisted conversation row id.
 */
export async function ingestDmMessages(
  ctx: SocialToolCtx,
  messages: NormalizedMessage[],
  convByExternalId: Map<string, ConvRow>,
): Promise<{ ingested: number }> {
  let ingested = 0
  const touched = new Set<string>()
  // Conversations that received a genuinely NEW inbound message in this batch:
  // only those may be reopened. A duplicate (Meta redelivery, webhook and
  // poller racing) or a re-fetched old message is not news.
  const newInbound = new Set<string>()
  for (const m of messages) {
    const conv = convByExternalId.get(m.conversationExternalId)
    if (!conv) continue
    const res = await upsertDmMessage(ctx, conv.id, m)
    // Every conversation the batch names is refreshed, a duplicate included:
    // a second delivery of the same message (Meta retries, or a webhook and
    // the poller racing) can finish before the run that inserted it has
    // written the conversation's state, and the refresh is idempotent.
    touched.add(conv.id)
    if (!res.created) continue
    ingested += 1
    if (res.inbound) {
      newInbound.add(conv.id)
      await ctx.emit?.({ entity: "dm", action: "received", entityId: conv.id })
    }
  }
  // Once per conversation, after the whole batch: a batch arrives newest
  // first, so a per-message write would leave the OLDEST message as the
  // conversation's last inbound time and snippet.
  for (const id of touched) await refreshConversationState(ctx, id, { reopen: newInbound.has(id) })
  return { ingested }
}

/** Stored conversation fields `refreshConversationState` derives. */
export interface ConversationStateRow {
  id: string
  status?: string | null
  last_inbound_at?: string | null
  last_message_at?: string | null
  last_message_snippet?: string | null
}

interface StoredMessageRow {
  direction?: string
  occurred_at?: string | null
  body?: string | null
}

/** The later of two timestamps, null only when both are absent or unparsable. */
export function laterIso(
  a: string | Date | null | undefined,
  b: string | Date | null | undefined,
): string | null {
  const ms = (v: string | Date | null | undefined) =>
    v == null ? Number.NaN : typeof v === "string" ? Date.parse(v) : v.getTime()
  const ta = ms(a)
  const tb = ms(b)
  if (Number.isNaN(ta) && Number.isNaN(tb)) return null
  const pick = Number.isNaN(tb) || (!Number.isNaN(ta) && ta >= tb) ? a : b
  return pick instanceof Date ? pick.toISOString() : (pick as string)
}

/**
 * Conversation lifecycle (`dm_conversation.status`): a thread whose latest
 * message is OURS (sent from Liaison or natively) is `handled`; a NEW inbound
 * message reopens a `handled` or `archived` thread. `reopen` says whether the
 * caller just inserted that new inbound message: the newest STORED message
 * being inbound proves nothing (an operator archives a thread after the
 * customer's last word), so without it a `handled` or `archived` thread stays
 * as set. `snoozed` and `awaiting_approval` are a person's or an approval's
 * call and stay as set.
 */
export function nextConversationStatus(
  current: string | null | undefined,
  latestDirection: string | undefined,
  reopen = false,
): string {
  const status = current ?? "open"
  if (reopen && latestDirection === "inbound" && (status === "handled" || status === "archived"))
    return "open"
  if (latestDirection === "outbound" && status === "open") return "handled"
  return status
}

/**
 * Recompute a conversation's derived state from its stored `dm_message` rows:
 * `last_inbound_at` (latest inbound, which drives the reply window,
 * dm-window.ts), `last_message_at`, the snippet, and the status lifecycle
 * (`nextConversationStatus`). The two timestamps only ever move forward.
 * `reopen` is set only by ingest, for a conversation that just received a new
 * inbound message; every other caller (the repair, send_dm) never reopens.
 * Idempotent: the DM state repair (`repairDmConversationState`) runs it over
 * every stored conversation. Writes only what changed.
 */
export async function refreshConversationState(
  ctx: SocialToolCtx,
  conversation: string | ConversationStateRow,
  opts: { reopen?: boolean } = {},
): Promise<boolean> {
  const conv =
    typeof conversation === "string"
      ? ((await ctx.db.findOne("dm_conversation", conversation)) as ConversationStateRow | null)
      : conversation
  if (!conv) return false
  const [latest] = (await ctx.db.findMany("dm_message", {
    where: { conversation_id: conv.id },
    orderBy: { occurred_at: "desc" },
    limit: 1,
  })) as StoredMessageRow[]
  if (!latest) return false
  const [latestInbound] = (await ctx.db.findMany("dm_message", {
    where: { conversation_id: conv.id, direction: "inbound" },
    orderBy: { occurred_at: "desc" },
    limit: 1,
  })) as StoredMessageRow[]

  const patch: Record<string, unknown> = {}
  const lastInbound = laterIso(conv.last_inbound_at, latestInbound?.occurred_at)
  if (lastInbound !== null && !sameInstant(lastInbound, conv.last_inbound_at))
    patch.last_inbound_at = lastInbound
  const lastMessage = laterIso(conv.last_message_at, latest.occurred_at)
  if (lastMessage !== null && !sameInstant(lastMessage, conv.last_message_at))
    patch.last_message_at = lastMessage
  const snippet = dmSnippet(latest.body)
  if (snippet !== null && snippet !== conv.last_message_snippet)
    patch.last_message_snippet = snippet
  const status = nextConversationStatus(conv.status, latest.direction, opts.reopen === true)
  if (status !== (conv.status ?? "open")) patch.status = status
  if (Object.keys(patch).length === 0) return false
  await ctx.db.update("dm_conversation", conv.id, patch)
  return true
}

function sameInstant(
  a: string | Date | null | undefined,
  b: string | Date | null | undefined,
): boolean {
  if (a == null || b == null) return a == null && b == null
  const ta = typeof a === "string" ? Date.parse(a) : a.getTime()
  const tb = typeof b === "string" ? Date.parse(b) : b.getTime()
  return ta === tb
}

/** Version of the stored-state repair below; bump it to run the repair again. */
export const DM_STATE_REPAIR_VERSION = 1
/** Conversations repaired per DM sync tick. */
export const DM_STATE_REPAIR_BATCH = 200

interface RepairProgress {
  version?: number
  offset?: number
  done?: boolean
}

/**
 * One bounded step of the DM state repair: recompute `last_inbound_at`,
 * `last_message_at`, the snippet and the status of stored conversations from
 * their stored messages (`refreshConversationState`). It repairs rows written
 * by the sync that reset `last_inbound_at` to null on every unchanged thread
 * (every reply window then read closed) and that never closed a conversation.
 * Runs inside the DM sync, `DM_STATE_REPAIR_BATCH` conversations per tick,
 * with its progress in the DM `sync_state.metadata.dmStateRepair`; once done
 * for `DM_STATE_REPAIR_VERSION` it is a no-op. Idempotent: rerunning it
 * rewrites nothing.
 */
export async function repairDmConversationState(
  ctx: SocialToolCtx,
  syncState: { id: string; platform: Platform; metadata?: Record<string, unknown> | null },
): Promise<{ repaired: number; scanned: number; done: boolean }> {
  const metadata = syncState.metadata ?? {}
  const prior = (metadata.dmStateRepair ?? {}) as RepairProgress
  const sameVersion = prior.version === DM_STATE_REPAIR_VERSION
  if (sameVersion && prior.done) return { repaired: 0, scanned: 0, done: true }
  const offset = sameVersion ? (prior.offset ?? 0) : 0
  const rows = (await ctx.db.findMany("dm_conversation", {
    where: { platform: syncState.platform },
    orderBy: { createdAt: "asc", id: "asc" },
    limit: DM_STATE_REPAIR_BATCH,
    offset,
  })) as ConversationStateRow[]
  let repaired = 0
  for (const row of rows) {
    if (await refreshConversationState(ctx, row)) repaired += 1
  }
  const done = rows.length < DM_STATE_REPAIR_BATCH
  const progress: RepairProgress = {
    version: DM_STATE_REPAIR_VERSION,
    offset: offset + rows.length,
    done,
  }
  await ctx.db.update("sync_state", syncState.id, {
    metadata: { ...metadata, dmStateRepair: progress },
  })
  if (repaired > 0 || done) {
    ctx.logger?.info?.("social: DM state repair step", {
      platform: syncState.platform,
      scanned: rows.length,
      repaired,
      done,
    })
  }
  return { repaired, scanned: rows.length, done }
}

/**
 * Deferred webhook work: parse the verified body into normalized findings, upsert
 * each (dedup), and emit `finding:created` for the rows that were newly created.
 * This is what the webhook handler enqueues via `ctx.enqueueJob("parse-webhook",…)`
 * after its fast-ack 200 — so the 200 returns before any DB write happens.
 */
export async function parseWebhookJob(
  ctx: SocialToolCtx,
  payload: { platform: Platform; body: unknown },
): Promise<{ ingested: number; messagesIngested: number }> {
  const parser = WEBHOOK_PARSERS[payload.platform]
  if (!parser) return { ingested: 0, messagesIngested: 0 }
  // A server-wide Meta callback routes by stored Page ids: only Pages this
  // workspace still manages are ingested (meta-pages.ts).
  const body =
    payload.platform === "facebook" ? await livePagesOnly(ctx, payload.body) : payload.body
  const { findings, messages } = parser(body)
  let ingested = 0
  for (const f of findings) {
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
      authoredByOwner: f.authoredByOwner,
      replyToExternalId: f.replyToExternalId,
    })
    if (res.created) {
      ingested += 1
      await emitFindingCreated(ctx, res.id)
    }
  }
  // Webhook-delivered DM messages: find-or-create the conversation per
  // participant (the same row the DM poller keeps for that person), then land
  // each message + emit dm:received for new inbound rows.
  const convByExternalId = new Map<string, ConvRow>()
  for (const m of messages) {
    if (convByExternalId.has(m.conversationExternalId)) continue
    convByExternalId.set(
      m.conversationExternalId,
      await findOrCreateConversation(
        ctx,
        payload.platform,
        m.participantExternalId ?? m.conversationExternalId,
        m.ownerExternalId ?? null,
      ),
    )
  }
  const { ingested: messagesIngested } = await ingestDmMessages(ctx, messages, convByExternalId)
  return { ingested, messagesIngested }
}

/**
 * The conversation a DM belongs to, whichever path saw it first. The poller
 * keys a thread by Meta's thread id (`external_id`, `t_...`) and stores the other
 * party's id as `participant_external_id`; a webhook delivery carries no thread
 * id, only the participant (FB PSID / IG IGSID, page- or account-scoped, so
 * unique per platform). Lookup order: the thread id, then the participant, then
 * a webhook-created row still keyed by the participant id. The poller then
 * rewrites that row's `external_id` to the thread id, so both paths keep landing
 * in one conversation.
 */
export async function findConversationRow(
  ctx: SocialToolCtx,
  platform: Platform,
  keys: { externalId?: string | null; participantExternalId?: string | null },
): Promise<ConvRow | null> {
  const tries: Array<Record<string, unknown>> = []
  if (keys.externalId) tries.push({ platform, external_id: keys.externalId })
  if (keys.participantExternalId) {
    tries.push({ platform, participant_external_id: keys.participantExternalId })
    if (keys.participantExternalId !== keys.externalId)
      tries.push({ platform, external_id: keys.participantExternalId })
  }
  for (const where of tries) {
    const rows = (await ctx.db.findMany("dm_conversation", { where, limit: 1 })) as ConvRow[]
    if (rows[0]) return rows[0]
  }
  return null
}

/** Find-or-create the conversation of a webhook-delivered DM, by participant. */
async function findOrCreateConversation(
  ctx: SocialToolCtx,
  platform: Platform,
  participantExternalId: string,
  ownerExternalId: string | null,
): Promise<ConvRow> {
  const existing = await findConversationRow(ctx, platform, { participantExternalId })
  if (existing) return existing
  // §5/§6: link the DM participant to a kernel contact.
  const contactId = await resolveAuthorContact(ctx, participantExternalId)
  try {
    const inserted = await ctx.db.insert("dm_conversation", {
      platform,
      // Placeholder key until the poller sees the thread and stores its id.
      external_id: participantExternalId,
      participant_external_id: participantExternalId,
      contact_id: contactId,
      status: "open",
      // A Facebook delivery names the Page it was sent to: send_dm needs it to
      // pick that Page's token (the poller stores the same `{ pageId }`).
      metadata: platform === "facebook" && ownerExternalId ? { pageId: ownerExternalId } : {},
    })
    return { id: inserted.id }
  } catch (err) {
    // Two deliveries from the same new person parsed at once both saw no
    // conversation: the loser of the unique-key race uses the winner's row.
    if (isUniqueViolation(err)) {
      const reread = await findConversationRow(ctx, platform, { participantExternalId })
      if (reread) return reread
    }
    throw err
  }
}

/** A postgres unique-key (23505) violation as the db bridge surfaces it (the pg code and text in
 *  the message). */
function isUniqueViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /\b23505\b/.test(msg) || /duplicate key value violates unique constraint/i.test(msg)
}
