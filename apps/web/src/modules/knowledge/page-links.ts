// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The titles of linked pages, as this reader may see them. A page's text holds only
// ids (`[](knowledge:document:<id>)`); every chip asks this resolver, which batches
// the ids of a tick into one `POST /knowledge/documents/resolve` (at most 200 each).
// The server answers live pages the reader may read; any other id is absent, and its
// chip is "Page you cannot open". A rename or a move to Trash, told by the page's
// `document:update` event, asks again for the chips that show that page.
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { isPageId, type PageLinkDeps, type PageLinkTitle } from "~/modules/editor/page-link-view"
import type { EditorPages } from "~/modules/editor/RichEditor"
import type { Translate } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"

type Api = Pick<ApiClient, "get" | "post">

/** The server's cap on ids per resolve call. */
export const RESOLVE_BATCH = 200

const titles = new Map<string, string | null>()
const watchers = new Map<string, Set<(title: PageLinkTitle) => void>>()
const queued = new Set<string>()
let flushing: Api | null = null

function notify(key: string): void {
  const title = titles.get(key)
  for (const fn of watchers.get(key) ?? []) fn(title)
}

async function resolveNow(api: Api, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += RESOLVE_BATCH) {
    const chunk = ids.slice(i, i + RESOLVE_BATCH)
    let found: Array<{ id: string; title: string }>
    try {
      found = await api.post<Array<{ id: string; title: string }>>(
        "/knowledge/documents/resolve",
        { ids: chunk },
        { suppressGlobalError: true },
      )
    } catch {
      // Not an answer: the chips show the neutral label, and are asked again later.
      for (const key of chunk) {
        for (const fn of watchers.get(key) ?? []) fn(null)
      }
      continue
    }
    const byId = new Map((found ?? []).map((p) => [String(p.id).toLowerCase(), p.title]))
    for (const key of chunk) {
      const title = byId.get(key)
      titles.set(key, typeof title === "string" ? title : null)
      notify(key)
    }
  }
}

/** Ask for `key` with the other ids asked in the same tick. */
function request(api: Api, key: string): void {
  queued.add(key)
  if (flushing) return
  flushing = api
  queueMicrotask(() => {
    const ids = [...queued]
    queued.clear()
    flushing = null
    void resolveNow(api, ids)
  })
}

/** Follow page `id`'s title for this reader (see PageLinkDeps.watch). */
export function watchPageTitle(
  api: Api,
  id: string,
  fn: (title: PageLinkTitle) => void,
): () => void {
  if (!isPageId(id)) {
    fn(null)
    return () => {}
  }
  const key = id.toLowerCase()
  let set = watchers.get(key)
  if (!set) {
    set = new Set()
    watchers.set(key, set)
  }
  set.add(fn)
  if (titles.has(key)) fn(titles.get(key))
  else request(api, key)
  return () => {
    const now = watchers.get(key)
    now?.delete(fn)
    if (now && now.size === 0) watchers.delete(key)
  }
}

/**
 * Page `id` changed (renamed, moved to Trash, restored, shared): the chips showing it
 * ask again. Nothing is asked for a page no chip shows.
 */
export function refreshPageTitle(api: Api | null | undefined, id: string | undefined): void {
  if (!id || !isPageId(id)) return
  const key = id.toLowerCase()
  titles.delete(key)
  if (api && watchers.has(key)) request(api, key)
}

/** Pages the writer may link to (the server checks the writer's read right). */
export async function pickPages(
  api: Api,
  query: string,
  exclude?: string,
): Promise<Array<{ id: string; title: string }>> {
  const q = query.trim().slice(0, 200)
  const rows = await api.get<Array<{ id: string; title: string }>>(
    `/knowledge/documents/pick${q ? `?q=${encodeURIComponent(q)}` : ""}`,
    { suppressGlobalError: true },
  )
  const pages = (rows ?? []).filter(
    (p) => isPageId(p.id) && p.id.toLowerCase() !== exclude?.toLowerCase(),
  )
  // The writer may read each of them: their titles are known without asking.
  for (const p of pages) {
    const key = p.id.toLowerCase()
    if (titles.get(key) !== p.title) {
      titles.set(key, p.title)
      notify(key)
    }
  }
  return pages
}

/** Forget every title (sign-out, another person). */
export function resetPageTitles(): void {
  titles.clear()
  queued.clear()
}
onSessionTeardown(resetPageTitles)

/** How a page's chips get their titles and open their page. */
export function pageLinkDeps(api: Api, t: Translate): PageLinkDeps {
  return {
    watch: (id, fn) => watchPageTitle(api, id, fn),
    open: (id, title) => openTab({ type: "knowledge:document", entityId: id, label: title }),
    labels: {
      unavailable: t("kernel.editor.pageUnavailable"),
      loading: t("kernel.editor.pageLink"),
    },
  }
}

/** The editor's page links for page `pageId`: chips, and the picker without the page itself. */
export function editorPages(api: Api, t: Translate, pageId: string): EditorPages {
  return {
    link: pageLinkDeps(api, t),
    pick: (query) => pickPages(api, query, pageId),
  }
}
