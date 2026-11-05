// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import { addThread, removeThread, resetThreadStore } from "~/modules/threads/thread-store"
import {
  activeThreadId,
  chatsOpen,
  collapse,
  DOCK_MAX_TABS,
  DOCK_PILL_CLASS,
  DOCK_WINDOW_CLASS,
  deactivate,
  dockAvailable,
  expand,
  openConversation,
  overflow,
  promoteFromOverflow,
  resetDockStore,
  setVisibleCapacity,
  surfaceIncoming,
  tabs,
  toggleChats,
  visibleTabs,
} from "./dock-store"

describe("dock-store", () => {
  beforeEach(() => {
    resetDockStore()
  })

  it("open focuses an existing tab instead of duplicating", () => {
    openConversation("t1")
    openConversation("t2")
    openConversation("t1")

    expect(tabs().filter((t) => t.threadId === "t1")).toHaveLength(1)
    expect(tabs()).toHaveLength(2)
    expect(activeThreadId()).toBe("t1")
  })

  it("capacity two with three tabs overflows the least recently active", () => {
    openConversation("t1")
    openConversation("t2")
    openConversation("t3")
    setVisibleCapacity(2)

    expect(overflow().map((t) => t.threadId)).toEqual(["t1"])
    expect(visibleTabs().map((t) => t.threadId)).toEqual(["t3", "t2"])
  })

  it("promote from overflow swaps with the least recently active visible tab", () => {
    openConversation("t1")
    openConversation("t2")
    openConversation("t3")
    setVisibleCapacity(2)
    expect(overflow().map((t) => t.threadId)).toEqual(["t1"])

    promoteFromOverflow("t1")

    expect(overflow().map((t) => t.threadId)).toEqual(["t2"])
    expect(visibleTabs().map((t) => t.threadId)).toEqual(["t1", "t3"])
  })

  // P4c FX-B2 (D2). The roster panel opens upward from the Chats pill, into
  // the band an expanded conversation tab occupies: leaving it open on top of
  // the tab that was just opened put its "Filter threads" tablist over the
  // tab's Collapse control and swallowed the click.
  it("opening a conversation puts the Chats roster away", () => {
    toggleChats()
    expect(chatsOpen()).toBe(true)

    openConversation("t1")

    expect(chatsOpen()).toBe(false)
  })

  it("a caller whose own surface is the roster keeps it open", () => {
    toggleChats()

    openConversation("t1", { keepChats: true })

    expect(chatsOpen()).toBe(true)
  })

  it("the roster and an expanded tab are never both in the visible set", () => {
    openConversation("t1", { expand: true })
    expect(visibleTabs()[0]?.expanded).toBe(true)

    toggleChats()

    expect(chatsOpen()).toBe(true)
    expect(visibleTabs()[0]?.expanded).toBe(false)
    // The persisted state is untouched: closing the roster restores it.
    expect(tabs()[0]?.expanded).toBe(true)

    toggleChats()

    expect(visibleTabs()[0]?.expanded).toBe(true)
  })

  // P4c FX-B2 (D8). Stepping back from a conversation is navigation, not
  // eviction: `close()` here lost the conversation, so widening to desktop
  // afterwards showed an empty dock.
  it("deactivate keeps the tab and only drops the active thread", () => {
    openConversation("t1", { expand: true })
    openConversation("t2", { expand: true })

    deactivate()

    expect(activeThreadId()).toBeNull()
    expect(
      tabs()
        .map((t) => t.threadId)
        .sort(),
    ).toEqual(["t1", "t2"])
    expect(tabs().find((t) => t.threadId === "t2")?.expanded).toBe(false)
  })

  it("state survives a reload through localStorage", async () => {
    openConversation("t1", { expand: false })
    toggleChats()

    vi.resetModules()
    const reloaded = await import("./dock-store")

    expect(reloaded.tabs().map((t) => t.threadId)).toEqual(["t1"])
    expect(reloaded.tabs()[0]?.expanded).toBe(false)
    expect(reloaded.activeThreadId()).toBe("t1")
    expect(reloaded.chatsOpen()).toBe(true)

    reloaded.resetDockStore()
  })

  it("teardown clears the store and the key", () => {
    openConversation("t1")
    toggleChats()

    resetDockStore()

    expect(tabs()).toEqual([])
    expect(chatsOpen()).toBe(false)
    expect(activeThreadId()).toBeNull()
    expect(localStorage.getItem("liaison.dock.v1")).toBeNull()
  })

  // An incoming message pops its conversation into the strip as a quiet
  // collapsed pill. The four rules of that gesture, one test each.
  it("surfaceIncoming adds a collapsed tab, once", () => {
    surfaceIncoming("t1")
    surfaceIncoming("t1")

    expect(tabs()).toHaveLength(1)
    expect(tabs()[0].threadId).toBe("t1")
    expect(tabs()[0].expanded).toBe(false)
    // Quiet: it never becomes the active conversation.
    expect(activeThreadId()).toBeNull()
  })

  it("surfaceIncoming leaves an existing tab expanded and active", () => {
    openConversation("t1")
    expect(tabs()[0].expanded).toBe(true)

    surfaceIncoming("t1")

    expect(tabs()).toHaveLength(1)
    expect(tabs()[0].expanded).toBe(true)
    expect(activeThreadId()).toBe("t1")
  })

  it("surfaceIncoming does not close the Chats roster", () => {
    toggleChats()
    expect(chatsOpen()).toBe(true)

    surfaceIncoming("t1")

    expect(chatsOpen()).toBe(true)
    expect(tabs().map((t) => t.threadId)).toEqual(["t1"])
  })

  it("surfaceIncoming is a no-op when the dock is unavailable", async () => {
    const originalMatchMedia = window.matchMedia
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query.includes("max-width: 639px"),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    })
    try {
      vi.resetModules()
      const phoneModule = await import("./dock-store")
      expect(phoneModule.dockAvailable()).toBe(false)

      phoneModule.surfaceIncoming("t1")

      expect(phoneModule.tabs()).toHaveLength(0)
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      })
    }
  })

  // A pill that arrived on its own must never cost the user the window they
  // are typing in. The open window keeps a seat on the bar, and the tab list
  // is capped by evicting a tab that was already put away.
  it("a surfaced pill never pushes the open window into the overflow", () => {
    openConversation("t1") // expanded, and the one being typed in
    openConversation("t2", { expand: false })
    setVisibleCapacity(2)

    surfaceIncoming("t3")

    expect(visibleTabs().map((t) => t.threadId)).toEqual(["t3", "t1"])
    expect(overflow().map((t) => t.threadId)).toEqual(["t2"])
  })

  it("at the tab cap a surfaced pill evicts the least recently active collapsed tab", () => {
    openConversation("keep") // expanded and active
    for (let i = 0; i < DOCK_MAX_TABS - 1; i++) {
      surfaceIncoming(`old-${i}`)
    }
    expect(tabs()).toHaveLength(DOCK_MAX_TABS)

    surfaceIncoming("fresh")

    expect(tabs()).toHaveLength(DOCK_MAX_TABS)
    const ids = tabs().map((t) => t.threadId)
    expect(ids).toContain("fresh")
    expect(ids).toContain("keep")
    // "old-0" is the least recently active collapsed tab: it is the one that goes.
    expect(ids).not.toContain("old-0")
  })

  // With one window at a time a full bar always holds something already put
  // away, so an incoming pill takes the oldest collapsed seat and never the
  // open window or the active conversation.
  it("at the cap a surfaced pill never evicts the open window", () => {
    for (let i = 0; i < DOCK_MAX_TABS; i++) {
      openConversation(`t${i}`) // each open puts the previous window away
    }
    expect(tabs()).toHaveLength(DOCK_MAX_TABS)
    const open = `t${DOCK_MAX_TABS - 1}`

    surfaceIncoming("fresh")

    const ids = tabs().map((t) => t.threadId)
    expect(ids).toHaveLength(DOCK_MAX_TABS)
    expect(ids).toContain("fresh")
    expect(ids).toContain(open)
    expect(ids).not.toContain("t0")
    expect(tabs().find((t) => t.threadId === open)?.expanded).toBe(true)
  })

  it("a deliberate open at the cap evicts a collapsed tab too", () => {
    openConversation("keep")
    for (let i = 0; i < DOCK_MAX_TABS - 1; i++) {
      surfaceIncoming(`old-${i}`)
    }
    expect(tabs()).toHaveLength(DOCK_MAX_TABS)

    openConversation("clicked")

    expect(tabs()).toHaveLength(DOCK_MAX_TABS)
    const ids = tabs().map((t) => t.threadId)
    expect(ids).toContain("clicked")
    expect(ids).toContain("keep")
    expect(ids).not.toContain("old-0")
  })

  // Reaching past the strip for a conversation must PUT IT ON THE STRIP: it
  // was a dead click once every visible seat held an expanded window.
  it("promoting from the overflow lands the conversation in the visible set", () => {
    openConversation("t1")
    openConversation("t2")
    openConversation("t3")
    collapse("t1") // put away, which is how a tab reaches the More menu
    setVisibleCapacity(2)
    // t3 (the open window) and t2 are the visible pair; t1 is on the shelf.
    expect(overflow().map((t) => t.threadId)).toEqual(["t1"])

    promoteFromOverflow("t1")

    expect(visibleTabs().map((t) => t.threadId)).toContain("t1")
    expect(visibleTabs().find((t) => t.threadId === "t1")?.expanded).toBe(true)
    // Every other window was minimised, never closed: they keep their seats.
    expect(
      tabs()
        .map((t) => t.threadId)
        .sort(),
    ).toEqual(["t1", "t2", "t3"])
    expect(tabs().find((t) => t.threadId === "t2")?.expanded).toBe(false)
    expect(tabs().find((t) => t.threadId === "t3")?.expanded).toBe(false)
  })

  // ONE WINDOW AT A TIME. Two open windows stacked above one bar covered each
  // other's headers; the dock now behaves like the chat bars people know.
  it("opening a conversation minimises every other window", () => {
    openConversation("t1")
    openConversation("t2")

    expect(
      tabs()
        .filter((t) => t.expanded)
        .map((t) => t.threadId),
    ).toEqual(["t2"])
  })

  it("expanding an item minimises the others, activates it and puts the roster away", () => {
    openConversation("t1")
    openConversation("t2", { expand: false })
    toggleChats()

    expand("t2")

    expect(
      tabs()
        .filter((t) => t.expanded)
        .map((t) => t.threadId),
    ).toEqual(["t2"])
    expect(activeThreadId()).toBe("t2")
    expect(chatsOpen()).toBe(false)
  })

  it("expanding an item leaves it where it was on the bar", () => {
    openConversation("t1", { expand: false })
    openConversation("t2", { expand: false })
    openConversation("t3", { expand: false })
    const before = visibleTabs().map((t) => t.threadId)

    expand("t1")

    // The clicked item does not jump next to Chats: its window opens right
    // above where the pointer is.
    expect(visibleTabs().map((t) => t.threadId)).toEqual(before)
  })

  it("expanding a conversation the dock does not hold does nothing", () => {
    openConversation("t1")

    expand("ghost")

    expect(tabs().map((t) => t.threadId)).toEqual(["t1"])
    expect(activeThreadId()).toBe("t1")
  })

  it("dockAvailable is false at tablet and phone", async () => {
    const originalMatchMedia = window.matchMedia

    function mockMatchMedia(matchesFor: (query: string) => boolean) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: (query: string) => ({
          matches: matchesFor(query),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }),
      })
    }

    try {
      mockMatchMedia(
        (query) => query.includes("min-width: 640px") && query.includes("max-width: 1023px"),
      )
      vi.resetModules()
      const tabletModule = await import("./dock-store")
      expect(tabletModule.dockAvailable()).toBe(false)

      mockMatchMedia((query) => query.includes("max-width: 639px"))
      vi.resetModules()
      const phoneModule = await import("./dock-store")
      expect(phoneModule.dockAvailable()).toBe(false)
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: originalMatchMedia,
      })
    }
  })
})

// The collapsed Chats pill sat on the Tickets page with no surface of its own:
// the row text beneath it ("16 hours ago") read through the pill and collided
// with the word Chats. Every collapsed pill in the strip shares this class, so
// the surface belongs here rather than on one of them.
describe("DOCK_PILL_CLASS", () => {
  it("leaves the surface to the bar, and the window carries its own", () => {
    // The items are joined inside ONE bar that owns the opaque surface
    // (ChatDock's data-dock-bar, pinned in ChatDock.test.tsx); an item that
    // painted its own would square off the bar's rounded ends.
    expect(DOCK_PILL_CLASS).not.toContain("bg-transparent")
    expect(DOCK_PILL_CLASS).not.toContain("bg-elevated")
    expect(DOCK_WINDOW_CLASS).toContain("bg-elevated")
  })
})

// A blob written by a session that grew the strip before the cap existed must
// not rehydrate it: the strip comes back at the cap, holding the most recently
// active conversations.
describe("dock rehydration", () => {
  it("trims a persisted strip to the cap, keeping the most recently active", async () => {
    const stored = Array.from({ length: 20 }, (_, i) => ({
      threadId: `t${i}`,
      expanded: false,
      openedAt: 1000 + i,
      lastActiveAt: 1000 + i,
    }))
    localStorage.setItem(
      "liaison.dock.v1",
      JSON.stringify({ tabs: stored, activeThreadId: null, chatsOpen: false }),
    )
    try {
      vi.resetModules()
      const rehydrated = await import("./dock-store")
      const ids = rehydrated.tabs().map((t) => t.threadId)
      expect(ids).toHaveLength(rehydrated.DOCK_MAX_TABS)
      expect(ids).toContain("t19")
      expect(ids).not.toContain("t0")
    } finally {
      localStorage.removeItem("liaison.dock.v1")
    }
  })

  /**
   * A conversation that is gone for this viewer (deleted, archived, or left)
   * must take its dock tab with it. The tab is persisted, so one left behind
   * is rehydrated on every page load and refetches a thread the server will
   * never serve again.
   */
  it("a blob with several open windows comes back with one, the active one", async () => {
    const stored = ["a", "b", "c"].map((id, i) => ({
      threadId: id,
      expanded: true,
      openedAt: 1000 + i,
      lastActiveAt: 1000 + i,
    }))
    localStorage.setItem(
      "liaison.dock.v1",
      JSON.stringify({ tabs: stored, activeThreadId: "b", chatsOpen: false }),
    )
    try {
      vi.resetModules()
      const rehydrated = await import("./dock-store")
      expect(
        rehydrated
          .tabs()
          .filter((t) => t.expanded)
          .map((t) => t.threadId),
      ).toEqual(["b"])
      expect(rehydrated.tabs()).toHaveLength(3)
    } finally {
      localStorage.removeItem("liaison.dock.v1")
    }
  })

  it("removeThread closes that conversation's dock tab", () => {
    resetThreadStore()
    addThread({
      id: "t-doomed",
      handle: "t-doomed",
      title: "Doomed",
      isPinned: false,
      participants: [],
    })
    openConversation("t-doomed")
    openConversation("t-keep")
    expect(tabs()).toHaveLength(2)

    removeThread("t-doomed")

    expect(tabs().map((t) => t.threadId)).toEqual(["t-keep"])
    const persisted = JSON.parse(localStorage.getItem("liaison.dock.v1") ?? '{"tabs":[]}') as {
      tabs: Array<{ threadId: string }>
    }
    expect(persisted.tabs.map((t) => t.threadId)).toEqual(["t-keep"])
  })
})
