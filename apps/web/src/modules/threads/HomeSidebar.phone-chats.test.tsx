// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Chats ROOT: the dock variant at phone width is an inbox in four
// collapsible sections (Agents, Unread, Direct messages, Channels) under a large
// title and the search field, and its rows read as an inbox (name, time,
// preview, unread) rather than as a directory.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import {
  _resetBranding,
  ensureBrandingLoaded,
  ensureSignedInOrgNameLoaded,
} from "~/modules/shell/branding-store"
import { resetTabStore } from "~/modules/shell/tab-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { isSectionCollapsed, resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import { setShellTier } from "~/tests/helpers/shell-tier"

/** The api answers every read with an empty list, except the discoverable
 *  channels, which the test sets. */
let discoverable: unknown[] = []
vi.stubGlobal(
  "fetch",
  vi.fn((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () =>
        Promise.resolve(
          JSON.stringify({
            data: String(url).includes("/threads/discoverable") ? discoverable : [],
          }),
        ),
    }),
  ),
)

function renderChats(onSelect = vi.fn()) {
  const result = render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <HomeSidebar variant="dock" onSelect={onSelect} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
  return { ...result, onSelect }
}

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function seedWorld(engUnread = 3) {
  // A plain channel, unread.
  addThread({
    id: "t-eng",
    handle: "@eng",
    title: "Engineering",
    discoverable: true,
    participants: [{ id: "me", name: "Me", avatarUrl: null }],
    lastMessage: { content: "Ship it", authorName: "Me", authorId: "me", createdAt: iso(5) },
    unreadCount: engUnread,
    updatedAt: iso(5),
  })
  // An agent DM, read.
  addThread({
    id: "t-agent",
    handle: "@dm-scout",
    title: null,
    participants: [
      {
        id: "a1",
        name: "Scout",
        avatarUrl: null,
        participantType: "agent",
        agentId: "a1",
      },
    ],
    lastMessage: { content: "On it", authorName: "Scout", authorId: "a1", createdAt: iso(120) },
    unreadCount: 0,
    updatedAt: iso(120),
  })
  // A pinned channel, read.
  addThread({
    id: "t-ops",
    handle: "@ops",
    title: "Ops",
    isPinned: true,
    participants: [{ id: "me", name: "Me", avatarUrl: null }],
    lastMessage: { content: "All quiet", authorName: "Me", authorId: "me", createdAt: iso(600) },
    unreadCount: 0,
    updatedAt: iso(600),
  })
}

const section = (id: string) =>
  document.querySelector(
    `[data-testid="chats-section"][data-section="${id}"]`,
  ) as HTMLElement | null

const titlesIn = (id: string) =>
  Array.from(section(id)?.querySelectorAll('[data-testid="chat-row-title"]') ?? []).map(
    (el) => el.textContent?.trim() ?? "",
  )

const rowFor = (threadId: string) =>
  screen
    .getAllByTestId("chat-row")
    .find((el) => el.getAttribute("data-thread-id") === threadId) as HTMLElement

describe("HomeSidebar — the phone Chats root", () => {
  beforeEach(() => {
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
    resetAgentDirectory()
    attentionStore._setForTest({ items: [] })
    discoverable = []
    setShellTier("phone")
  })
  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it("renders the large title, the search field and the sections, and no filter chips", async () => {
    await loadAgentDirectory({
      get: async () => ({
        data: [{ id: "ag-sup", handle: "@support", displayName: "Support Desk", kind: "role" }],
      }),
    })
    seedWorld()
    renderChats()

    const title = screen.getByTestId("chats-title")
    expect(title.textContent).toBe("Chats")
    expect(title.getAttribute("class")).toContain("font-display")
    expect(title.getAttribute("class")).toContain("text-[32px]")
    expect(screen.getByTestId("chats-search")).toBeTruthy()
    expect(screen.queryAllByRole("tab")).toHaveLength(0)

    await waitFor(() => expect(section("agents")).not.toBeNull())
    const order = Array.from(document.querySelectorAll('[data-testid="chats-section"]')).map((el) =>
      el.getAttribute("data-section"),
    )
    // D32: the agents lead, in view without scrolling, then what there is to
    // read, then the people, and the channels close the list.
    expect(order).toEqual(["agents", "unread", "directMessages", "channels"])
    expect(
      within(section("agents") as HTMLElement).getByTestId("chats-section-add-agents"),
    ).toBeTruthy()
  })

  it("lists a role agent's DM under Agents, and offers the ones not messaged yet there too", async () => {
    await loadAgentDirectory({
      get: async () => ({
        data: [
          { id: "ag-fin", handle: "@finance", displayName: "Finance Desk", kind: "role" },
          { id: "ag-sup", handle: "@support", displayName: "Support Desk", kind: "role" },
        ],
      }),
    })
    seedWorld(0)
    addThread({
      id: "t-sup",
      handle: "@dm-sup",
      title: null,
      participants: [
        {
          id: "seat-sup",
          name: "Support Desk",
          avatarUrl: null,
          participantType: "agent",
          agentId: "ag-sup",
        },
      ],
      unreadCount: 3,
      updatedAt: iso(30),
    })
    renderChats()

    // Unread, yet it stays in Agents with its count: Unread is people and
    // channels only, and a row lives in one section.
    await waitFor(() => expect(titlesIn("agents")).toEqual(["Support Desk"]))
    expect(section("unread")).toBeNull()
    expect(
      within(section("agents") as HTMLElement).getByTestId("chat-row-unread").textContent,
    ).toContain("3")
    const offers = within(section("agents") as HTMLElement).getAllByTestId("chats-agent-offer")
    expect(offers.map((el) => el.getAttribute("data-agent-id"))).toEqual(["ag-fin"])
    // The unknown agent Scout is not a role agent the directory names: its DM
    // stays a direct message.
    expect(titlesIn("directMessages")).toEqual(["Scout"])
  })

  // The line under the title printed "Default Organization": the deployment's
  // PUBLIC branding name. Nothing on this screen ever asked for the signed-in
  // org; `startup.ts` loads it once per session now.
  it("names the SIGNED IN org under the title, not the deployment's public name", async () => {
    seedWorld()
    _resetBranding()
    await ensureBrandingLoaded((async () => ({
      ok: true,
      json: async () => ({ data: { orgName: "Default Organization" } }),
    })) as never)
    await ensureSignedInOrgNameLoaded(async () => ({ data: { name: "Resonant Audio Labs" } }))
    renderChats()
    expect(screen.getByTestId("chats-title-org").textContent).toBe("Resonant Audio Labs")
    _resetBranding()
  })

  it("is NOT the Chats root in the sidebar variant at phone width", () => {
    seedWorld()
    render(() => (
      <Router>
        <Route
          path="/*"
          component={() => (
            <ApiProvider>
              <HomeSidebar />
            </ApiProvider>
          )}
        />
      </Router>
    ))
    expect(screen.queryByTestId("chats-title")).toBeNull()
    expect(screen.getAllByTestId("thread-item").length).toBeGreaterThan(0)
  })

  it("lifts unread conversations into Unread and lists every row exactly once", () => {
    seedWorld()
    renderChats()
    expect(titlesIn("unread")).toEqual(["Engineering"])
    expect(titlesIn("channels")).toEqual(["Ops"])
    expect(titlesIn("directMessages")).toEqual(["Scout"])
    expect(screen.getByTestId("chats-section-count-unread").textContent).toBe("1")
  })

  it("orders Unread newest first and leaves a muted conversation in its group", () => {
    seedWorld()
    addThread({
      id: "t-sales",
      handle: "@sales",
      title: "Sales",
      participants: [{ id: "me", name: "Me", avatarUrl: null }],
      lastMessage: { content: "Signed", authorName: "Ann", authorId: "ann", createdAt: iso(1) },
      unreadCount: 1,
      updatedAt: iso(1),
    })
    addThread({
      id: "t-noise",
      handle: "@noise",
      title: "Noise",
      isMuted: true,
      participants: [{ id: "me", name: "Me", avatarUrl: null }],
      unreadCount: 9,
      updatedAt: iso(2),
    })
    renderChats()
    expect(titlesIn("unread")).toEqual(["Sales", "Engineering"])
    expect(titlesIn("channels")).toContain("Noise")
  })

  it("has no Unread section when nothing is unread", () => {
    seedWorld(0)
    renderChats()
    expect(section("unread")).toBeNull()
    expect(titlesIn("channels").sort()).toEqual(["Engineering", "Ops"])
  })

  it("a section header folds its rows, and the fold is remembered", () => {
    seedWorld()
    renderChats()
    const toggle = screen.getByTestId("chats-section-toggle-channels")
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    expect(titlesIn("channels")).toEqual([])
    expect(isSectionCollapsed("channels")).toBe(true)
    // The other sections are untouched.
    expect(titlesIn("directMessages")).toEqual(["Scout"])
    fireEvent.click(toggle)
    expect(titlesIn("channels")).toEqual(["Ops"])
  })

  it("the search field narrows every section", () => {
    seedWorld()
    renderChats()
    fireEvent.input(screen.getByTestId("chats-search"), { target: { value: "sco" } })
    expect(section("unread")).toBeNull()
    expect(titlesIn("channels")).toEqual([])
    expect(titlesIn("directMessages")).toEqual(["Scout"])
  })

  it("says so when the search matches nothing", () => {
    seedWorld()
    renderChats()
    fireEvent.input(screen.getByTestId("chats-search"), { target: { value: "zzz" } })
    expect(screen.getByTestId("chats-no-match")).toBeTruthy()
  })

  it("a row carries the title, the relative time, the preview and the unread pill", () => {
    seedWorld()
    renderChats()

    const row = rowFor("t-eng")
    expect(row.getAttribute("class")).toContain("min-h-16")
    expect(row.querySelector('[data-testid="chat-row-avatar"]')?.getAttribute("class")).toContain(
      "h-10",
    )
    const title = row.querySelector('[data-testid="chat-row-title"]')
    expect(title?.textContent).toBe("Engineering")
    expect(title?.getAttribute("class")).toContain("font-bold")
    expect(row.querySelector('[data-testid="chat-row-time"]')?.textContent).toBe("5m ago")
    expect(row.querySelector('[data-testid="chat-row-preview"]')?.textContent).toBe("Ship it")
    expect(row.querySelector('[data-testid="chat-row-unread"]')?.textContent).toBe("3")
    // A read row is not bold.
    expect(
      rowFor("t-ops").querySelector('[data-testid="chat-row-title"]')?.getAttribute("class"),
    ).not.toContain("font-bold")
  })

  it("draws a mention louder than a plain unread count", () => {
    seedWorld()
    attentionStore._setForTest({
      items: [
        {
          id: "att-1",
          app: "kernel",
          entity: "thread",
          entityId: "t-eng",
          kind: "mention",
          summary: "",
          urgency: 1,
          occurredAt: iso(5),
          action: { type: "open_url", url: "/" },
        } as never,
      ],
    })
    renderChats()
    const badge = rowFor("t-eng").querySelector('[data-testid="chat-row-unread"]') as HTMLElement
    expect(badge.getAttribute("data-mention")).toBe("true")
    expect(badge.textContent).toBe("@3")
    expect(badge.getAttribute("class")).toContain("bg-danger")
  })

  it("Direct messages ends with the New message entry", () => {
    seedWorld()
    renderChats()
    const dms = section("directMessages") as HTMLElement
    expect(within(dms).getByTestId("chats-new-message")).toBeTruthy()
    expect(within(dms).getByTestId("chats-section-add-directMessages")).toBeTruthy()
    expect(
      within(section("channels") as HTMLElement).getByTestId("chats-section-add-channels"),
    ).toBeTruthy()
  })

  it("folds channels beyond three under 'N more channels', as the desktop sidebar does", () => {
    for (let i = 0; i < 12; i++) {
      addThread({
        id: `t-c${i}`,
        handle: `@c${i}`,
        title: `Channel ${String(i).padStart(2, "0")}`,
        participants: [{ id: "me", name: "Me", avatarUrl: null }],
        unreadCount: 0,
        updatedAt: iso(i + 1),
      })
    }
    renderChats()
    expect(titlesIn("channels")).toHaveLength(3)
    const more = screen.getByTestId("chats-channels-more")
    expect(more.textContent).toContain("9 more channels")
    fireEvent.click(more)
    expect(titlesIn("channels")).toHaveLength(12)
  })

  it("Browse channels opens the channels the member can join", async () => {
    discoverable = [
      {
        id: "t-design",
        handle: "#design",
        title: "Design",
        topic: "Pixels",
        participantCount: 4,
        agentCount: 0,
      },
    ]
    seedWorld()
    renderChats()
    const browse = await waitFor(() => screen.getByTestId("chats-browse-channels"))
    expect(screen.queryByTestId("chats-joinable-channel")).toBeNull()
    fireEvent.click(browse)
    expect(screen.getByTestId("chats-joinable-channel").textContent).toContain("Design")
  })

  it("each row carries the Read and Pin swipe actions", () => {
    seedWorld()
    renderChats()

    const rows = screen.getAllByTestId("chat-swipe-row")
    expect(rows.length).toBe(3)
    // Ops is pinned, so ITS second action offers to unpin.
    const ops = rows.find((r) => r.textContent?.includes("Ops"))
    expect(ops?.querySelector('[data-testid="swipe-action-read"]')).toBeTruthy()
    expect(ops?.querySelector('[data-testid="swipe-action-unpin"]')).toBeTruthy()

    const eng = rows.find((r) => r.textContent?.includes("Engineering"))
    expect(eng?.querySelector('[data-testid="swipe-action-pin"]')).toBeTruthy()
  })

  it("the Read swipe action clears the count and moves the row back to its group", () => {
    seedWorld()
    renderChats()
    const eng = screen
      .getAllByTestId("chat-swipe-row")
      .find((r) => r.textContent?.includes("Engineering"))
    expect(eng?.querySelector('[data-testid="chat-row-unread"]')?.textContent).toBe("3")

    fireEvent.click(eng?.querySelector('[data-testid="swipe-action-read"]') as HTMLElement)

    expect(section("unread")).toBeNull()
    expect(titlesIn("channels")).toContain("Engineering")
    expect(rowFor("t-eng").querySelector('[data-testid="chat-row-unread"]')).toBeNull()
  })

  it("a long press opens the actions sheet with Pin, Mute and Open on Home", async () => {
    vi.useFakeTimers()
    try {
      seedWorld()
      renderChats()
      const eng = screen
        .getAllByTestId("chat-swipe-row")
        .find((r) => r.textContent?.includes("Engineering")) as HTMLElement

      fireEvent.pointerDown(eng.lastElementChild as HTMLElement, {
        clientX: 20,
        clientY: 20,
        button: 0,
        pointerId: 1,
      })
      vi.advanceTimersByTime(600)

      expect(screen.getByTestId("chat-sheet-pin").textContent).toContain("Pin")
      expect(screen.getByTestId("chat-sheet-mute").textContent).toContain("Mute")
      expect(screen.getByTestId("chat-sheet-open-home").textContent).toContain("Open on Home")
    } finally {
      vi.useRealTimers()
    }
  })

  it("a row opens the conversation through onSelect, never a tab", () => {
    seedWorld()
    const { onSelect } = renderChats()
    fireEvent.click(rowFor("t-agent"))
    expect(onSelect).toHaveBeenCalledWith("t-agent")
  })
})
