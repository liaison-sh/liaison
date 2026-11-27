// SPDX-License-Identifier: FSL-1.1-ALv2
//
// iOS Dynamic Type in the iPhone and iPad app. A web view does not follow the
// system text size by itself: the page's sizes are fixed (13.5 px body), so the
// larger sizes in Settings > Accessibility changed nothing. WebKit exposes the
// reader's body size as the `-apple-system-body` font (17 px at the default
// size, from about 14 px to 23 px over the standard sizes, more with the
// accessibility sizes); its ratio to 17 px becomes the page's text zoom
// (`-webkit-text-size-adjust` on the body, the same zoom the system's own text
// zoom uses), so every text on the page scales while the layout boxes keep
// their size. The zoom is capped at the largest standard size (23/17): beyond
// it the phone layouts' one-line rows (tab bar, headers, chips) no longer fit.
// Read again whenever the app comes back to the front, since the size may
// have changed in Settings meanwhile. No-op outside the iOS app.
import { nativeShellPlatform } from "~/lib/native-bridge"

/** The body size at the default Dynamic Type setting ("Large"). */
export const DYNAMIC_TYPE_DEFAULT_PX = 17
/** The smallest and largest zoom applied: the standard sizes, xSmall to xxxLarge. */
export const DYNAMIC_TYPE_MIN_ZOOM = 14 / 17
export const DYNAMIC_TYPE_MAX_ZOOM = 23 / 17

/** The text zoom, as a percentage, for the reader's `-apple-system-body` size in px. */
export function dynamicTypeZoomPercent(bodyPx: number): number {
  if (!Number.isFinite(bodyPx) || bodyPx <= 0) return 100
  const zoom = Math.min(
    DYNAMIC_TYPE_MAX_ZOOM,
    Math.max(DYNAMIC_TYPE_MIN_ZOOM, bodyPx / DYNAMIC_TYPE_DEFAULT_PX),
  )
  return Math.round(zoom * 100)
}

/** The reader's system body size in px, measured on a hidden probe, or null when unknown. */
function systemBodyPx(doc: Document): number | null {
  const probe = doc.createElement("span")
  probe.setAttribute("aria-hidden", "true")
  probe.style.cssText =
    "position:absolute;visibility:hidden;pointer-events:none;font:-apple-system-body;"
  probe.textContent = "x"
  doc.body.appendChild(probe)
  const size = Number.parseFloat(getComputedStyle(probe).fontSize)
  probe.remove()
  // A browser without the system font keeps the inherited size: not a reading.
  return Number.isFinite(size) && size > 0 && probe.style.font !== "" ? size : null
}

/** Applies the reader's text size to the page once. */
export function applyDynamicType(doc: Document = document): void {
  const px = systemBodyPx(doc)
  if (px === null) return
  const percent = `${dynamicTypeZoomPercent(px)}%`
  doc.body.style.setProperty("-webkit-text-size-adjust", percent)
  doc.body.style.setProperty("text-size-adjust", percent)
}

let started = false

/** In the iOS app: follow Dynamic Type now and each time the app comes back. */
export function startDynamicType(): void {
  if (started || typeof document === "undefined" || nativeShellPlatform() !== "ios") return
  started = true
  applyDynamicType()
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") applyDynamicType()
  })
}
