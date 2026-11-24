// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The reader's half of a page's tokens: after the rendered text is in place, each
// `<span data-liaison-file="<id>">` (markdown.ts) gets the view the editor shows for
// the same file (editor/file-view.ts). A span whose value is not a file id is left
// empty: nothing is looked up for it. Page links are drawn the same way (page-link-view.ts).
import { type FileViewDeps, isFileId, renderFileView } from "~/modules/editor/file-view"
import { isPageId, type PageLinkDeps, renderPageLink } from "~/modules/editor/page-link-view"

/** Mount every file view under `root`; answers a function that stops them all. */
export function hydrateFileTokens(
  root: HTMLElement,
  deps: FileViewDeps | null,
  label: string,
): () => void {
  const stops: Array<() => void> = []
  for (const span of root.querySelectorAll<HTMLElement>("span[data-liaison-file]")) {
    const id = span.getAttribute("data-liaison-file")
    if (!isFileId(id)) {
      span.replaceChildren()
      continue
    }
    span.dataset.testid = "liaison-file"
    if (deps) stops.push(renderFileView(span, id, deps))
    else {
      span.classList.add("liaison-file")
      span.textContent = label
    }
  }
  return () => {
    for (const stop of stops) stop()
  }
}

/**
 * Draw every page link under `root` (`<span data-page-link="<id>">`, markdown.ts) as
 * the editor draws it: the title this reader may see, else the neutral label.
 * Answers a function that stops them all.
 */
export function hydratePageLinks(root: HTMLElement, deps: PageLinkDeps | null): () => void {
  const stops: Array<() => void> = []
  for (const span of root.querySelectorAll<HTMLElement>("span[data-page-link]")) {
    const id = span.getAttribute("data-page-link")
    if (!isPageId(id)) {
      span.replaceChildren()
      continue
    }
    stops.push(renderPageLink(span, id, deps))
  }
  return () => {
    for (const stop of stops) stop()
  }
}
