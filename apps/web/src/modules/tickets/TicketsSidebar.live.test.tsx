// SPDX-License-Identifier: FSL-1.1-ALv2
// The per-inbox unread badges were fetched on mount and on a WS reconnect
// only: a new ticket or a customer reply left them stale. They now follow
// ticket and message changes (and a resync).
import { render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { EntityChangesTestAccess, notifyEntityChange } from "~/framework/entity-changes"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  ),
)

const state = vi.hoisted(() => ({ unread: 1, post: vi.fn() }))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ post: state.post, get: vi.fn(), getEnvelope: vi.fn() }),
}))
vi.mock("~/modules/shell/WsContext", () => ({ useWs: () => ({ status: () => "connected" }) }))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  tabStore: {
    tabs: [{ id: "tickets:inbox", type: "tickets:inbox", routePath: "/tickets?filter=all-open" }],
    activeTabId: "tickets:inbox",
  },
}))
vi.mock("~/modules/tickets/ticket-category-store", () => ({
  loadCategories: vi.fn(),
  ticketCategoryStore: { categories: [] },
}))

import { TicketsSidebar } from "./TicketsSidebar"
import { resetTicketInboxStore } from "./ticket-inbox-store"

const inbox = {
  id: "i1",
  connectedAccountId: "ca",
  name: "Support",
  emailAddress: "s@x",
  defaultTeam: null,
  defaultSensitivity: "internal",
  fromDisplayName: null,
  isDefaultForCreate: true,
  archivedAt: null,
}

describe("TicketsSidebar live inbox counts", () => {
  beforeEach(() => {
    EntityChangesTestAccess.reset()
    resetTicketInboxStore()
    state.unread = 1
    state.post.mockReset()
    state.post.mockImplementation(async (_path: string, body: { toolName: string }) => {
      if (body.toolName === "tickets:inboxes.list") return [inbox]
      if (body.toolName === "tickets:inboxCounts") {
        return { counts: [{ inboxId: "i1", unread: state.unread }], totalUnread: state.unread }
      }
      if (body.toolName === "tickets:search") return { totalCount: 0, items: [] }
      return {}
    })
  })
  afterEach(() => EntityChangesTestAccess.reset())

  it("a new ticket moves the inbox unread badge without a reload", async () => {
    render(() => <TicketsSidebar />)
    await waitFor(() => expect(screen.getByTestId("tickets-inbox-unread-i1").textContent).toBe("1"))
    state.unread = 2
    notifyEntityChange({
      key: "tickets:ticket",
      app: "tickets",
      entity: "ticket",
      action: "create",
      data: { ticketId: "t2" },
    })
    await waitFor(
      () => expect(screen.getByTestId("tickets-inbox-unread-i1").textContent).toBe("2"),
      { timeout: 5000 },
    )
  })

  const countCalls = () =>
    state.post.mock.calls.filter(
      (c) => (c[1] as { toolName?: string } | undefined)?.toolName === "tickets:inboxCounts",
    ).length

  it("changes that cannot move an unread count do not recount", async () => {
    render(() => <TicketsSidebar />)
    await waitFor(() => expect(screen.getByTestId("tickets-inbox-unread-i1").textContent).toBe("1"))
    const before = countCalls()
    const fire = (key: string, action: string, data: unknown) =>
      notifyEntityChange({
        key,
        app: "tickets",
        entity: key.split(":")[1] ?? "",
        action,
        data,
      })
    fire("tickets:ticket", "update", { ticketId: "t1", changes: { priority: "high" } })
    fire("tickets:ticket", "breach", { ticketId: "t1" })
    fire("tickets:message", "create", { id: "m1", ticketId: "t1", kind: "outbound", textBody: "x" })
    fire("tickets:message", "create", { id: "m2", ticketId: "t1", kind: "note", textBody: "x" })
    fire("tickets:message", "update", { id: "m1", ticketId: "t1", attachments: [] })
    await new Promise((r) => setTimeout(r, 2000))
    expect(countCalls()).toBe(before)
    // A customer reply does.
    fire("tickets:message", "create", { ticketId: "t1" })
    await waitFor(() => expect(countCalls()).toBe(before + 1), { timeout: 5000 })
  }, 15000)
})
