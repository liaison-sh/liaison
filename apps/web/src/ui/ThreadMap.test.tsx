// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal, For } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadMap } from "~/ui/ThreadMap"
import type { ThreadMapItem } from "~/ui/thread-map-model"

// jsdom has no layout: the harness gives the scroller a scrollHeight and a
// clientHeight, and every message root a rect derived from its index and the
// scroller's scrollTop, so the map measures a believable thread.
const ITEM_PITCH = 400

function makeItems(n: number): ThreadMapItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    kind: i % 2 === 0 ? "in" : "out",
    who: i % 2 === 0 ? "Lina" : "Sam",
    dateLabel: `${i + 1} Oct`,
    line: `Line of message ${i + 1}`,
  }))
}

interface Harness {
  scroller: HTMLDivElement
  setItems: (items: ThreadMapItem[]) => void
  rectReads: () => number
  offsetReads: () => number
  resetReads: () => void
}

function mount(opts: { items: ThreadMapItem[]; scrollHeight: number; clientHeight: number }) {
  const [items, setItems] = createSignal(opts.items)
  let scroller!: HTMLDivElement
  let content!: HTMLDivElement
  let rectReads = 0
  let offsetReads = 0
  const dims = { scrollHeight: opts.scrollHeight, clientHeight: opts.clientHeight }

  const instrument = (el: HTMLElement, index: number) => {
    el.getBoundingClientRect = () => {
      rectReads++
      const top = index * ITEM_PITCH - scroller.scrollTop
      return { top, height: ITEM_PITCH - 20, bottom: top + ITEM_PITCH - 20 } as DOMRect
    }
    Object.defineProperty(el, "offsetTop", {
      configurable: true,
      get: () => {
        offsetReads++
        return index * ITEM_PITCH
      },
    })
  }

  render(() => (
    <div style={{ display: "flex" }}>
      <div
        data-testid="scroller"
        ref={(el) => {
          scroller = el
          Object.defineProperty(el, "scrollHeight", {
            configurable: true,
            get: () => dims.scrollHeight,
          })
          Object.defineProperty(el, "clientHeight", {
            configurable: true,
            get: () => dims.clientHeight,
          })
          el.getBoundingClientRect = () => ({ top: 0, height: dims.clientHeight }) as DOMRect
        }}
      >
        <div ref={content}>
          <For each={items()}>
            {(item, i) => (
              <article data-thread-map-id={item.id} ref={(el) => instrument(el, i())}>
                {item.line}
              </article>
            )}
          </For>
        </div>
      </div>
      <ThreadMap
        scrollEl={() => scroller}
        contentEl={() => content}
        items={items}
        label="Thread map"
        counter={(i, n) => `${i} / ${n}`}
      />
    </div>
  ))

  const harness: Harness & { dims: typeof dims } = {
    scroller,
    setItems,
    dims,
    rectReads: () => rectReads,
    offsetReads: () => offsetReads,
    resetReads: () => {
      rectReads = 0
      offsetReads = 0
    },
  }
  flushFrames()
  return harness
}

let fillRect: ReturnType<typeof vi.fn>
let frameQueue: FrameRequestCallback[] = []
/** Runs every queued animation frame, and the frames those queue, to idle. */
function flushFrames(): void {
  for (let guard = 0; frameQueue.length > 0 && guard < 20; guard++) {
    const batch = frameQueue
    frameQueue = []
    for (const cb of batch) cb(0)
  }
}
const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
) as PropertyDescriptor
const originalMatchMedia = Object.getOwnPropertyDescriptor(
  window,
  "matchMedia",
) as PropertyDescriptor

beforeEach(() => {
  // Frames run when the test says so (flushFrames): the map coalesces its
  // work into animation frames, and the assertions want each frame's effect.
  frameQueue = []
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frameQueue.push(cb)
    return frameQueue.length
  })
  fillRect = vi.fn()
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillRect,
    globalAlpha: 1,
    fillStyle: "",
  }
  // jsdom has no canvas backend: getContext returns null. A stand-in that
  // records fillRect is enough to count paints.
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => ctx,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext)
  Object.defineProperty(window, "matchMedia", originalMatchMedia)
  document.documentElement.removeAttribute("data-theme")
})

describe("ThreadMap", () => {
  it("stays hidden on a thread shorter than 2.5 screens", () => {
    mount({ items: makeItems(5), scrollHeight: 2000, clientHeight: 1000 })
    expect(screen.queryByTestId("thread-map")).toBeNull()
  })

  it("renders on a long thread with one title per message and a counter", () => {
    mount({ items: makeItems(10), scrollHeight: 4000, clientHeight: 1000 })
    expect(screen.getByTestId("thread-map")).toBeInTheDocument()
    expect(screen.getByTestId("thread-map-counter").textContent).toBe("1 / 10")
    expect(screen.getByTestId("thread-map-titles").querySelectorAll("button")).toHaveLength(10)
    // Painted: blocks went onto the canvas at mount.
    expect(fillRect.mock.calls.length).toBeGreaterThan(0)
  })

  it("keeps the map between 2.2 and 2.5 screens once shown, hides it below 2.2", () => {
    const h = mount({ items: makeItems(10), scrollHeight: 2600, clientHeight: 1000 })
    expect(screen.getByTestId("thread-map")).toBeInTheDocument()
    h.dims.scrollHeight = 2300
    h.setItems(makeItems(9))
    flushFrames()
    expect(screen.getByTestId("thread-map")).toBeInTheDocument()
    h.dims.scrollHeight = 2100
    h.setItems(makeItems(8))
    flushFrames()
    expect(screen.queryByTestId("thread-map")).toBeNull()
  })

  it("shows titles only while the strip is hovered or focused", () => {
    mount({ items: makeItems(10), scrollHeight: 4000, clientHeight: 1000 })
    const titles = screen.getByTestId("thread-map-titles")
    expect(titles.dataset.shown).toBe("false")
    expect(titles.className).toContain("opacity-0")
    const strip = screen.getByTestId("thread-map")
    fireEvent.pointerEnter(strip)
    expect(titles.dataset.shown).toBe("true")
    expect(titles.className).not.toContain("opacity-0")
    fireEvent.pointerLeave(strip)
    expect(titles.dataset.shown).toBe("false")
    // Keyboard: tabbing onto a title is focus inside the strip.
    fireEvent.focusIn(screen.getByTestId("thread-map-title-m1"))
    expect(titles.dataset.shown).toBe("true")
  })

  it("clicking a title scrolls that message's top into view", () => {
    const h = mount({ items: makeItems(10), scrollHeight: 4000, clientHeight: 1000 })
    const scrollTo = vi.fn()
    Object.defineProperty(h.scroller, "scrollTo", { configurable: true, value: scrollTo })
    fireEvent.click(screen.getByTestId("thread-map-title-m4"))
    expect(scrollTo).toHaveBeenCalledWith({ top: 3 * ITEM_PITCH - 8, behavior: "smooth" })
  })

  it("jumps without animation when the reader prefers reduced motion", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    })
    const h = mount({ items: makeItems(10), scrollHeight: 4000, clientHeight: 1000 })
    const scrollTo = vi.fn()
    Object.defineProperty(h.scroller, "scrollTo", { configurable: true, value: scrollTo })
    fireEvent.click(screen.getByTestId("thread-map-title-m2"))
    expect(scrollTo).toHaveBeenCalledWith({ top: ITEM_PITCH - 8, behavior: "auto" })
  })

  it("a scroll reads no item layout and paints nothing (S9 budget)", () => {
    const h = mount({ items: makeItems(10), scrollHeight: 4000, clientHeight: 1000 })
    const band = screen.getByTestId("thread-map-band")
    h.resetReads()
    fillRect.mockClear()
    for (let k = 1; k <= 20; k++) {
      h.scroller.scrollTop = k * 150
      h.scroller.dispatchEvent(new Event("scroll"))
      flushFrames()
    }
    expect(h.rectReads()).toBe(0)
    expect(h.offsetReads()).toBe(0)
    expect(fillRect).not.toHaveBeenCalled()
    // ...and still did its job: the band followed, the counter moved on.
    // scrollTop 3000 + 30% of 1000 = 3300 → message 9 (top 3200).
    expect(band.style.transform).toBe(`translateY(${3000 * (1000 / 4000)}px)`)
    expect(screen.getByTestId("thread-map-counter").textContent).toBe("9 / 10")
    expect(screen.getByTestId("thread-map-title-m9").dataset.active).toBe("true")
  })

  it("repaints when the theme flips", async () => {
    mount({ items: makeItems(10), scrollHeight: 4000, clientHeight: 1000 })
    fillRect.mockClear()
    document.documentElement.setAttribute("data-theme", "light")
    await new Promise((r) => setTimeout(r, 0))
    flushFrames()
    expect(fillRect.mock.calls.length).toBeGreaterThan(0)
  })
})
