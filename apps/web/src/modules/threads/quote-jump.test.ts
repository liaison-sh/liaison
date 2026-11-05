// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S14: clicking a quote scrolls to its source (`data-message-id`) and
// highlights it, loading older pages until it is there, at most ten, then
// says "Message not found".

import { afterEach, describe, expect, it, vi } from "vitest"
import { jumpToMessage } from "~/modules/threads/quote-jump"

function containerWith(ids: string[]): HTMLElement {
  const el = document.createElement("div")
  for (const id of ids) {
    const row = document.createElement("div")
    row.dataset.messageId = id
    el.appendChild(row)
  }
  document.body.appendChild(el)
  return el
}

const nativeScrollIntoView = HTMLElement.prototype.scrollIntoView

afterEach(() => {
  document.body.innerHTML = ""
  vi.useRealTimers()
  vi.unstubAllGlobals()
  HTMLElement.prototype.scrollIntoView = nativeScrollIntoView
})

describe("jumpToMessage", () => {
  it("highlights a source that is already on screen without loading anything", async () => {
    const container = containerWith(["a", "b"])
    const loadMore = vi.fn(async () => {})
    const onMissing = vi.fn()
    const found = await jumpToMessage({
      container: () => container,
      messageId: "b",
      hasMore: () => true,
      loadMore,
      onMissing,
    })
    expect(found).toBe(true)
    expect(loadMore).not.toHaveBeenCalled()
    const row = container.querySelector('[data-message-id="b"]') as HTMLElement
    expect(row.dataset.quoteHighlight).toBe("true")
    expect(onMissing).not.toHaveBeenCalled()
  })

  it("loads older pages until the source is rendered", async () => {
    const container = containerWith(["z"])
    let pages = 0
    const loadMore = vi.fn(async () => {
      pages++
      const row = document.createElement("div")
      row.dataset.messageId = pages === 3 ? "old" : `filler-${pages}`
      container.prepend(row)
    })
    const found = await jumpToMessage({
      container: () => container,
      messageId: "old",
      hasMore: () => true,
      loadMore,
      onMissing: vi.fn(),
    })
    expect(found).toBe(true)
    expect(loadMore).toHaveBeenCalledTimes(3)
  })

  it("gives up after ten pages and says so", async () => {
    const container = containerWith(["z"])
    const loadMore = vi.fn(async () => {})
    const onMissing = vi.fn()
    const found = await jumpToMessage({
      container: () => container,
      messageId: "never",
      hasMore: () => true,
      loadMore,
      onMissing,
    })
    expect(found).toBe(false)
    expect(loadMore).toHaveBeenCalledTimes(10)
    expect(onMissing).toHaveBeenCalledTimes(1)
  })

  it("stops early when there is nothing older to load", async () => {
    const container = containerWith(["z"])
    const loadMore = vi.fn(async () => {})
    const onMissing = vi.fn()
    await jumpToMessage({
      container: () => container,
      messageId: "never",
      hasMore: () => false,
      loadMore,
      onMissing,
    })
    expect(loadMore).not.toHaveBeenCalled()
    expect(onMissing).toHaveBeenCalledTimes(1)
  })

  /**
   * QUO-03: a source older than the loaded page. The page is inserted above
   * the reader, and at the next layout the browser keeps her reading position
   * (scroll anchoring), which CANCELS a smooth scroll already under way. This
   * models that frame: callbacks, then layout; a layout after an insert
   * cancels a smooth scroll in flight, and one that survives a layout lands.
   */
  function layoutModel(container: HTMLElement) {
    const queue: Array<() => void> = []
    let inserted = false
    let smoothTo: HTMLElement | null = null
    let landedOn: HTMLElement | null = null
    let highlightedWhenLanded = false
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      queue.push(() => cb(0))
      return queue.length
    })
    new MutationObserver(() => {
      inserted = true
    }).observe(container, { childList: true })
    const scroll = function (this: HTMLElement, opts?: ScrollIntoViewOptions) {
      if (opts?.behavior === "smooth") smoothTo = this
      else {
        smoothTo = null
        landedOn = this
        highlightedWhenLanded = this.dataset.quoteHighlight === "true"
      }
    }
    HTMLElement.prototype.scrollIntoView = scroll as never
    async function frame() {
      // Let pending promises and observers run first, as the event loop does.
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
      const callbacks = queue.splice(0)
      for (const cb of callbacks) cb()
      if (inserted) {
        inserted = false
        smoothTo = null // anchoring keeps the reading position: smooth scroll cancelled
      } else if (smoothTo) {
        landedOn = smoothTo
        highlightedWhenLanded = smoothTo.dataset.quoteHighlight === "true"
        smoothTo = null
      }
    }
    return { frame, landed: () => landedOn, highlightedWhenLanded: () => highlightedWhenLanded }
  }

  it.each([1, 3])(
    "brings a source %i older page(s) away into view, highlighted, past the scroll anchoring",
    async (pagesAway) => {
      const container = containerWith(["z"])
      const model = layoutModel(container)
      let pages = 0
      const loadMore = vi.fn(async () => {
        pages++
        const row = document.createElement("div")
        row.dataset.messageId = pages === pagesAway ? "old" : `filler-${pages}`
        container.prepend(row)
      })
      const done = jumpToMessage({
        container: () => container,
        messageId: "old",
        hasMore: () => true,
        loadMore,
        onMissing: vi.fn(),
      })
      for (let i = 0; i < 12; i++) await model.frame()
      expect(await done).toBe(true)
      expect(loadMore).toHaveBeenCalledTimes(pagesAway)
      const source = container.querySelector('[data-message-id="old"]')
      expect(model.landed()).toBe(source)
      expect(model.highlightedWhenLanded()).toBe(true)
    },
  )
})
