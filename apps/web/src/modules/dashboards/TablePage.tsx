// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE TABLE, FULL WIDTH (`/dashboard-table/:id`), beside the Dashboards sidebar: its name, then
// three tabs at the top. Grid is the editable table (every column, 50 rows a page), Settings its
// columns, sharing and the agent-approval switch, History every change to its rows, with Undo.
import { type Component, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Skeleton } from "~/ui/Skeleton"
import { EditableTableBlock } from "./blocks/EditableTableBlock"
import { RowHistoryPanel } from "./blocks/RowHistoryPanel"
import { getTable, type TableInfo, type TablesApi } from "./dashboards-client"
import { TableSettings } from "./TableSettings"
import { rememberTable } from "./tables-store"

type PageTab = "grid" | "settings" | "history"
const TABS: PageTab[] = ["grid", "settings", "history"]

export const TablePage: Component<{ entityId: string }> = (props) => {
  const i18n = useI18n()
  const [tab, setTab] = createSignal<PageTab>("grid")
  const [table, setTable] = createSignal<TableInfo | null>(null)
  // A settings change (a new column, a renamed one) makes the grid read the table again.
  const [gridKey, setGridKey] = createSignal(0)

  const api = useApi() as unknown as TablesApi
  const seen = (t: TableInfo) => {
    setTable(t)
    rememberTable(t)
  }
  // The grid reads it too; this read names the tab even when Settings or History opens first.
  // A table with no column yet (just created) opens on Settings, where columns are added.
  onMount(() => {
    void getTable(api, props.entityId)
      .then((t) => {
        seen(t)
        if (t.columns.length === 0 && (t.myRole === "editor" || t.myRole === "owner")) {
          setTab("settings")
        }
      })
      .catch(() => {})
  })

  return (
    <div data-testid="table-page" class="flex h-full min-h-0 flex-col">
      <header class="flex flex-col gap-2 border-b border-border-subtle px-4 pb-0 pt-3">
        <div class="flex min-w-0 items-baseline gap-2">
          <h1 data-testid="table-page-title" class="truncate text-[15px] font-semibold text-text">
            {table()?.name ?? i18n.t("kernel.dashboards.tables.table")}
          </h1>
          <Show when={table()?.description}>
            <p class="truncate text-[12.5px] text-text-tertiary">{table()?.description}</p>
          </Show>
        </div>
        <div
          role="tablist"
          aria-label={i18n.t("kernel.dashboards.tables.table")}
          class="flex gap-1"
        >
          <For each={TABS}>
            {(t) => (
              <button
                type="button"
                role="tab"
                data-testid={`table-page-tab-${t}`}
                aria-selected={tab() === t}
                onClick={() => setTab(t)}
                class={cn(
                  "-mb-px border-b-2 px-3 py-1.5 text-[13px] transition-colors",
                  tab() === t
                    ? "border-accent font-medium text-text"
                    : "border-transparent text-text-secondary hover:text-text",
                )}
              >
                {i18n.t(`kernel.dashboards.tables.tab.${t}`)}
              </button>
            )}
          </For>
        </div>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Switch>
          <Match when={tab() === "grid"}>
            <EditableTableBlock
              tableId={props.entityId}
              reloadKey={gridKey()}
              onTable={seen}
              testid="table-page-grid"
            />
          </Match>
          <Match when={tab() === "settings"}>
            <Show when={table()} fallback={<Skeleton class="h-5 w-1/2" />}>
              {(t) => (
                <TableSettings
                  table={t()}
                  onChanged={(next) => {
                    seen(next)
                    setGridKey((k) => k + 1)
                  }}
                />
              )}
            </Show>
          </Match>
          <Match when={tab() === "history"}>
            <RowHistoryPanel
              tableId={props.entityId}
              columns={table()?.columns ?? []}
              title={i18n.t("kernel.dashboards.tables.history")}
              canUndo={table()?.myRole === "editor" || table()?.myRole === "owner"}
              testid="table-page-history"
              onUndone={() => setGridKey((k) => k + 1)}
            />
          </Match>
        </Switch>
      </div>
    </div>
  )
}

export default TablePage
