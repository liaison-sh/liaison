// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A message as one readable line, for every surface that shows message text
// outside the renderer: the iOS/Android push body, the desktop and browser
// notification, the attention row, the chat list's last line. The stored
// content is markdown plus the mention grammar (`@[Name](user:<id>)`,
// `@[Name](agent:<id>)`, `#[name](thread:<id>)`, `@[Label](app:type:<id>)`);
// a lock screen showing `@[Recipient](user:2f1c…)` is the bug this exists for.
// A mention reads as its label, taken from the markup itself: no lookup.

const LABEL = String.raw`(?:[^\]\\]|\\.)+`
/** `[@[Name](ref)](url)`: a mention the editor wrapped in a link. */
const WRAPPED_MENTION_RE = new RegExp(
  String.raw`\[([@#])\[(${LABEL})\]\([^)\s]+\)\]\([^)\s]+\)`,
  "g",
)
const MENTION_RE = new RegExp(String.raw`([@#])\[(${LABEL})\]\([^)\s]+\)`, "g")
const IMAGE_RE = /!\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g
const LINK_RE = /\[([^\]]+)\]\([^)\s]*(?:\s+"[^"]*")?\)/g
const AUTOLINK_RE = /<((?:https?|mailto):[^>\s]+)>/g
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm
const CODE_SPAN_RE = /(`+)([\s\S]+?)\1(?!`)/g
const PLACEHOLDER_RE = /\uE000(\d+)\uE000/g

function unescapeLabel(label: string): string {
  return label.replace(/\\([\]\\[])/g, "$1")
}

/**
 * The plain text of a message's markup, on one line: mentions as `@Name`,
 * links as their text, emphasis markers dropped, code kept verbatim (a mention
 * quoted in backticks is an example, not a mention), block markers flattened.
 */
export function messagePlainText(content: string): string {
  const kept: string[] = []
  const keep = (text: string) => `\uE000${kept.push(text) - 1}\uE000`

  let text = content.replace(/\r\n?/g, "\n")
  text = text.replace(FENCE_RE, (_m, _fence: string, body: string) => ` ${keep(body.trim())} `)
  text = text.replace(CODE_SPAN_RE, (_m, _ticks: string, body: string) => keep(body.trim()))

  text = text
    .replace(WRAPPED_MENTION_RE, (_m, sigil: string, label: string) => sigil + unescapeLabel(label))
    .replace(MENTION_RE, (_m, sigil: string, label: string) => sigil + unescapeLabel(label))
    .replace(IMAGE_RE, "$1")
    .replace(LINK_RE, "$1")
    .replace(AUTOLINK_RE, "$1")

  // Block markers, line by line.
  text = text
    .split("\n")
    .map((line) =>
      line
        .replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/, "")
        .replace(/^ {0,3}#{1,6}[ \t]+/, "")
        .replace(/^ {0,3}(?:>[ \t]?)+/, "")
        .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/, ""),
    )
    .join("\n")

  // Emphasis. `*`/`_` only off a word boundary, so `2*3*4` and `snake_case`
  // stay as written.
  text = text
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(^|[^\p{L}\p{N}_+])\+\+(?=[^\s+])([\s\S]*?[^\s+])\+\+(?!\+)/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\p{L}\p{N}*])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!~>|])/g, "$1")

  return text
    .replace(PLACEHOLDER_RE, (_m, i: string) => kept[Number(i)] ?? "")
    .replace(/\s+/g, " ")
    .trim()
}
