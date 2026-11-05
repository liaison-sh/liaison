// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Slack-style way in: a "+" beside Channels creates a channel, a "+"
// beside Direct messages writes to somebody. It replaces the single "New
// thread" dialog, where a room became a channel only if a title happened to be
// typed and could not be created without naming somebody else first.
//
// Pinned here: both "+" exist even in an empty workspace; a channel can be
// created alone; a name already in use offers the existing channel instead of
// a twin; the message picker lands in a DM that already exists rather than
// asking the server to make one, and an agent opens through the idempotent
// `/threads/dm`.

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: () => true,
    userFromToken: () => ({ userId: "me", name: "Tester" }),
  }
})

import { ApiContext } from "~/modules/shell/ApiContext"
import { makeTabId, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import NewChannelDialog from "~/modules/threads/NewChannelDialog"
import NewMessageDialog from "~/modules/threads/NewMessageDialog"
import {
  closeNewConversationDialog,
  newConversationDialog,
  openNewChannelDialog,
  openNewMessageDialog,
} from "~/modules/threads/new-conversation-store"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

const ALICE = "11111111-1111-4111-8111-111111111111"
const BOB = "22222222-2222-4222-8222-222222222222"
const SUPPORT = "33333333-3333-4333-8333-333333333333"

const seat = (id: string, name: string, type: "user" | "agent" = "user") => ({
  id,
  name,
  avatarUrl: null,
  participantType: type,
  agentId: type === "agent" ? id : null,
})

function seed(row: Record<string, unknown>) {
  addThread({
    handle: `@${String(row.id)}`,
    type: "thread",
    isPinned: false,
    isPinnedByUser: false,
    isMuted: false,
    discoverable: false,
    unreadCount: 0,
    lastMessage: null,
    updatedAt: "2026-09-20T10:00:00.000Z",
    ...row,
  } as never)
}

interface ApiOpts {
  discoverable?: unknown[]
  agents?: unknown[]
  people?: unknown[]
  post?: (path: string, body: any) => unknown
}

function makeApi(opts: ApiOpts = {}) {
  return {
    get: vi.fn(async (path: string) => {
      if (path === "/threads/discoverable") return { data: opts.discoverable ?? [] }
      if (path === "/agents") return { data: opts.agents ?? [] }
      if (path.startsWith("/mentions")) return { data: opts.people ?? [] }
      return { data: [] }
    }),
    post: vi.fn(async (path: string, body: any) => opts.post?.(path, body) ?? { data: {} }),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    getEnvelope: vi.fn(),
  } as any
}

function renderWith(api: any, ui: () => any) {
  return render(() => <ApiContext.Provider value={api}>{ui()}</ApiContext.Provider>)
}

const activeThread = () => tabStore.activeTabId

beforeEach(() => {
  resetThreadStore()
  resetTabStore()
  resetAgentDirectory()
  resetSidebarSections()
  closeNewConversationDialog()
})
afterEach(() => cleanup())

describe("sidebar section headers", () => {
  it("offers a + on Channels and on Direct messages, even with nothing in either", () => {
    renderWith(makeApi(), () => <HomeSidebar />)
    expect(screen.getByTestId("thread-group-add-channels")).toBeTruthy()
    expect(screen.getByTestId("thread-group-add-directMessages")).toBeTruthy()
    // The old catch-all "New thread" button above the list is gone.
    expect(screen.queryByLabelText("New thread")).toBeNull()
  })

  it("opens the channel dialog from Channels and the message dialog from Direct messages", () => {
    renderWith(makeApi(), () => <HomeSidebar />)
    fireEvent.click(screen.getByTestId("thread-group-add-channels"))
    expect(newConversationDialog()).toBe("channel")
    fireEvent.click(screen.getByTestId("thread-group-add-directMessages"))
    expect(newConversationDialog()).toBe("message")
  })
})

describe("new channel", () => {
  it("creates a public channel with nobody else in it and opens it", async () => {
    const api = makeApi({
      post: (_path, body) => ({
        data: { id: "c-new", handle: "@growth", title: body.title, discoverable: true },
      }),
    })
    renderWith(api, () => <NewChannelDialog />)
    openNewChannelDialog()

    fireEvent.input(await screen.findByTestId("new-channel-name"), {
      target: { value: "  growth-lab " },
    })
    fireEvent.click(screen.getByText("Create channel"))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/threads", {
        title: "growth-lab",
        participantIds: [],
        discoverable: true,
        forceCreate: true,
      }),
    )
    await waitFor(() => expect(activeThread()).toBe(makeTabId("thread", "c-new")))
    expect(newConversationDialog()).toBeNull()
  })

  it("sends a private channel as not discoverable", async () => {
    const api = makeApi({ post: () => ({ data: { id: "c-p", title: "ops" } }) })
    renderWith(api, () => <NewChannelDialog />)
    openNewChannelDialog()
    fireEvent.input(await screen.findByTestId("new-channel-name"), { target: { value: "ops" } })
    fireEvent.click(screen.getByText("Private"))
    fireEvent.click(screen.getByText("Create channel"))
    await waitFor(() =>
      expect(api.post.mock.calls[0][1]).toMatchObject({ title: "ops", discoverable: false }),
    )
  })

  it("offers the channel the member is already in instead of creating a twin", async () => {
    seed({ id: "c-eng", title: "Engineering", participants: [seat("me", "Tester")] })
    const api = makeApi()
    renderWith(api, () => <NewChannelDialog />)
    openNewChannelDialog()
    fireEvent.input(await screen.findByTestId("new-channel-name"), {
      target: { value: "engineering" },
    })

    const clash = screen.getByTestId("new-channel-clash")
    expect(clash.dataset.clash).toBe("joined")
    expect(
      (screen.getByText("Create channel").closest("button") as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByText("Open"))
    expect(activeThread()).toBe(makeTabId("thread", "c-eng"))
    expect(api.post).not.toHaveBeenCalled()
  })

  it("offers to join a public channel of the same name", async () => {
    const api = makeApi({
      discoverable: [{ id: "c-pub", handle: "@design", title: "Design" }],
    })
    renderWith(api, () => <NewChannelDialog />)
    openNewChannelDialog()
    const input = await screen.findByTestId("new-channel-name")
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/threads/discoverable"))
    fireEvent.input(input, { target: { value: "Design" } })

    expect(screen.getByTestId("new-channel-clash").dataset.clash).toBe("public")
    fireEvent.click(screen.getByText("Join"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/threads/c-pub/join"))
    await waitFor(() => expect(activeThread()).toBe(makeTabId("thread", "c-pub")))
  })
})

describe("new message", () => {
  it("lists recent conversations before anything is typed, and opens one", async () => {
    seed({ id: "d-alice", title: null, participants: [seat("me", "Tester"), seat(ALICE, "Alice")] })
    seed({ id: "c-eng", title: "Engineering", participants: [seat("me", "Tester")] })
    const api = makeApi()
    renderWith(api, () => <NewMessageDialog />)
    openNewMessageDialog()

    const rows = await screen.findAllByTestId("new-message-option-conversation")
    // DMs only: a channel is not somebody to write to.
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Alice")])
    fireEvent.click(rows[0])
    expect(activeThread()).toBe(makeTabId("thread", "d-alice"))
    expect(api.post).not.toHaveBeenCalled()
  })

  it("says a DM already exists with the chosen person and opens it without creating", async () => {
    seed({ id: "d-alice", title: null, participants: [seat("me", "Tester"), seat(ALICE, "Alice")] })
    const api = makeApi({
      people: [{ type: "user", id: ALICE, label: "Alice", secondaryLabel: "a@x" }],
    })
    renderWith(api, () => <NewMessageDialog />)
    openNewMessageDialog()

    const to = await screen.findByTestId("new-message-to")
    // A query that matches no existing conversation name, so the person row is
    // what gets picked.
    fireEvent.input(to, { target: { value: "a@x" } })
    fireEvent.click(await screen.findByTestId("new-message-option-person"))

    const status = screen.getByTestId("new-message-status")
    expect(status.dataset.existing).toBe("true")
    fireEvent.click(screen.getByText("Open conversation"))
    expect(activeThread()).toBe(makeTabId("thread", "d-alice"))
    expect(api.post).not.toHaveBeenCalled()
  })

  it("starts a group conversation with the people chosen, first message included", async () => {
    const api = makeApi({
      people: [
        { type: "user", id: ALICE, label: "Alice", secondaryLabel: "" },
        { type: "user", id: BOB, label: "Bob", secondaryLabel: "" },
      ],
      post: () => ({ data: { id: "d-group", title: null, participants: [] } }),
    })
    renderWith(api, () => <NewMessageDialog />)
    openNewMessageDialog()
    const to = await screen.findByTestId("new-message-to")

    fireEvent.input(to, { target: { value: "Alice" } })
    fireEvent.click((await screen.findAllByTestId("new-message-option-person"))[0])
    fireEvent.input(to, { target: { value: "Bob" } })
    await waitFor(() =>
      expect(screen.getAllByTestId("new-message-option-person")[0].textContent).toContain("Bob"),
    )
    fireEvent.keyDown(to, { key: "Enter" })

    expect(screen.getAllByTestId("new-message-recipient")).toHaveLength(2)
    expect(screen.getByTestId("new-message-status").dataset.existing).toBe("false")
    fireEvent.input(screen.getByTestId("new-message-body"), { target: { value: "Hello both" } })
    fireEvent.click(screen.getByText("Send"))

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith("/threads", {
        participantIds: [ALICE, BOB],
        initialMessage: { content: "Hello both" },
      }),
    )
    await waitFor(() => expect(activeThread()).toBe(makeTabId("thread", "d-group")))
  })

  it("opens an agent's DM through /threads/dm, and never offers a colleague's personal agent", async () => {
    const api = makeApi({
      agents: [
        { id: SUPPORT, handle: "@support", displayName: "Support", kind: "role" },
        { id: "p-bob", handle: "@bob-agent", displayName: "Supportive Bob", kind: "personal" },
      ],
      post: () => ({ data: { id: "d-support", handle: "@d-support" } }),
    })
    renderWith(api, () => <NewMessageDialog />)
    openNewMessageDialog()
    const to = await screen.findByTestId("new-message-to")
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/agents"))

    fireEvent.input(to, { target: { value: "supp" } })
    const agents = await screen.findAllByTestId("new-message-option-agent")
    expect(agents.map((a) => a.textContent)).toEqual([expect.stringContaining("Support")])
    fireEvent.click(agents[0])

    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/threads/dm", { agentId: SUPPORT }))
    await waitFor(() => expect(activeThread()).toBe(makeTabId("thread", "d-support")))
  })
})
