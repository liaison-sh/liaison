// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A BOTTOM-PINNED COMPOSER RISES ABOVE THE DOCK'S BAR ONCE THE BAR HIDES ITS
// CONTROLS. The desktop dock's bar lies over the main panel's bottom right
// corner and reserves no band (ChatDock.tsx). With one or two items it only
// grazes a composer's Send corner, which is intended (CLAUDE.md, "Chat dock
// overlap"); with enough conversations open it runs left over Send, the
// recipient line and the mic. From that point on the composer is lifted by
// exactly the bar's height above the composer's bottom, so it sits on top of
// the bar, and it drops back when the bar shrinks.
//
// "Hides" means the bar covers a control's centre, horizontally and
// vertically: a corner the bar merely touches never moves a page. Nothing is
// lifted where no bar is shown (phone, tablet, a layoutless test).
//
// The lift is a bottom margin on the composer's root: the column above it
// shrinks, the composer's own size never changes, so measuring cannot feed
// back into itself. Positions are judged where they would sit with no lift
// (the current lift added back), which keeps the result stable.
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js"

/** Where the desktop dock's bar lies on screen (viewport coordinates), as
 *  ChatDock measures it; null while no bar is shown (phone, tablet, signed
 *  out) and in a layoutless test environment. */
export interface DockBarRect {
  left: number
  right: number
  top: number
  bottom: number
}
const [barRect, setBarRect] = createSignal<DockBarRect | null>(null)
export const dockBarRect = barRect
export function setDockBarRect(rect: DockBarRect | null): void {
  const prev = barRect()
  if (
    prev &&
    rect &&
    prev.left === rect.left &&
    prev.right === rect.right &&
    prev.top === rect.top &&
    prev.bottom === rect.bottom
  )
    return
  setBarRect(rect)
}

const CONTROLS =
  'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [contenteditable="true"]'

interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/** The lift (px) a composer whose box is `root` and whose controls are
 *  `controls` needs to clear `bar`, all measured with `currentLift` applied. */
export function computeDockLift(
  root: Box,
  controls: readonly Box[],
  bar: DockBarRect | null,
  currentLift: number,
): number {
  if (!bar) return 0
  const hidden = controls.some((c) => {
    if (c.right <= c.left || c.bottom <= c.top) return false
    const cx = (c.left + c.right) / 2
    const cy = (c.top + c.bottom) / 2 + currentLift
    return cx >= bar.left && cx <= bar.right && cy >= bar.top && cy <= bar.bottom
  })
  if (!hidden) return 0
  return Math.max(0, Math.round(root.bottom + currentLift - bar.top))
}

/** Lifts `el()` above the dock's bar while the bar hides one of its controls.
 *  `enabled()` false (a composer docked to the native keyboard) clears it. */
export function createDockLift(
  el: Accessor<HTMLElement | undefined>,
  enabled: Accessor<boolean> = () => true,
): Accessor<number> {
  const [lift, setLift] = createSignal(0)

  const measure = (): void => {
    const root = el()
    const bar = dockBarRect()
    if (!root || !bar || !enabled()) {
      setLift(0)
      return
    }
    const controls = [...root.querySelectorAll<HTMLElement>(CONTROLS)].map((c) =>
      c.getBoundingClientRect(),
    )
    setLift(computeDockLift(root.getBoundingClientRect(), controls, bar, lift()))
  }

  // The bar moved or grew (an item opened or closed, the panel resized).
  createEffect(() => {
    dockBarRect()
    enabled()
    measure()
  })

  createEffect(() => {
    const root = el()
    if (!root || typeof ResizeObserver === "undefined") return
    // The composer's own controls move when it resizes (Cc opened, a draft
    // grew, the panel narrowed).
    const ro = new ResizeObserver(() => measure())
    ro.observe(root)
    window.addEventListener("resize", measure)
    onCleanup(() => {
      ro.disconnect()
      window.removeEventListener("resize", measure)
    })
  })

  return lift
}
