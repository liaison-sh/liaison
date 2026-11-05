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
import { Marked } from "marked"
import { wrapMarkdownTables } from "~/lib/markdown-tables"
import { sanitizeHtml } from "~/lib/sanitize"

const marked = new Marked({ breaks: false, gfm: true }, editorMarkdown)

/** Sanitized HTML; a wide table scrolls in its own box, as in a message. */
export function renderMarkdown(body: string): string {
  return wrapMarkdownTables(sanitizeHtml(marked.parse(body, { async: false }) as string))
}
