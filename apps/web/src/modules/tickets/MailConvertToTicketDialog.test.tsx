// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"

function setTier(tier: "phone" | "desktop"): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: tier === "phone" ? query === PHONE_QUERY : query === "(min-width: 1024px)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  syncShellTier()
}

const state = vi.hoisted(() => ({
  api: { post: vi.fn() } as any,
  openTab: vi.fn(),
  onClose: vi.fn(),
  loadInboxes: vi.fn(),
  inboxes: [{ id: "in1", name: "Support", archivedAt: null, isDefaultForCreate: true }],
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: state.openTab }))
vi.mock("~/modules/tickets/ticket-inbox-store", () => ({
  loadInboxes: state.loadInboxes,
  ticketInboxStore: {
    get inboxes() {
      return state.inboxes
    },
  },
}))

import {
  resetMailConversationStore,
  upsertConversation,
} from "~/modules/mail/mail-conversation-store"
import { loadMessages, resetMailMessageStore } from "~/modules/mail/mail-message-store"
import {
  MailConvertToTicketAction,
  MailConvertToTicketBanner,
  MailConvertToTicketDialog,
} from "./MailConvertToTicketDialog"

describe("MailConvertToTicketDialog and slot hosts", () => {
  beforeEach(() => {
    state.api.post = vi.fn().mockResolvedValue({ ticketId: "t-new", ticketHandle: "ticket-9" })
    state.openTab.mockReset()
    state.onClose.mockReset()
    state.loadInboxes.mockResolvedValue(undefined)
    state.inboxes = [{ id: "in1", name: "Support", archivedAt: null, isDefaultForCreate: true }]
    resetMailConversationStore()
    resetMailMessageStore()
  })

  it("[SC10] dialog submit invokes mail:convertToTicket and opens the new ticket tab", async () => {
    render(() => <MailConvertToTicketDialog mailConversationId="mc1" onClose={state.onClose} />)
    await waitFor(() => expect(screen.getByTestId("mail-convert-inbox")).toBeTruthy())
    fireEvent.change(screen.getByTestId("mail-convert-inbox"), { target: { value: "in1" } })
    fireEvent.click(screen.getByTestId("mail-convert-submit"))
    await waitFor(() => expect(state.openTab).toHaveBeenCalled())
    expect(state.api.post.mock.calls[0][1]).toMatchObject({
      toolName: "mail:convertToTicket",
      params: { conversationId: "mc1", inboxId: "in1", idempotencyKey: "mail:convert:mc1" },
    })
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:ticket", entityId: "t-new" }),
    )
    expect(state.onClose).toHaveBeenCalled()
  })

  it("banner host renders the convert button and surfaces dialog on click", () => {
    render(() => <MailConvertToTicketBanner mailConversationId="mc1" />)
    expect(screen.getByTestId("mail-convert-banner")).toBeTruthy()
    fireEvent.click(screen.getByTestId("mail-convert-banner-button"))
    expect(screen.getByTestId("mail-convert-to-ticket-dialog")).toBeTruthy()
  })

  // K5: this prompt line duplicates the phone conversation screen's own
  // "..." sheet Convert action, so it is hidden there.
  describe("at phone tier", () => {
    afterEach(() => {
      cleanup()
      vi.unstubAllGlobals()
      setTier("desktop")
    })

    it("K5: hides the redundant follow-up prompt", () => {
      setTier("phone")
      render(() => <MailConvertToTicketBanner mailConversationId="mc1" />)
      expect(screen.queryByTestId("mail-convert-banner")).toBeNull()
    })

    it("K5: still shows the escalated state, once converted", () => {
      setTier("phone")
      upsertConversation({
        id: "mc1",
        accountId: "acct1",
        subject: "Help",
        status: "escalated",
        escalatedTicketId: "t-1",
        escalatedTicketHandle: "ticket-1",
        escalatedTicketStatus: "open",
      } as any)
      render(() => <MailConvertToTicketBanner mailConversationId="mc1" />)
      expect(screen.getByTestId("mail-escalated-banner")).toBeTruthy()
    })
  })

  it("renders escalated state and pulls the latest inbound reply", async () => {
    await loadMessages(
      {
        get: vi.fn().mockResolvedValue({
          conversation: {
            id: "mc1",
            accountId: "acct1",
            subject: "Help",
            snippet: "reply",
            isRead: true,
            isStarred: false,
            status: "escalated",
            lastMessageAt: "2026-01-01T00:02:00Z",
            messageCount: 2,
            assignedTo: null,
            contactId: null,
            internalThreadId: null,
            labels: [],
            senderName: "Alice",
            senderEmail: "alice@test.local",
            escalatedTicketId: "t1",
            escalatedTicketHandle: "ticket-9",
            escalatedTicketStatus: "open",
          },
          messages: [
            {
              id: "m1",
              conversationId: "mc1",
              direction: "inbound",
              sentAt: "2026-01-01T00:00:00Z",
            },
            {
              id: "m2",
              conversationId: "mc1",
              direction: "inbound",
              sentAt: "2026-01-01T00:02:00Z",
            },
          ],
          nextMessageCursor: null,
        }),
      },
      "mc1",
    )

    render(() => <MailConvertToTicketBanner mailConversationId="mc1" />)
    expect(screen.getByTestId("mail-escalated-banner").textContent).toContain("ticket-9")
    fireEvent.click(screen.getByTestId("mail-pull-reply-button"))
    await waitFor(() => expect(screen.getByTestId("mail-pull-reply-done")).toBeTruthy())
    expect(state.api.post).toHaveBeenCalledWith(
      "/apps/run-tool",
      expect.objectContaining({
        toolName: "tickets:pullMailReplyFromBanner",
        params: {
          ticketId: "t1",
          mailMessageId: "m2",
          idempotencyKey: "tickets:pullMailReply:t1:m2",
        },
      }),
    )
  })

  it("action host renders the convert action and surfaces dialog on click", () => {
    render(() => <MailConvertToTicketAction mailConversationId="mc1" />)
    fireEvent.click(screen.getByTestId("mail-convert-action-button"))
    expect(screen.getByTestId("mail-convert-to-ticket-dialog")).toBeTruthy()
  })

  it("action host opens the escalated ticket instead of offering conversion", () => {
    upsertConversation({
      id: "mc1",
      accountId: "acct1",
      subject: "Help",
      snippet: "reply",
      isRead: true,
      isStarred: false,
      status: "escalated",
      lastMessageAt: "2026-01-01T00:02:00Z",
      messageCount: 2,
      assignedTo: null,
      contactId: null,
      internalThreadId: null,
      labels: [],
      senderName: "Alice",
      senderEmail: "alice@test.local",
      escalatedTicketId: "t1",
      escalatedTicketHandle: "ticket-9",
      escalatedTicketStatus: "open",
    })
    render(() => <MailConvertToTicketAction mailConversationId="mc1" />)
    expect(screen.queryByTestId("mail-convert-action-button")).toBeNull()
    fireEvent.click(screen.getByTestId("mail-convert-action-open-ticket"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "tickets:ticket", entityId: "t1", label: "ticket-9" }),
    )
  })
})
