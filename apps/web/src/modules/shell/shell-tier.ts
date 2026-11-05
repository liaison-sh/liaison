// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell's layout tier, owned here rather than by Shell.tsx. Desktop keeps
// the multi-column grid; tablet keeps the sidebar beside the content (rail or
// overlay drawer, never stacked above it); phone is a single pane with a
// bottom tab bar.
//
// It lives in its own module because more than one place needs it: Shell.tsx
// lays out the grid from it, and the chat dock (`dock-store`) is a desktop
// affordance that has to read the SAME breakpoints. While the signal was
// component-local, dock-store re-derived the tier from copies of these three
// queries and the two could drift apart.
import { createSignal } from "solid-js"

export type ShellTier = "desktop" | "tablet" | "phone"

// The activity rail's width. Shell's grid lays its first track out at this
// width and the tablet sidebar drawer offsets itself by the same value, so the
// drawer starts exactly where the rail ends and the two cannot drift apart.
export const ACTIVITY_RAIL_WIDTH = "48px"

// The tablet drawer is a PANEL beside the rail, not a second full screen: it
// deliberately stops short of the right edge so the content it covers stays
// visible under the scrim and the scrim itself is tappable to dismiss. At the
// narrowest tablet (640px) that still leaves ~270px of tappable scrim.
export const TABLET_DRAWER_WIDTH = "min(320px, 100%)"

export const DESKTOP_QUERY = "(min-width: 1024px)"
export const TABLET_QUERY = "(min-width: 640px) and (max-width: 1023px)"
export const PHONE_QUERY = "(max-width: 639px)"

export const SHELL_TIER_QUERIES = [DESKTOP_QUERY, TABLET_QUERY, PHONE_QUERY]

// Defaults to desktop wherever `matchMedia` is unavailable (SSR, plain jsdom),
// the same fallback the single compact query used.
export function resolveShellTier(): ShellTier {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "desktop"
  if (window.matchMedia(PHONE_QUERY).matches) return "phone"
  if (window.matchMedia(TABLET_QUERY).matches) return "tablet"
  return "desktop"
}

const [shellTier, setShellTier] = createSignal<ShellTier>(resolveShellTier())

export { shellTier }

/** Re-reads the media queries and publishes the tier. */
export function syncShellTier(): void {
  setShellTier(resolveShellTier())
}

// Module scope, once: the tier is a property of the viewport, not of any one
// mounted component, and every reader shares this signal.
if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
  for (const query of SHELL_TIER_QUERIES) {
    try {
      window.matchMedia(query).addEventListener("change", syncShellTier)
    } catch {
      /* matchMedia mocks in some test environments do not implement addEventListener */
    }
  }
}
