// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"
import { addThread, removeThread, resetThreadStore } from "~/modules/threads/thread-store"
import { startTabBadge, TabBadgeTestAccess } from "./tab-badge"

function makeThread(id: string, unreadCount: number, isMuted = false) {
  return {
    id,
    handle: `thread-${id}`,
    // A direct conversation: its unread messages are THE badge (rule 6).
    title: null,
    isPinned: false,
    isPinnedByUser: false,
    isMuted,
    participants: [],
    updatedAt: new Date().toISOString(),
    unreadCount,
  }
}

describe("tab-badge", () => {
  beforeEach(() => {
    resetThreadStore()
    TabBadgeTestAccess.reset()
    document.title = "Liaison"
    const link = document.getElementById("favicon") as HTMLLinkElement | null
    link?.remove()
    const newLink = document.createElement("link")
    newLink.id = "favicon"
    newLink.rel = "icon"
    newLink.href = "/favicon.svg"
    document.head.appendChild(newLink)
  })

  it("shows (N) prefix when unread threads exist and restores the exact title at 0", () => {
    startTabBadge()
    expect(document.title).toBe("Liaison")

    addThread(makeThread("t1", 3))
    expect(document.title).toBe("(3) Liaison")

    removeThread("t1")
    expect(document.title).toBe("Liaison")
  })

  it("does not stack (N) prefixes across repeated transitions (0->3->0->2)", () => {
    startTabBadge()
    addThread(makeThread("t1", 3))
    expect(document.title).toBe("(3) Liaison")
    removeThread("t1")
    expect(document.title).toBe("Liaison")
    addThread(makeThread("t2", 2))
    expect(document.title).toBe("(2) Liaison")
  })

  it("swaps the favicon href when unread > 0 and reverts at 0", () => {
    startTabBadge()
    const link = document.getElementById("favicon") as HTMLLinkElement
    expect(link.href).toContain("/favicon.svg")

    addThread(makeThread("t1", 1))
    expect(link.getAttribute("href")).toContain("data:image/svg+xml")

    removeThread("t1")
    expect(link.getAttribute("href")).toBe("/favicon.svg")
  })

  it("degrades to title-only when the favicon element is missing (no throw)", () => {
    document.getElementById("favicon")?.remove()
    startTabBadge()
    expect(() => addThread(makeThread("t1", 4))).not.toThrow()
    expect(document.title).toBe("(4) Liaison")
  })

  it("degrades to title-only when setting the favicon href throws (element present but hostile DOM)", () => {
    // Distinct from the "missing element" test above: the #favicon element
    // IS present, so the `if (link)` guard passes and code reaches the
    // try/catch around `link.href = ...` itself.
    const link = document.getElementById("favicon") as HTMLLinkElement
    Object.defineProperty(link, "href", {
      configurable: true,
      set() {
        throw new Error("boom")
      },
      get() {
        return "/favicon.svg"
      },
    })
    startTabBadge()
    expect(() => addThread(makeThread("t1", 4))).not.toThrow()
    expect(document.title).toBe("(4) Liaison")
  })

  it("is idempotent across a double start (does not re-capture a badged title as the base)", () => {
    startTabBadge()
    addThread(makeThread("t1", 5))
    expect(document.title).toBe("(5) Liaison")
    startTabBadge() // second call — must be a no-op
    expect(document.title).toBe("(5) Liaison")
    removeThread("t1")
    expect(document.title).toBe("Liaison")
  })
})
