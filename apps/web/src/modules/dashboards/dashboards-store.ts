// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The viewer's dashboards as the shell knows them: the list the home sidebar
// shows and each open tab's title (`resolveLabel`).
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { openTab } from "~/modules/shell/tab-store"
import { type DashboardSummary, type DashboardsApi, listDashboards } from "./dashboards-client"

export const DASHBOARD_TAB_TYPE = "kernel:dashboard"

const [list, setList] = createSignal<DashboardSummary[]>([])
const [titles, setTitles] = createStore<Record<string, string>>({})
let pending: Promise<void> | null = null

/** Personal dashboards first, then the org's, each by title. */
export function sortDashboards(rows: DashboardSummary[]): DashboardSummary[] {
  return [...rows].sort((a, b) =>
    a.visibility !== b.visibility
      ? a.visibility === "personal"
        ? -1
        : 1
      : a.title.localeCompare(b.title),
  )
}

export function dashboardsList(): DashboardSummary[] {
  return list()
}

/** The open tab's label: the dashboard's title once it is known. */
export function dashboardTitle(id: string): string | undefined {
  return titles[id]
}

/** One dashboard read by its page: its title names the tab, and the list carries it. */
export function rememberDashboard(d: DashboardSummary): void {
  setTitles(d.id, d.title)
  setList((rows) =>
    rows.some((r) => r.id === d.id)
      ? sortDashboards(
          rows.map((r) => (r.id === d.id ? { ...r, title: d.title, visibility: d.visibility } : r)),
        )
      : rows,
  )
}

/** Reads the list again. A failed read keeps the last one: the sidebar never flickers empty. */
export function loadDashboards(api: DashboardsApi): Promise<void> {
  pending ??= listDashboards(api)
    .then((rows) => {
      const sorted = sortDashboards(rows)
      for (const r of sorted) setTitles(r.id, r.title)
      setList(sorted)
    })
    .catch(() => {})
    .finally(() => {
      pending = null
    })
  return pending
}

export function openDashboard(d: Pick<DashboardSummary, "id" | "title">): void {
  openTab({ type: DASHBOARD_TAB_TYPE, entityId: d.id, label: d.title })
}

/** Test seam. */
export function resetDashboardsStore(): void {
  setList([])
  setTitles({})
  pending = null
}
