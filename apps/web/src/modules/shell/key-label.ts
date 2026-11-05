// SPDX-License-Identifier: FSL-1.1-ALv2
import { tNow } from "~/modules/i18n/i18n-context"

/**
 * THE ONE PLACE A KEYSTROKE BECOMES WORDS.
 *
 * Keybindings and commands declare a platform-neutral spec (`mod+.`,
 * `mod+shift+t`), because `mod` is Cmd on a Mac and Ctrl everywhere else.
 * Anything that SHOWS a keystroke to a reader goes through here, so the
 * shortcuts overlay and the command palette can never disagree, and neither
 * can print the raw spec.
 */

/** Any platform string a Mac answers with. Chromium says "macOS", the legacy
 *  `navigator.platform` says "MacIntel", and iPadOS says "iOS" while carrying a
 *  Mac keyboard's modifiers, so the comparison is case-insensitive. */
const MAC_PLATFORM = /mac|iphone|ipad|ios/i

/** True on a Mac keyboard. Anything without a `navigator` is treated as not a
 *  Mac, so a server render is never blank. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData
  // Chromium reports "macOS", which a `includes("Mac")` test misses, so Chrome,
  // Edge and Arc printed "Ctrl + P" on a Mac. An empty or unfamiliar string is
  // not a verdict either: the user agent is asked in that case rather than
  // taken as a no.
  if (typeof data?.platform === "string" && MAC_PLATFORM.test(data.platform)) return true
  return MAC_PLATFORM.test(navigator.userAgent ?? "")
}

function token(part: string, isMac: boolean): string {
  const key = part.toLowerCase()
  if (key === "mod") return isMac ? "⌘" : "Ctrl"
  if (key === "cmd" || key === "meta") return isMac ? "⌘" : "Win"
  if (key === "shift") return isMac ? "⇧" : tNow("kernel.shellUi.key.shift")
  if (key === "alt" || key === "option") return isMac ? "⌥" : "Alt"
  if (key === "ctrl" || key === "control") return isMac ? "⌃" : "Ctrl"
  if (key === "escape" || key === "esc") return tNow("kernel.shellUi.key.esc")
  if (key === "enter" || key === "return") return isMac ? "↩" : tNow("kernel.shellUi.key.enter")
  if (key === "space") return tNow("kernel.shellUi.key.space")
  // The key itself: a single character reads as a capital on a keycap, a
  // named key ("Tab", "Home") keeps its own casing.
  return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)
}

/**
 * Renders a binding spec as the label a reader sees: "Cmd + ." on a Mac,
 * "Ctrl + ." elsewhere. Pass `isMac` to render for a platform other than the
 * one running (tests, and any future per-profile override).
 */
export function formatKeyLabel(keySpec: string, isMac: boolean = isMacPlatform()): string {
  return keySpec
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => token(part, isMac))
    .join(" + ")
}
