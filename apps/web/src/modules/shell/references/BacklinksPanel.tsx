// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
  Suspense,
} from "solid-js"
import { apiUrl } from "~/lib/env"
import { accessToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openTab } from "~/modules/shell/tab-store"

function backlinksAuthHeaders(): Record<string, string> {
  const token = accessToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface BacklinkRow {
  threadId: string
  handle: string
  title: string | null
  updatedAt: string
}

interface BacklinksPanelProps {
  app: string
  entityType: string
  entityId: string
  pageSize?: number
}

async function fetchBacklinks(
  app: string,
  entityType: string,
  entityId: string,
  limit: number,
  offset: number,
  signal?: AbortSignal,
): Promise<BacklinkRow[]> {
  const url = apiUrl(
    `/references?app=${encodeURIComponent(app)}&entityType=${encodeURIComponent(
      entityType,
    )}&entityId=${encodeURIComponent(entityId)}&limit=${limit}&offset=${offset}`,
  )
  const res = await fetch(url, { headers: backlinksAuthHeaders(), signal })
  if (!res.ok) return []
  const body = await res.json().catch(() => ({}))
  return body?.data ?? []
}

// Own Suspense boundary: the resource read below must never propagate to the
// tab-level <Suspense> in MainPanel — that would blank the entire tab while
// backlinks load (the "ticket keeps reloading" blink).
export const BacklinksPanel: Component<BacklinksPanelProps> = (props) => (
  <Suspense fallback={null}>
    <BacklinksPanelInner {...props} />
  </Suspense>
)

const BacklinksPanelInner: Component<BacklinksPanelProps> = (props) => {
  const i18n = useI18n()
  const pageSize = () => props.pageSize ?? 10
  const [pages, setPages] = createSignal(1)
  const [extraRows, setExtraRows] = createSignal<BacklinkRow[]>([])

  // Source is a primitive key, not a fresh object literal — an object source
  // gets a new reference on every upstream re-evaluation and refetches even
  // when nothing changed.
  const sourceKey = (): string => `${props.app}:${props.entityType}:${props.entityId}`

  let activeController: AbortController | null = null
  onCleanup(() => activeController?.abort())
  // The resolved value carries the key it was fetched for so `allRows` can tell
  // a fresh result apart from the previous entity's value that `createResource`
  // keeps returning during a refetch (its stale-while-revalidate behavior).
  // Most hosts remount this panel per entity, but a singleton detail surface can
  // swap `entityId` on a live instance — without the key guard + the pagination
  // reset below, the new entity would briefly render the previous one's rows and
  // permanently inherit its accumulated "Show more" pages.
  const [firstPage] = createResource(sourceKey, async (key) => {
    activeController?.abort()
    const ac = new AbortController()
    activeController = ac
    // Entity changed (or a refetch started): drop any accumulated extra pages
    // so they can't leak onto a different entity. Resetting in the fetcher is
    // the reactive "on source change" hook — it reads nothing `allRows` writes,
    // so there is no feedback loop.
    setExtraRows([])
    setPages(1)
    try {
      const rows = await fetchBacklinks(
        props.app,
        props.entityType,
        props.entityId,
        pageSize(),
        0,
        ac.signal,
      )
      return { key, rows }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err
      return { key, rows: null as BacklinkRow[] | null }
    }
  })

  const allRows = createMemo<BacklinkRow[] | null>(() => {
    const first = firstPage()
    if (!first) return null // initial load (undefined)
    if (first.key !== sourceKey()) return null // stale value from a prior entity
    if (first.rows === null) return null // fetch failed — stay hidden (calm UI)
    return [...first.rows, ...extraRows()]
  })

  async function loadMore() {
    const next = await fetchBacklinks(
      props.app,
      props.entityType,
      props.entityId,
      pageSize(),
      pages() * pageSize(),
    )
    if (next.length === 0) return
    setExtraRows((prev) => [...prev, ...next])
    setPages((p) => p + 1)
  }

  function openThread(row: BacklinkRow) {
    openTab({ type: "thread", entityId: row.threadId, label: row.handle })
  }

  return (
    <Show when={allRows() && (allRows() as BacklinkRow[]).length > 0}>
      <div
        class="flex flex-col gap-2 rounded border border-border bg-surface p-3"
        data-testid="backlinks-panel"
        data-app={props.app}
        data-entity-type={props.entityType}
        data-entity-id={props.entityId}
      >
        <div class="text-xs font-medium text-text-secondary">
          {(allRows() as BacklinkRow[]).length === 1
            ? i18n.t("kernel.shellUi.referencedInOne")
            : i18n.t("kernel.shellUi.referencedInMany", {
                count: (allRows() as BacklinkRow[]).length,
              })}
        </div>
        <ul class="flex flex-col gap-1">
          <For each={allRows() as BacklinkRow[]}>
            {(row) => (
              <li>
                <button
                  type="button"
                  class="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm hover:bg-surface-hover"
                  data-testid={`backlink-row-${row.threadId}`}
                  onClick={() => openThread(row)}
                >
                  <span class="truncate text-text">{row.handle}</span>
                  <Show when={row.title}>
                    <span class="truncate text-xs text-text-tertiary">{row.title}</span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
        <Show
          when={
            allRows() &&
            (allRows() as BacklinkRow[]).length >= pages() * pageSize() &&
            extraRows().length % pageSize() === 0
          }
        >
          <button
            type="button"
            class="self-start rounded border border-border px-2 py-1 text-xs text-text-secondary hover:bg-surface-hover"
            data-testid="backlinks-show-more"
            onClick={() => void loadMore()}
          >
            {i18n.t("kernel.common.showMore")}
          </button>
        </Show>
      </div>
    </Show>
  )
}
