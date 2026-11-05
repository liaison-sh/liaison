// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Resolves the user's effective theme from a stored preference and a system
 * pref. Keep mirror-in-sync with the inline pre-paint script in index.html.
 *
 * - "light" / "dark" stored → that value wins
 * - "system" or any other value (null, garbage) → fall back to system pref
 */
export function resolveTheme(stored: string | null, prefersDark: boolean): "light" | "dark" {
  if (stored === "light" || stored === "dark") return stored
  return prefersDark ? "dark" : "light"
}
