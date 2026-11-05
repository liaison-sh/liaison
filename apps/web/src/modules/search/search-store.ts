// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore, produce } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface SearchHit {
  id: string
  app: string
  entity_type: string
  entity_id?: string
  title?: string
  body?: string
  source?: string
  [k: string]: unknown
}

export interface SearchStoreState {
  query: string
  hits: SearchHit[]
  total: number
  limit: number
  offset: number
  loading: boolean
  unavailable: boolean
  filters: { app?: string[]; entityType?: string[]; dimensions?: Record<string, string[]> }
}

const initial: SearchStoreState = {
  query: "",
  hits: [],
  total: 0,
  limit: 25,
  offset: 0,
  loading: false,
  unavailable: false,
  filters: {},
}

const [store, setStore] = createStore<SearchStoreState>({ ...initial })

let debounceTimer: ReturnType<typeof setTimeout> | null = null
let seq = 0

const DEBOUNCE_MS = 200

export const searchStore = store

export function resetSearchStore(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = null
  seq++
  setStore({ ...initial, filters: {} })
}

onSessionTeardown(resetSearchStore)

function buildPath(state: SearchStoreState): string {
  const params = new URLSearchParams()
  params.set("q", state.query)
  params.set("limit", String(state.limit))
  params.set("offset", String(state.offset))
  if (state.filters.app?.length) params.set("app", state.filters.app.join(","))
  if (state.filters.entityType?.length) params.set("entityType", state.filters.entityType.join(","))
  const dims = state.filters.dimensions ?? {}
  const nonEmpty = Object.fromEntries(
    Object.entries(dims).filter(([, v]) => Array.isArray(v) && v.length > 0),
  )
  if (Object.keys(nonEmpty).length > 0) params.set("filters", JSON.stringify(nonEmpty))
  return `/search/page?${params.toString()}`
}

/** Initialize the store query from a `?q=` URL fragment (idempotent). */
export function initFromUrlQuery(api: ApiClient, queryString: string): void {
  const sp = new URLSearchParams(queryString)
  const q = sp.get("q") ?? ""
  if (!q) return
  setQuery(q, api)
}

async function runSearch(api: ApiClient): Promise<void> {
  const current = ++seq
  const state = store
  if (!state.query.trim()) {
    setStore(
      produce((s) => {
        s.hits = []
        s.total = 0
        s.loading = false
      }),
    )
    return
  }
  setStore("loading", true)
  try {
    const env = await api.getEnvelope<SearchHit[]>(buildPath(state))
    if (current !== seq) return
    const meta = (env.meta ?? {}) as { total?: number; limit?: number; offset?: number }
    setStore(
      produce((s) => {
        s.hits = env.data ?? []
        s.total = meta.total ?? env.data?.length ?? 0
        s.unavailable = false
        s.loading = false
      }),
    )
  } catch (err) {
    if (current !== seq) return
    if (err instanceof ApiError && (err.code === "SEARCH_UNAVAILABLE" || err.status === 503)) {
      setStore(
        produce((s) => {
          s.unavailable = true
          s.loading = false
          s.hits = []
          s.total = 0
        }),
      )
      return
    }
    setStore(
      produce((s) => {
        s.loading = false
        s.hits = []
        s.total = 0
      }),
    )
  }
}

function scheduleRun(api: ApiClient): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    void runSearch(api)
  }, DEBOUNCE_MS)
}

export function setQuery(query: string, api: ApiClient): void {
  setStore(
    produce((s) => {
      s.query = query
      s.offset = 0
      s.unavailable = false
    }),
  )
  scheduleRun(api)
}

export function setOffset(offset: number, api: ApiClient): void {
  setStore("offset", Math.max(0, offset))
  void runSearch(api)
}

export function setFilters(
  filters: { app?: string[]; entityType?: string[]; dimensions?: Record<string, string[]> },
  api: ApiClient,
): void {
  setStore(
    produce((s) => {
      s.filters = filters
      s.offset = 0
    }),
  )
  scheduleRun(api)
}

export function toggleAppFilter(app: string, api: ApiClient): void {
  const cur = new Set(searchStore.filters.app ?? [])
  if (cur.has(app)) cur.delete(app)
  else cur.add(app)
  setFilters({ ...searchStore.filters, app: Array.from(cur) }, api)
}

export function toggleEntityTypeFilter(entityType: string, api: ApiClient): void {
  const cur = new Set(searchStore.filters.entityType ?? [])
  if (cur.has(entityType)) cur.delete(entityType)
  else cur.add(entityType)
  setFilters({ ...searchStore.filters, entityType: Array.from(cur) }, api)
}

export function clearFilters(api: ApiClient): void {
  setFilters({}, api)
}
