// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Markdown the editor has no node for, kept as the source it is: any image
// (`![alt](address "title")`) and any link with no label (`[](address)`, the page
// link token among them). Without a node, an image or an empty link had nothing to
// show and was dropped the first time its block was edited.
//
// The atom shows a chip with a fixed label and keeps the source in a data attribute:
// it never draws the image and never puts the address in a URL attribute, so a page
// cannot make the browser fetch another host from the editor.
import { Node } from "@tiptap/core"

/** An address in parentheses: no space, balanced parentheses one level deep, escapes. */
const DEST = String.raw`\((?:[^()\s\\]|\\.|\([^()\s]*\))*(?:\s+(?:"[^"]*"|'[^']*'))?\)`
const IMAGE = new RegExp(String.raw`^!\[(?:\\.|[^\]\\])*\]${DEST}`)
const EMPTY_LINK = new RegExp(String.raw`^\[\]${DEST}`)
/** A file of this app's storage is its own node (liaison-file.ts), never this chip. */
const FILE_REF = /^!\[(?:\\.|[^\]\\])*\]\(liaison-file:/
/** A link to a page is its own node too (page-link.ts). */
const PAGE_REF = /^\[\]\(knowledge:document:/

/**
 * A pasted web image kept as its source, never loaded: `![](address)` with the
 * address escaped so it stays one destination. Only http(s) addresses are kept;
 * a `data:`, `blob:` or other image is dropped.
 */
export function rawImageOfSrc(src: string | null | undefined): string | null {
  if (!src || !/^https?:\/\//i.test(src.trim())) return null
  const address = src.trim().replace(/[\s()<>\\]/g, (c) => encodeURIComponent(c))
  return `![](${address})`
}

export type RawMarkdownKind = "image" | "link"

export interface RawMarkdownLabels {
  /** The chip of an image (never loaded in the editor). */
  image: string
  /** The chip of a link with no label (a page link until links show their page). */
  link: string
}

export const RawMarkdownInline = Node.create<{ labels: RawMarkdownLabels }>({
  name: "rawMarkdownInline",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addOptions() {
    return { labels: { image: "Image from another site, not loaded", link: "Page link" } }
  },
  markdownTokenizer: {
    name: "rawMarkdownInline",
    level: "inline",
    start: (src) => src.search(/!\[|\[\]\(/),
    tokenize: (src) => {
      if (FILE_REF.test(src) || PAGE_REF.test(src)) return undefined
      const match = IMAGE.exec(src) ?? EMPTY_LINK.exec(src)
      return match ? { type: "rawMarkdownInline", raw: match[0] } : undefined
    },
  },
  addAttributes() {
    return {
      // Null when absent, so a rule's own attrs (a pasted image) are kept.
      raw: { default: "", parseHTML: (el) => el.getAttribute("data-raw-markdown") },
    }
  },
  parseHTML() {
    return [
      { tag: "span[data-raw-markdown]" },
      // Any other pasted image (one of this app is a file node, tried first).
      {
        tag: "img[src]",
        getAttrs: (el) => {
          const raw = rawImageOfSrc((el as HTMLElement).getAttribute("src"))
          return raw ? { raw } : false
        },
      },
    ]
  },
  renderHTML({ node }) {
    const raw = String(node.attrs.raw ?? "")
    const kind: RawMarkdownKind = raw.startsWith("!") ? "image" : "link"
    return [
      "span",
      {
        "data-raw-markdown": raw,
        "data-raw-kind": kind,
        class: "md-raw-markdown",
        contenteditable: "false",
      },
      this.options.labels[kind],
    ]
  },
  renderText: ({ node }) => node.attrs.raw,
  parseMarkdown: (token) => ({ type: "rawMarkdownInline", attrs: { raw: token.raw ?? "" } }),
  renderMarkdown: (node) => node.attrs?.raw ?? "",
})
