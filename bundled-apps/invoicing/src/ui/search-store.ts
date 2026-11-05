// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared document-search signal. The Invoicing sidebar and the documents-list
// toolbar live in two separate render roots (the kernel mounts the sidebar
// shell and the main tab panel independently). In the page they run in the
// SAME JS bundle, so a module-level Solid signal is reactive across both: the
// sidebar's "Search documents..." box drives the documents table's filter live
// (and vice-versa) without threading props through the kernel tab router.
//
// When the app's UI runs framed, each view is its own frame with its own copy
// of this module, and the signal reaches no other view. The search therefore
// also travels in the route: Enter in the sidebar box opens the documents list
// at `?q=<search>`, and the list takes the search from its route.
import { createSignal } from "solid-js"

export const [documentSearch, setDocumentSearch] = createSignal("")

const DOCUMENTS_PREFIX = "/invoicing/documents/"
const ALL_DOCUMENTS = "/invoicing/documents/all"

/** The search a path carries (`?q=`), or null when it carries none. */
export function searchInPath(path: string): string | null {
  const at = path.indexOf("?")
  if (at === -1) return null
  return new URLSearchParams(path.slice(at + 1).replace(/#.*$/, "")).get("q")
}

/** The documents route for a search: the list on view when it is one, else all documents. */
export function documentsSearchTarget(path: string, query: string): string {
  const pathname = path.replace(/[?#].*$/, "")
  const base = pathname.startsWith(DOCUMENTS_PREFIX) ? pathname : ALL_DOCUMENTS
  return query ? `${base}?q=${encodeURIComponent(query)}` : base
}
