// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARDS SIDEBAR, beside the Dashboards page and every dashboard tab: a
// filter, "All dashboards" (the page), then the viewer's own dashboards and the
// ones others share with the team, each by title, then the tables (org data people and agents
// write) the viewer can see. The open one is lit. The agent
// builds dashboards, so the foot says to ask it. The list is the store's, so it
// stays live like the page. A new table is named in place; "From a project" makes it a view of
// a project's tasks (the project picked, the task values to show ticked).
import { LayoutDashboard, LayoutGrid, Plus, Search, Sparkles, Table2, Users } from "lucide-solid"
import { type Component, createSignal, For, type JSX, onMount, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab, tabStore } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"
import { CellEditor } from "./blocks/CellEditor"
import { isLinkCell } from "./blocks/table-cells"
import {
  createTable,
  type DashboardSummary,
  type LinkCell,
  type TableColumn,
  type TablesApi,
  tableErrorFrom,
} from "./dashboards-client"
import {
  DASHBOARD_TAB_TYPE,
  DASHBOARDS_TAB_TYPE,
  dashboardsList,
  loadDashboards,
  openDashboard,
  splitDashboards,
} from "./dashboards-store"
import { type BackingField, readProjectShape } from "./table-backing"
import { loadTables, openTable, rememberTable, TABLE_TAB_TYPE, tablesList } from "./tables-store"

/** The tab the shell shows now, if any. */
function activeTab() {
  return tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
}

const SidebarRow: Component<{
  testid: string
  label: string
  icon: Component<{ size?: number }>
  active: boolean
  title?: string
  trailing?: JSX.Element
  onClick: () => void
}> = (props) => (
  <button
    type="button"
    data-testid={props.testid}
    aria-current={props.active ? "page" : undefined}
    title={props.title ?? props.label}
    onClick={() => props.onClick()}
    class={cn(
      "flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-[13px] transition-colors",
      props.active
        ? "bg-surface-active font-medium text-text"
        : "text-text-secondary hover:bg-surface-hover",
    )}
  >
    <span class="flex w-4 shrink-0 justify-center text-text-tertiary">
      <props.icon size={14} />
    </span>
    <span class="min-w-0 flex-1 truncate">{props.label}</span>
    {props.trailing}
  </button>
)

const SectionTitle: Component<{
  testid: string
  label: string
  count: number
  action?: JSX.Element
}> = (props) => (
  <h3
    data-testid={props.testid}
    class="mt-3 flex items-center px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary"
  >
    <span class="flex-1">{props.label}</span>
    <span class="font-mono font-normal tabular-nums">{props.count}</span>
    {props.action}
  </h3>
)

export const DashboardsSidebar: Component = () => {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()
  const [query, setQuery] = createSignal("")
  onMount(() => {
    void loadDashboards(api)
    void loadTables(api)
  })

  const matches = (d: DashboardSummary) => {
    const q = query().trim().toLocaleLowerCase(i18n.locale())
    return !q || d.title.toLocaleLowerCase(i18n.locale()).includes(q)
  }
  const groups = () =>
    splitDashboards(dashboardsList().filter(matches), userFromToken()?.userId ?? "")
  const isOpen = (id: string) => {
    const tab = activeTab()
    return tab?.type === DASHBOARD_TAB_TYPE && tab.entityId === id
  }
  const tables = () => {
    const q = query().trim().toLocaleLowerCase(i18n.locale())
    return tablesList().filter((t) => !q || t.name.toLocaleLowerCase(i18n.locale()).includes(q))
  }
  const isTableOpen = (id: string) => {
    const tab = activeTab()
    return tab?.type === TABLE_TAB_TYPE && tab.entityId === id
  }
  const indexOpen = () => activeTab()?.type === DASHBOARDS_TAB_TYPE

  // A new table: its name typed in place, then it opens on its Settings to add columns. From a
  // project, it reads the project's tasks: the project and the task values to show are picked.
  const [naming, setNaming] = createSignal(false)
  const [newName, setNewName] = createSignal("")
  const [creating, setCreating] = createSignal(false)
  const [createError, setCreateError] = createSignal<string | null>(null)
  const [fromProject, setFromProject] = createSignal(false)
  const [project, setProject] = createSignal<LinkCell | null>(null)
  const [offered, setOffered] = createSignal<BackingField[]>([])
  const [picked, setPicked] = createSignal<string[]>([])
  let projectSeq = 0
  function stopNaming(): void {
    setNaming(false)
    setNewName("")
    setCreateError(null)
    setFromProject(false)
    setProject(null)
    setOffered([])
    setPicked([])
  }
  const projectColumn: TableColumn = {
    key: "project",
    label: t("kernel.dashboards.tables.project"),
    type: "link",
    linkTo: { app: "projects", entityType: "project" },
  }
  const fieldLabel = (f: BackingField) =>
    f.builtin ? t(`kernel.dashboards.tables.builtin.${f.key}`) : (f.label ?? f.key)
  async function pickProject(cell: LinkCell | null): Promise<void> {
    setProject(cell)
    setOffered([])
    setCreateError(null)
    if (!cell) return
    const mine = ++projectSeq
    try {
      const shape = await readProjectShape(api, cell.id)
      if (mine !== projectSeq) return
      setOffered(shape.fields)
      // The usual view of a project's work: what, where it stands, who and when.
      setPicked(["title", "status", "assignee", "due"])
    } catch {
      if (mine === projectSeq) setCreateError(t("kernel.dashboards.tables.projectUnreadable"))
    }
  }
  function toggleField(key: string): void {
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]))
  }
  async function submitNewTable(): Promise<void> {
    const name = newName().trim()
    if (!name || creating()) return
    const chosen = project()
    if (fromProject() && !chosen) {
      setCreateError(t("kernel.dashboards.tables.pickProject"))
      return
    }
    // The ticked values in the order the project offers them.
    const fields = offered()
      .map((f) => f.key)
      .filter((k) => picked().includes(k))
    if (fromProject() && fields.length === 0) {
      setCreateError(t("kernel.dashboards.tables.pickValue"))
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      const table = await createTable(api as unknown as TablesApi, {
        name,
        ...(fromProject() && chosen
          ? { backing: { app: "projects", entity: "task", parentId: chosen.id, fields } }
          : {}),
      })
      rememberTable(table)
      stopNaming()
      openTable(table)
    } catch (err) {
      const e = tableErrorFrom(err)
      setCreateError(
        e.code === "conflict"
          ? t("kernel.dashboards.tables.nameTaken", { name })
          : e.code === "forbidden"
            ? t("kernel.dashboards.tables.createForbidden")
            : t("kernel.dashboards.tables.createFailed"),
      )
    } finally {
      setCreating(false)
    }
  }

  function openIndex(): void {
    openTab({
      type: DASHBOARDS_TAB_TYPE,
      entityId: "dashboards",
      label: t("kernel.nav.dashboards"),
    })
  }

  return (
    <nav
      data-testid="dashboards-sidebar"
      aria-label={t("kernel.nav.dashboards")}
      class="flex h-full min-h-0 flex-col"
    >
      <div class="px-3 pb-2 pt-3">
        <label class="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5">
          <Search size={14} class="shrink-0 text-text-tertiary" />
          <span class="sr-only">{t("kernel.dashboards.filterLabel")}</span>
          <input
            type="text"
            data-testid="dashboards-sidebar-filter"
            placeholder={t("kernel.dashboards.filterLabel")}
            class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </label>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <SidebarRow
          testid="dashboards-sidebar-all"
          label={t("kernel.dashboards.allDashboards")}
          icon={LayoutDashboard}
          active={indexOpen()}
          trailing={
            <span class="ml-2 shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary">
              {dashboardsList().length}
            </span>
          }
          onClick={openIndex}
        />

        <Show when={groups().yours.length > 0}>
          <SectionTitle
            testid="dashboards-sidebar-yours"
            label={t("kernel.dashboards.sectionYours")}
            count={groups().yours.length}
          />
          <For each={groups().yours}>
            {(d) => (
              <SidebarRow
                testid={`dashboards-sidebar-row-${d.id}`}
                label={d.title}
                icon={LayoutGrid}
                active={isOpen(d.id)}
                trailing={
                  <Show when={d.shared ?? d.visibility === "org"}>
                    <span
                      data-testid={`dashboards-sidebar-row-${d.id}-shared`}
                      title={t("kernel.dashboards.sharedWithTeam")}
                      class="ml-2 flex shrink-0 text-text-tertiary"
                    >
                      <Users size={13} aria-label={t("kernel.dashboards.sharedWithTeam")} />
                    </span>
                  </Show>
                }
                onClick={() => openDashboard(d)}
              />
            )}
          </For>
        </Show>

        <Show when={groups().team.length > 0}>
          <SectionTitle
            testid="dashboards-sidebar-team"
            label={t("kernel.dashboards.sectionTeam")}
            count={groups().team.length}
          />
          <For each={groups().team}>
            {(d) => (
              <SidebarRow
                testid={`dashboards-sidebar-row-${d.id}`}
                label={d.title}
                icon={LayoutGrid}
                active={isOpen(d.id)}
                title={
                  d.ownerName
                    ? t("kernel.dashboards.titleByOwner", { title: d.title, name: d.ownerName })
                    : d.title
                }
                trailing={
                  <Show when={d.ownerName}>
                    <span
                      data-testid={`dashboards-sidebar-row-${d.id}-owner`}
                      class="ml-2 max-w-[40%] shrink-0 truncate text-[11px] text-text-tertiary"
                    >
                      {d.ownerName?.split(" ")[0]}
                    </span>
                  </Show>
                }
                onClick={() => openDashboard(d)}
              />
            )}
          </For>
        </Show>

        <Show when={tables().length > 0 || query().trim() === ""}>
          <SectionTitle
            testid="dashboards-sidebar-tables"
            label={t("kernel.dashboards.tables.section")}
            count={tables().length}
            action={
              <button
                type="button"
                data-testid="dashboards-sidebar-new-table"
                title={t("kernel.dashboards.tables.newTable")}
                aria-label={t("kernel.dashboards.tables.newTable")}
                class="ml-2 rounded p-0.5 text-text-tertiary hover:bg-surface-hover hover:text-text"
                onClick={() => (naming() ? stopNaming() : setNaming(true))}
              >
                <Plus size={13} />
              </button>
            }
          />
          <Show when={naming()}>
            <form
              class="px-3 pb-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                void submitNewTable()
              }}
            >
              <input
                type="text"
                data-testid="dashboards-sidebar-new-table-name"
                aria-label={t("kernel.dashboards.tables.newTableName")}
                placeholder={t("kernel.dashboards.tables.newTableName")}
                maxLength={120}
                ref={(el) => queueMicrotask(() => el.focus())}
                value={newName()}
                disabled={creating()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") stopNaming()
                }}
                class="w-full rounded-md border border-border-subtle bg-surface px-2.5 py-1.5 text-[13px] text-text outline-none placeholder:text-text-tertiary focus:border-accent"
              />
              <label class="flex items-center gap-2 pt-1.5 text-[12px] text-text-secondary">
                <input
                  type="checkbox"
                  data-testid="dashboards-sidebar-new-table-from-project"
                  checked={fromProject()}
                  disabled={creating()}
                  onChange={(e) => {
                    setFromProject(e.currentTarget.checked)
                    setCreateError(null)
                  }}
                />
                {t("kernel.dashboards.tables.fromProject")}
              </label>
              <Show when={fromProject()}>
                <div
                  data-testid="dashboards-sidebar-new-table-project-form"
                  class="flex flex-col gap-1.5 pt-1.5"
                >
                  <p class="text-[11.5px] text-text-tertiary">
                    {t("kernel.dashboards.tables.fromProjectHint")}
                  </p>
                  <span class="text-[11.5px] text-text-secondary">
                    {t("kernel.dashboards.tables.project")}
                  </span>
                  <CellEditor
                    column={projectColumn}
                    value={project()}
                    inline
                    testid="dashboards-sidebar-new-table-project"
                    onCommit={(v) => void pickProject(isLinkCell(v) ? v : null)}
                  />
                  <Show when={project()}>
                    {(p) => (
                      <p
                        data-testid="dashboards-sidebar-new-table-project-picked"
                        class="truncate text-[12px] font-medium text-text"
                      >
                        {p().label}
                      </p>
                    )}
                  </Show>
                  <Show when={offered().length > 0}>
                    <fieldset
                      data-testid="dashboards-sidebar-new-table-fields"
                      class="flex flex-col gap-1"
                    >
                      <legend class="pb-0.5 text-[11.5px] text-text-secondary">
                        {t("kernel.dashboards.tables.projectValues")}
                      </legend>
                      <For each={offered()}>
                        {(f) => (
                          <label class="flex items-center gap-2 text-[12px] text-text-secondary">
                            <input
                              type="checkbox"
                              data-testid={`dashboards-sidebar-new-table-field-${f.key}`}
                              checked={picked().includes(f.key)}
                              disabled={creating()}
                              onChange={() => toggleField(f.key)}
                            />
                            <span class="truncate">{fieldLabel(f)}</span>
                          </label>
                        )}
                      </For>
                    </fieldset>
                  </Show>
                  <div class="flex items-center gap-2 pt-0.5">
                    <Button
                      type="submit"
                      size="sm"
                      data-testid="dashboards-sidebar-new-table-create"
                      disabled={creating() || !newName().trim()}
                    >
                      {t("kernel.dashboards.tables.create")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="dashboards-sidebar-new-table-cancel"
                      onClick={stopNaming}
                    >
                      {t("kernel.common.cancel")}
                    </Button>
                  </div>
                </div>
              </Show>
              <Show when={createError()}>
                <p
                  data-testid="dashboards-sidebar-new-table-error"
                  class="pt-1 text-[12px] text-danger"
                >
                  {createError()}
                </p>
              </Show>
            </form>
          </Show>
          <For each={tables()}>
            {(tb) => (
              <SidebarRow
                testid={`dashboards-sidebar-table-${tb.id}`}
                label={tb.name}
                icon={Table2}
                active={isTableOpen(tb.id)}
                onClick={() => openTable(tb)}
              />
            )}
          </For>
        </Show>

        <Show
          when={
            query().trim() !== "" &&
            groups().yours.length + groups().team.length + tables().length === 0
          }
        >
          <p
            data-testid="dashboards-sidebar-no-match"
            class="px-3 py-2 text-[12.5px] text-text-tertiary"
          >
            {t("kernel.dashboards.noMatch", { query: query().trim() })}
          </p>
        </Show>
      </div>

      <p
        data-testid="dashboards-sidebar-hint"
        class="flex items-start gap-2 border-t border-border-subtle px-5 py-3 text-[12px] text-text-tertiary"
      >
        <Sparkles size={13} class="mt-0.5 shrink-0" />
        <span>{t("kernel.dashboards.sidebarHint")}</span>
      </p>
    </nav>
  )
}

export default DashboardsSidebar
