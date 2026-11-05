// SPDX-License-Identifier: FSL-1.1-ALv2
// The Channels list: sort order (remembered per device), the Muted chip and the
// membership filter (channels I'm in / not in).
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetTabStore } from "~/modules/shell/tab-store"
import { CHANNEL_SORT_KEY } from "~/modules/threads/channel-list-prefs"
import { resetSidebarSections } from "~/modules/threads/sidebar-sections"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"
import HomeSidebar from "./HomeSidebar"

const DISCOVERABLE = [
  { id: "pub-1", handle: "open-house", title: "Open house", memberCount: 3, discoverable: true },
]

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
            data: String(url).includes("/threads/discoverable") ? DISCOVERABLE : [],
          }),
        ),
    }),
  ),
)

function seed(id: string, title: string, minutesAgo: number, unreadCount = 0, isMuted = false) {
  addThread({
    id,
    handle: id,
    title,
    type: "thread",
    isPinned: false,
    isMuted,
    participants: [],
    updatedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    unreadCount,
  })
}

function mount() {
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
}

/** Channel names in the order the list shows them. */
function order(...names: string[]): string[] {
  const text = (n: string) => screen.queryByText(n)
  return names
    .filter((n) => text(n))
    .sort((a, b) => {
      const pos = text(a)?.compareDocumentPosition(text(b) as Node) ?? 0
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
}

// The list folds channels past three, so the fixture stays at three.
const NAMES = ["Bravo", "Delta", "Charlie"]

describe("Home sidebar channels: sort and filters", () => {
  beforeEach(() => {
    localStorage.clear()
    resetThreadStore()
    resetTabStore()
    resetSidebarSections()
    attentionStore._setForTest({ items: [], errors: [], loading: false })
    // Recent order: Bravo, Delta, Charlie. Delta is unread, Charlie muted.
    seed("c-bravo", "Bravo", 1)
    seed("c-delta", "Delta", 30, 3)
    seed("c-charlie", "Charlie", 40, 5, true)
  })
  afterEach(() => cleanup())

  it("defaults to recent activity", async () => {
    mount()
    await screen.findByText("Bravo")
    expect(order(...NAMES)).toEqual(["Bravo", "Delta", "Charlie"])
  })

  it("sorts by name A-Z and remembers the choice per device", async () => {
    mount()
    await screen.findByText("Bravo")
    fireEvent.change(screen.getByTestId("channels-sort"), { target: { value: "name" } })
    expect(order(...NAMES)).toEqual(["Bravo", "Charlie", "Delta"])
    expect(localStorage.getItem(CHANNEL_SORT_KEY)).toBe("name")
    cleanup()
    mount()
    await screen.findByText("Bravo")
    expect((screen.getByTestId("channels-sort") as HTMLSelectElement).value).toBe("name")
    expect(order(...NAMES)).toEqual(["Bravo", "Charlie", "Delta"])
  })

  it("sorts unread first, a muted room not counting as unread", async () => {
    mount()
    await screen.findByText("Bravo")
    fireEvent.change(screen.getByTestId("channels-sort"), { target: { value: "unread" } })
    expect(order(...NAMES)).toEqual(["Delta", "Bravo", "Charlie"])
  })

  it("survives storage that throws", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    try {
      mount()
      await screen.findByText("Bravo")
      fireEvent.change(screen.getByTestId("channels-sort"), { target: { value: "name" } })
      expect(order(...NAMES)).toEqual(["Bravo", "Charlie", "Delta"])
    } finally {
      get.mockRestore()
      set.mockRestore()
    }
  })

  it("Unread, Mentions and Muted chips narrow the list", async () => {
    mount()
    await screen.findByText("Bravo")
    fireEvent.click(screen.getByTestId("chats-filter-unread"))
    expect(order(...NAMES)).toEqual(["Delta"])
    fireEvent.click(screen.getByTestId("chats-filter-muted"))
    expect(order(...NAMES)).toEqual(["Charlie"])
    fireEvent.click(screen.getByTestId("chats-filter-mentions"))
    expect(order(...NAMES)).toEqual([])
    fireEvent.click(screen.getByTestId("chats-filter-all"))
    expect(order(...NAMES).length).toBe(3)
  })

  it("membership: in shows joined only, not-in shows the joinable ones only", async () => {
    mount()
    await screen.findByText("Bravo")
    expect(await screen.findByTestId("joinable-channels-count")).toBeTruthy()
    const select = screen.getByTestId("channels-membership")
    fireEvent.change(select, { target: { value: "in" } })
    expect(screen.queryByTestId("joinable-channels-count")).toBeNull()
    expect(order(...NAMES).length).toBe(3)
    fireEvent.change(select, { target: { value: "not-in" } })
    expect(order(...NAMES)).toEqual([])
    expect(screen.getByTestId("joinable-channels-count")).toBeTruthy()
    fireEvent.change(select, { target: { value: "all" } })
    expect(order(...NAMES).length).toBe(3)
    expect(screen.getByTestId("joinable-channels-count")).toBeTruthy()
  })
})
