// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket list store — paginated list view used by TicketsInbox. Tracks search
// params, results, multi-select, and smart-filter dispatch.
import { createStore, produce } from "solid-js/store"
import type { EntityChangeEvent } from "~/framework/entity-changes"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { runTool } from "~/lib/run-tool"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { Ticket } from "./ticket-types"

/** True when a caught error represents the search backend being down (Meili
 *  outage), whether surfaced as an HTTP 503 or a tool-envelope error code. */
function isSearchUnavailableError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === "SEARCH_UNAVAILABLE" || err.status === 503)
}

export type SmartFilter =
  | "needs-attention"
  | "awaiting-customer"
  | "follow-ups"
  | "closed"
  | "all-open"

export interface TicketListParams {
  smartFilter?: SmartFilter
  inboxId?: string | null
  sourceInboxId?: string | null
  categoryId?: string | null
  query?: string
  status?: string[]
  priority?: string[]
  team?: string[]
  audience?: string[]
  contactId?: string
  assignedTo?: string
  cursor?: string | null
  limit?: number
  includeMergedSources?: boolean
  excludeMergedSources?: boolean
  closedAfter?: string
  followup?: "scheduled"
  /**
   * Explicit result ordering. The inbox orders by the last MESSAGE (inbound OR
   * outbound) -- "activity_newest" everywhere except "Needs attention", which uses
   * "activity_oldest" (longest-untouched first, to catch tickets before an SLA
   * breach). This is the same key the row's "last activity" date shows, so the
   * order and the visible timestamp always agree. "newest"/"oldest" (created_at)
   * remain available for agent/backlog reads. Passed straight through to
   * `tickets:search` (see search.ts `sort`).
   */
  sort?: "oldest" | "newest" | "recently_updated" | "activity_newest" | "activity_oldest"
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

export const DEFAULT_TICKET_FILTER: SmartFilter = "all-open"

export function paramsForSmartFilter(filter: SmartFilter): TicketListParams {
  switch (filter) {
    case "needs-attention":
      // Newest activity first, consistent with every other view -- one chronological
      // system. (Oldest-first, the longest-waiting/SLA-first read, is still one click
      // away on the sort toggle.)
      return { smartFilter: filter, sort: "activity_newest" }
    case "awaiting-customer":
      return { smartFilter: filter, status: ["awaiting_customer"], sort: "activity_newest" }
    case "follow-ups":
      // Status-only on purpose: many follow-ups have no schedulable date (e.g.
      // waiting on a restock with an unknown arrival). The section is "tickets
      // we owe a follow-up", scheduled or not -- NOT just the dated ones.
      return {
        smartFilter: filter,
        status: ["awaiting_followup"],
        sort: "activity_newest",
      }
    case "closed":
      return {
        smartFilter: filter,
        status: ["closed"],
        closedAfter: isoDaysAgo(30),
        includeMergedSources: true,
        sort: "activity_newest",
      }
    case "all-open":
      return {
        smartFilter: filter,
        status: ["open", "awaiting_customer", "awaiting_followup"],
        excludeMergedSources: true,
        sort: "activity_newest",
      }
  }
}

export function paramsForInbox(inboxId: string): TicketListParams {
  return { ...paramsForSmartFilter(DEFAULT_TICKET_FILTER), inboxId, sourceInboxId: inboxId }
}

export function filterRoutePath(filter: SmartFilter, inboxId?: string): string {
  const value = inboxId ? `inbox:${inboxId}` : filter
  return `/tickets?filter=${encodeURIComponent(value)}`
}

export function paramsFromRoutePath(routePath?: string): TicketListParams {
  const raw = routePath?.split("?")[1]
  const filterParam = raw ? new URLSearchParams(raw).get("filter") : null
  if (filterParam?.startsWith("inbox:")) return paramsForInbox(filterParam.slice("inbox:".length))
  const allowed: SmartFilter[] = [
    "needs-attention",
    "awaiting-customer",
    "follow-ups",
    "closed",
    "all-open",
  ]
  return paramsForSmartFilter(
    allowed.includes(filterParam as SmartFilter)
      ? (filterParam as SmartFilter)
      : DEFAULT_TICKET_FILTER,
  )
}

interface ListState {
  byId: Record<string, Ticket>
  ids: string[]
  cursor: string | null
  hasMore: boolean
  loading: boolean
  loaded: boolean
  selection: Record<string, boolean>
  params: TicketListParams
  error: string | null
  /** True when the last `tickets:search` call failed because the search
   *  backend (Meili) is unavailable, and the active params carry a non-empty
   *  query. Filters/views without a query never hit this — TicketsInbox shows
   *  a notice instead of the (untouched) result list. Cleared on the next
   *  successful load or when the query is cleared. */
  searchUnavailable: boolean
}

const [ticketListStore, setTicketListStore] = createStore<ListState>({
  byId: {},
  ids: [],
  cursor: null,
  hasMore: false,
  loading: false,
  loaded: false,
  selection: {},
  params: paramsForSmartFilter(DEFAULT_TICKET_FILTER),
  error: null,
  searchUnavailable: false,
})

export { ticketListStore }

/**
 * Cached list row for a ticket (when the inbox list has it loaded). Used by
 * the detail store to paint the header instantly on open while the full
 * tickets:get revalidates in place.
 */
export function getTicketFromList(id: string): Ticket | undefined {
  return ticketListStore.byId[id]
}

/**
 * Returns a shallow copy of the current list params for saved-view capture.
 * The store keeps params + selection in one piece; this exposes just the
 * query-relevant slice consumers should serialize.
 */
export function currentParams(): TicketListParams {
  return { ...ticketListStore.params }
}

/**
 * Apply a saved-view payload to the list store, then reload from the API.
 * Unknown keys are silently ignored; missing keys fall back to the smart-filter
 * defaults so legacy payloads still produce a valid query.
 */
export function applyParams(payload: Record<string, unknown> | TicketListParams): void {
  const allowed: ReadonlySet<keyof TicketListParams> = new Set([
    "smartFilter",
    "inboxId",
    "sourceInboxId",
    "categoryId",
    "query",
    "status",
    "priority",
    "team",
    "audience",
    "contactId",
    "assignedTo",
    "cursor",
    "limit",
    "includeMergedSources",
    "excludeMergedSources",
    "closedAfter",
    "followup",
    "sort",
  ])
  const cleaned: Partial<TicketListParams> = {}
  for (const [k, v] of Object.entries(payload ?? {})) {
    if (allowed.has(k as keyof TicketListParams)) {
      ;(cleaned as Record<string, unknown>)[k] = v
    }
  }
  const filter = (cleaned.smartFilter as SmartFilter) ?? DEFAULT_TICKET_FILTER
  const merged: TicketListParams = { ...paramsForSmartFilter(filter), ...cleaned }
  setListParams(merged)
  void reloadFromCurrent()
}

let reloadHook: (() => Promise<void>) | null = null

/** Register the API-aware reloader (Inbox onMount). Tests can swap in a spy. */
export function setReloadHook(hook: (() => Promise<void>) | null): void {
  reloadHook = hook
}

async function reloadFromCurrent(): Promise<void> {
  if (!reloadHook) return
  await reloadHook()
}

export function setListParams(params: TicketListParams): void {
  setTicketListStore(
    produce((s) => {
      s.params = { ...params }
      s.byId = {}
      s.ids = []
      s.cursor = null
      s.hasMore = false
      s.loaded = false
      s.selection = {}
      s.searchUnavailable = false
    }),
  )
}

/**
 * True when the list is in global-search mode: a non-empty free-text query
 * overrides the active view's narrowing so a search can NEVER miss a ticket
 * because of the view it was typed from. Exposed for the UI scope hint.
 */
export function searchOverridesView(): boolean {
  return !!ticketListStore.params.query?.trim()
}

/**
 * The params actually sent to `tickets:search`. A non-empty free-text query
 * searches ALL tickets: it drops the smart-filter predicate and every
 * status/recency narrowing (needs-attention, awaiting-customer, closed's
 * 30-day window, follow-ups). Searching a customer name or email from ANY
 * view must surface every matching ticket, open or closed; the view scope
 * comes back the moment the query is cleared. Explicit filter-bar dimensions
 * (priority, inbox, category) still apply, since the bar keeps showing them.
 */
function effectiveParams(): TicketListParams {
  const params = { ...ticketListStore.params }
  if (params.query?.trim()) {
    delete params.smartFilter
    delete params.status
    delete params.closedAfter
    delete params.followup
    delete params.excludeMergedSources
    delete params.inboxId
  }
  return params
}

// Monotonic request id: every keystroke fires a search with no debounce, and
// responses can resolve out of order. Only the LATEST request may write the
// list, otherwise a slow early prefix query clobbers the final results.
let loadSeq = 0

export async function loadTickets(api: ApiClient, append = false): Promise<void> {
  const seq = ++loadSeq
  setTicketListStore("loading", true)
  try {
    const params = effectiveParams()
    if (append && ticketListStore.cursor) params.cursor = ticketListStore.cursor
    const out = await runTool<{ items: Ticket[]; nextCursor: string | null }>(
      api,
      "tickets:search",
      params as Record<string, unknown>,
    )
    if (seq !== loadSeq) return
    const items = out.items ?? []
    setTicketListStore(
      produce((s) => {
        if (!append) {
          s.byId = {}
          s.ids = []
        }
        for (const t of items) {
          s.byId[t.id] = t
          if (!s.ids.includes(t.id)) s.ids.push(t.id)
        }
        s.cursor = out.nextCursor ?? null
        s.hasMore = !!out.nextCursor
        s.loaded = true
        s.error = null
        s.searchUnavailable = false
      }),
    )
  } catch (err: any) {
    if (seq === loadSeq) {
      if (isSearchUnavailableError(err)) {
        // Meili is down and this request carried a free-text query — surface a
        // dedicated notice instead of the generic error banner, and leave the
        // existing list/rows untouched (no garbage clobber). Filters/views without
        // a query never take this path (the backend only needs Meili for `query`).
        setTicketListStore("searchUnavailable", true)
      } else {
        setTicketListStore(
          produce((s) => {
            s.error = String(err?.message ?? err)
            s.searchUnavailable = false
          }),
        )
      }
    }
  } finally {
    if (seq === loadSeq) setTicketListStore("loading", false)
  }
}

// --- Inbox filter bar setters ---
// Each patches ONE filter dimension into the live params and reloads. They layer
// on top of whichever smart-filter preset (sidebar) owns the base view;
// setListParams resets the page (rows/cursor/selection) so a narrower or broader
// filter always refetches from the top. Switching a smart-filter preset replaces
// params wholesale (paramsForSmartFilter) and so clears these refinements — the
// intended "new view, fresh filters" behaviour.

/** Narrow the view to a set of statuses. Empty reverts to the current smart
 *  filter's natural status scope (never "no statuses", which matches nothing). */
export function setStatusFilter(api: ApiClient, statuses: string[]): void {
  const base = paramsForSmartFilter(ticketListStore.params.smartFilter ?? DEFAULT_TICKET_FILTER)
  setListParams({
    ...ticketListStore.params,
    status: statuses.length > 0 ? statuses : base.status,
  })
  void loadTickets(api)
}

/** Filter by one or more priorities. Empty clears the priority filter. */
export function setPriorityFilter(api: ApiClient, priorities: string[]): void {
  setListParams({
    ...ticketListStore.params,
    priority: priorities.length > 0 ? priorities : undefined,
  })
  void loadTickets(api)
}

/** Scope to a single inbox (or all). Written to `sourceInboxId` — the backend
 *  filter column — NOT `inboxId`, so it does not collide with the inbox-tab
 *  routePath reconciliation in TicketsInbox (which keys on params.inboxId). */
export function setInboxFilter(api: ApiClient, inboxId: string | null): void {
  setListParams({
    ...ticketListStore.params,
    sourceInboxId: inboxId ?? undefined,
  })
  void loadTickets(api)
}

/** Filter by a single category (or all). */
export function setCategoryFilter(api: ApiClient, categoryId: string | null): void {
  setListParams({
    ...ticketListStore.params,
    categoryId: categoryId ?? undefined,
  })
  void loadTickets(api)
}

/** Scope to a single team (or all). Teams are FREE TEXT with no id, so the label
 *  travels verbatim — trimming or case-folding it here would produce a filter
 *  that matches nothing, since the backend compares exactly. Written as a
 *  one-element array because `search` accepts several. */
export function setTeamFilter(api: ApiClient, team: string | null): void {
  setListParams({
    ...ticketListStore.params,
    team: team === null ? undefined : [team],
  })
  void loadTickets(api)
}

/** Scope to one audience (or all). A closed set of two, so unlike `setTeamFilter`
 *  there is nothing to load and nothing to spell wrong. */
export function setAudienceFilter(api: ApiClient, audience: string | null): void {
  setListParams({
    ...ticketListStore.params,
    audience: audience === null ? undefined : [audience],
  })
  void loadTickets(api)
}

/** Set the explicit sort order (null = the view's natural order). */
export function setSortMode(api: ApiClient, sort: TicketListParams["sort"] | null): void {
  setListParams({
    ...ticketListStore.params,
    sort: sort ?? undefined,
  })
  void loadTickets(api)
}

export function toggleSelection(id: string): void {
  setTicketListStore(
    produce((s) => {
      s.selection[id] = !s.selection[id]
      if (!s.selection[id]) delete s.selection[id]
    }),
  )
}

export function clearSelection(): void {
  setTicketListStore(
    produce((s) => {
      for (const k of Object.keys(s.selection)) delete s.selection[k]
    }),
  )
}

export function replaceSelection(ids: string[]): void {
  setTicketListStore(
    produce((s) => {
      for (const k of Object.keys(s.selection)) delete s.selection[k]
      for (const id of ids) s.selection[id] = true
    }),
  )
}

export function selectedIds(): string[] {
  return Object.keys(ticketListStore.selection).filter((id) => ticketListStore.selection[id])
}

/**
 * Drop a ticket from the open list — used when a source ticket is merged or
 * otherwise transitions out of the currently-filtered view. Keeps the inbox
 * in sync after bulk merges without waiting for the next full reload.
 */
export function removeTicketFromList(id: string): void {
  setTicketListStore(
    produce((s) => {
      if (s.byId[id]) delete s.byId[id]
      const i = s.ids.indexOf(id)
      if (i >= 0) s.ids.splice(i, 1)
      if (s.selection[id]) delete s.selection[id]
    }),
  )
}

/**
 * Does a ticket still belong in the currently-filtered list? Mirrors the
 * server-side smart-filter predicates in `searchTickets` (apps/api search.ts)
 * closely enough to keep the visible list aligned with what the next reload
 * would return, so a status transition (close, reopen, reply -> awaiting) is
 * reflected live instead of leaving a stale row behind.
 */
function ticketMatchesListParams(t: Ticket, params: TicketListParams): boolean {
  // Status-scoped filters (all-open, awaiting-customer, follow-ups, closed) carry
  // an explicit status list; a ticket whose status left that set leaves the view.
  if (params.status && params.status.length > 0 && !params.status.includes(t.status)) {
    return false
  }
  // needs-attention has no explicit status param (the set is server-computed), but
  // a closed ticket is never "needs attention" — drop it on close at least.
  if (params.smartFilter === "needs-attention" && t.status === "closed") return false
  // Open-work views hide merged-away source tickets.
  if (params.excludeMergedSources && t.mergedIntoTicketId) return false
  // The follow-ups view only holds tickets with a scheduled follow-up.
  if (params.followup === "scheduled" && !t.followupAt) return false
  return true
}

/**
 * Live-reconcile a ticket ROW in the inbox list when a `tickets:ticket`
 * `update`/`reopened` WS event arrives (the same events `handleTicketEvent`
 * consumes for the detail store). Two effects:
 *   1. Patch the row's changed fields (status, priority, follow-up, SLA, ...) so
 *      the visible row reflects the new state.
 *   2. If the ticket no longer matches the active filter — the common case being
 *      a ticket CLOSED from its own tab while the all-open list is showing —
 *      drop it from the list, so returning to the list shows it gone without
 *      waiting for a manual reload. Previously only MERGES pruned the list, so a
 *      plain close/convert left a stale open row behind.
 *
 * A no-op when the ticket isn't currently in the loaded list: we can't
 * materialize a full row from an event payload, and the "should now appear"
 * direction is covered by the next reload / filter switch.
 */
export function applyTicketUpdateToList(id: string, changes: Record<string, unknown>): void {
  if (!id || !changes) return
  setTicketListStore(
    produce((s) => {
      const t = s.byId[id]
      if (!t) return
      Object.assign(t, changes)
      // Only reconsider list membership when the change touches a dimension the
      // active smart filter actually scopes on — status, the follow-up schedule,
      // or the merge target. An unrelated patch (SLA breach, priority, category,
      // message preview) just updates the row in place and must never evict a
      // still-matching ticket.
      const touchesMembership =
        "status" in changes || "followupAt" in changes || "mergedIntoTicketId" in changes
      if (touchesMembership && !ticketMatchesListParams(t, s.params)) {
        delete s.byId[id]
        const i = s.ids.indexOf(id)
        if (i >= 0) s.ids.splice(i, 1)
        if (s.selection[id]) delete s.selection[id]
      }
    }),
  )
}

/**
 * Live-patch a ticket ROW in the inbox list when a `tickets:message` WS
 * `create` event arrives — last-message preview, unread indicator, and sort
 * position, mirroring how `handleTicketEvent` (ticket-detail-store.ts) patches
 * the detail store on ticket-level events. The list is otherwise server-sorted
 * (no client re-sort of the full array), so a new message is reflected in
 * position by nudging the row to the front or back per the active sort (see the
 * reorder block below) — the inbox orders by last message (either direction), so
 * any new message bumps the row to the front (newest-first) or back
 * (oldest-first); this keeps the visible order aligned with the next server reload.
 *
 * `data` is the WS `message:create` payload — same shape
 * `handleTicketMessageEvent` (ticket-message-store.ts) consumes: `ticketId`,
 * `kind` ("inbound" | "outbound" | "note"), `snippet`/`textBody`/`htmlBody`,
 * `sentAt`.
 */
export function applyTicketMessageToList(data: any): void {
  const ticketId = data?.ticketId
  if (!ticketId) return
  const kind = data?.kind
  // Internal notes don't change the customer-facing preview/unread state and
  // aren't a "new message" for sort-position purposes.
  if (kind === "note") return
  // Acknowledgement sends are hidden from the conversation view, so they must
  // not become the list-row preview either (defensive: the ack path doesn't
  // currently emit a live event, but a future one must not surface the
  // "We have received your request..." boilerplate as the ticket's preview).
  if (data?.isAcknowledgement === true) return
  const sentAt = data?.sentAt ?? new Date().toISOString()
  const snippet =
    typeof data?.snippet === "string"
      ? data.snippet
      : typeof data?.textBody === "string"
        ? data.textBody.slice(0, 200)
        : null
  setTicketListStore(
    produce((s) => {
      const t = s.byId[ticketId]
      if (!t) return
      t.snippet = snippet
      t.lastMessageAt = sentAt
      if (kind === "inbound") {
        t.lastInboundAt = sentAt
        // A new customer message makes the ticket unread again, unless the
        // agent who's currently viewing it will immediately mark it read
        // (TicketDetail's own markRead flow handles that case).
        t.unread = true
      } else if (kind === "outbound") {
        t.lastOutboundAt = sentAt
      }
      t.messageCount = (t.messageCount ?? 0) + 1
      // Keep the row's live position aligned with where the next server reload
      // would place it, per the active sort. The inbox orders by last_message_at,
      // which ANY new message (inbound OR outbound) updates:
      //  * activity_newest / unset (last_message_at DESC): any message fronts the row.
      //  * activity_oldest (last_message_at ASC): any message sends it to the back.
      //  * oldest/newest (created_at): immutable key — never reorder.
      const sort = s.params.sort
      const i = s.ids.indexOf(ticketId)
      if (i >= 0) {
        if (sort === "activity_oldest") {
          if (i < s.ids.length - 1) {
            s.ids.splice(i, 1)
            s.ids.push(ticketId)
          }
        } else if (sort === "oldest" || sort === "newest") {
          // created_at never changes on a new message — leave the row in place.
        } else if (i > 0) {
          // activity_newest / recently_updated / unset: any message fronts it.
          s.ids.splice(i, 1)
          s.ids.unshift(ticketId)
        }
      }
    }),
  )
}

/**
 * Does a batch of entity changes call for reloading the list? The rows the
 * list holds are patched in place by the WS handlers above; what a patch
 * cannot do is MATERIALIZE a row the list does not have: a new ticket, one
 * whose status or follow-up moved it into the view, one a customer message
 * reopened. Those (and a resync) reload the current view from the server.
 */
/**
 * Can a customer message ALONE bring a ticket the list does not hold into it?
 * In a status-scoped view, no: a message that reopens a ticket announces the
 * status change too (a `tickets:ticket` event, handled above), so a fully
 * loaded view already holds every ticket the message could concern. Yes when
 * the view's predicate is not a status list (search, needs-attention), or when
 * more pages exist under an activity-newest order: the reply lifts the ticket
 * onto the loaded page.
 */
function customerMessageMayEnterView(params: TicketListParams, hasMore: boolean): boolean {
  if (!params.status || params.status.length === 0) return true
  return hasMore && params.sort === "activity_newest"
}

export function ticketListNeedsReload(events: EntityChangeEvent[]): boolean {
  const has = (id: unknown) => typeof id === "string" && !!ticketListStore.byId[id]
  for (const e of events) {
    if (e.resync) return true
    const data = (e.data ?? {}) as Record<string, unknown>
    if (e.key === "tickets:ticket") {
      const id = data.ticketId ?? data.id
      if (e.action === "create" || e.action === "created") return true
      const changes = (data.changes ?? {}) as Record<string, unknown>
      const mayEnter =
        e.action === "reopened" ||
        "status" in changes ||
        "followupAt" in changes ||
        "mergedIntoTicketId" in changes
      if (mayEnter && typeof id === "string" && !has(id)) return true
    } else if (e.key === "tickets:message") {
      const id = data.ticketId
      // The inbound append path announces `{ ticketId }` without a kind: treat
      // anything that is not our own reply or a note as a customer message.
      const fromCustomer = data.kind === undefined || data.kind === "inbound"
      if (e.action !== "create" || !fromCustomer || typeof id !== "string" || has(id)) continue
      if (customerMessageMayEnterView(ticketListStore.params, ticketListStore.hasMore)) return true
    }
  }
  return false
}

export function applyTicketSlaBreach(data: any): void {
  const id = data?.ticketId ?? data?.id
  if (!id) return
  setTicketListStore(
    produce((s) => {
      const t = s.byId[id]
      if (!t) return
      t.slaBreachedAt = data.breachedAt ?? new Date().toISOString()
      if (data.slaDeadline) t.slaDeadline = data.slaDeadline
    }),
  )
}

// --- Smart-filter result counts (sidebar badges) ---
// Each count is an exact server COUNT over the SAME predicate the list query uses
// (search `countOnly`), so the badge always matches what clicking the filter
// shows. `needs-attention` is counted here (not via the attention feed) so its
// badge is the count of tickets the list actually holds and never falls back to a
// "Retry" affordance when the separate attention aggregator hiccups. `all-open`
// keeps its own total-unread counter.
export const COUNTED_SMART_FILTERS: SmartFilter[] = [
  "needs-attention",
  "awaiting-customer",
  "follow-ups",
  "closed",
  // Counted like the others: its badge used to be the unread total, which
  // read "All open work 4" over a list of many more open tickets.
  "all-open",
]

const [ticketFilterCountStore, setTicketFilterCountStore] = createStore<{
  countByFilter: Partial<Record<SmartFilter, number>>
}>({ countByFilter: {} })

export { ticketFilterCountStore }

export async function refreshFilterCounts(api: ApiClient): Promise<void> {
  await Promise.all(
    COUNTED_SMART_FILTERS.map(async (filter) => {
      try {
        const out = await runTool<{ totalCount: number }>(api, "tickets:search", {
          ...paramsForSmartFilter(filter),
          countOnly: true,
        } as Record<string, unknown>)
        setTicketFilterCountStore("countByFilter", filter, out.totalCount ?? 0)
      } catch {
        // non-fatal — keep the previous count rather than blanking the badge
      }
    }),
  )
}

export function resetTicketListStore(): void {
  setTicketListStore({
    byId: {},
    ids: [],
    cursor: null,
    hasMore: false,
    loading: false,
    loaded: false,
    selection: {},
    params: paramsForSmartFilter(DEFAULT_TICKET_FILTER),
    error: null,
    searchUnavailable: false,
  })
  setTicketFilterCountStore({ countByFilter: {} })
}

onSessionTeardown(resetTicketListStore)
