// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A link to another Knowledge page: the token `[](knowledge:document:<id>)`, one inline
// atom holding the page's id and nothing else (document preset only). Its chip shows
// the title as the reader may see it (page-link-view.ts). A labelled link or an
// agent's `@[Title](knowledge:document:<id>)` reads as the same node: the label is
// never kept, never shown, and the block is written back as the bare token once edited.
import { pageToken } from "@liaison/shared"
import { Node } from "@tiptap/core"
import {
  isOpenPageLink,
  isPageId,
  PAGE_REF_AT_START,
  type PageLinkDeps,
  type PageLinkLabels,
  pageRefStart,
  renderPageLink,
} from "./page-link-view"

export interface PageLinkOptions {
  /** How chips get their titles; without it every chip is the neutral label. */
  deps: PageLinkDeps | null
  labels: PageLinkLabels
}

export const PageLink = Node.create<PageLinkOptions>({
  name: "pageLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  // Lowest: marked tries the tokenizer registered LAST first, and TipTap registers by
  // priority (highest first). So a page reference is read as this node before the
  // mention chip, the source chip of an empty link or the link mark can take it.
  priority: 1,
  addOptions() {
    return {
      deps: null,
      labels: { unavailable: "Page you cannot open", loading: "Page link" },
    }
  },
  markdownTokenizer: {
    name: "pageLink",
    level: "inline",
    start: (src) => pageRefStart(src),
    tokenize: (src) => {
      const match = PAGE_REF_AT_START.exec(src)
      return match ? { type: "pageLink", raw: match[0], id: match[1] } : undefined
    },
  },
  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el) => {
          const id = el.getAttribute("data-page-link")
          return isPageId(id) ? id : null
        },
      },
    }
  },
  parseHTML() {
    return [
      {
        tag: "span[data-page-link]",
        getAttrs: (el) => {
          const id = (el as HTMLElement).getAttribute("data-page-link")
          return isPageId(id) ? { id } : false
        },
      },
    ]
  },
  // The id only: a copy of the chip carries no title to wherever it is pasted.
  renderHTML({ node }) {
    return ["span", { "data-page-link": String(node.attrs.id ?? "") }]
  },
  renderText: ({ node }) => pageToken(String(node.attrs.id ?? "")),
  parseMarkdown: (token) => ({ type: "pageLink", attrs: { id: String(token.id ?? "") } }),
  renderMarkdown: (node) => (isPageId(node.attrs?.id) ? pageToken(node.attrs.id) : ""),
  addNodeView() {
    const { deps, labels } = this.options
    return ({ node }) => {
      const dom = document.createElement("span")
      dom.contentEditable = "false"
      let id = String(node.attrs.id ?? "")
      let stop = renderPageLink(dom, id, deps, labels)
      return {
        dom,
        update: (next) => {
          if (next.type.name !== "pageLink") return false
          const nextId = String(next.attrs.id ?? "")
          if (nextId !== id) {
            stop()
            id = nextId
            stop = renderPageLink(dom, id, deps, labels)
          }
          return true
        },
        // A chip of a page the writer may open takes its own click (it opens the
        // page); the neutral one lets the editor select it, to delete it.
        stopEvent: (event) =>
          isOpenPageLink(dom) && (event.type === "mousedown" || event.type === "click"),
        destroy: () => stop(),
        ignoreMutation: () => true,
      }
    }
  },
})
