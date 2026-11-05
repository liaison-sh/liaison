// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The one HTML-to-text conversion, shared by the server (search enrichment,
 * the slim ticket view, the text/plain part of outgoing mail, web fetch
 * extraction, snippets) and the browser (composer text bodies, quote-length
 * checks). String based on purpose: it runs in Bun with no DOM, and in the
 * browser it never hands markup to a live parser, so nothing in the input can
 * load or execute.
 *
 * It renders what a reader sees, not a sanitizer: script, style and other
 * non-rendered elements are dropped with their content, block boundaries and
 * `<br>` become line breaks, table cells are separated by a space, source
 * whitespace collapses the way a browser collapses it, and entities are
 * decoded once (so `&amp;lt;` stays the literal text `&lt;`).
 */

export interface HtmlToTextOptions {
  /** Collapse every run of whitespace, line breaks included, to one space. */
  singleLine?: boolean
}

// Openers only: the span each one starts is found by `stripSpans` below, in
// one pass. A regex spanning opener to closer (`<!--[\s\S]*?-->`) rescans to
// the end of the input from every opener that never closes, which is quadratic
// on attacker text (inbound mail, fetched pages).
const NON_RENDERED_OPEN_RE = /<(script|style|noscript|template|head|title)\b/gi
const TAG_OPEN_RE = /<\/?[a-zA-Z!]/g
const BREAK_RE = /<br\s*\/?>/gi
// A run of adjacent block closers (`</li></ul>`, `</p></div>`) is ONE boundary.
const BLOCK_END_RE =
  /(?:<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|table|thead|tbody|tfoot|ul|ol|dl|dt|dd|section|article|header|footer|aside|nav|figure|figcaption|address)\s*>\s*)+/gi
const CELL_END_RE = /<\/t[dh]\s*>/gi
// Only real tags: a bare `<` in text ("1 < 2") is not the start of one.
const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  eacute: "é",
  egrave: "è",
  agrave: "à",
  ccedil: "ç",
}

function decodeEntity(match: string, body: string): string {
  if (body[0] === "#") {
    const code =
      body[1] === "x" || body[1] === "X"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
    if (code >= 0xd800 && code <= 0xdfff) return match
    return code === 0xa0 ? " " : String.fromCodePoint(code)
  }
  return NAMED_ENTITIES[body] ?? match
}

/** Decode character references once (`&amp;lt;` stays the literal text `&lt;`). */
export function decodeHtmlEntities(text: string): string {
  return text.replace(ENTITY_RE, decodeEntity)
}

/**
 * Remove every span an opener starts, the way a global regex replace of
 * `<opener>[^>]*>` (when `ends` is null) or `<opener>[\s\S]*?<end>` would, in
 * time linear in the input. Each lookahead (the next `>`, the next closer of a
 * kind) is cached and only moves forward: once a search runs off the end,
 * every later opener of that kind fails at once instead of rescanning.
 */
function stripSpans(
  text: string,
  openRe: RegExp,
  closer: (open: RegExpExecArray) => { key: string; re: RegExp } | null,
): string {
  let out = ""
  let kept = 0
  let gt = -2 // the next `>` at or after the last search start; -1 none left
  const closes = new Map<string, { at: number; end: number }>() // per kind; at -1: none left
  openRe.lastIndex = 0
  for (let open = openRe.exec(text); open; open = openRe.exec(text)) {
    const from = open.index + open[0].length
    if (gt !== -1 && gt < from) gt = text.indexOf(">", from)
    if (gt === -1) break // no `>` left: no later opener can complete a tag
    let end = gt + 1
    const kind = closer(open)
    if (kind) {
      let close = closes.get(kind.key)
      if (!close || (close.at !== -1 && close.at < end)) {
        kind.re.lastIndex = end
        const m = kind.re.exec(text)
        close = m ? { at: m.index, end: m.index + m[0].length } : { at: -1, end: -1 }
        closes.set(kind.key, close)
      }
      if (close.at === -1) {
        // No closer of this kind after here: like the regex, try the next opener.
        openRe.lastIndex = open.index + 1
        continue
      }
      end = close.end
    }
    out += text.slice(kept, open.index)
    kept = end
    openRe.lastIndex = end
  }
  return kept === 0 ? text : out + text.slice(kept)
}

const CLOSERS = new Map<string, RegExp>()
function nonRenderedCloser(open: RegExpExecArray): { key: string; re: RegExp } {
  const key = (open[1] as string).toLowerCase()
  let re = CLOSERS.get(key)
  if (!re) {
    re = new RegExp(`</${key}\\s*>`, "gi")
    CLOSERS.set(key, re)
  }
  return { key, re }
}

function stripComments(text: string): string {
  // A comment's end is searched from just after `<!--`, not after a `>`.
  let out = ""
  let kept = 0
  let at = text.indexOf("<!--")
  while (at !== -1) {
    const close = text.indexOf("-->", at + 4)
    if (close === -1) break
    out += text.slice(kept, at)
    kept = close + 3
    at = text.indexOf("<!--", kept)
  }
  return kept === 0 ? text : out + text.slice(kept)
}

export function htmlToText(html: string, options: HtmlToTextOptions = {}): string {
  if (!html) return ""
  let text = stripSpans(stripComments(html), NON_RENDERED_OPEN_RE, nonRenderedCloser)
    .replace(/\s+/g, " ")
    .replace(BREAK_RE, "\n")
    .replace(BLOCK_END_RE, "\n")
    .replace(CELL_END_RE, " ")
  text = stripSpans(text, TAG_OPEN_RE, () => null)
  text = decodeHtmlEntities(text)
  if (options.singleLine) return text.replace(/\s+/g, " ").trim()
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
  return text.trim()
}
