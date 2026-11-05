// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tap and a long press, for a finger only.
//
// A touch screen has no hover, so an action a mouse reaches by hovering a
// message (the toolbar, the "who reacted" hint) has to be reachable by a
// finger instead: a tap or a hold on the element. A mouse, a pen and a
// keyboard keep their hover, their clicks and their own right click: nothing
// here arms for them, and their clicks pass through untouched.
//
// WHAT COUNTS AS A TAP. The finger went down and came up within LONG_PRESS_MS
// (500 ms, past which it is the long press) and never moved more than
// LONG_PRESS_MOVE_PX (8 px, the slop a resting finger drifts; past it the
// gesture is a scroll, a drag or a swipe). A scroll also takes the pointer
// away from the page (pointercancel), which ends any tap. The tap acts on the
// click the browser sends after the finger lifts, never on the lift itself, so
// the browser's own tap detection (no click after a scroll) still applies.
//
// ONE TOUCH, ONE ACTION. A touch sequence (pointerdown to pointerup) is
// allowed exactly one click. The first one is the tap; any further click
// before the next pointerdown is a duplicate and is swallowed in the capture
// phase, so no handler under the element runs twice for one finger. The click
// that follows a fired long press is swallowed the same way: lifting the
// finger after the press is not also a tap. The native long-press menu
// (Android's context menu) is suppressed for the same reason.
import { onCleanup } from "solid-js"
import { createLongPressTracker, LONG_PRESS_MOVE_PX } from "~/ui/SwipeRow"

export interface TouchPressOptions {
  /** A finger held on the element. */
  onLongPress?: () => void
  /** A finger tapped the element. Without it a touch click passes through to
   *  the element's own click handler (once). */
  onTap?: () => void
  /** Return true for a target inside the element that has a gesture of its
   *  own (a reaction chip, a link, a field being edited): a press there never
   *  arms the long press, and a tap there keeps its own click. */
  ignore?: (target: Element) => boolean
  /** Like `ignore`, for the tap only: a link keeps its tap but a hold on it
   *  is still the element's long press. */
  ignoreTap?: (target: Element) => boolean
}

type TouchClick = "none" | "pending" | "consumed"

/**
 * Returns a `ref` callback: every listener goes on the element itself, the
 * click guard in the capture phase so it runs before any child's handler.
 */
export function createTouchPress(options: TouchPressOptions): (el: HTMLElement) => void {
  let touching = false
  let fired = false
  let moved = false
  let cancelled = false
  let originX = 0
  let originY = 0
  let startTarget: Element | null = null
  // The click the current touch sequence is owed: none (not a touch), one
  // still to come, or already spent.
  let touchClick: TouchClick = "none"
  const tracker = createLongPressTracker(() => {
    fired = true
    options.onLongPress?.()
  })
  onCleanup(() => tracker.cancel())

  const ignored = (target: EventTarget | null) =>
    target instanceof Element && !!options.ignore?.(target)
  const keepsItsTap = (target: EventTarget | null) =>
    ignored(target) || (target instanceof Element && !!options.ignoreTap?.(target))

  const onPointerDown = (e: PointerEvent) => {
    touching = e.pointerType === "touch"
    fired = false
    moved = false
    cancelled = false
    originX = e.clientX
    originY = e.clientY
    startTarget = e.target instanceof Element ? e.target : null
    touchClick = touching ? "pending" : "none"
    if (!touching || !options.onLongPress || ignored(e.target)) return
    tracker.start(e.clientX, e.clientY)
  }
  const onPointerMove = (e: PointerEvent) => {
    if (!touching) return
    tracker.move(e.clientX, e.clientY)
    if (
      Math.abs(e.clientX - originX) > LONG_PRESS_MOVE_PX ||
      Math.abs(e.clientY - originY) > LONG_PRESS_MOVE_PX
    ) {
      moved = true
    }
  }
  const onPointerUp = () => tracker.cancel()
  const onPointerCancel = () => {
    cancelled = true
    tracker.cancel()
  }
  // A key pressed after a tap starts a keyboard gesture: its click is its own.
  const onKeyDown = () => {
    touchClick = "none"
  }
  const onContextMenu = (e: MouseEvent) => {
    if (touching) e.preventDefault()
  }
  const swallow = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const onClick = (e: MouseEvent) => {
    // A mouse, a pen or a keyboard: not ours.
    if (touchClick === "none") return
    if (touchClick === "consumed") {
      swallow(e)
      return
    }
    touchClick = "consumed"
    if (fired) {
      swallow(e)
      return
    }
    if (!options.onTap) return
    // A tap on something with its own action (a link, a mention, a button,
    // a chip) keeps that action.
    if (keepsItsTap(e.target) || keepsItsTap(startTarget)) return
    swallow(e)
    if (!moved && !cancelled) options.onTap()
  }

  return (el) => {
    el.addEventListener("pointerdown", onPointerDown)
    el.addEventListener("pointermove", onPointerMove)
    el.addEventListener("pointerup", onPointerUp)
    el.addEventListener("pointercancel", onPointerCancel)
    el.addEventListener("contextmenu", onContextMenu)
    el.addEventListener("keydown", onKeyDown, true)
    el.addEventListener("click", onClick, true)
    onCleanup(() => {
      el.removeEventListener("pointerdown", onPointerDown)
      el.removeEventListener("pointermove", onPointerMove)
      el.removeEventListener("pointerup", onPointerUp)
      el.removeEventListener("pointercancel", onPointerCancel)
      el.removeEventListener("contextmenu", onContextMenu)
      el.removeEventListener("keydown", onKeyDown, true)
      el.removeEventListener("click", onClick, true)
    })
  }
}
