// SPDX-License-Identifier: FSL-1.1-ALv2
// Task label catalog: every group and value of the org, archived ones
// included (the board filter lists them), loaded from `projects:labels.list`.
// Pickers derive the live lists. Any `label` event refetches the whole list.
import { createStore } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { runTool } from "~/lib/run-tool"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { registerTaskLabelSanitizer } from "~/modules/projects/projects-filter-store"
import { sanitizeLabelFilter, type TaskLabel } from "~/modules/projects/task-labels"

export interface LabelValue {
  id: string
  groupId: string
  name: string
  sortOrder: number
  archivedAt: string | null
  /** Own archive stamp or the group's. */
  archived: boolean
}

export interface LabelGroup {
  id: string
  name: string
  sortOrder: number
  archivedAt: string | null
  values: LabelValue[]
}

interface CatalogState {
  groups: LabelGroup[]
  loaded: boolean
  loading: boolean
  failed: boolean
}

const initialState = (): CatalogState => ({
  groups: [],
  loaded: false,
  loading: false,
  failed: false,
})

const [state, setState] = createStore<CatalogState>(initialState())

let lastApi: ApiClient | null = null
let inFlight: Promise<void> | null = null
/**
 * Bumped by every load and by the reset: a response whose generation is no
 * longer current (an older fetch overtaken by a newer one, or a fetch still
 * running at session teardown) is dropped instead of overwriting the store.
 */
let generation = 0

/** `projects:labels.list` answers `{ groups }`, camelCase, `archived` on each value. */
function groupsOf(result: unknown): LabelGroup[] {
  const groups = (result as { groups?: unknown } | null)?.groups
  return Array.isArray(groups) ? (groups as LabelGroup[]) : []
}

export function loadLabelCatalog(api: ApiClient): Promise<void> {
  lastApi = api
  generation += 1
  setState("loading", true)
  const run = fetchCatalog(api, generation).finally(() => {
    if (inFlight === run) {
      inFlight = null
      setState("loading", false)
    }
  })
  inFlight = run
  return run
}

async function fetchCatalog(api: ApiClient, gen: number): Promise<void> {
  try {
    const result = await runTool<unknown>(api, "projects:labels.list", { includeArchived: true })
    if (gen !== generation) return
    setState({ groups: groupsOf(result), loaded: true, failed: false })
  } catch {
    // runTool already toasted the failure.
    if (gen !== generation) return
    setState("failed", true)
  }
}

/**
 * Load once: no-op when loaded, the in-flight promise while loading. A failed
 * load is not retried here (each retry would toast again); a `label` event or
 * an explicit `loadLabelCatalog` reloads it.
 */
export function ensureLabelCatalog(api: ApiClient): Promise<void> {
  if (inFlight) return inFlight
  if (state.loaded || state.failed) return Promise.resolve()
  return loadLabelCatalog(api)
}

/** Any `label` event (created/updated/archived/restored/reordered): refetch the list. */
export function handleLabelEvent(_action: string, _data: unknown): void {
  if (!lastApi) return
  void loadLabelCatalog(lastApi)
}

export function resetLabelCatalogStore(): void {
  lastApi = null
  inFlight = null
  generation += 1
  setState(initialState())
}

export const labelCatalog = {
  /** All groups, archived included, each with all its values. */
  get groups(): LabelGroup[] {
    return state.groups
  },
  get loaded(): boolean {
    return state.loaded
  },
  get loading(): boolean {
    return state.loading
  },
  get failed(): boolean {
    return state.failed
  },
  /** Live groups, each with its live values only. */
  liveGroups(): LabelGroup[] {
    return state.groups
      .filter((g) => g.archivedAt === null)
      .map((g) => ({ ...g, values: g.values.filter((v) => !v.archived) }))
  },
  /** Group ids in catalog order (archived included). */
  groupOrder(): string[] {
    return state.groups.map((g) => g.id)
  },
  group(id: string): LabelGroup | undefined {
    return state.groups.find((g) => g.id === id)
  },
  /**
   * Names and archive state of a task's label entry. The catalog wins when it
   * knows the value, so a rename, an archive or a restore shows at once on
   * every chip; the payload's own fields are the fallback.
   */
  displayName(entry: TaskLabel): { groupName: string; valueName: string; archived: boolean } {
    const group = state.groups.find((g) => g.id === entry.groupId)
    const value = group?.values.find((v) => v.id === entry.valueId)
    return {
      groupName: group?.name ?? entry.groupName,
      valueName: value?.name ?? entry.valueName,
      archived: value?.archived ?? entry.archived,
    }
  },
}

onSessionTeardown(resetLabelCatalogStore)
// Once the catalog has loaded, the board filter forgets the ids it no longer knows.
registerTaskLabelSanitizer((raw) => (state.loaded ? sanitizeLabelFilter(raw, state.groups) : raw))
