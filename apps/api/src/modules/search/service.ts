// SPDX-License-Identifier: FSL-1.1-ALv2
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { effectiveIndexName, getMeili } from "~/infra/search/client"
import { searchLogger as log } from "~/lib/logger"
import {
  APP_DOCUMENT_ENTITY_TYPE,
  APP_DOCUMENT_SEARCH_REGISTRATION,
  appDocumentSearchReadScopes,
  rejectStaleAppDocumentHits,
} from "~/modules/data-store/search"
import { hasScope } from "~/modules/permissions/permissions"
import { documentId } from "~/modules/search/document-id"
import { isSearchReady } from "~/modules/search/drift"
import { fanoutExternal } from "~/modules/search/external-handlers"
import { attachMentionSecondaryLabels } from "~/modules/search/mention-secondary"
import {
  type MentionType,
  matchesMentionType,
  mentionTypeClause,
  orderRegistrationsForMentionType,
} from "~/modules/search/mention-types"
import { MESSAGE_SEARCH_REGISTRATION } from "~/modules/search/message-indexer"
import {
  buildPermissionFilter,
  normalizeSearchDimensionGrants,
} from "~/modules/search/permission-filter"
import {
  collectSearchableRegistrations,
  type SearchableEntityRegistration,
} from "~/modules/search/searchable-entities"
import { actorSearchKeys } from "~/modules/sharing/service"
import { isMessageVisible } from "~/services/security/visibility"

export class MeiliUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "MeiliUnavailableError"
  }
}

export interface SearchParams {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants?: Record<string, string[]>
  /**
   * Role ids the caller holds (JWT `roles` claim). Threaded into
   * {@link buildPermissionFilter} so entities using the generic ACL search
   * primitive (org_wide + acl_user_ids + acl_role_ids) also honor per-role
   * shares in search, mirroring the sharing RLS policy exactly.
   */
  roleIds?: string[]
  q: string
  limit: number
  /**
   * Per-app opaque cursors from the previous page's response, keyed by app
   * name. Threaded into `fanoutExternal` so each external section (e.g. "From
   * Shopify") paginates independently (spec §3.7 / criterion #7). A `null`
   * value means that source had no further pages.
   */
  externalCursors?: Record<string, string | null>
  /** Market handle the caller is scoped to, forwarded to external handlers (spec §4.4). */
  marketContext?: string | null
}

export interface MentionSearchParams extends SearchParams {
  type?: MentionType
  /**
   * Restrict to one app's entities (and optionally one entity type), in the
   * engine query. A picker for one kind of record passes it rather than
   * filtering a mixed top-N afterwards, which a common word fills with
   * other records.
   */
  app?: string
  entityType?: string
}

export interface PageSearchParams {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants?: Record<string, string[]>
  /** See {@link SearchParams.roleIds}. */
  roleIds?: string[]
  q: string
  limit: number
  offset: number
  app?: string[]
  entityType?: string[]
  filters: Record<string, string[]>
  /**
   * Per-app opaque cursors from the previous page's response, keyed by app
   * name. Threaded into `fanoutExternal` so each external section paginates
   * independently (spec §3.7 / criterion #7).
   */
  externalCursors?: Record<string, string | null>
  /** Market handle the caller is scoped to, forwarded to external handlers (spec §4.4). */
  marketContext?: string | null
}

export interface SearchHit {
  id: string
  app: string
  entity_type: string
  entity_id?: string
  title?: string
  body?: string
  handle?: string
  source?: string
  [k: string]: unknown
}

export interface SearchResponseThread {
  id: string
  title: string | null
  handle: string
}
export interface SearchResponseUser {
  id: string
  name: string
  email: string | null
}
export interface SearchResponseContact {
  id: string
  name: string
  email: string | null
}
export interface SearchResponseEntity {
  id: string
  app: string
  entityType: string
  label: string
  title: string | null
  handle?: string | null
  source?: string
}

export interface GlobalSearchResponse {
  threads: SearchResponseThread[]
  users: SearchResponseUser[]
  contacts: SearchResponseContact[]
  entities: SearchResponseEntity[]
  /**
   * Per-external-source next-page cursors, keyed by app name (criterion #7).
   * `null` ⇒ that source is exhausted; an absent key ⇒ the source returned no
   * cursor (or timed out / errored). The API echoes this in the response so the
   * client can request the next page of each external section independently.
   */
  externalCursors: Record<string, string | null>
}

export interface PageSearchResponse {
  hits: SearchHit[]
  /**
   * How many matches this caller may READ, plus the external hits on this page.
   *
   * Counted over the WHOLE internal result set after every visibility filter
   * the hits themselves pass through (message visibility, thread membership,
   * entity registration), never from the engine's pre-filter estimate. A page
   * whose every match was withheld therefore reports 0 instead of announcing
   * that something matched. It never over-reports: beyond
   * `VISIBLE_TOTAL_CAP` internal matches it saturates.
   *
   * The client derives "is there a next page" from
   * `offset + hits.length < total`, which still holds — with the difference
   * that it no longer offers a next page made entirely of documents the
   * searcher cannot read.
   */
  total: number
  limit: number
  offset: number
  /**
   * Per-external-source next-page cursors, keyed by app name (criterion #7).
   * See `GlobalSearchResponse.externalCursors`.
   */
  externalCursors: Record<string, string | null>
}

function meiliEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

function quoteList(values: string[]): string {
  return `[${values.map((v) => `"${meiliEscape(v)}"`).join(",")}]`
}

// ---------------------------------------------------------------------------
// Sensitivity-ladder pre-expansion (spec §3.1a)
//
// `sensitivity` is an ORDERED/level dimension: granting a level implicitly
// grants everything at or below it. The kernel filter (permission-filter.ts)
// is deliberately agnostic to ordering — it only tests set membership — so a
// caller granted `restricted` must have its grant PRE-EXPANDED to
// `[internal, confidential, restricted]` before the filter is built, exactly
// mirroring `app_tickets.can_read_ticket`'s SQL (MAX ordinal grants
// everything at or below) and the same ladder-expansion shape Knowledge uses
// (`expandKnowledgeSensitivityGrants` in packages/shared) for its own
// `sensitivity` dimension. Tickets' ladder has no `public` tier, so it is not
// the same enum as Knowledge's and gets its own ordered list here rather than
// reusing Knowledge's constant.
const TICKET_SENSITIVITY_ORDER = ["internal", "confidential", "restricted"] as const
type TicketSensitivityTier = (typeof TICKET_SENSITIVITY_ORDER)[number]

/**
 * Expand a list of ticket `sensitivity` grants into the cumulative set of
 * tiers the caller may read. `["confidential"]` expands to
 * `["internal","confidential"]`; `["restricted"]` expands to all three.
 * Wildcard (`*`) passes through unexpanded (handled by the caller/kernel
 * filter's own wildcard semantics). Unknown values are preserved verbatim so
 * a future/foreign tier does not silently vanish.
 */
export function expandTicketSensitivityGrants(values: string[] = []): string[] {
  if (values.includes("*")) return ["*"]
  let max = -1
  const unknown: string[] = []
  for (const value of values) {
    const index = TICKET_SENSITIVITY_ORDER.indexOf(value as TicketSensitivityTier)
    if (index >= 0) max = Math.max(max, index)
    else unknown.push(value)
  }
  const expanded = max >= 0 ? TICKET_SENSITIVITY_ORDER.slice(0, max + 1) : []
  return Array.from(new Set([...expanded, ...unknown]))
}

/**
 * Grant-key finding (investigated against the real JWT/RLS wiring, not
 * assumed): `role_dimension_grants`/`user_dimension_grants` store whatever
 * `dimension_key` the granting call used, and `computeEffectivePermissions`
 * (modules/permissions/permissions.ts) copies that key VERBATIM into the JWT
 * `dimensionGrants` map — no namespace stripping happens anywhere in the
 * auth pipeline. The tickets app grants (and `can_read_ticket`'s SQL GUC
 * reads) use the NAMESPACED keys `tickets:team` / `tickets:sensitivity`
 * (confirmed in the tickets manifest's grant tooling, e2e fixtures, and the
 * `can_read_ticket` function body in `0000_initial.sql`). But
 * `buildPermissionFilter` / `collectSearchableRegistrations` look up grants
 * by the BARE doc-field name (`team`, `sensitivity`) — the same field name
 * the Meili document carries and the manifest's `dimensionFields` declares.
 * So the namespaced grant a real actor carries would silently miss the bare
 * lookup key. This helper fixes that at the tickets-search boundary: it
 * merges `tickets:team` into `team` and expands+merges
 * `tickets:sensitivity` into `sensitivity`, while leaving the original
 * namespaced keys untouched (so any other namespaced consumer, e.g. SQL GUC
 * building, keeps seeing them) and passing through a BARE `team`/`sensitivity`
 * grant unchanged if the caller already carries one (defensive — handles
 * both shapes in case either exists in the wild, per the task brief).
 */
export function expandTicketSearchDimensionGrants(
  grants: Record<string, string[]> = {},
): Record<string, string[]> {
  const normalized = normalizeSearchDimensionGrants(grants)

  const namespacedTeam = normalized["tickets:team"]
  if (namespacedTeam) {
    normalized.team = Array.from(new Set([...(normalized.team ?? []), ...namespacedTeam]))
  }

  const namespacedSensitivity = normalized["tickets:sensitivity"]
  if (namespacedSensitivity) {
    const expanded = expandTicketSensitivityGrants(namespacedSensitivity)
    normalized["tickets:sensitivity"] = expanded
    normalized.sensitivity = Array.from(new Set([...(normalized.sensitivity ?? []), ...expanded]))
  } else if (normalized.sensitivity) {
    // A bare `sensitivity` grant (e.g. seeded directly in a test, or a future
    // caller that already uses the unnamespaced key) still needs ladder
    // expansion — only the SOURCE of the grant differs, not the semantics.
    normalized.sensitivity = expandTicketSensitivityGrants(normalized.sensitivity)
  }

  // RLS parity for the NO-GRANT case: `app_tickets.can_read_ticket` COALESCEs
  // a missing sensitivity grant to ordinal 0, so a member with no sensitivity
  // grant can still read lowest-band ("internal") tickets — and every ticket
  // row defaults to sensitivity='internal'. The kernel filter, by contrast,
  // emits `(NOT sensitivity EXISTS)` for an empty grant list, which matches
  // NOTHING because the indexed docs all carry the field. Without this
  // default, any member lacking an explicit sensitivity grant gets zero
  // search hits for tickets they can open in the list view. Membership dims
  // (`team`) keep their empty-set semantics: no grant means only teamless
  // docs, matching the SQL policy.
  const hasGlobalWildcard = (normalized["*"] ?? []).includes("*")
  if (!hasGlobalWildcard && (normalized.sensitivity ?? []).length === 0) {
    normalized.sensitivity = [TICKET_SENSITIVITY_ORDER[0]]
  }

  return normalized
}

async function callMeili(
  filter: string,
  q: string,
  opts: {
    limit: number
    offset?: number
    attributesToRetrieve?: string[]
    distinct?: string
    matchingStrategy?: "all" | "last" | "frequency"
  },
) {
  try {
    const index = getMeili().index(effectiveIndexName())
    // The client enforces a per-request timeout (see getMeili) and aborts the
    // underlying fetch on connection failure or hang — both surface here as a
    // thrown error and are normalised to MeiliUnavailableError below.
    return (await index.search(q, {
      filter,
      limit: opts.limit,
      offset: opts.offset ?? 0,
      attributesToHighlight: [],
      ...(opts.attributesToRetrieve ? { attributesToRetrieve: opts.attributesToRetrieve } : {}),
      // Search-time dedupe (Meili v1.9+ `distinct` parameter; the attribute
      // must be filterable — dedupe_key is in STATIC_FILTERABLE).
      ...(opts.distinct ? { distinct: opts.distinct } : {}),
      ...(opts.matchingStrategy ? { matchingStrategy: opts.matchingStrategy } : {}),
    })) as unknown as { hits: SearchHit[]; estimatedTotalHits?: number }
  } catch (err) {
    throw new MeiliUnavailableError("MeiliSearch request failed", { cause: err })
  }
}

function entitiesByType(
  regs: SearchableEntityRegistration[],
): Map<string, SearchableEntityRegistration> {
  const m = new Map<string, SearchableEntityRegistration>()
  for (const r of regs) m.set(r.entityType, r)
  return m
}

/**
 * Defense-in-depth recheck for kernel thread visibility. The Meili permission
 * filter gates threads solely on the *indexed* `participant_ids`, which can lag
 * the source of truth — e.g. a participant removal only re-indexes the thread
 * if the indexer ran; until then the removed user keeps matching the thread in
 * search. This authoritative recheck queries `kernel.thread_participants` for
 * the candidate thread ids and returns the subset the actor is truly a member
 * of, so stale index state can never widen visibility.
 */
async function filterVisibleThreadIds(
  orgId: string,
  userId: string,
  threadIds: string[],
): Promise<Set<string>> {
  if (threadIds.length === 0) return new Set()
  return await withPrivilegedDb(orgId, "search:thread-participant-recheck", async (tx) => {
    const result = await tx.execute(
      sql`SELECT thread_id FROM ${sql.raw(`${schemaRef("kernel")}.thread_participants`)}
          WHERE org_id = ${orgId}
            AND user_id = ${userId}
            AND thread_id IN (${sql.join(
              threadIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
    )
    const rows = ((result as { rows?: Record<string, unknown>[] }).rows ?? result) as Array<{
      thread_id: string
    }>
    return new Set(rows.map((r) => r.thread_id))
  })
}

/**
 * Drops thread hits whose viewer is not an authoritative participant. Non-thread
 * hits pass through untouched. Used after every Meili read so a stale indexed
 * `participant_ids` cannot leak a thread to a removed/non-participant user.
 */
async function rejectStaleThreadHits(
  orgId: string,
  userId: string,
  hits: SearchHit[],
): Promise<SearchHit[]> {
  const threadIds = hits
    .filter((h) => h.entity_type === "thread")
    .map((h) => (h.entity_id ?? h.id) as string)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  if (threadIds.length === 0) return hits
  const visible = await filterVisibleThreadIds(orgId, userId, threadIds)
  return hits.filter((h) => {
    if (h.entity_type !== "thread") return true
    const id = (h.entity_id ?? h.id) as string
    return visible.has(id)
  })
}

function defensiveFilterHits(
  hits: SearchHit[],
  byType: Map<string, SearchableEntityRegistration>,
): SearchHit[] {
  return hits.filter((h) => byType.has(h.entity_type))
}

// ---------------------------------------------------------------------------
// Message visibility (P2b-T26, spec-security.md D16)
//
// A search never returns a message the searcher cannot see, and it takes two
// layers to say that:
//
//   1. the engine narrows. `required_scopes` is a filterable array attribute
//      (P2b-T25), so the query carries
//      `(NOT required_scopes EXISTS OR required_scopes IN [grants])` and Meili
//      never even ranks a message whose scopes the searcher does not name.
//   2. the database decides. The indexed document deliberately holds neither
//      the disclosure list (publishing it would leak the membership of every
//      Share anyway) nor the room, so every message hit is re-read here and
//      answered by `isMessageVisible` (P2b-T10) ANDed with real thread
//      membership, which is what the messages SELECT policy itself checks.
//
// Neither layer alone is the gate. Layer 1 cannot express the disclosure
// branch or membership; layer 2 runs over whatever survived layer 1. So layer
// 1 is only ever allowed to narrow on facts that cannot hide a readable
// message: a covering wildcard or parent grant, or an unanswerable disclosure
// read, drops the clause entirely and leaves layer 2 to decide alone.
// ---------------------------------------------------------------------------

const MESSAGE_ENTITY_TYPE = MESSAGE_SEARCH_REGISTRATION.entityType

/** A kernel thread message document (never a mail message fragment). */
function isKernelMessageHit(h: SearchHit): boolean {
  return h.entity_type === MESSAGE_ENTITY_TYPE && (h.app === undefined || h.app === "kernel")
}

/**
 * The documents only memory search reads (message windows, brief rows,
 * episodes): kept out of every human surface at the query, so they never take
 * ranking slots from results a surface can show.
 */
const MEMORY_ONLY_CLAUSE = `NOT (app = "kernel" AND entity_type IN ["message_window", "brief_row", "episode"])`

/** Every kernel transcript document, which the ids projection never resolves. */
const KERNEL_TRANSCRIPT_CLAUSE = `NOT (app = "kernel" AND entity_type IN ["message", "message_window", "brief_row", "episode"])`

// ---------------------------------------------------------------------------
// Fragments
//
// A FRAGMENT document is one part of a parent entity, indexed on its own so
// that a change to the part costs one small document instead of a rebuild of
// the parent's whole text (a mail message of a conversation: apps/mail/
// search-enrichment.ts). It carries `parent_type` / `parent_id`, its parent's
// `dedupe_key`, and its parent's EXACT permission fields (copied from the
// parent row with the parent registration, doc-builder.applyPermissionFields),
// so the engine filter admits it for exactly the searchers it admits the
// parent for.
//
// Every surface reports a fragment hit AS ITS PARENT: same app, the parent's
// entity type and id, before any post-filter runs, so every recheck and every
// consumer sees only registered entities. `distinct` on `dedupe_key` collapses
// a parent and its fragments to one hit, and a search scoped to the parent's
// type (`entity_type IN [...]`) also admits its fragments.
// ---------------------------------------------------------------------------

/**
 * The live index's filterable attributes, read at most every
 * FILTERABLE_TTL_MS. A query may only name an attribute the index it runs
 * against can filter on, and the live index changes shape at a rebuild's swap,
 * not at a deploy. A failed read answers with the empty set: every clause then
 * falls back to the attributes every index shape has.
 */
const FILTERABLE_TTL_MS = 30_000
let filterableCache: { names: Set<string>; at: number; index: string } | null = null

export async function liveIndexFilterable(): Promise<Set<string>> {
  const index = effectiveIndexName()
  const now = Date.now()
  if (
    filterableCache &&
    filterableCache.index === index &&
    now - filterableCache.at < FILTERABLE_TTL_MS
  ) {
    return filterableCache.names
  }
  let names = new Set<string>()
  try {
    const attrs = (await getMeili().index(index).getFilterableAttributes()) as unknown
    if (Array.isArray(attrs)) names = new Set(attrs.map(String))
  } catch (err) {
    log.warn({ err }, "search: could not read the index's filterable attributes")
  }
  filterableCache = { names, at: now, index }
  return names
}

/** Test-only: forget the cached filterable attributes. */
export const SearchServiceTestAccess = {
  resetFilterableCache(): void {
    filterableCache = null
  },
}

function asParentHit(h: SearchHit): SearchHit {
  const parentType = h.parent_type
  const parentId = h.parent_id
  if (typeof parentType !== "string" || typeof parentId !== "string") return h
  const { parent_type: _t, parent_id: _p, ...rest } = h
  return {
    ...rest,
    id: documentId(String(h.org_id ?? ""), h.app, parentType, parentId),
    entity_type: parentType,
    entity_id: parentId,
  }
}

/** Fragment hits as their parents, first (best ranked) occurrence of each kept. */
function parentHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const hit of hits.map(asParentHit)) {
    const key = `${hit.app}\0${hit.entity_type}\0${hit.entity_id ?? hit.id}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

/**
 * Cap on the disclosed-message THREADS folded into the filter. Past it the
 * clause is dropped rather than truncated: a truncated list would silently hide
 * the remaining disclosed messages from their own recipient.
 */
const MAX_DISCLOSED_THREADS = 200

/**
 * How deep the exact-count pass reads.
 *
 * The count is taken AFTER the visibility filters, so it costs one extra Meili
 * read (a few fields per document) plus the same two batched database rechecks
 * the page already runs; this bounds that work. Past the cap the count
 * saturates, which UNDER-reports and so can never announce something the
 * searcher may not read, at the price that paging stops there (40 pages at the
 * default page size). Meili's own default `maxTotalHits` is 1000; this index
 * raises it to 10,000 for id-resolution, which the count pass does not follow.
 */
const VISIBLE_TOTAL_CAP = 1000

const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * True when a grant can satisfy scope strings it does not literally name, so
 * an `IN [grants]` list cannot enumerate what the searcher may read. `*` and
 * `<prefix>:*` are wildcards, and a grant shorter than a canonical
 * `app:resource:action` scope covers every child below it — `hasScope` and the
 * messages SELECT policy agree on both rules.
 */
function grantCoversUnnamedScopes(grant: string): boolean {
  return grant.includes("*") || grant.split(":").length < 3
}

/**
 * The engine-layer clause, or `null` for "narrow nothing, let the DB decide".
 * `disclosedThreadIds` is the threads holding a message disclosed to the
 * searcher (`null` when that read could not answer, or answered with too many).
 *
 * A disclosed message can carry scopes the searcher does not hold, so its
 * thread is let through whole: the clause may only ever WIDEN past what the
 * searcher can read (layer 2 then decides each message), never hide something
 * readable. Narrowing by thread rather than by message id is what lets
 * `entity_id` stay out of the filterable attributes, where one unique facet
 * value per document made every index write re-walk 760k values.
 *
 * Documents that carry no `required_scopes` at all (every non-message
 * document) match the first term and are untouched by this clause.
 */
export function buildMessageVisibilityFilterClause(
  grants: string[],
  disclosedThreadIds: string[] | null,
): string | null {
  if (disclosedThreadIds === null) return null
  if (grants.some(grantCoversUnnamedScopes)) return null
  const terms = ["NOT required_scopes EXISTS"]
  if (grants.length > 0) terms.push(`required_scopes IN ${quoteList(grants)}`)
  if (disclosedThreadIds.length > 0) terms.push(`thread_id IN ${quoteList(disclosedThreadIds)}`)
  return `(${terms.join(" OR ")})`
}

/**
 * The threads holding a message this searcher is personally disclosed to. The
 * index cannot hold the disclosure list, so without this the scope clause would
 * hide a Share anyway message from the very person it was shared with.
 * Answering `null` (unreadable, or more than the cap) removes the clause: the
 * post-filter is the gate either way, so degrading here loses ranking, never
 * safety.
 */
async function disclosedThreadIdsFor(orgId: string, userId: string): Promise<string[] | null> {
  try {
    return await withPrivilegedDb(orgId, "search:message-disclosure-list", async (tx) => {
      const result = await tx.execute(
        sql`SELECT DISTINCT thread_id FROM ${sql.raw(`${schemaRef("kernel")}.messages`)}
            WHERE org_id = ${orgId}
              AND deleted_at IS NULL
              AND disclosure_list @> ARRAY[${userId}]::uuid[]
            LIMIT ${MAX_DISCLOSED_THREADS + 1}`,
      )
      const rows = ((result as { rows?: Record<string, unknown>[] }).rows ?? result) as Array<{
        thread_id: string
      }>
      if (rows.length > MAX_DISCLOSED_THREADS) return null
      return rows.map((r) => String(r.thread_id))
    })
  } catch (err) {
    log.error({ err, orgId, userId }, "search: disclosure-list read failed, dropping scope clause")
    return null
  }
}

/** The engine-layer clause for this actor and projection, or null for none. */
async function messageVisibilityClauseFor(
  actor: ExecuteSearchActorSpec,
  opts: ExecuteSearchOptions,
): Promise<string | null> {
  // The ids projection excludes message documents outright (below), and a
  // mention query is `is_mentionable = true`, which a message document never
  // is. Neither pays for the disclosure read.
  if (opts.projection !== "hits" || opts.mentionableOnly) return null
  if (actor.scopes.some(grantCoversUnnamedScopes)) return null
  return buildMessageVisibilityFilterClause(
    actor.scopes,
    await disclosedThreadIdsFor(actor.orgId, actor.userId),
  )
}

/**
 * The subset of `messageIds` this viewer may actually read: a row that still
 * exists, in a thread they are a participant of, that `isMessageVisible`
 * admits. Everything else is simply absent from the result, which is how a
 * deleted, foreign or undeterminable hit fails closed.
 */
async function visibleMessageIds(
  orgId: string,
  userId: string,
  grants: string[],
  messageIds: string[],
): Promise<Map<string, string | null>> {
  return await withPrivilegedDb(orgId, "search:message-visibility-recheck", async (tx) => {
    const result = await tx.execute(
      sql`SELECT m.id AS id, m.required_scopes AS required_scopes,
                 m.disclosure_list AS disclosure_list, m.reply_root_id AS reply_root_id
          FROM ${sql.raw(`${schemaRef("kernel")}.messages`)} m
          JOIN ${sql.raw(`${schemaRef("kernel")}.thread_participants`)} tp
            ON tp.thread_id = m.thread_id
           AND tp.org_id = m.org_id
           AND tp.user_id = ${userId}
          WHERE m.org_id = ${orgId}
            AND m.deleted_at IS NULL
            AND m.id IN (${sql.join(
              messageIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
    )
    const rows = ((result as { rows?: Record<string, unknown>[] }).rows ?? result) as Array<{
      id: string
      required_scopes: string[]
      disclosure_list: string[] | null
      reply_root_id: string | null
    }>
    // Visible id -> the reply thread it lives in (A17), null in the channel.
    const visible = new Map<string, string | null>()
    for (const row of rows) {
      const seen = isMessageVisible(
        { requiredScopes: row.required_scopes, disclosureList: row.disclosure_list },
        { userId, grants },
      )
      if (seen) visible.set(row.id, row.reply_root_id ?? null)
    }
    return visible
  })
}

/**
 * Drops every message hit the searcher may not read. Non-message hits pass
 * through untouched. A hit whose visibility cannot be determined — no row, a
 * room the searcher is not in, or a failed read — is dropped: losing a hit is
 * recoverable, surfacing a scoped one is not.
 */
async function rejectHiddenMessageHits(
  actor: ExecuteSearchActorSpec,
  hits: SearchHit[],
): Promise<SearchHit[]> {
  const idOf = (h: SearchHit) => String(h.entity_id ?? h.id ?? "")
  const messageHits = hits.filter(isKernelMessageHit)
  if (messageHits.length === 0) return hits
  const candidateIds = messageHits.map(idOf).filter((id) => MESSAGE_ID_RE.test(id))
  let visible = new Map<string, string | null>()
  if (candidateIds.length > 0) {
    try {
      visible = await visibleMessageIds(actor.orgId, actor.userId, actor.scopes, candidateIds)
    } catch (err) {
      log.error(
        { err, orgId: actor.orgId, userId: actor.userId, count: candidateIds.length },
        "search: message visibility recheck failed, dropping every message hit",
      )
      visible = new Map()
    }
  }
  return hits
    .filter((h) => !isKernelMessageHit(h) || visible.has(idOf(h)))
    .map((h) =>
      // A17: a message hit names the reply thread it lives in, read from the
      // row by this same re-check, so a click opens the reply panel.
      isKernelMessageHit(h) ? { ...h, replyRootId: visible.get(idOf(h)) ?? null } : h,
    )
}

/**
 * How many of `hits` this searcher may read, through exactly the filters the
 * returned page passes through, so the count and the hits can never disagree
 * about what is visible.
 */
async function countVisibleHits(
  actor: ExecuteSearchActorSpec,
  hits: SearchHit[],
  byType: Map<string, SearchableEntityRegistration>,
): Promise<number> {
  if (hits.length === 0) return 0
  const rechecked = await rejectStaleThreadHits(actor.orgId, actor.userId, parentHits(hits))
  const visible = await rejectHiddenMessageHits(actor, rechecked)
  return (await rejectStaleAppDocumentHits(actor, defensiveFilterHits(visible, byType))).length
}

// ---------------------------------------------------------------------------
// Core executor (spec §3.4)
// ---------------------------------------------------------------------------

interface ExecuteSearchActorSpec {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants?: Record<string, string[]>
  roleIds?: string[]
}

interface ExecuteSearchEntityScope {
  app?: string[]
  entityType?: string[]
}

interface ExecuteSearchOptions {
  q: string
  limit: number
  offset?: number
  /** Restrict the Meili filter to specific app(s)/entityType(s) (e.g. tickets-only id resolution). */
  entityScope?: ExecuteSearchEntityScope
  /** Extra dimension-style `key IN [...]` clauses beyond the manifest-declared dimensions (SearchTab filters). */
  filters?: Record<string, string[]>
  /** Restrict to mentionable docs (`is_mentionable = true`). */
  mentionableOnly?: boolean
  /** `entity_type` equality/inequality clause for mention type narrowing. */
  typeClause?: string
  /** Fan out to registered external providers (Shopify etc.) in parallel with Meili. */
  includeExternal: boolean
  externalArgs?: {
    externalCursors?: Record<string, string | null>
    marketContext?: string | null
    /**
     * The page size handed to `fanoutExternal`, independent of the internal
     * Meili `limit` above — globalSearch fetches up to 50 internal hits (to
     * populate several grouped buckets) but must still request the caller's
     * requested page size (e.g. 5) from external sources. Defaults to `limit`
     * when omitted.
     */
    limit?: number
  }
  /**
   * `hits` returns full documents (rechecked against stale-thread/registration
   * drift); `ids` returns only the entity ids of matching documents (used by
   * `resolveTicketMatches`) and never fans out externally.
   */
  projection: "hits" | "ids"
  /**
   * Collapse documents sharing a `dedupe_key` to the single best-ranked hit
   * (Meili `distinct`). ON for human-facing hits surfaces (SearchTab, palette,
   * mentions) so a fragmented email conversation is one result, not one per
   * message/fragment. OFF for the ids projection: the inbox is a work list of
   * real ticket rows and must not hide actionable items.
   */
  dedupe?: boolean
  /**
   * Count the whole result set EXACTLY, after the visibility filters, instead
   * of correcting the engine's estimate for this page alone. Set by the one
   * surface that PUBLISHES the number (`pageSearch`); the others never surface
   * a count and do not pay for the extra read.
   */
  exactTotal?: boolean
  /** Only meaningful for `projection: "ids"` — restricts the Meili payload to this field. */
  idField?: string
}

interface ExecuteSearchResult {
  hits: SearchHit[]
  ids: string[]
  /**
   * How many matches this searcher may READ, counted after the visibility
   * filters. Deliberately never Meili's raw `estimatedTotalHits`: that number
   * is taken before those filters, and surfacing it publishes the existence of
   * documents the searcher cannot see.
   *
   * With `exactTotal` it is an exact count over the whole result set, up to
   * {@link VISIBLE_TOTAL_CAP}, where it saturates (under-reporting, never
   * over). Without it — the surfaces that publish no count — it is the
   * engine's estimate minus the message hits this page's post-filter dropped.
   */
  visibleTotal: number
  externalHits: SearchHit[]
  externalCursors: Record<string, string | null>
  byType: Map<string, SearchableEntityRegistration>
}

const EMPTY_RESULT: ExecuteSearchResult = {
  hits: [],
  ids: [],
  visibleTotal: 0,
  externalHits: [],
  externalCursors: {},
  byType: new Map(),
}

/**
 * Single core query executor every surface adapter (globalSearch, pageSearch,
 * mentionSearch, resolveTicketMatches) is a thin projection over. Always
 * applies {@link buildPermissionFilter}; a null filter (no authorized scopes)
 * short-circuits to an empty result without touching Meili. `includeExternal`
 * fans out to `fanoutExternal` in parallel with the Meili call (never
 * sequentially — see spec §8 latency criterion); the `ids` projection never
 * fans out regardless of `includeExternal` (id-resolution is internal-only).
 */
async function executeSearch(
  actor: ExecuteSearchActorSpec,
  opts: ExecuteSearchOptions,
): Promise<ExecuteSearchResult> {
  const regs = collectSearchableRegistrations(actor.orgId)
  // Sensitivity-ladder pre-expansion (spec §3.1a) applies on EVERY executor
  // path — global/page/mention hits and the ids projection alike — since all
  // of them can surface ticket documents (mentions/global/page are entity-
  // type-agnostic by default). For actors with no sensitivity grant at all it
  // also injects the lowest-band default (RLS COALESCE-0 parity — see the
  // helper's doc comment); `sensitivity` is only indexed on ticket documents,
  // so applying it unconditionally here is safe for every other app's docs.
  const dimensionGrants = expandTicketSearchDimensionGrants(actor.dimensionGrants ?? {})
  const filter = buildPermissionFilter({
    orgId: actor.orgId,
    userId: actor.userId,
    scopes: actor.scopes,
    dimensionGrants,
    // The data store's indexed collections are not registered entities (the
    // generic rebuild walk cannot build their documents, data-store/search.ts
    // streams them), so their read scopes join here, on the query path.
    registeredReadScopes: [
      ...new Set([...regs.registeredReadScopes, ...appDocumentSearchReadScopes(actor.orgId)]),
    ],
    dimensionFields: regs.dimensionFields,
    roleIds: actor.roleIds ?? [],
    aclFieldDeclarations: regs.aclFieldDeclarations,
  })

  const byType = entitiesByType(regs.entities)
  // Message documents are indexed (message-indexer.ts) but are deliberately
  // NOT a registered searchable entity: `reindex.ts` walks the registrations
  // and rebuilds documents with the shared doc builder, which knows nothing
  // about `required_scopes`, so a registered message would come back from the
  // next full reindex untagged and this gate would open. The query path gets
  // the registration here instead, where the two visibility layers below
  // apply to every hit it lets through.
  byType.set(MESSAGE_ENTITY_TYPE, MESSAGE_SEARCH_REGISTRATION)
  byType.set(APP_DOCUMENT_ENTITY_TYPE, APP_DOCUMENT_SEARCH_REGISTRATION)
  const includeExternal = opts.includeExternal && opts.projection === "hits"

  if (!filter) {
    if (!includeExternal) return { ...EMPTY_RESULT, byType }
    // No internal scope, but external federation is independent of the
    // internal permission filter — still fan out (mirrors prior globalSearch/
    // pageSearch behavior where the internal Meili call was skipped but
    // fanoutExternal still ran).
    const externalRes = await runExternalFanout(actor, opts)
    return { ...EMPTY_RESULT, externalHits: externalRes.hits, externalCursors: externalRes.cursors }
  }

  const clauses: string[] = [filter]
  // Layer 1 of message visibility (see "Message visibility" above). Null means
  // "narrow nothing here"; layer 2 below is the gate either way.
  const messageClause = await messageVisibilityClauseFor(actor, opts)
  if (messageClause) clauses.push(messageClause)
  if (opts.projection === "ids") {
    // The ids projection retrieves one field and runs no post-filter, so it
    // must never resolve a message in the first place. Both of today's callers
    // already scope themselves to one app's entity, but the exclusion belongs
    // on the query, not on the callers' good behaviour.
    clauses.push(KERNEL_TRANSCRIPT_CLAUSE)
  } else {
    clauses.push(MEMORY_ONLY_CLAUSE)
  }
  if (opts.entityScope?.app?.length) clauses.push(`app IN ${quoteList(opts.entityScope.app)}`)
  if (opts.entityScope?.entityType?.length) {
    // A fragment answers for its parent's type, never for its own (see
    // "Fragments"): it is reported as its parent. Only on an index that can
    // filter on `parent_type`: until a rebuild swaps the new shape in, the live
    // index cannot, Meili refuses the whole query, and it holds no fragment the
    // plain clause would miss anyway.
    const types = quoteList(opts.entityScope.entityType)
    clauses.push(
      (await liveIndexFilterable()).has("parent_type")
        ? `((entity_type IN ${types} AND NOT parent_type EXISTS) OR parent_type IN ${types})`
        : `entity_type IN ${types}`,
    )
  }
  if (opts.mentionableOnly) clauses.push(`is_mentionable = true`)
  if (opts.typeClause) clauses.push(opts.typeClause)
  for (const [key, values] of Object.entries(opts.filters ?? {})) {
    if (values.length === 0) continue
    clauses.push(`${key} IN ${quoteList(values)}`)
  }
  const fullFilter = clauses.join(" AND ")

  const meiliPromise = callMeili(fullFilter, opts.q, {
    limit: opts.limit,
    offset: opts.offset,
    attributesToRetrieve:
      opts.projection === "ids" ? [opts.idField ?? "entity_id", "parent_id"] : undefined,
    distinct: opts.dedupe ? "dedupe_key" : undefined,
  })
  const externalPromise = includeExternal
    ? runExternalFanout(actor, opts)
    : Promise.resolve({ hits: [] as SearchHit[], cursors: {} as Record<string, string | null> })
  // The exact-count pass: the same query and the same filter, read to the cap
  // with only the three fields the post-filters need, and issued in PARALLEL so
  // an honest count never costs a round trip in series.
  const countPromise =
    opts.exactTotal && opts.projection === "hits"
      ? callMeili(fullFilter, opts.q, {
          limit: VISIBLE_TOTAL_CAP,
          attributesToRetrieve: [
            "id",
            "org_id",
            "app",
            "entity_id",
            "entity_type",
            "parent_type",
            "parent_id",
          ],
          distinct: opts.dedupe ? "dedupe_key" : undefined,
        })
      : Promise.resolve(null)

  const [meiliRes, externalRes, countRes] = await Promise.all([
    meiliPromise,
    externalPromise,
    countPromise,
  ])

  if (opts.projection === "ids") {
    const idField = opts.idField ?? "entity_id"
    // A fragment resolves to its parent's id, once, at its best rank.
    const seen = new Set<string>()
    const ids: string[] = []
    for (const h of meiliRes.hits) {
      const id = (h.parent_id ?? h[idField] ?? h.entity_id ?? h.id) as unknown
      if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    return {
      hits: [],
      ids,
      // This projection has no post-filter and no consumer of the count (its
      // callers read `ids`), so it reports what it actually resolved rather
      // than an engine estimate nothing has vetted.
      visibleTotal: ids.length,
      externalHits: [],
      externalCursors: {},
      byType,
    }
  }

  const recheckedHits = await rejectStaleThreadHits(
    actor.orgId,
    actor.userId,
    parentHits(meiliRes.hits),
  )
  // Layer 2: the database decides every message hit, on membership and on
  // `isMessageVisible`, exactly as the messages SELECT policy would.
  const visibleHits = await rejectHiddenMessageHits(actor, recheckedHits)
  // A data store hit is re-checked against its collection's live declaration
  // and its row (data-store/search.ts).
  const hits = await rejectStaleAppDocumentHits(actor, defensiveFilterHits(visibleHits, byType))
  // THE COUNT PASSES THROUGH THE SAME FILTERS AS THE HITS. The engine's
  // estimate is taken before all three: a message document carries neither its
  // room nor its disclosure list, a thread document's indexed participants can
  // be stale, and an unregistered entity type is dropped outright. Publishing
  // that estimate tells a searcher who may read none of it that something
  // matched, and because it is a count that moves with the query, varying the
  // query binary-searches the hidden content. Correcting it for the FETCHED
  // PAGE alone was not enough: 60 unreadable matches with a 25-item page still
  // reported 35.
  //
  // So when the caller publishes the number, it is counted over the whole
  // result set (to the cap) after those filters. Otherwise the page-local
  // correction stands, which is all those surfaces could use anyway.
  const hiddenMessageHits = recheckedHits.length - visibleHits.length
  const visibleTotal = countRes
    ? await countVisibleHits(actor, countRes.hits, byType)
    : Math.max(0, (meiliRes.estimatedTotalHits ?? hits.length) - hiddenMessageHits)
  return {
    hits,
    ids: [],
    visibleTotal,
    externalHits: externalRes.hits,
    externalCursors: externalRes.cursors,
    byType,
  }
}

async function runExternalFanout(
  actor: ExecuteSearchActorSpec,
  opts: ExecuteSearchOptions,
): Promise<{ hits: SearchHit[]; cursors: Record<string, string | null> }> {
  const res = await fanoutExternal({
    orgId: actor.orgId,
    userId: actor.userId,
    q: opts.q,
    filters: opts.filters ?? {},
    limit: opts.externalArgs?.limit ?? opts.limit,
    cursors: opts.externalArgs?.externalCursors,
    marketContext: opts.externalArgs?.marketContext,
  }).catch((err) => {
    log.error({ err }, "external fanout error")
    return { hits: [], timedOut: [] as string[], cursors: {} as Record<string, string | null> }
  })
  return { hits: res.hits as SearchHit[], cursors: res.cursors }
}

// ---------------------------------------------------------------------------
// Surface adapters (spec §3.4) — thin projections over executeSearch, HTTP
// shapes byte-compatible with the pre-refactor implementation.
// ---------------------------------------------------------------------------

/**
 * The identity of the entity a hit points at: its app, its entity type and its
 * id in that app. An internal document carries the id as `entity_id` (its own
 * `id` is the Meili document id); an external hit carries it as `id`.
 */
function entityIdentity(hit: SearchHit): string {
  return `${hit.app}\0${hit.entity_type}\0${hit.entity_id ?? hit.id}`
}

/**
 * One hit per entity, the first (best ranked, internal before external) kept.
 * An app can both index its rows and answer an external search over the same
 * rows, and the merged list then showed the one entity twice.
 */
export function dedupeHitsByEntity(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const out: SearchHit[] = []
  for (const hit of hits) {
    const key = entityIdentity(hit)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(hit)
  }
  return out
}

export async function globalSearch(params: SearchParams): Promise<GlobalSearchResponse> {
  const empty: GlobalSearchResponse = {
    threads: [],
    users: [],
    contacts: [],
    entities: [],
    externalCursors: {},
  }

  const actor = {
    orgId: params.orgId,
    userId: params.userId,
    scopes: params.scopes,
    dimensionGrants: params.dimensionGrants,
    roleIds: params.roleIds,
  }
  // Two windows, read in parallel: the people and threads buckets, and every
  // other record. One shared top 50 let a word common in mail or tickets (a
  // company's own product name) fill the window and empty the contacts,
  // people and threads buckets although they had matches.
  const bucketTypes = quoteList(["thread", "user", "contact"])
  const [result, bucketResult] = await Promise.all([
    executeSearch(actor, {
      q: params.q,
      limit: 50,
      typeClause: `entity_type NOT IN ${bucketTypes}`,
      includeExternal: true,
      externalArgs: {
        externalCursors: params.externalCursors,
        marketContext: params.marketContext,
        limit: params.limit,
      },
      projection: "hits",
      dedupe: true,
    }),
    executeSearch(actor, {
      q: params.q,
      limit: 50,
      typeClause: `entity_type IN ${bucketTypes}`,
      includeExternal: false,
      projection: "hits",
      dedupe: true,
    }),
  ])

  const internalHits: SearchHit[] = [...bucketResult.hits, ...result.hits].map((h) => ({
    ...h,
    id: (h.entity_id ?? h.id) as string,
    source: h.source ?? "internal",
  }))

  const grouped: GlobalSearchResponse = { ...empty }
  const limit = Math.min(Math.max(params.limit, 1), 20)
  // A fragment answers as its parent, so one record can reach both windows.
  const bucketed = new Set<string>()
  for (const hit of internalHits) {
    const bucketKey = `${hit.entity_type}\0${hit.id}`
    if (bucketed.has(bucketKey)) continue
    bucketed.add(bucketKey)
    if (hit.entity_type === "thread") {
      if (grouped.threads.length < limit) {
        grouped.threads.push({
          id: hit.id,
          title: (hit.title as string | null) ?? null,
          handle: (hit.handle as string) ?? "",
        })
      }
    } else if (hit.entity_type === "user") {
      if (grouped.users.length < limit) {
        grouped.users.push({
          id: hit.id,
          name: (hit.title as string) ?? "",
          email: (hit.label_secondary as string | null) ?? null,
        })
      }
    } else if (hit.entity_type === "contact") {
      if (grouped.contacts.length < limit) {
        grouped.contacts.push({
          id: hit.id,
          name: (hit.title as string) ?? "",
          email: (hit.label_secondary as string | null) ?? null,
        })
      }
    }
    // Note: app entities are merged with external hits below using interleave
  }

  // Interleave internal app-entity hits and external hits so external sources
  // are not starved when internal hits fill the bucket first.
  const internalEntityHits = internalHits
    .filter(
      (h) => h.entity_type !== "thread" && h.entity_type !== "user" && h.entity_type !== "contact",
    )
    .map((h) => ({
      id: h.id,
      app: h.app,
      entityType: h.entity_type,
      label: (h.title as string | null) ?? (h.handle as string | null) ?? h.id,
      title: (h.title as string | null) ?? null,
      handle: (h.handle as string | null) ?? null,
      source: h.source ?? "internal",
    }))

  const externalEntityHits = result.externalHits.map((hit) => {
    const h = hit as SearchHit
    return {
      id: (h.entity_id ?? h.id) as string,
      app: h.app,
      entityType: h.entity_type ?? "unknown",
      label: (h.title as string | null) ?? (h.handle as string | null) ?? h.id,
      title: (h.title as string | null) ?? null,
      handle: (h.handle as string | null) ?? null,
      source: h.source ?? "external",
    }
  })

  // Round-robin interleave: take one from each source per iteration so no
  // single source starves the other. An entity already listed (the same row
  // indexed internally and answered by its app's external search) is skipped.
  const listed = new Set<string>()
  const pushEntity = (e: SearchResponseEntity) => {
    const key = `${e.app}\0${e.entityType}\0${e.id}`
    if (listed.has(key)) return
    listed.add(key)
    grouped.entities.push(e)
  }
  const maxI = Math.max(internalEntityHits.length, externalEntityHits.length)
  for (let i = 0; i < maxI && grouped.entities.length < limit; i++) {
    if (i < internalEntityHits.length) pushEntity(internalEntityHits[i])
    if (grouped.entities.length < limit && i < externalEntityHits.length) {
      pushEntity(externalEntityHits[i])
    }
  }
  grouped.externalCursors = result.externalCursors
  return grouped
}

// ---------------------------------------------------------------------------
// scopedEntitySearch — one app's own entities, filtered IN the engine.
// ---------------------------------------------------------------------------

export interface ScopedEntitySearchParams {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants?: Record<string, string[]>
  /** See {@link SearchParams.roleIds}. */
  roleIds?: string[]
  q: string
  app: string[]
  entityType: string[]
  limit: number
  offset?: number
}

/**
 * The ranked internal hits of the given app(s) and entity type(s), through the
 * same permission filter and post-filters as every other surface.
 *
 * A surface that searches ONE kind of record must narrow the query to it in
 * the engine, never take the top N of the whole index and filter afterwards:
 * a term common in mail or contacts (a company's own product name) fills that
 * window with other records, and the surface reports nothing although
 * hundreds of its records match. Internal only (no external fan-out).
 */
export async function scopedEntitySearch(
  params: ScopedEntitySearchParams,
): Promise<SearchResponseEntity[]> {
  if (params.app.length === 0 || params.entityType.length === 0) return []
  const result = await executeSearch(
    {
      orgId: params.orgId,
      userId: params.userId,
      scopes: params.scopes,
      dimensionGrants: params.dimensionGrants,
      roleIds: params.roleIds,
    },
    {
      q: params.q,
      limit: params.limit,
      offset: params.offset,
      entityScope: { app: params.app, entityType: params.entityType },
      includeExternal: false,
      projection: "hits",
      dedupe: true,
    },
  )
  return result.hits.map((h) => {
    const id = (h.entity_id ?? h.id) as string
    return {
      id,
      app: h.app,
      entityType: h.entity_type,
      label: (h.title as string | null) ?? (h.handle as string | null) ?? id,
      title: (h.title as string | null) ?? null,
      handle: (h.handle as string | null) ?? null,
      source: h.source ?? "internal",
    }
  })
}

export interface MentionHit {
  type: string
  id: string
  label: string
  secondaryLabel?: string
  app?: string
  entityType?: string
  threadId?: string
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`)
  return `"${value.replaceAll('"', '""')}"`
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function sqlLikeLiteral(value: string): string {
  return sqlLiteral(
    `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
  )
}

function rowAllowedByRegistration(
  row: Record<string, unknown>,
  reg: SearchableEntityRegistration,
  params: MentionSearchParams,
): boolean {
  const dimensionGrants = normalizeSearchDimensionGrants(params.dimensionGrants ?? {})
  const participantField = reg.permissionFields.participantIdsField
  if (participantField) {
    const participants = row[participantField]
    if (Array.isArray(participants) && !participants.includes(params.userId)) return false
  }

  // Generic ACL search primitive — mirrors buildPermissionFilter's ACL
  // disjunct for the direct-DB fallback path (used when Meili returns too
  // few hits). A row is allowed when org-wide readable, the caller is on its
  // per-user ACL, or the caller holds one of its role / dimension-grant keys.
  // Checked BEFORE the dimension wildcard below: that wildcard is about
  // dimension columns, and a restricted resource grants no one access by
  // dimension wildcard (the RLS policies have no admin bypass either).
  const aclFields = reg.permissionFields.aclFields
  if (aclFields && row[aclFields.orgWideField] !== true) {
    const userIds = row[aclFields.userIdsField]
    const roleIds = row[aclFields.roleIdsField]
    const callerKeys = [...(params.roleIds ?? []), ...actorSearchKeys(params.dimensionGrants)]
    const onUserAcl = Array.isArray(userIds) && userIds.includes(params.userId)
    const onRoleAcl = Array.isArray(roleIds) && callerKeys.some((k) => roleIds.includes(k))
    if (!onUserAcl && !onRoleAcl) return false
  }

  // Mirror the wildcard logic from buildPermissionFilter: a global wildcard
  // (dimensionGrants["*"] includes "*") bypasses all per-dimension checks, and
  // a per-dimension wildcard (grants includes "*") passes that dimension.
  const hasGlobalWildcard = (dimensionGrants["*"] ?? []).includes("*")
  if (hasGlobalWildcard) return true

  for (const dim of reg.permissionFields.dimensionFields ?? []) {
    const value = row[dim]
    if (value == null) continue
    const grants = dimensionGrants[dim] ?? []
    if (grants.includes("*")) continue
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      if (!value.some((v) => grants.includes(String(v)))) return false
    } else if (!grants.includes(String(value))) {
      return false
    }
  }
  return true
}

async function directMentionFallback(
  params: MentionSearchParams,
  regs: SearchableEntityRegistration[],
  limit: number,
): Promise<MentionHit[]> {
  const q = params.q.trim()
  const hits: MentionHit[] = []
  const seen = new Set<string>()

  for (const reg of regs) {
    if (hits.length >= limit) break
    if (reg.mentionable === false) continue
    if (!reg.tableName || !hasScope(reg.readScope, params.scopes)) continue
    if (!matchesMentionType(params.type, reg.entityType)) continue

    const schemaName = schemaRef(
      reg.schemaName ?? (reg.app === "kernel" ? "kernel" : `app_${reg.app}`),
    )
    const table = `${quoteIdent(schemaName)}.${quoteIdent(reg.tableName)}`
    const fields = reg.indexFields
    const searchableFields = [fields?.title, fields?.handle, fields?.labelSecondary]
      .filter((f): f is string => !!f)
      .map(quoteIdent)
    if (searchableFields.length === 0) continue

    // Empty q (bare-`@` trigger): drop the ILIKE clause and return the
    // most recently touched rows so the popup has a starter list. The
    // permission filter (org_id) still applies. Order by updated_at when
    // available, otherwise created_at, otherwise id.
    const whereClauses: string[] = [`org_id = ${sqlLiteral(params.orgId)}`]
    if (reg.indexFilter) {
      whereClauses.push(
        `${quoteIdent(reg.indexFilter.field)}::text IN (${reg.indexFilter.includeValues.map(sqlLiteral).join(", ")})`,
      )
    }
    if (reg.archivedField) whereClauses.push(`${quoteIdent(reg.archivedField)} IS NULL`)
    if (q) {
      whereClauses.push(
        `(${searchableFields.map((f) => `COALESCE(${f}::text, '') ILIKE ${sqlLikeLiteral(q)} ESCAPE '\\'`).join(" OR ")})`,
      )
    }
    const where = whereClauses.join(" AND ")
    const orderBy = q ? "" : ` ORDER BY COALESCE(updated_at, created_at) DESC NULLS LAST, id ASC`
    const rows = (await withPrivilegedDb(params.orgId, "search:mention-fallback", async (tx) => {
      const result = await tx.execute(
        sql.raw(`SELECT * FROM ${table} WHERE ${where}${orderBy} LIMIT ${limit}`),
      )
      return ((result as { rows?: Record<string, unknown>[] }).rows ?? result) as Record<
        string,
        unknown
      >[]
    })) as Record<string, unknown>[]

    for (const row of rows) {
      if (hits.length >= limit) break
      if (!rowAllowedByRegistration(row, reg, params)) continue
      const id = String(row.id ?? "")
      if (!id) continue
      const key = `${reg.app}:${reg.entityType}:${id}`
      if (seen.has(key)) continue
      seen.add(key)
      const title = fields?.title ? row[fields.title] : undefined
      const handle = fields?.handle ? row[fields.handle] : undefined
      const secondary = fields?.labelSecondary ? row[fields.labelSecondary] : undefined
      hits.push({
        type: reg.entityType,
        id,
        label: String(title ?? handle ?? id),
        secondaryLabel:
          secondary != null ? String(secondary) : handle != null ? String(handle) : undefined,
        app: reg.app,
        entityType: reg.entityType,
        threadId: typeof row.thread_id === "string" ? row.thread_id : undefined,
      })
    }
  }
  return hits
}

const USER_DIRECTORY_SCOPE = "kernel:users:read"

/**
 * The scopes a people search runs under. Whoever may write a conversation may
 * address a colleague: start a DM, add someone to a room, @mention them. The
 * people pickers ask for the addressable set, and the member documents are
 * indexed under kernel:users:read, a directory scope the `member` preset does
 * not hold: a member's "New message" and "Add people" found nobody. A people
 * search (addressable or user) therefore reads the member directory for any
 * caller holding kernel:threads:write. Every other mention type, and a
 * read-only caller, keeps its own scopes.
 */
export function mentionSearchScopes(type: MentionType | undefined, scopes: string[]): string[] {
  if (type !== "addressable" && type !== "user") return scopes
  if (hasScope(USER_DIRECTORY_SCOPE, scopes)) return scopes
  if (!hasScope("kernel:threads:write", scopes)) return scopes
  return [...scopes, USER_DIRECTORY_SCOPE]
}

export async function mentionSearch(input: MentionSearchParams): Promise<MentionHit[]> {
  const params = { ...input, scopes: mentionSearchScopes(input.type, input.scopes) }
  const typeClause = mentionTypeClause(params.type)

  const limit = Math.min(Math.max(params.limit, 1), 10)
  const result = await executeSearch(
    {
      orgId: params.orgId,
      userId: params.userId,
      scopes: params.scopes,
      dimensionGrants: params.dimensionGrants,
      roleIds: params.roleIds,
    },
    {
      q: params.q,
      limit,
      mentionableOnly: true,
      typeClause,
      entityScope: {
        app: params.app ? [params.app] : undefined,
        entityType: params.entityType ? [params.entityType] : undefined,
      },
      includeExternal: false,
      projection: "hits",
      dedupe: true,
    },
  )

  const hits: MentionHit[] = result.hits.map((h) => ({
    type: h.entity_type,
    id: (h.entity_id ?? h.id) as string,
    label: (h.title as string) ?? "",
    secondaryLabel: (h.handle as string) ?? undefined,
    app: h.app,
    entityType: h.entity_type,
    threadId: (h.thread_id as string) ?? undefined,
  }))
  if (hits.length < limit) {
    // Direct-DB top-up: rows created since the last index pass (or never
    // indexed) must still autocomplete in the mention popup. Meili hits keep
    // priority; the fallback only fills the remaining slots.
    const seen = new Set(hits.map((h) => `${h.app}:${h.entityType}:${h.id}`))
    const regs = collectSearchableRegistrations(params.orgId)
    for (const hit of await directMentionFallback(
      params,
      orderRegistrationsForMentionType(params.type, regs.entities),
      limit - hits.length,
    )) {
      if (params.app && hit.app !== params.app) continue
      if (params.entityType && (hit.entityType ?? hit.type) !== params.entityType) continue
      const key = `${hit.app}:${hit.entityType}:${hit.id}`
      if (!seen.has(key)) hits.push(hit)
    }
  }
  // Rows the picker cannot tell apart are rows the writer cannot choose
  // between: give every row without one a fact of its own. This runs on EVERY
  // path out of here, the full page of Meili hits included: an early return
  // above it shipped the one case that fills the limit (a common handle such
  // as "@support") with no second line at all.
  await attachMentionSecondaryLabels(params.orgId, hits)
  return hits
}

export class UnknownFilterError extends Error {
  constructor(key: string) {
    super(`unknown search filter: ${key}`)
    this.name = "UnknownFilterError"
  }
}

export async function pageSearch(params: PageSearchParams): Promise<PageSearchResponse> {
  const regs = collectSearchableRegistrations(params.orgId)
  for (const key of Object.keys(params.filters ?? {})) {
    if (!regs.dimensionFields.includes(key)) throw new UnknownFilterError(key)
  }

  const result = await executeSearch(
    {
      orgId: params.orgId,
      userId: params.userId,
      scopes: params.scopes,
      dimensionGrants: params.dimensionGrants,
      roleIds: params.roleIds,
    },
    {
      q: params.q,
      limit: params.limit,
      offset: params.offset,
      entityScope: { app: params.app, entityType: params.entityType },
      filters: params.filters,
      includeExternal: true,
      externalArgs: {
        externalCursors: params.externalCursors,
        marketContext: params.marketContext,
      },
      projection: "hits",
      dedupe: true,
      // The one surface that publishes the count, so the one that pays for it.
      exactTotal: true,
    },
  )

  const internalHits: SearchHit[] = result.hits.map((h) => ({
    ...h,
    source: h.source ?? "internal",
  }))
  const merged = dedupeHitsByEntity([...internalHits, ...result.externalHits])
  const droppedTwins = internalHits.length + result.externalHits.length - merged.length
  return {
    hits: merged,
    total: Math.max(0, result.visibleTotal + result.externalHits.length - droppedTwins),
    limit: params.limit,
    offset: params.offset,
    externalCursors: result.externalCursors,
  }
}

// ---------------------------------------------------------------------------
// resolveTicketMatches (spec §3.4/§3.5) — internal id-resolution consumed by
// searchTickets()'s retargeted free-text path.
// ---------------------------------------------------------------------------

export interface ResolveTicketMatchesArgs {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants?: Record<string, string[]>
  roleIds?: string[]
  q: string
}

/**
 * Resolve free-text query `q` to ranked ticket entity ids the caller may
 * read, via the executor's `ids` projection. Sensitivity grants are
 * pre-expanded (spec §3.1a) at this boundary before the permission filter is
 * built. Raised ceiling (10,000, spec §3.6/§7) so a broad query still
 * resolves the full ranked id set within the accepted truncation bound.
 * Throws {@link MeiliUnavailableError} when Meili itself fails AND when the
 * drift-tracked index is not ready (`isSearchReady()` false) — a caller with
 * a non-empty query must never silently fall back to unfiltered/stale
 * results.
 */
export async function resolveTicketMatches(args: ResolveTicketMatchesArgs): Promise<string[]> {
  if (!isSearchReady()) {
    throw new MeiliUnavailableError("search index not ready")
  }
  // Ladder expansion happens inside executeSearch (applies to every path);
  // no need to pre-expand here.
  const result = await executeSearch(
    {
      orgId: args.orgId,
      userId: args.userId,
      scopes: args.scopes,
      dimensionGrants: args.dimensionGrants,
      roleIds: args.roleIds,
    },
    {
      q: args.q,
      limit: 10000,
      entityScope: { app: ["tickets"], entityType: ["ticket"] },
      includeExternal: false,
      projection: "ids",
      idField: "entity_id",
    },
  )
  return result.ids
}

/**
 * Resolve free-text query `q` to ranked mail conversation entity ids the
 * caller may read — the mail twin of {@link resolveTicketMatches}, consumed by
 * `apps/mail/search.ts`'s free-text path. Same permission-filtered executor
 * (`participant_ids` carries the conversation's owner_id, so personal-mailbox
 * conversations only ever resolve for their owner), same MeiliUnavailableError
 * contract: a non-empty query must never silently fall back to unfiltered or
 * stale results.
 */
export async function resolveMailConversationMatches(
  args: ResolveTicketMatchesArgs,
): Promise<string[]> {
  if (!isSearchReady()) {
    throw new MeiliUnavailableError("search index not ready")
  }
  const result = await executeSearch(
    {
      orgId: args.orgId,
      userId: args.userId,
      scopes: args.scopes,
      dimensionGrants: args.dimensionGrants,
      roleIds: args.roleIds,
    },
    {
      q: args.q,
      limit: 10000,
      // Admits the conversations' message fragments too (see "Fragments"); each
      // resolves to its conversation id, one per conversation.
      entityScope: { app: ["mail"], entityType: ["conversation"] },
      includeExternal: false,
      projection: "ids",
      idField: "entity_id",
      dedupe: true,
    },
  )
  return result.ids
}

// ---------------------------------------------------------------------------
// resolveThreadMessageMatches — the agent's thread search, content pass.
// ---------------------------------------------------------------------------

/** Past this many rooms the thread clause is dropped (the DB re-read still gates). */
const MAX_THREAD_CLAUSE_IDS = 2000
/** Pages of 200 read at most when the rooms are narrowed after the engine. */
const THREAD_MESSAGE_MAX_PAGES = 5

export interface ThreadMessageMatchArgs {
  orgId: string
  userId: string
  scopes: string[]
  q: string
  /** The rooms the caller may search (its own threads); nothing outside them. */
  threadIds: string[]
  limit: number
}

/**
 * Ranked CANDIDATE message ids for a content search over the caller's rooms,
 * from the message documents of the index: the replacement for an
 * `ILIKE '%q%'` over every message of the org (564k rows, a sequential scan per
 * agent search in production).
 *
 * NOT a visibility decision. The engine narrows to the org, to thread messages,
 * to the caller's rooms and to the scopes it holds (plus the threads of its
 * disclosures), but the caller must re-read every returned id through its own
 * RLS transaction with its own membership join, exactly as the query this
 * replaces did; a stale document can therefore cost a hit, never leak one.
 * Throws {@link MeiliUnavailableError} when the index cannot answer, so the
 * caller can fall back rather than report "no match".
 */
export async function resolveThreadMessageMatches(args: ThreadMessageMatchArgs): Promise<string[]> {
  if (!isSearchReady()) throw new MeiliUnavailableError("search index not ready")
  const q = args.q.trim()
  if (q.length === 0 || args.threadIds.length === 0) return []
  if (!hasScope(MESSAGE_SEARCH_REGISTRATION.readScope, args.scopes)) return []
  const clauses = [
    `org_id = "${meiliEscape(args.orgId)}"`,
    `app = "kernel"`,
    `entity_type = "${MESSAGE_ENTITY_TYPE}"`,
  ]
  if (args.threadIds.length <= MAX_THREAD_CLAUSE_IDS) {
    clauses.push(`thread_id IN ${quoteList(args.threadIds)}`)
  }
  const scopeClause = args.scopes.some(grantCoversUnnamedScopes)
    ? null
    : buildMessageVisibilityFilterClause(
        args.scopes,
        await disclosedThreadIdsFor(args.orgId, args.userId),
      )
  if (scopeClause) clauses.push(scopeClause)
  const limit = Math.min(Math.max(args.limit, 1), 200)
  // Past the clause cap the engine cannot narrow to the caller's rooms, so the
  // window is read in pages and narrowed here: a top-N of every room's
  // messages would otherwise be filled by rooms the caller is not in.
  const inRooms = args.threadIds.length > MAX_THREAD_CLAUSE_IDS ? new Set(args.threadIds) : null
  const pageSize = inRooms ? 200 : limit
  const ids: string[] = []
  for (let page = 0; page < (inRooms ? THREAD_MESSAGE_MAX_PAGES : 1); page++) {
    const res = await callMeili(clauses.join(" AND "), q, {
      limit: pageSize,
      offset: page * pageSize,
      attributesToRetrieve: inRooms ? ["entity_id", "thread_id"] : ["entity_id"],
      // Every word must appear, the closest a token index gets to the substring
      // match this replaces.
      matchingStrategy: "all",
    })
    for (const h of res.hits) {
      const id = h.entity_id
      if (inRooms && !(typeof h.thread_id === "string" && inRooms.has(h.thread_id))) continue
      if (typeof id === "string" && MESSAGE_ID_RE.test(id) && !ids.includes(id)) ids.push(id)
      if (ids.length >= limit) return ids
    }
    if (res.hits.length < pageSize) break
  }
  return ids
}
