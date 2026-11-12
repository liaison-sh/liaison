// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tables the viewer can see, as the shell knows them: the Tables section of the
// Dashboards sidebar and each open table tab's title (`resolveLabel`). A failed read keeps the
// last list, so the sidebar never flickers empty. The realtime frames of a table
// (`kernel:dashboard_table*`, sent only to its readers) bump a per-table revision its open grids
// read again on.
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { openTab } from "~/modules/shell/tab-store"
import { listTables, type TableInfo, type TablesApi } from "./dashboards-client"

export const TABLE_TAB_TYPE = "kernel:dashboard-table"

const [list, setList] = createSignal<TableInfo[]>([])
const [titles, setTitles] = createStore<Record<string, string>>({})
// Per table: how many times its rows (`rows`) or its columns and settings (`table`) changed.
const [revisions, setRevisions] = createStore<Record<string, { rows: number; table: number }>>({})
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

/** The revision an open grid of table `id` reads again on (rows, or the table itself). */
export function tableRevision(id: string, kind: "rows" | "table"): number {
  return revisions[id]?.[kind] ?? 0
}

export interface TableEventData {
  tableId?: string
}

/**
 * A table or its rows changed somewhere (another person, an agent, a routine, this window): an
 * open grid of it reads it again, and a created, renamed or deleted table updates the list.
 */
export function handleTableEvent(
  api: Pick<TablesApi, "get">,
  kind: "rows" | "table",
  action: string,
  data: TableEventData | undefined,
): Promise<void> | undefined {
  const id = data?.tableId
  if (!id) return undefined
  setRevisions(id, (r) => ({
    rows: (r?.rows ?? 0) + (kind === "rows" ? 1 : 0),
    table: (r?.table ?? 0) + (kind === "table" ? 1 : 0),
  }))
  if (kind !== "table") return undefined
  if (action === "deleted") setList((rows) => rows.filter((r) => r.id !== id))
  return loadTables(api)
}

export function openTable(t: Pick<TableInfo, "id" | "name">): void {
  openTab({ type: TABLE_TAB_TYPE, entityId: t.id, label: t.name })
}

export function resetTablesStore(): void {
  setList([])
  setTitles({})
  setRevisions({})
  pending = null
}

onSessionTeardown(resetTablesStore)
