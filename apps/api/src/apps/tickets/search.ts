// SPDX-License-Identifier: FSL-1.1-ALv2
import { htmlToText } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { lookupTicketIdByHandle } from "~/apps/tickets/display-handle"
import {
  asTicketHandle,
  resolveTicketRef,
  type TicketRefError,
} from "~/apps/tickets/resolve-ticket-ref"
import { kernelRel, ticketsRel } from "~/apps/tickets/schema-refs"
import { extractRows, type PrivilegedDb, type RlsClient, type RlsTx } from "~/db"
import { decodeKeysetCursor, encodeKeysetCursor } from "~/lib/cursor"
import { sanitizeCustomerHtml } from "~/lib/email/sanitize"
import { stripQuotedHistory, stripQuotedHtml } from "~/lib/email/strip-quoted"
import { UUID_RE } from "~/lib/uuid"
import { resolveTicketMatches } from "~/modules/search/service"

type SqlClient = RlsClient | RlsTx | PrivilegedDb

/**
 * The subset of the caller's real ActorContext `resolveTicketMatches` needs
 * for permission-filtered text matching (spec §3.5): scopes AND
 * dimensionGrants AND roleIds — NOT just scopes. Several existing internal
 * cross-app call sites in this codebase hardcode `dimensionGrants: {}` for
 * unrelated calls; that pattern must never be copied here, or a team-scoped
 * user's search would silently resolve against an empty grant set and come
 * back empty. `userId` doubles as the RLS actor id for the (currently unused
 * by tickets but future-proof) participant-narrowing path in the shared
 * executor.
 */
export interface TicketSearchActor {
  userId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  roleIds: string[]
}

/**
 * Thrown when a non-empty free-text query cannot be resolved because Meili is
 * unavailable or the search index is not yet ready (spec §3.5/§6). Carries the
 * `status`/`code` pair shape used by `PermissionDeniedError`
 * (modules/permissions/errors.ts) and every other deliberate typed tool error
 * in this codebase — but for a call reached through the sandbox bridge
 * (`rpc-bridge.ts`'s `tickets_search`), a THROWN error's `.status`/`.code`
 * do NOT survive the QuickJS boundary (only `.message` does — see
 * `executor.ts`'s bridge catch handler). So the bridge catches this specific
 * error and RETURNS the structured `{error:{code,message,retryable,status}}`
 * envelope instead (mirrors `dispatchTransition`'s `result.ok === false`
 * handling in this same file) — that shape crosses the sandbox boundary
 * intact as plain JSON, and `execute-tool.ts`'s `normalizeToolErrorResult`
 * picks up its `status`/`code` from exactly that envelope, surfacing
 * `SEARCH_UNAVAILABLE` instead of an opaque `tool_error`. Empty-query listing
 * is never affected — this error is only ever thrown on the text-search
 * branch.
 */
export class TicketSearchUnavailableError extends Error {
  readonly status = 503
  readonly code = "SEARCH_UNAVAILABLE"

  constructor(message = "Search is temporarily unavailable. Try again shortly.") {
    super(message)
    this.name = "TicketSearchUnavailableError"
  }
}

/**
 * Test-only injection seam: lets colocated unit tests exercise the empty-id
 * short-circuit and id-join wiring without a real Meili instance (the
 * `search.*.test.ts` files pass an in-process `tx` double and must stay free
 * of live-Meili dependencies, per the existing-suite convention). Production
 * code never calls this — `searchTickets` always resolves the real
 * `resolveTicketMatches` at call time unless a test override is installed.
 */
let ticketMatchResolverOverride:
  | ((args: { orgId: string; actor: TicketSearchActor; q: string }) => Promise<string[]>)
  | null = null

async function resolveTicketMatchIds(
  orgId: string,
  actor: TicketSearchActor,
  q: string,
): Promise<string[]> {
  if (ticketMatchResolverOverride) return ticketMatchResolverOverride({ orgId, actor, q })
  return resolveTicketMatches({
    orgId,
    userId: actor.userId,
    scopes: actor.scopes,
    dimensionGrants: actor.dimensionGrants,
    roleIds: actor.roleIds,
    q,
  })
}
type TicketStatus = "open" | "awaiting_customer" | "awaiting_followup" | "closed"
type TicketPriority = "low" | "normal" | "high" | "urgent"

interface SearchParams {
  query?: string
  /** Alias for `query` — the tickets manifest documents `q` as the primary free-text
   *  param ("Free-text search across subject and body") and `query` as the inbox-UI
   *  alias, so a caller passing EITHER must search. Without this, an agent calling
   *  `search({ q: "preset" })` (the documented primary name) was silently ignored —
   *  `params.query` was undefined, the text filter was skipped, and the call returned
   *  the most-recent rows instead of the matches. */
  q?: string
  status?: TicketStatus | TicketStatus[]
  priority?: TicketPriority | TicketPriority[]
  team?: string | string[]
  /** b2b | b2c — the requester's side. Orthogonal to `team` (the centre): the
   *  same centre carries tickets of both kinds, so filtering one never implies
   *  the other. */
  audience?: string | string[]
  contactId?: string
  categoryId?: string
  /** A category NAME (e.g. "Shipping") OR a UUID — mirrors the setCategory
   *  ergonomics. A non-UUID string is resolved case-insensitively against the
   *  org's category list before filtering; an unknown name yields zero matches
   *  (rather than a 500), and the resolved id is reported back so the caller can
   *  see what it filtered on. Lets an agent ask for "shipping tickets at SLA risk"
   *  without first having to look up the category UUID. */
  category?: string
  categoryIdIncludingChildren?: string
  /**
   * Filter by the ticket's tagged `language` (ISO-ish code, e.g. 'fr'/'de'/'it'/'en'). Accepts a
   * single code or an array (e.g. ['fr','de','it'] for an EU-language backlog). The tickets app tags
   * each ticket's language (the `language` column / setLanguage tool), so a routine that digests "my
   * EU-language tickets" filters by language: ['fr','de','it'] SERVER-SIDE instead of detecting language
   * in-context per ticket body (fragile across a mixed backlog — it lets English/other tickets leak in).
   * Each returned row also carries `language` for display. Case-insensitive.
   */
  language?: string | string[]
  assignedTo?: string
  slaApproaching?: boolean
  slaBreached?: boolean
  includeMerged?: boolean
  includeMergedSources?: boolean
  excludeMergedSources?: boolean
  inboxId?: string | null
  sourceInboxId?: string | null
  closedAfter?: string
  followup?: "scheduled" | "due"
  smartFilter?:
    | "needs-attention"
    | "awaiting-customer"
    | "follow-ups"
    | "closed"
    | "all-open"
    | "my-backlog"
  /**
   * Explicit result ordering. Default (omitted) keeps the relevance/recency order
   * (most-recent activity first), which is NOT age-sorted — so an agent asked for
   * "the oldest open tickets" cannot get the GLOBAL N oldest from the default page
   * without exhaustive pagination. `oldest` orders by created_at ASC (the real
   * ticket-open time), so a single bounded call (e.g. smartFilter='all-open',
   * sort='oldest', limit=10) returns the actual N oldest open tickets — the
   * backlog-burndown read. `newest` orders by created_at DESC. `activity_newest`
   * / `activity_oldest` order by the last MESSAGE (inbound OR outbound) --
   * last_message_at -- newest-first / oldest-first respectively; this is the order
   * the tickets inbox UI uses (the row's visible "last activity" time IS this key,
   * so order and timestamp always agree), and activity_oldest is the
   * longest-untouched-first read "Needs attention" uses to surface tickets closest
   * to an SLA breach. `recently_updated` is the legacy alias for activity_newest.
   * When `sort` is set it OVERRIDES the smartFilter's implicit order (the filter
   * still scopes WHICH rows).
   */
  sort?: "oldest" | "newest" | "recently_updated" | "activity_newest" | "activity_oldest"
  /**
   * Aging threshold in whole days for the per-row `aging` boolean (default 3). Each returned row
   * reports `ageDays` (whole days open) AND `aging` (= ageDays > agingThresholdDays) — the server does
   * the per-ticket aging DISCRIMINATION so an agent building a "flag tickets aging past N days" digest
   * RENDERS the boolean each row carries instead of recomputing the comparison in-context (which a
   * weak model did unreliably — flagging everything/nothing). Set it to match the request's window
   * (e.g. agingThresholdDays: 3 for "aging past 3 days").
   */
  agingThresholdDays?: number
  /**
   * Customer-SILENCE threshold in whole days for the per-row `customerSilent` boolean (default 7 — the
   * common "no customer reply for 7+ days" auto-close window). For an awaiting_customer ticket each
   * returned row reports `customerSilentDays` (whole days since the LAST INBOUND customer message,
   * `last_inbound_at`) AND `customerSilent` (= customerSilentDays >= silentForDays) — the server does the
   * per-ticket STALENESS DISCRIMINATION so an auto-close routine tick RENDERS the boolean each row carries
   * instead of recomputing the last-inbound age in-context (which a weak model did unreliably — acting on
   * fresh 1-2-day tickets, applying a "we haven't heard from you in over a week" notice to a customer who
   * just replied). This is the exact analogue of `aging`/`followupDue`: the tick copies a boolean, it does
   * not do date arithmetic. Set it to match the request's window (e.g. silentForDays: 7 for "no reply for
   * 7+ days"). NULL `last_inbound_at` (no customer message ever) yields customerSilentDays/customerSilent
   * undefined — never a misleading false-stale.
   */
  silentForDays?: number
  actorUserId?: string | null
  limit?: number
  cursor?: string
  /** Skip the page query entirely and return ONLY `totalCount` — the cheap
   *  "how many are left" / countdown read. (The count itself is ALWAYS
   *  returned; this only suppresses fetching the rows.) */
  countOnly?: boolean
}

interface SearchResult {
  items: Array<Record<string, unknown>>
  nextCursor: string | null
  /** Server-side COUNT(*) over the SAME filter as the page (not the page size).
   *  Always present, matching the contacts/users/mail `totalCount` convention —
   *  a routine sweeping "every open ticket" reads a measured remaining count
   *  that tracks the predicate (process one → its status flips → it leaves the
   *  set → the count drops), so the agent cannot lose count. */
  totalCount: number
}

interface GetParams {
  ticketId: string
  messagesLimit?: number
  messagesCursor?: string
  /** Drill-down: return ONLY this one message, in FULL (untrimmed text; html
   *  too with includeHtml). The escape hatch when a slim-view message's
   *  '[quoted history trimmed]' note or an old page holds something you
   *  actually need. */
  messageId?: string
  /** Return each message's html_body + full wire columns (to/cc, header ids).
   *  Default FALSE — the slim text-only view: a reader that already gets the
   *  body as text never needs its HTML duplicate, which multiplies a long
   *  thread's payload several-fold. The web UI opts in (it renders HTML). */
  includeHtml?: boolean
  /** Strip each body's quoted reply-chain tail ("On … wrote:", "> " pyramids).
   *  Default TRUE — the quoted tail re-embeds the entire prior conversation
   *  inside every message, pure duplication of the thread's own earlier rows.
   *  Pass false to read full chains. */
  stripQuoted?: boolean
}

interface GetResult {
  ticket: Record<string, unknown> | null
  messages: { items: Array<Record<string, unknown>>; nextCursor: string | null }
  /** Total messages on the ticket — a bounded read still reports the real
   *  thread size (page older messages via messagesCursor). */
  totalMessageCount: number
}

/**
 * `actor` carries the REAL caller identity/scopes/dimensionGrants/roleIds
 * used to resolve free-text matches through the shared search executor (spec
 * §3.5). It is OPTIONAL only because every existing call with a non-empty
 * free-text `q` must supply it going forward — a call site with a query and
 * no actor throws before touching Meili (see below) rather than silently
 * defaulting to an empty-grant actor, which would produce a permission-
 * scoped-wrong (typically empty) result set for a real user. Callers that
 * never pass `q`/`query` (pure relational listings, countOnly sweeps, the
 * existing `search.*.test.ts` fixtures) are unaffected and need no actor.
 */
export async function searchTickets(
  tx: SqlClient,
  orgId: string,
  params: SearchParams,
  actor?: TicketSearchActor,
): Promise<SearchResult> {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100)
  // Aging threshold (whole days) for the per-row `aging` boolean. Default 3 (the common "aging past 3
  // days" backlog-health window); clamped to a non-negative integer so a bad value can never inject SQL
  // or produce a nonsense comparison. The server does the per-ticket discrimination so the agent renders
  // the boolean instead of recomputing it.
  const agingThresholdDays = Math.max(
    0,
    Math.floor(
      Number.isFinite(params.agingThresholdDays) ? (params.agingThresholdDays as number) : 3,
    ),
  )
  // Customer-silence threshold (whole days) for the per-row `customerSilent` boolean. Default 7 (the
  // standard "no customer reply for 7+ days" auto-close window); clamped to a non-negative integer so a
  // bad value can never inject SQL or produce a nonsense comparison. The server does the per-ticket
  // staleness discrimination (days since last_inbound_at >= threshold) so the auto-close tick RENDERS the
  // boolean instead of recomputing the last-inbound age in-context (where a weak model acted on fresh
  // tickets) — the same lever as agingThresholdDays/aging.
  const silentForDays = Math.max(
    0,
    Math.floor(Number.isFinite(params.silentForDays) ? (params.silentForDays as number) : 7),
  )
  // D1 join rewrite note: every bare column reference below MUST be qualified
  // with the tickets-table alias (T) — the LEFT JOINs to kernel.users /
  // kernel.contacts / app_tickets.categories bring their OWN org_id/status/
  // created_at/priority-shaped columns into scope, so an unqualified
  // `org_id`/`status`/etc. is ambiguous once those joins are in the FROM
  // clause (Postgres: "column reference is ambiguous").
  const T = ticketsRel("tickets")
  const conditions: ReturnType<typeof drizzleSql>[] = [drizzleSql`${T}.org_id = ${orgId}`]
  const priorityRank = drizzleSql`CASE ${T}.priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'normal' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`
  const urgencyRank = drizzleSql`CASE
    WHEN ${T}.first_response_at IS NULL AND ${T}.sla_deadline <= now() THEN 400 + ${priorityRank}
    WHEN ${T}.followup_at IS NOT NULL AND ${T}.followup_at <= now() THEN 300 + ${priorityRank}
    WHEN ${T}.last_inbound_at IS NOT NULL AND (${T}.last_outbound_at IS NULL OR ${T}.last_inbound_at > ${T}.last_outbound_at) THEN 200 + ${priorityRank}
    WHEN ${T}.first_response_at IS NULL AND ${T}.sla_deadline <= now() + (${T}.sla_target_seconds * 0.25 * INTERVAL '1 second') THEN 100 + ${priorityRank}
    ELSE ${priorityRank}
  END`
  let orderBy = drizzleSql`${T}.last_message_at DESC NULLS LAST, ${priorityRank} DESC, ${T}.id DESC`

  if (
    (!params.includeMerged && !params.includeMergedSources && params.smartFilter !== "closed") ||
    params.excludeMergedSources
  ) {
    conditions.push(drizzleSql`${T}.merged_into_ticket_id IS NULL`)
  }
  // Accept either a single value or an array — agent-driven callers tend to
  // pass scalars (matching the conventional JSON-schema shape) while UI
  // multi-select callers send arrays. Normalize before building the IN clause.
  const statusValues = Array.isArray(params.status)
    ? params.status
    : params.status
      ? [params.status]
      : []
  if (statusValues.length > 0) {
    const list = drizzleSql.join(
      statusValues.map((s) => drizzleSql`${s}`),
      drizzleSql`, `,
    )
    conditions.push(drizzleSql`${T}.status IN (${list})`)
  }
  const priorityValues = Array.isArray(params.priority)
    ? params.priority
    : params.priority
      ? [params.priority]
      : []
  if (priorityValues.length > 0) {
    const list = drizzleSql.join(
      priorityValues.map((p) => drizzleSql`${p}`),
      drizzleSql`, `,
    )
    conditions.push(drizzleSql`${T}.priority IN (${list})`)
  }
  // Language filter (server-side): accept a single code or an array, case-insensitive on the tagged
  // `language` column. Lets a routine digest "my EU-language tickets" via language:['fr','de','it']
  // instead of fragile in-context language detection per body (which leaks English/other tickets into
  // an EU-language backlog). Codes are lowercased both sides so 'FR'/'fr' both match.
  const languageValues = Array.isArray(params.language)
    ? params.language
    : params.language
      ? [params.language]
      : []
  if (languageValues.length > 0) {
    const list = drizzleSql.join(
      languageValues.map((l) => drizzleSql`${l.toLowerCase()}`),
      drizzleSql`, `,
    )
    conditions.push(drizzleSql`lower(${T}.language) IN (${list})`)
  }
  const audienceValues = Array.isArray(params.audience)
    ? params.audience
    : params.audience
      ? [params.audience]
      : []
  if (audienceValues.length > 0) {
    const list = drizzleSql.join(
      audienceValues.map((a) => drizzleSql`${a}`),
      drizzleSql`, `,
    )
    conditions.push(drizzleSql`${T}.audience IN (${list})`)
  }

  const teamValues = Array.isArray(params.team) ? params.team : params.team ? [params.team] : []
  if (teamValues.length > 0) {
    const list = drizzleSql.join(
      teamValues.map((t) => drizzleSql`${t}`),
      drizzleSql`, `,
    )
    conditions.push(drizzleSql`${T}.team IN (${list})`)
  }
  if (params.contactId) {
    conditions.push(drizzleSql`${T}.contact_id = ${params.contactId}`)
  }
  if (params.assignedTo) {
    // The manifest documents `assignedTo: "User UUID, or 'me' for the calling user"`, but the handler
    // previously filtered `assigned_to = 'me'` LITERALLY — matching nothing, so an agent that followed
    // the documented `'me'` (or that runs AS a user, e.g. a routine tick, and does not know its own
    // UUID) got an EMPTY result and reported "you have no assigned tickets" on a non-empty queue. That
    // is the assignee-scope FALSE-EMPTY caught by the liam-weekly-eu-language-backlog runtime gate (the
    // tick searched its OWN queue, passed 'me'/a hallucinated UUID, and got nothing). Resolve the self
    // sentinels (`me` / `self` / `@me`) to the actor's userId so the documented contract actually holds;
    // when there is no actor context to resolve against, fall back to an impossible id (empty, never a
    // silent whole-org read) rather than filtering on the literal sentinel.
    const wantedAssignee = params.assignedTo.trim()
    const isSelfSentinel = /^(@?me|self)$/i.test(wantedAssignee)
    const resolvedAssignee = isSelfSentinel
      ? (params.actorUserId ?? "00000000-0000-0000-0000-000000000000")
      : wantedAssignee
    conditions.push(drizzleSql`${T}.assigned_to = ${resolvedAssignee}`)
  }
  const sourceInboxId = params.sourceInboxId ?? params.inboxId
  if (sourceInboxId) {
    conditions.push(drizzleSql`${T}.source_inbox_id = ${sourceInboxId}`)
  }
  if (params.closedAfter)
    conditions.push(drizzleSql`${T}.updated_at >= ${params.closedAfter}::timestamptz`)
  // followup:'scheduled' = every ticket with a scheduled follow-up (past OR future). followup:'due' =
  // ONLY the follow-ups that are DUE NOW (followup_at already in the past) — the server does the
  // due-ness filter so a "draft the follow-ups I owe today" routine tick gets EXACTLY the due set in ONE
  // call and CANNOT mis-pick due vs not-yet-due in-context (the inverted-discrimination failure the
  // vip-mailbox-followup-scheduler runtime gate caught: a flash-lite tick that read the mixed
  // scheduled set drafted for the FUTURE-dated items and skipped the due ones). 'due' is the
  // can't-get-it-wrong scope for that sweep; 'scheduled' stays available for a digest that wants both.
  if (params.followup === "scheduled") conditions.push(drizzleSql`${T}.followup_at IS NOT NULL`)
  else if (params.followup === "due")
    conditions.push(drizzleSql`(${T}.followup_at IS NOT NULL AND ${T}.followup_at <= now())`)
  if (params.smartFilter) {
    switch (params.smartFilter) {
      case "all-open":
        conditions.push(drizzleSql`${T}.status IN ('open','awaiting_customer','awaiting_followup')`)
        orderBy = drizzleSql`${T}.last_message_at DESC NULLS LAST, ${priorityRank} DESC, ${T}.id DESC`
        break
      case "my-backlog":
        // "My backlog / my open tickets / my assigned queue" in ONE param: the WHOLE non-closed set
        // (open + awaiting_customer + awaiting_followup) ASSIGNED TO THE CALLER. This is the
        // single-call, can't-get-it-wrong scope for a routine that runs AS its owner and must digest
        // "my tickets" — no assignee UUID to know, no 'me' sentinel to remember, no whole-org read to
        // accidentally fall into. Auto-scoped to actorUserId; falls back to an impossible id (empty,
        // never a silent whole-org read) when there is no actor context. Each returned row still carries
        // the `aging` boolean + status + categoryName so the digest groups + flags from one read.
        conditions.push(drizzleSql`${T}.status IN ('open','awaiting_customer','awaiting_followup')`)
        conditions.push(
          drizzleSql`${T}.assigned_to = ${params.actorUserId ?? "00000000-0000-0000-0000-000000000000"}`,
        )
        orderBy = drizzleSql`${T}.last_message_at DESC NULLS LAST, ${priorityRank} DESC, ${T}.id DESC`
        break
      case "awaiting-customer":
        conditions.push(drizzleSql`${T}.status = 'awaiting_customer'`)
        orderBy = drizzleSql`${T}.last_message_at DESC NULLS LAST, ${priorityRank} DESC, ${T}.id DESC`
        break
      case "needs-attention":
        // "Needs attention" = the ball is in OUR court: a non-closed ticket whose
        // LAST message is inbound (the customer wrote or opened it and we owe the
        // next reply). This is defined by message DIRECTION, not status: a ticket
        // where WE replied last (last message outbound) is "awaiting customer" and
        // must NOT appear here, whatever its status label. Keying on direction also
        // makes this immune to status-transition quirks (e.g. a customer reply that
        // didn't flip the status field) -- if the customer has the last word, it
        // needs attention. Unanswered tickets have last_outbound_at NULL, so they
        // are included too (they're the customer's opening message).
        // awaiting_followup is the ONE status that overrides direction: a human
        // explicitly deferred the ticket, so it lives in Follow-ups until the
        // follow-up comes due (followupCron flips it back to open) or the
        // customer writes again (an inbound message clears the follow-up and
        // reopens) -- both paths put it back in this view via status change.
        conditions.push(drizzleSql`${T}.status NOT IN ('closed','awaiting_followup')`)
        conditions.push(
          drizzleSql`(${T}.last_inbound_at IS NOT NULL AND (${T}.last_outbound_at IS NULL OR ${T}.last_inbound_at > ${T}.last_outbound_at))`,
        )
        // Monitoring inboxes (inboxes.suppress_attention, e.g. automated bug
        // reports) never need a reply — keep them out of the sweep that
        // mirrors the attention feed. Explicit filters/free text still find them.
        conditions.push(
          drizzleSql`(${T}.source_inbox_id IS NULL OR ${T}.source_inbox_id NOT IN (
            SELECT id FROM ${ticketsRel("inboxes")}
            WHERE org_id = ${orgId} AND suppress_attention = true
          ))`,
        )
        orderBy = drizzleSql`${urgencyRank} DESC, ${T}.last_message_at DESC NULLS LAST, ${priorityRank} DESC, ${T}.id DESC`
        break
      case "follow-ups":
        // Status-only: a ticket can await a follow-up with NO schedulable date (e.g.
        // waiting on a restock with an unknown arrival) -- it still belongs in the
        // Follow-ups view. Callers that want only the DATED subset pass
        // followup:'scheduled' (or 'due') explicitly. Undated rows sort after the
        // dated ones (NULLS LAST), then by priority/activity.
        conditions.push(drizzleSql`${T}.status = 'awaiting_followup'`)
        orderBy = drizzleSql`${T}.followup_at ASC NULLS LAST, ${priorityRank} DESC, ${T}.last_message_at DESC NULLS LAST, ${T}.id DESC`
        break
      case "closed":
        conditions.push(drizzleSql`${T}.status = 'closed'`)
        conditions.push(drizzleSql`${T}.updated_at >= now() - interval '30 days'`)
        orderBy = drizzleSql`${T}.updated_at DESC, ${T}.last_message_at DESC NULLS LAST, ${T}.id DESC`
        break
    }
  }
  // Explicit sort OVERRIDES the smartFilter's implicit order. `oldest`/`newest`
  // order by created_at (the real ticket-open time) so an "oldest open tickets"
  // backlog read gets the GLOBAL N oldest in one bounded call instead of paging
  // the whole relevance-ordered set. The keyset cursor below switches its column
  // to match (created_at vs last_message_at) so pagination stays correct.
  const sortMode:
    | "oldest"
    | "newest"
    | "recently_updated"
    | "activity_newest"
    | "activity_oldest"
    | null = params.sort ?? null
  if (sortMode === "oldest") {
    orderBy = drizzleSql`${T}.created_at ASC NULLS LAST, ${T}.id ASC`
  } else if (sortMode === "newest") {
    orderBy = drizzleSql`${T}.created_at DESC NULLS LAST, ${T}.id DESC`
  } else if (sortMode === "recently_updated" || sortMode === "activity_newest") {
    // Last message (inbound OR outbound), newest first -- the inbox default. This is
    // the same key the row's "last activity" date shows, so list order and the
    // visible timestamp always agree. `recently_updated` is the legacy alias.
    orderBy = drizzleSql`${T}.last_message_at DESC NULLS LAST, ${priorityRank} DESC, ${T}.id DESC`
  } else if (sortMode === "activity_oldest") {
    // Last message, oldest first -- the longest-untouched-first order (Needs
    // attention uses it to surface tickets closest to an SLA breach).
    orderBy = drizzleSql`${T}.last_message_at ASC NULLS LAST, ${T}.id ASC`
  }

  // Resolve a category NAME (or UUID) passed via the `category` param into a
  // categoryId filter — the same ergonomics setCategory offers, so an agent can
  // ask for "shipping tickets" without first looking up the category UUID. A
  // non-UUID string is matched case-insensitively against the org's categories;
  // an unknown name resolves to NO match (a sentinel impossible id) rather than a
  // 500 or — worse — silently dropping the filter and returning unrelated rows.
  if (typeof params.category === "string" && params.category.trim().length > 0) {
    const wanted = params.category.trim()
    if (UUID_RE.test(wanted)) {
      conditions.push(drizzleSql`${T}.category_id = ${wanted}`)
    } else {
      const catResult = await tx.execute(drizzleSql`
        SELECT id FROM ${ticketsRel("categories")}
        WHERE org_id = ${orgId} AND lower(name) = lower(${wanted})
        LIMIT 1
      `)
      const catId = extractRows<{ id: string }>(catResult)[0]?.id ?? null
      conditions.push(
        catId
          ? drizzleSql`${T}.category_id = ${catId}`
          : drizzleSql`${T}.category_id = '00000000-0000-0000-0000-000000000000'`,
      )
    }
  }
  if (params.categoryId) {
    conditions.push(drizzleSql`${T}.category_id = ${params.categoryId}`)
  }
  if (params.categoryIdIncludingChildren) {
    conditions.push(drizzleSql`
      ${T}.category_id IN (
        WITH RECURSIVE descendants AS (
          SELECT id FROM ${ticketsRel("categories")} WHERE id = ${params.categoryIdIncludingChildren} AND org_id = ${orgId}
          UNION ALL
          SELECT c.id FROM ${ticketsRel("categories")} c
          JOIN descendants d ON c.parent_id = d.id
          WHERE c.org_id = ${orgId}
        )
        SELECT id FROM descendants
      )
    `)
  }
  if (params.slaApproaching) {
    conditions.push(
      drizzleSql`${T}.sla_deadline <= now() + (${T}.sla_target_seconds * 0.25 * INTERVAL '1 second')`,
    )
    conditions.push(drizzleSql`${T}.first_response_at IS NULL`)
  }
  // slaBreached: the ticket is ALREADY past its SLA deadline (an open ticket "aging past SLA"), the
  // grounded signal for a relationship-risk readout. Unlike slaApproaching (which is for not-yet-
  // answered tickets nearing their deadline and therefore requires first_response_at IS NULL), a
  // breach is true whether or not we have replied — match on sla_breached_at (the recorded breach
  // timestamp) OR a deadline already in the past on a still-active SLA (paused-state defensive).
  if (params.slaBreached) {
    // A NULL sla_deadline is an SLA-exempt ticket (suppress_attention inbox, e.g.
    // bug reports) — no SLA, so never "breached", even with a stale breach stamp.
    conditions.push(
      drizzleSql`(${T}.sla_deadline IS NOT NULL AND (${T}.sla_breached_at IS NOT NULL OR (${T}.sla_deadline < now() AND ${T}.sla_paused_at IS NULL)))`,
    )
  }
  // Free-text search (unified-search retarget, spec §3.5): the tickets
  // manifest documents `q`/`query` as "free-text search across subject and
  // body". Matching now goes entirely through the shared search executor's
  // `ids` projection (resolveTicketMatches) against the enriched Meili
  // document (subject + handle + linked contact name/email + message body) —
  // the SAME matching definition `/search` and `/search/page` use, so the
  // inbox and global search can no longer disagree (spec §1/§3). The old
  // per-term ILIKE clauses (subject/handle/contact/ticket_ids_matching_text)
  // and the AND-then-OR recall fallback are DELETED: Meili's words-ranking
  // already ranks fuller matches first and a partial-term match still
  // surfaces (spec §2 "Matching-semantics change").
  //
  // Every relational filter/sort/cursor/computed-field/RLS behavior below is
  // UNCHANGED — only the text-match predicate changes shape, from a SQL
  // ILIKE clause to a `T.id IN (ids)` membership test over the executor's
  // ranked id list. This still selects from `tickets` under the FULL ticket
  // RLS policy (via `tx`), so an id the caller cannot see never surfaces even
  // if it were somehow present in the Meili result — defense in depth
  // identical in spirit to the 0019 helper design (spec §3.5/§6).
  const rawQuery = (params.q ?? params.query)?.trim()
  const hasQuery = !!rawQuery && rawQuery.length > 0

  // A ticket handle (`ticket-4637`, or its display form `ticket-B2B-4637`) is how people and agents name a ticket, so
  // it resolves by exact key on the (org_id, handle) unique index, under the
  // caller's RLS `tx`. It must NOT reach Meili: the tokenizer splits it into
  // `ticket` + `4637`, and `ticket` is in every ticket's indexed handle, so the
  // executor returned the whole org (4 747 ids on the Acme box) and the
  // page query over that IN-list ran past the sandbox time budget.
  const handleQuery = hasQuery ? asTicketHandle(rawQuery as string) : null
  // The ticket's uuid names it as surely as its handle (tickets:get resolves
  // it), and Meili indexes no uuid: a full-text search for one found nothing
  // (TIC-04). It resolves by primary key, under the same RLS `tx`.
  const uuidQuery = hasQuery && !handleQuery && UUID_RE.test(rawQuery as string) ? rawQuery : null

  let matchedTicketIds: string[] | null = null
  if (uuidQuery) {
    const hit = extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${ticketsRel("tickets")}
        WHERE org_id = ${orgId} AND id = ${(uuidQuery as string).toLowerCase()}::uuid
        LIMIT 1
      `),
    )[0]
    matchedTicketIds = hit ? [hit.id] : []
    if (matchedTicketIds.length === 0) {
      return { items: [], nextCursor: null, totalCount: 0 }
    }
  } else if (handleQuery) {
    // Any display form resolves by NUMBER (`ticket-B2B-12` and a stale
    // `ticket-B2C-12` both name the ticket stored as `ticket-12`), exact
    // stored match first.
    const hit = await lookupTicketIdByHandle(tx, orgId, handleQuery)
    matchedTicketIds = hit ? [hit] : []
    if (matchedTicketIds.length === 0) {
      return { items: [], nextCursor: null, totalCount: 0 }
    }
  } else if (hasQuery) {
    if (!actor) {
      // A non-empty free-text query with no actor context is a caller bug,
      // not a permission edge case: every real entry point (rpc-bridge's
      // tickets_search) has a real ActorContext available. Fail loudly rather
      // than silently resolving against an empty-grant actor, which would
      // return a wrong (typically empty) result set that looks like "no
      // matches" instead of a misconfigured call site.
      throw new Error(
        "searchTickets: a non-empty free-text query requires an actor (scopes/dimensionGrants/roleIds) to resolve matches",
      )
    }
    try {
      matchedTicketIds = await resolveTicketMatchIds(orgId, actor, rawQuery as string)
    } catch (err) {
      throw new TicketSearchUnavailableError(
        err instanceof Error
          ? err.message
          : "Search is temporarily unavailable. Try again shortly.",
      )
    }
    // Mandatory explicit short-circuit (spec §3.5/§7): zero matches means the
    // page AND total are both empty WITHOUT running the page/count query —
    // never emit `T.id IN ()` (SQL syntax error) and never lean on the query
    // builder's own empty-list behavior.
    if (matchedTicketIds.length === 0) {
      return { items: [], nextCursor: null, totalCount: 0 }
    }
  }
  const textClause = matchedTicketIds
    ? drizzleSql`${T}.id IN (${drizzleSql.join(
        matchedTicketIds.map((id) => drizzleSql`${id}::uuid`),
        drizzleSql`, `,
      )})`
    : null

  // Exhaustive-sweep substrate: a server COUNT(*) over the SAME filter the page
  // uses — ALWAYS returned (the contacts/users/mail `totalCount` convention),
  // on EVERY page including cursor pages (search.total.test.ts pins this).
  // Computed BEFORE the keyset-cursor clause is appended, since the cursor only
  // PAGES and must never shrink the reported total. With a free-text query the
  // total is the count of the RESOLVED id set (bounded by the executor's
  // maxTotalHits ceiling) — an accepted divergence from the old exact COUNT
  // once a query exceeds that ceiling (spec §7). `countOnly` skips the page
  // fetch — the cheap countdown read; that branch is untouched below.
  const countAll = textClause ? [...conditions, textClause] : conditions
  const countWhere = drizzleSql.join(countAll, drizzleSql.raw(" AND "))
  const runCount = () =>
    tx
      .execute(
        drizzleSql`SELECT COUNT(*)::int AS total FROM ${ticketsRel("tickets")} WHERE ${countWhere}`,
      )
      .then((result) => extractRows<{ total: number }>(result)[0]?.total ?? 0)

  if (params.countOnly) {
    const totalCount = await runCount()
    return { items: [], nextCursor: null, totalCount }
  }

  if (params.cursor) {
    const cursor = decodeKeysetCursor(params.cursor)
    if (sortMode === "oldest" || sortMode === "newest") {
      // created_at keyset — matches the created_at ORDER BY. `oldest` paginates
      // forward with `>` (ascending), `newest` with `<` (descending).
      if (typeof cursor.createdAt !== "string" || typeof cursor.id !== "string") {
        throw new Error("invalid_cursor")
      }
      conditions.push(
        sortMode === "oldest"
          ? drizzleSql`(${T}.created_at, ${T}.id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
          : drizzleSql`(${T}.created_at, ${T}.id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      )
    } else if (sortMode === "activity_oldest") {
      // last_message_at ASC keyset — paginates forward with `>` (ascending).
      if (typeof cursor.lastMessageAt !== "string" || typeof cursor.id !== "string") {
        throw new Error("invalid_cursor")
      }
      conditions.push(
        drizzleSql`(${T}.last_message_at, ${T}.id) > (${cursor.lastMessageAt}::timestamptz, ${cursor.id}::uuid)`,
      )
    } else {
      // last_message_at DESC keyset (default / recently_updated / activity_newest).
      if (typeof cursor.lastMessageAt !== "string" || typeof cursor.id !== "string") {
        throw new Error("invalid_cursor")
      }
      conditions.push(drizzleSql`
        (${T}.last_message_at, ${T}.id) < (${cursor.lastMessageAt}::timestamptz, ${cursor.id}::uuid)
      `)
    }
  }

  // D1 de-correlation: the five per-row scalar subqueries (category name,
  // assignee name, contact name/email, latest-message snippet) each re-ran
  // once PER TICKET ROW. category/assignee/contact are single-row lookups by
  // primary key, so they become plain LEFT JOINs; the snippet is the only
  // one-of-many-candidates lookup, so it becomes a LEFT JOIN LATERAL bounded
  // by LIMIT 1, served by the existing (ticket_id, sent_at) index — same
  // result shape (NULL when there's no match), just one join plan instead of
  // N re-executions of a correlated subplan.
  const runQuery = async () => {
    const all = textClause ? [...conditions, textClause] : conditions
    const whereClause = drizzleSql.join(all, drizzleSql.raw(" AND "))
    const result = await tx.execute(drizzleSql`
      SELECT ${ticketsRel("tickets")}.*,
        ${urgencyRank} AS urgency_rank,
        -- Server-computed whole-days-open age (the SAME formula backlogHealth.oldest uses). An agent
        -- asked to flag tickets 'aging past N days' can then compare this integer to N directly instead
        -- of doing fragile in-context date arithmetic over created_at (which a weak model mis-computed —
        -- flagging equal-age tickets inconsistently, or claiming every ticket was created 'today'). This
        -- is a derived convenience field; created_at is still returned for any finer-grained need.
        FLOOR(EXTRACT(EPOCH FROM (now() - ${ticketsRel("tickets")}.created_at)) / 86400)::int AS age_days,
        -- Server-computed per-row aging DISCRIMINATION: true iff the ticket is OLDER than the threshold
        -- (age_days > agingThresholdDays, default 3). The model RENDERS this boolean into the digest —
        -- it no longer has to compute the per-ticket comparison in-context (the failing clause where a
        -- weak model flagged everything/nothing or inverted the set). Moving the discrimination
        -- server-side is the whole point: the tick copies a boolean, it does not do arithmetic.
        (FLOOR(EXTRACT(EPOCH FROM (now() - ${ticketsRel("tickets")}.created_at)) / 86400)::int > ${agingThresholdDays}) AS aging,
        -- Server-computed follow-up DUE-ness: NULL when there is no scheduled follow-up (so the
        -- projection maps it to undefined, never a misleading false); else true iff the scheduled
        -- followup_at is already in the PAST (due now) and false iff it is in the FUTURE (not yet due).
        -- The model RENDERS this boolean to pick the DUE follow-ups for a draft-due-follow-ups sweep
        -- (vip-mailbox-followup-scheduler) instead of comparing the followup_at ISO timestamp to now()
        -- in-context -- a flash-lite tick mis-computes ISO-date arithmetic, so the discrimination moves
        -- server-side (the l710 lesson: the tick copies a boolean, it does not do date math).
        CASE WHEN ${ticketsRel("tickets")}.followup_at IS NULL THEN NULL
             ELSE (${ticketsRel("tickets")}.followup_at <= now()) END AS followup_due,
        -- Server-computed whole-days-since-LAST-INBOUND-customer-message (last_inbound_at). NULL when the
        -- ticket has no inbound customer message ever (so the projection maps it to undefined, never a
        -- misleading 0). For an awaiting_customer ticket this is the CUSTOMER-SILENCE age the auto-close
        -- routine needs — days since the customer last wrote.
        CASE WHEN ${ticketsRel("tickets")}.last_inbound_at IS NULL THEN NULL
             ELSE FLOOR(EXTRACT(EPOCH FROM (now() - ${ticketsRel("tickets")}.last_inbound_at)) / 86400)::int
        END AS customer_silent_days,
        -- Server-computed per-row STALENESS DISCRIMINATION: NULL when there is no inbound customer message
        -- (undefined → never a false-stale); else true iff the customer has been silent for >= silentForDays
        -- (last_inbound_at older than the threshold) and false iff they replied more recently. The
        -- auto-close routine tick RENDERS this boolean to pick the STALE awaiting_customer tickets instead
        -- of recomputing the last-inbound age in-context (the failing clause where a flash-lite tick acted
        -- on FRESH 1-2-day tickets, applying a "we haven't heard from you in over a week" notice to a
        -- customer who just replied). Moving the discrimination server-side is the whole point: the tick
        -- copies a boolean, it does not do date arithmetic (the same lever as aging/followup_due).
        CASE WHEN ${ticketsRel("tickets")}.last_inbound_at IS NULL THEN NULL
             ELSE (${ticketsRel("tickets")}.last_inbound_at <= now() - (${silentForDays} * INTERVAL '1 day'))
        END AS customer_silent,
        ticket_category.name AS category_name,
        ticket_assignee.name AS assignee_name,
        -- Inbox row contact (resolved/created by email at ticket creation). The list
        -- shows contact.name ?? contact.email; without these the inbox reads "No contact"
        -- even though contact_id is set.
        ticket_contact.name AS contact_name,
        ticket_contact.email AS contact_email,
        -- Inbox row preview: the latest CONVERSATION message's snippet, falling
        -- back to the first 200 chars of its text (or tag-stripped HTML) when no
        -- snippet was stored (e.g. imported messages persist text_body but no
        -- snippet). Acknowledgement sends are excluded: they are system
        -- boilerplate hidden from the conversation view, so the list preview must
        -- not surface "We have received your request..." as the ticket's latest
        -- activity (it would mask the real customer message on every new ticket).
        latest_message.snippet AS snippet
      FROM ${ticketsRel("tickets")}
      LEFT JOIN ${ticketsRel("categories")} ticket_category
        ON ticket_category.id = ${ticketsRel("tickets")}.category_id
        AND ticket_category.org_id = ${orgId}
      LEFT JOIN ${kernelRel("users")} ticket_assignee
        ON ticket_assignee.id = ${ticketsRel("tickets")}.assigned_to
        AND ticket_assignee.org_id = ${orgId}
      LEFT JOIN ${kernelRel("contacts")} ticket_contact
        ON ticket_contact.id = ${ticketsRel("tickets")}.contact_id
        AND ticket_contact.org_id = ${orgId}
      LEFT JOIN LATERAL (
        SELECT COALESCE(
          m.snippet,
          left(m.text_body, 200),
          left(regexp_replace(COALESCE(m.html_body, ''), '<[^>]+>', ' ', 'g'), 200)
        ) AS snippet
        FROM ${ticketsRel("messages")} m
        WHERE m.ticket_id = ${ticketsRel("tickets")}.id
          AND m.is_acknowledgement = false
        ORDER BY m.sent_at DESC NULLS LAST, m.created_at DESC
        LIMIT 1
      ) AS latest_message ON true
      WHERE ${whereClause}
      ORDER BY ${orderBy}
      LIMIT ${limit + 1}
    `)
    return extractRows<Record<string, unknown>>(result)
  }

  const [totalCount, rows] = await Promise.all([runCount(), runQuery()])
  // Multi-term free-text ranking (nachumi-shaped queries, "return ORDER
  // #2936") is entirely Meili's words-ranking now — documents matching more
  // terms rank first, partial-term matches still surface — so no AND/OR
  // two-pass SQL recall widening is needed here (spec §2 "Matching-semantics
  // change", §7 "Multi-term query"). The DELETED AND/OR fallback used to live
  // in this exact spot.
  const items = rows.slice(0, limit)
  let nextCursor: string | null = null
  if (rows.length > limit) {
    if (sortMode === "oldest" || sortMode === "newest") {
      const last = items[items.length - 1] as { created_at: Date | string | null; id: string }
      if (last) {
        nextCursor = encodeKeysetCursor({
          createdAt:
            last.created_at instanceof Date
              ? last.created_at.toISOString()
              : (last.created_at ?? new Date(0).toISOString()),
          id: last.id,
        })
      }
    } else {
      // last_message_at keyset — default / recently_updated / activity_newest / activity_oldest.
      const last = items[items.length - 1] as {
        last_message_at: Date | string | null
        id: string
      }
      if (last) {
        nextCursor = encodeKeysetCursor({
          lastMessageAt:
            last.last_message_at instanceof Date
              ? last.last_message_at.toISOString()
              : (last.last_message_at ?? new Date(0).toISOString()),
          id: last.id,
        })
      }
    }
  }
  return { items, nextCursor, totalCount }
}

export async function getTicket(
  tx: SqlClient,
  orgId: string,
  params: GetParams,
): Promise<GetResult | { error: TicketRefError }> {
  // Agents see (and pass) the `ticket-<n>` HANDLE far more often than the row
  // uuid; binding it raw into the uuid column made Postgres throw. Resolve
  // first, then every query below uses the uuid.
  const ref = await resolveTicketRef(tx, orgId, params.ticketId)
  if (!ref.ok) return { error: ref.error }
  const ticketId = ref.ticketId
  const ticketResult = await tx.execute(
    drizzleSql`SELECT *,
        (
          SELECT c.name FROM ${ticketsRel("categories")} c
          WHERE c.id = ${ticketsRel("tickets")}.category_id
            AND c.org_id = ${orgId}
        ) AS category_name,
        (
          SELECT ct.name FROM ${kernelRel("contacts")} ct
          WHERE ct.id = ${ticketsRel("tickets")}.contact_id
            AND ct.org_id = ${orgId}
        ) AS contact_name,
        (
          SELECT ct.email FROM ${kernelRel("contacts")} ct
          WHERE ct.id = ${ticketsRel("tickets")}.contact_id
            AND ct.org_id = ${orgId}
        ) AS contact_email,
        (
          SELECT u.name FROM ${kernelRel("users")} u
          WHERE u.id = ${ticketsRel("tickets")}.assigned_to
            AND u.org_id = ${orgId}
        ) AS assignee_name
      FROM ${ticketsRel("tickets")} WHERE id = ${ticketId} AND org_id = ${orgId} LIMIT 1`,
  )
  const ticket = extractRows<Record<string, unknown>>(ticketResult)[0] ?? null

  // Slim by default: 12 recent messages, text-only, quoted history stripped.
  // Rationale: this tool is the agent's primary thread read, and its output is
  // re-shipped to the model on EVERY subsequent step of a run — a 39-message
  // full read (both bodies, full quote chains) measured ~213k chars and alone
  // consumed most of a run's token budget. The web UI passes
  // { messagesLimit: 15, includeHtml: true, stripQuoted: true } and lazily
  // re-fetches a single message untrimmed (messageId + stripQuoted: false)
  // when the reader expands its quoted history.
  const includeHtml = params.includeHtml === true
  const stripQuoted = params.stripQuoted !== false
  const messagesLimit = Math.min(Math.max(params.messagesLimit ?? 12, 1), 100)
  const msgConditions: ReturnType<typeof drizzleSql>[] = [
    drizzleSql`ticket_id = ${ticketId}`,
    drizzleSql`org_id = ${orgId}`,
  ]
  // Single-message drill-down: full body, never trimmed (asking for one exact
  // message IS the opt-in to its full content).
  const singleMessage = typeof params.messageId === "string" && params.messageId.length > 0
  if (singleMessage) {
    msgConditions.push(drizzleSql`id = ${params.messageId}`)
  }
  if (params.messagesCursor) {
    const cursor = decodeKeysetCursor(params.messagesCursor)
    if (typeof cursor.sentAt !== "string" || typeof cursor.id !== "string") {
      throw new Error("invalid_cursor")
    }
    msgConditions.push(
      drizzleSql`(sent_at, id) < (${cursor.sentAt}::timestamptz, ${cursor.id}::uuid)`,
    )
  }
  const msgWhere = drizzleSql.join(msgConditions, drizzleSql.raw(" AND "))
  const msgResult = await tx.execute(drizzleSql`
    SELECT m.*,
      COALESCE(
        -- An agent drafted it: the agent is the author, under its CURRENT name.
        -- created_by is only the human the call executed as (a routine runs as
        -- its owner, an approval as its requester).
        (SELECT a.display_name FROM ${kernelRel("agents")} a
         WHERE a.id = m.author_agent_id AND a.org_id = ${orgId}),
        -- The Liaison user who sent this message (outbound replies, notes).
        -- The conversation view shows THIS as the author of agent-authored
        -- rows; from_email/from_name stay the email-wire identity.
        (SELECT u.name FROM ${kernelRel("users")} u
         WHERE u.id = m.created_by AND u.org_id = ${orgId})
      ) AS author_name,
      (
        -- Who APPROVED a gated send. An approved handler runs as the REQUESTER,
        -- so created_by is the drafter and this is the authoriser; the
        -- conversation shows both. Null on a direct send.
        SELECT u.name FROM ${kernelRel("users")} u
        WHERE u.id = m.approved_by AND u.org_id = ${orgId}
      ) AS approver_name
    FROM ${ticketsRel("messages")} m
    WHERE ${msgWhere}
    ORDER BY m.sent_at DESC, m.id DESC
    LIMIT ${messagesLimit + 1}
  `)
  const mRows = extractRows<Record<string, unknown>>(msgResult)
  const messages = mRows.slice(0, messagesLimit).map((row) => {
    // A reply written in Liaison holds only what was written: a quote in it is
    // part of the reply, never a history tail to trim.
    const trim = stripQuoted && !singleMessage && !(row.kind === "outbound" && row.created_by)
    if (includeHtml) {
      let htmlBody = row.html_body
      let textBody = row.text_body
      // Rich view can still opt into quote trimming (the web UI does, to keep
      // huge threads loadable): cut each body's quoted tail, leaving the
      // QUOTE_TRIMMED_MARKER so the client can lazily re-fetch this single
      // message untrimmed (messageId + stripQuoted:false) on demand.
      //
      // Order matters for cost: strip FIRST (one cheap regex scan over the raw
      // body), THEN sanitize only the trimmed head. sanitize-html does a full
      // DOM parse per body — running it over 15 x 200-350KB quote chains was a
      // dominant term of prod's 5-10s tickets:get. The quote-boundary classes
      // the stripper matches exist in the raw body too (sanitize preserves
      // `class`, so they were identical either way), and clients detect the
      // elision by the marker TEXT, which sanitize keeps.
      if (trim) {
        if (typeof htmlBody === "string") htmlBody = stripQuotedHtml(htmlBody).html
        if (typeof textBody === "string") textBody = stripQuotedHistory(textBody).text
      }
      if (typeof htmlBody === "string") htmlBody = sanitizeCustomerHtml(htmlBody)
      return { ...row, html_body: htmlBody, text_body: textBody }
    }
    // Slim view: text body only (derived from HTML when text is absent), the
    // columns a reader acts on, and no wire/header metadata.
    const rawText =
      typeof row.text_body === "string" && row.text_body.trim().length > 0
        ? row.text_body
        : typeof row.html_body === "string"
          ? htmlToText(row.html_body)
          : ""
    const body = trim ? stripQuotedHistory(rawText).text : rawText
    return {
      id: row.id,
      ticket_id: row.ticket_id,
      kind: row.kind,
      from_email: row.from_email,
      from_name: row.from_name,
      author_name: row.author_name,
      approver_name: row.approver_name,
      author_label: row.author_label,
      subject: row.subject,
      sent_at: row.sent_at,
      created_by: row.created_by,
      text_body: body,
    }
  })
  let nextCursor: string | null = null
  if (mRows.length > messagesLimit) {
    const last = messages[messages.length - 1] as unknown as { sent_at: Date | string; id: string }
    if (last) {
      nextCursor = encodeKeysetCursor({
        sentAt:
          last.sent_at instanceof Date ? last.sent_at.toISOString() : (last.sent_at as string),
        id: last.id,
      })
    }
  }

  const countResult = await tx.execute(
    drizzleSql`SELECT count(*)::int AS n FROM ${ticketsRel("messages")}
      WHERE ticket_id = ${ticketId} AND org_id = ${orgId}`,
  )
  const totalMessageCount =
    (extractRows<{ n: number }>(countResult)[0]?.n as number | undefined) ?? messages.length

  return { ticket, messages: { items: messages, nextCursor }, totalMessageCount }
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const TicketsSearchTestAccess = {
  setMatchResolver(resolver: typeof ticketMatchResolverOverride): void {
    ticketMatchResolverOverride = resolver
  },
}
