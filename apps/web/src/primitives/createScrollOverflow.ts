// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal, onCleanup, onMount } from "solid-js"

/**
 * Tracks whether a scrollable element can scroll in either direction.
 * Reacts to scroll events, container resizes, and content mutations.
 */
export function createScrollOverflow(
  getEl: () => HTMLElement | undefined,
  orientation: "vertical" | "horizontal" = "vertical",
) {
  const [canScrollStart, setCanScrollStart] = createSignal(false)
  const [canScrollEnd, setCanScrollEnd] = createSignal(false)

  function update() {
    const el = getEl()
    if (!el) return
    if (orientation === "vertical") {
      setCanScrollStart(el.scrollTop > 0)
      setCanScrollEnd(el.scrollTop + el.clientHeight < el.scrollHeight - 1)
    } else {
      setCanScrollStart(el.scrollLeft > 0)
      setCanScrollEnd(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
    }
  }

  onMount(() => {
    const el = getEl()
    if (!el) return

    el.addEventListener("scroll", update, { passive: true })

    const ro = new ResizeObserver(update)
    ro.observe(el)

    // Catch content changes (items added/removed in lists) — debounced to avoid
    // excessive calls from subtree mutations in large lists
    let moQueued = false
    const mo = new MutationObserver(() => {
      if (moQueued) return
      moQueued = true
      queueMicrotask(() => {
        moQueued = false
        update()
      })
    })
    mo.observe(el, { childList: true, subtree: true })

    update()

    onCleanup(() => {
      el.removeEventListener("scroll", update)
      ro.disconnect()
      mo.disconnect()
    })
  })

  return { canScrollStart, canScrollEnd, update }
}
