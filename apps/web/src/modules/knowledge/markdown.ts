// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Shared markdown renderer for Knowledge surfaces.
 *
 * Why a module-scoped helper rather than `new Marked()` per component:
 *   1. `Marked` keeps its own parser state — instantiating it once amortises
 *      compile/setup across every render in the session.
 *   2. One set of parse options for every document surface (gfm: true).
 *      `breaks` is OFF: a document is prose, and a single newline inside a
 *      paragraph is a soft wrap (CommonMark), not a line break. Imported
 *      sources (Drive exports, pasted text) are hard-wrapped at ~80 columns,
 *      and with `breaks: true` every one of those wraps became a <br>, so
 *      sentences broke mid-line. Paragraphs (blank line), lists, headings and
 *      code blocks are unaffected; an intentional break inside a paragraph is
 *      still written the CommonMark way (two trailing spaces or a backslash).
 *      Chat messages keep `breaks: true` (shell/markdown-content.tsx): a chat
 *      line typed with Enter is meant as a line.
 *   3. The HTML is **always** funnelled through `sanitizeHtml` (DOMPurify)
 *      before injection — synced-source bodies may originate from an
 *      attacker-controlled Drive file with a misleading `text/markdown`
 *      MIME, so escape hatches like `<script>` and `<iframe>` must die at
 *      the renderer boundary, not at the call site.
 */

import { editorMarkdown } from "@liaison/shared"
import { Marked, type MarkedExtension } from "marked"
import { wrapMarkdownTables } from "~/lib/markdown-tables"
import { sanitizeHtml } from "~/lib/sanitize"
import { CALLOUT_AT_START, calloutInner, calloutStart } from "~/modules/editor/callout"
import { FILE_REF_AT_START, imageWidthOfRef } from "~/modules/editor/file-view"
import { PAGE_REF_AT_START, pageRefStart } from "~/modules/editor/page-link-view"

/**
 * A page's image or file (`![](liaison-file:<id>)`) is an empty
 * `<span data-page-file="<id>">`: no address at all. The page mounts the file's
 * view into it after the HTML is in place (hydrate-tokens.ts).
 */
const fileTokens: MarkedExtension = {
  extensions: [
    {
      name: "liaisonFile",
      level: "inline",
      start: (src: string) => {
        const at = src.search(/!\[[^\]]*\]\(liaison-file:/)
        return at < 0 ? undefined : at
      },
      tokenizer(src: string) {
        const match = FILE_REF_AT_START.exec(src)
        return match
          ? { type: "liaisonFile", raw: match[0], id: match[1], width: imageWidthOfRef(match[0]) }
          : undefined
      },
      renderer: (token) =>
        token.width && token.width !== "full"
          ? `<span data-page-file="${String(token.id)}" data-width="${String(token.width)}"></span>`
          : `<span data-page-file="${String(token.id)}"></span>`,
    },
  ],
}

/**
 * A link to another page (`[](knowledge:document:<id>)`, or a label an older text
 * still holds) is an empty `<span data-page-link="<id>">`: the label is never
 * rendered. The page draws the title this reader may see into it (hydrate-tokens.ts).
 */
const pageTokens: MarkedExtension = {
  extensions: [
    {
      name: "pageLink",
      level: "inline",
      start: (src: string) => {
        const at = pageRefStart(src)
        return at < 0 ? undefined : at
      },
      tokenizer(src: string) {
        const match = PAGE_REF_AT_START.exec(src)
        return match ? { type: "pageLink", raw: match[0], id: match[1] } : undefined
      },
      renderer: (token) => `<span data-page-link="${String(token.id)}"></span>`,
    },
  ],
}

/**
 * A callout (`> [!NOTE]` and its quoted lines, editor/callout.ts) is a quote with a
 * kind: `<blockquote class="md-callout" data-callout="note">`, its icon drawn by the
 * stylesheet.
 */
const callouts: MarkedExtension = {
  extensions: [
    {
      name: "callout",
      level: "block",
      start: (src: string) => {
        const at = calloutStart(src)
        return at < 0 ? undefined : at
      },
      tokenizer(src: string) {
        const match = CALLOUT_AT_START.exec(src)
        if (!match) return undefined
        return {
          type: "callout",
          raw: match[0],
          kind: match[1]!.toLowerCase(),
          tokens: this.lexer.blockTokens(calloutInner(match[2] ?? ""), []),
        }
      },
      renderer(token) {
        const kind = String(token.kind)
        return `<blockquote class="md-callout" data-callout="${kind}">${this.parser.parse(token.tokens ?? [])}</blockquote>\n`
      },
    },
  ],
}

const marked = new Marked(
  { breaks: false, gfm: true },
  editorMarkdown,
  callouts,
  fileTokens,
  pageTokens,
)

/** Sanitized HTML; a wide table scrolls in its own box, as in a message. */
export function renderMarkdown(body: string): string {
  return wrapMarkdownTables(sanitizeHtml(marked.parse(body, { async: false }) as string))
}
