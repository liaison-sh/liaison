// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE JUMP FROM A QUOTE TO ITS SOURCE (S14).
//
// The source is found by its row's `data-message-id` inside one scroll
// container (the channel list, or a reply panel). A source above the loaded
// window is reached by loading older pages, at most ten, and a source that is
// still not there is said to be missing rather than silently not scrolled to.

/** Pages loaded, at most, while looking for a source. */
export const MAX_JUMP_PAGES = 10

/** How long the source stays highlighted once reached. */
const HIGHLIGHT_MS = 1600

function findRow(container: HTMLElement | null | undefined, messageId: string): HTMLElement | null {
  if (!container) return null
  // Message ids are uuids (or the client's own `pending-…`): a quote or a
  // backslash in one is not a message id at all.
  if (/["\\]/.test(messageId)) return null
  return container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
}

/** Scrolls a row into view and marks it for a moment (`data-quote-highlight`).
 *  `behavior` defaults to a smooth scroll, for a source already on the page. */
export function highlightRow(row: HTMLElement, behavior: ScrollBehavior = "smooth"): void {
  row.dataset.quoteHighlight = "true"
  if (typeof row.scrollIntoView === "function") {
    row.scrollIntoView({ block: "center", behavior })
  }
  setTimeout(() => {
    delete row.dataset.quoteHighlight
  }, HIGHLIGHT_MS)
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 16)
  })
}

function inView(container: HTMLElement | null | undefined, row: HTMLElement): boolean {
  if (!container) return true
  const box = container.getBoundingClientRect()
  const r = row.getBoundingClientRect()
  return r.bottom > box.top && r.top < box.bottom
}

export async function jumpToMessage(opts: {
  container: () => HTMLElement | null | undefined
  messageId: string
  hasMore: () => boolean
  loadMore: () => Promise<void>
  onMissing: () => void
  maxPages?: number
}): Promise<boolean> {
  const maxPages = opts.maxPages ?? MAX_JUMP_PAGES
  let row = findRow(opts.container(), opts.messageId)
  let pages = 0
  while (!row && pages < maxPages && opts.hasMore()) {
    await opts.loadMore()
    pages++
    // The list renders the page it was handed before this resumes.
    await Promise.resolve()
    row = findRow(opts.container(), opts.messageId)
  }
  if (!row) {
    opts.onMissing()
    return false
  }
  if (pages === 0) {
    highlightRow(row)
    return true
  }
  // QUO-03. The older page was just inserted ABOVE the reader, and at the next
  // layout the browser keeps her reading position (scroll anchoring), which
  // cancels a smooth scroll started in the same moment: the source was
  // highlighted thousands of pixels off screen. So the scroll waits for that
  // layout, is instant (nothing left to cancel it), and is checked once more a
  // frame later in case the list moved again (a prefetch at the top).
  await nextFrame()
  await nextFrame()
  row = findRow(opts.container(), opts.messageId) ?? row
  highlightRow(row, "auto")
  await nextFrame()
  if (row.isConnected && !inView(opts.container(), row)) {
    row.scrollIntoView?.({ block: "center", behavior: "auto" })
  }
  return true
}
