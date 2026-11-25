// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How a page link (`[](knowledge:document:<id>)`) is drawn, in the editor and in the
// reader alike: a chip with the linked page's title as THIS reader may see it. The
// token holds the id and nothing else; the title comes from the page's resolver,
// which answers only for pages the reader may open. Any other page is the neutral
// "Page you cannot open": no title, no address, nothing to click.

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
const UUID_RE = new RegExp(`^${UUID}$`)

/**
 * A label as CommonMark reads one: escapes, any character but a bracket, and
 * brackets that balance (two levels). An agent's `@[Q3 [draft] Plan](…)` is one
 * label, never a link whose text a reader would see.
 */
const LABEL = String.raw`(?:\\.|[^\[\]\\]|\[(?:\\.|[^\[\]\\]|\[(?:\\.|[^\[\]\\])*\])*\])*`

/**
 * A page reference at the start of markdown source: the bare token, a labelled link,
 * or an agent's `@[Label](…)`. Group 1 is the page id; the label is never kept.
 */
export const PAGE_REF_AT_START = new RegExp(
  String.raw`^@?\[${LABEL}\]\(knowledge:document:(${UUID})\)`,
)

/** Where the next page reference starts in `src` (not an image's `![`), or -1. */
export function pageRefStart(src: string): number {
  const re = new RegExp(String.raw`@?\[${LABEL}\]\(knowledge:document:${UUID}\)`, "g")
  for (const m of src.matchAll(re)) {
    const at = m.index ?? 0
    if (at > 0 && src[at - 1] === "!" && m[0][0] === "[") continue
    return at
  }
  return -1
}

/** A page id as a token holds it: a uuid and nothing else. */
export function isPageId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}

/** What a page link's title is for this reader: still asked, a title, or none. */
export type PageLinkTitle = string | null | undefined

export interface PageLinkLabels {
  /** A page the reader cannot open (no access, in Trash, deleted). */
  unavailable: string
  /** While the title is asked. */
  loading: string
}

/** What a chip needs; the page's resolver answers it. */
export interface PageLinkDeps {
  /**
   * Follow a page's title for this reader: `fn` is called with `undefined` while it
   * is asked, the title, or `null` when the reader cannot open it, and again when it
   * changes (a rename). Answers a function that stops following.
   */
  watch: (id: string, fn: (title: PageLinkTitle) => void) => () => void
  /** Open the page (a click or Enter on its chip). */
  open: (id: string, title: string) => void
  labels: PageLinkLabels
}

const SVG_NS = "http://www.w3.org/2000/svg"

/** The file-text icon (lucide), drawn from fixed shapes: never markup from a page. */
function pageIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg")
  for (const [k, v] of Object.entries({
    width: "12",
    height: "12",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "page-link-icon",
  })) {
    svg.setAttribute(k, v)
  }
  for (const d of [
    "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z",
    "M14 2v4a2 2 0 0 0 2 2h4",
    "M16 13H8",
    "M16 17H8",
  ]) {
    const path = document.createElementNS(SVG_NS, "path")
    path.setAttribute("d", d)
    svg.appendChild(path)
  }
  return svg
}

/**
 * Draw the chip of page `id` into `dom` and keep it current; answers a function
 * that stops it. Without `deps` the chip is the neutral label and nothing is asked.
 */
export function renderPageLink(
  dom: HTMLElement,
  id: string,
  deps: PageLinkDeps | null,
  fallback: PageLinkLabels = { unavailable: "Page you cannot open", loading: "Page link" },
): () => void {
  const labels = deps?.labels ?? fallback
  let title: string | null = null
  dom.dataset.testid = "page-link"
  dom.setAttribute("data-page-link", id)
  const draw = (next: PageLinkTitle) => {
    title = typeof next === "string" ? next : null
    const state = next === undefined ? "loading" : next === null ? "unavailable" : "open"
    dom.dataset.state = state
    dom.className =
      state === "open" ? "page-link mention-pill mention-actionable" : "page-link page-link-muted"
    if (state === "open") {
      dom.setAttribute("role", "link")
      dom.tabIndex = 0
    } else {
      dom.removeAttribute("role")
      dom.removeAttribute("tabindex")
    }
    const text = document.createElement("span")
    text.textContent =
      state === "open"
        ? (next as string)
        : state === "loading"
          ? labels.loading
          : labels.unavailable
    dom.replaceChildren(pageIcon(), text)
  }
  const open = (event: Event) => {
    if (title === null || !deps) return
    event.preventDefault()
    event.stopPropagation()
    deps.open(id, title)
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") open(event)
  }
  dom.addEventListener("click", open)
  dom.addEventListener("keydown", onKey)
  draw(isPageId(id) && deps ? undefined : null)
  const stop = isPageId(id) && deps ? deps.watch(id, draw) : () => {}
  return () => {
    stop()
    dom.removeEventListener("click", open)
    dom.removeEventListener("keydown", onKey)
  }
}

/** Whether `dom` is the chip of a page the reader may open (a click opens it). */
export function isOpenPageLink(dom: HTMLElement): boolean {
  return dom.dataset.state === "open"
}
