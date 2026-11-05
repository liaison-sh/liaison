// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Minimal HTML-entity decoder for adapter ingest. YouTube's Data API returns
// comment text (`snippet.textDisplay`) and video titles HTML-encoded — a
// comment reading `don't` arrives as `don&#39;t`, a title `Q & A` as `Q &amp; A`.
// Stored raw, those leak into the findings UI and into search. Decoding at
// ingest is the right boundary: it fixes the display AND the search index in
// one place (vs decoding only at render, which leaves the stored text and the
// Meili document still entity-encoded).
//
// Scope is deliberately narrow: the named entities the platforms actually emit
// plus numeric (decimal + hex) character references. This is NOT a full HTML
// sanitizer — the untrusted-content fence (see reads.ts wrapExternalContent)
// still owns injection safety; this only un-escapes entities into their
// characters.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  // Decode &nbsp; to a plain ASCII space (0x20), not U+00A0, so finding text
  // stays searchable and free of confusing invisible characters.
  nbsp: " ",
}

/**
 * Decode HTML entities in a string. Handles named entities (&amp; &lt; &gt;
 * &quot; &apos; &nbsp;), decimal numeric refs (&#39;), and hex numeric refs
 * (&#x27;). Unknown entities are left verbatim (never dropped). A null/undefined
 * input passes through unchanged so callers can decode an optional field inline.
 */
export function decodeHtmlEntities(input: string): string
export function decodeHtmlEntities(input: null): null
export function decodeHtmlEntities(input: undefined): undefined
export function decodeHtmlEntities(input: string | null | undefined): string | null | undefined
export function decodeHtmlEntities(input: string | null | undefined): string | null | undefined {
  if (input == null || input === "") return input
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body[0] === "#") {
      const isHex = body[1] === "x" || body[1] === "X"
      const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    const named = NAMED[body.toLowerCase()]
    return named ?? match
  })
}
