// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two rules the desktop sidebar's lists live by.
//
// THE PERSONAL AGENT IS ALWAYS A ROW. It used to appear only once a DM thread
// with it existed, so a member whose thread had never been created (or had
// been deleted) had no way to reach their own agent from the sidebar at all,
// while the phone Chats column pinned it unconditionally. The row is now the
// head of Direct messages either way, and pressing it opens the thread or
// creates it through the one idempotent `POST /threads/dm` path.
//
// THE CHANNEL LIST IS CAPPED. Thirty five channels is not a directory anybody
// reads. Ten rows show: every pinned channel, everything unread, then the most
// recent others; the rest fold under one "More" row that remembers whether it
// was opened. A search is a question, so it is answered in full.

import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { DESKTOP_QUERY, PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import { makeTabId, openTab, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { resetPersonalDmStore } from "~/modules/threads/personal-dm-store"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
  const body =
    init?.method === "POST" && String(url).includes("/threads/dm")
      ? { data: { id: "dm-created", handle: "@dm-created" } }
      : { data: [] }
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
    },
    text: async () => JSON.stringify(body),
  }
})
vi.stubGlobal("fetch", fetchMock)

const b64 = (value: object) =>
  btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")

/** A token the client can decode; nothing here verifies a signature. */
function signInAs(userId: string) {
  setTokens(
    `${b64({ alg: "none" })}.${b64({
      userId,
      orgId: "org-1",
      name: "Me",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    })}.x`,
  )
}

const PERSONAL_AGENT = {
  id: "ag-mine",
  handle: "@liaison",
  displayName: "Liaison",
  kind: "personal",
  ownerUserId: "me",
  state: "Watching the inbox",
}

function renderSidebar() {
  return render(() => (
    <Router>
      <Route path="/*" component={() => <ApiProvider>{<HomeSidebar />}</ApiProvider>} />
    </Router>
  ))
}

/** Pin the shell tier: the Chats column exists only at phone width. */
function setTier(query: string) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q === query,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  syncShellTier()
}

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

function dmGroup(): HTMLElement {
  return document.querySelector(
    "[data-testid='thread-group'][data-group='directMessages']",
  ) as HTMLElement
}

function agentGroup(): HTMLElement {
  return document.querySelector("[data-testid='thread-group'][data-group='agents']") as HTMLElement
}

function channelGroup(): HTMLElement {
  return document.querySelector(
    "[data-testid='thread-group'][data-group='channels']",
  ) as HTMLElement
}

/** The NAME each channel row prints, without its trailing unread pill. */
function channelNames(): string[] {
  return Array.from(channelGroup().querySelectorAll("[data-testid='thread-item']")).map((el) =>
    (el.querySelector("span.truncate")?.textContent ?? "").trim(),
  )
}

beforeEach(() => {
  fetchMock.mockClear()
  localStorage.clear()
  resetThreadStore()
  resetTabStore()
  resetSidebarSections()
  resetAgentDirectory()
  resetPersonalDmStore()
  signInAs("me")
})
afterEach(() => {
  cleanup()
  clearAuth()
  setTier(DESKTOP_QUERY)
})

describe("HomeSidebar - the personal agent leads Agents", () => {
  it("is the first Agents row, marked yours, with no thread, and pressing it creates the DM", async () => {
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    addThread({
      id: "d-alice",
      handle: "@d-alice",
      title: null,
      participants: [{ id: "u-alice", name: "Alice Chen", avatarUrl: null }],
      updatedAt: iso(5),
    } as never)
    renderSidebar()

    const row = await waitFor(() => screen.getByTestId("chats-personal-agent-row"))
    // The Chats screen's own list: not the dock's row a guided step rings.
    expect(row.dataset.inDock).toBeUndefined()
    expect(row.textContent).toContain("Liaison")
    expect(row.querySelector("[data-testid='chats-personal-agent-yours']")?.textContent).toBe(
      "· yours",
    )
    const rows = Array.from(
      agentGroup().querySelectorAll(
        "[data-testid='chats-personal-agent-row'], [data-testid='thread-item']",
      ),
    )
    expect(rows[0]).toBe(row)
    expect(dmGroup().contains(row)).toBe(false)

    fireEvent.click(row)
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]: any[]) => String(url).includes("/threads/dm") && init?.method === "POST",
        ),
      ).toBe(true),
    )
    await waitFor(() =>
      expect(tabStore.tabs.some((t: any) => t.entityId === "dm-created")).toBe(true),
    )
  })

  it("stays listed under the Unread and Mentions chips and a search (the tours' anchor)", async () => {
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    addThread({
      id: "d-alice",
      handle: "@d-alice",
      title: null,
      participants: [{ id: "u-alice", name: "Alice Chen", avatarUrl: null }],
      unreadCount: 1,
      updatedAt: iso(5),
    } as never)
    renderSidebar()
    await waitFor(() => screen.getByTestId("chats-personal-agent-row"))

    for (const chip of ["unread", "mentions"]) {
      fireEvent.click(screen.getByTestId(`chats-filter-${chip}`))
      await waitFor(() => expect(screen.getByTestId("chats-personal-agent-row")).toBeTruthy())
    }
    fireEvent.click(screen.getByTestId("chats-filter-all"))
    const search = document.querySelector("input[type='text']") as HTMLInputElement
    fireEvent.input(search, { target: { value: "zzz" } })
    await waitFor(() => expect(screen.getByTestId("chats-personal-agent-row")).toBeTruthy())
  })

  it("renders no row when the viewer has no personal agent", async () => {
    await loadAgentDirectory({
      get: async () => ({
        data: [{ id: "ag-role", handle: "@finance", displayName: "Finance", kind: "role" }],
      }),
    })
    addThread({
      id: "d-alice",
      handle: "@d-alice",
      title: null,
      participants: [{ id: "u-alice", name: "Alice Chen", avatarUrl: null }],
    } as never)
    renderSidebar()

    await waitFor(() => expect(screen.getAllByTestId("thread-item").length).toBeGreaterThan(0))
    expect(screen.queryByTestId("chats-personal-agent-row")).toBeNull()
  })

  it("is listed ONCE when the DM exists, carrying its unread count", async () => {
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    addThread({
      id: "t-my-dm",
      handle: "@dm-mine",
      title: null,
      participants: [
        {
          id: "ag-mine",
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: "ag-mine",
        },
      ],
      unreadCount: 2,
      updatedAt: iso(1),
    } as never)
    renderSidebar()

    const row = await waitFor(() => screen.getByTestId("chats-personal-agent-row"))
    expect(row.querySelector("[data-testid='row-trailing']")?.textContent).toBe("2")
    // Not repeated as an ordinary DM row below.
    const names = Array.from(dmGroup().querySelectorAll("[data-testid='thread-item']")).map((el) =>
      (el.querySelector("span.truncate")?.textContent ?? "").trim(),
    )
    expect(names).not.toContain("Liaison")

    fireEvent.click(row)
    await waitFor(() => expect(tabStore.tabs.some((t: any) => t.entityId === "t-my-dm")).toBe(true))
    expect(
      fetchMock.mock.calls.some(
        ([url, init]: any[]) => String(url).includes("/threads/dm") && init?.method === "POST",
      ),
    ).toBe(false)
  })

  /** An untitled room with the agent AND a colleague is a group DM by shape
   *  rule 3, not the member's 1:1 with their agent. Matching on "the agent is
   *  in it" picked the newer group, so the agent appeared twice, the group
   *  fell out of Direct messages and the lead row opened the wrong room with
   *  no unread on it. */
  function seedOneToOneAndGroup() {
    addThread({
      id: "t-1to1",
      handle: "@dm-mine",
      title: null,
      participants: [
        {
          id: "ag-mine",
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: "ag-mine",
        },
      ],
      unreadCount: 7,
      updatedAt: iso(30),
    } as never)
    addThread({
      id: "t-group",
      handle: "@dm-group",
      title: null,
      participants: [
        {
          id: "ag-mine",
          name: "Liaison",
          avatarUrl: null,
          participantType: "agent",
          agentId: "ag-mine",
        },
        { id: "u-bob", name: "Bob Martinez", avatarUrl: null },
      ],
      unreadCount: 0,
      updatedAt: iso(1),
    } as never)
  }

  it("never mistakes a group room the agent sits in for the personal DM", async () => {
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    seedOneToOneAndGroup()
    renderSidebar()

    const row = await waitFor(() => screen.getByTestId("chats-personal-agent-row"))
    // The 1:1, with its seven unread, not the newer group.
    expect(row.querySelector("[data-testid='row-trailing']")?.textContent).toBe("7")

    const names = Array.from(dmGroup().querySelectorAll("[data-testid='thread-item']")).map((el) =>
      (el.querySelector("span.truncate")?.textContent ?? "").trim(),
    )
    // The group is still listed, ONCE, under its own people (its display name
    // names every other seat, the agent included); the 1:1 is not repeated.
    expect(names.length).toBe(1)
    expect(names[0]).toContain("Bob")

    fireEvent.click(row)
    await waitFor(() => expect(tabStore.tabs.some((t: any) => t.entityId === "t-1to1")).toBe(true))
    expect(tabStore.tabs.some((t: any) => t.entityId === "t-group")).toBe(false)
  })

  /** Two rooms of the SAME shape: a 1:1 with the personal agent. A guest room
   *  opened for one question is indistinguishable from the real conversation
   *  by shape, so the tie is broken by recency. The stale room here is PINNED,
   *  which is how it outranked the real conversation: `allThreads` lists every
   *  pinned row before any unpinned one, so "the first match" was the pin, and
   *  the head row opened a throwaway with nothing in it while the real DM
   *  carried seven unread as an ordinary row below. */
  it("prefers the most recently updated 1:1 when the agent has two", async () => {
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    const agentSeat = {
      id: "ag-mine",
      name: "Liaison",
      avatarUrl: null,
      participantType: "agent",
      agentId: "ag-mine",
    }
    addThread({
      id: "t-real",
      handle: "@dm-real",
      title: null,
      participants: [agentSeat],
      unreadCount: 7,
      updatedAt: iso(1),
    } as never)
    addThread({
      id: "t-guest",
      handle: "@dm-guest",
      title: null,
      isPinned: true,
      participants: [agentSeat],
      unreadCount: 0,
      updatedAt: iso(300),
    } as never)
    renderSidebar()

    const row = await waitFor(() => screen.getByTestId("chats-personal-agent-row"))
    expect(row.querySelector("[data-testid='row-trailing']")?.textContent).toBe("7")

    fireEvent.click(row)
    await waitFor(() => expect(tabStore.tabs.some((t: any) => t.entityId === "t-real")).toBe(true))
    expect(tabStore.tabs.some((t: any) => t.entityId === "t-guest")).toBe(false)
  })

  it("makes the same distinction in the Chats column", async () => {
    // The Chats column is the dock variant AT PHONE TIER; anywhere else the
    // dock renders this same sidebar.
    setTier(PHONE_QUERY)
    await loadAgentDirectory({ get: async () => ({ data: [PERSONAL_AGENT] }) })
    seedOneToOneAndGroup()
    const onSelect = vi.fn()
    render(() => (
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

    const row = await waitFor(() => screen.getByTestId("chats-personal-agent-row"))
    expect(row.querySelector("[data-testid='chat-row-unread']")?.textContent).toBe("7")
    // The group keeps its row; the 1:1 is only the head row.
    const ids = Array.from(document.querySelectorAll("[data-testid='chat-row']")).map((el) =>
      el.getAttribute("data-thread-id"),
    )
    expect(ids).toEqual(["t-group"])

    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalledWith("t-1to1")
  })
})

describe("HomeSidebar - the channel list is capped, the rest folds", () => {
  /** Fourteen channels, most recent first. Channel 12 is pinned and channel 13
   *  has something unread: both sit past the third row by recency alone. */
  function seedChannels() {
    for (let i = 0; i < 14; i++) {
      addThread({
        id: `c-${i}`,
        handle: `@chan-${i}`,
        title: `Chan ${i}`,
        discoverable: true,
        isPinned: i === 12,
        unreadCount: i === 13 ? 3 : 0,
        participants: [{ id: "me", name: "Me", avatarUrl: null }],
        updatedAt: iso(i + 1),
      } as never)
    }
  }

  it("shows three rows, folds the rest under 'N more channels', and expands them in place", async () => {
    seedChannels()
    renderSidebar()

    await waitFor(() => expect(screen.getByTestId("channels-more-toggle")).toBeInTheDocument())
    const visible = channelNames()
    expect(visible.length).toBe(3)
    // Pinned and unread survive the cap even though recency put them last;
    // the cap fills what is left with the most recent one.
    expect(visible).toEqual(["Chan 12", "Chan 0", "Chan 13"])
    expect(screen.getByTestId("channels-more-toggle").textContent).toContain("11 more channels")

    fireEvent.click(screen.getByTestId("channels-more-toggle"))
    await waitFor(() => expect(channelNames().length).toBe(14))
    expect(channelNames()).toContain("Chan 11")
    expect(screen.getByTestId("channels-more-toggle").textContent).toContain("Show less")

    fireEvent.click(screen.getByTestId("channels-more-toggle"))
    await waitFor(() => expect(channelNames().length).toBe(3))
  })

  it("keeps the channel being read out of the fold", async () => {
    seedChannels()
    // The twelfth channel by recency: past the cap, unpinned, nothing unread,
    // and the tab the member is looking at.
    openTab({ type: "thread", entityId: "c-11", label: "Chan 11" })
    expect(tabStore.activeTabId).toBe(makeTabId("thread", "c-11"))
    renderSidebar()

    await waitFor(() => expect(screen.getByTestId("channels-more-toggle")).toBeInTheDocument())
    // Still three rows: the active channel takes the place of the most recent
    // one the cap would have shown, it does not widen the list.
    const visible = channelNames()
    expect(visible.length).toBe(3)
    expect(visible).toContain("Chan 11")
    expect(visible).not.toContain("Chan 0")
    expect(screen.getByTestId("channels-more-toggle").textContent).toContain("11 more channels")
  })

  it("answers a search in full, with no fold", async () => {
    seedChannels()
    renderSidebar()
    await waitFor(() => expect(screen.getByTestId("channels-more-toggle")).toBeInTheDocument())

    const search = document.querySelector("input[type='text']") as HTMLInputElement
    fireEvent.input(search, { target: { value: "Chan" } })

    await waitFor(() => expect(channelNames().length).toBe(14))
    expect(screen.queryByTestId("channels-more-toggle")).toBeNull()
  })

  it("leaves Direct messages uncapped", async () => {
    for (let i = 0; i < 14; i++) {
      addThread({
        id: `d-${i}`,
        handle: `@dm-${i}`,
        title: null,
        participants: [{ id: `u-${i}`, name: `Person ${i}`, avatarUrl: null }],
        updatedAt: iso(i + 1),
      } as never)
    }
    renderSidebar()

    await waitFor(() =>
      expect(dmGroup().querySelectorAll("[data-testid='thread-item']").length).toBe(14),
    )
    expect(screen.queryByTestId("channels-more-toggle")).toBeNull()
  })
})
