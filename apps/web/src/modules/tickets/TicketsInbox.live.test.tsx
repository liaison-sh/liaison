// SPDX-License-Identifier: FSL-1.1-ALv2
// The inbox list already patches rows it holds (status, preview, order). The
// gaps: a ticket that is NEW, or that ENTERS the view (reopened by a customer
// message, a status change into the filter), and a resync. Those reload it.
import { render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type EntityChangeEvent,
  EntityChangesTestAccess,
  notifyEntityChange,
} from "~/framework/entity-changes"
import { requestResync } from "~/framework/resync"

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  post: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ post: state.post, get: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
}))
vi.mock("~/modules/shell/WsContext", () => ({ useWs: () => ({ status: () => "connected" }) }))
vi.mock("~/modules/tickets/ticket-inbox-store", () => ({
  loadInboxes: vi.fn(),
  ticketInboxStore: { inboxes: [], loaded: true },
}))
vi.mock("~/modules/tickets/ticket-category-store", () => ({
  loadCategories: vi.fn(),
  ticketCategoryStore: { categories: [], loaded: true },
}))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  tabStore: {
    tabs: [{ id: "tickets:inbox", type: "tickets:inbox", routePath: "/tickets?filter=all-open" }],
    activeTabId: "tickets:inbox",
  },
}))

import { TicketsInbox } from "./TicketsInbox"
import { resetTicketListStore } from "./ticket-list-store"

const row = (id: string, subject: string) => ({
  id,
  handle: id,
  subject,
  status: "open",
  priority: "normal",
  unread: false,
  team: null,
})

const ev = (key: string, action: string, data: unknown): EntityChangeEvent => {
  const [app = "", entity = ""] = key.split(":")
  return { key, app, entity, action, data }
}

describe("TicketsInbox live list", () => {
  beforeEach(() => {
    EntityChangesTestAccess.reset()
    resetTicketListStore()
    state.rows = [row("t1", "First")]
    state.post.mockReset()
    state.post.mockImplementation(
      async (_path: string, body: { params?: { countOnly?: boolean } }) =>
        body.params?.countOnly
          ? { totalCount: state.rows.length }
          : { items: state.rows, nextCursor: null },
    )
  })
  afterEach(() => EntityChangesTestAccess.reset())

  it("a ticket created elsewhere appears in the list", async () => {
    render(() => <TicketsInbox />)
    await screen.findByTestId("tickets-list-row-t1")
    state.rows = [row("t2", "Brand new"), row("t1", "First")]
    notifyEntityChange(ev("tickets:ticket", "create", { ticketId: "t2", subject: "Brand new" }))
    await screen.findByTestId("tickets-list-row-t2")
  })

  it("a customer message on a ticket outside the list (reopen) brings it in", async () => {
    render(() => <TicketsInbox />)
    await screen.findByTestId("tickets-list-row-t1")
    state.rows = [row("t9", "Reopened"), row("t1", "First")]
    // The inbound path announces the append, and the reopen as a status change.
    notifyEntityChange(ev("tickets:message", "create", { ticketId: "t9", kind: "inbound" }))
    notifyEntityChange(
      ev("tickets:ticket", "update", { ticketId: "t9", changes: { status: "open" } }),
    )
    await screen.findByTestId("tickets-list-row-t9")
  })

  it("a customer message alone on a ticket outside a complete status view does not refetch", async () => {
    // The whole all-open view is loaded: a ticket not in it is closed or merged,
    // and a message that reopens it also announces the status change.
    render(() => <TicketsInbox />)
    await screen.findByTestId("tickets-list-row-t1")
    const calls = state.post.mock.calls.length
    notifyEntityChange(ev("tickets:message", "create", { ticketId: "t9", kind: "inbound" }))
    notifyEntityChange(ev("tickets:message", "create", { ticketId: "t8" }))
    await new Promise((r) => setTimeout(r, 300))
    expect(state.post.mock.calls.length).toBe(calls)
  })

  it("a customer message on a ticket past the loaded page lifts it to the top", async () => {
    state.post.mockImplementation(
      async (_path: string, body: { params?: { countOnly?: boolean } }) =>
        body.params?.countOnly ? { totalCount: 99 } : { items: state.rows, nextCursor: "page-2" },
    )
    render(() => <TicketsInbox />)
    await screen.findByTestId("tickets-list-row-t1")
    state.rows = [row("t40", "Old one, new reply"), row("t1", "First")]
    notifyEntityChange(ev("tickets:message", "create", { ticketId: "t40", kind: "inbound" }))
    await screen.findByTestId("tickets-list-row-t40")
  })

  it("a resync reloads the list", async () => {
    render(() => <TicketsInbox />)
    await screen.findByTestId("tickets-list-row-t1")
    state.rows = [row("t1", "First"), row("t3", "Missed while offline")]
    requestResync("test")
    await screen.findByTestId("tickets-list-row-t3")
  })

  it("an update to a row the list holds does not refetch (it is patched in place)", async () => {
    render(() => <TicketsInbox />)
    await screen.findByTestId("tickets-list-row-t1")
    const calls = state.post.mock.calls.length
    notifyEntityChange(
      ev("tickets:ticket", "update", { ticketId: "t1", changes: { priority: "high" } }),
    )
    notifyEntityChange(ev("tickets:message", "create", { ticketId: "t1", kind: "inbound" }))
    await new Promise((r) => setTimeout(r, 250))
    await waitFor(() => expect(state.post.mock.calls.length).toBe(calls))
  })
})
