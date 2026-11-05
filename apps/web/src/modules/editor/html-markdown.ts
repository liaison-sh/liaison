// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HTML read into the editor's markdown, through the editor's own schema: what
// the editor can show survives (marks, lists, links, quotes), the rest keeps
// its text. Loaded on demand, for content written before the shared editor
// (a mail draft the earlier mail editor saved as HTML).
import { Editor } from "@tiptap/core"
import { sanitizeMailHtml } from "~/modules/mail/mail-sanitize"
import { editorExtensions } from "./extensions"

export function htmlToMarkdown(html: string): string {
  const editor = new Editor({
    extensions: editorExtensions("full", { keys: { onLink: () => {} } }),
    content: sanitizeMailHtml(html),
  })
  try {
    // An empty line the old editor kept (`<div><br></div>`) is one blank line.
    return editor
      .getMarkdown()
      .replace(/^[ \t]+$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  } finally {
    editor.destroy()
  }
}
