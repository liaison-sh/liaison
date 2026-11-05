// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  CARD_IDS,
  cardOrder,
  hydrateHomeCardLayout,
  isCardCollapsed,
  reorderCards,
  resetHomeCardLayout,
  toggleCardCollapsed,
} from "./home-card-layout"

function makeApi() {
  return { put: vi.fn(async () => ({})) } as any
}

beforeEach(() => {
  resetHomeCardLayout()
  vi.useFakeTimers()
})

describe("home-card-layout", () => {
  it("defaults to the full card order with nothing collapsed when hydrated with null", () => {
    hydrateHomeCardLayout(makeApi(), null)
    expect(cardOrder()).toEqual([...CARD_IDS])
    for (const id of CARD_IDS) expect(isCardCollapsed(id)).toBe(false)
  })

  it("hydrates order and collapsed state from a persisted layout", () => {
    hydrateHomeCardLayout(makeApi(), {
      order: ["mail", "approvals", "messages", "feed"],
      collapsed: ["approvals"],
    })
    expect(cardOrder()).toEqual(["mail", "approvals", "messages", "feed"])
    expect(isCardCollapsed("approvals")).toBe(true)
    expect(isCardCollapsed("mail")).toBe(false)
  })

  it("appends a known id missing from the persisted order rather than dropping the card", () => {
    hydrateHomeCardLayout(makeApi(), { order: ["mail"], collapsed: [] })
    expect(cardOrder()).toEqual(["mail", "approvals", "messages", "feed"])
  })

  it("ignores an unknown persisted card id instead of throwing or displaying it", () => {
    hydrateHomeCardLayout(makeApi(), {
      order: ["mail", "some-future-card", "approvals", "messages", "feed"],
      collapsed: ["some-future-card"],
    })
    expect(cardOrder()).toEqual(["mail", "approvals", "messages", "feed"])
    expect(isCardCollapsed("some-future-card" as any)).toBe(false)
  })

  it("reorderCards moves the dragged card to the target's position", () => {
    hydrateHomeCardLayout(makeApi(), null)
    reorderCards("mail", "approvals")
    expect(cardOrder()).toEqual(["mail", "approvals", "messages", "feed"])
  })

  it("hydration does NOT fire a PUT", () => {
    const api = makeApi()
    hydrateHomeCardLayout(api, { order: ["mail", "approvals", "messages", "feed"], collapsed: [] })
    vi.advanceTimersByTime(5_000)
    expect(api.put).not.toHaveBeenCalled()
  })

  it("a single reorder debounces to exactly one PUT with the new order", async () => {
    const api = makeApi()
    hydrateHomeCardLayout(api, null)
    reorderCards("mail", "approvals")
    vi.advanceTimersByTime(1_000)
    await Promise.resolve()
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledWith(
      "/user/preferences/home-cards",
      expect.objectContaining({ order: ["mail", "approvals", "messages", "feed"] }),
    )
  })

  it("several rapid reorders/collapses in quick succession fire exactly ONE PUT (debounce, not per-action)", async () => {
    const api = makeApi()
    hydrateHomeCardLayout(api, null)
    reorderCards("mail", "approvals")
    vi.advanceTimersByTime(200)
    reorderCards("messages", "feed")
    vi.advanceTimersByTime(200)
    toggleCardCollapsed("approvals")
    vi.advanceTimersByTime(200)
    toggleCardCollapsed("mail")
    // Still inside the debounce window from the last action.
    expect(api.put).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    await Promise.resolve()
    expect(api.put).toHaveBeenCalledTimes(1)
    // The single PUT carries the FINAL state, not an intermediate one.
    const lastCall = api.put.mock.calls[0][1]
    expect(lastCall.collapsed.sort()).toEqual(["approvals", "mail"].sort())
  })

  it("toggleCardCollapsed flips membership", () => {
    hydrateHomeCardLayout(makeApi(), null)
    expect(isCardCollapsed("approvals")).toBe(false)
    toggleCardCollapsed("approvals")
    expect(isCardCollapsed("approvals")).toBe(true)
    toggleCardCollapsed("approvals")
    expect(isCardCollapsed("approvals")).toBe(false)
  })

  it("a hydrate while a debounced PUT is pending does not clobber the pending change (remount-during-debounce)", async () => {
    const api = makeApi()
    hydrateHomeCardLayout(api, null)
    reorderCards("mail", "approvals") // user change, PUT now pending (1s debounce)

    // Home remounts (tab close+reopen) and its GET resolves with STALE server
    // data (the reorder hasn't landed server-side yet) before the debounce
    // timer fires.
    hydrateHomeCardLayout(api, { order: [...CARD_IDS], collapsed: [] })

    // Local state must still reflect the user's reorder, not the stale hydrate.
    expect(cardOrder()).toEqual(["mail", "approvals", "messages", "feed"])

    vi.advanceTimersByTime(1_000)
    await Promise.resolve()
    expect(api.put).toHaveBeenCalledTimes(1)
    expect(api.put).toHaveBeenCalledWith(
      "/user/preferences/home-cards",
      expect.objectContaining({ order: ["mail", "approvals", "messages", "feed"] }),
    )
  })

  it("a PUT failure does not throw and the local order is kept", async () => {
    const api = {
      put: vi.fn(async () => {
        throw new Error("network")
      }),
    } as any
    hydrateHomeCardLayout(api, null)
    reorderCards("mail", "approvals")
    vi.advanceTimersByTime(1_000)
    await Promise.resolve()
    await Promise.resolve()
    expect(cardOrder()).toEqual(["mail", "approvals", "messages", "feed"])
  })
})
