// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { mailboxStore, resetMailboxStore } from "~/modules/mailbox/mailbox-store"
import { MAILBOX_UNLOCK_EVENT } from "~/modules/mailbox/mailbox-unlock-bus"
import { MailInbox } from "./MailInbox"

interface MockConversation {
  accountId: string
  assignedTo: string | null
  subject: string
  snippet: string
  senderName: string
  senderEmail: string
  isRead: boolean
  isStarred: boolean
  lastMessageAt: string
  sealed?: boolean
  encState?: "sealed" | "locked" | "opened"
}

const mailInboxState = vi.hoisted(() => ({
  accounts: [] as Array<{
    id: string
    unreadCount: number
    ownerType: "user" | "org"
    provider?: string
  }>,
  loadConversations: vi.fn(),
  api: { get: vi.fn().mockResolvedValue({ data: [] }), patch: vi.fn(), post: vi.fn() },
  claimConversation: vi.fn(),
  currentView: "inbox",
  drafts: {} as Record<string, unknown>,
  reassignConversation: vi.fn(),
  searchAllConversations: vi.fn(),
  hasMore: false,
  store: {
    ids: [] as string[],
    byId: {} as Record<string, MockConversation>,
    searchIds: [] as string[],
  },
}))

function resetInboxState(): void {
  mailInboxState.accounts = [{ id: "acc-1", unreadCount: 0, ownerType: "org" }]
  mailInboxState.api = {
    get: vi.fn().mockResolvedValue({ data: [] }),
    patch: vi.fn(),
    post: vi.fn(),
  }
  mailInboxState.claimConversation.mockReset()
  mailInboxState.currentView = "inbox"
  mailInboxState.drafts = {}
  mailInboxState.reassignConversation.mockReset()
  mailInboxState.searchAllConversations.mockReset()
  mailInboxState.hasMore = false
  mailInboxState.store.searchIds = []
  mailInboxState.store.ids = ["c1", "c2"]
  mailInboxState.store.byId = {
    c1: {
      accountId: "acc-1",
      assignedTo: null,
      subject: "Invoice #123",
      snippet: "Please pay",
      senderName: "Alice",
      senderEmail: "alice@co.com",
      isRead: true,
      isStarred: false,
      lastMessageAt: "2026-04-13T10:00:00Z",
    },
    c2: {
      accountId: "acc-1",
      assignedTo: null,
      subject: "Meeting notes",
      snippet: "Attached",
      senderName: "Bob",
      senderEmail: "bob@co.com",
      isRead: true,
      isStarred: false,
      lastMessageAt: "2026-04-13T09:00:00Z",
    },
  }
}

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => mailInboxState.api,
}))
vi.mock("~/modules/mail/mail-conversation-store", () => ({
  claimConversation: mailInboxState.claimConversation,
  conversationStore: mailInboxState.store,
  currentView: () => mailInboxState.currentView,
  loading: () => false,
  loadingMore: () => false,
  hasMore: () => mailInboxState.hasMore,
  deepSearching: () => false,
  clearDeepSearch: vi.fn(),
  searchAllConversations: mailInboxState.searchAllConversations,
  loadConversations: mailInboxState.loadConversations,
  loadMoreConversations: vi.fn(),
  toggleRead: vi.fn(),
  toggleStar: vi.fn(),
  archiveConversation: vi.fn(),
  reassignConversation: mailInboxState.reassignConversation,
  unassignConversation: vi.fn(),
  setView: (view: string) => {
    mailInboxState.currentView = view
  },
}))
vi.mock("~/modules/mail/mail-account-store", () => ({
  allAccounts: () => mailInboxState.accounts,
  getAccount: (id: string) => mailInboxState.accounts.find((account) => account.id === id),
  loadAccounts: vi.fn(),
}))
vi.mock("~/modules/mail/mail-draft-store", () => ({
  loadDrafts: vi.fn(),
  drafts: () => mailInboxState.drafts,
}))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
}))
vi.mock("~/modules/auth/auth-store", () => ({
  userFromToken: () => ({ userId: "current-user-id" }),
  // The mailbox modules subscribe at import (key wipe, crypto worker).
  onAuthCleared: () => () => {},
}))
vi.mock("~/modules/mail/AssigneePicker", () => ({
  AssigneePicker: (props: any) => (
    <button type="button" data-testid="assignee-chip" onClick={() => props.onReassign("user-2")}>
      Assigned {props.assignedTo}
    </button>
  ),
}))

beforeEach(() => {
  resetInboxState()
})

describe("MailInbox — search filter", () => {
  test("filters conversations by subject", async () => {
    render(() => <MailInbox entityId="inbox" />)
    const input = screen.getByTestId("mail-inbox-search")
    await fireEvent.input(input, { target: { value: "invoice" } })
    const row = screen.getByTestId("conversation-row")
    expect(row.dataset.conversationId).toBe("c1")
    expect(screen.getByText("Invoice #123")).toBeTruthy()
    expect(screen.queryByText("Meeting notes")).toBeNull()
  })

  test("filters conversations by sender", async () => {
    render(() => <MailInbox entityId="inbox" />)
    const input = screen.getByTestId("mail-inbox-search")
    await fireEvent.input(input, { target: { value: "bob" } })
    const row = screen.getByTestId("conversation-row")
    expect(row.dataset.conversationId).toBe("c2")
    expect(screen.queryByText("Invoice #123")).toBeNull()
    expect(screen.getByText("Meeting notes")).toBeTruthy()
  })

  test("shows all conversations when search is empty", () => {
    render(() => <MailInbox entityId="inbox" />)
    const rows = screen.getAllByTestId("conversation-row")
    expect(rows).toHaveLength(2)
  })

  test("shows a filtered-empty state when no loaded conversations match", async () => {
    render(() => <MailInbox entityId="inbox" />)
    const input = screen.getByTestId("mail-inbox-search")
    await fireEvent.input(input, { target: { value: "does-not-exist" } })
    expect(screen.queryByTestId("conversation-row")).toBeNull()
    expect(screen.getByText("No matching conversations")).toBeTruthy()
  })

  test("a fully loaded list is searched locally only: no request", async () => {
    vi.useFakeTimers()
    try {
      render(() => <MailInbox entityId="inbox" />)
      await fireEvent.input(screen.getByTestId("mail-inbox-search"), {
        target: { value: "invoice" },
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(mailInboxState.searchAllConversations).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  test("with more pages to load, the query also searches the whole view after a pause", async () => {
    mailInboxState.hasMore = true
    vi.useFakeTimers()
    try {
      render(() => <MailInbox entityId="inbox" />)
      const input = screen.getByTestId("mail-inbox-search")
      await fireEvent.input(input, { target: { value: "in" } })
      await fireEvent.input(input, { target: { value: "invoice" } })
      await vi.advanceTimersByTimeAsync(100)
      expect(mailInboxState.searchAllConversations).not.toHaveBeenCalled()
      // Nothing is claimed missing while the search over the view is pending.
      await fireEvent.input(input, { target: { value: "quarterly" } })
      expect(screen.queryByText("No matching conversations")).toBeNull()
      expect(screen.getByText("Searching all conversations…")).toBeTruthy()
      await vi.advanceTimersByTimeAsync(300)
      expect(mailInboxState.searchAllConversations).toHaveBeenCalledTimes(1)
      expect(mailInboxState.searchAllConversations).toHaveBeenCalledWith(
        mailInboxState.api,
        "quarterly",
        expect.anything(),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  test("a conversation found beyond the loaded pages is listed with the loaded matches", async () => {
    mailInboxState.hasMore = true
    // The server's search matched it on text the list row does not show.
    mailInboxState.store.searchIds = ["c3"]
    mailInboxState.store.byId.c3 = {
      accountId: "acc-1",
      assignedTo: null,
      subject: "Old thread",
      snippet: "From last month",
      senderName: "Carol",
      senderEmail: "carol@co.com",
      isRead: true,
      isStarred: false,
      lastMessageAt: "2026-03-01T09:00:00Z",
    }
    render(() => <MailInbox entityId="inbox" />)
    await fireEvent.input(screen.getByTestId("mail-inbox-search"), {
      target: { value: "invoice" },
    })
    const rows = screen.getAllByTestId("conversation-row")
    expect(rows.map((row) => row.dataset.conversationId)).toEqual(["c1", "c3"])
  })

  test("shows only the connect-account empty state when no account is connected", () => {
    mailInboxState.accounts = []
    mailInboxState.store.ids = []
    mailInboxState.store.byId = {}

    render(() => <MailInbox entityId="inbox" />)
    expect(screen.getByTestId("mail-empty-state-connect")).toBeTruthy()
    expect(screen.queryByTestId("mail-inbox-search")).toBeNull()
    expect(screen.queryByText("No conversations")).toBeNull()
  })

  test("renders Claim button on unassigned shared-inbox row", () => {
    render(() => <MailInbox entityId="inbox" />)

    expect(screen.getAllByRole("button", { name: "Claim" })).toHaveLength(2)
  })

  test("Claim click assigns the row to the current user", async () => {
    render(() => <MailInbox entityId="inbox" />)

    await fireEvent.click(screen.getAllByRole("button", { name: "Claim" })[1])

    expect(mailInboxState.claimConversation).toHaveBeenCalledWith(
      mailInboxState.api,
      "c2",
      "current-user-id",
    )
  })

  test("renders assignee chip for assigned shared row and no Claim", async () => {
    mailInboxState.store.byId.c1.assignedTo = "user-1"
    render(() => <MailInbox entityId="inbox" />)

    expect(screen.getByTestId("assignee-chip")).toHaveTextContent("Assigned user-1")
    expect(screen.getAllByRole("button", { name: "Claim" })).toHaveLength(1)

    await fireEvent.click(screen.getByTestId("assignee-chip"))
    expect(mailInboxState.reassignConversation).toHaveBeenCalledWith(
      mailInboxState.api,
      "c1",
      "user-2",
    )
  })

  test("personal-account rows never render Claim or chip", () => {
    mailInboxState.accounts = [{ id: "acc-1", unreadCount: 0, ownerType: "user" }]
    render(() => <MailInbox entityId="inbox" />)

    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull()
    expect(screen.queryByTestId("assignee-chip")).toBeNull()
  })

  test("assigned-to-me view rows hide assignment controls", () => {
    mailInboxState.currentView = "assigned-to-me"
    mailInboxState.store.byId.c1.assignedTo = "current-user-id"
    render(() => <MailInbox entityId="inbox" />)

    expect(screen.queryByRole("button", { name: "Claim" })).toBeNull()
    expect(screen.queryByTestId("assignee-chip")).toBeNull()
  })
})

describe("MailInbox — sealed conversations", () => {
  test("a sealed row shows a locked placeholder, never (No subject)", async () => {
    mailInboxState.store.ids = ["c3"]
    mailInboxState.store.byId = {
      c3: {
        accountId: "acc-1",
        assignedTo: null,
        subject: "",
        snippet: "",
        senderName: "Carol",
        senderEmail: "carol@co.com",
        isRead: true,
        isStarred: false,
        lastMessageAt: "2026-04-13T10:00:00Z",
        sealed: true,
      },
    }
    render(() => <MailInbox entityId="inbox" />)
    const row = screen.getByTestId("conversation-row")
    expect(row.querySelector('[data-testid="conversation-row-locked"]')).toBeTruthy()
    expect(row.textContent).not.toMatch(/no subject/i)
  })
})

describe("MailInbox — sealed drafts", () => {
  test("a sealed draft shows a locked placeholder, never (No subject)", async () => {
    mailInboxState.currentView = "drafts"
    mailInboxState.drafts = {
      d1: {
        id: "d1",
        accountId: "acc-1",
        conversationId: null,
        replyToMessageId: null,
        to: [{ email: "dan@co.com" }],
        cc: [],
        bcc: [],
        subject: "",
        htmlBody: "",
        textBody: "",
        updatedAt: "2026-04-13T10:00:00Z",
        sealed: true,
      },
    }
    const { container } = render(() => <MailInbox entityId="inbox" />)
    expect(container.querySelector('[data-testid="draft-row-locked"]')).toBeTruthy()
    expect(container.textContent).not.toMatch(/no subject/i)
  })
})

describe("MailInbox, locked mailbox on the mail home", () => {
  function wireKeyring(enrolled: boolean) {
    mailInboxState.api.get = vi.fn(async (path: string) => {
      if (path === "/mailbox-keys/me") {
        return {
          identityId: enrolled ? "identity-1" : null,
          keyId: 1,
          identities: enrolled
            ? [
                {
                  id: "identity-1",
                  keyId: 1,
                  status: "active",
                  ecdhPublicKey: "",
                  signPublicKey: "",
                  attestation: "",
                  createdAt: "2026-08-01T00:00:00.000Z",
                  retiredAt: null,
                },
              ]
            : [],
          wraps: [],
        }
      }
      return { data: [] }
    })
  }

  let unlockRequests = 0
  const onUnlock = () => {
    unlockRequests++
  }
  beforeEach(() => {
    resetMailboxStore()
    unlockRequests = 0
    window.addEventListener(MAILBOX_UNLOCK_EVENT, onUnlock)
  })
  afterEach(() => {
    window.removeEventListener(MAILBOX_UNLOCK_EVENT, onUnlock)
    cleanup()
  })

  test("a locked mailbox says so on the list and asks to unlock right away, once", async () => {
    wireKeyring(true)
    render(() => <MailInbox entityId="inbox" />)
    await waitFor(() => expect(screen.getByTestId("mail-inbox-locked")).toBeTruthy())
    expect(screen.getByTestId("mailbox-locked-notice.unlock")).toBeTruthy()
    await waitFor(() => expect(unlockRequests).toBe(1))

    // Coming back to the mail home in the same page does not ask again; the
    // notice and its button stay.
    cleanup()
    render(() => <MailInbox entityId="inbox" />)
    await waitFor(() => expect(screen.getByTestId("mail-inbox-locked")).toBeTruthy())
    expect(unlockRequests).toBe(1)

    fireEvent.click(screen.getByTestId("mailbox-locked-notice.unlock"))
    expect(unlockRequests).toBe(2)
  })

  function sealedRow(sender: string, encState: "sealed" | "locked"): MockConversation {
    return {
      accountId: "acc-1",
      assignedTo: null,
      subject: "",
      snippet: "",
      senderName: sender,
      senderEmail: `${sender.toLowerCase()}@co.com`,
      isRead: true,
      isStarred: false,
      lastMessageAt: "2026-04-13T10:00:00Z",
      sealed: true,
      encState,
    }
  }

  test("a locked inbox of sealed rows shows only the big unlock panel, no blank rows", async () => {
    wireKeyring(true)
    mailInboxState.store.ids = ["s1", "s2"]
    mailInboxState.store.byId = {
      s1: sealedRow("Carol", "locked"),
      s2: sealedRow("Dan", "locked"),
    }
    render(() => <MailInbox entityId="inbox" />)
    await waitFor(() => expect(screen.getByTestId("mail-inbox-locked")).toBeTruthy())
    const panel = screen.getByTestId("mailbox-locked-notice")
    expect(panel).toHaveAttribute("data-variant", "page")
    expect(panel).toHaveTextContent("Unlock your mail")
    expect(screen.queryAllByTestId("conversation-row")).toHaveLength(0)
    expect(screen.queryByTestId("conversation-row-locked")).toBeNull()
    // The panel stands in for the list: no search box over an empty list.
    expect(screen.queryByTestId("mail-inbox-search")).toBeNull()
  })

  test("a locked inbox keeps readable rows under the panel and hides the sealed ones", async () => {
    wireKeyring(true)
    mailInboxState.store.ids = ["c1", "s1"]
    mailInboxState.store.byId = {
      c1: mailInboxState.store.byId.c1!,
      s1: sealedRow("Carol", "locked"),
    }
    render(() => <MailInbox entityId="inbox" />)
    await waitFor(() => expect(screen.getByTestId("mail-inbox-locked")).toBeTruthy())
    const rows = screen.getAllByTestId("conversation-row")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent("Invoice #123")
    expect(screen.queryByTestId("conversation-row-locked")).toBeNull()
  })

  test("the panel's big Unlock button asks for the unlock modal", async () => {
    wireKeyring(true)
    mailInboxState.store.ids = ["s1"]
    mailInboxState.store.byId = { s1: sealedRow("Carol", "locked") }
    render(() => <MailInbox entityId="inbox" />)
    await waitFor(() => expect(unlockRequests).toBe(1))
    const button = screen.getByTestId("mailbox-locked-notice.unlock")
    expect(button).toHaveTextContent("Unlock")
    fireEvent.click(button)
    expect(unlockRequests).toBe(2)
  })

  test("does not prompt while the lock state is still unknown, only once it is known locked", async () => {
    // Locked rows are on screen before the keyring answers: the startup
    // restore may still open the mailbox, so nothing may ask for a password.
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    wireKeyring(true)
    const wired = mailInboxState.api.get
    mailInboxState.api.get = vi.fn(async (path: string) => {
      if (path === "/mailbox-keys/me") await gate
      return wired(path)
    })
    mailInboxState.store.ids = ["s1"]
    mailInboxState.store.byId = { s1: sealedRow("Carol", "locked") }
    render(() => <MailInbox entityId="inbox" />)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mailboxStore.status).toBe("unknown")
    expect(unlockRequests).toBe(0)
    release()
    await waitFor(() => expect(mailboxStore.status).toBe("locked"))
    await waitFor(() => expect(unlockRequests).toBe(1))
  })

  test("a mailbox that is not encrypted shows no lock and asks nothing", async () => {
    wireKeyring(false)
    render(() => <MailInbox entityId="inbox" />)
    await waitFor(() => expect(mailboxStore.status).toBe("not-enrolled"))
    expect(screen.queryByTestId("mail-inbox-locked")).toBeNull()
    expect(unlockRequests).toBe(0)
  })
})

describe("MailInbox — Gmail Primary / Other", () => {
  test("the switch is hidden for a non-Gmail account", () => {
    mailInboxState.accounts = [{ id: "acc-1", unreadCount: 0, ownerType: "org", provider: "imap" }]
    // The mocked store's view is not a signal: set it as the mount would.
    mailInboxState.currentView = "inbox:acc-1"
    render(() => <MailInbox entityId="inbox:account:acc-1" />)
    expect(screen.queryByTestId("mail-category-switch")).toBeNull()
  })

  test("a personal Gmail account shows Primary selected, and Other is remembered for that account", async () => {
    localStorage.clear()
    mailInboxState.accounts = [
      { id: "acc-1", unreadCount: 0, ownerType: "user", provider: "gmail" },
    ]
    mailInboxState.currentView = "inbox:acc-1"
    render(() => <MailInbox entityId="inbox:account:acc-1" />)
    expect(screen.getByTestId("mail-category-switch")).toBeTruthy()
    expect(screen.getByTestId("mail-category-primary").getAttribute("aria-selected")).toBe("true")
    mailInboxState.loadConversations.mockClear()
    await fireEvent.click(screen.getByTestId("mail-category-other"))
    expect(screen.getByTestId("mail-category-other").getAttribute("aria-selected")).toBe("true")
    expect(mailInboxState.loadConversations).toHaveBeenCalled()
    const { mailCategoryFor } = await import("~/modules/mail/mail-category")
    expect(mailCategoryFor("acc-1", mailInboxState.accounts)).toBe("other")
  })

  test("A45: a shared Gmail account offers the switch with All selected by default", () => {
    localStorage.clear()
    mailInboxState.accounts = [{ id: "acc-1", unreadCount: 0, ownerType: "org", provider: "gmail" }]
    mailInboxState.currentView = "inbox:acc-1"
    render(() => <MailInbox entityId="inbox:account:acc-1" />)
    expect(screen.getByTestId("mail-category-switch")).toBeTruthy()
    expect(screen.getByTestId("mail-category-all").getAttribute("aria-selected")).toBe("true")
    expect(screen.getByTestId("mail-category-primary").getAttribute("aria-selected")).toBe("false")
  })
})
