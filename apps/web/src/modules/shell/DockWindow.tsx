// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The floating window above the dock bar: an open conversation, or the Chats
// roster. It is rendered INSIDE the bar item it belongs to (so the item's
// `data-dock-tab` still contains the conversation it opens) and positioned
// above the bar, right aligned with that item.
//
// A person's conversation and the roster are 360 x 460; an agent conversation
// is sized from the main panel (dock-store.ts DOCK_AGENT_WINDOW).
//
// Right alignment is the rule; the dock's left edge is the limit. An item far
// enough to the left (a narrow main panel, a long bar) would push the
// window past the panel's left edge and under the sidebar, so the window then
// slides right just enough to stay inside the dock.
import { createEffect, createSignal, type JSX, onCleanup, onMount } from "solid-js"
import {
  DOCK_GAP,
  DOCK_TAB_WIDTH,
  DOCK_WINDOW_CLASS,
  DOCK_WINDOW_GAP,
  dockWindowSize,
  registerDockWindowHeight,
} from "./dock-store"

interface DockWindowProps {
  children: JSX.Element
  "data-testid"?: string
  /** "agent" for a conversation with an agent: the larger window. */
  kind?: "person" | "agent"
}

/** How far right the window must slide to stay inside the dock, in px: 0 when
 *  right alignment already fits. `anchorRight` and `dockLeft` are viewport x. */
export function dockWindowShift(
  anchorRight: number,
  dockLeft: number,
  width: number = DOCK_TAB_WIDTH,
): number {
  const overshoot = dockLeft + DOCK_GAP - (anchorRight - width)
  return overshoot > 0 ? overshoot : 0
}

export function DockWindow(props: DockWindowProps): JSX.Element {
  let ref: HTMLDivElement | undefined
  const [shift, setShift] = createSignal(0)
  const size = () => dockWindowSize(props.kind ?? "person")
  const key = Symbol("dock-window")
  createEffect(() => {
    const unregister = registerDockWindowHeight(key, size().height)
    onCleanup(unregister)
  })

  function measure() {
    const anchor = ref?.parentElement
    const dock = ref?.closest("[data-chat-dock]")
    if (!anchor || !dock) return
    const dockRect = dock.getBoundingClientRect()
    // A layoutless environment (jsdom) measures nothing: keep right aligned.
    if (dockRect.width === 0) return
    setShift(dockWindowShift(anchor.getBoundingClientRect().right, dockRect.left, size().width))
  }
  // A resize of the agent window (the panel grew or shrank) re-runs the fit.
  createEffect(() => {
    size()
    measure()
  })

  onMount(() => {
    measure()
    if (typeof ResizeObserver === "undefined") return
    // The item moves when anything to its right changes width (the bar grows
    // or shrinks) or when the panel itself resizes: watch both.
    const ro = new ResizeObserver(() => measure())
    const bar = ref?.closest("[data-dock-bar]")
    const dock = ref?.closest("[data-chat-dock]")
    if (bar) ro.observe(bar)
    if (dock) ro.observe(dock)
    onCleanup(() => ro.disconnect())
  })

  return (
    <div
      ref={ref}
      data-testid={props["data-testid"]}
      data-dock-window
      class={`absolute ${DOCK_WINDOW_CLASS}`}
      style={{
        // Above the bar: the item's own box, plus the bar's 1px top border,
        // plus the gap.
        bottom: `calc(100% + ${1 + DOCK_WINDOW_GAP}px)`,
        // -1: the window's border lands on the item's divider (or the bar's own
        // right border), not a pixel inside it.
        right: `${-1 - shift()}px`,
        width: `${size().width}px`,
        height: `${size().height}px`,
        "pointer-events": "auto",
      }}
    >
      {props.children}
    </div>
  )
}
