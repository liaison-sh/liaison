// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Slack reaction-name → unicode emoji conversion for the Slack importer.
 *
 * Liaison's reaction UI stores the literal emoji character (e.g. "👍"), while
 * Slack exports store short names (e.g. "+1"). The name table is the shared
 * shortcode table (the editor's `:` picker uses it too); unknown names fall
 * back to `:name:` so nothing is dropped.
 */
import { emojiForShortcode } from "@liaison/shared"

/**
 * Convert a Slack reaction name to the emoji character Liaison stores.
 * Handles skin-tone suffixes (`+1::skin-tone-3` → base emoji), passes through
 * names that are already unicode emoji, and falls back to `:name:`.
 */
export function slackReactionToEmoji(name: string): string {
  // Already a literal emoji (raw unicode reaction) — pass through.
  if (/\p{Extended_Pictographic}/u.test(name)) return name
  const base = name.split("::")[0] ?? name
  return emojiForShortcode(base) ?? `:${base}:`
}
