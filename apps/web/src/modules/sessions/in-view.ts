// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ON SCREEN (S58, owner D34). A transcript row whose content the store holds
// as a stub (a large output, input or message off the last screen) reads it
// back only while the row is on screen, and lets it go when it scrolls away.
// One IntersectionObserver serves every row, with a margin so a row is read
// a little before it scrolls in. Without IntersectionObserver (an old engine,
// a test) every row counts as on screen: content is read as before S58.
//
// Batch-5 F4: a row that turns into its stub or back must not move what the
// reader sees. WKWebView (the desktop and iOS apps) has no CSS scroll
// anchoring, so a long message growing to its whole text above the viewport
// pushed the transcript down, and shrinking back pulled it up. So a stub row
// (`createStubRow`) keeps the height it had while whole when it scrolls away
// (reserved until it is whole again), and a row above the viewport that
// changes height moves the scroller by the same amount, less whatever the
// engine's own anchoring already did.

import { type Accessor, createSignal, onCleanup } from "solid-js"

/** Rows within this distance of the viewport count as on screen. */
const IN_VIEW_MARGIN = "600px 0px"

let observer: IntersectionObserver | null = null
const listeners = new Map<Element, (visible: boolean) => void>()

function shared(): IntersectionObserver | null {
  if (observer) return observer
  const IO = (globalThis as { IntersectionObserver?: typeof IntersectionObserver })
    .IntersectionObserver
  if (typeof IO !== "function") return null
  observer = new IO(
    (entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting)
    },
    { rootMargin: IN_VIEW_MARGIN },
  )
  return observer
}

/**
 * A ref for the row's element and whether it is on screen (false until the
 * observer says so; always true without IntersectionObserver).
 */
export function createInView(): [
  ref: (el: HTMLElement) => void,
  inView: Accessor<boolean>,
  element: () => HTMLElement | null,
] {
  const io = shared()
  const [inView, setInView] = createSignal(io === null)
  let target: HTMLElement | null = null
  const ref = (el: HTMLElement) => {
    if (!io) {
      target = el
      return
    }
    if (target === el) return
    if (target) {
      io.unobserve(target)
      listeners.delete(target)
    }
    target = el
    listeners.set(el, setInView)
    io.observe(el)
  }
  onCleanup(() => {
    if (io && target) {
      io.unobserve(target)
      listeners.delete(target)
    }
  })
  return [ref, inView, () => target]
}

/** The nearest scrolling ancestor of a row (the transcript's or the drawer's scroller). */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    let overflow = ""
    try {
      overflow = getComputedStyle(p).overflowY
    } catch {
      return null
    }
    if (overflow === "auto" || overflow === "scroll") return p
  }
  return null
}

/**
 * F4: apply a change to a row's content without moving what the reader sees:
 * when the row lies wholly above the viewport and its height changed, the
 * scroller moves by the difference (less what the engine's own scroll
 * anchoring already moved it). Measured once the DOM has the change (Solid
 * flushes it before any microtask).
 */
export function keepAnchored(row: HTMLElement | null, change: () => void): void {
  const scroller = row ? scrollerOf(row) : null
  if (!row || !scroller) {
    change()
    return
  }
  const before = row.getBoundingClientRect()
  const viewTop = scroller.getBoundingClientRect().top
  const top0 = scroller.scrollTop
  change()
  if (before.bottom > viewTop) return
  queueMicrotask(() => {
    const delta = row.getBoundingClientRect().height - before.height
    const moved = scroller.scrollTop - top0
    if (delta !== moved) scroller.scrollTop = top0 + delta
  })
}

/** A row whose content can be a stub: on screen or not, and its height kept steady. */
export interface StubRow {
  ref: (el: HTMLElement) => void
  inView: Accessor<boolean>
  /**
   * F4: the row turns whole (`whole`) or back into its stub. Scrolled away, a
   * stub keeps the height the row had whole; whole again, the reserve goes.
   * Either way a row above the viewport does not move what the reader sees.
   */
  swap(whole: boolean, apply: () => void): void
  /** The row closed (the owner's choice): no height is kept for it. */
  unreserve(): void
}

export function createStubRow(): StubRow {
  const [ref, inView, element] = createInView()
  return {
    ref,
    inView,
    swap(whole, apply) {
      const row = element()
      if (!row) {
        apply()
        return
      }
      if (!whole && !inView()) row.style.minHeight = `${row.getBoundingClientRect().height}px`
      keepAnchored(row, () => {
        // Whole again: the reserve goes with the change (measured before it).
        if (whole) row.style.minHeight = ""
        apply()
      })
    },
    unreserve() {
      const row = element()
      if (row) row.style.minHeight = ""
    },
  }
}

/** Tests: drop the shared observer (the global may have changed). */
export function _resetInView(): void {
  observer?.disconnect()
  observer = null
  listeners.clear()
}
