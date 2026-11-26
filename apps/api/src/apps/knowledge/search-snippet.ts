// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The line of a page a search result shows under its title: the page's text as
 * read (no markdown, file or page-link tokens), cut around the first place a word
 * of the query appears, or its opening when only the title matched.
 */
import { plainTextOf } from "@liaison/shared"

/** At most this many characters of a page are read for its snippet. */
export const SNIPPET_SOURCE_CHARS = 200_000
const BEFORE = 60
const LENGTH = 180

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

/** The page's text as a reader sees it, on one line. */
export function readableText(body: string): string {
  return plainTextOf(body.slice(0, SNIPPET_SOURCE_CHARS))
    .replace(
      /^ {0,3}(?:#{1,6}\s+|>\s?(?:\[![A-Z]+\]\s*)?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm,
      "",
    )
    .replace(/^ {0,3}(?:```|~~~).*$/gm, "")
    .replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** The snippet for `query` in `body`, or undefined for a page with no text. */
export function snippetOf(body: string, query: string): string | undefined {
  const text = readableText(body)
  if (!text) return undefined
  const folded = fold(text)
  const words = fold(query)
    .split(/\s+/)
    .filter((w) => w.length > 1)
  let at = -1
  for (const w of words) {
    const i = folded.indexOf(w)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  // Folding can change lengths (rarely): offsets map back only when it did not.
  if (folded.length !== text.length) at = -1
  const start = at <= BEFORE ? 0 : text.lastIndexOf(" ", at - BEFORE) + 1 || at - BEFORE
  const end = Math.min(text.length, start + LENGTH)
  const cut = text.slice(start, end)
  const tail = end < text.length ? cut.replace(/\s+\S*$/, "") : cut
  return `${start > 0 ? "… " : ""}${tail}${end < text.length ? " …" : ""}`
}
