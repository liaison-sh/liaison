// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE STREAMING RENDERER KNOWS NOTHING ABOUT `@[...]`.
//
// A finished turn is drawn by `markdown-content.tsx`, whose marked instance has
// a mention tokenizer. A turn still arriving is drawn by `streaming-markdown`,
// which has only the CommonMark link rule, so the same reference came out
// mangled while the reader watched it stream:
//
//   "@[Client Feedback](mail:conversation:id)"    -> "@" + a link
//   "[@[Client Feedback](mail:conversation:id)]"  -> "[Client Feedback" inside
//                                                    a link, "]" left over
//
// The streamed text is normalized to a plain markdown link before it reaches
// that parser. The href keeps the entity reference, which the renderer's own
// `safe_set_attr` already allows, so the anchor is a real reference rather than
// the raw syntax with punctuation stuck to it.
import { isEntityRefHref } from "~/modules/shell/markdown-content"

const LABEL = String.raw`(?:[^[\]\\]|\\.|\[[^\]]*\])+`
/**
 * `@[Label](ref)`, with either wrapper the model puts around it: a bare pair
 * of brackets, `[@[Label](ref)]`, or a markdown LINK whose text is the whole
 * mention, `[@[Label](ref)](ref)`. The link form is what a ticket reference
 * arrives in, and matching only the bracket pair left its trailing `](ref)`
 * behind as raw text.
 */
const MENTION_G = new RegExp(
  String.raw`\[?@\[(${LABEL})\]\(([^)\s]+)\)(?:\]\(([^)\s]+)\)|\])?`,
  "g",
)

/** Rewrite every complete mention token into the markdown link it means. */
export function mentionsToMarkdownLinks(text: string): string {
  return text.replace(MENTION_G, (raw, label: string, ref: string, linkRef?: string) => {
    if (!isEntityRefHref(ref)) return raw
    // The label is carried VERBATIM, escapes included: it is about to be a
    // markdown link text, and that is the same grammar it was already written
    // in. Unescaping here would re-open the bracket the escape was closing.
    const link = `[${label}](${ref})`
    // The mention as a link's own text. The outer reference is the same one
    // twice over, so the token collapses to a single link; anything else in
    // the outer href is somebody's real link and is left alone.
    if (typeof linkRef === "string") return isEntityRefHref(linkRef) ? link : raw
    // Absorb the wrapping brackets only as a PAIR: one alone is somebody's
    // punctuation and stays exactly where they put it.
    if (raw.startsWith("[") && raw.endsWith("]")) return link
    return `${raw.startsWith("[") ? "[" : ""}${link}${raw.endsWith("]") ? "]" : ""}`
  })
}

/**
 * Where an UNFINISHED mention starts in this chunk, or -1.
 *
 * A stream arrives a few characters at a time, so "@[Client Feed" is a token
 * that is not there yet: rewritten now it would be rewritten wrong, and passed
 * through now the parser would commit it as text before the rest arrived. The
 * caller holds everything from this index back until the next chunk completes
 * it (or the turn ends and it is flushed as the literal text it turned out to
 * be).
 */
export function pendingMentionStart(text: string): number {
  const at = text.lastIndexOf("@[")
  if (at === -1) return -1
  const start = at > 0 && text[at - 1] === "[" ? at - 1 : at
  const rest = text.slice(start)
  // Complete once the closing paren of the reference has arrived. A wrapped
  // token also wants its trailing bracket, but a missing one only costs the
  // absorption, never the chip, so the paren is the whole test.
  return /\]\([^)\s]*\)/.test(rest) ? -1 : start
}
