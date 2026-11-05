// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S11 / A23: the "Followed threads" sidebar section. Unread first (then the
// newest reply), an unread badge, a click opens the channel with the reply
// panel on that root, and a followup event refreshes it.

import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { DESKTOP_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import { makeTabId, resetTabStore, tabStore } from "~/modules/shell/tab-store"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"
import {
  handleFollowedRepliesMessageEvent,
  resetFollowedReplies,
  sortFollowedReplies,
  splitFollowedReplies,
} from "~/modules/threads/followed-replies-store"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { resetPersonalDmStore } from "~/modules/threads/personal-dm-store"
import { getOpenReplyPanel, resetReplyPanels } from "~/modules/threads/reply-panel-store"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { resetThreadStore } from "~/modules/threads/thread-store"

function followed(
  rootId: string,
  channel: string,
  unreadCount: number,
  lastReplyAt: string,
  content: string,
) {
  return {
    rootMessage: {
      id: rootId,
      threadId: `ch-${channel}`,
      authorId: "u-x",
      authorName: "Alice",
      authorAvatarUrl: null,
      authorType: "user",
      authorAgentId: null,
      content,
      createdAt: "2026-09-28T08:00:00.000Z",
      deletedAt: null,
    },
    channel: { id: `ch-${channel}`, name: channel },
    replyCount: 3,
    lastReplyAt,
    unreadCount,
  }
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const daysAgo = (d: number) => hoursAgo(d * 24)

// Deliberately out of order: the client orders them too.
const FOLLOWED = [
  followed("r-read", "general", 0, hoursAgo(1), "Read and recent"),
  followed("r-old", "finance", 2, hoursAgo(4), "Unread but older"),
  followed("r-new", "support", 5, hoursAgo(2), "Unread and newer"),
]

// Six threads: two unread (one of them old), two read and recent, two read
// and stale. Only the unread and the freshest read ones earn a row.
const MANY = [
  followed("m-read-1", "general", 0, hoursAgo(1), "Read, newest"),
  followed("m-read-2", "sales", 0, hoursAgo(3), "Read, recent"),
  followed("m-read-3", "ops", 0, hoursAgo(5), "Read, recent but past the cap"),
  followed("m-stale", "legal", 0, daysAgo(30), "Read, a month old"),
  followed("m-unread-old", "finance", 1, daysAgo(40), "Unread, old"),
  followed("m-unread", "support", 4, hoursAgo(2), "Unread, fresh"),
]
let payload: unknown[] = FOLLOWED

const fetchMock = vi.fn(async (url: string) => {
  const body = String(url).includes("/threads/followed-replies") ? { data: payload } : { data: [] }
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

function renderSidebar() {
  return render(() => (
    <Router>
      <Route path="/*" component={() => <ApiProvider>{<HomeSidebar />}</ApiProvider>} />
    </Router>
  ))
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-testid='followed-thread-row']"))
}

beforeEach(() => {
  payload = FOLLOWED
  fetchMock.mockClear()
  localStorage.clear()
  resetThreadStore()
  resetTabStore()
  resetSidebarSections()
  resetAgentDirectory()
  resetPersonalDmStore()
  resetFollowedReplies()
  resetReplyPanels()
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q === DESKTOP_QUERY,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  syncShellTier()
  signInAs("me")
})

afterEach(() => {
  cleanup()
  clearAuth()
})

describe("sortFollowedReplies", () => {
  it("puts unread first, then the newest reply", () => {
    expect(sortFollowedReplies(FOLLOWED).map((f) => f.rootMessage.id)).toEqual([
      "r-new",
      "r-old",
      "r-read",
    ])
  })
})

describe("splitFollowedReplies", () => {
  const ids = (xs: { rootMessage: { id: string } }[]) => xs.map((x) => x.rootMessage.id)
  it("shows every unread thread and fills the cap with recent read ones", () => {
    const { shown, folded } = splitFollowedReplies(sortFollowedReplies(MANY), {
      activeRootId: null,
      now: Date.now(),
    })
    expect(ids(shown)).toEqual(["m-unread", "m-unread-old", "m-read-1"])
    expect(ids(folded)).toEqual(["m-read-2", "m-read-3", "m-stale"])
  })

  it("never folds unread threads, even past the cap", () => {
    const unread = [1, 2, 3, 4, 5].map((n) => followed(`u${n}`, "c", n, daysAgo(n * 10), "x"))
    const { shown, folded } = splitFollowedReplies(unread, { activeRootId: null, now: Date.now() })
    expect(shown).toHaveLength(5)
    expect(folded).toHaveLength(0)
  })

  it("keeps the thread whose panel is open, however old", () => {
    const { shown } = splitFollowedReplies(sortFollowedReplies(MANY), {
      activeRootId: "m-stale",
      now: Date.now(),
    })
    expect(ids(shown)).toContain("m-stale")
  })

  it("folds a read thread with no recent reply even when the cap has room", () => {
    const { shown, folded } = splitFollowedReplies([followed("s", "c", 0, daysAgo(8), "x")], {
      activeRootId: null,
      now: Date.now(),
    })
    expect(shown).toHaveLength(0)
    expect(ids(folded)).toEqual(["s"])
  })
})

describe("HomeSidebar followed threads", () => {
  it("sits below Direct messages", async () => {
    renderSidebar()
    await waitFor(() => expect(rows().length).toBe(3))
    const order = Array.from(
      document.querySelectorAll<HTMLElement>("[data-testid='thread-group']"),
    ).map((g) => g.dataset.group)
    expect(order.indexOf("followedThreads")).toBeGreaterThan(order.indexOf("directMessages"))
    expect(order.at(-1)).toBe("followedThreads")
  })

  it("shows the useful threads and folds the rest behind More", async () => {
    payload = MANY
    renderSidebar()
    await waitFor(() => expect(rows().length).toBe(3))
    expect(rows().map((r) => r.dataset.rootId)).toEqual(["m-unread", "m-unread-old", "m-read-1"])
    const more = screen.getByTestId("followed-threads-more-toggle")
    expect(more.textContent).toContain("More (3)")
    fireEvent.click(more)
    expect(rows().map((r) => r.dataset.rootId)).toEqual([
      "m-unread",
      "m-unread-old",
      "m-read-1",
      "m-read-2",
      "m-read-3",
      "m-stale",
    ])
    expect(screen.getByTestId("followed-threads-more-toggle").textContent).toContain("Show less")
  })

  it("has no More row when everything fits", async () => {
    renderSidebar()
    await waitFor(() => expect(rows().length).toBe(3))
    expect(screen.queryByTestId("followed-threads-more-toggle")).toBeNull()
  })

  it("lists followed threads unread first with an unread badge", async () => {
    renderSidebar()
    await waitFor(() => expect(rows().length).toBe(3))
    const group = document.querySelector("[data-group='followedThreads']") as HTMLElement
    expect(group.textContent).toContain("Followed threads")
    expect(rows().map((r) => r.dataset.rootId)).toEqual(["r-new", "r-old", "r-read"])
    expect(rows()[0]?.querySelector("[data-testid='followed-thread-unread']")?.textContent).toBe(
      "5",
    )
    expect(rows()[2]?.querySelector("[data-testid='followed-thread-unread']")).toBeNull()
  })

  it("opens the channel with the reply panel on that root", async () => {
    renderSidebar()
    await waitFor(() => expect(rows().length).toBe(3))
    fireEvent.click(rows()[1]!)
    expect(tabStore.activeTabId).toBe(makeTabId("thread", "ch-finance"))
    expect(getOpenReplyPanel("ch-finance")?.rootId).toBe("r-old")
  })

  it("folds like the other sections", async () => {
    renderSidebar()
    await waitFor(() => expect(rows().length).toBe(3))
    fireEvent.click(screen.getByTestId("thread-group-toggle-followedThreads"))
    expect(rows().length).toBe(0)
  })

  it("refreshes when a reply lands in a thread this user follows", async () => {
    renderSidebar()
    await waitFor(() => expect(rows().length).toBe(3))
    const before = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/threads/followed-replies"),
    ).length
    handleFollowedRepliesMessageEvent(
      "create",
      { threadId: "ch-x", replyRootId: "r-z", followerIds: ["me", "u-2"], authorId: "u-2" },
      "me",
    )
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes("/threads/followed-replies"))
          .length,
      ).toBeGreaterThan(before),
    )
  })
})
