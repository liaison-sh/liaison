// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

describe("ticket-inbox-store", () => {
  beforeEach(async () => {
    vi.resetModules()
  })

  it("loadInboxes populates inboxes via tickets:inboxes.list and refreshes counts", async () => {
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:inboxes.list") {
        return [
          {
            id: "i1",
            connectedAccountId: "ca1",
            name: "Inbox 1",
            emailAddress: "a@x",
            defaultTeam: null,
            defaultSensitivity: "internal",
            fromDisplayName: null,
            isDefaultForCreate: true,
            archivedAt: null,
          },
          {
            id: "i2",
            connectedAccountId: "ca2",
            name: "Inbox 2",
            emailAddress: "b@x",
            defaultTeam: null,
            defaultSensitivity: "internal",
            fromDisplayName: null,
            isDefaultForCreate: false,
            archivedAt: null,
          },
        ]
      }
      if (body?.toolName === "tickets:inboxCounts") {
        return {
          counts: [
            { inboxId: "i1", unread: 3 },
            { inboxId: "i2", unread: 0 },
          ],
        }
      }
      return null
    })
    const api = { post } as any
    const { loadInboxes, ticketInboxStore } = await import("~/modules/tickets/ticket-inbox-store")
    await loadInboxes(api)
    expect(ticketInboxStore.inboxes).toHaveLength(2)
    expect(ticketInboxStore.unreadByInboxId.i1).toBe(3)
    expect(ticketInboxStore.unreadByInboxId.i2).toBe(0)
    expect(ticketInboxStore.loaded).toBe(true)
  })

  it("loadInboxes gives the snake_case admin rows their camelCase keys", async () => {
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:inboxes.list") {
        return [
          {
            id: "i1",
            connected_account_id: "ca1",
            name: "Inbox 1",
            email_address: "a@x",
            default_team: "support",
            default_sensitivity: "internal",
            is_default_for_create: true,
            sla_exempt: false,
            archived_at: null,
          },
        ]
      }
      if (body?.toolName === "tickets:inboxCounts") return { counts: [] }
      return null
    })
    const { loadInboxes, ticketInboxStore } = await import("~/modules/tickets/ticket-inbox-store")
    await loadInboxes({ post } as any)
    const inbox = ticketInboxStore.inboxes[0]!
    expect(inbox.isDefaultForCreate).toBe(true)
    expect(inbox.emailAddress).toBe("a@x")
    expect(inbox.defaultTeam).toBe("support")
    expect(inbox.connectedAccountId).toBe("ca1")
    expect(inbox.archivedAt).toBeNull()
    expect(inbox.sla_exempt).toBe(false)
  })

  it("an inbox update event in snake_case replaces the camelCase value", async () => {
    const { handleInboxEvent, ticketInboxStore, resetTicketInboxStore } = await import(
      "~/modules/tickets/ticket-inbox-store"
    )
    resetTicketInboxStore()
    handleInboxEvent("create", { id: "x1", name: "X", is_default_for_create: false })
    expect(ticketInboxStore.inboxes[0]?.isDefaultForCreate).toBe(false)
    handleInboxEvent("update", { id: "x1", is_default_for_create: true })
    expect(ticketInboxStore.inboxes[0]?.isDefaultForCreate).toBe(true)
  })

  it("handleInboxEvent applies create/update/disconnect actions", async () => {
    const { handleInboxEvent, ticketInboxStore, resetTicketInboxStore } = await import(
      "~/modules/tickets/ticket-inbox-store"
    )
    resetTicketInboxStore()
    handleInboxEvent("create", {
      id: "x1",
      connectedAccountId: "ca",
      name: "X",
      emailAddress: "x@x",
      isDefaultForCreate: false,
      archivedAt: null,
    })
    expect(ticketInboxStore.inboxes.find((i) => i.id === "x1")?.name).toBe("X")
    handleInboxEvent("update", { id: "x1", name: "X updated" })
    expect(ticketInboxStore.inboxes.find((i) => i.id === "x1")?.name).toBe("X updated")
    handleInboxEvent("disconnect", { id: "x1" })
    expect(ticketInboxStore.inboxes.find((i) => i.id === "x1")?.archivedAt).toBeTruthy()
  })

  it("the All badge is the server's totalUnread, not the per-inbox sum", async () => {
    const post = vi.fn().mockImplementation(async (_path: string, body: any) => {
      if (body?.toolName === "tickets:inboxCounts") {
        return { counts: [{ inboxId: "i1", unread: 2 }], totalUnread: 7 }
      }
      return null
    })
    const { refreshInboxCounts, totalUnreadAcrossInboxes } = await import(
      "~/modules/tickets/ticket-inbox-store"
    )
    await refreshInboxCounts({ post } as any)
    expect(totalUnreadAcrossInboxes()).toBe(7)
  })

  it("falls back to the per-inbox sum when the server sends no total", async () => {
    const post = vi.fn().mockResolvedValue({
      counts: [
        { inboxId: "i1", unread: 2 },
        { inboxId: "i2", unread: 1 },
      ],
    })
    const { refreshInboxCounts, totalUnreadAcrossInboxes } = await import(
      "~/modules/tickets/ticket-inbox-store"
    )
    await refreshInboxCounts({ post } as any)
    expect(totalUnreadAcrossInboxes()).toBe(3)
  })
})
