// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The iOS back swipe, inside the native app.
//
// A drag from the left edge of the screen goes back, as everywhere else on
// iOS. WKWebView's own gesture (`allowsBackForwardNavigationGestures`) walks
// the browser history, which is not what Back means in this app: a detail
// opened from a push tap has nothing of ours behind it, and Back goes UP to
// its parent screen (primitives/createPushNav.ts). So the swipe does not
// navigate at all. It presses the back control that is on screen, whichever
// one that is (the shell's, a thread's, a ticket's, a settings section's):
// every one of them carries `data-phone-back`, and the swipe and the tap then
// cannot disagree about where Back goes.
//
// Only in the native shell: a mobile browser has its own edge gesture, and
// two backs for one swipe would skip a screen.

/** The attribute every phone back control carries. */
export const PHONE_BACK_ATTRIBUTE = "data-phone-back"

/** How far from the left edge a swipe must start, in CSS pixels. */
export const EDGE_SWIPE_START_PX = 24
/** How far right it must travel before it counts. */
export const EDGE_SWIPE_MIN_TRAVEL_PX = 64

function defaultIsVisible(el: HTMLElement): boolean {
  if (el.getClientRects().length === 0) return false
  if ((el as HTMLButtonElement).disabled) return false
  return el.closest("[inert], [aria-hidden='true']") === null
}

/**
 * The back control the user sees. When several are visible (the shell's bar
 * and a sub-screen's own back inside the page, or a sheet over the page), the
 * LAST in document order is the innermost level, the one a tap on screen
 * would most plausibly mean.
 */
export function findPhoneBackControl(
  root: ParentNode,
  isVisible: (el: HTMLElement) => boolean = defaultIsVisible,
): HTMLElement | null {
  const candidates = [...root.querySelectorAll<HTMLElement>(`[${PHONE_BACK_ATTRIBUTE}]`)]
  return candidates.filter(isVisible).at(-1) ?? null
}

export interface EdgeSwipeOptions {
  /** Tests: the visibility rule (jsdom lays nothing out). */
  isVisible?: (el: HTMLElement) => boolean
}

/**
 * Listens for left-edge swipes on `target` and presses the visible back
 * control at the end of one. Returns the unsubscribe.
 */
export function installEdgeSwipeBack(
  target: Document = document,
  options: EdgeSwipeOptions = {},
): () => void {
  let start: { x: number; y: number; id: number } | null = null

  const onStart = (event: TouchEvent): void => {
    start = null
    if (event.touches.length !== 1) return
    const touch = event.touches[0]
    if (touch.clientX > EDGE_SWIPE_START_PX) return
    start = { x: touch.clientX, y: touch.clientY, id: touch.identifier }
  }

  const onMove = (event: TouchEvent): void => {
    if (!start) return
    const touch = [...event.touches].find((t) => t.identifier === start?.id)
    if (!touch) return
    const dx = touch.clientX - start.x
    const dy = Math.abs(touch.clientY - start.y)
    // A scroll that began near the edge stays a scroll.
    if (dy > 24 && dy > Math.abs(dx)) start = null
  }

  const onEnd = (event: TouchEvent): void => {
    if (!start) return
    const began = start
    start = null
    const touch = [...event.changedTouches].find((t) => t.identifier === began.id)
    if (!touch) return
    const dx = touch.clientX - began.x
    const dy = Math.abs(touch.clientY - began.y)
    if (dx < EDGE_SWIPE_MIN_TRAVEL_PX || dy > dx) return
    findPhoneBackControl(target, options.isVisible)?.click()
  }

  const onCancel = (): void => {
    start = null
  }

  target.addEventListener("touchstart", onStart, { passive: true })
  target.addEventListener("touchmove", onMove, { passive: true })
  target.addEventListener("touchend", onEnd, { passive: true })
  target.addEventListener("touchcancel", onCancel, { passive: true })
  return () => {
    target.removeEventListener("touchstart", onStart)
    target.removeEventListener("touchmove", onMove)
    target.removeEventListener("touchend", onEnd)
    target.removeEventListener("touchcancel", onCancel)
  }
}
