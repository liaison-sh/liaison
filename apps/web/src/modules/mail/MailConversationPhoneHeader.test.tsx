// SPDX-License-Identifier: FSL-1.1-ALv2
//
// K4. MailConversationPhoneHeader is the mail conversation's phone-tier nav
// bar, tested on its own now that it is a separate component (registered onto
// the tab type at runtime, rendered by MainPanel's phone top bar) instead of a
// block inside MailConversation.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({ openTab: vi.fn(), openMailConversationMoreSheet: vi.fn() }))

vi.mock("~/modules/shell/tab-store", () => ({ openTab: state.openTab }))
vi.mock("~/modules/mail/mail-conversation-phone-header-store", () => ({
  openMailConversationMoreSheet: state.openMailConversationMoreSheet,
}))
vi.mock("~/modules/mail/mail-conversation-store", () => ({
  conversationStore: { byId: { "conv-1": { id: "conv-1", subject: "Client Feedback" } } },
}))
vi.mock("~/modules/mail/mail-message-store", () => ({
  getMessages: () => [],
}))

import MailConversationPhoneHeader from "~/modules/mail/MailConversationPhoneHeader"
import {
  clearThreadMapSize,
  closeThreadMap,
  isThreadMapOpen,
  setThreadMapSize,
} from "~/ui/thread-map-store"

describe("MailConversationPhoneHeader", () => {
  afterEach(() => {
    cleanup()
    state.openTab.mockClear()
    state.openMailConversationMoreSheet.mockClear()
  })

  it("shows the conversation's subject", () => {
    render(() => <MailConversationPhoneHeader entityId="conv-1" />)
    expect(screen.getByTestId("mail-phone-subject").textContent).toBe("Client Feedback")
  })

  it("back returns to the mail list", () => {
    render(() => <MailConversationPhoneHeader entityId="conv-1" />)
    fireEvent.click(screen.getByTestId("mail-phone-back"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mail:inbox", entityId: "inbox" }),
    )
  })

  it("the more control opens the shared actions sheet for this conversation", () => {
    render(() => <MailConversationPhoneHeader entityId="conv-1" />)
    fireEvent.click(screen.getByTestId("mail-phone-more"))
    expect(state.openMailConversationMoreSheet).toHaveBeenCalledWith("conv-1")
  })

  it("offers no thread map button on a thread of fewer than 3 messages", () => {
    setThreadMapSize("mail:conv-1", 2)
    render(() => <MailConversationPhoneHeader entityId="conv-1" />)
    expect(screen.queryByTestId("mail-phone-thread-map")).toBeNull()
    clearThreadMapSize("mail:conv-1")
  })

  it("the thread map button opens this conversation's drawer", () => {
    setThreadMapSize("mail:conv-1", 3)
    render(() => <MailConversationPhoneHeader entityId="conv-1" />)
    expect(isThreadMapOpen("mail:conv-1")).toBe(false)
    fireEvent.click(screen.getByTestId("mail-phone-thread-map"))
    expect(isThreadMapOpen("mail:conv-1")).toBe(true)
    closeThreadMap()
    clearThreadMapSize("mail:conv-1")
  })

  it("renders exactly one back control", () => {
    render(() => <MailConversationPhoneHeader entityId="conv-1" />)
    expect(screen.getAllByTestId("mail-phone-back")).toHaveLength(1)
  })
})
