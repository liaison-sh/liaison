// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Document-number registry for tab labels. The kernel TabBar re-evaluates a
// view's `resolveLabel(entityId)` inside a reactive computation
// (`TabBar.tsx: displayLabel`), so backing the registry with a Solid signal
// makes a document tab rename itself to the invoice number the moment the
// number is known — from the documents list row on click, or from
// DocumentDetail's own load on a cold open.
import { createSignal } from "solid-js"

const [labels, setLabels] = createSignal<Record<string, string>>({})

export function rememberDocumentLabel(id: string, label: string | null | undefined): void {
  if (!id || !label) return
  setLabels((prev) => (prev[id] === label ? prev : { ...prev, [id]: label }))
}

/** Manifest-referenced (`views.tabTypes.detail.resolveLabel`) — the kernel
 *  calls this with the tab's entityId (the document id) and falls back to the
 *  view's static label while the number is still unknown. */
export function resolveDocumentTabLabel(entityId: string): string | undefined {
  return labels()[entityId]
}
