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
import { ISSUER_PARK_KIND, resolveIssuerAttention } from "./einvoicing/seller"
import { LINES_PARK, type LinesCtx, recountGroup } from "./handlers/stripe-lines"

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
      offset?: number
      select?: string[]
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

/**
 * Parks that wait on the organization's own issuer profile: an e-invoice its issuer cannot sign
 * (no SIREN or no structured address) in an org that enforces e-invoicing. Only a person filling
 * Settings clears them, so like identity waits they are exempt from the retry cap and never
 * dead-letter, and they are due as soon as that issuer profile changed after their last try.
 */
export const ISSUER_WAIT_KIND = ISSUER_PARK_KIND

export function isIssuerWait(blocked_on: Record<string, unknown> | null | undefined): boolean {
  return String(blocked_on?.kind ?? "") === ISSUER_WAIT_KIND
}

/** A wait only a person can clear: never capped, never dead-lettered. */
function waitsOnPerson(blocked_on: Record<string, unknown> | null | undefined): boolean {
  return isIdentityWait(blocked_on) || isIssuerWait(blocked_on)
}

/** A Stripe invoice parked before its issue. */
export const STRIPE_INVOICE_PARK = "stripe_invoice"
/** A Stripe refund's credit note parked before its issue. */
export const STRIPE_CREDIT_NOTE_PARK = "stripe_credit_note"

/**
 * Parks of card payments that wait on a record: a Stripe invoice on its buyer (an email or an
 * address a person adds in Stripe) or on the issuer, a refund's credit note on its invoice. They
 * are never dead-lettered: money was taken, so a person must see them through.
 */
export function waitsOnRecord(blocked_on: Record<string, unknown> | null | undefined): boolean {
  const kind = String(blocked_on?.kind ?? "")
  return (
    kind === STRIPE_INVOICE_PARK ||
    (kind === STRIPE_CREDIT_NOTE_PARK && typeof blocked_on?.invoice_ref === "string")
  )
}

/**
 * A park whose record was not there through every ordinary retry (DEAD_LETTER_CAP of them): the
 * sweep no longer tries it. What happens then differs:
 *   - a Stripe invoice: nothing issues it but a person. The safety job notices that its buyer is
 *     complete and says so on Home (handlers/stripe-lines.ts). A person's click
 *     (`invoice_from_stripe_payment`) reads the invoice from Stripe at that moment, never the
 *     payload stored here, and issues it with the next number dated that day, or refuses saying
 *     why: already invoiced by hand, void in Stripe, the buyer still incomplete, Stripe
 *     unreadable. A refusal takes no number and leaves the park here, with the person;
 *   - a refund's credit note: it follows its invoice. Once that invoice exists (a person issued
 *     it, or linked its payment to one made by hand) the safety job hands the park back to the
 *     sweep (`revive`).
 */
export function isStalled(r: DeferredRow): boolean {
  return (
    !TERMINAL_STATUSES.has(r.status) &&
    r.retry_count >= DEAD_LETTER_CAP &&
    waitsOnRecord(r.blocked_on)
  )
}

/**
 * The invoice a stalled credit note waited for is there: the next sweep tries the park, after the
 * rows already due, with the ordinary retries again.
 */
export async function revive(
  ctx: { db: Pick<ParkDb, "update"> },
  id: string,
  now: Date = new Date(),
): Promise<void> {
  await ctx.db.update("deferred_events", id, { retry_count: 0, retried_at: now.toISOString() })
}

/** An automatic credit note refused for a reason other than the buyer's identity (an incomplete
 *  recipient, an over-credit…): parked with its own arguments and an attention item. */
export const AUTO_CREDIT_NOTE_PARK_KIND = "auto_credit_note"

/** The db + emit surface closing a park's attention item needs. */
export interface ParkAttentionCtx {
  db: Pick<ParkDb, "findMany"> & Partial<Pick<ParkDb, "update">>
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
  if (isIssuerWait(blocked)) {
    const issuer =
      typeof blocked.issuer_profile_id === "string" && blocked.issuer_profile_id
        ? blocked.issuer_profile_id
        : null
    await resolveIssuerAttention(ctx, { parkId: row.id, issuer_profile_id: issuer })
    return
  }
  // An unmatched card payment's line (or its money-first question) goes with its park: the
  // payment was invoiced, linked, or drafted as the advance. The kind is stripe-payment-unmatched's.
  if (
    blocked.kind === "stripe_unmatched_payment" &&
    ctx.emit &&
    typeof blocked.charge_id === "string"
  ) {
    await ctx.emit({
      entity: "stripe_payment",
      action: typeof blocked.step_id === "string" ? "advance_received" : "unmatched",
      entityId: blocked.charge_id,
      data: { charge_id: blocked.charge_id, resolved: true },
    })
    return
  }
  // A Stripe invoice's line goes with its park, whatever it waited for.
  const stripeItem = stripeInvoiceItemOf(blocked)
  if (stripeItem && ctx.emit) {
    await ctx.emit({
      ...stripeItem,
      entityId: row.id,
      data: { deferred_id: row.id, resolved: true },
    })
    if (blocked.kind === STRIPE_INVOICE_PARK) await recountGroup(ctx as LinesCtx)
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

/** The attention item a parked Stripe invoice raises under its park's id, by what it waits for. */
function stripeInvoiceItemOf(
  blocked: Record<string, unknown>,
): { entity: string; action: string } | null {
  if (typeof blocked.stripe_invoice_id !== "string") return null
  if (blocked.kind === STRIPE_INVOICE_PARK)
    return { entity: "stripe_invoice", action: "needs_person" }
  if (blocked.kind === "stripe_issuer_undecided")
    return { entity: "stripe_invoice", action: "issuer_undecided" }
  if (blocked.kind === "tax_check") return { entity: "deferred", action: "stripe_tax_review" }
  return null
}

/**
 * The event now waits elsewhere: close its open parks of `kind` other than `keepId`, with their
 * attention, so one event never waits (and is never tried again) twice.
 */
export async function closeParksOfKind(
  ctx: { db: Pick<ParkDb, "findMany" | "update">; emit?: ParkAttentionCtx["emit"] },
  event_id: string,
  kind: string,
  keepId: string,
): Promise<void> {
  for (const r of await openParksOf(ctx, event_id)) {
    if (r.id === keepId || r.blocked_on.kind !== kind) continue
    await ctx.db.update("deferred_events", r.id, { status: "resolved", reason: "waits_elsewhere" })
    await resolveParkAttention(ctx, r)
  }
}

export function isBulkDeadLettered(reason: string | null): boolean {
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

export function toDeferredRow(row: unknown): DeferredRow {
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
  const dup = (await openParksOf(ctx, input.event_id)).find(
    (r) => parkDedupKey(r.blocked_on) === key,
  )
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
      // What its Home line says now stays with the park (handlers/stripe-lines.ts).
      blocked_on:
        typeof dup.blocked_on.line === "string"
          ? { ...input.blocked_on, line: dup.blocked_on.line }
          : input.blocked_on,
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

/** Rows read at a time. */
const PAGE = 500

/** Every field but the payload, which can be large: a scan reads all the waiting rows. */
const ROW_FIELDS = [
  "id",
  "event_id",
  "status",
  "reason",
  "blocked_on",
  "retry_count",
  "retried_at",
  "created_at",
]

interface PageDb {
  findMany(entity: string, opts?: Record<string, unknown>): Promise<unknown[]>
}

/** The rows a read matches, a page at a time, however many there are. */
async function* pagesOf(
  db: PageDb,
  opts: Record<string, unknown>,
): AsyncGenerator<Array<Record<string, unknown>>> {
  let last = ""
  for (let offset = 0; ; offset += PAGE) {
    const rows = (await db.findMany("deferred_events", {
      ...opts,
      orderBy: { id: "asc" },
      limit: PAGE,
      offset,
    })) as Array<Record<string, unknown>>
    const first = String(rows[0]?.id ?? "")
    // A store that ignores `offset` answers the same page again.
    if (rows.length === 0 || first === last) return
    last = first
    yield rows
    if (rows.length < PAGE) return
  }
}

/** The parks of one event that are not resolved, the given-up ones included. */
export async function parksOf(
  ctx: { db: Pick<ParkDb, "findMany"> },
  event_id: string,
): Promise<DeferredRow[]> {
  const open = (rows: unknown[]) => rows.map(toDeferredRow).filter((r) => r.status !== "resolved")
  const first = await ctx.db.findMany("deferred_events", { where: { event_id }, limit: PAGE })
  if (first.length < PAGE) return open(first)
  const out: DeferredRow[] = []
  for await (const page of pagesOf(ctx.db as PageDb, { where: { event_id } }))
    out.push(...open(page))
  return out
}

/** The open parks of one event. */
async function openParksOf(
  ctx: { db: Pick<ParkDb, "findMany"> },
  event_id: string,
): Promise<DeferredRow[]> {
  return (await parksOf(ctx, event_id)).filter((r) => !TERMINAL_STATUSES.has(r.status))
}

/** Every open park whose event id contains `prefix`, with or without its payload. */
export async function* openRowsOf(
  ctx: { db: PageDb },
  prefix: string,
  opts: { payload?: boolean; statuses?: readonly DeferredStatus[] } = {},
): AsyncGenerator<DeferredRow> {
  const read = {
    where: { status: { in: [...(opts.statuses ?? OPEN_STATUSES)] } },
    search: { fields: ["event_id"], query: prefix },
    ...(opts.payload ? {} : { select: ROW_FIELDS }),
  }
  for await (const page of pagesOf(ctx.db, read))
    for (const r of page.map(toDeferredRow)) if (r.event_id.startsWith(prefix)) yield r
}

/**
 * Every NON-terminal row, per open status, without its payload (`withPayload` reads the ones a
 * sweep takes). The table keeps its resolved and dead-lettered history forever, so terminal rows
 * are never read; and every page is: a row past the first 500 waiting is tried like the others.
 */
async function fetchOpenRows(ctx: DeferredCtx): Promise<DeferredRow[]> {
  const out: DeferredRow[] = []
  for (const status of OPEN_STATUSES)
    for await (const page of pagesOf(ctx.db as PageDb, { where: { status }, select: ROW_FIELDS }))
      for (const r of page) out.push(toDeferredRow(r))
  return out
}

/** The rows with the payload the scan left out. */
async function withPayload(ctx: DeferredCtx, rows: DeferredRow[]): Promise<DeferredRow[]> {
  const out: DeferredRow[] = []
  for (const r of rows) {
    if (r.event_payload_json !== undefined) {
      out.push(r)
      continue
    }
    const [full] = await ctx.db.findMany("deferred_events", { where: { id: r.id }, limit: 1 })
    if (full) out.push(toDeferredRow(full))
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
  let resolved = 0
  for (const r of await openParksOf(ctx, event_id)) {
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
 * exclusions are a post-filter over every open row (fetchOpenRows).
 */
export type IdentityChangedAt =
  | ReadonlyMap<string, Date>
  | ((contactIds: string[]) => Promise<ReadonlyMap<string, Date>>)

/** `updated_at` of the issuer profiles the sweep's waiting issuer parks are blocked on, by id. */
export type IssuerChangedAt = (issuerProfileIds: string[]) => Promise<ReadonlyMap<string, Date>>

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
    /** Loader of the issuer profiles' `updated_at`, asked only for the issuer parks whose
     *  backoff has not elapsed. */
    issuerChangedAt?: IssuerChangedAt
  },
): Promise<DeferredRow[]> {
  const now = opts?.now ?? new Date()
  const cap = opts?.maxRetryCount ?? DEAD_LETTER_CAP
  const batchSize = opts?.batchSize ?? RETRY_BATCH_SIZE
  const rows = await fetchOpenRows(ctx)
  const candidates = rows
    .filter((r) => !isBulkDeadLettered(r.reason))
    .filter((r) => !needsHumanReview(r.blocked_on) && r.blocked_on.kind !== LINES_PARK)
    .filter((r) => waitsOnPerson(r.blocked_on) || r.retry_count < cap)
  const lastTry = (r: DeferredRow) => r.retried_at ?? r.created_at
  const backoffElapsed = (r: DeferredRow) =>
    now.getTime() - lastTry(r).getTime() >= defaultBackoffMs(r.retry_count)
  // An identity park is due as soon as the identity it waits on changed after its last try.
  const waiting = new Set<string>()
  for (const r of candidates) {
    const contactId = String(r.blocked_on.contact_id ?? "")
    if (isIdentityWait(r.blocked_on) && contactId && !backoffElapsed(r)) waiting.add(contactId)
  }
  const issuersWaiting = new Set<string>()
  for (const r of candidates) {
    const issuerId = String(r.blocked_on.issuer_profile_id ?? "")
    if (isIssuerWait(r.blocked_on) && issuerId && !backoffElapsed(r)) issuersWaiting.add(issuerId)
  }
  const issuerChanged: ReadonlyMap<string, Date> =
    opts?.issuerChangedAt && issuersWaiting.size > 0
      ? await opts.issuerChangedAt([...issuersWaiting])
      : new Map()
  const source = opts?.identityChangedAt
  const changed: ReadonlyMap<string, Date> =
    typeof source === "function"
      ? waiting.size > 0
        ? await source([...waiting])
        : new Map()
      : (source ?? new Map())
  const eligible = candidates.filter((r) => {
    if (backoffElapsed(r)) return true
    if (isIssuerWait(r.blocked_on)) {
      // Due as soon as the issuer profile it waits on was edited after its last try.
      const at = issuerChanged.get(String(r.blocked_on.issuer_profile_id ?? ""))
      return !!at && at.getTime() > lastTry(r).getTime()
    }
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
  return withPayload(ctx, eligible.slice(0, batchSize))
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
  if (waitsOnPerson(row.blocked_on) || waitsOnRecord(row.blocked_on)) return row
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
