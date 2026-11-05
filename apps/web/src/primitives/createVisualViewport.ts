// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The VISUAL viewport as signals (M1-B T6).
//
// On a phone the layout viewport (`100vh`, `window.innerHeight`) does not
// shrink when the software keyboard opens: it keeps its full height and the
// keyboard is drawn over the bottom of it. A thread laid out at `100vh`
// therefore puts its composer UNDER the keyboard. `window.visualViewport` is
// the part actually on screen, so the thread's height comes from here instead.
//
// Every reader shares one contract: `height` is what is visible, `offsetTop`
// how far the visual viewport has been pushed or scrolled down inside the
// layout viewport, and `keyboardInset` how many pixels at the bottom are
// covered. Absent `visualViewport` (jsdom, old WebViews) the signals fall back
// to the layout viewport and a zero inset, which is exactly the pre keyboard
// behaviour.
//
// INSIDE THE NATIVE APP the visual viewport never moves: the keyboard plugin
// takes the keyboard notifications away from WKWebView. The shell reports the
// keyboard's height instead (primitives/keyboardInset.ts) and it is folded in
// here, so a reader gets the same answer on both: a visible height that stops
// at the top of the keyboard. Only one of the two is ever non-zero, since the
// browser has no shell and the app's visual viewport has no keyboard.
import { type Accessor, createSignal, onCleanup } from "solid-js"
import { keyboardInset as nativeKeyboardInset } from "~/primitives/keyboardInset"

export interface VisualViewportSignals {
  height: Accessor<number>
  offsetTop: Accessor<number>
  keyboardInset: Accessor<number>
}

function layoutHeight(): number {
  if (typeof window === "undefined") return 0
  return window.innerHeight ?? 0
}

function readHeight(): number {
  if (typeof window === "undefined") return 0
  return window.visualViewport?.height ?? layoutHeight()
}

function readOffsetTop(): number {
  if (typeof window === "undefined") return 0
  return window.visualViewport?.offsetTop ?? 0
}

function readKeyboardInset(): number {
  if (typeof window === "undefined") return 0
  const vv = window.visualViewport
  if (!vv) return 0
  return Math.max(0, layoutHeight() - vv.height - vv.offsetTop)
}

/**
 * Reactive `visualViewport` height and offset. Call inside a reactive root:
 * the listeners are dropped through `onCleanup` with the owner.
 */
export function createVisualViewport(): VisualViewportSignals {
  const [height, setHeight] = createSignal(readHeight())
  const [offsetTop, setOffsetTop] = createSignal(readOffsetTop())
  const [keyboardInset, setKeyboardInset] = createSignal(readKeyboardInset())

  const sync = (): void => {
    setHeight(readHeight())
    setOffsetTop(readOffsetTop())
    setKeyboardInset(readKeyboardInset())
  }

  if (typeof window !== "undefined") {
    const vv = window.visualViewport
    if (vv && typeof vv.addEventListener === "function") {
      // `scroll` matters as much as `resize`: iOS pans the visual viewport
      // rather than resizing it when a field near the bottom takes focus.
      vv.addEventListener("resize", sync)
      vv.addEventListener("scroll", sync)
      onCleanup(() => {
        vv.removeEventListener("resize", sync)
        vv.removeEventListener("scroll", sync)
      })
    } else if (typeof window.addEventListener === "function") {
      window.addEventListener("resize", sync)
      onCleanup(() => window.removeEventListener("resize", sync))
    }
  }

  return {
    height: () => Math.max(0, height() - nativeKeyboardInset()),
    offsetTop,
    keyboardInset: () => Math.max(keyboardInset(), nativeKeyboardInset()),
  }
}
