// SPDX-License-Identifier: FSL-1.1-ALv2
import { vi } from "vitest"
import { DESKTOP_QUERY, PHONE_QUERY, syncShellTier, TABLET_QUERY } from "~/modules/shell/shell-tier"

/**
 * Puts the shell on the phone, tablet or desktop tier: stubs `matchMedia` so only that
 * tier's media query matches, then re-reads the tier.
 */
export function setShellTier(tier: "phone" | "tablet" | "desktop"): void {
  const answer = tier === "phone" ? PHONE_QUERY : tier === "tablet" ? TABLET_QUERY : DESKTOP_QUERY
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === answer,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  syncShellTier()
}
