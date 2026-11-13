// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `{{team}}` placeholder. One inbox can serve several teams; the ticket's
// team field says which one a ticket belongs to. An inbox's acknowledgement
// text, signature and sender name may name it with `{{team}}`, replaced here
// by the ticket's team label.
//
// A template without the placeholder is returned untouched. A ticket with no
// team drops the placeholder AND the separator (and short connector word)
// that introduced it, so the text never reads "Support -" or "pour".

const PLACEHOLDER = /\{\{\s*team\s*\}\}/i

// Whitespace, then separators, then one optional connector word, then the
// placeholder. The lookbehind keeps a connector from matching the tail of a
// longer word ("Plateau {{team}}" must keep "Plateau").
const DROP_WITH_LEAD_IN =
  /[ \t]*(?:[-–—|:,·•][ \t]*)*(?:(?<![\p{L}\p{N}])(?:for|regarding|about|concerning|pour|concernant|de|du|des|à|au|chez|sur)[ \t]+)?\{\{\s*team\s*\}\}/giu

// HTML only: an inline tag wrapped around the placeholder alone (`<b>{{team}}</b>`)
// goes with it, or its lead-in word would stay in front of an empty element.
const WRAPPED_PLACEHOLDER = /<(b|strong|i|em|u|span)(?:\s[^>]*)?>\s*(\{\{\s*team\s*\}\})\s*<\/\1>/gi

const EMPTY_BRACKETS = /[ \t]*[([][ \t]*[)\]]/g
const LEADING_SEPARATORS = /^[\s\-–—|:,·•]+/
const DOUBLE_SPACES = /[ \t]{2,}/g

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** The team as one clean line: control characters and newlines folded to a
 *  space (it can end up in the From header), null when nothing is left. */
function teamName(team: string | null | undefined): string | null {
  const clean = (team ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping header-unsafe characters is the point
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return clean || null
}

export function hasTeamPlaceholder(template: string | null | undefined): boolean {
  return !!template && PLACEHOLDER.test(template)
}

/**
 * Replace `{{team}}` in `template` with the ticket's team.
 * `mode` "html" escapes the value for an HTML template; "text" leaves it raw.
 */
export function applyTeamPlaceholder(
  template: string,
  team: string | null | undefined,
  mode?: "text" | "html",
): string
export function applyTeamPlaceholder(
  template: string | null | undefined,
  team: string | null | undefined,
  mode?: "text" | "html",
): string | null
export function applyTeamPlaceholder(
  template: string | null | undefined,
  team: string | null | undefined,
  mode: "text" | "html" = "text",
): string | null {
  if (template == null) return null
  if (!PLACEHOLDER.test(template)) return template
  const name = teamName(team)
  if (name) {
    const value = mode === "html" ? escapeHtml(name) : name
    // A function replacement: the value is data, `$&` in it must stay literal.
    return template.replace(new RegExp(PLACEHOLDER.source, "gi"), () => value)
  }
  return (mode === "html" ? template.replace(WRAPPED_PLACEHOLDER, "$2") : template)
    .replace(DROP_WITH_LEAD_IN, "")
    .replace(EMPTY_BRACKETS, "")
    .replace(LEADING_SEPARATORS, "")
    .replace(DOUBLE_SPACES, " ")
}
