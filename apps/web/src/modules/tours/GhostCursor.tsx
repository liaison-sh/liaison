// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createSignal, Show } from "solid-js"
import type { AutoplayCursor } from "./autoplay"

interface CursorState {
  x: number
  y: number
  /** Duration of the current glide, ms. */
  ms: number
}

/** Human-ish glide: longer moves take longer, within bounds. */
function glideMs(dx: number, dy: number): number {
  const d = Math.hypot(dx, dy)
  if (d < 2) return 0
  return Math.round(Math.min(900, Math.max(250, d * 1.2)))
}

/**
 * The ghost cursor's state and the AutoplayCursor the runner drives. One per
 * TourHost; `visible` is on only while autoplay plays.
 */
export function createGhostCursor() {
  const [pos, setPos] = createSignal<CursorState | null>(null)
  const [visible, setVisible] = createSignal(false)

  const cursor: AutoplayCursor = {
    moveTo(el, signal) {
      const r = el.getBoundingClientRect()
      const x = r.left + Math.min(r.width / 2, 24)
      const y = r.top + r.height / 2
      const from = pos() ?? { x: window.innerWidth - 120, y: window.innerHeight / 2, ms: 0 }
      const ms = glideMs(x - from.x, y - from.y)
      if (!pos()) setPos(from)
      setVisible(true)
      // Next frame, so the transition starts from where it was.
      return new Promise<void>((resolve) => {
        const go = () => setPos({ x, y, ms })
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(go)
        else go()
        const timer = setTimeout(resolve, ms)
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
    },
  }

  return { pos, visible, setVisible, cursor }
}

export const GhostCursor: Component<{ pos: CursorState | null; visible: boolean }> = (props) => (
  <Show when={props.visible && props.pos}>
    {(p) => (
      <div
        data-testid="tour-ghost-cursor"
        aria-hidden="true"
        class="pointer-events-none fixed left-0 top-0 z-[60] text-text drop-shadow"
        style={{
          transform: `translate(${p().x}px, ${p().y}px)`,
          transition: `transform ${p().ms}ms cubic-bezier(0.3, 0.7, 0.4, 1)`,
        }}
      >
        <svg width="18" height="22" viewBox="0 0 18 22" role="presentation">
          <path
            d="M1 1 L1 17 L5.5 13 L8.5 20 L11 19 L8 12 L14 12 Z"
            fill="currentColor"
            stroke="white"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
        </svg>
      </div>
    )}
  </Show>
)
