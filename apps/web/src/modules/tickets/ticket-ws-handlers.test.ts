// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-ws-handlers", () => {
  beforeEach(() => vi.resetModules())

  it("invalidates ticket inboxes for tickets connected-account events", async () => {
    const { handleConnectedAccountEvent } = await import("~/modules/tickets/ticket-ws-handlers")
    const calls: unknown[] = []
    const listener = (event: Event) => calls.push((event as CustomEvent).detail)
    window.addEventListener("tickets:inboxes-invalidated", listener)
    try {
      handleConnectedAccountEvent("create", { appName: "mail", id: "ca-mail" })
      handleConnectedAccountEvent("create", { appName: "tickets", id: "ca-tickets" })
    } finally {
      window.removeEventListener("tickets:inboxes-invalidated", listener)
    }

    expect(calls).toEqual([{ action: "create", data: { appName: "tickets", id: "ca-tickets" } }])
  })

  it("routes mail conversion events into the Mail banner state", async () => {
    const { conversationStore, resetMailConversationStore, upsertConversation } = await import(
      "~/modules/mail/mail-conversation-store"
    )
    const { handleMailConversationEvent } = await import("~/modules/tickets/ticket-ws-handlers")
    resetMailConversationStore()
    upsertConversation({
      id: "m1",
      accountId: "a1",
      subject: "Hello",
      snippet: "Hi",
      isRead: true,
      isStarred: false,
      status: "open",
      lastMessageAt: "2026-01-01T00:00:00.000Z",
      messageCount: 1,
      assignedTo: null,
      contactId: null,
      internalThreadId: null,
      labels: [],
      senderName: null,
      senderEmail: null,
      escalatedTicketId: null,
      escalatedTicketHandle: null,
      escalatedTicketStatus: null,
    })

    handleMailConversationEvent("converted", {
      conversationId: "m1",
      escalatedTicketId: "t1",
      escalatedTicketHandle: "T-1",
    })

    expect(conversationStore.byId.m1.escalatedTicketId).toBe("t1")
    expect(conversationStore.byId.m1.escalatedTicketHandle).toBe("T-1")
    expect(conversationStore.byId.m1.status).toBe("escalated")
  })

  it("applies SLA breach events to cached list and detail tickets", async () => {
    const { handleTicketEvent, getTicket, resetTicketDetailStore } = await import(
      "~/modules/tickets/ticket-detail-store"
    )
    const { applyTicketSlaBreach, loadTickets, resetTicketListStore, ticketListStore } =
      await import("~/modules/tickets/ticket-list-store")
    const { handleSlaEvent } = await import("~/modules/tickets/ticket-ws-handlers")
    const breachedAt = "2026-01-02T00:00:00.000Z"
    const slaDeadline = "2026-01-01T00:00:00.000Z"
    resetTicketDetailStore()
    resetTicketListStore()
    handleTicketEvent("create", { id: "t1", subject: "A", status: "open", slaBreachedAt: null })
    await loadTickets({
      post: vi.fn().mockResolvedValue({
        items: [{ id: "t1", subject: "A", slaBreachedAt: null }],
        nextCursor: null,
      }),
    } as any)
    applyTicketSlaBreach({ ticketId: "missing", breachedAt })

    handleSlaEvent("breach", { ticketId: "t1", breachedAt, slaDeadline })

    expect(ticketListStore.byId.t1.slaBreachedAt).toBe(breachedAt)
    expect(ticketListStore.byId.t1.slaDeadline).toBe(slaDeadline)
    expect(getTicket("t1")?.slaBreachedAt).toBe(breachedAt)
  })
})
