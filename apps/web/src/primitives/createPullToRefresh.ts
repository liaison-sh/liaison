// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pull down at the top of a list to reload it.
//
// TOUCH ONLY, AND ONLY AT THE TOP. A pull that starts anywhere but the very
// top of the scroller is the user scrolling, and stealing it would make the
// list impossible to scroll back up. So the gesture arms on `touchstart`
// against the scroll position at that moment and disarms the instant the
// finger moves up rather than down.
//
// The scroll position is read from the ELEMENT THE TOUCH LANDED ON, walked up
// to its first scrollable ancestor, not from a container the caller names. The
// two screens this drives scroll in different places: Work scrolls in its own
// root, Chats scrolls inside a list component it renders. A primitive that
// demanded one ref would work on one of them and silently never arm on the
// other.
//
// IT RESISTS. Raw finger travel makes a 64px threshold trivial to trip while
// flicking a list, so the indicator follows at half speed and stops moving
// well before the finger does: crossing the threshold has to be deliberate.
import { type Accessor, createSignal } from "solid-js"

/** How far the INDICATOR must travel before releasing refreshes. */
export const PULL_THRESHOLD_PX = 64
/** How far it can travel at all, so a long drag does not push the list away. */
export const PULL_MAX_PX = 96
/** Finger travel to indicator travel. Below 1, so the threshold means something. */
export const PULL_RESISTANCE = 0.5

/** How far the indicator is drawn for a given finger travel, in pixels. */
export function pullDistance(fingerDy: number): number {
  if (fingerDy <= 0) return 0
  return Math.min(fingerDy * PULL_RESISTANCE, PULL_MAX_PX)
}

/** Whether releasing at this distance refreshes. */
export function pullArmed(distance: number): boolean {
  return distance >= PULL_THRESHOLD_PX
}

/**
 * The scroll offset of the first scrollable ancestor of `target`, or 0 when
 * there is none (a short list that does not scroll is at its top by
 * definition, so the gesture is available there).
 */
export function scrollTopFor(target: EventTarget | null): number {
  let node = target instanceof Element ? target : null
  while (node !== null) {
    if (node.scrollHeight > node.clientHeight) return node.scrollTop
    node = node.parentElement
  }
  return 0
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

export interface PullToRefreshOptions {
  /** Runs when the gesture is released past the threshold. */
  onRefresh: () => void | Promise<unknown>
  /** Injected for tests; defaults to walking up from the touch target. */
  scrollTop?: (target: EventTarget | null) => number
  /** Injected for tests; defaults to the media query. */
  reducedMotion?: () => boolean
}

export interface PullToRefreshHandlers {
  onTouchStart: (event: TouchEvent) => void
  onTouchMove: (event: TouchEvent) => void
  onTouchEnd: () => void
  onTouchCancel: () => void
}

export interface PullToRefresh {
  handlers: PullToRefreshHandlers
  /** How far the indicator is drawn, in pixels. Zero when idle. */
  distance: Accessor<number>
  /** Whether releasing now would refresh. */
  armed: Accessor<boolean>
  /** Whether a refresh is in flight. */
  refreshing: Accessor<boolean>
  /** Whether the indicator should animate back. False under reduced motion. */
  animated: Accessor<boolean>
}

function firstTouchY(event: TouchEvent): number | null {
  const touch = event.touches?.[0]
  return touch ? touch.clientY : null
}

export function createPullToRefresh(options: PullToRefreshOptions): PullToRefresh {
  const readScrollTop = options.scrollTop ?? scrollTopFor
  const reduced = options.reducedMotion ?? prefersReducedMotion
  const [distance, setDistance] = createSignal(0)
  const [refreshing, setRefreshing] = createSignal(false)
  let startY: number | null = null

  function reset(): void {
    startY = null
    setDistance(0)
  }

  return {
    distance,
    refreshing,
    armed: () => pullArmed(distance()),
    animated: () => !reduced(),
    handlers: {
      onTouchStart(event: TouchEvent): void {
        // A second gesture during a refresh would queue a second load over
        // the one already running.
        if (refreshing()) return
        const y = firstTouchY(event)
        // Armed against the scroll position AT TOUCH DOWN. Checking it later
        // would arm halfway through a flick that happened to reach the top.
        if (y === null || readScrollTop(event.target) > 0) return
        startY = y
      },
      onTouchMove(event: TouchEvent): void {
        if (startY === null) return
        const y = firstTouchY(event)
        if (y === null) return
        const dy = y - startY
        if (dy <= 0) {
          // Upward: this was a scroll all along. Hand it back for good, so a
          // gesture that wanders down again does not snatch it back.
          reset()
          return
        }
        setDistance(pullDistance(dy))
      },
      onTouchEnd(): void {
        const shouldRefresh = startY !== null && pullArmed(distance())
        reset()
        if (!shouldRefresh) return
        setRefreshing(true)
        void Promise.resolve()
          .then(() => options.onRefresh())
          .catch(() => {
            // The screen shows its own load failure. The spinner's job is only
            // to stop.
          })
          .finally(() => setRefreshing(false))
      },
      onTouchCancel(): void {
        reset()
      },
    },
  }
}
