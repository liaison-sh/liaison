// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal, onCleanup, onMount } from "solid-js"

/**
 * Whether an element's content is taller than the box drawing it.
 *
 * The question a "Show more" toggle actually has to answer. Deciding it from a
 * CHARACTER COUNT gets it wrong in both directions: 542 characters of prose
 * with a line break every few words overflows a 320px box and offered no
 * toggle at all (the reviewer saw a message cut mid word with no way to read
 * the rest), while 700 characters on three long lines fits and offered one for
 * nothing. Only the laid-out box knows.
 *
 * Re-measured on container resize AND on content mutation, because both change
 * the answer after mount: a markdown body streams in, an image loads, a phone
 * rotates.
 */
export function createOverflowed(getEl: () => HTMLElement | undefined) {
  const [overflowed, setOverflowed] = createSignal(false)

  function update(): void {
    const el = getEl()
    if (!el) return
    // A pixel of slack: sub-pixel layout rounding makes scrollHeight exceed
    // clientHeight by fractions on boxes that visibly fit.
    setOverflowed(el.scrollHeight > el.clientHeight + 1)
  }

  onMount(() => {
    const el = getEl()
    if (!el) return

    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    ro?.observe(el)

    let queued = false
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            if (queued) return
            queued = true
            queueMicrotask(() => {
              queued = false
              update()
            })
          })
    mo?.observe(el, { childList: true, subtree: true, characterData: true })

    update()

    onCleanup(() => {
      ro?.disconnect()
      mo?.disconnect()
    })
  })

  return { overflowed, update }
}
