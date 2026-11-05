// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M4: a phone keeps at most six working tabs mounted, and closes the oldest
// hidden one to stay there. Every open tab is a live component with live
// subscriptions, so an unbounded session is what gets the webview killed in
// the background.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"
import {
  closeTab,
  type EvictableTab,
  openTab,
  PHONE_TAB_CAP,
  phoneTabsToEvict,
  resetTabStore,
  TabStoreTestAccess,
  tabStore,
} from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

/** Pins the shell tier by answering matchMedia for one query only. */
function setTier(query: string | null): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({
      matches: query !== null && q === query,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
  syncShellTier()
}

const never = () => false

function tabs(...ids: string[]): EvictableTab[] {
  return ids.map((id) => ({ id, type: "tickets:ticket" }))
}

describe("choosing what to evict", () => {
  it("evicts nothing while the phone is at or under the cap", () => {
    const six = tabs(...Array.from({ length: PHONE_TAB_CAP }, (_, i) => `t${i}`))
    expect(phoneTabsToEvict(six, "t0", never, () => 0)).toEqual([])
  })

  it("evicts the OLDEST hidden tab, one per tab over the cap", () => {
    const seven = tabs(...Array.from({ length: PHONE_TAB_CAP + 1 }, (_, i) => `t${i}`))
    const used: Record<string, number> = { t0: 9, t1: 1, t2: 8, t3: 7, t4: 6, t5: 5, t6: 10 }
    expect(phoneTabsToEvict(seven, "t6", never, (id) => used[id])).toEqual(["t1"])

    const nine = tabs(...Array.from({ length: PHONE_TAB_CAP + 3 }, (_, i) => `t${i}`))
    const used2: Record<string, number> = {
      t0: 9,
      t1: 1,
      t2: 8,
      t3: 2,
      t4: 6,
      t5: 5,
      t6: 10,
      t7: 3,
      t8: 11,
    }
    expect(phoneTabsToEvict(nine, "t8", never, (id) => used2[id])).toEqual(["t1", "t3", "t7"])
  })

  it("NEVER evicts the active tab, even when it is the oldest", () => {
    const seven = tabs(...Array.from({ length: PHONE_TAB_CAP + 1 }, (_, i) => `t${i}`))
    // t0 is the least recently used AND the active one.
    const used: Record<string, number> = { t0: 0, t1: 1, t2: 2, t3: 3, t4: 4, t5: 5, t6: 6 }
    expect(phoneTabsToEvict(seven, "t0", never, (id) => used[id])).toEqual(["t1"])
  })

  it("never evicts a phone root, and never counts one against the cap", () => {
    const roots: EvictableTab[] = [
      { id: "kernel:home:home", type: "kernel:home" },
      { id: "kernel:chats:chats", type: "kernel:chats" },
      { id: "kernel:work:work", type: "kernel:work" },
      { id: "kernel:search:search", type: "kernel:search" },
      { id: "kernel:settings:settings", type: "kernel:settings" },
    ]
    const six = tabs(...Array.from({ length: PHONE_TAB_CAP }, (_, i) => `t${i}`))
    // Eleven tabs, six of them work: nothing over the cap.
    expect(phoneTabsToEvict([...roots, ...six], "t0", never, () => 0)).toEqual([])
  })

  it("never evicts a singleton, and never counts one against the cap", () => {
    const singletons: EvictableTab[] = [
      { id: "s1", type: "knowledge:home" },
      { id: "s2", type: "kernel:approvals" },
    ]
    const six = tabs(...Array.from({ length: PHONE_TAB_CAP }, (_, i) => `t${i}`))
    const isSingleton = (type: string) => type === "knowledge:home" || type === "kernel:approvals"
    expect(phoneTabsToEvict([...singletons, ...six], "t0", isSingleton, () => 0)).toEqual([])
  })

  it("sorts a tab never used in this session oldest", () => {
    const seven = tabs(...Array.from({ length: PHONE_TAB_CAP + 1 }, (_, i) => `t${i}`))
    // t4 has no entry at all: a tab rehydrated from a previous session.
    const used: Record<string, number> = { t0: 9, t1: 8, t2: 7, t3: 6, t5: 5, t6: 10 }
    expect(phoneTabsToEvict(seven, "t6", never, (id) => used[id] ?? 0)).toEqual(["t4"])
  })
})

describe("the cap in the live store", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    registerTabType("tickets:ticket", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
    } as never)
    setTier(PHONE_QUERY)
  })

  function openTicket(id: string): void {
    openTab({ type: "tickets:ticket", entityId: id, label: id, preview: false })
  }

  it("keeps the newest six and closes the oldest as the seventh opens", () => {
    for (let i = 0; i < PHONE_TAB_CAP; i++) openTicket(`t${i}`)
    const before = tabStore.tabs.filter((t) => t.type === "tickets:ticket")
    expect(before).toHaveLength(PHONE_TAB_CAP)

    openTicket("t6")
    const after = tabStore.tabs.filter((t) => t.type === "tickets:ticket")
    expect(after).toHaveLength(PHONE_TAB_CAP)
    expect(after.map((t) => t.entityId)).not.toContain("t0")
    // The one just opened is active and still there.
    expect(after.map((t) => t.entityId)).toContain("t6")
    expect(tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.entityId).toBe("t6")
  })

  it("keeps a tab the user came back to, and drops the one they did not", () => {
    for (let i = 0; i < PHONE_TAB_CAP; i++) openTicket(`t${i}`)
    // Revisiting t0 makes it the most recent, so t1 becomes the oldest.
    openTicket("t0")
    openTicket("t6")
    const open = tabStore.tabs.filter((t) => t.type === "tickets:ticket").map((t) => t.entityId)
    expect(open).toContain("t0")
    expect(open).not.toContain("t1")
  })

  it("does nothing at desktop tier, where the tab bar shows what is open", () => {
    setTier(null)
    for (let i = 0; i < PHONE_TAB_CAP + 4; i++) openTicket(`t${i}`)
    expect(tabStore.tabs.filter((t) => t.type === "tickets:ticket")).toHaveLength(PHONE_TAB_CAP + 4)
  })

  it("prunes the LRU entry when a tab closes, instead of leaking it forever", () => {
    openTicket("t0")
    const tabId = tabStore.tabs.find((t) => t.entityId === "t0")!.id
    expect(TabStoreTestAccess.hasLastUsed(tabId)).toBe(true)

    closeTab(tabId)
    expect(TabStoreTestAccess.hasLastUsed(tabId)).toBe(false)
  })
})
