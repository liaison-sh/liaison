// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore } from "solid-js/store"
import { type EntityChangeEvent, onEntityChange } from "~/framework/entity-changes"
import { subscribeResync } from "~/framework/resync"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface Project {
  id: string
  /** The task-key prefix, e.g. "ERB" in ERB-12. */
  key?: string | null
  name: string
  description: string | null
  icon: string | null
  color: string | null
  /** Sidebar group heading; null or absent = ungrouped (project-groups.ts). */
  group?: string | null
  ownerId: string
  owner?: { id: string; name: string; avatarUrl: string | null }
  taskCount: number
  archivedAt: string | null
  updatedAt: string
}

type ProjectsState = {
  items: Project[]
  loading: boolean
  loaded: boolean
  error: string | null
  /** Archived projects, fetched on demand (the sidebar's "Archived" fold). */
  archived: Project[]
  archivedLoaded: boolean
}

const [state, setState] = createStore<ProjectsState>({
  items: [],
  loading: false,
  loaded: false,
  error: null,
  archived: [],
  archivedLoaded: false,
})

// The list endpoint pages at 25 by default (100 max). The sidebar and home are
// the whole project list, so a bare `/projects` silently hid every project past
// the 25th. Follow the cursor instead, bounded so a server bug cannot loop.
const PAGE_LIMIT = 100
const MAX_PAGES = 20

async function fetchAllProjects(api: ApiClient, archived: "exclude" | "only"): Promise<Project[]> {
  const out: Project[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) })
    if (archived === "only") params.set("archived", "only")
    if (cursor) params.set("cursor", cursor)
    const data: { items?: Project[]; nextCursor?: string | null } = await api.get(
      `/projects?${params.toString()}`,
    )
    out.push(...(data.items ?? []))
    cursor = data.nextCursor ?? null
    if (!cursor) break
  }
  return out
}

// Last API client seen — captured so the resync subscription can refetch the
// project list without a component context.
let _projectsApi: ApiClient | null = null

export async function loadProjects(api: ApiClient): Promise<void> {
  _projectsApi = api
  setState({ loading: true, error: null })
  try {
    const items = await fetchAllProjects(api, "exclude")
    setState({ items, loading: false, loaded: true })
  } catch (err) {
    setState({ loading: false, error: (err as Error).message })
  }
}

export async function loadArchivedProjects(api: ApiClient): Promise<void> {
  _projectsApi = api
  const archived = await fetchAllProjects(api, "only")
  setState({ archived, archivedLoaded: true })
}

// --- Resync subscription ---
// On a resync bump, refetch the project list in place ONLY if it has been
// loaded (loadProjects keeps items until the fresh page lands — no wipe).
// Idempotent.
let _projectsResyncSubscribed = false

export function subscribeProjectsResync(): void {
  if (_projectsResyncSubscribed) return
  _projectsResyncSubscribed = true
  subscribeResync(() => {
    const api = _projectsApi
    if (api && state.loaded) void loadProjects(api)
    if (api && state.archivedLoaded) void loadArchivedProjects(api).catch(() => {})
  })
  // `taskCount` is computed server-side and loaded once: a task created,
  // deleted, restored or moved to another project by anyone refetches the list
  // (once per burst). A field update or a move within a project (reorder,
  // status column, bulk status move) never changes a count. Resync is covered
  // above.
  onEntityChange(
    "projects:task",
    (events) => {
      const countChanged = events.some((e) => !e.resync && taskEventChangesCount(e))
      const api = _projectsApi
      if (countChanged && api && state.loaded) void loadProjects(api)
    },
    { debounceMs: 1000, maxWaitMs: 3000 },
  )
}

const TASK_COUNT_ACTIONS = new Set(["created", "deleted", "restored"])

function taskEventChangesCount(e: EntityChangeEvent): boolean {
  if (TASK_COUNT_ACTIONS.has(e.action)) return true
  if (e.action !== "moved") return false
  const data = (e.data ?? {}) as Record<string, unknown>
  // Only a cross-project move carries `fromProjectId` (move-task.ts).
  return typeof data.fromProjectId === "string" && data.fromProjectId !== data.projectId
}

function upsert(p: Project): void {
  const idx = state.items.findIndex((x) => x.id === p.id)
  if (idx >= 0) {
    setState("items", idx, p)
  } else {
    setState("items", [p, ...state.items])
  }
}

function remove(id: string): void {
  setState(
    "items",
    state.items.filter((p) => p.id !== id),
  )
}

/**
 * A project was archived (by this user or, via the WS echo, anyone). It stays
 * in `items` with `archivedAt` set, which every list already filters out, and
 * joins the archived fold if that has been fetched.
 */
function markArchived(id: string, archivedAt: string, fallback?: Project): void {
  const idx = state.items.findIndex((p) => p.id === id)
  if (idx >= 0) setState("items", idx, "archivedAt", archivedAt)
  if (!state.archivedLoaded) return
  const source = (idx >= 0 ? state.items[idx] : undefined) ?? fallback
  if (!source) return
  const entry = { ...source, archivedAt }
  const aIdx = state.archived.findIndex((p) => p.id === id)
  if (aIdx >= 0) setState("archived", aIdx, entry)
  else setState("archived", [entry, ...state.archived])
}

/**
 * A project was restored: it leaves the archived fold and rejoins the active
 * list. A project this client never had (archived before the page loaded, and
 * the fold never opened) is refetched rather than invented from an event that
 * carries only its id.
 */
function markRestored(id: string, fallback?: Project): void {
  const source =
    state.items.find((p) => p.id === id) ?? state.archived.find((p) => p.id === id) ?? fallback
  setState(
    "archived",
    state.archived.filter((p) => p.id !== id),
  )
  if (source) {
    upsert({ ...source, archivedAt: null })
  } else if (_projectsApi && state.loaded) {
    void loadProjects(_projectsApi)
  }
}

export const projectsStore = {
  get items() {
    return state.items
  },
  get loading() {
    return state.loading
  },
  get loaded() {
    return state.loaded
  },
  get error() {
    return state.error
  },
  /** Archived projects: the fetched fold plus any archived in this session,
   *  minus any since restored. */
  get archivedItems(): Project[] {
    const activeIds = new Set(state.items.filter((p) => !p.archivedAt).map((p) => p.id))
    const byId = new Map<string, Project>()
    for (const p of state.archived) if (!activeIds.has(p.id)) byId.set(p.id, p)
    for (const p of state.items) if (p.archivedAt) byId.set(p.id, p)
    return [...byId.values()]
  },
  get archivedLoaded() {
    return state.archivedLoaded
  },
  byId: (id: string) => state.items.find((p) => p.id === id),
  load: loadProjects,
  loadArchived: loadArchivedProjects,
  upsert,
  remove,
  markArchived,
  markRestored,
  _setForTest(s: Partial<ProjectsState>) {
    setState(s)
  },
}

/** Reset on logout so a new session cannot see the previous user's projects (cross-account leak). */
export function resetProjectsStore(): void {
  setState({
    items: [],
    loading: false,
    loaded: false,
    error: null,
    archived: [],
    archivedLoaded: false,
  })
}
onSessionTeardown(resetProjectsStore)
