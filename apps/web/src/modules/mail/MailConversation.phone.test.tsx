// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-2 T15. The mail conversation at phone width: its own nav bar, the pinned
// reply bar, the actions sheet, and the one thing the Discuss action must not
// change on the way to a phone, the message it injects into the personal DM.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    post: vi.fn(async (path: string) =>
      path === "/threads/dm" ? { data: { id: "dm-thread-1" } } : {},
    ),
    patch: vi.fn(),
    getEnvelope: vi.fn(async () => ({ data: [] })),
  } as any,
  archiveConversation: vi.fn(),
  createDraft: vi.fn(async () => ({ id: "draft-9" })),
  saveDraft: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),
  openTab: vi.fn(),
  dockAvailable: vi.fn(() => true),
  openConversation: vi.fn(),
  messages: [] as any[],
}))

const INBOUND_MESSAGE = {
  id: "msg-1",
  fromAddress: { name: "Alice", email: "alice@example.com" },
  toAddresses: [],
  ccAddresses: [],
  htmlBody: null,
  textBody: "The pedal stopped responding.",
  sentAt: "2026-04-13T10:00:00Z",
  direction: "inbound",
}

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "me", name: "Tester" }),
}))
vi.mock("~/modules/shell/tab-store", () => ({
  tabStore: {
    activeTabId: "test-tab",
    tabs: [{ id: "mail:conversation:conv-1", type: "mail:conversation", entityId: "conv-1" }],
  },
  openTab: state.openTab,
  makeTabId: (type: string, id: string) => `${type}:${id}`,
  tabToUrl: () => "/mail/conv-1",
}))
vi.mock("~/modules/mail/mail-conversation-store", () => ({
  archiveConversation: state.archiveConversation,
  claimConversation: vi.fn(),
  reassignConversation: vi.fn(),
  conversationStore: {
    byId: {
      "conv-1": {
        id: "conv-1",
        subject: "Client Feedback",
        snippet: "Preview",
        accountId: "acc-1",
        assignedTo: null,
        contactId: null,
        internalThreadId: null,
        status: "open",
        labels: [],
      },
    },
  },
}))
vi.mock("~/modules/mail/mail-draft-store", () => ({
  createDraft: state.createDraft,
  saveDraft: state.saveDraft,
}))
vi.mock("~/modules/mail/mail-account-store", () => ({
  getAccount: () => ({ id: "acc-1", ownerType: "org" }),
  allAccounts: () => [{ id: "acc-1", ownerType: "org" }],
}))
vi.mock("~/modules/mail/mail-message-store", () => ({
  getDiscussionMarkers: () => [],
  loadMessages: vi.fn(async () => {}),
  loadOlderMessages: vi.fn(async () => {}),
  getMessages: () => state.messages,
}))
vi.mock("~/modules/mail/MailMessageRenderer", () => ({
  MailMessageRenderer: () => <div data-testid="mock-renderer" />,
}))
vi.mock("~/modules/mail/MailReplyBar", () => ({
  MailReplyBar: (props: any) => (
    <div data-testid="mock-reply-bar" data-initial-mode={props.initialMode ?? "none"} />
  ),
}))
vi.mock("~/modules/mail/MailEncryptionEnrollmentBanner", () => ({
  MailEncryptionEnrollmentBanner: () => null,
}))
vi.mock("~/modules/approvals/ApprovalCard", () => ({ default: () => null }))
vi.mock("~/framework/app-registry", () => ({ getContributions: () => [] }))
vi.mock("~/modules/tickets/MailConvertToTicketDialog", () => ({
  MailConvertToTicketDialog: (props: any) => (
    <div data-testid="mail-convert-dialog" data-conversation-id={props.mailConversationId} />
  ),
}))

// `discussWithPersonalAgent` runs for real: the batch's one hard requirement is
// that the phone does not change what it injects, so the store's own branch is
// what this exercises. Only its collaborators are stubbed.
vi.mock("~/modules/threads/message-store", () => ({ sendMessage: state.sendMessage }))
vi.mock("~/modules/threads/agent-directory", () => ({
  agentDirectoryLoaded: () => true,
  loadAgentDirectory: vi.fn(async () => {}),
  personalAgentFor: () => ({ id: "agent-1", name: "Liaison" }),
}))
vi.mock("~/modules/shell/dock-store", () => ({
  activeThreadId: () => null,
  collapse: vi.fn(),
  dockAvailable: state.dockAvailable,
  tabs: () => [],
  openConversation: state.openConversation,
}))
vi.mock("~/modules/shell/attention-store", () => ({ getAttentionApi: () => state.api }))

import { PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import { resetPersonalDmStore } from "~/modules/threads/personal-dm-store"
import { MailConversation } from "./MailConversation"
import MailConversationPhoneHeader from "./MailConversationPhoneHeader"

// K4: the nav bar (back / subject / "...") moved OUT of MailConversation into
// its own registered header component, the same way MainPanel composes them
// at runtime (the header in the bar, the body in the tab). This renders both
// together so the interaction tests (open the sheet, go back) still exercise
// the real wiring between them, through the shared
// `mail-conversation-phone-header-store` signal.
function renderConversationWithHeader(entityId = "conv-1") {
  return render(() => (
    <>
      <MailConversationPhoneHeader entityId={entityId} />
      <MailConversation entityId={entityId} />
    </>
  ))
}

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

beforeEach(() => {
  for (const fn of [
    state.archiveConversation,
    state.createDraft,
    state.saveDraft,
    state.sendMessage,
    state.openTab,
    state.openConversation,
  ]) {
    fn.mockClear()
  }
  resetPersonalDmStore()
  state.messages = [INBOUND_MESSAGE]
  setTier("phone")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setTier("desktop")
})

describe("MailConversation at phone tier", () => {
  // 390px. "Giulia Ferrari" wrapped onto two lines, the TO CUSTOMER chip broke
  // inside its own box and "Sent" plus the timestamp fell off the baseline,
  // because every part of the sender line was free to shrink and wrap.
  it("keeps the sender line on ONE row: the name truncates, the chip and the date stay whole", () => {
    state.messages = [
      {
        ...INBOUND_MESSAGE,
        id: "msg-out",
        direction: "outbound",
        sentByUser: null,
        fromAddress: { name: "Giulia Ferrari", email: "giulia@conservatoire.example" },
        toAddresses: [{ name: "Resonant Audio Labs", email: "hello@resonant.example" }],
      },
    ]
    render(() => <MailConversation entityId="conv-1" />)

    const name = screen.getByTestId("mail-message-from")
    const chip = screen.getByTestId("mail-message-to-customer")
    const sent = screen.getByTestId("mail-message-sent")
    const date = screen.getByTestId("mail-message-date")

    // Only the name gives, and it gives by truncating rather than wrapping.
    expect(name.className).toContain("truncate")
    expect(name.className).toContain("min-w-0")
    // The chip, the caption and the date never break and never shrink.
    for (const el of [chip, sent, date]) {
      expect(el.className).toContain("whitespace-nowrap")
      expect(el.className).toContain("shrink-0")
    }
    // The date is pushed right on the SAME row, not dropped mid-line.
    expect(date.className).toContain("ml-auto")
    const row = name.closest("div") as HTMLElement
    expect(row.contains(chip)).toBe(true)
    expect(row.contains(date)).toBe(true)
    expect(row.className).toContain("min-w-0")
    expect(row.className).not.toContain("flex-wrap")
    // "To:" sits UNDER the sender line, never inside it.
    const to = screen.getByTestId("mail-message-to")
    expect(row.contains(to)).toBe(false)
  })

  // K4: the nav bar used to render a SECOND time here while MainPanel's phone
  // top bar ALSO rendered its own generic bar above it. It now lives ONLY in
  // MailConversationPhoneHeader (own test file), registered onto the tab type
  // at runtime — this screen renders none of it.
  it("renders no in-screen nav bar: that lives in MailConversationPhoneHeader now", () => {
    render(() => <MailConversation entityId="conv-1" />)
    expect(screen.queryByTestId("mail-conversation-phone-header")).toBeNull()
    expect(screen.queryByTestId("mail-phone-back")).toBeNull()
    expect(screen.queryByTestId("mail-phone-subject")).toBeNull()
    expect(screen.queryByTestId("mail-phone-more")).toBeNull()
    expect(screen.queryByTestId("mail-status-pill")).toBeNull()
  })

  it("keeps the desktop header at desktop tier", () => {
    setTier("desktop")
    render(() => <MailConversation entityId="conv-1" />)
    expect(screen.queryByTestId("mail-conversation-phone-header")).toBeNull()
    expect(screen.queryByTestId("mail-action-bar")).toBeNull()
    expect(screen.getByTestId("mail-status-pill")).toBeTruthy()
  })

  it("goes back to the list, from the registered header", () => {
    render(() => <MailConversationPhoneHeader entityId="conv-1" />)
    fireEvent.click(screen.getByTestId("mail-phone-back"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mail:inbox", entityId: "inbox" }),
    )
  })

  it("pins reply, reply all and forward to the bottom", () => {
    render(() => <MailConversation entityId="conv-1" />)
    const bar = screen.getByTestId("mail-action-bar")
    expect(bar.querySelector('[data-testid="mail-action-reply"]')).not.toBeNull()
    expect(bar.querySelector('[data-testid="mail-action-reply-all"]')).not.toBeNull()
    expect(bar.querySelector('[data-testid="mail-action-forward"]')).not.toBeNull()
    // The desktop's inline composer is not also on screen.
    expect(screen.queryByTestId("mock-reply-bar")).toBeNull()
  })

  it("opens the existing composer full screen, on the tab the button named", async () => {
    render(() => <MailConversation entityId="conv-1" />)
    fireEvent.click(screen.getByTestId("mail-action-reply-all"))
    await waitFor(() => expect(screen.getByTestId("mail-composer-sheet")).toBeTruthy())
    expect(screen.getByTestId("mail-composer-sheet").dataset.mode).toBe("reply-all")
    expect(screen.getByTestId("mock-reply-bar").dataset.initialMode).toBe("reply-all")
  })

  it("forwards through a new draft opened in the compose view", async () => {
    render(() => <MailConversation entityId="conv-1" />)
    fireEvent.click(screen.getByTestId("mail-action-forward"))
    await waitFor(() => expect(state.createDraft).toHaveBeenCalled())
    expect(state.createDraft).toHaveBeenCalledWith(state.api, { accountId: "acc-1" })
    await waitFor(() => expect(state.saveDraft).toHaveBeenCalled())
    const [, draftId, changes] = state.saveDraft.mock.calls[0]! as unknown as [unknown, string, any]
    expect(draftId).toBe("draft-9")
    expect(changes.subject).toBe("Fwd: Client Feedback")
    expect(changes.textBody).toContain("The pedal stopped responding.")
    await waitFor(() =>
      expect(state.openTab).toHaveBeenCalledWith(
        expect.objectContaining({ type: "mail:compose", entityId: "draft-9" }),
      ),
    )
  })

  it("archives from the actions sheet, through the existing store method", async () => {
    renderConversationWithHeader()
    fireEvent.click(screen.getByTestId("mail-phone-more"))
    await waitFor(() => expect(screen.getByTestId("mail-more-sheet")).toBeTruthy())
    fireEvent.click(screen.getByTestId("mail-more-archive"))
    expect(state.archiveConversation).toHaveBeenCalledWith(state.api, "conv-1")
  })

  it("opens the convert dialog from the actions sheet", async () => {
    renderConversationWithHeader()
    fireEvent.click(screen.getByTestId("mail-phone-more"))
    await waitFor(() => expect(screen.getByTestId("mail-more-sheet")).toBeTruthy())
    fireEvent.click(screen.getByTestId("mail-more-convert"))
    await waitFor(() => expect(screen.getByTestId("mail-convert-dialog")).toBeTruthy())
    expect(screen.getByTestId("mail-convert-dialog").dataset.conversationId).toBe("conv-1")
  })

  it("injects exactly the same Discuss message as the desktop, and lands on the thread route", async () => {
    renderConversationWithHeader()
    fireEvent.click(screen.getByTestId("mail-phone-more"))
    await waitFor(() => expect(screen.getByTestId("mail-more-sheet")).toBeTruthy())
    fireEvent.click(screen.getByTestId("mail-more-discuss"))

    await waitFor(() => expect(state.sendMessage).toHaveBeenCalled())
    const [, threadId, text] = state.sendMessage.mock.calls[0]! as unknown as [
      unknown,
      string,
      string,
    ]
    expect(threadId).toBe("dm-thread-1")
    // F6: the mail travels as an ENTITY REFERENCE the thread renders as a
    // chip, not the bare "/mail/conv-1" path that opened nothing.
    expect(text).toBe("I want to discuss @[Client Feedback](mail:conversation:conv-1)")

    // At phone width the DM is a ROUTE, never the dock, even though the dock
    // reports itself available.
    expect(state.openConversation).not.toHaveBeenCalled()
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread", entityId: "dm-thread-1" }),
    )
  })
})
