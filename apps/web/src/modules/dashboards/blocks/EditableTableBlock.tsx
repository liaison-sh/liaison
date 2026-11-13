// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN EDITABLE TABLE: a table's rows, changed in place by the people who may edit it. It is the
// body of a `table` block on a table source with `map.editable`, and the grid of the table's
// own page. It reads the table and its rows itself (`/dashboards/tables/:id`, 50 rows a page,
// sorted by any column) as the viewer, so a viewer gets the same rows read-only.
//
// An editor clicks a cell to change it (each column type has its editor, CellEditor.tsx), adds
// a row from the form at the top (required columns first), deletes one after a confirm, and
// opens a row's history (the "Last change" column) to undo a change. A cell saved over someone
// else's newer change is refused by the server: the grid reloads the row and says who changed it.
//
// A link cell opens its record (the app's own opener, BlockDrillPanel's openRecordLink); an
// editor changes it from the pencil beside it. A table backed by a project shows its rows as the
// project's tasks: a column read from the project carries a small link mark naming it, a change
// to it changes the task (a refusal says so in plain words), Add creates a task, and a row is
// never deleted here (archive the task in Projects).
import { History, Link2, Pencil, Plus, Trash2 } from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import { openRecordLink } from "../BlockDrillPanel"
import {
  getTable,
  getTableRows,
  isDeletedRow,
  type TableCells,
  type TableColumn,
  type TableInfo,
  type TableRow,
  type TablesApi,
  tableErrorFrom,
  writeTableRows,
} from "../dashboards-client"
import { backingName } from "../table-backing"
import { tableRevision } from "../tables-store"
import { CellEditor } from "./CellEditor"
import { RowHistoryPanel } from "./RowHistoryPanel"
import { TableConfirmDialog } from "./TableConfirmDialog"
import {
  addFormColumns,
  cellText,
  isEmptyCell,
  isLinkCell,
  isStale,
  parseCellInput,
  relativeTime,
  rowLabel,
  shownColumns,
} from "./table-cells"
import { loadPeople, personName } from "./table-people"

export interface EditableTableBlockProps {
  tableId: string
  /** The column keys to show, in order (the block's `map.columns`); absent: every column. */
  columns?: string[]
  /** Bumped by a refresh (the block's own, or the page's Refresh all): reads the rows again. */
  reloadKey?: unknown
  /** The table as read: the table page names its tab and settings from it. */
  onTable?: (table: TableInfo) => void
  /** Rows not changed for this many days show a "to confirm" marker (the block's map). */
  staleAfterDays?: number
  /** The page's clock (ms): "4 min ago" follows it. */
  now?: number
  /** Test ids start with this (several blocks may show the same table). */
  testid?: string
}

type Status = "loading" | "ready" | "error"

interface Editing {
  rowId: string
  key: string
}

export const EditableTableBlock: Component<EditableTableBlockProps> = (props) => {
  const i18n = useI18n()
  const client = useApi()
  const api = client as unknown as TablesApi & Parameters<typeof loadPeople>[0]
  const tid = () => props.testid ?? "table-block"
  const [table, setTable] = createSignal<TableInfo | null>(null)
  const [status, setStatus] = createSignal<Status>("loading")
  const [failure, setFailure] = createSignal<"not_found" | "error">("error")
  const [rows, setRows] = createSignal<TableRow[]>([])
  // The cursors of the pages before this one (the first is null), and the next page's.
  const [cursors, setCursors] = createSignal<Array<string | null>>([null])
  const [nextCursor, setNextCursor] = createSignal<string | null>(null)
  const [sort, setSort] = createSignal<{ key: string; dir: "asc" | "desc" } | null>(null)
  const [editing, setEditing] = createSignal<Editing | null>(null)
  const [saving, setSaving] = createSignal(false)
  // One line under a row: a conflict ("changed by Nico just now") or a refused cell.
  const [rowNotice, setRowNotice] = createSignal<{ rowId: string; text: string } | null>(null)
  const [adding, setAdding] = createSignal(false)
  const [draft, setDraft] = createSignal<Record<string, unknown>>({})
  const [addError, setAddError] = createSignal<string | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal<TableRow | null>(null)
  const [historyRow, setHistoryRow] = createSignal<TableRow | null>(null)
  const [historyKey, setHistoryKey] = createSignal(0)
  const [clock, setClock] = createSignal(Date.now())
  let seq = 0

  onMount(() => {
    void loadPeople(api)
    if (props.now !== undefined) return
    const timer = setInterval(() => setClock(Date.now()), 60_000)
    onCleanup(() => clearInterval(timer))
  })
  const now = () => props.now ?? clock()

  const canEdit = () => {
    const role = table()?.myRole
    return role === "editor" || role === "owner"
  }
  const columns = (): TableColumn[] => shownColumns(table()?.columns ?? [], props.columns)
  const backing = () => table()?.backing
  const isReadThrough = (key: string) => backing()?.readThrough.includes(key) === true
  /** The backing project's name, else "the project". */
  const parentName = () =>
    backingName(api, backing()) ?? i18n.t("kernel.dashboards.tables.theProject")
  /** The add form: a backed table adds a task (its title) with the table's own columns. */
  const addColumns = (): TableColumn[] => {
    const all = table()?.columns ?? []
    const b = backing()
    if (!b) return all
    return all.filter((c) => !b.readThrough.includes(c.key) || c.key === "title")
  }
  const textOpts = () => ({ locale: i18n.locale(), personName, t: i18n.t })
  const cursor = () => cursors()[cursors().length - 1] ?? null

  async function readRows(at: string | null): Promise<TableRow[]> {
    const s = sort()
    const page = await getTableRows(api, props.tableId, {
      cursor: at,
      ...(s ? { sort: s.key, dir: s.dir } : {}),
    })
    setNextCursor(page.nextCursor)
    return page.rows
  }

  /** Reads the table and the current page; a failed read says so, with a retry. */
  async function load(): Promise<void> {
    const mine = ++seq
    if (!table()) setStatus("loading")
    try {
      const info = await getTable(api, props.tableId)
      if (mine !== seq) return
      setTable(info)
      props.onTable?.(info)
      const page = await readRows(cursor())
      if (mine !== seq) return
      setRows(page)
      setStatus("ready")
    } catch (err) {
      if (mine !== seq) return
      setFailure(tableErrorFrom(err).code === "not_found" ? "not_found" : "error")
      setStatus("error")
    }
  }

  /** Reads the current page again (after a conflict or an undo). */
  async function reloadRows(): Promise<TableRow[]> {
    const mine = ++seq
    const page = await readRows(cursor())
    if (mine === seq) setRows(page)
    return page
  }

  createEffect(
    on(
      () => [props.tableId, props.reloadKey] as const,
      () => void load(),
    ),
  )
  // Live: another person's, an agent's or a routine's change reaches this grid (tables-store).
  // A changed table (its columns) reads everything again; changed rows read the table (its row
  // count) and the page again, unless a cell is being edited or saved (the save reads its row).
  createEffect(
    on(
      () => tableRevision(props.tableId, "table"),
      () => void load(),
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => tableRevision(props.tableId, "rows"),
      () => {
        if (status() !== "ready" || editing() || saving()) return
        void load()
      },
      { defer: true },
    ),
  )

  function goTo(which: "next" | "previous"): void {
    if (which === "next") {
      const n = nextCursor()
      if (!n) return
      setCursors((c) => [...c, n])
    } else {
      if (cursors().length <= 1) return
      setCursors((c) => c.slice(0, -1))
    }
    setEditing(null)
    void load()
  }

  function sortBy(key: string): void {
    const s = sort()
    setSort(s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" })
    setCursors([null])
    void load()
  }

  function replaceRow(row: TableRow): void {
    setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)))
    setHistoryKey((k) => k + 1)
    if (historyRow()?.id === row.id) setHistoryRow(row)
  }

  /** A refused write, said under its row; a conflict reloads the row and names who changed it. */
  async function refused(rowId: string, err: unknown): Promise<void> {
    const e = tableErrorFrom(err)
    if (e.code === "version_conflict") {
      if (e.current) replaceRow(e.current)
      const page = await reloadRows().catch(() => rows())
      const latest = e.current ?? page.find((r) => r.id === rowId)
      setRowNotice({
        rowId,
        text: latest
          ? i18n.t("kernel.dashboards.tables.changedBy", { name: latest.updatedBy.label })
          : i18n.t("kernel.dashboards.tables.rowGone"),
      })
      return
    }
    setRowNotice({ rowId, text: refusalText(e.code, e.column, e.message) })
  }

  function refusalText(code: string, column?: string, message?: string): string {
    const label = column ? (table()?.columns.find((c) => c.key === column)?.label ?? column) : null
    if (code === "invalid_cell")
      return label
        ? i18n.t("kernel.dashboards.tables.invalidCellIn", { column: label, reason: message ?? "" })
        : (message ?? i18n.t("kernel.dashboards.tables.saveFailed"))
    if (code === "forbidden") {
      // A refused read-through change: the table may be editable while the tasks are not.
      return backing() && (!column || isReadThrough(column))
        ? i18n.t("kernel.dashboards.tables.projectForbidden", { name: parentName() })
        : i18n.t("kernel.dashboards.tables.forbidden")
    }
    if (code === "limit") return message ?? i18n.t("kernel.dashboards.tables.limit")
    if (code === "not_found") return i18n.t("kernel.dashboards.tables.rowGone")
    return i18n.t("kernel.dashboards.tables.saveFailed")
  }

  async function saveCell(row: TableRow, column: TableColumn, raw: unknown): Promise<void> {
    setEditing(null)
    const parsed = parseCellInput(column, raw)
    if (!parsed.ok) {
      setRowNotice({
        rowId: row.id,
        text:
          parsed.reason === "required"
            ? i18n.t("kernel.dashboards.tables.required", { column: column.label })
            : i18n.t("kernel.dashboards.tables.notANumber", { column: column.label }),
      })
      return
    }
    const before = row.cells[column.key]
    if (JSON.stringify(before ?? null) === JSON.stringify(parsed.value ?? null)) return
    if (isEmptyCell(before) && isEmptyCell(parsed.value)) return
    setSaving(true)
    setRowNotice(null)
    try {
      const [out] = await writeTableRows(api, props.tableId, [
        { op: "update", id: row.id, ifVersion: row.version, cells: { [column.key]: parsed.value } },
      ])
      if (out && !isDeletedRow(out)) replaceRow(out)
    } catch (err) {
      const e = tableErrorFrom(err)
      if (e.code === "forbidden" && !e.column) {
        setRowNotice({ rowId: row.id, text: refusalText(e.code, column.key, e.message) })
        return
      }
      await refused(row.id, err)
    } finally {
      setSaving(false)
    }
  }

  function openAdd(): void {
    setDraft({})
    setAddError(null)
    setAdding(true)
  }

  async function saveAdd(): Promise<void> {
    const cells: TableCells = {}
    for (const c of addColumns()) {
      const raw = draft()[c.key]
      if (raw === undefined && !c.required) continue
      const parsed = parseCellInput(c, raw)
      if (!parsed.ok) {
        setAddError(
          parsed.reason === "required"
            ? i18n.t("kernel.dashboards.tables.required", { column: c.label })
            : i18n.t("kernel.dashboards.tables.notANumber", { column: c.label }),
        )
        return
      }
      if (!isEmptyCell(parsed.value) || c.type === "checkbox") cells[c.key] = parsed.value
    }
    setSaving(true)
    setAddError(null)
    try {
      const [out] = await writeTableRows(api, props.tableId, [{ op: "add", cells }])
      setAdding(false)
      if (out && !isDeletedRow(out)) setRows((prev) => [out, ...prev])
      setTable((t) => (t ? { ...t, rowCount: t.rowCount + 1 } : t))
    } catch (err) {
      const e = tableErrorFrom(err)
      setAddError(refusalText(e.code, e.column, e.message))
    } finally {
      setSaving(false)
    }
  }

  async function deleteRow(row: TableRow): Promise<void> {
    setConfirmDelete(null)
    setSaving(true)
    try {
      await writeTableRows(api, props.tableId, [
        { op: "delete", id: row.id, ifVersion: row.version },
      ])
      setRows((prev) => prev.filter((r) => r.id !== row.id))
      setTable((t) => (t ? { ...t, rowCount: Math.max(0, t.rowCount - 1) } : t))
      if (historyRow()?.id === row.id) setHistoryRow(null)
    } catch (err) {
      await refused(row.id, err)
    } finally {
      setSaving(false)
    }
  }

  const isEditing = (row: TableRow, c: TableColumn) =>
    editing()?.rowId === row.id && editing()?.key === c.key

  const CellView: Component<{ row: TableRow; column: TableColumn }> = (p) => {
    const value = () => p.row.cells[p.column.key]
    const text = () => cellText(p.column, value(), textOpts())
    return (
      <Switch fallback={<span class="truncate">{text()}</span>}>
        <Match when={p.column.type === "choice" && !isEmptyCell(value())}>
          <span class="inline-flex max-w-full truncate rounded-full border border-border-subtle bg-surface-hover px-2 py-0.5 text-[12px] text-text-secondary">
            {text()}
          </span>
        </Match>
        <Match when={p.column.type === "choices" && Array.isArray(value())}>
          <span class="flex flex-wrap gap-1">
            <For each={value() as string[]}>
              {(v) => (
                <span class="rounded-full border border-border-subtle bg-surface-hover px-2 py-0.5 text-[12px] text-text-secondary">
                  {v}
                </span>
              )}
            </For>
          </span>
        </Match>
        <Match when={p.column.type === "link" && !isEmptyCell(value())}>
          <span class="truncate">{text()}</span>
        </Match>
      </Switch>
    )
  }

  const numeric = (c: TableColumn) => c.type === "number" || c.type === "amount"

  /** A link cell's label, opening its record through the app's own opener (Enter works too). */
  const LinkOpen: Component<{ row: TableRow; column: TableColumn }> = (p) => {
    const cell = () => p.row.cells[p.column.key]
    const text = () => cellText(p.column, cell(), textOpts())
    return (
      <button
        type="button"
        data-testid={`${tid()}-open-${p.row.id}-${p.column.key}`}
        aria-label={i18n.t("kernel.dashboards.tables.openLink", { label: text() })}
        onClick={() => {
          const v = cell()
          if (isLinkCell(v)) {
            openRecordLink(client, {
              kind: "entity",
              app: v.app,
              entityType: v.entityType,
              id: v.id,
            })
          }
        }}
        class="min-w-0 truncate rounded text-left text-accent underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        {text()}
      </button>
    )
  }

  return (
    <div
      data-testid={tid()}
      data-state={status()}
      data-role={table()?.myRole}
      class="flex min-w-0 flex-col gap-2"
    >
      <Show when={status() === "ready" && table()}>
        {(t) => (
          <div class="flex items-center gap-2">
            <p
              data-testid={`${tid()}-count`}
              class="min-w-0 flex-1 truncate text-[12px] text-text-tertiary"
            >
              {t().rowCount === 1
                ? i18n.t("kernel.dashboards.tables.rowCountOne")
                : i18n.t("kernel.dashboards.tables.rowCount", { count: t().rowCount })}
              <Show when={!canEdit()}>{` · ${i18n.t("kernel.dashboards.tables.readOnly")}`}</Show>
            </p>
            <Show when={canEdit() && rows().length > 0}>
              <Button
                variant="outline"
                size="sm"
                data-testid={`${tid()}-add`}
                disabled={adding() || saving()}
                onClick={openAdd}
              >
                <Plus size={13} />
                {backing()
                  ? i18n.t("kernel.dashboards.tables.addTask")
                  : i18n.t("kernel.dashboards.tables.add")}
              </Button>
            </Show>
          </div>
        )}
      </Show>

      <Show when={adding()}>
        <form
          data-testid={`${tid()}-add-form`}
          class="flex flex-wrap items-end gap-2 rounded-md border border-border-subtle bg-surface-hover/40 p-2"
          onSubmit={(e) => {
            e.preventDefault()
            void saveAdd()
          }}
        >
          <For each={addFormColumns(addColumns())}>
            {(c) => (
              <div class="flex min-w-[7rem] flex-col gap-1 text-[11.5px] text-text-secondary">
                <span>
                  {c.label}
                  <Show when={c.required}>
                    <span aria-hidden="true"> *</span>
                  </Show>
                </span>
                <CellEditor
                  column={c}
                  value={draft()[c.key]}
                  inline
                  testid={`${tid()}-add-${c.key}`}
                  onCommit={(v) => setDraft((d) => ({ ...d, [c.key]: v }))}
                />
              </div>
            )}
          </For>
          <div class="flex items-center gap-2">
            <Button type="submit" size="sm" data-testid={`${tid()}-add-save`} disabled={saving()}>
              {i18n.t("kernel.dashboards.tables.save")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid={`${tid()}-add-cancel`}
              onClick={() => setAdding(false)}
            >
              {i18n.t("kernel.common.cancel")}
            </Button>
          </div>
          <Show when={addError()}>
            <p data-testid={`${tid()}-add-error`} class="w-full text-[12px] text-error">
              {addError()}
            </p>
          </Show>
        </form>
      </Show>

      <Switch>
        <Match when={status() === "loading"}>
          <div data-testid={`${tid()}-loading`} class="space-y-2 py-2">
            <Skeleton class="h-5 w-full" />
            <Skeleton class="h-5 w-full" />
            <Skeleton class="h-5 w-3/4" />
          </div>
        </Match>
        <Match when={status() === "error"}>
          <p
            data-testid={`${tid()}-error`}
            data-error={failure()}
            class="py-4 text-[13px] text-text-tertiary"
          >
            {failure() === "not_found"
              ? i18n.t("kernel.dashboards.tables.notFound")
              : i18n.t("kernel.dashboards.tables.loadFailed")}{" "}
            <Show when={failure() !== "not_found"}>
              <button
                type="button"
                data-testid={`${tid()}-retry`}
                onClick={() => void load()}
                class="underline underline-offset-2 hover:text-text-secondary"
              >
                {i18n.t("kernel.dashboards.tables.retry")}
              </button>
            </Show>
          </p>
        </Match>
        <Match when={status() === "ready" && rows().length === 0 && cursors().length === 1}>
          <div
            data-testid={`${tid()}-empty`}
            class="flex items-center gap-3 py-3 text-[13px] text-text-tertiary"
          >
            <span>{i18n.t("kernel.dashboards.tables.empty")}</span>
            <Show when={canEdit() && !adding()}>
              <Button variant="outline" size="sm" data-testid={`${tid()}-add`} onClick={openAdd}>
                <Plus size={13} />
                {backing()
                  ? i18n.t("kernel.dashboards.tables.addTask")
                  : i18n.t("kernel.dashboards.tables.add")}
              </Button>
            </Show>
          </div>
        </Match>
        <Match when={status() === "ready"}>
          <div class="min-w-0 overflow-x-auto">
            <table data-testid={`${tid()}-grid`} class="w-full border-collapse text-[13px]">
              <thead>
                <tr class="border-b border-border-subtle">
                  <For each={columns()}>
                    {(c) => (
                      <th
                        scope="col"
                        aria-sort={
                          sort()?.key === c.key
                            ? sort()?.dir === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                        class={cn(
                          "px-1.5 py-1.5 font-normal",
                          numeric(c) ? "text-right" : "text-left",
                        )}
                      >
                        <button
                          type="button"
                          data-testid={`${tid()}-sort-${c.key}`}
                          data-source={
                            backing() ? (isReadThrough(c.key) ? "record" : "own") : undefined
                          }
                          title={
                            backing()
                              ? isReadThrough(c.key)
                                ? i18n.t("kernel.dashboards.tables.fromProjectColumn", {
                                    name: parentName(),
                                  })
                                : i18n.t("kernel.dashboards.tables.ownColumn")
                              : undefined
                          }
                          onClick={() => sortBy(c.key)}
                          class="inline-flex items-center gap-1 text-[11.5px] text-text-tertiary hover:text-text-secondary"
                        >
                          <Show when={isReadThrough(c.key)}>
                            <Link2
                              size={11}
                              data-testid={`${tid()}-from-record-${c.key}`}
                              aria-label={i18n.t("kernel.dashboards.tables.fromProjectColumn", {
                                name: parentName(),
                              })}
                              class="shrink-0 opacity-70"
                            />
                          </Show>
                          {c.label}
                          <Show when={sort()?.key === c.key}>
                            {sort()?.dir === "asc" ? " ↑" : " ↓"}
                          </Show>
                        </button>
                      </th>
                    )}
                  </For>
                  <th
                    scope="col"
                    class="px-1.5 py-1.5 text-left text-[11.5px] font-normal text-text-tertiary"
                  >
                    {i18n.t("kernel.dashboards.tables.lastChange")}
                  </th>
                  <th scope="col" class="w-8">
                    <span class="sr-only">{i18n.t("kernel.dashboards.tables.rowActions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <>
                      <tr
                        data-testid={`${tid()}-row-${row.id}`}
                        class="border-b border-border-subtle align-middle"
                      >
                        <For each={columns()}>
                          {(c) => (
                            <td
                              data-testid={`${tid()}-cell-${row.id}-${c.key}`}
                              class={cn(
                                "max-w-[16rem] px-1.5 py-1.5",
                                numeric(c) && "text-right tabular-nums",
                              )}
                            >
                              <Switch>
                                <Match when={c.type === "checkbox"}>
                                  <input
                                    type="checkbox"
                                    data-testid={`${tid()}-check-${row.id}-${c.key}`}
                                    aria-label={c.label}
                                    checked={row.cells[c.key] === true}
                                    disabled={!canEdit() || saving()}
                                    onChange={(e) => void saveCell(row, c, e.currentTarget.checked)}
                                  />
                                </Match>
                                <Match when={isEditing(row, c)}>
                                  <CellEditor
                                    column={c}
                                    value={row.cells[c.key]}
                                    testid={`${tid()}-editor-${row.id}-${c.key}`}
                                    onCommit={(v) => void saveCell(row, c, v)}
                                    onCancel={() => setEditing(null)}
                                  />
                                </Match>
                                <Match when={isLinkCell(row.cells[c.key])}>
                                  <span class="flex min-h-6 items-center gap-1 px-1">
                                    <LinkOpen row={row} column={c} />
                                    <Show when={canEdit()}>
                                      <button
                                        type="button"
                                        data-testid={`${tid()}-edit-${row.id}-${c.key}`}
                                        aria-label={i18n.t("kernel.dashboards.tables.editCell", {
                                          column: c.label,
                                        })}
                                        title={i18n.t("kernel.dashboards.tables.editCell", {
                                          column: c.label,
                                        })}
                                        disabled={saving()}
                                        onClick={() => {
                                          setRowNotice(null)
                                          setEditing({ rowId: row.id, key: c.key })
                                        }}
                                        class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                                      >
                                        <Pencil size={11} />
                                      </button>
                                    </Show>
                                  </span>
                                </Match>
                                <Match when={canEdit()}>
                                  <button
                                    type="button"
                                    data-testid={`${tid()}-edit-${row.id}-${c.key}`}
                                    aria-label={i18n.t("kernel.dashboards.tables.editCell", {
                                      column: c.label,
                                    })}
                                    disabled={saving()}
                                    onClick={() => {
                                      setRowNotice(null)
                                      setEditing({ rowId: row.id, key: c.key })
                                    }}
                                    class={cn(
                                      "flex min-h-6 w-full min-w-[2rem] items-center rounded px-1 hover:bg-surface-hover",
                                      numeric(c) ? "justify-end" : "justify-start",
                                    )}
                                  >
                                    <CellView row={row} column={c} />
                                  </button>
                                </Match>
                                <Match when={true}>
                                  <span class="flex min-h-6 items-center px-1">
                                    <CellView row={row} column={c} />
                                  </span>
                                </Match>
                              </Switch>
                            </td>
                          )}
                        </For>
                        <td class="px-1.5 py-1.5">
                          <Show when={isStale(row.updatedAt, now(), props.staleAfterDays)}>
                            <span
                              data-testid={`${tid()}-stale-${row.id}`}
                              title={i18n.t("kernel.dashboards.tables.toConfirmHint", {
                                days: props.staleAfterDays ?? 0,
                              })}
                              class="mb-0.5 inline-flex rounded-full border border-border-subtle px-1.5 text-[11px] text-text-secondary"
                            >
                              {i18n.t("kernel.dashboards.tables.toConfirm")}
                            </span>
                          </Show>
                          <button
                            type="button"
                            data-testid={`${tid()}-history-${row.id}`}
                            title={row.updatedAt}
                            aria-label={i18n.t("kernel.dashboards.tables.openHistory")}
                            onClick={() => setHistoryRow(historyRow()?.id === row.id ? null : row)}
                            class="flex items-center gap-1 whitespace-nowrap text-[12px] text-text-tertiary hover:text-text-secondary"
                          >
                            <History size={12} class="shrink-0" />
                            {i18n.t("kernel.dashboards.tables.lastChangeBy", {
                              name: row.updatedBy.label,
                              when: relativeTime(row.updatedAt, now(), i18n.locale(), i18n.t),
                            })}
                          </button>
                        </td>
                        <td class="px-1 py-1.5 text-right">
                          <Show when={canEdit() && backing()}>
                            <span
                              data-testid={`${tid()}-delete-off-${row.id}`}
                              title={i18n.t("kernel.dashboards.tables.deleteRowBacked", {
                                name: parentName(),
                              })}
                              class="flex h-6 w-6 items-center justify-center text-text-tertiary opacity-40"
                            >
                              <Trash2
                                size={13}
                                aria-label={i18n.t("kernel.dashboards.tables.deleteRowBacked", {
                                  name: parentName(),
                                })}
                              />
                            </span>
                          </Show>
                          <Show when={canEdit() && !backing()}>
                            <button
                              type="button"
                              data-testid={`${tid()}-delete-${row.id}`}
                              aria-label={i18n.t("kernel.dashboards.tables.deleteRow")}
                              title={i18n.t("kernel.dashboards.tables.deleteRow")}
                              disabled={saving()}
                              onClick={() => setConfirmDelete(row)}
                              class="flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text-secondary disabled:opacity-50"
                            >
                              <Trash2 size={13} />
                            </button>
                          </Show>
                        </td>
                      </tr>
                      <Show when={rowNotice()?.rowId === row.id}>
                        <tr data-testid={`${tid()}-notice-${row.id}`}>
                          <td
                            colSpan={columns().length + 2}
                            class="px-1.5 pb-1.5 text-[12px] text-text-tertiary"
                          >
                            {rowNotice()?.text}
                          </td>
                        </tr>
                      </Show>
                    </>
                  )}
                </For>
              </tbody>
            </table>
          </div>
          <Show when={cursors().length > 1 || nextCursor()}>
            <div
              data-testid={`${tid()}-pager`}
              class="flex items-center justify-end gap-2 text-[12px] text-text-tertiary"
            >
              <span data-testid={`${tid()}-page`}>
                {i18n.t("kernel.dashboards.tables.page", { page: cursors().length })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                data-testid={`${tid()}-prev`}
                disabled={cursors().length <= 1}
                onClick={() => goTo("previous")}
              >
                {i18n.t("kernel.dashboards.tables.previous")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid={`${tid()}-next`}
                disabled={!nextCursor()}
                onClick={() => goTo("next")}
              >
                {i18n.t("kernel.dashboards.tables.next")}
              </Button>
            </div>
          </Show>
        </Match>
      </Switch>

      <Show when={historyRow()}>
        {(r) => (
          <div class="rounded-md border border-border-subtle p-3">
            <RowHistoryPanel
              tableId={props.tableId}
              columns={table()?.columns ?? []}
              rowId={r().id}
              title={(() => {
                const label = rowLabel(columns(), r().cells, textOpts())
                return label
                  ? i18n.t("kernel.dashboards.tables.historyOf", { row: label })
                  : i18n.t("kernel.dashboards.tables.history")
              })()}
              canUndo={canEdit()}
              reloadKey={historyKey()}
              now={now()}
              testid={`${tid()}-row-history`}
              onClose={() => setHistoryRow(null)}
              onUndone={() => void reloadRows().catch(() => {})}
            />
          </div>
        )}
      </Show>

      <TableConfirmDialog
        open={confirmDelete() !== null}
        title={i18n.t("kernel.dashboards.tables.deleteRowTitle")}
        body={i18n.t("kernel.dashboards.tables.deleteRowBody")}
        confirmLabel={i18n.t("kernel.common.delete")}
        testid={`${tid()}-delete-dialog`}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const r = confirmDelete()
          if (r) void deleteRow(r)
        }}
      />
    </div>
  )
}
