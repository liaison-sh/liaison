// SPDX-License-Identifier: FSL-1.1-ALv2
// Browser tab title + favicon unread badge (Task 4, liaison-messaging-visibility).
//
// The shipped favicon is an SVG (`apps/web/index.html`: <link id="favicon"
// rel="icon" type="image/svg+xml" href="/favicon.svg">), not a raster image —
// so the badged variant is built as an inline SVG data URL (base glyph +
// overlaid danger-color circle), never a <canvas>. This sidesteps the
// per-browser SVG rasterization minefield AND jsdom's total absence of
// `getContext` (a canvas approach would be untestable here).

import { createEffect, createRoot } from "solid-js"
import { appBadgeCount } from "~/modules/notifications/app-badge-store"

// Mirrors apps/web/public/favicon.svg exactly (base glyph), with a danger-color
// notification dot added top-right. `--color-danger` (theme.css) is #e5484d in
// both themes' rounding; hardcoded here since an SVG data URL can't read CSS
// custom properties.
const BASE_FAVICON_PATH = "/favicon.svg"
const BADGED_FAVICON_HREF =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
      '<rect width="32" height="32" rx="7" fill="#1f2937"/>' +
      '<path d="M10 8 V20 H22" stroke="#f3f4f6" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' +
      '<circle cx="22" cy="20" r="2.5" fill="#f3f4f6"/>' +
      '<circle cx="25" cy="7" r="6" fill="#e5484d" stroke="#1f2937" stroke-width="1.5"/>' +
      "</svg>",
  )

let started = false
let baseTitle = ""
let disposeRoot: (() => void) | null = null

function getFaviconLink(): HTMLLinkElement | null {
  return document.getElementById("favicon") as HTMLLinkElement | null
}

function applyBadge(n: number): void {
  document.title = n > 0 ? `(${n > 99 ? "99+" : n}) ${baseTitle}` : baseTitle
  try {
    const link = getFaviconLink()
    if (link) link.href = n > 0 ? BADGED_FAVICON_HREF : BASE_FAVICON_PATH
  } catch {
    // Favicon swap failed (e.g. detached DOM in a test environment) — title
    // already updated above, so degrade to title-only rather than throwing.
  }
}

/**
 * Starts a root-level `createEffect` on `appBadgeCount()` (THE badge, rule 6:
 * the same number as the phone, the dock and Home) that mirrors the
 * count onto the document title and favicon on every change — automatic,
 * no manual refresh call needed from WS handlers. Idempotent — safe against
 * a double bootstrap call; captures the base title exactly once, at first
 * start, so repeated 0→N→0 transitions always restore the ORIGINAL title
 * (never a title that already had a stale "(N) " prefix baked into it).
 */
export function startTabBadge(): void {
  if (started) return
  started = true
  baseTitle = document.title
  disposeRoot = createRoot((dispose) => {
    createEffect(() => {
      applyBadge(appBadgeCount())
    })
    return dispose
  })
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const TabBadgeTestAccess = {
  /** Restore module state between test cases. */
  reset(): void {
    started = false
    baseTitle = ""
    disposeRoot?.()
    disposeRoot = null
  },
}
