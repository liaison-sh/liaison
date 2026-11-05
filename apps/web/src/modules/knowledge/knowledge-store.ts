// SPDX-License-Identifier: FSL-1.1-ALv2
// Knowledge domain store — manages view state, search results, and home data
import type { KnowledgeSearchHit, KnowledgeSourceStatus } from "@liaison/shared"
import { createStore, produce } from "solid-js/store"
import { subscribeResync } from "~/framework/resync"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import type {
  CollectionTreeNode,
  KnowledgeHomeData,
  KnowledgeSearchParams,
  KnowledgeSearchResult,
} from "./knowledge-api"
import {
  runKnowledgeSearch as apiRunKnowledgeSearch,
  fetchKnowledgeHome,
  getCollectionsTree,
  listKnowledgeDocuments,
} from "./knowledge-api"

export type { KnowledgeSourceStatus } from "@liaison/shared"

export type KnowledgeView = "home" | "search" | "collection" | "tag" | "review" | "unfiled"

export interface KnowledgeDocListItem {
  id: string
  title: string
  updatedAt: string
  documentScope?: "personal" | "organization"
  status?: string
}

export interface KnowledgeDocument {
  id: string
  title: string
  body: string
  syncedSourceId?: string | null
  externalRev?: string | null
  lastSyncedAt?: string | null
  syncedSourceName?: string | null
  syncedSourceApp?: string | null
  [k: string]: unknown
}

interface KnowledgeState {
  view: KnowledgeView
  homeData: KnowledgeHomeData | null
  documents: KnowledgeDocListItem[]
  documentsLoading: boolean
  searchQuery: string
  searchResults: KnowledgeSearchHit[]
  sourceStatuses: KnowledgeSourceStatus[]
  searchLoading: boolean
  searchFinal: boolean
  sourceSettings: unknown | null
  collectionsTree: CollectionTreeNode[]
  /** Full document cache keyed by id. Populated by KnowledgeDocumentView on
   * open + by the synced-doc WS handler when a remote update arrives. */
  documentsById: Record<string, KnowledgeDocument>
  /** Doc ids currently pulsing "Refreshed just now" (Map<docId, true>). */
  pulseUpdatedIds: Record<string, true>
  /**
   * Set of synced_source ids the client has observed an `archive` event for
   * since session start. Used by the doc view to switch the synced banner to
   * "Source removed" (I4). Cleared on session teardown.
   */
  archivedSyncedSourceIds: Record<string, true>
  error: string | null
}

const [knowledgeStore, setKnowledgeStore] = createStore<KnowledgeState>({
  view: "home",
  homeData: null,
  documents: [],
  documentsLoading: false,
  searchQuery: "",
  searchResults: [],
  sourceStatuses: [],
  searchLoading: false,
  searchFinal: true,
  sourceSettings: null,
  collectionsTree: [],
  documentsById: {},
  pulseUpdatedIds: {},
  archivedSyncedSourceIds: {},
  error: null,
})

export { knowledgeStore }

export function setKnowledgeView(view: KnowledgeView): void {
  setKnowledgeStore("view", view)
}

export function setKnowledgeSearchLoading(v: boolean): void {
  setKnowledgeStore("searchLoading", v)
}

export function setKnowledgeSourceStatuses(v: KnowledgeSourceStatus[]): void {
  setKnowledgeStore("sourceStatuses", v)
}

// Last API client seen — captured so the resync subscription can refetch the
// active knowledge view without a component context.
let _knowledgeApi: ApiClient | null = null

export async function loadKnowledgeHome(api: ApiClient): Promise<void> {
  _knowledgeApi = api
  try {
    const data = await fetchKnowledgeHome(api)
    setKnowledgeStore("homeData", data)
    setKnowledgeStore("error", null)
  } catch (err) {
    setKnowledgeStore("error", err instanceof Error ? err.message : "Failed to load home")
  }
}

export async function searchKnowledge(
  api: ApiClient,
  params: KnowledgeSearchParams,
): Promise<void> {
  _knowledgeApi = api
  setKnowledgeStore(
    produce((s) => {
      s.searchLoading = true
      s.searchQuery = params.query
      s.searchResults = []
      s.sourceStatuses = []
      s.searchFinal = false
      s.view = "search"
    }),
  )
  try {
    const result: KnowledgeSearchResult = await apiRunKnowledgeSearch(api, params)
    setKnowledgeStore(
      produce((s) => {
        s.searchResults = result.hits
        s.sourceStatuses = result.sourceStatuses
        s.searchFinal = result.final
        s.searchLoading = false
      }),
    )
  } catch (err) {
    setKnowledgeStore(
      produce((s) => {
        s.searchLoading = false
        s.searchFinal = true
        s.error = err instanceof Error ? err.message : "Search failed"
      }),
    )
  }
}

export async function loadDocuments(api: ApiClient): Promise<void> {
  _knowledgeApi = api
  setKnowledgeStore("documentsLoading", true)
  try {
    const data = (await listKnowledgeDocuments(api)) as unknown[]
    const items: KnowledgeDocListItem[] = data.map((doc: any) => ({
      id: doc.id,
      title: doc.title,
      updatedAt: doc.updatedAt,
      documentScope: doc.documentScope,
      status: doc.status,
    }))
    setKnowledgeStore("documents", items)
    setKnowledgeStore("error", null)
  } catch (err) {
    setKnowledgeStore("error", err instanceof Error ? err.message : "Failed to load documents")
  } finally {
    setKnowledgeStore("documentsLoading", false)
  }
}

export async function loadCollectionsTree(api: ApiClient): Promise<void> {
  _knowledgeApi = api
  try {
    const tree = await getCollectionsTree(api)
    setKnowledgeStore("collectionsTree", tree)
    setKnowledgeStore("error", null)
  } catch (err) {
    setKnowledgeStore("error", err instanceof Error ? err.message : "Failed to load collections")
  }
}

// --- Resync subscription ---
// On a resync bump, refetch whichever knowledge surfaces are currently loaded,
// in place (each loader swaps its slice atomically — no wipe). Idempotent.
let _knowledgeResyncSubscribed = false

export function subscribeKnowledgeResync(): void {
  if (_knowledgeResyncSubscribed) return
  _knowledgeResyncSubscribed = true
  subscribeResync(() => {
    const api = _knowledgeApi
    if (!api) return
    if (knowledgeStore.homeData) void loadKnowledgeHome(api)
    if (knowledgeStore.documents.length > 0) void loadDocuments(api)
    if (knowledgeStore.collectionsTree.length > 0) void loadCollectionsTree(api)
    if (knowledgeStore.searchQuery) void searchKnowledge(api, { query: knowledgeStore.searchQuery })
  })
}

export function resetKnowledgeStore(): void {
  for (const t of pulseTimers.values()) clearTimeout(t)
  pulseTimers.clear()
  setKnowledgeStore({
    view: "home",
    homeData: null,
    documents: [],
    documentsLoading: false,
    searchQuery: "",
    searchResults: [],
    sourceStatuses: [],
    searchLoading: false,
    searchFinal: true,
    sourceSettings: null,
    collectionsTree: [],
    documentsById: {},
    pulseUpdatedIds: {},
    archivedSyncedSourceIds: {},
    error: null,
  })
}

// ---------------------------------------------------------------------------
// Document cache + WS-driven live update path (T-7)
// ---------------------------------------------------------------------------

const pulseTimers = new Map<string, ReturnType<typeof setTimeout>>()
const PULSE_MS = 3000

export function setKnowledgeStoreDocument(doc: KnowledgeDocument): void {
  setKnowledgeStore("documentsById", doc.id, doc)
}

export function getPulseUpdated(id: string): boolean {
  return knowledgeStore.pulseUpdatedIds[id] === true
}

/**
 * Mark a synced doc as "just refreshed" for a short window so the UI can show
 * a brief pulse / pill. Calling again before the timer expires resets the
 * timer rather than stacking (M-4).
 */
export function pulseDocumentUpdated(id: string): void {
  const existing = pulseTimers.get(id)
  if (existing) clearTimeout(existing)
  setKnowledgeStore("pulseUpdatedIds", id, true)
  const t = setTimeout(() => {
    setKnowledgeStore("pulseUpdatedIds", id, undefined as unknown as true)
    pulseTimers.delete(id)
  }, PULSE_MS)
  pulseTimers.set(id, t)
}

/**
 * Handle a knowledge:document:update event from the WS layer. H-6: short
 * circuit when the incoming externalRev matches the local rev (no refetch).
 *
 * Optional injected `fetchDoc` lets tests assert refetch behaviour without
 * mocking the global API client.
 */
export async function handleKnowledgeDocumentUpdate(
  data: { entityId?: string; id?: string; externalRev?: string | null; lastSyncAt?: string },
  fetchDoc: (id: string) => Promise<KnowledgeDocument | null>,
): Promise<void> {
  const entityId = data.entityId ?? data.id
  if (!entityId) return
  const incomingRev = data.externalRev ?? null
  const local = knowledgeStore.documentsById[entityId]
  // H-6: if the incoming externalRev matches what we already have, skip the
  // refetch. The store value is already current.
  if (incomingRev != null && local?.externalRev === incomingRev) return
  const fresh = await fetchDoc(entityId).catch(() => null)
  if (!fresh) return
  setKnowledgeStore("documentsById", entityId, fresh)
  pulseDocumentUpdated(entityId)
}

/**
 * I4: mark a synced_source id as "archived" so any open document tab whose
 * source is this id can render the "Source removed" banner state.
 *
 * Called by the bootstrap WS handler on `knowledge:synced_source:archive`.
 */
export function markSyncedSourceArchived(sourceId: string): void {
  setKnowledgeStore("archivedSyncedSourceIds", sourceId, true)
}

export function isSyncedSourceArchived(sourceId: string): boolean {
  return knowledgeStore.archivedSyncedSourceIds[sourceId] === true
}

// Expose the store on `window` in test/dev so E2E scenarios can inspect
// reactive state without depending on internal imports. Guarded so prod
// bundles don't leak the surface.
if (
  typeof window !== "undefined" &&
  (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development")
) {
  ;(
    window as unknown as { __KNOWLEDGE_STORE_FOR_TEST__: typeof knowledgeStore }
  ).__KNOWLEDGE_STORE_FOR_TEST__ = knowledgeStore
}

onSessionTeardown(resetKnowledgeStore)
