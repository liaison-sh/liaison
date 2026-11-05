// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Attribute-based roving focus system.
 *
 * Usage:
 *   Container:  onKeyDown={rovingFocus}
 *   Each item:  data-roving  (+ tabindex="0" on non-button elements)
 *
 * ArrowUp / ArrowDown cycles focus through [data-roving] descendants.
 * Works with buttons, divs, links — anything focusable and marked.
 */
export function rovingFocus(e: KeyboardEvent) {
  const isDown = e.key === "ArrowDown"
  const isUp = e.key === "ArrowUp"
  if (!isDown && !isUp) return

  e.preventDefault()
  const container = e.currentTarget as HTMLElement
  const items = Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-roving]:not([disabled]):not([aria-disabled="true"])',
    ),
  )
  if (!items.length) return

  const idx = items.indexOf(document.activeElement as HTMLElement)
  const next = isDown ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length
  items[next].focus()
}
