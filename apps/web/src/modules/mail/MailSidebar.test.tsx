// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { MailSidebar } from "./MailSidebar"

const sidebarMocks = vi.hoisted(() => ({
  assignedToMeCount: vi.fn(() => 3),
  currentView: vi.fn(() => "inbox"),
  setView: vi.fn(),
  openTab: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({}),
}))

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: sidebarMocks.openTab,
}))

vi.mock("~/modules/mail/mail-conversation-store", () => ({
  assignedToMeCount: sidebarMocks.assignedToMeCount,
  currentView: sidebarMocks.currentView,
  setView: sidebarMocks.setView,
}))

vi.mock("~/modules/mail/mail-account-store", () => ({
  allAccounts: () => [{ id: "acc-1", unreadCount: 0 }],
  loadAccounts: vi.fn(),
  personalAccounts: () => [],
  sharedAccounts: () => [],
}))

vi.mock("~/modules/mail/mail-draft-store", () => ({
  drafts: () => ({}),
}))

beforeEach(() => {
  sidebarMocks.assignedToMeCount.mockReturnValue(3)
  sidebarMocks.currentView.mockReturnValue("inbox")
  sidebarMocks.setView.mockReset()
  sidebarMocks.openTab.mockReset()
})

describe("MailSidebar", () => {
  test("mailbox navigation activates the inbox tab", async () => {
    render(() => <MailSidebar />)
    await fireEvent.click(screen.getByTestId("mail-nav-starred"))

    expect(sidebarMocks.setView).toHaveBeenCalledWith("starred")
    expect(sidebarMocks.openTab).toHaveBeenCalledWith({
      type: "mail:inbox",
      entityId: "starred",
      label: "Mail",
    })
  })

  test("renders assigned-to-me item with count and activates the inbox tab", async () => {
    render(() => <MailSidebar />)

    const item = screen.getByTestId("mail-sidebar-assigned-to-me")
    expect(item).toHaveTextContent("Assigned to me")
    expect(item).toHaveTextContent("3")

    await fireEvent.click(item)

    expect(sidebarMocks.setView).toHaveBeenCalledWith("assigned-to-me")
    expect(sidebarMocks.openTab).toHaveBeenCalledWith({
      type: "mail:inbox",
      entityId: "inbox:assigned-to-me",
      label: "Mail",
    })
  })
})
