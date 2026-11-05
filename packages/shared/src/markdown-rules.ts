// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the editor writes that plain marked does not draw: `++underline++` and
// checklists (`- [ ] item`). Every renderer takes these, so what the editor
// showed is what a reader sees.
import type { MarkedExtension } from "marked"

// The delimiters hug the text, like emphasis: "C++ et C++" is two languages,
// not an underline.
const UNDERLINE_RE = /^\+\+(?=[^\s+])([\s\S]*?[^\s+])\+\+(?!\+)/

/** The underline at the start of `src`, unless the previous character glues it to a word. */
export function matchUnderline(
  src: string,
  previous: readonly { raw?: string }[],
): { raw: string; text: string } | undefined {
  const before = previous.at(-1)?.raw?.at(-1)
  if (before && /[\p{L}\p{N}_+]/u.test(before)) return undefined
  const match = UNDERLINE_RE.exec(src)
  return match ? { raw: match[0], text: match[1]! } : undefined
}

/** Marked options for the editor's markdown. The sanitizer drops `<input>`, so a checklist box is a span. */
export const editorMarkdown: MarkedExtension = {
  extensions: [
    {
      name: "underline",
      level: "inline",
      start: (src: string) => src.indexOf("++"),
      tokenizer(src, tokens) {
        const match = matchUnderline(src, tokens)
        if (!match) return undefined
        return { type: "underline", ...match, tokens: this.lexer.inlineTokens(match.text) }
      },
      renderer(token) {
        return `<u>${this.parser.parseInline(token.tokens ?? [])}</u>`
      },
    },
  ],
  renderer: {
    listitem(item) {
      if (!item.task) return false
      return `<li class="md-task">${this.parser.parse(item.tokens)}</li>\n`
    },
    checkbox({ checked }) {
      return `<span class="md-task-box${checked ? " md-task-done" : ""}"></span>`
    },
  },
}
