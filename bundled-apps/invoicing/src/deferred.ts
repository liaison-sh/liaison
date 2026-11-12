// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 Task E3 — Deferred-event queue + retry plumbing.
//
// The deferred_events table (manifest §schema) holds events that could not
// be processed inline — either because configuration is missing
// (`awaiting_config`), required data is absent (`awaiting_data`), a
// dependency app is unavailable (`awaiting_dependency`), or a transient
// failure occurred (`render_failed`, `email_failed`).
//
// Filter logic that needs comparison operators (backoff window elapsed,
// retry_count < cap) is done client-side after a bounded `findMany` — the
// generic bridge `where` clause only supports field equality. The eligible
// set is small in practice (deferred events are exceptional), so a
// client-side filter on a few hundred rows is fine.

import { resolveIdentityAttention } from "./einvoicing/gate"

export type DeferredStatus =
  | "awaiting_config"
  | "awaiting_data"
  | "awaiting_dependency"
  | "render_failed"
  | "email_failed"
  | "resolved"
  | "permanent_failure"

export interface DeferredRow {
  id: string
  event_id: string
  event_payload_json: unknown
  status: DeferredStatus
  reason: string | null
  blocked_on: Record<string, unknown>
  retry_count: number
  retried_at: Date | null
  created_at: Date
}

export interface DeferredDb {
  findMany(
    entity: string,
    opts?: {
      where?: Record<string, unknown>
      orderBy?: Record<string, "asc" | "desc">
      limit?: number
    },
  ): Promise<unknown[]>
  findOne(entity: string, id: string): Promise<unknown | null>
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export interface DeferredCtx {
  db: DeferredDb
  /** Present on the kernel ctx: closes a resolved park's attention item. */
  emit?(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

/** Maximum retries before a row is dead-lettered (spec §7 default 10). */
export const DEAD_LETTER_CAP = 10

/** Dead-letter requires both retry-cap exceeded AND minimum age (7 days). */
export const DEAD_LETTER_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Per-run dispatch batch. The cron drains at most this many rows PER 5-min
 * sweep so one sandbox execution always finishes well inside the worker
 * execution timeout (worker-pool.ts). Each dispatch can re-drive the order
 * handler (DB reads + a cross-app call), so an unbounded loop over the whole
 * backlog (hundreds of awaiting_data rows) blows the timeout on every run and
 * the queue never drains. A small batch with least-recently-tried ordering
 * (below) guarantees forward progress: every sweep advances a different slice.
 */
export const RETRY_BATCH_SIZE = 25

/**
 * Reasons stamped by an operational bulk dead-letter (e.g. the 2026-07-08
 * cutover backfill): a row carrying one of these must never be re-dispatched
 * even if its status was left non-terminal and its retry_count is below the
 * cap. Matched as a case-insensitive prefix on `reason`.
 */
const DEAD_LETTERED_REASON_PREFIX = "dead-lettered"

/**
 * Parks a retry can never clear: the order handler parks them from facts that do not change on
 * their own (a tax figure that disagrees with Shopify's, seller tax on an exempt treatment, an OSS
 * placeholder rate). Re-driving them every sweep only re-parks until the row dead-letters and the
 * order is never invoiced. They wait for a person instead: an attention row is raised once when
 * the park is created, and an operator resolves it through `deferred_tax_override`.
 */
export const HUMAN_REVIEW_KINDS: ReadonlySet<string> = new Set([
  "tax_check",
  "tax_treatment",
  "tax_rate",
])

export function needsHumanReview(blocked_on: Record<string, unknown> | null | undefined): boolean {
  return HUMAN_REVIEW_KINDS.has(String(blocked_on?.kind ?? ""))
}

/**
 * Parks that wait on a buyer's e-invoicing identity (order-paid, refund and cancellation credit
 * notes). Only a person or the registry can supply it, however long that takes, so these rows
 * are exempt from the retry cap and never dead-letter. Besides the ordinary backoff, they are due
 * the moment the identity they wait on changes (`changed_at` later than the park's last try).
 */
export const IDENTITY_WAIT_KINDS: ReadonlySet<string> = new Set(["einvoice_identity"])

export function isIdentityWait(blocked_on: Record<string, unknown> | null | undefined): boolean {
  return IDENTITY_WAIT_KINDS.has(String(blocked_on?.kind ?? ""))
}

/** An automatic credit note refused for a reason other than the buyer's identity (an incomplete
 *  recipient, an over-credit…): parked with its own arguments and an attention item. */
export const AUTO_CREDIT_NOTE_PARK_KIND = "auto_credit_note"

/** The db + emit surface closing a park's attention item needs. */
export interface ParkAttentionCtx {
  db: Pick<ParkDb, "findMany">
  emit?(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

/**
 * Close the attention item a resolved park raised: the buyer-identity item once no other identity
 * park waits on the contact, a refused credit note's item with its park.
 */
export async function resolveParkAttention(
  ctx: ParkAttentionCtx,
  row: { id: string; blocked_on: Record<string, unknown> | null | undefined },
): Promise<void> {
  const blocked = row.blocked_on ?? {}
  if (isIdentityWait(blocked)) {
    const contact =
      typeof blocked.contact_id === "string" && blocked.contact_id ? blocked.contact_id : null
    await resolveIdentityAttention(ctx, { parkId: row.id, contact_id: contact })
    return
  }
  if (blocked.kind === AUTO_CREDIT_NOTE_PARK_KIND && ctx.emit) {
    await ctx.emit({
      entity: "deferred",
      action: "credit_note_refused",
      entityId: row.id,
      data: { deferred_id: row.id, resolved: true },
    })
  }
}

function isBulkDeadLettered(reason: string | null): boolean {
  return (reason ?? "").trim().toLowerCase().startsWith(DEAD_LETTERED_REASON_PREFIX)
}

/**
 * Default exponential backoff schedule, capped at 1h.
 *   0 → 0ms (run on next sweep)
 *   1 → 5min
 *   2 → 15min
 *   3 → 30min
 *   4+ → 60min (cap)
 */
export function defaultBackoffMs(retry_count: number): number {
  if (retry_count <= 0) return 0
  if (retry_count === 1) return 5 * 60 * 1000
  if (retry_count === 2) return 15 * 60 * 1000
  if (retry_count === 3) return 30 * 60 * 1000
  return 60 * 60 * 1000
}

function toDate(v: unknown): Date {
  if (v instanceof Date) return v
  if (typeof v === "string" && v.length > 0) return new Date(v)
  return new Date(0)
}

function toDeferredRow(row: unknown): DeferredRow {
  const r = row as Record<string, unknown>
  return {
    id: String(r.id),
    event_id: String(r.event_id ?? ""),
    event_payload_json: r.event_payload_json,
    status: (r.status as DeferredStatus) ?? "awaiting_config",
    reason: (r.reason as string | null) ?? null,
    blocked_on: (r.blocked_on as Record<string, unknown> | undefined) ?? {},
    retry_count: Number(r.retry_count ?? 0),
    retried_at: r.retried_at ? toDate(r.retried_at) : null,
    created_at: toDate(r.created_at),
  }
}

const TERMINAL_STATUSES: ReadonlySet<DeferredStatus> = new Set(["resolved", "permanent_failure"])

/**
 * Dedup identity for a park: same order + same blocker (and same target document, when the
 * blocker is document-scoped, so a goods vs services invoice blocked on the same kind stay
 * distinct). Two DIFFERENT blockers for one order remain separate rows.
 */
function parkDedupKey(blocked_on: Record<string, unknown>): string {
  const kind = String(blocked_on?.kind ?? "")
  const docId = String(blocked_on?.document_id ?? "")
  return `${kind}|${docId}`
}

/**
 * Append a deferred row -- IDEMPOTENTLY by (event_id, blocker). A Shopify webhook redelivery/
 * replay, or a `deferred-retry` re-dispatch that re-drives the order handler while STILL
 * blocked, must not spawn a NEW row each time. That is exactly what let a single order accrue
 * 392 identical `awaiting_data` rows during the 2026-07-08 cutover, thrashing the jobs DB pool
 * (DbAcquireTimeoutError) so nothing drained. If a non-terminal row already exists for this
 * event_id with the same blocker identity, refresh it in place and return its id (its
 * retry_count/backoff progression is preserved -- the retry cron owns that counter).
 */
/** The db surface `park` / `resolveOpenParks` need: every handler ctx (order, refund, cancel,
 *  cron) carries at least this much. */
export interface ParkDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<unknown>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

export async function park(
  ctx: { db: ParkDb },
  input: {
    event_id: string
    event_payload_json: unknown
    status: DeferredStatus
    reason: string | null
    blocked_on: Record<string, unknown>
  },
): Promise<{ id: string; created: boolean }> {
  const key = parkDedupKey(input.blocked_on)
  const existing = (await ctx.db.findMany("deferred_events", {
    where: { event_id: input.event_id },
    limit: 500,
  })) as unknown[]
  const dup = existing
    .map(toDeferredRow)
    .find((r) => !TERMINAL_STATUSES.has(r.status) && parkDedupKey(r.blocked_on) === key)
  // The contact a park waits on, as a column: identity lookups filter on it (never a scan).
  const contactId =
    typeof input.blocked_on?.contact_id === "string" && input.blocked_on.contact_id
      ? input.blocked_on.contact_id
      : null
  if (dup) {
    await ctx.db.update("deferred_events", dup.id, {
      event_payload_json: input.event_payload_json,
      status: input.status,
      reason: input.reason,
      blocked_on: input.blocked_on,
      contact_id: contactId,
    })
    return { id: dup.id, created: false }
  }
  const inserted = (await ctx.db.insert("deferred_events", {
    event_id: input.event_id,
    contact_id: contactId,
    event_payload_json: input.event_payload_json,
    status: input.status,
    reason: input.reason,
    blocked_on: input.blocked_on,
    retry_count: 0,
    retried_at: null,
  })) as Record<string, unknown>
  return { id: String(inserted.id), created: true }
}

const OPEN_STATUSES: readonly DeferredStatus[] = [
  "awaiting_config",
  "awaiting_data",
  "awaiting_dependency",
  "render_failed",
  "email_failed",
]

/** Per-status fetch ceiling for the open set. */
const OPEN_FETCH_LIMIT = 500

/**
 * Every NON-terminal row, fetched per open status. The table keeps its resolved and
 * dead-lettered history forever, so a single `orderBy id limit 500` page over the WHOLE table
 * (uuid order, terminal rows included) could be filled entirely by history and never reach a
 * row that is actually waiting: those rows were then starved forever.
 */
async function fetchOpenRows(ctx: DeferredCtx): Promise<DeferredRow[]> {
  const out: DeferredRow[] = []
  for (const status of OPEN_STATUSES) {
    const rows = await ctx.db.findMany("deferred_events", {
      where: { status },
      limit: OPEN_FETCH_LIMIT,
    })
    for (const r of rows) out.push(toDeferredRow(r))
  }
  return out
}

/** Reason stamped on a row closed because an identical open park for the same order exists. */
export const DUPLICATE_PARK_REASON = "duplicate_park"

/** Most duplicate rows closed per sweep, so one run stays well inside the job timeout. */
export const COLLAPSE_BATCH_SIZE = 200

/**
 * Self-heal for parks written before `park()` was idempotent on every path: collapse each group
 * of OPEN rows sharing (event_id, blocker) into ONE survivor. The survivor is the most retried
 * row (its backoff progression is kept), then the oldest. Every other row is marked resolved
 * with reason `duplicate_park`. Bounded per sweep; successive sweeps finish a larger backlog.
 */
export async function collapseDuplicateParks(
  ctx: DeferredCtx,
  opts?: { batchSize?: number },
): Promise<{ collapsed: number }> {
  const batchSize = opts?.batchSize ?? COLLAPSE_BATCH_SIZE
  const groups = new Map<string, DeferredRow[]>()
  for (const r of await fetchOpenRows(ctx)) {
    const key = `${r.event_id}|${parkDedupKey(r.blocked_on)}`
    const g = groups.get(key)
    if (g) g.push(r)
    else groups.set(key, [r])
  }
  let collapsed = 0
  for (const g of groups.values()) {
    if (g.length < 2) continue
    g.sort((a, b) => {
      if (a.retry_count !== b.retry_count) return b.retry_count - a.retry_count
      const ta = a.created_at.getTime()
      const tb = b.created_at.getTime()
      if (ta !== tb) return ta - tb
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    for (const dup of g.slice(1)) {
      if (collapsed >= batchSize) return { collapsed }
      await ctx.db.update("deferred_events", dup.id, {
        status: "resolved",
        reason: DUPLICATE_PARK_REASON,
      })
      collapsed += 1
    }
  }
  return { collapsed }
}

/**
 * Close every OPEN park for one order (e.g. the order was cancelled, so there is nothing left to
 * invoice). `patch` may carry extra fields to stamp (e.g. a refreshed event_payload_json).
 */
export async function resolveOpenParks(
  ctx: { db: Pick<ParkDb, "findMany" | "update">; emit?: ParkAttentionCtx["emit"] },
  event_id: string,
  reason: string,
  patch?: Record<string, unknown>,
): Promise<{ resolved: number }> {
  if (!event_id) return { resolved: 0 }
  const rows = (await ctx.db.findMany("deferred_events", {
    where: { event_id },
    limit: 500,
  })) as unknown[]
  let resolved = 0
  for (const r of rows.map(toDeferredRow)) {
    if (TERMINAL_STATUSES.has(r.status)) continue
    await ctx.db.update("deferred_events", r.id, { ...(patch ?? {}), status: "resolved", reason })
    resolved += 1
    await resolveParkAttention(ctx, r)
  }
  return { resolved }
}

/**
 * Select a BOUNDED batch of rows whose backoff window has elapsed and
 * retry_count < cap, excluding terminal and bulk-dead-lettered rows.
 *
 * The returned set is capped at `batchSize` (default RETRY_BATCH_SIZE) so a
 * single cron sweep always drains inside the sandbox execution timeout. Rows
 * are ordered LEAST-RECENTLY-TRIED first (oldest retried_at/created_at) so
 * successive sweeps advance through the whole backlog instead of re-chewing the
 * same head rows every run — that ordering is what guarantees forward progress
 * when the eligible set is larger than one batch.
 *
 * Generic `where` supports only equality, so status/cap/backoff/dead-letter
 * exclusions are a post-filter. We over-fetch (a multiple of the batch) so the
 * batch is drawn from the genuinely-eligible set even when the raw page is
 * dominated by terminal/dead/not-yet-due rows.
 */
export type IdentityChangedAt =
  | ReadonlyMap<string, Date>
  | ((contactIds: string[]) => Promise<ReadonlyMap<string, Date>>)

export async function retryEligible(
  ctx: DeferredCtx,
  opts?: {
    now?: Date
    maxRetryCount?: number
    batchSize?: number
    /** `changed_at` of the identity each open identity park waits on, keyed by contact id: a
     *  map, or a loader asked only for the contacts of identity parks whose backoff has not
     *  elapsed (so a sweep reads those identities alone, filtered by contact). */
    identityChangedAt?: IdentityChangedAt
  },
): Promise<DeferredRow[]> {
  const now = opts?.now ?? new Date()
  const cap = opts?.maxRetryCount ?? DEAD_LETTER_CAP
  const batchSize = opts?.batchSize ?? RETRY_BATCH_SIZE
  const rows = await fetchOpenRows(ctx)
  const candidates = rows
    .filter((r) => !isBulkDeadLettered(r.reason))
    .filter((r) => !needsHumanReview(r.blocked_on))
    .filter((r) => isIdentityWait(r.blocked_on) || r.retry_count < cap)
  const lastTry = (r: DeferredRow) => r.retried_at ?? r.created_at
  const backoffElapsed = (r: DeferredRow) =>
    now.getTime() - lastTry(r).getTime() >= defaultBackoffMs(r.retry_count)
  // An identity park is due as soon as the identity it waits on changed after its last try.
  const waiting = new Set<string>()
  for (const r of candidates) {
    const contactId = String(r.blocked_on.contact_id ?? "")
    if (isIdentityWait(r.blocked_on) && contactId && !backoffElapsed(r)) waiting.add(contactId)
  }
  const source = opts?.identityChangedAt
  const changed: ReadonlyMap<string, Date> =
    typeof source === "function"
      ? waiting.size > 0
        ? await source([...waiting])
        : new Map()
      : (source ?? new Map())
  const eligible = candidates.filter((r) => {
    if (backoffElapsed(r)) return true
    if (!isIdentityWait(r.blocked_on)) return false
    const contactId = String(r.blocked_on.contact_id ?? "")
    const changedAt = contactId ? changed.get(contactId) : undefined
    return !!changedAt && changedAt.getTime() > lastTry(r).getTime()
  })
  // Least-recently-tried first: a never-tried row (retried_at null) sorts by its
  // created_at, so freshly-parked and long-stale rows both get their turn.
  eligible.sort((a, b) => {
    const ta = (a.retried_at ?? a.created_at).getTime()
    const tb = (b.retried_at ?? b.created_at).getTime()
    if (ta !== tb) return ta - tb
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return eligible.slice(0, batchSize)
}

/** The parks whose remaining step is a document's automatic mail. */
export const AUTO_EMAIL_PARK_KINDS: ReadonlySet<string> = new Set([
  "email_send",
  "issuer_mail_account",
])
/** A park's automatic mail whose outcome is unknown: the sweep never sends it again. */
export const EMAIL_OUTCOME_UNKNOWN = "email_outcome_unknown"
const AUTO_EMAIL_PARK_STATUSES: readonly DeferredStatus[] = [
  "email_failed",
  "awaiting_dependency",
  "awaiting_config",
]

/**
 * A person sent the document (documents_send_to_customer): every open park whose remaining step
 * is that document's automatic mail is closed, so the sweep never sends it as well. This is the
 * way out of a park whose automatic mail is unknown (`email_outcome_unknown`): the person checks
 * the mailbox's sent folder and, when the mail is not there, sends the document. Returns how many
 * parks it closed.
 */
export async function closeAutoEmailParks(
  ctx: { db: Pick<DeferredDb, "findMany" | "update">; emit?: DeferredCtx["emit"] },
  documentId: string,
  now: Date = new Date(),
): Promise<number> {
  let closed = 0
  for (const status of AUTO_EMAIL_PARK_STATUSES) {
    const rows = (await ctx.db.findMany("deferred_events", { where: { status }, limit: 500 })).map(
      toDeferredRow,
    )
    for (const row of rows) {
      const kind = String(row.blocked_on.kind ?? "")
      if (
        !AUTO_EMAIL_PARK_KINDS.has(kind) ||
        String(row.blocked_on.document_id ?? "") !== documentId
      )
        continue
      await ctx.db.update("deferred_events", row.id, {
        status: "resolved",
        retried_at: now.toISOString(),
      })
      await resolveParkAttention(ctx, row)
      closed += 1
    }
  }
  return closed
}

export async function markPermanentFailure(
  ctx: DeferredCtx,
  row: DeferredRow,
  opts?: { now?: Date; minAgeMs?: number; cap?: number },
): Promise<DeferredRow> {
  const now = opts?.now ?? new Date()
  const minAgeMs = opts?.minAgeMs ?? DEAD_LETTER_MIN_AGE_MS
  const cap = opts?.cap ?? DEAD_LETTER_CAP
  const ageMs = now.getTime() - row.created_at.getTime()
  if (isIdentityWait(row.blocked_on)) return row
  if (row.retry_count < cap || ageMs < minAgeMs) return row
  await ctx.db.update("deferred_events", row.id, { status: "permanent_failure" })
  return { ...row, status: "permanent_failure" }
}

export async function manualRetry(
  ctx: DeferredCtx,
  id: string,
  handler: (row: DeferredRow) => Promise<void>,
): Promise<{ status: "ok" | "failed"; row: DeferredRow }> {
  // findMany shape — see issue.ts comment on the shim's JSON-parse asymmetry.
  const rows = await ctx.db.findMany("deferred_events", {
    where: { id },
    limit: 1,
  })
  const raw = rows[0]
  if (!raw) throw new Error(`deferred row ${id} not found`)
  const row = toDeferredRow(raw)
  const now = new Date()
  try {
    await handler(row)
    await ctx.db.update("deferred_events", id, {
      retried_at: now.toISOString(),
      retry_count: row.retry_count + 1,
      status: "resolved",
    })
    await resolveParkAttention(ctx, row)
    return {
      status: "ok",
      row: { ...row, retried_at: now, retry_count: row.retry_count + 1, status: "resolved" },
    }
  } catch {
    await ctx.db.update("deferred_events", id, {
      retried_at: now.toISOString(),
      retry_count: row.retry_count + 1,
    })
    return {
      status: "failed",
      row: { ...row, retried_at: now, retry_count: row.retry_count + 1 },
    }
  }
}
