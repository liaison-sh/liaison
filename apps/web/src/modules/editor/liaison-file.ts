// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A page's image or file: the token `![](liaison-file:<id>)`, one inline atom holding
// the file's id and nothing else. Its type decides how it is drawn (file-view.ts).
// An alt text someone wrote into the token is not kept once its block is edited.
//
// HTML that names a file of this app (the editor's own clipboard, the reader's
// `<span data-liaison-file>`, an `<img>` of the app's own inline route) reads back as
// this node; any other `<img>` is kept as the source chip of raw-image.ts, never drawn.
//
// While a file uploads, an `uploadingFile` chip stands where it goes; it writes no
// markdown, and the token takes its place once the file is stored.
import { fileToken } from "@liaison/shared"
import { Node } from "@tiptap/core"
import { Fragment, type Node as PMNode, type Slice } from "@tiptap/pm/model"
import { FILE_REF_AT_START, type FileViewDeps, isFileId, renderFileView } from "./file-view"

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
/** The app's own inline route for a file: `/api/files/<id>/inline`. */
const OWN_INLINE_PATH = new RegExp(`^/api/files/(${UUID})/inline(?:[?#].*)?$`)

/** The id of a file of THIS app an `<img src>` points at, else null. */
export function ownFileIdOfSrc(src: string | null | undefined): string | null {
  if (!src) return null
  let url: URL
  try {
    url = new URL(src, window.location.origin)
  } catch {
    return null
  }
  if (url.origin !== window.location.origin) return null
  return OWN_INLINE_PATH.exec(`${url.pathname}${url.search}`)?.[1] ?? null
}

export interface LiaisonFileOptions {
  /** How to draw a file; without it the node shows a neutral label and fetches nothing. */
  view: FileViewDeps | null
  /** The label of a file the page cannot draw (no view). */
  label: string
}

export const LiaisonFile = Node.create<LiaisonFileOptions>({
  name: "liaisonFile",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  // Before the source chip's `<img>` rule: an image of this app is a file.
  priority: 1001,
  addOptions() {
    return { view: null, label: "Image or file" }
  },
  markdownTokenizer: {
    name: "liaisonFile",
    level: "inline",
    start: (src) => src.indexOf("![]("),
    tokenize: (src) => {
      const match = FILE_REF_AT_START.exec(src)
      return match ? { type: "liaisonFile", raw: match[0], id: match[1] } : undefined
    },
  },
  addAttributes() {
    return {
      id: {
        default: "",
        // The span's own attribute; an image's id comes from its rule.
        parseHTML: (el) => {
          const id = el.getAttribute("data-liaison-file")
          return isFileId(id) ? id : null
        },
      },
    }
  },
  parseHTML() {
    return [
      {
        tag: "span[data-liaison-file]",
        getAttrs: (el) => {
          const id = (el as HTMLElement).getAttribute("data-liaison-file")
          return isFileId(id) ? { id } : false
        },
      },
      {
        tag: "img[src]",
        getAttrs: (el) => {
          const id = ownFileIdOfSrc((el as HTMLElement).getAttribute("src"))
          return id ? { id } : false
        },
      },
    ]
  },
  renderHTML({ node }) {
    return ["span", { "data-liaison-file": String(node.attrs.id ?? "") }]
  },
  renderText: ({ node }) => fileToken(String(node.attrs.id ?? "")),
  parseMarkdown: (token) => ({ type: "liaisonFile", attrs: { id: String(token.id ?? "") } }),
  renderMarkdown: (node) => (isFileId(node.attrs?.id) ? fileToken(node.attrs.id) : ""),
  addNodeView() {
    const { view, label } = this.options
    return ({ node }) => {
      const dom = document.createElement("span")
      dom.contentEditable = "false"
      dom.dataset.testid = "liaison-file"
      let id = String(node.attrs.id ?? "")
      let stop = () => {}
      const draw = () => {
        stop()
        if (view) stop = renderFileView(dom, id, view)
        else {
          dom.className = "liaison-file"
          dom.dataset.liaisonFile = id
          dom.textContent = label
        }
      }
      draw()
      return {
        dom,
        update: (next) => {
          if (next.type.name !== "liaisonFile") return false
          const nextId = String(next.attrs.id ?? "")
          if (nextId !== id) {
            id = nextId
            draw()
          }
          return true
        },
        destroy: () => stop(),
        ignoreMutation: () => true,
      }
    }
  },
})

export const UploadingFile = Node.create<{ label: (name: string) => string }>({
  name: "uploadingFile",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addOptions() {
    return { label: (name: string) => `Uploading ${name}` }
  },
  addAttributes() {
    return { key: { default: "" }, name: { default: "" } }
  },
  // Never read from HTML: a chip exists only while this editor uploads.
  parseHTML: () => [],
  renderHTML: ({ node }) => ["span", { "data-uploading-file": String(node.attrs.key ?? "") }],
  renderText: () => "",
  renderMarkdown: () => "",
  addNodeView() {
    const label = this.options.label
    return ({ node }) => {
      const dom = document.createElement("span")
      dom.contentEditable = "false"
      dom.className = "liaison-file-uploading"
      dom.dataset.testid = "liaison-file-uploading"
      dom.setAttribute("role", "status")
      dom.textContent = label(String(node.attrs.name ?? ""))
      return { dom, ignoreMutation: () => true }
    }
  },
})

/** The ids of every file node in a slice or a node, in order. */
export function fileIdsInFragment(fragment: Fragment): string[] {
  const ids: string[] = []
  fragment.descendants((node) => {
    if (node.type.name === "liaisonFile" && isFileId(node.attrs.id)) ids.push(node.attrs.id)
  })
  return ids
}

/** `fragment` with every file node whose id `keep` refuses removed. */
export function withoutFiles(fragment: Fragment, keep: (id: string) => boolean): Fragment {
  const out: PMNode[] = []
  fragment.forEach((node) => {
    if (node.type.name === "liaisonFile") {
      if (keep(String(node.attrs.id))) out.push(node)
      return
    }
    out.push(node.isLeaf ? node : node.copy(withoutFiles(node.content, keep)))
  })
  return Fragment.from(out)
}

/** `node` with each file id `map` names (any case) replaced by its new id. */
export function withFileIds(node: PMNode, to: (id: string) => string | undefined): PMNode {
  if (node.type.name === "liaisonFile") {
    const next = to(String(node.attrs.id))
    return next ? node.type.create({ ...node.attrs, id: next }, null, node.marks) : node
  }
  if (node.isLeaf || node.childCount === 0) return node
  const children: PMNode[] = []
  node.content.forEach((child) => {
    children.push(withFileIds(child, to))
  })
  return node.copy(Fragment.from(children))
}

/** Whether a slice holds no content left to insert. */
export function isEmptySlice(slice: Slice): boolean {
  let text = false
  slice.content.descendants((node) => {
    if (node.isText || node.isAtom) text = true
    return !text
  })
  return !text
}
