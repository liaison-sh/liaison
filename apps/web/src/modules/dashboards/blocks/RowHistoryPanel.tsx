// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A table's change history: one row's (the grid's history panel) or the whole table's (the
// table page's History tab). Each change says who made it ("Nico", "@support", "Routine X"),
// when, and what changed ("Status: In production → In transit"). An editor may undo a change
// the server still allows: the row's before cells are written back as a new change. A row
// changed since is not undone: the panel says by whom.
import { type Component, createEffect, createSignal, For, on, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Skeleton } from "~/ui/Skeleton"
import {
  getTableChanges,
  type TableChange,
  type TableColumn,
  type TableRow,
  type TablesApi,
  tableErrorFrom,
  undoTableChange,
} from "../dashboards-client"
import { changeSummary, relativeTime } from "./table-cells"
import { personName } from "./table-people"

export interface RowHistoryPanelProps {
  tableId: string
  columns: TableColumn[]
  /** One row's history; absent: the whole table's. */
  rowId?: string
  /** The panel's heading ("History · B4"). */
  title: string
  /** The viewer may undo (an editor of the table). */
  canUndo: boolean
  /** A change is reloaded when this changes (the grid saved a cell). */
  reloadKey?: unknown
  onClose?: () => void
  /** An undo went through: the grid shows the row as it is now. */
  onUndone?: (row: TableRow | null) => void
  now?: number
  testid?: string
}

export const RowHistoryPanel: Component<RowHistoryPanelProps> = (props) => {
  const i18n = useI18n()
  const api = useApi() as unknown as TablesApi
  const [changes, setChanges] = createSignal<TableChange[]>([])
  const [next, setNext] = createSignal<string | null>(null)
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">("loading")
  const [notice, setNotice] = createSignal<{ changeId: string; text: string } | null>(null)
  const [undoing, setUndoing] = createSignal<string | null>(null)
  const tid = () => props.testid ?? "table-history"
  let seq = 0

  async function load(cursor: string | null = null): Promise<void> {
    const mine = ++seq
    if (!cursor) setStatus("loading")
    try {
      const page = await getTableChanges(api, props.tableId, { rowId: props.rowId, cursor })
      if (mine !== seq) return
      setChanges((prev) => (cursor ? [...prev, ...page.changes] : page.changes))
      setNext(page.nextCursor)
      setStatus("ready")
    } catch {
      if (mine === seq) setStatus("error")
    }
  }

  createEffect(
    on(
      () => [props.tableId, props.rowId, props.reloadKey] as const,
      () => void load(),
    ),
  )

  async function undo(change: TableChange): Promise<void> {
    setUndoing(change.id)
    setNotice(null)
    try {
      const row = await undoTableChange(api, props.tableId, change.id)
      props.onUndone?.(row)
      await load()
    } catch (err) {
      const e = tableErrorFrom(err)
      const who = e.current?.updatedBy.label
      setNotice({
        changeId: change.id,
        text:
          e.code === "version_conflict"
            ? who
              ? i18n.t("kernel.dashboards.tables.undoChangedSince", { name: who })
              : i18n.t("kernel.dashboards.tables.undoChangedSinceAnon")
            : i18n.t("kernel.dashboards.tables.undoFailed"),
      })
      if (e.code === "version_conflict") props.onUndone?.(e.current ?? null)
    } finally {
      setUndoing(null)
    }
  }

  const summaryOpts = () => ({ locale: i18n.locale(), personName, t: i18n.t })

  return (
    <section data-testid={tid()} class="flex min-w-0 flex-col gap-2" aria-label={props.title}>
      <header class="flex items-center gap-2">
        <h3
          data-testid={`${tid()}-title`}
          class="min-w-0 flex-1 truncate text-[13px] font-medium text-text"
        >
          {props.title}
        </h3>
        <Show when={props.onClose}>
          <button
            type="button"
            data-testid={`${tid()}-close`}
            onClick={() => props.onClose?.()}
            class="text-[12px] text-text-tertiary hover:text-text-secondary"
          >
            {i18n.t("kernel.dashboards.tables.close")}
          </button>
        </Show>
      </header>
      <Show when={status() === "loading"}>
        <div data-testid={`${tid()}-loading`} class="space-y-2">
          <Skeleton class="h-4 w-2/3" />
          <Skeleton class="h-4 w-1/2" />
        </div>
      </Show>
      <Show when={status() === "error"}>
        <p data-testid={`${tid()}-error`} class="text-[12.5px] text-text-tertiary">
          {i18n.t("kernel.dashboards.tables.historyFailed")}{" "}
          <button
            type="button"
            data-testid={`${tid()}-retry`}
            onClick={() => void load()}
            class="underline underline-offset-2 hover:text-text-secondary"
          >
            {i18n.t("kernel.dashboards.tables.retry")}
          </button>
        </p>
      </Show>
      <Show when={status() === "ready" && changes().length === 0}>
        <p data-testid={`${tid()}-empty`} class="text-[12.5px] text-text-tertiary">
          {i18n.t("kernel.dashboards.tables.historyEmpty")}
        </p>
      </Show>
      <Show when={status() === "ready" && changes().length > 0}>
        <ol class="flex flex-col">
          <For each={changes()}>
            {(c) => (
              <li
                data-testid={`${tid()}-change-${c.id}`}
                data-op={c.op}
                class="flex flex-col gap-0.5 border-b border-border-subtle py-2 text-[13px]"
              >
                <div class="flex items-baseline justify-between gap-2">
                  <span class="truncate font-medium text-text">{c.actor.label}</span>
                  <span class="shrink-0 text-[11.5px] text-text-tertiary" title={c.at}>
                    {relativeTime(c.at, props.now ?? Date.now(), i18n.locale(), i18n.t)}
                  </span>
                </div>
                <p class="text-text-secondary">{changeSummary(c, props.columns, summaryOpts())}</p>
                <Show when={props.canUndo && c.undoable}>
                  <button
                    type="button"
                    data-testid={`${tid()}-undo-${c.id}`}
                    disabled={undoing() !== null}
                    onClick={() => void undo(c)}
                    class="self-start text-[12px] text-text-tertiary underline underline-offset-2 hover:text-text-secondary disabled:opacity-50"
                  >
                    {i18n.t("kernel.dashboards.tables.undo")}
                  </button>
                </Show>
                <Show when={notice()?.changeId === c.id}>
                  <p data-testid={`${tid()}-notice`} class="text-[12px] text-text-tertiary">
                    {notice()?.text}
                  </p>
                </Show>
              </li>
            )}
          </For>
        </ol>
        <Show when={next()}>
          <button
            type="button"
            data-testid={`${tid()}-more`}
            onClick={() => void load(next())}
            class="self-start text-[12px] text-text-tertiary underline underline-offset-2 hover:text-text-secondary"
          >
            {i18n.t("kernel.dashboards.tables.showMore")}
          </button>
        </Show>
      </Show>
    </section>
  )
}
