// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HTML written into markdown that the editor has no node for (an agent's
// `<details>` around a section, a `<reason>` tag in a sentence). Parsed as
// HTML, its tags were dropped or turned into escaped text; kept here as the
// source it is, shown as such, and written back character for character.
import { Node } from "@tiptap/core"

/** A tag the schema has no mark or node for (those it has are left to the HTML parser). */
const UNKNOWN_TAG =
  /^<\/?(?!(?:br|strong|b|em|i|u|s|del|strike|code|a)\b)[a-z][\w-]*(?:\s[^<>]*)?\/?>/i

/** A block of HTML, editable as its source text. */
const RawHtmlBlock = Node.create({
  name: "rawHtmlBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  markdownTokenName: "html",
  parseHTML() {
    return [{ tag: "pre[data-raw-html]", preserveWhitespace: "full" }]
  },
  renderHTML() {
    return ["pre", { "data-raw-html": "", class: "md-raw-html" }, 0]
  },
  parseMarkdown: (token) => {
    const raw = (token.raw ?? "").replace(/\n+$/, "")
    if (!token.block || !raw.trim()) return []
    return { type: "rawHtmlBlock", content: [{ type: "text", text: raw }] }
  },
  renderMarkdown: (node, h) => h.renderChildren(node),
})

/** One HTML tag inside a line of text: a chip showing the tag, written back as is. */
const RawHtmlInline = Node.create({
  name: "rawHtmlInline",
  group: "inline",
  inline: true,
  atom: true,
  // Its own tokenizer: an inline HTML token never reaches a node's parser.
  markdownTokenizer: {
    name: "rawHtmlInline",
    level: "inline",
    start: (src) => src.search(/<\/?[a-z]/i),
    tokenize: (src) => {
      const match = UNKNOWN_TAG.exec(src)
      return match ? { type: "rawHtmlInline", raw: match[0] } : undefined
    },
  },
  addAttributes() {
    return { raw: { default: "", parseHTML: (el) => el.getAttribute("data-raw-html") } }
  },
  parseHTML() {
    return [{ tag: "span[data-raw-html]" }]
  },
  renderHTML({ node }) {
    return ["span", { "data-raw-html": node.attrs.raw, class: "md-raw-html" }, node.attrs.raw]
  },
  renderText: ({ node }) => node.attrs.raw,
  parseMarkdown: (token) => ({ type: "rawHtmlInline", attrs: { raw: token.raw ?? "" } }),
  renderMarkdown: (node) => node.attrs?.raw ?? "",
})

export const rawHtml = [RawHtmlBlock, RawHtmlInline]
