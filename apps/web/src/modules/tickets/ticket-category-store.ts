// SPDX-License-Identifier: FSL-1.1-ALv2
// Ticket category store — flat tree of categories used by sidebar + composer.
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { runTool } from "~/lib/run-tool"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type { TicketCategory } from "./ticket-types"

interface CategoryState {
  categories: TicketCategory[]
  loaded: boolean
  loading: boolean
}

const [ticketCategoryStore, setTicketCategoryStore] = createStore<CategoryState>({
  categories: [],
  loaded: false,
  loading: false,
})

export { ticketCategoryStore }

/**
 * The wire row of `tickets:categories.list` (admin.ts categoriesList) is
 * snake_case: `parent_id`, `sort_order`, `archived_at`. The store is typed
 * camelCase and every consumer reads `parentId` / `archivedAt`, so an
 * unmapped row made EVERY category a root and no category archived: the
 * settings tree listed each child as a top-level entry ("Under Achat non
 * comptabilisé" three times, once per escalation level, which read as
 * duplicates) and the archived probe row reappeared. Found on the Acme
 * walk, 2026-09-22. Accepts either shape so a camelCase row (tests, realtime
 * events carrying the tool params) passes through unchanged.
 */
export function normalizeCategory(row: Record<string, unknown>): TicketCategory {
  const pick = (camel: string, snake: string): unknown =>
    row[camel] !== undefined ? row[camel] : row[snake]
  const sort = Number(pick("sortOrder", "sort_order") ?? 0)
  return {
    id: String(row.id),
    parentId: (pick("parentId", "parent_id") as string | null | undefined) ?? null,
    name: String(row.name ?? ""),
    sortOrder: Number.isFinite(sort) ? sort : 0,
    archivedAt: (pick("archivedAt", "archived_at") as string | null | undefined) ?? null,
  }
}

export async function loadCategories(api: ApiClient): Promise<void> {
  setTicketCategoryStore("loading", true)
  try {
    const list = await runTool<Record<string, unknown>[]>(api, "tickets:categories.list", {})
    setTicketCategoryStore(
      produce((s) => {
        s.categories = Array.isArray(list) ? list.map(normalizeCategory) : []
        s.loaded = true
      }),
    )
  } finally {
    setTicketCategoryStore("loading", false)
  }
}

export function handleCategoryEvent(action: string, data: any): void {
  if (!data?.id) return
  setTicketCategoryStore(
    produce((s) => {
      if (action === "create") {
        if (!s.categories.some((c) => c.id === data.id)) s.categories.push(normalizeCategory(data))
      } else if (action === "update") {
        const idx = s.categories.findIndex((c) => c.id === data.id)
        if (idx >= 0) {
          const patch = (data.changes ?? data) as Record<string, unknown>
          // Patch fields win in either spelling; fields it does not name keep
          // the stored value.
          const camel: Record<string, unknown> = { ...s.categories[idx] }
          for (const [k, v] of Object.entries(patch)) {
            camel[k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())] = v
          }
          s.categories[idx] = normalizeCategory(camel)
        }
      } else if (action === "archive") {
        const idx = s.categories.findIndex((c) => c.id === data.id)
        if (idx >= 0) {
          s.categories[idx] = { ...s.categories[idx], archivedAt: new Date().toISOString() }
        }
      }
    }),
  )
}

export function resetTicketCategoryStore(): void {
  setTicketCategoryStore({ categories: [], loaded: false, loading: false })
}

onSessionTeardown(resetTicketCategoryStore)
