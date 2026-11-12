// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tables the viewer can see, as the shell knows them: the Tables section of the
// Dashboards sidebar and each open table tab's title (`resolveLabel`). A failed read keeps the
// last list, so the sidebar never flickers empty.
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { openTab } from "~/modules/shell/tab-store"
import { listTables, type TableInfo, type TablesApi } from "./dashboards-client"

export const TABLE_TAB_TYPE = "kernel:dashboard-table"

const [list, setList] = createSignal<TableInfo[]>([])
const [titles, setTitles] = createStore<Record<string, string>>({})
let pending: Promise<void> | null = null

export function tablesList(): TableInfo[] {
  return list()
}

export function tableTitle(id: string): string | undefined {
  return titles[id]
}

export function loadTables(api: Pick<TablesApi, "get">): Promise<void> {
  if (pending) return pending
  pending = listTables(api)
    .then((rows) => {
      const sorted = [...rows].sort((a, b) => a.name.localeCompare(b.name))
      for (const t of sorted) setTitles(t.id, t.name)
      setList(sorted)
    })
    .catch(() => {})
    .finally(() => {
      pending = null
    })
  return pending
}

/** A table read by its page: its name labels the tab, and the list carries it. */
export function rememberTable(t: TableInfo): void {
  setTitles(t.id, t.name)
  setList((rows) =>
    (rows.some((r) => r.id === t.id)
      ? rows.map((r) => (r.id === t.id ? t : r))
      : [...rows, t]
    ).sort((a, b) => a.name.localeCompare(b.name)),
  )
}

export function openTable(t: Pick<TableInfo, "id" | "name">): void {
  openTab({ type: TABLE_TAB_TYPE, entityId: t.id, label: t.name })
}

export function resetTablesStore(): void {
  setList([])
  setTitles({})
  pending = null
}

onSessionTeardown(resetTablesStore)
