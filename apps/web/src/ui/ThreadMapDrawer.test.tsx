// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal, For } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { THREAD_MAP_PILL_IDLE_MS, ThreadMapDrawer } from "~/ui/ThreadMapDrawer"
import type { ThreadMapItem } from "~/ui/thread-map-model"

// jsdom has no layout: the scroller gets a clientHeight and every message
// root a rect from its index and the scroller's scrollTop.
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

let frameQueue: FrameRequestCallback[] = []
function flushFrames(): void {
  for (let guard = 0; frameQueue.length > 0 && guard < 20; guard++) {
    const batch = frameQueue
    frameQueue = []
    for (const cb of batch) cb(0)
  }
}

function mount(items: ThreadMapItem[], initiallyOpen = false) {
  const [open, setOpen] = createSignal(initiallyOpen)
  const onOpen = vi.fn(() => setOpen(true))
  const onClose = vi.fn(() => setOpen(false))
  let scroller!: HTMLDivElement
  let content!: HTMLDivElement
  render(() => (
    <div style={{ position: "relative" }}>
      <div
        data-testid="scroller"
        ref={(el) => {
          scroller = el
          Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 800 })
          el.getBoundingClientRect = () => ({ top: 0, height: 800 }) as DOMRect
        }}
      >
        <div ref={content}>
          <For each={items}>
            {(item, i) => (
              <article
                data-thread-map-id={item.id}
                ref={(el) => {
                  el.getBoundingClientRect = () => {
                    const top = i() * ITEM_PITCH - scroller.scrollTop
                    return { top, height: ITEM_PITCH - 20 } as DOMRect
                  }
                }}
              >
                {item.line}
              </article>
            )}
          </For>
        </div>
      </div>
      <ThreadMapDrawer
        scrollEl={() => scroller}
        contentEl={() => content}
        items={() => items}
        open={open()}
        onOpen={onOpen}
        onClose={onClose}
        title="This conversation"
        summary={(count, first, last) => `${count} messages · ${first} to ${last}`}
        pill={(index, total, who) => `${index} / ${total} · ${who}`}
        openLabel="Open thread map"
        closeLabel="Close"
        noteTag="note"
      />
    </div>
  ))
  flushFrames()
  const scrollTo = vi.fn()
  Object.defineProperty(scroller, "scrollTo", { configurable: true, value: scrollTo })
  const scrollBy = (top: number) => {
    scroller.scrollTop = top
    scroller.dispatchEvent(new Event("scroll"))
    flushFrames()
  }
  return { open, onOpen, onClose, scrollTo, scrollBy }
}

beforeEach(() => {
  frameQueue = []
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frameQueue.push(cb)
    return frameQueue.length
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("ThreadMapDrawer", () => {
  it("the pill hides until the conversation scrolls, then fades 1.6 s after it stops", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const h = mount(makeItems(6))
    const pill = screen.getByTestId("thread-map-pill")
    expect(pill.dataset.shown).toBe("false")
    // scrollTop 1200 + 30% of 800 = 1440 → message 4 (top 1200).
    h.scrollBy(1200)
    expect(pill.dataset.shown).toBe("true")
    expect(pill.textContent).toBe("4 / 6 · Sam")
    vi.advanceTimersByTime(THREAD_MAP_PILL_IDLE_MS - 100)
    h.scrollBy(1300)
    // Still scrolling: the idle clock restarted.
    vi.advanceTimersByTime(THREAD_MAP_PILL_IDLE_MS - 100)
    expect(pill.dataset.shown).toBe("true")
    vi.advanceTimersByTime(200)
    expect(pill.dataset.shown).toBe("false")
  })

  it("tapping the pill opens the drawer", () => {
    const h = mount(makeItems(6))
    h.scrollBy(400)
    fireEvent.click(screen.getByTestId("thread-map-pill"))
    expect(h.onOpen).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId("thread-map-drawer")).toBeInTheDocument()
  })

  it("offers nothing on a thread of fewer than 3 messages", () => {
    const h = mount(makeItems(2))
    h.scrollBy(400)
    expect(screen.queryByTestId("thread-map-pill")).toBeNull()
  })

  it("is closed by default; open, it lists one row per message with the current one marked", () => {
    const items: ThreadMapItem[] = [
      ...makeItems(5),
      { id: "e1", kind: "event", who: "", dateLabel: "6 Oct", line: "Status changed" },
    ]
    const h = mount(items)
    expect(screen.queryByTestId("thread-map-drawer")).toBeNull()
    h.scrollBy(800)
    fireEvent.click(screen.getByTestId("thread-map-pill"))
    flushFrames()
    const drawer = screen.getByTestId("thread-map-drawer")
    // Rows = messages; the event gets no row.
    expect(drawer.querySelectorAll("[data-testid^='thread-map-row-']")).toHaveLength(5)
    expect(screen.queryByTestId("thread-map-row-e1")).toBeNull()
    // scrollTop 800 + 240 = 1040 → message 3.
    expect(screen.getByTestId("thread-map-row-m3").dataset.active).toBe("true")
    expect(screen.getByTestId("thread-map-row-m1").dataset.active).toBeUndefined()
    expect(screen.getByTestId("thread-map-summary").textContent).toBe("5 messages · 1 Oct to 5 Oct")
    // Held against the right edge.
    expect(document.querySelector("[data-overlay-sheet]")?.getAttribute("data-variant")).toBe(
      "side",
    )
    const panel = document.querySelector("[data-overlay-sheet]")?.parentElement as HTMLElement
    expect(panel.parentElement?.className).toContain("justify-end")
  })

  it("tapping a row closes the drawer and lands that message's top in view", () => {
    const h = mount(makeItems(6), true)
    flushFrames()
    fireEvent.click(screen.getByTestId("thread-map-row-m5"))
    expect(h.onClose).toHaveBeenCalledTimes(1)
    expect(h.open()).toBe(false)
    expect(h.scrollTo).toHaveBeenCalledWith({ top: 4 * ITEM_PITCH - 8, behavior: "smooth" })
  })
})
