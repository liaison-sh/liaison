// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-2 T14 and T16. The phone mail list: the large title and the account line
// under it, the title as the way back into the navigator, the segmented
// filter, the swipe actions, the long press sheet and the claim and release
// pair on a shared mailbox. Every assertion is on behaviour or on rendered
// text, never on a class string.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface MockConversation {
  id: string
  accountId: string
  assignedTo: string | null
  subject: string
  snippet: string
  senderName: string
  senderEmail: string
  isRead: boolean
  isStarred: boolean
  lastMessageAt: string
}

const state = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn(), getEnvelope: vi.fn() } as any,
  accounts: [] as any[],
  currentView: "inbox" as string,
  store: {
    ids: [] as string[],
    byId: {} as Record<string, MockConversation>,
    searchIds: [] as string[],
  },
  archiveConversation: vi.fn(),
  toggleRead: vi.fn(),
  toggleStar: vi.fn(),
  claimConversation: vi.fn(),
  unassignConversation: vi.fn(),
  openTab: vi.fn(),
  openPhoneNavigator: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "me", name: "Tester" }),
  // The mailbox modules subscribe at import (key wipe, crypto worker).
  onAuthCleared: () => () => {},
}))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: state.openTab }))
vi.mock("~/modules/shell/phone-navigator-store", () => ({
  openPhoneNavigator: state.openPhoneNavigator,
}))
vi.mock("~/modules/mail/mail-draft-store", () => ({ loadDrafts: vi.fn(), drafts: () => ({}) }))
vi.mock("~/modules/mail/mail-account-store", () => ({
  accountsLoaded: () => true,
  allAccounts: () => state.accounts,
  getAccount: (id: string) => state.accounts.find((a) => a.id === id),
  loadAccounts: vi.fn(),
}))
vi.mock("~/modules/mail/mail-conversation-store", () => ({
  conversationStore: state.store,
  currentView: () => state.currentView,
  loading: () => false,
  loadingMore: () => false,
  hasMore: () => false,
  deepSearching: () => false,
  clearDeepSearch: vi.fn(),
  searchAllConversations: vi.fn(),
  loadConversations: vi.fn(),
  loadMoreConversations: vi.fn(),
  archiveConversation: state.archiveConversation,
  toggleRead: state.toggleRead,
  toggleStar: state.toggleStar,
  claimConversation: state.claimConversation,
  reassignConversation: vi.fn(),
  unassignConversation: state.unassignConversation,
  setView: (view: string) => {
    state.currentView = view
  },
}))
vi.mock("~/modules/mail/AssigneePicker", () => ({
  AssigneePicker: () => <span data-testid="assignee-chip" />,
}))

import { PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import { MailInbox } from "./MailInbox"

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

function conversation(over: Partial<MockConversation> & { id: string }): MockConversation {
  return {
    accountId: "acc-shared",
    assignedTo: null,
    subject: `Subject ${over.id}`,
    snippet: `Preview ${over.id}`,
    senderName: `Sender ${over.id}`,
    senderEmail: `${over.id}@example.com`,
    isRead: true,
    isStarred: false,
    lastMessageAt: "2026-04-13T10:00:00Z",
    ...over,
  }
}

beforeEach(() => {
  for (const fn of [
    state.archiveConversation,
    state.toggleRead,
    state.toggleStar,
    state.claimConversation,
    state.unassignConversation,
    state.openTab,
    state.openPhoneNavigator,
  ]) {
    fn.mockReset()
  }
  state.currentView = "inbox"
  state.accounts = [
    {
      id: "acc-shared",
      emailAddress: "support@acme.test",
      displayName: "Support",
      ownerType: "org",
      unreadCount: 1,
    },
  ]
  const unread = conversation({ id: "c1", isRead: false, subject: "Pedal not detected" })
  const read = conversation({ id: "c2", isRead: true, isStarred: true, subject: "Refund" })
  state.store.ids = ["c1", "c2"]
  state.store.byId = { c1: unread, c2: read }
  setTier("phone")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setTier("desktop")
})

describe("MailInbox at phone tier", () => {
  it("titles the screen with the folder and names the account under it", () => {
    render(() => <MailInbox entityId="inbox" />)
    expect(screen.getByTestId("mail-phone-title").textContent).toContain("Inbox")
    expect(screen.getByTestId("mail-phone-account").textContent).toBe("support@acme.test")
  })

  it("follows the store into another folder", () => {
    state.currentView = "starred"
    render(() => <MailInbox entityId="starred" />)
    expect(screen.getByTestId("mail-phone-title").textContent).toContain("Starred")
  })

  it("counts the accounts rather than naming one when several are connected", () => {
    state.accounts = [
      ...state.accounts,
      { id: "acc-2", emailAddress: "me@example.com", ownerType: "user", unreadCount: 0 },
    ]
    render(() => <MailInbox entityId="inbox" />)
    expect(screen.getByTestId("mail-phone-account").textContent).toContain("2")
  })

  it("opens the navigator sheet from the title", () => {
    render(() => <MailInbox entityId="inbox" />)
    fireEvent.click(screen.getByTestId("mail-phone-title"))
    expect(state.openPhoneNavigator).toHaveBeenCalledTimes(1)
  })

  it("renders a row with sender, subject and preview", () => {
    render(() => <MailInbox entityId="inbox" />)
    const rows = screen.getAllByTestId("conversation-row")
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain("Sender c1")
    expect(rows[0]!.textContent).toContain("Pedal not detected")
    expect(rows[0]!.textContent).toContain("Preview c1")
  })

  it("a sealed row says locked, never No subject", () => {
    state.store.ids = ["c3"]
    state.store.byId = {
      c3: { ...conversation({ id: "c3", subject: "", snippet: "" }), sealed: true } as any,
    }
    render(() => <MailInbox entityId="inbox" />)
    const row = screen.getByTestId("conversation-row")
    expect(row.querySelector('[data-testid="conversation-row-locked"]')).toBeTruthy()
    expect(row.textContent).not.toMatch(/no subject/i)
  })

  it("narrows to unread and to starred, and back to all", () => {
    render(() => <MailInbox entityId="inbox" />)
    expect(screen.getByTestId("mail-filter-unread-count").textContent).toBe("1")

    fireEvent.click(screen.getByTestId("mail-filter-unread"))
    expect(screen.getAllByTestId("conversation-row")).toHaveLength(1)
    expect(screen.getAllByTestId("conversation-row")[0]!.dataset.conversationId).toBe("c1")

    fireEvent.click(screen.getByTestId("mail-filter-starred"))
    expect(screen.getAllByTestId("conversation-row")).toHaveLength(1)
    expect(screen.getAllByTestId("conversation-row")[0]!.dataset.conversationId).toBe("c2")

    fireEvent.click(screen.getByTestId("mail-filter-all"))
    expect(screen.getAllByTestId("conversation-row")).toHaveLength(2)
  })

  it("archives through the store the desktop row already calls", () => {
    render(() => <MailInbox entityId="inbox" />)
    const rail = screen.getByTestId("mail-swipe-c1")
    fireEvent.click(rail.querySelector('[data-testid="swipe-action-archive"]')!)
    expect(state.archiveConversation).toHaveBeenCalledWith(state.api, "c1")
  })

  it("offers convert to ticket on the same rail", () => {
    render(() => <MailInbox entityId="inbox" />)
    const rail = screen.getByTestId("mail-swipe-c1")
    expect(rail.querySelector('[data-testid="swipe-action-convert-to-ticket"]')).not.toBeNull()
  })

  it("opens the compose view from the phone bar", () => {
    render(() => <MailInbox entityId="inbox" />)
    fireEvent.click(screen.getByTestId("mail-phone-compose"))
    expect(state.openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: "mail:compose", entityId: "compose" }),
    )
  })

  it("paints none of the phone chrome at desktop tier", () => {
    setTier("desktop")
    render(() => <MailInbox entityId="inbox" />)
    expect(screen.queryByTestId("mail-phone-header")).toBeNull()
    expect(screen.queryByTestId("mail-filter-unread")).toBeNull()
    expect(screen.queryByTestId("mail-swipe-c1")).toBeNull()
  })
})

describe("MailInbox long press sheet", () => {
  it("marks read and stars through the existing store methods", async () => {
    render(() => <MailInbox entityId="inbox" />)
    await openSheetFor("c1")

    fireEvent.click(screen.getByTestId("mail-sheet-read"))
    expect(state.toggleRead).toHaveBeenCalledWith(state.api, "c1")

    await openSheetFor("c1")
    fireEvent.click(screen.getByTestId("mail-sheet-star"))
    expect(state.toggleStar).toHaveBeenCalledWith(state.api, "c1")
  })

  it("claims an unassigned shared conversation and releases an assigned one", async () => {
    render(() => <MailInbox entityId="inbox" />)
    await openSheetFor("c1")
    fireEvent.click(screen.getByTestId("mail-sheet-claim"))
    expect(state.claimConversation).toHaveBeenCalledWith(state.api, "c1", "me")

    state.store.byId.c2!.assignedTo = "me"
    await openSheetFor("c2")
    fireEvent.click(screen.getByTestId("mail-sheet-release"))
    expect(state.unassignConversation).toHaveBeenCalledWith(state.api, "c2")
  })

  it("offers neither claim nor release on a personal mailbox", async () => {
    state.accounts = [
      { id: "acc-shared", emailAddress: "me@example.com", ownerType: "user", unreadCount: 0 },
    ]
    render(() => <MailInbox entityId="inbox" />)
    await openSheetFor("c1")
    expect(screen.queryByTestId("mail-sheet-claim")).toBeNull()
    expect(screen.queryByTestId("mail-sheet-release")).toBeNull()
    expect(screen.getByTestId("mail-sheet-star")).toBeTruthy()
  })
})

/** Hold a finger on the row long enough for SwipeRow to call `onLongPress`. */
async function openSheetFor(id: string): Promise<void> {
  // Child 0 is the action rail underneath; child 1 is the content that carries
  // the pointer handlers.
  const row = screen.getByTestId(`mail-swipe-${id}`).children[1] as HTMLElement
  vi.useFakeTimers()
  try {
    fireEvent.pointerDown(row, { clientX: 10, clientY: 10, button: 0 })
    vi.advanceTimersByTime(600)
  } finally {
    vi.useRealTimers()
  }
  await waitFor(() => expect(screen.getByTestId("mail-row-sheet")).toBeTruthy())
}
