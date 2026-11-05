// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import * as tabStoreModule from "~/modules/shell/tab-store"
import { makeTabId, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import {
  closeTabletSidebar,
  tabletSidebarOpen,
  toggleTabletSidebar,
} from "~/modules/shell/tablet-sidebar-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

function renderInShell(ui: () => any) {
  return render(() => (
    <Router>
      <Route path="/*" component={() => <ApiProvider>{ui()}</ApiProvider>} />
    </Router>
  ))
}

function seedThread(overrides: Record<string, unknown> = {}) {
  addThread({
    id: "t1",
    handle: "@thread-1",
    title: "Test Thread",
    isPinned: false,
    isMuted: false,
    participants: [{ id: "me", name: "Me", avatarUrl: null }],
    lastMessage: {
      content: "Hello",
      authorName: "Me",
      authorId: "me",
      createdAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  })
}

describe("HomeSidebar — muted thread icon", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("does not show muted icon for non-muted threads", () => {
    seedThread({ id: "t1", isMuted: false })
    renderInShell(() => <HomeSidebar />)
    expect(screen.queryByLabelText("Muted")).not.toBeInTheDocument()
  })

  it("shows muted icon for muted threads", () => {
    seedThread({ id: "t2", isMuted: true })
    renderInShell(() => <HomeSidebar />)
    expect(screen.getByLabelText("Muted")).toBeInTheDocument()
  })

  it("shows muted icon alongside thread title", () => {
    seedThread({ id: "t3", title: "Engineering", isMuted: true })
    renderInShell(() => <HomeSidebar />)
    expect(screen.getByText("Engineering")).toBeInTheDocument()
    expect(screen.getByLabelText("Muted")).toBeInTheDocument()
  })
})

describe("HomeSidebar — pinned ordering", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("renders pinned threads before unpinned", () => {
    seedThread({
      id: "t-unpinned",
      title: "Unpinned Thread",
      isPinned: false,
      updatedAt: "2026-01-02T00:00:00Z",
    })
    seedThread({
      id: "t-pinned",
      title: "Pinned Thread",
      isPinned: true,
      updatedAt: "2026-01-01T00:00:00Z",
    })
    renderInShell(() => <HomeSidebar />)

    const pinned = screen.getByText("Pinned Thread")
    const unpinned = screen.getByText("Unpinned Thread")
    expect(pinned).toBeInTheDocument()
    expect(unpinned).toBeInTheDocument()

    // A36: no PINNED sub-header any more, the pin is a glyph on the row.
    expect(screen.getAllByLabelText("Pinned")).toHaveLength(1)

    // Pinned thread should appear before unpinned in the DOM
    const listItems = screen.getAllByRole("listitem")
    const pinnedIndex = listItems.findIndex((el) => el.textContent?.includes("Pinned Thread"))
    const unpinnedIndex = listItems.findIndex((el) => el.textContent?.includes("Unpinned Thread"))
    expect(pinnedIndex).toBeLessThan(unpinnedIndex)
  })
})

describe("HomeSidebar — unread dot", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("shows unread dot when thread has unread messages", () => {
    seedThread({ id: "t-unread", title: "Unread Thread", unreadCount: 5 })
    renderInShell(() => <HomeSidebar />)
    const item = screen.getByText("Unread Thread").closest("[data-testid='thread-item']")!
    const dot = item.querySelector(".rounded-full.bg-accent")
    expect(dot).toBeInTheDocument()
  })
})

describe("HomeSidebar — empty state", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("an empty workspace shows both headers with their +, and no empty-state line", () => {
    renderInShell(() => <HomeSidebar />)
    expect(screen.getByText("Channels")).toBeInTheDocument()
    expect(screen.getByText("Direct messages")).toBeInTheDocument()
    expect(screen.getByTestId("thread-group-add-channels")).toBeInTheDocument()
    expect(screen.getByTestId("thread-group-add-directMessages")).toBeInTheDocument()
    expect(screen.queryByTestId("thread-item")).not.toBeInTheDocument()
  })
})

describe("HomeSidebar — type filter, unread badge, row archive", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
  })
  afterEach(() => cleanup())

  // The per-type chips were replaced by the Channels / Direct messages grouping
  // (P4b-T07): an agent chat is a DM, so it belongs in the same group as a
  // plain chat rather than behind a chip of its own.
  // A35 moved the line: an UNTITLED plain chat and an agent chat are both
  // DMs, a TITLED room is a channel however private it is.
  it("groups an untitled plain chat and an agent chat together under Direct messages", () => {
    seedThread({
      id: "t1",
      title: null,
      type: "thread",
      discoverable: false,
      participants: [{ id: "u2", name: "Quinn Dupont", avatarUrl: null }],
    })
    seedThread({
      id: "t2",
      title: "Agent convo",
      type: "agent_chat",
      discoverable: false,
      participants: [
        {
          id: "a-1",
          name: "Support",
          avatarUrl: null,
          participantType: "agent",
          agentId: "a-1",
        },
      ],
    })
    renderInShell(() => <HomeSidebar />)
    const section = screen.getByText("Direct messages").closest("[data-testid='thread-group']")!
    const rows = Array.from(section.querySelectorAll("[data-testid='thread-item']")).map(
      (el) => el.textContent ?? "",
    )
    expect(rows.some((r) => r.includes("Quinn"))).toBe(true)
    // Named by the agent, not by the title the row froze.
    expect(rows.some((r) => r.includes("Support"))).toBe(true)
    expect(screen.queryByRole("tab", { name: "Agent" })).not.toBeInTheDocument()
  })

  it("Unread chip shows only threads with unread messages", async () => {
    seedThread({ id: "t1", title: "Read thread", unreadCount: 0 })
    seedThread({ id: "t2", title: "Unread thread", unreadCount: 3 })
    const { findByRole } = renderInShell(() => <HomeSidebar />)
    const unreadChip = await findByRole("tab", { name: "Unread" })
    unreadChip.click()
    await Promise.resolve()
    expect(screen.queryByText("Read thread")).not.toBeInTheDocument()
    expect(screen.getByText("Unread thread")).toBeInTheDocument()
  })

  it("renders the unread count as a numeric badge, not a bare dot", () => {
    seedThread({ id: "t1", title: "Busy thread", unreadCount: 5 })
    renderInShell(() => <HomeSidebar />)
    expect(screen.getByLabelText("5 unread")).toHaveTextContent("5")
  })
})

describe("HomeSidebar - real agent participants (P4b-T04)", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
  })
  afterEach(() => cleanup())

  it("sidebar row shows the real agent name for an agent-participant thread", () => {
    seedThread({
      id: "t-agent",
      title: null,
      tainted: true,
      participants: [
        { id: "me", name: "Me", avatarUrl: null },
        {
          id: "66666666-6666-4666-8666-666666666666",
          name: "Logistics",
          avatarUrl: null,
          participantType: "agent",
          agentId: "66666666-6666-4666-8666-666666666666",
        },
      ],
    })
    renderInShell(() => <HomeSidebar />)
    expect(screen.getByText("Me, Logistics")).toBeInTheDocument()
    // Only the real seats: no synthetic "Liaison" seat ahead of them. A36
    // dropped the avatar STACK, so the participant count is gone from the row
    // with it; what is left is one mark, and it is not a fake agent.
    expect(screen.queryByLabelText("2 participants")).not.toBeInTheDocument()
    expect(screen.queryAllByText("LI")).toHaveLength(0)
  })

  it("a tainted thread with no agent participant gets no synthetic agent seat", () => {
    seedThread({
      id: "t-plain",
      title: "Plain",
      tainted: true,
      participants: [
        { id: "me", name: "Me", avatarUrl: null },
        { id: "u2", name: "Quinn Dupont", avatarUrl: null },
      ],
    })
    renderInShell(() => <HomeSidebar />)
    expect(document.querySelectorAll("[data-agent-glyph]")).toHaveLength(0)
    expect(screen.queryAllByText("LI")).toHaveLength(0)
  })
})

describe("HomeSidebar - Channels and Direct messages groups (P4b-T07)", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
  })
  afterEach(() => cleanup())

  function seedGroups() {
    seedThread({ id: "c1", title: "General", discoverable: true })
    seedThread({
      id: "d1",
      title: null,
      discoverable: false,
      participants: [{ id: "u2", name: "Quinn Dupont", avatarUrl: null }],
    })
  }

  function rowsUnder(header: string): string[] {
    const heading = screen.getByText(header)
    const section = heading.closest("[data-testid='thread-group']")!
    return Array.from(section.querySelectorAll("[data-testid='thread-item']")).map(
      (el) => el.textContent ?? "",
    )
  }

  it("sidebar renders a Channels section containing only titled threads", () => {
    seedGroups()
    renderInShell(() => <HomeSidebar />)
    const rows = rowsUnder("Channels")
    expect(rows.some((r) => r.includes("General"))).toBe(true)
    expect(rows.some((r) => r.includes("Quinn"))).toBe(false)
  })

  it("sidebar renders a Direct messages section containing only untitled threads", () => {
    seedGroups()
    renderInShell(() => <HomeSidebar />)
    const rows = rowsUnder("Direct messages")
    expect(rows.some((r) => r.includes("Quinn"))).toBe(true)
    expect(rows.some((r) => r.includes("General"))).toBe(false)
  })

  it("a group with no threads keeps its header, so its + stays reachable, and lists nothing", () => {
    seedThread({
      id: "d1",
      title: null,
      discoverable: false,
      participants: [{ id: "u2", name: "Quinn Dupont", avatarUrl: null }],
    })
    renderInShell(() => <HomeSidebar />)
    expect(rowsUnder("Channels")).toEqual([])
    expect(rowsUnder("Direct messages").some((r) => r.includes("Quinn"))).toBe(true)
  })

  it("a TITLED non discoverable thread is a private channel, not a direct message (A35)", () => {
    seedThread({ id: "p1", title: "Q2 Marketing Plan", discoverable: false })
    renderInShell(() => <HomeSidebar />)
    expect(rowsUnder("Channels").some((r) => r.includes("Q2 Marketing Plan"))).toBe(true)
    expect(rowsUnder("Direct messages")).toEqual([])
  })

  it("the Unread chip applies within both groups rather than being a third group", async () => {
    seedThread({ id: "c1", title: "Read channel", discoverable: true, unreadCount: 0 })
    seedThread({ id: "c2", title: "Busy channel", discoverable: true, unreadCount: 2 })
    seedThread({
      id: "d1",
      title: null,
      discoverable: false,
      unreadCount: 1,
      participants: [{ id: "u2", name: "Dana Park", avatarUrl: null }],
    })
    const { findByRole } = renderInShell(() => <HomeSidebar />)
    const unreadChip = await findByRole("tab", { name: "Unread" })
    unreadChip.click()
    await Promise.resolve()
    expect(screen.queryByText("Read channel")).not.toBeInTheDocument()
    expect(rowsUnder("Channels").some((r) => r.includes("Busy channel"))).toBe(true)
    expect(rowsUnder("Direct messages").some((r) => r.includes("Dana"))).toBe(true)
  })
})

describe("HomeSidebar - Direct messages cover agent DMs and group DMs (P4b-T11)", () => {
  beforeEach(async () => {
    resetThreadStore()
    resetTabStore()
    resetAgentDirectory()
    await loadAgentDirectory({
      get: async () => ({
        data: [
          {
            id: "88888888-8888-4888-8888-888888888888",
            handle: "@support",
            displayName: "Support",
            avatarUrl: "/api/avatars/support.png",
          },
        ],
      }),
    })
  })
  afterEach(() => cleanup())

  it("Direct messages section still renders an unchanged group DM with 3 human participants", () => {
    seedThread({
      id: "d-group",
      title: null,
      discoverable: false,
      participants: [
        { id: "me", name: "Me", avatarUrl: null },
        { id: "u2", name: "Quinn Dupont", avatarUrl: null },
        { id: "u3", name: "Alice Smith", avatarUrl: null },
      ],
    })
    renderInShell(() => <HomeSidebar />)
    const section = screen.getByText("Direct messages").closest("[data-testid='thread-group']")!
    expect(section.querySelectorAll("[data-testid='thread-item']")).toHaveLength(1)
    expect(screen.getByText("Me, Quinn, Alice")).toBeInTheDocument()
  })

  it("Direct messages section renders a 1:1 agent DM using the agent directory name", () => {
    seedThread({
      id: "d-agent",
      title: null,
      discoverable: false,
      participants: [
        {
          id: "88888888-8888-4888-8888-888888888888",
          name: "",
          avatarUrl: null,
          participantType: "agent",
          agentId: "88888888-8888-4888-8888-888888888888",
        },
      ],
    })
    renderInShell(() => <HomeSidebar />)
    const section = screen.getByText("Direct messages").closest("[data-testid='thread-group']")!
    expect(section.textContent).toContain("Support")
  })
})

describe("HomeSidebar - joining a discoverable channel (P4b-T10)", () => {
  let calls: Array<{ url: string; method: string }>

  function jsonResponse(body: unknown) {
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify(body)),
    }
  }

  /** The joinable list is a FOLDED sub-section now (card 31): open it, the way
   *  a member does, before looking for a row inside it. */
  async function openJoinable() {
    const toggle = await screen.findByTestId("thread-group-toggle-joinableChannels")
    if (toggle.getAttribute("aria-expanded") === "false") toggle.click()
    return toggle
  }

  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetAgentDirectory()
    resetSidebarSections()
    localStorage.clear()
    calls = []
    let joined = false
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init: { method?: string } = {}) => {
        const url = String(input)
        const method = (init.method ?? "GET").toUpperCase()
        calls.push({ url, method })
        if (method === "GET" && url.includes("/threads?")) {
          return Promise.resolve(
            jsonResponse({
              data: joined
                ? [
                    {
                      id: "chan-1",
                      handle: "@growth",
                      title: "Growth",
                      discoverable: true,
                      participants: [],
                    },
                  ]
                : [],
            }),
          )
        }
        if (method === "GET" && url.includes("/threads/discoverable")) {
          return Promise.resolve(
            jsonResponse({
              data: [
                {
                  id: "chan-1",
                  handle: "@growth",
                  title: "Growth",
                  topic: "Acquisition experiments",
                  description: "Where growth experiments get run.",
                  participantCount: 4,
                  agentCount: 1,
                  agents: [{ id: "a-growth", handle: "@growth-agent", displayName: "Growth" }],
                },
              ],
            }),
          )
        }
        if (method === "POST" && url.includes("/threads/chan-1/join")) {
          joined = true
          return Promise.resolve(jsonResponse({ data: { added: true } }))
        }
        return Promise.resolve(jsonResponse({ data: [] }))
      }),
    )
  })
  afterEach(() => cleanup())

  it("clicking a joinable channel row calls the join endpoint and moves it into the joined section", async () => {
    renderInShell(() => <HomeSidebar />)
    await openJoinable()
    const joinButton = await screen.findByRole("button", { name: "Join and open Growth" })
    expect(joinButton.getAttribute("data-testid")).toBe("unjoined-channel")

    joinButton.click()
    await vi.waitFor(() => {
      expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/threads/chan-1/join"))).toBe(
        true,
      )
    })

    await vi.waitFor(() => {
      expect(screen.queryByTestId("unjoined-channel")).not.toBeInTheDocument()
    })
    const section = screen.getByText("Channels").closest("[data-testid='thread-group']")!
    expect(
      Array.from(section.querySelectorAll("[data-testid='thread-item']")).some((el) =>
        (el.textContent ?? "").includes("Growth"),
      ),
    ).toBe(true)
  })

  // Card 31. The joinable list used to be a four line card per channel sitting
  // under one line rows. It is a folded sub-section now, and the row inside it
  // is an ordinary row.
  it("the joinable channels are a sub-section, collapsed by default, with a count", async () => {
    renderInShell(() => <HomeSidebar />)
    const toggle = await screen.findByTestId("thread-group-toggle-joinableChannels")
    expect(toggle.textContent).toContain("Channels you can join")
    expect(screen.getByTestId("joinable-channels-count").textContent).toBe("1")
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByTestId("unjoined-channel")).not.toBeInTheDocument()

    toggle.click()
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByTestId("unjoined-channel")).toBeInTheDocument()
  })

  it("a joinable channel is one ordinary row: hash mark, name, nothing else", async () => {
    renderInShell(() => <HomeSidebar />)
    await openJoinable()
    const row = await screen.findByTestId("unjoined-channel")
    expect(row.querySelector("[data-testid='row-mark']")?.getAttribute("data-kind")).toBe(
      "channel-public",
    )
    expect(row.textContent).toContain("Growth")
    // The topic, the handle line, the member count and the agent list moved to
    // the thread header the row opens.
    expect(row.textContent).not.toContain("Acquisition experiments")
    expect(row.textContent).not.toContain("@growth-agent")
    expect(row.textContent).not.toContain("member")
    expect(row.textContent).not.toContain("#growth")
    expect(row.querySelector("[data-testid='unjoined-channel-topic']")).toBeNull()
    expect(row.querySelector("[data-testid='unjoined-channel-handle']")).toBeNull()
    // Same row height and type as a joined channel row above it.
    const joinedRow = document.querySelector("[data-testid='thread-item']")
    if (joinedRow) {
      const tokens = (c: Element | null) =>
        new Set((c?.className ?? "").split(/\s+/).filter((t) => /^(h-|text-\[)/.test(t)))
      const rowButton = joinedRow.querySelector("button")
      expect([...tokens(row)].sort()).toEqual([...tokens(rowButton)].sort())
    }
  })

  it("the fold survives a remount, remembered per user", async () => {
    const first = renderInShell(() => <HomeSidebar />)
    const toggle = await openJoinable()
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    first.unmount()

    renderInShell(() => <HomeSidebar />)
    await vi.waitFor(() => {
      expect(
        screen.getByTestId("thread-group-toggle-joinableChannels").getAttribute("aria-expanded"),
      ).toBe("true")
    })
  })

  it("an unjoined channel the user already belongs to is never listed twice", async () => {
    seedThread({ id: "chan-1", handle: "@growth", title: "Growth", discoverable: true })
    renderInShell(() => <HomeSidebar />)
    await vi.waitFor(() => {
      expect(calls.some((c) => c.url.includes("/threads/discoverable"))).toBe(true)
    })
    await Promise.resolve()
    expect(screen.queryByRole("button", { name: "Join and open Growth" })).not.toBeInTheDocument()
  })
})

describe("HomeSidebar - starting a DM with a role agent (FX4)", () => {
  // Nothing in the product opened a chat with a role agent: POST /threads/dm
  // existed and its only caller was the withheld-capability card, so a member
  // who wanted to ask @support something had no way to start.
  let calls: Array<{ url: string; method: string; body?: string }>
  let dmOpened = false

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status < 400,
      status,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify(body)),
    }
  }

  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetAgentDirectory()
    calls = []
    dmOpened = false
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init: { method?: string; body?: string } = {}) => {
        const url = String(input)
        const method = (init.method ?? "GET").toUpperCase()
        calls.push({ url, method, body: init.body })
        if (method === "GET" && url.endsWith("/agents")) {
          return Promise.resolve(
            jsonResponse({
              data: [
                { id: "a-support", handle: "@support", displayName: "Support", kind: "role" },
                { id: "a-mine", handle: "@alice", displayName: "Alice agent", kind: "personal" },
              ],
            }),
          )
        }
        if (method === "GET" && url.includes("/threads?")) {
          return Promise.resolve(
            jsonResponse({
              data: dmOpened
                ? [
                    {
                      id: "dm-1",
                      handle: "@dm-1",
                      title: null,
                      discoverable: false,
                      participants: [
                        {
                          id: "a-support",
                          name: "Support",
                          avatarUrl: null,
                          participantType: "agent",
                          agentId: "a-support",
                        },
                      ],
                    },
                  ]
                : [],
            }),
          )
        }
        if (method === "POST" && url.endsWith("/threads/dm")) {
          dmOpened = true
          return Promise.resolve(
            jsonResponse({ data: { id: "dm-1", handle: "@dm-1", created: true } }, 201),
          )
        }
        return Promise.resolve(jsonResponse({ data: [] }))
      }),
    )
  })
  afterEach(() => cleanup())

  it("offers a role agent with no DM yet, and opens the chat it creates", async () => {
    renderInShell(() => <HomeSidebar />)
    const button = await screen.findByRole("button", { name: "Message @support" })
    button.click()

    await vi.waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/threads/dm"))
      expect(post).toBeDefined()
      expect(JSON.parse(post?.body ?? "{}").agentId).toBe("a-support")
    })
    await vi.waitFor(() => {
      expect(tabStore.activeTabId).toBe(makeTabId("thread", "dm-1"))
    })
    // Once the DM exists it is a row, not an invitation.
    await vi.waitFor(() => {
      expect(screen.queryByRole("button", { name: "Message @support" })).not.toBeInTheDocument()
    })
  })

  it("never offers a personal agent, only role agents", async () => {
    renderInShell(() => <HomeSidebar />)
    await screen.findByRole("button", { name: "Message @support" })
    expect(screen.queryByRole("button", { name: "Message @alice" })).not.toBeInTheDocument()
  })
})

describe("HomeSidebar - picking a thread drops the tablet drawer (FX1)", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    closeTabletSidebar()
  })
  afterEach(() => {
    closeTabletSidebar()
    cleanup()
  })

  it("selecting a thread closes the tablet sidebar drawer", () => {
    seedThread({ id: "t1", title: "Engineering" })
    renderInShell(() => <HomeSidebar />)
    toggleTabletSidebar()
    expect(tabletSidebarOpen()).toBe(true)

    screen.getByText("Engineering").click()

    expect(tabletSidebarOpen()).toBe(false)
  })
})

describe("HomeSidebar - agent rows open the agent profile (P4m-T31)", () => {
  beforeEach(async () => {
    resetThreadStore()
    resetTabStore()
    resetAgentDirectory()
    await loadAgentDirectory({
      get: async () => ({
        data: [
          { id: "a-support", handle: "@support", displayName: "Support", kind: "role" },
          { id: "a-logistics", handle: "@logistics", displayName: "Logistics", kind: "role" },
        ],
      }),
    })
  })
  afterEach(() => cleanup())

  // A37 (P6d-FX6) replaced the two line invite card with ONE dimmed row: the
  // agent mark, the name, no handle and no control. The profile tab is still
  // one press away once the DM exists (the next case), which is where a member
  // who wants to read an agent's definition is going anyway.
  it("an agent with no DM yet is a plain row and carries no profile control", async () => {
    renderInShell(() => <HomeSidebar />)
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-testid='agent-dm-row']").length).toBe(2),
    )
    expect(screen.queryByTestId("agent-profile-open-a-support")).not.toBeInTheDocument()
    expect(screen.queryByTestId("agent-profile-open-a-logistics")).not.toBeInTheDocument()
  })

  it("an agent DM row opens the agent's page without opening the thread", async () => {
    seedThread({
      id: "dm-logistics",
      title: null,
      discoverable: false,
      participants: [
        { id: "me", name: "Me", avatarUrl: null },
        {
          id: "seat-logistics",
          name: "Logistics",
          avatarUrl: null,
          participantType: "agent",
          agentId: "a-logistics",
        },
      ],
    })
    renderInShell(() => <HomeSidebar />)
    const open = await screen.findByTestId("agent-profile-open-a-logistics")
    open.click()
    // P4c-T39: the agent's own page, addressed by handle, and the same tab the
    // thread header row and a mention chip open.
    expect(tabStore.activeTabId).toBe(makeTabId("agents:agent", "@logistics"))
    expect(tabStore.tabs.some((t) => t.id === makeTabId("thread", "dm-logistics"))).toBe(false)
  })
})

describe("HomeSidebar - dock variant (P4c-T07)", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("dock variant routes a row click to onSelect and opens no tab", () => {
    const openTabSpy = vi.spyOn(tabStoreModule, "openTab")
    seedThread({ id: "t1", title: "Engineering" })
    const onSelect = vi.fn()
    renderInShell(() => <HomeSidebar variant="dock" onSelect={onSelect} />)

    screen.getByText("Engineering").click()

    expect(onSelect).toHaveBeenCalledWith("t1")
    expect(openTabSpy).not.toHaveBeenCalled()
  })

  it("dock variant keeps the channel and direct message groups", () => {
    seedThread({ id: "c1", title: "General", discoverable: true })
    seedThread({
      id: "d1",
      title: null,
      discoverable: false,
      participants: [{ id: "u2", name: "Quinn Dupont", avatarUrl: null }],
    })
    renderInShell(() => <HomeSidebar variant="dock" onSelect={() => {}} />)

    expect(screen.getByText("Channels")).toBeInTheDocument()
    expect(screen.getByText("Direct messages")).toBeInTheDocument()
    expect(screen.getByText("General")).toBeInTheDocument()
    expect(screen.getByText("Quinn")).toBeInTheDocument()
  })
})

describe("HomeSidebar - dock variant creates the DM through Message @agent (P4c-T07)", () => {
  let calls: Array<{ url: string; method: string; body?: string }>
  let dmOpened = false

  function jsonResponse(body: unknown, status = 200) {
    return {
      ok: status < 400,
      status,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify(body)),
    }
  }

  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetAgentDirectory()
    calls = []
    dmOpened = false
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init: { method?: string; body?: string } = {}) => {
        const url = String(input)
        const method = (init.method ?? "GET").toUpperCase()
        calls.push({ url, method, body: init.body })
        if (method === "GET" && url.endsWith("/agents")) {
          return Promise.resolve(
            jsonResponse({
              data: [{ id: "a-support", handle: "@support", displayName: "Support", kind: "role" }],
            }),
          )
        }
        if (method === "GET" && url.includes("/threads?")) {
          return Promise.resolve(
            jsonResponse({
              data: dmOpened
                ? [
                    {
                      id: "dm-1",
                      handle: "@dm-1",
                      title: null,
                      discoverable: false,
                      participants: [
                        {
                          id: "a-support",
                          name: "Support",
                          avatarUrl: null,
                          participantType: "agent",
                          agentId: "a-support",
                        },
                      ],
                    },
                  ]
                : [],
            }),
          )
        }
        if (method === "POST" && url.endsWith("/threads/dm")) {
          dmOpened = true
          return Promise.resolve(
            jsonResponse({ data: { id: "dm-1", handle: "@dm-1", created: true } }, 201),
          )
        }
        return Promise.resolve(jsonResponse({ data: [] }))
      }),
    )
  })
  afterEach(() => cleanup())

  it("a role agent row without a DM creates the DM then selects it", async () => {
    const onSelect = vi.fn()
    renderInShell(() => <HomeSidebar variant="dock" onSelect={onSelect} />)
    const button = await screen.findByRole("button", { name: "Message @support" })
    button.click()

    await vi.waitFor(() => {
      const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/threads/dm"))
      expect(post).toBeDefined()
    })
    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith("dm-1")
    })
    // No tab was ever activated: the dock, not the tab store, owns selection.
    expect(tabStore.activeTabId).not.toBe(makeTabId("thread", "dm-1"))
  })
})
