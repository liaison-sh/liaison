// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The viewer's dashboards as the shell knows them: the list the home sidebar
// shows and each open tab's title (`resolveLabel`).
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { openTab } from "~/modules/shell/tab-store"
import { type DashboardSummary, type DashboardsApi, listDashboards } from "./dashboards-client"

export const DASHBOARD_TAB_TYPE = "kernel:dashboard"

const [list, setList] = createSignal<DashboardSummary[]>([])
const [titles, setTitles] = createStore<Record<string, string>>({})
/** Bumped to make an open dashboard read its spec again (see `reloadDashboard`). */
const [revisions, setRevisions] = createStore<Record<string, number>>({})
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

/**
 * One dashboard read by its page: its title names the tab, and the list carries it, added when
 * the list does not have it yet (one the agent just made and opened), so the Home sidebar shows
 * it without a reload.
 */
export function rememberDashboard(d: DashboardSummary): void {
  setTitles(d.id, d.title)
  const summary: DashboardSummary = {
    id: d.id,
    title: d.title,
    visibility: d.visibility,
    ownerUserId: d.ownerUserId,
    ...(d.updatedAt ? { updatedAt: d.updatedAt } : {}),
  }
  setList((rows) =>
    sortDashboards(
      rows.some((r) => r.id === d.id)
        ? rows.map((r) => (r.id === d.id ? { ...r, title: d.title, visibility: d.visibility } : r))
        : [...rows, summary],
    ),
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
  reloadDashboard(d.id)
  openTab({ type: DASHBOARD_TAB_TYPE, entityId: d.id, label: d.title })
}

/**
 * The open dashboard `id` reads its spec again. Every open goes through here (the sidebar, the
 * agent's open after it changed the dashboard, Refresh all), so a tab already open shows the
 * blocks as they are now, not as they were when the tab first opened.
 */
export function reloadDashboard(id: string): void {
  setRevisions(id, (n) => (n ?? 0) + 1)
}

/** The read revision `DashboardView` keys its dashboard on. */
export function dashboardRevision(id: string): number {
  return revisions[id] ?? 0
}

/** Forget the viewer's dashboards: at sign-out (the next person must not see them) and between tests. */
export function resetDashboardsStore(): void {
  setList([])
  setTitles({})
  setRevisions({})
  pending = null
}

onSessionTeardown(resetDashboardsStore)
