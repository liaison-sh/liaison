// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Markdown tables, made survivable in a narrow column.
//
// Message prose sets `word-break: break-word` so a pasted URL cannot blow out
// the bubble. A table inherits that, and a table forced to `width: 100%` in a
// 340px dock tab has nowhere to put "RETURNED": it breaks the word per
// character and the column reads "RE TUR NE D". The fix is the one every
// document renderer uses: the table keeps its natural width and the OVERFLOW
// is handed to a scrollable wrapper around it, with cells that never wrap.
//
// The geometry is written as INLINE style rather than a class because it is a
// guarantee, not a theme: a wrapper that does not actually scroll, or a cell
// that still wraps, is the bug coming back, and a test reads it back here.

/** Marks a table that has already been given its scroll container. */
export const TABLE_WRAP_CLASS = "md-table-wrap"

/**
 * Wrap every table under `root` in a horizontally scrollable container and
 * stop its cells wrapping. Idempotent: a table already wrapped keeps its
 * wrapper, and cells added later (a streamed table growing row by row) pick up
 * the rule on the next pass.
 */
export function wrapTableElements(root: ParentNode): void {
  for (const table of Array.from(root.querySelectorAll("table"))) {
    const doc = table.ownerDocument
    const parent = table.parentElement
    if (!parent?.classList.contains(TABLE_WRAP_CLASS)) {
      const wrap = doc.createElement("div")
      wrap.className = TABLE_WRAP_CLASS
      wrap.style.overflowX = "auto"
      wrap.style.maxWidth = "100%"
      table.parentNode?.insertBefore(wrap, table)
      wrap.appendChild(table)
    }
    // The table keeps its own width: the wrapper, not the words, absorbs the
    // overflow. `min-width` keeps a short table filling the column.
    table.style.width = "max-content"
    table.style.minWidth = "100%"
    for (const cell of Array.from(table.querySelectorAll("th, td"))) {
      ;(cell as HTMLElement).style.whiteSpace = "nowrap"
    }
  }
}

/** The same pass over a sanitized HTML string, for the innerHTML path. */
export function wrapMarkdownTables(html: string): string {
  if (!html.includes("<table")) return html
  const doc = new DOMParser().parseFromString(html, "text/html")
  wrapTableElements(doc.body)
  return doc.body.innerHTML
}
