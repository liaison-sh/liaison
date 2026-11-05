// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A touch row that reveals actions when it is swiped left, and a long press on
// the same row (M1-B T8).
//
// Pointer events only, no library: once the gesture is a horizontal swipe the
// row captures the pointer, so the drag keeps arriving even after the finger
// has left the row's box, and the same handler covers touch, pen and a
// trackpad drag. The capture is deliberately NOT taken on pointerdown: a
// captured pointer retargets the following click to the capture element, so a
// plain tap on a row never reaches the button inside it and the row does not
// open. `ui/` owns no strings: every label and every action comes from the
// caller.
//
// The GEOMETRY is exported as pure functions because that is the part worth
// pinning: a threshold read off a rendered row is a screenshot, not a test.
import type { Component, JSX } from "solid-js"
import { createSignal, For, onCleanup } from "solid-js"
import { cn } from "~/lib/cn"
import { nativeHaptic } from "~/lib/native-bridge"

/** Past this much drag the row stays open when the finger lifts. */
export const SWIPE_COMMIT_PX = 60
/** How far open the row snaps: wide enough for two 74px action buttons. */
export const SWIPE_OPEN_PX = 148
/** A drag past this fraction of the row's width runs the FIRST action. */
export const SWIPE_FULL_FRACTION = 0.6
/** How long a finger must rest before the row treats it as a long press. */
export const LONG_PRESS_MS = 500
/** Past this much movement the press is a scroll or a swipe, never a press. */
export const LONG_PRESS_MOVE_PX = 8

export type SwipeOutcome = "closed" | "open" | "commit"

/**
 * What a released swipe means. `dx` is the horizontal travel (negative is a
 * leftward drag, which is the only direction that reveals anything) and
 * `width` the row's own width.
 */
export function resolveSwipe(dx: number, width: number): SwipeOutcome {
  // A rightward drag closes: there is nothing on the left to reveal.
  if (dx >= 0) return "closed"
  const travel = -dx
  if (width > 0 && travel >= width * SWIPE_FULL_FRACTION) return "commit"
  if (travel >= SWIPE_COMMIT_PX) return "open"
  return "closed"
}

/** How far the row is actually drawn for a given live drag: it follows the
 *  finger, but never further than a full swipe across its own width. */
export function swipeOffset(dx: number, width: number): number {
  if (dx >= 0) return 0
  return Math.min(-dx, width > 0 ? width : SWIPE_OPEN_PX)
}

/**
 * True when a drag moving from `before` to `after` revealed pixels has just
 * passed the point where releasing would leave the row OPEN. It is the detent
 * the selection haptic marks, so the finger learns where the threshold is
 * without the user watching the row.
 *
 * Written as a crossing rather than a comparison on purpose: a test on `after`
 * alone fires on every pointer move past the threshold, which on a slow drag
 * is a continuous buzz instead of a tick.
 */
export function crossedOpenDetent(before: number, after: number): boolean {
  return before < SWIPE_COMMIT_PX && after >= SWIPE_COMMIT_PX
}

export interface LongPressTracker {
  start: (x: number, y: number) => void
  move: (x: number, y: number) => void
  cancel: () => void
}

/**
 * The long-press timer, separated from the DOM so its timing is testable with
 * fake timers. `onFire` runs once, `LONG_PRESS_MS` after `start`, unless the
 * pointer has moved more than `LONG_PRESS_MOVE_PX` in any direction or
 * `cancel` has been called.
 */
export function createLongPressTracker(onFire: () => void): LongPressTracker {
  let timer: ReturnType<typeof setTimeout> | undefined
  let originX = 0
  let originY = 0

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }

  return {
    start(x, y) {
      cancel()
      originX = x
      originY = y
      timer = setTimeout(() => {
        timer = undefined
        onFire()
      }, LONG_PRESS_MS)
    },
    move(x, y) {
      if (timer === undefined) return
      if (
        Math.abs(x - originX) > LONG_PRESS_MOVE_PX ||
        Math.abs(y - originY) > LONG_PRESS_MOVE_PX
      ) {
        cancel()
      }
    },
    cancel,
  }
}

export interface SwipeAction {
  label: string
  icon?: JSX.Element
  tone?: "default" | "accent" | "danger"
  onSelect: () => void
}

export interface SwipeRowProps {
  actions: SwipeAction[]
  /** Fired after `LONG_PRESS_MS` with the finger still on the row. */
  onLongPress?: () => void
  /** Test hook for the row's action rail. */
  testid?: string
  class?: string
  /**
   * Extra classes for the card itself, on top of `class`: the row's own
   * padding and surface.
   *
   * `class` and `contentClass` both land on the ONE translated element, so a
   * caller's frame and its padding can never end up on two different boxes.
   */
  contentClass?: string
  children: JSX.Element
}

/**
 * The corner radius the revealed rail is clipped to.
 *
 * The rail sits BEHIND the card, reaching the card's right edge, so its outer
 * corners must be the card's own or a danger action paints right angles where
 * the card is round. The radius is read off the caller's class rather than
 * duplicated, so a row that is not a card cannot drift from its rail.
 */
export function railRadiusClass(cardClass?: string): string {
  const tokens = (cardClass ?? "").split(/\s+/).filter((t) => /^rounded(-|$)/.test(t))
  return tokens.length > 0 ? tokens.join(" ") : "rounded-lg"
}

/** Pale tints with coloured text, the same treatment `Button`'s `primary`
 *  variant uses. Solid slate and solid red read as two alert panels shoved
 *  under a quiet card; the tint keeps the weight on the row. */
const TONE_CLASS: Record<NonNullable<SwipeAction["tone"]>, string> = {
  default: "bg-surface-active text-text-secondary",
  accent: "bg-accent-wash text-accent",
  danger: "bg-error-glow text-error",
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

export const SwipeRow: Component<SwipeRowProps> = (props) => {
  const [offset, setOffset] = createSignal(0)
  const [dragging, setDragging] = createSignal(false)
  let rowRef: HTMLDivElement | undefined
  let startX = 0
  let startY = 0
  let active = false
  let horizontal = false
  // How far open the rail already was when this gesture began, so a second
  // drag continues from there rather than jumping back to zero.
  let startOffset = 0
  // The element holding the pointer capture, and which pointer, so the
  // capture is always released exactly once on up or cancel.
  let capturedEl: HTMLElement | undefined
  let capturedId = 0

  function releaseCapture() {
    if (!capturedEl) return
    try {
      capturedEl.releasePointerCapture?.(capturedId)
    } catch {
      // The pointer is already gone: nothing left to release.
    }
    capturedEl = undefined
  }
  onCleanup(releaseCapture)

  const longPress = createLongPressTracker(() => {
    // A long press and a swipe are exclusive: the row snaps shut so the sheet
    // is not drawn over a half open rail.
    active = false
    setDragging(false)
    setOffset(0)
    props.onLongPress?.()
  })
  onCleanup(() => longPress.cancel())

  const width = () => rowRef?.offsetWidth ?? 0

  function onPointerDown(e: PointerEvent) {
    if (e.button !== undefined && e.button !== 0) return
    active = true
    horizontal = false
    startX = e.clientX
    startY = e.clientY
    startOffset = offset()
    if (props.onLongPress) longPress.start(e.clientX, e.clientY)
  }

  function onPointerMove(e: PointerEvent) {
    if (!active) return
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    longPress.move(e.clientX, e.clientY)
    if (!horizontal) {
      // A vertical intent is the page scrolling: hand the gesture back.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > LONG_PRESS_MOVE_PX) {
        active = false
        longPress.cancel()
        return
      }
      if (Math.abs(dx) <= LONG_PRESS_MOVE_PX) return
      horizontal = true
      setDragging(true)
      // Only now, with a swipe proven, is it safe to take the pointer: the
      // gesture is no longer going to end as a click on the row's content.
      const el = e.currentTarget as HTMLElement | null
      if (el?.setPointerCapture) {
        try {
          el.setPointerCapture(e.pointerId)
          capturedEl = el
          capturedId = e.pointerId
        } catch {
          // A pointer that has already been released cannot be captured.
        }
      }
    }
    const before = offset()
    const after = swipeOffset(dx - startOffset, width())
    setOffset(after)
    // The detent tick, on the crossing alone. No-op off a native shell.
    if (crossedOpenDetent(before, after)) nativeHaptic("selection")
  }

  function onPointerUp() {
    releaseCapture()
    if (!active) {
      longPress.cancel()
      return
    }
    active = false
    longPress.cancel()
    setDragging(false)
    if (!horizontal) return
    // The revealed distance IS the gesture: a drag that started from an
    // already open row is judged on where it ended, not on how far it moved.
    const outcome = resolveSwipe(-offset(), width())
    if (outcome === "commit") {
      setOffset(0)
      // A full swipe runs an action without the user ever seeing the rail, so
      // the only confirmation the gesture gets is this one.
      nativeHaptic("light")
      props.actions[0]?.onSelect()
      return
    }
    setOffset(outcome === "open" ? SWIPE_OPEN_PX : 0)
  }

  function runAction(action: SwipeAction) {
    setOffset(0)
    action.onSelect()
  }

  return (
    <div
      ref={rowRef}
      data-testid={props.testid ?? "swipe-row"}
      data-swipe-open={offset() > 0 ? "true" : "false"}
      // Nothing but a positioning context for the rail. It is deliberately NOT
      // `overflow-hidden` and carries NO frame: a fixed frame with the content
      // sliding under it cut the card's title mid-word and left a status pill
      // as a sliver. The iOS Mail model instead moves the whole card, border
      // and radius included, and uncovers the rail behind it.
      class="relative"
    >
      {/* The rail is REVEALED from behind the card, inside the list gutter,
          and never moves on its own. Out of flow, so uncovering it cannot
          reflow the card; clipped to the card's radius on its outer corners. */}
      <div
        class={cn(
          "absolute inset-y-0 right-0 flex overflow-hidden",
          railRadiusClass(props.class),
          // The rail's left edge is where the card meets it: square, so the
          // open row reads as one strip (card, then actions) and not as two
          // rounded tiles pushed together.
          "rounded-l-none",
        )}
        data-testid="swipe-row-actions"
      >
        <For each={props.actions}>
          {(action) => (
            <button
              type="button"
              data-testid={`swipe-action-${action.label.toLowerCase().replace(/\s+/g, "-")}`}
              aria-label={action.label}
              onClick={() => runAction(action)}
              class={cn(
                "flex h-full w-[74px] flex-col items-center justify-center gap-1 text-[12px] font-medium",
                TONE_CLASS[action.tone ?? "default"],
              )}
            >
              {action.icon}
              {action.label}
            </button>
          )}
        </For>
      </div>
      {/* ONE element carries the whole card, frame included, so the children
          never re-lay out and nothing inside them is ever clipped. */}
      <div
        data-testid="swipe-row-content"
        class={cn(
          "relative rounded-lg bg-bg",
          props.class,
          props.contentClass,
          !dragging() && !prefersReducedMotion() && "transition-transform duration-150",
          // While the rail shows, the card's right corners are the seam with
          // the rail, not the row's outer edge: square them for the same reason.
          offset() > 0 && "rounded-r-none",
        )}
        style={{ transform: `translateX(-${offset()}px)`, "touch-action": "pan-y" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {props.children}
      </div>
    </div>
  )
}
