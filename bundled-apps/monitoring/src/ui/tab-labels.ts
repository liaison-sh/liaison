// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Source labels for tab names. The kernel tab strip re-evaluates a tab type's
// `resolveLabel(entityId)` reactively, so backing it with a Solid signal makes
// a source tab rename itself to the source's profile label as soon as any
// monitoring view (sidebar, source page) has loaded the summary. Until then
// the tab shows the raw source id, never the generic type name.
import { createSignal } from "solid-js"
import { decodeSourceId } from "./sources"

const [labels, setLabels] = createSignal<Record<string, string>>({})

export function rememberSourceLabels(views: ReadonlyArray<{ source: string; label: string }>): void {
  setLabels((prev) => {
    let next = prev
    for (const v of views) {
      if (!v.source || !v.label || next[v.source] === v.label) continue
      if (next === prev) next = { ...prev }
      next[v.source] = v.label
    }
    return next
  })
}

/** Manifest-referenced (`views.tabTypes.source.resolveLabel`): the tab's entity
 *  id is the (URL encoded) source id. Profile label when known, else the raw id. */
export function resolveSourceTabLabel(entityId: string): string | undefined {
  const source = decodeSourceId(entityId)
  if (!source) return undefined
  return labels()[source] ?? source
}
