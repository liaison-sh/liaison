// SPDX-License-Identifier: FSL-1.1-ALv2
// Lightweight bulk-selection state for the Projects app.
// The bulk action toolbar reads `selectedIds()` and calls `clearSelection()`.
import { createStore, produce } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"

interface SelectionState {
  ids: Record<string, boolean>
}

const [state, setState] = createStore<SelectionState>({ ids: {} })

export function selectedIds(): string[] {
  return Object.keys(state.ids).filter((id) => state.ids[id])
}

export function toggleSelection(id: string): void {
  setState(
    produce((s) => {
      if (s.ids[id]) delete s.ids[id]
      else s.ids[id] = true
    }),
  )
}

export function clearSelection(): void {
  setState(
    produce((s) => {
      for (const k of Object.keys(s.ids)) delete s.ids[k]
    }),
  )
}

export function replaceSelection(ids: string[]): void {
  setState(
    produce((s) => {
      for (const k of Object.keys(s.ids)) delete s.ids[k]
      for (const id of ids) s.ids[id] = true
    }),
  )
}

/** Reset on logout so a stale bulk selection can't act on a new user's data. */
export function resetProjectsSelectionStore(): void {
  clearSelection()
}
onSessionTeardown(resetProjectsSelectionStore)

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const ProjectsSelectionTestAccess = {
  /** Drop the bulk selection between cases. */
  reset(): void {
    clearSelection()
  },
}
