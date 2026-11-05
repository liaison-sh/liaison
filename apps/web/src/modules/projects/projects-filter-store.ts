// SPDX-License-Identifier: FSL-1.1-ALv2
// Sidebar filter state for the Projects app.
//
// One canonical source of truth: search query, assigned-to-me toggle, and a set
// of *labels* (lowercase, e.g. "todo", "in_progress", "doing") to include.
// Labels (not IDs) so the same toggle survives switching between projects with
// matching custom statuses, and so projects-home can filter without binding to
// a single project's status IDs.
//
// Consumers (ProjectWorkspace, ProjectsHome, ProjectsSidebar) read this store.
// Filters compose: empty filter set = no constraint; set with N entries =
// match-any.
import { createStore } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { INVOLVED_DEFAULT_DAYS, parseInvolvedDays } from "~/modules/projects/involved"

/** Filterable due-status buckets — mirrors the API's `due` query param minus "done" (a terminal task is never shown by a due bucket). */
export type DueBucket = "overdue" | "due_soon" | "later" | "none"

interface ProjectsFilterState {
  query: string
  assignedToMe: boolean
  /** Status *labels* to include (case-preserved as supplied by backend). Empty set = no constraint. */
  statusLabels: string[]
  /** Due-status buckets to include. Empty set = no constraint. */
  dueBuckets: DueBucket[]
  /**
   * Effective release to match (own, else nearest ancestor; case-insensitive),
   * RELEASE_NONE for "no release", null = no constraint. Single value: the
   * API's `release` query param takes one.
   */
  release: string | null
  /**
   * Task label filter: group id → value id, or LABEL_NONE for "no
   * label in this group". Groups combine with AND. Empty = no constraint.
   * Always replaced wholesale: a Solid path setter would MERGE an object into
   * the current one and keep keys the new map dropped.
   */
  taskLabels: Record<string, string>
  /**
   * "Recently involved": only the tasks the signed-in person commented on,
   * was mentioned in, changed, created or was assigned in the last N days
   * (1..90), newest involvement first. Null = no constraint.
   */
  involvedWithinDays: number | null
  /** Optional explicit project scope — when null, filters apply across all projects. */
  scopeProjectId: string | null
}

const [state, setState] = createStore<ProjectsFilterState>({
  query: "",
  assignedToMe: false,
  statusLabels: [],
  dueBuckets: [],
  release: null,
  taskLabels: {},
  involvedWithinDays: null,
  scopeProjectId: null,
})

function setQuery(q: string): void {
  setState("query", q)
}

function toggleAssignedToMe(): void {
  setState("assignedToMe", (v) => !v)
}

function setAssignedToMe(v: boolean): void {
  setState("assignedToMe", v)
}

function toggleStatusLabel(label: string): void {
  const next = state.statusLabels.includes(label)
    ? state.statusLabels.filter((l) => l !== label)
    : [...state.statusLabels, label]
  setState("statusLabels", next)
}

function clearStatusLabels(): void {
  setState("statusLabels", [])
}

function toggleDueBucket(bucket: DueBucket): void {
  const next = state.dueBuckets.includes(bucket)
    ? state.dueBuckets.filter((b) => b !== bucket)
    : [...state.dueBuckets, bucket]
  setState("dueBuckets", next)
}

function clearDueBuckets(): void {
  setState("dueBuckets", [])
}

function setRelease(release: string | null): void {
  const v = typeof release === "string" ? release.trim() : ""
  setState("release", v.length > 0 ? v : null)
}

/** Select `valueId` in `groupId` (one value per group); null drops the group. */
function setTaskLabel(groupId: string, valueId: string | null): void {
  const next: Record<string, string> = { ...state.taskLabels }
  if (valueId === null) delete next[groupId]
  else next[groupId] = valueId
  setState({ taskLabels: next })
}

function clearTaskLabels(): void {
  setState({ taskLabels: {} })
}

/**
 * Drops the label filter keys the catalog no longer knows, registered by the
 * label catalog store. Every reader (board matching, the home query, the chip
 * count, `isActive`, saved-view capture) sees the same sanitized map, so a
 * stale saved-view id never leaves a filter "active" that constrains nothing.
 */
let taskLabelSanitizer: ((raw: Record<string, string>) => Record<string, string>) | null = null

export function registerTaskLabelSanitizer(
  fn: ((raw: Record<string, string>) => Record<string, string>) | null,
): void {
  taskLabelSanitizer = fn
}

function effectiveTaskLabels(): Record<string, string> {
  return taskLabelSanitizer ? taskLabelSanitizer(state.taskLabels) : state.taskLabels
}

/** A plain object of string values, else null (saved views come from storage). */
function parseTaskLabels(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value
  }
  return out
}

/** Turn "Recently involved" on (default window) or off. */
function toggleInvolved(): void {
  setState("involvedWithinDays", (v) => (v === null ? INVOLVED_DEFAULT_DAYS : null))
}

function setInvolvedWithinDays(days: number | null): void {
  setState("involvedWithinDays", days === null ? null : parseInvolvedDays(days))
}

function setScopeProjectId(id: string | null): void {
  setState("scopeProjectId", id)
}

function clearAll(): void {
  setState({
    query: "",
    assignedToMe: false,
    statusLabels: [],
    dueBuckets: [],
    release: null,
    taskLabels: {},
    involvedWithinDays: null,
  })
}

/** Snapshot the filter state for saved-view capture (cloned to avoid leaking the store proxy). */
function currentParams(): ProjectsFilterState {
  return {
    query: state.query,
    assignedToMe: state.assignedToMe,
    statusLabels: [...state.statusLabels],
    dueBuckets: [...state.dueBuckets],
    release: state.release,
    taskLabels: { ...effectiveTaskLabels() },
    involvedWithinDays: state.involvedWithinDays,
    scopeProjectId: state.scopeProjectId,
  }
}

let reloadHook: (() => Promise<void> | void) | null = null

function setReloadHook(hook: (() => Promise<void> | void) | null): void {
  reloadHook = hook
}

/** Apply a saved-view payload; unknown keys ignored. Triggers any registered reload hook. */
function applyParams(payload: Record<string, unknown>): void {
  const next: Partial<ProjectsFilterState> = {}
  if (typeof payload.query === "string") next.query = payload.query
  if (typeof payload.assignedToMe === "boolean") next.assignedToMe = payload.assignedToMe
  if (Array.isArray(payload.statusLabels)) {
    next.statusLabels = payload.statusLabels.filter((s): s is string => typeof s === "string")
  }
  if (Array.isArray(payload.dueBuckets)) {
    const valid: DueBucket[] = ["overdue", "due_soon", "later", "none"]
    next.dueBuckets = payload.dueBuckets.filter((b): b is DueBucket =>
      valid.includes(b as DueBucket),
    )
  }
  if (payload.release === null) next.release = null
  else if (typeof payload.release === "string") {
    const v = payload.release.trim()
    next.release = v.length > 0 ? v : null
  }
  const taskLabels = parseTaskLabels(payload.taskLabels)
  if (taskLabels) next.taskLabels = taskLabels
  if (payload.involvedWithinDays === null) next.involvedWithinDays = null
  else if (payload.involvedWithinDays !== undefined) {
    next.involvedWithinDays = parseInvolvedDays(payload.involvedWithinDays)
  }
  if (payload.scopeProjectId === null || typeof payload.scopeProjectId === "string") {
    next.scopeProjectId = payload.scopeProjectId
  }
  setState(next)
  void Promise.resolve(reloadHook?.())
}

export const projectsFilterStore = {
  get query() {
    return state.query
  },
  get assignedToMe() {
    return state.assignedToMe
  },
  get statusLabels() {
    return state.statusLabels
  },
  get dueBuckets() {
    return state.dueBuckets
  },
  get release() {
    return state.release
  },
  /** The label filter, minus the ids the catalog no longer knows (once it has loaded). */
  get taskLabels() {
    return effectiveTaskLabels()
  },
  get involvedWithinDays() {
    return state.involvedWithinDays
  },
  get scopeProjectId() {
    return state.scopeProjectId
  },
  get isActive() {
    return (
      state.query.length > 0 ||
      state.assignedToMe ||
      state.statusLabels.length > 0 ||
      state.dueBuckets.length > 0 ||
      state.release !== null ||
      state.involvedWithinDays !== null ||
      Object.keys(effectiveTaskLabels()).length > 0
    )
  },
  setQuery,
  toggleAssignedToMe,
  setAssignedToMe,
  toggleStatusLabel,
  clearStatusLabels,
  toggleDueBucket,
  clearDueBuckets,
  setRelease,
  setTaskLabel,
  clearTaskLabels,
  toggleInvolved,
  setInvolvedWithinDays,
  setScopeProjectId,
  clearAll,
  currentParams,
  applyParams,
  setReloadHook,
}

/** Reset on logout so filters don't carry across users. */
export function resetProjectsFilterStore(): void {
  setState({
    query: "",
    assignedToMe: false,
    statusLabels: [],
    dueBuckets: [],
    release: null,
    taskLabels: {},
    involvedWithinDays: null,
    scopeProjectId: null,
  })
}
onSessionTeardown(resetProjectsFilterStore)
