// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-list-store", () => {
  beforeEach(() => vi.resetModules())

  it("setListParams resets the store and applies new params", async () => {
    const { setListParams, ticketListStore } = await import("~/modules/tickets/ticket-list-store")
    setListParams({ smartFilter: "needs-attention", inboxId: "i1" })
    expect(ticketListStore.params.smartFilter).toBe("needs-attention")
    expect(ticketListStore.params.inboxId).toBe("i1")
    expect(ticketListStore.ids).toEqual([])
    expect(ticketListStore.loaded).toBe(false)
  })

  it("maps smart filters to the documented search params", async () => {
    const { paramsForSmartFilter, paramsForInbox } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    expect(paramsForSmartFilter("follow-ups")).toMatchObject({
      status: ["awaiting_followup"],
    })
    // Status-only view: an awaiting_followup ticket with NO scheduled date (unknown
    // restock etc.) must still appear, so no followup:'scheduled' narrowing here.
    expect(paramsForSmartFilter("follow-ups").followup).toBeUndefined()
    expect(paramsForSmartFilter("closed")).toMatchObject({
      status: ["closed"],
      includeMergedSources: true,
    })
    expect(paramsForSmartFilter("closed").closedAfter).toBeTruthy()
    expect(paramsForSmartFilter("all-open")).toMatchObject({ excludeMergedSources: true })
    expect(paramsForInbox("in1")).toMatchObject({ sourceInboxId: "in1" })
    // One consolidated order: every view sorts by last message, newest first.
    expect(paramsForSmartFilter("all-open").sort).toBe("activity_newest")
    expect(paramsForSmartFilter("awaiting-customer").sort).toBe("activity_newest")
    expect(paramsForSmartFilter("closed").sort).toBe("activity_newest")
    expect(paramsForSmartFilter("needs-attention").sort).toBe("activity_newest")
    expect(paramsForInbox("in1").sort).toBe("activity_newest")
  })

  it("loadTickets stores items and tracks pagination", async () => {
    const post = vi.fn().mockResolvedValue({
      items: [
        {
          id: "t1",
          handle: "ticket-1",
          subject: "A",
          status: "open",
          priority: "normal",
          unread: true,
          readByCount: 0,
          readByRecent: [],
        },
        {
          id: "t2",
          handle: "ticket-2",
          subject: "B",
          status: "open",
          priority: "normal",
          unread: false,
          readByCount: 1,
          readByRecent: [],
        },
      ],
      nextCursor: "abc",
    })
    const api = { post } as any
    const { loadTickets, ticketListStore, resetTicketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    resetTicketListStore()
    await loadTickets(api)
    expect(ticketListStore.ids).toEqual(["t1", "t2"])
    expect(ticketListStore.byId.t1.subject).toBe("A")
    expect(ticketListStore.cursor).toBe("abc")
    expect(ticketListStore.hasMore).toBe(true)
  })

  it("currentParams returns a copy of the live params", async () => {
    const { currentParams, setListParams, resetTicketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    resetTicketListStore()
    setListParams({ smartFilter: "closed", assignedTo: "u1" })
    const snap = currentParams()
    expect(snap).toMatchObject({ smartFilter: "closed", assignedTo: "u1" })
    snap.smartFilter = "needs-attention"
    expect(currentParams().smartFilter).toBe("closed")
  })

  it("applyParams ignores unknown keys, fills smart-filter defaults, and triggers reload", async () => {
    const reload = vi.fn().mockResolvedValue(undefined)
    const { applyParams, currentParams, setReloadHook, resetTicketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    resetTicketListStore()
    setReloadHook(reload)
    applyParams({ smartFilter: "closed", unknown: "x" } as any)
    expect(reload).toHaveBeenCalled()
    expect(currentParams().smartFilter).toBe("closed")
    expect(currentParams()).toMatchObject({ status: ["closed"] })
    expect((currentParams() as any).unknown).toBeUndefined()
    setReloadHook(null)
  })

  it("applyParams without a reload hook is a no-op for reload but still updates params", async () => {
    const { applyParams, currentParams, setReloadHook, resetTicketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    resetTicketListStore()
    setReloadHook(null)
    expect(() => applyParams({ smartFilter: "needs-attention" })).not.toThrow()
    expect(currentParams().smartFilter).toBe("needs-attention")
  })

  it("applyTicketMessageToList patches preview/lastMessageAt and moves the row to the front", async () => {
    const post = vi.fn().mockResolvedValue({
      items: [
        {
          id: "t1",
          handle: "ticket-1",
          subject: "A",
          status: "open",
          priority: "normal",
          unread: false,
          snippet: "old preview",
          lastMessageAt: "2026-01-01T00:00:00Z",
          messageCount: 3,
        },
        {
          id: "t2",
          handle: "ticket-2",
          subject: "B",
          status: "open",
          priority: "normal",
          unread: false,
          snippet: "other",
          lastMessageAt: "2026-01-02T00:00:00Z",
          messageCount: 1,
        },
      ],
      nextCursor: null,
    })
    const api = { post } as any
    const { loadTickets, applyTicketMessageToList, ticketListStore, resetTicketListStore } =
      await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()
    await loadTickets(api)
    expect(ticketListStore.ids).toEqual(["t1", "t2"])

    applyTicketMessageToList({
      ticketId: "t1",
      kind: "inbound",
      textBody: "brand new customer reply",
      sentAt: "2026-01-03T00:00:00Z",
    })

    expect(ticketListStore.ids).toEqual(["t1", "t2"])
    const t1 = ticketListStore.byId.t1
    expect(t1.snippet).toBe("brand new customer reply")
    expect(t1.lastMessageAt).toBe("2026-01-03T00:00:00Z")
    expect(t1.unread).toBe(true)
    expect(t1.messageCount).toBe(4)
  })

  it("applyTicketMessageToList fronts the row on ANY message (activity_newest default)", async () => {
    const post = vi.fn().mockResolvedValue({
      items: [
        { id: "t1", handle: "ticket-1", subject: "A", status: "open", priority: "normal" },
        { id: "t2", handle: "ticket-2", subject: "B", status: "open", priority: "normal" },
        { id: "t3", handle: "ticket-3", subject: "C", status: "open", priority: "normal" },
      ],
      nextCursor: null,
    })
    const api = { post } as any
    const { loadTickets, applyTicketMessageToList, ticketListStore, resetTicketListStore } =
      await import("~/modules/tickets/ticket-list-store")
    // The default view (all-open) sorts by activity_newest — last_message_at DESC.
    resetTicketListStore()
    await loadTickets(api)
    expect(ticketListStore.ids).toEqual(["t1", "t2", "t3"])

    // last_message_at updates on ANY message, so an agent reply (outbound) fronts
    // the row just like a customer message would.
    applyTicketMessageToList({ ticketId: "t3", kind: "outbound", textBody: "agent replied" })
    expect(ticketListStore.ids).toEqual(["t3", "t1", "t2"])
    expect(ticketListStore.byId.t3.lastOutboundAt).toBeDefined()

    // A new customer message (inbound) also fronts its row.
    applyTicketMessageToList({ ticketId: "t2", kind: "inbound", textBody: "customer wrote" })
    expect(ticketListStore.ids).toEqual(["t2", "t3", "t1"])
  })

  it("applyTicketMessageToList sends a touched ticket to the BACK under activity_oldest", async () => {
    const post = vi.fn().mockResolvedValue({
      items: [
        { id: "t1", handle: "ticket-1", subject: "A", status: "open", priority: "normal" },
        { id: "t2", handle: "ticket-2", subject: "B", status: "open", priority: "normal" },
        { id: "t3", handle: "ticket-3", subject: "C", status: "open", priority: "normal" },
      ],
      nextCursor: null,
    })
    const api = { post } as any
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      applyTicketMessageToList,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()
    // Under an oldest-activity-first sort (the toggle's other direction), a fresh
    // message makes the ticket the most-recently-touched, so it belongs at the end.
    setListParams({ ...paramsForSmartFilter("all-open"), sort: "activity_oldest" })
    await loadTickets(api)
    expect(ticketListStore.ids).toEqual(["t1", "t2", "t3"])

    applyTicketMessageToList({ ticketId: "t1", kind: "inbound", textBody: "customer wrote" })
    expect(ticketListStore.ids).toEqual(["t2", "t3", "t1"])
  })

  it("applyTicketMessageToList ignores internal notes and unknown tickets", async () => {
    const post = vi.fn().mockResolvedValue({
      items: [{ id: "t1", handle: "ticket-1", subject: "A", status: "open", priority: "normal" }],
      nextCursor: null,
    })
    const api = { post } as any
    const { loadTickets, applyTicketMessageToList, ticketListStore, resetTicketListStore } =
      await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()
    await loadTickets(api)
    const before = { ...ticketListStore.byId.t1 }

    applyTicketMessageToList({ ticketId: "t1", kind: "note", textBody: "internal only" })
    expect(ticketListStore.byId.t1).toEqual(before)

    // Unknown ticket (not currently in the loaded list) — no-op, no throw.
    expect(() =>
      applyTicketMessageToList({ ticketId: "unknown", kind: "inbound", textBody: "x" }),
    ).not.toThrow()
  })

  it("applyTicketUpdateToList prunes a ticket closed out of the all-open filter and patches survivors", async () => {
    const post = vi.fn().mockResolvedValue({
      items: [
        { id: "t1", handle: "ticket-1", subject: "A", status: "open", priority: "normal" },
        {
          id: "t2",
          handle: "ticket-2",
          subject: "B",
          status: "awaiting_customer",
          priority: "low",
        },
      ],
      nextCursor: null,
    })
    const api = { post } as any
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      applyTicketUpdateToList,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()
    setListParams(paramsForSmartFilter("all-open"))
    await loadTickets(api)
    expect(ticketListStore.ids).toEqual(["t1", "t2"])

    // Closing t1 in its own tab -> its status leaves the all-open status set ->
    // the row must drop out of the list without waiting for a manual reload.
    applyTicketUpdateToList("t1", { status: "closed", closedReason: "resolved" })
    expect(ticketListStore.ids).toEqual(["t2"])
    expect(ticketListStore.byId.t1).toBeUndefined()

    // A field change that keeps the ticket in the filter patches the row in place.
    applyTicketUpdateToList("t2", { priority: "urgent" })
    expect(ticketListStore.ids).toEqual(["t2"])
    expect(ticketListStore.byId.t2.priority).toBe("urgent")
  })

  it("applyTicketUpdateToList drops a reopened ticket from the closed filter and ignores unknown ids", async () => {
    const post = vi.fn().mockResolvedValue({
      items: [
        { id: "c1", handle: "ticket-c1", subject: "Closed", status: "closed", priority: "normal" },
      ],
      nextCursor: null,
    })
    const api = { post } as any
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      applyTicketUpdateToList,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()
    setListParams(paramsForSmartFilter("closed"))
    await loadTickets(api)
    expect(ticketListStore.ids).toEqual(["c1"])

    applyTicketUpdateToList("c1", { status: "open", closedReason: null })
    expect(ticketListStore.ids).toEqual([])

    // Not in the loaded list -> no-op, no throw.
    expect(() => applyTicketUpdateToList("ghost", { status: "closed" })).not.toThrow()
  })

  it("refreshFilterCounts fetches an exact count per status-scoped smart filter via countOnly", async () => {
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      const counts: Record<string, number> = {
        "awaiting-customer": 84,
        "follow-ups": 2,
        closed: 7,
        "all-open": 61,
      }
      return { items: [], nextCursor: null, totalCount: counts[body.params.smartFilter] ?? 0 }
    })
    const api = { post } as any
    const {
      refreshFilterCounts,
      ticketFilterCountStore,
      COUNTED_SMART_FILTERS,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()
    await refreshFilterCounts(api)

    expect(ticketFilterCountStore.countByFilter["awaiting-customer"]).toBe(84)
    expect(ticketFilterCountStore.countByFilter["follow-ups"]).toBe(2)
    expect(ticketFilterCountStore.countByFilter.closed).toBe(7)
    // "All open work" is counted like the rest (it used to show the unread total).
    expect(ticketFilterCountStore.countByFilter["all-open"]).toBe(61)
    // Every counted filter asks the server for a count-only page (no rows fetched).
    expect(post).toHaveBeenCalledTimes(COUNTED_SMART_FILTERS.length)
    for (const call of post.mock.calls) {
      expect(call[1].params.countOnly).toBe(true)
    }
  })

  it("multi-select toggle and clear work", async () => {
    const { ticketListStore, toggleSelection, selectedIds, clearSelection, resetTicketListStore } =
      await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()
    toggleSelection("a")
    toggleSelection("b")
    expect(selectedIds().sort()).toEqual(["a", "b"])
    toggleSelection("a")
    expect(selectedIds()).toEqual(["b"])
    clearSelection()
    expect(selectedIds()).toEqual([])
    expect(ticketListStore.selection).toEqual({})
  })

  it("setStatusFilter narrows to a subset and reverts to the view scope when cleared", async () => {
    const post = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    const api = { post } as any
    const { setListParams, paramsForSmartFilter, setStatusFilter, ticketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    setListParams(paramsForSmartFilter("all-open"))

    setStatusFilter(api, ["open"])
    expect(ticketListStore.params.status).toEqual(["open"])
    await Promise.resolve()
    expect(post.mock.calls.at(-1)?.[1].params.status).toEqual(["open"])

    // Empty selection reverts to the smart filter's natural status scope, never
    // an empty status list (which would match nothing).
    setStatusFilter(api, [])
    expect(ticketListStore.params.status).toEqual([
      "open",
      "awaiting_customer",
      "awaiting_followup",
    ])
  })

  it("setInboxFilter writes sourceInboxId (not inboxId) so it layers on the view", async () => {
    const post = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    const api = { post } as any
    const { setListParams, paramsForSmartFilter, setInboxFilter, ticketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    setListParams(paramsForSmartFilter("all-open"))

    setInboxFilter(api, "ibx1")
    expect(ticketListStore.params.sourceInboxId).toBe("ibx1")
    expect(ticketListStore.params.inboxId).toBeUndefined()

    setInboxFilter(api, null)
    expect(ticketListStore.params.sourceInboxId).toBeUndefined()
  })

  it("setTeamFilter scopes to one team and sends the label VERBATIM to the backend", async () => {
    const post = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    const api = { post } as any
    const { setListParams, paramsForSmartFilter, setTeamFilter, ticketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    setListParams(paramsForSmartFilter("all-open"))

    // `team` is an ARRAY on the wire (search accepts several), but the chip is a
    // single choice — so one element, not a bare string.
    setTeamFilter(api, "Support EU")
    expect(ticketListStore.params.team).toEqual(["Support EU"])

    // Teams are free text: a label whose leading space is REAL must survive to
    // the query untouched, or the filter silently matches nothing.
    setTeamFilter(api, " Support US")
    expect(ticketListStore.params.team).toEqual([" Support US"])
    const lastBody = post.mock.calls.at(-1)?.[1]
    expect(lastBody?.params?.team).toEqual([" Support US"])

    setTeamFilter(api, null)
    expect(ticketListStore.params.team).toBeUndefined()
  })

  it("setSortMode sets and clears the explicit sort", async () => {
    const post = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    const api = { post } as any
    const { setListParams, paramsForSmartFilter, setSortMode, ticketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    setListParams(paramsForSmartFilter("all-open"))

    setSortMode(api, "oldest")
    expect(ticketListStore.params.sort).toBe("oldest")
    await Promise.resolve()
    expect(post.mock.calls.at(-1)?.[1].params.sort).toBe("oldest")

    setSortMode(api, null)
    expect(ticketListStore.params.sort).toBeUndefined()
  })

  it("a new message does not re-front the row when an explicit created_at sort is active", async () => {
    const post = vi.fn().mockResolvedValue({
      items: [
        { id: "t1", handle: "ticket-1", subject: "A", status: "open", priority: "normal" },
        { id: "t2", handle: "ticket-2", subject: "B", status: "open", priority: "normal" },
        { id: "t3", handle: "ticket-3", subject: "C", status: "open", priority: "normal" },
      ],
      nextCursor: null,
    })
    const api = { post } as any
    const {
      loadTickets,
      setListParams,
      paramsForSmartFilter,
      applyTicketMessageToList,
      ticketListStore,
      resetTicketListStore,
    } = await import("~/modules/tickets/ticket-list-store")
    resetTicketListStore()
    setListParams({ ...paramsForSmartFilter("all-open"), sort: "oldest" })
    await loadTickets(api)
    expect(ticketListStore.ids).toEqual(["t1", "t2", "t3"])

    // Under an explicit chronological sort a new message must NOT jump the row to
    // the top (created_at is unchanged) — the row stays put; the field still updates.
    applyTicketMessageToList({ ticketId: "t3", kind: "inbound", textBody: "customer wrote" })
    expect(ticketListStore.ids).toEqual(["t1", "t2", "t3"])
    expect(ticketListStore.byId.t3.unread).toBe(true)
  })

  it("a non-empty query searches ALL tickets: view narrowing is dropped from the request", async () => {
    const post = vi.fn().mockResolvedValue({ items: [], nextCursor: null })
    const api = { post } as any
    const { loadTickets, setListParams, paramsForSmartFilter, searchOverridesView } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    // Searching a customer name from "Needs attention" must not stay scoped to
    // that view — a ticket awaiting the customer (or closed) still has to match.
    setListParams({ ...paramsForSmartFilter("needs-attention"), query: "nachumi" })
    await loadTickets(api)
    let sent = post.mock.calls.at(-1)?.[1].params
    expect(sent.query).toBe("nachumi")
    expect(sent.smartFilter).toBeUndefined()
    expect(sent.status).toBeUndefined()
    expect(searchOverridesView()).toBe(true)

    // Same from the closed view: the 30-day closedAfter window must not hide
    // older tickets from a search.
    setListParams({ ...paramsForSmartFilter("closed"), query: "nachumi_e@me.com" })
    await loadTickets(api)
    sent = post.mock.calls.at(-1)?.[1].params
    expect(sent.status).toBeUndefined()
    expect(sent.closedAfter).toBeUndefined()

    // Clearing the query restores the view scope untouched.
    setListParams({ ...paramsForSmartFilter("closed"), query: "" })
    await loadTickets(api)
    sent = post.mock.calls.at(-1)?.[1].params
    expect(sent.smartFilter).toBe("closed")
    expect(sent.status).toEqual(["closed"])
    expect(sent.closedAfter).toBeTruthy()
    expect(searchOverridesView()).toBe(false)
  })

  it("a stale (out-of-order) response never clobbers the latest search results", async () => {
    let resolveFirst: (v: any) => void = () => {}
    const first = new Promise((r) => {
      resolveFirst = r
    })
    const post = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({
        items: [{ id: "t2", handle: "ticket-2", subject: "final", status: "open" }],
        nextCursor: null,
      })
    const api = { post } as any
    const { loadTickets, setListParams, paramsForSmartFilter, ticketListStore } = await import(
      "~/modules/tickets/ticket-list-store"
    )
    setListParams({ ...paramsForSmartFilter("all-open"), query: "nach" })
    const p1 = loadTickets(api)
    setListParams({ ...paramsForSmartFilter("all-open"), query: "nachumi" })
    await loadTickets(api)
    expect(ticketListStore.ids).toEqual(["t2"])
    // The earlier keystroke's response arrives late — it must be ignored.
    resolveFirst({
      items: [{ id: "t1", handle: "ticket-1", subject: "stale", status: "open" }],
      nextCursor: null,
    })
    await p1
    expect(ticketListStore.ids).toEqual(["t2"])
    expect(ticketListStore.loading).toBe(false)
  })
})
