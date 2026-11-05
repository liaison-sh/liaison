// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sign-in opens the provider in another tab and finishes on the server's own
// page there, so this page gets no event when it completes. What it does get
// is the person coming back: the window regains focus, or the tab becomes
// visible again. Lists and the add flow re-read the connection then, so a
// finished sign-in shows without a reload.
import { onCleanup } from "solid-js"

/** Focus and visibility often fire together on one return; one call covers both. */
const SETTLE_MS = 400

/**
 * Calls `fn` each time the person returns to this page (window focus, or the
 * document becoming visible), at most once per return. Removed with the owner.
 */
export function onReturnToPage(fn: () => void): void {
  if (typeof window === "undefined") return
  let last = 0
  const fire = () => {
    const now = Date.now()
    if (now - last < SETTLE_MS) return
    last = now
    fn()
  }
  const onVisibility = () => {
    if (document.visibilityState === "visible") fire()
  }
  window.addEventListener("focus", fire)
  document.addEventListener("visibilitychange", onVisibility)
  onCleanup(() => {
    window.removeEventListener("focus", fire)
    document.removeEventListener("visibilitychange", onVisibility)
  })
}
