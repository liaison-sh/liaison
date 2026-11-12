// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE FILTERS IN EDIT MODE, at the top of the dashboard: each filter's name, editable in place,
// with a button to remove it, and "Add filter", which opens a short form inline (no modal): the
// filter's name, its kind (choose one, choose several, type text), a field the blocks' rows
// carry (read from the server when the form opens), and the blocks it applies to (every block
// carrying the field, ticked). Saving sends the operations of filter-editor.ts through the same
// edit route as every other change: versioned, in the history, undoable. Viewers keep picking
// values in the filter bar, remembered per person.
import { Plus, X } from "lucide-solid"
import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import type { DashboardSpec, EditOperation, FilterType } from "./dashboards-client"
import {
  addFilterOps,
  type FilterField,
  type FilterTarget,
  fieldsFrom,
  filterTargets,
  MAX_FILTER_LABEL,
  MAX_FILTERS,
  removeFilterOps,
  renameFilterOp,
  targetKey,
  targetsOfFilter,
} from "./filter-editor"

export interface FilterEditorProps {
  spec: DashboardSpec
  /** Saves the operations as one change; resolves true when saved. */
  apply: (operations: EditOperation[]) => Promise<boolean>
  /** The fields a block's (or a layer's) rows carry; null when they could not be read. */
  loadFields: (target: FilterTarget) => Promise<string[] | null>
  busy?: boolean
}

const TYPES: { type: FilterType; key: string }[] = [
  { type: "select", key: "kernel.dashboards.filterTypeSelect" },
  { type: "multi", key: "kernel.dashboards.filterTypeMulti" },
  { type: "text", key: "kernel.dashboards.filterTypeText" },
]

const inputClass =
  "rounded-md border border-border-subtle bg-bg px-2 py-1 text-[12.5px] text-text outline-none placeholder:text-text-tertiary focus:border-accent"

export const FilterEditor: Component<FilterEditorProps> = (props) => {
  const i18n = useI18n()
  const filters = () => props.spec.filters ?? []
  const [adding, setAdding] = createSignal(false)
  const [label, setLabel] = createSignal("")
  const [type, setType] = createSignal<FilterType>("select")
  const [fields, setFields] = createSignal<FilterField[] | null>(null)
  const [fieldsFailed, setFieldsFailed] = createSignal(false)
  const [field, setField] = createSignal("")
  const [picked, setPicked] = createSignal<Set<string>>(new Set())
  const [problem, setProblem] = createSignal<string | null>(null)

  const targetName = (t: FilterTarget) => {
    const block = props.spec.blocks.find((b) => b.id === t.blockId)
    const title = block?.title || t.blockId
    if (!t.layerId) return title
    const layer = block?.layers?.find((l) => l.id === t.layerId)
    return `${title} · ${layer?.label ?? t.layerId}`
  }
  const carrying = createMemo(() => fields()?.find((f) => f.field === field())?.targets ?? [])

  const open = async () => {
    setAdding(true)
    setLabel("")
    setType("select")
    setField("")
    setPicked(new Set<string>())
    setProblem(null)
    setFields(null)
    setFieldsFailed(false)
    const targets = filterTargets(props.spec)
    const read = await Promise.all(
      targets.map(async (target) => ({ target, fields: await props.loadFields(target) })),
    )
    if (read.every((r) => r.fields === null)) setFieldsFailed(true)
    setFields(fieldsFrom(read.map((r) => ({ target: r.target, fields: r.fields ?? [] }))))
  }
  const pickField = (f: string) => {
    setField(f)
    const targets = fields()?.find((x) => x.field === f)?.targets ?? []
    setPicked(new Set(targets.map(targetKey)))
    if (!label().trim() && f) setLabel(f.slice(0, MAX_FILTER_LABEL))
  }
  const toggle = (key: string, on: boolean) => {
    const next = new Set(picked())
    if (on) next.add(key)
    else next.delete(key)
    setPicked(next)
  }
  const ready = () => label().trim() !== "" && field() !== "" && picked().size > 0 && !props.busy
  const save = async () => {
    if (!ready()) return
    const targets = carrying().filter((t) => picked().has(targetKey(t)))
    const ops = addFilterOps(props.spec, { label: label(), type: type(), field: field(), targets })
    if (!ops) {
      setProblem(i18n.t("kernel.dashboards.filterNoOptions"))
      return
    }
    if (await props.apply(ops)) setAdding(false)
  }

  return (
    <section
      data-testid="dashboard-filter-editor"
      aria-label={i18n.t("kernel.dashboards.filterEditorAria")}
      class="border-b border-border-subtle px-4 py-2"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[12px] text-text-tertiary">
          {i18n.t("kernel.dashboards.filtersLabel")}
        </span>
        <For each={filters()}>
          {(def) => (
            <span
              data-testid={`dashboard-filter-edit-${def.id}`}
              class="flex items-center gap-1 rounded-md border border-border-subtle bg-bg pl-1"
            >
              <input
                data-testid={`dashboard-filter-rename-${def.id}`}
                aria-label={i18n.t("kernel.dashboards.filterRename", { label: def.label })}
                value={def.label}
                maxLength={MAX_FILTER_LABEL}
                size={Math.max(6, Math.min(24, def.label.length + 1))}
                disabled={props.busy}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur()
                  if (e.key === "Escape") {
                    e.currentTarget.value = def.label
                    e.currentTarget.blur()
                  }
                }}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim()
                  if (!v) e.currentTarget.value = def.label
                  else if (v !== def.label) void props.apply([renameFilterOp(def, v)])
                }}
                class="w-auto border-0 bg-transparent px-1 py-0.5 text-[12.5px] text-text outline-none"
              />
              <span class="text-[11.5px] text-text-tertiary">
                {i18n.t("kernel.dashboards.filterAppliesTo", {
                  count: targetsOfFilter(props.spec, def.id).length,
                })}
              </span>
              <button
                type="button"
                data-testid={`dashboard-filter-remove-${def.id}`}
                aria-label={i18n.t("kernel.dashboards.filterRemove", { label: def.label })}
                title={i18n.t("kernel.dashboards.filterRemove", { label: def.label })}
                disabled={props.busy}
                onClick={() => void props.apply(removeFilterOps(props.spec, def.id))}
                class="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary disabled:opacity-50"
              >
                <X size={12} />
              </button>
            </span>
          )}
        </For>
        <Show when={!adding()}>
          <Button
            variant="ghost"
            size="sm"
            data-testid="dashboard-filter-add"
            disabled={props.busy || filters().length >= MAX_FILTERS}
            onClick={() => void open()}
          >
            <Plus size={12} />
            {i18n.t("kernel.dashboards.filterAdd")}
          </Button>
        </Show>
      </div>
      <Show when={adding()}>
        <div data-testid="dashboard-filter-new" class="mt-2 flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              data-testid="dashboard-filter-new-save"
              disabled={!ready()}
              onClick={() => void save()}
            >
              {i18n.t("kernel.dashboards.filterSave")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="dashboard-filter-new-cancel"
              onClick={() => setAdding(false)}
            >
              {i18n.t("kernel.dashboards.filterCancel")}
            </Button>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label class="flex items-center gap-1.5 text-[12px] text-text-secondary">
              {i18n.t("kernel.dashboards.filterField")}
              <Show
                when={fields()}
                fallback={
                  <span data-testid="dashboard-filter-new-loading" class="text-text-tertiary">
                    {i18n.t("kernel.dashboards.filterFieldsLoading")}
                  </span>
                }
              >
                <select
                  data-testid="dashboard-filter-new-field"
                  value={field()}
                  onChange={(e) => pickField(e.currentTarget.value)}
                  class={inputClass}
                >
                  <option value="">{i18n.t("kernel.dashboards.filterFieldPick")}</option>
                  <For each={fields() ?? []}>
                    {(f) => <option value={f.field}>{f.field}</option>}
                  </For>
                </select>
              </Show>
            </label>
            <label class="flex items-center gap-1.5 text-[12px] text-text-secondary">
              {i18n.t("kernel.dashboards.filterName")}
              <input
                data-testid="dashboard-filter-new-label"
                value={label()}
                maxLength={MAX_FILTER_LABEL}
                onInput={(e) => setLabel(e.currentTarget.value)}
                class={inputClass}
              />
            </label>
            <label class="flex items-center gap-1.5 text-[12px] text-text-secondary">
              {i18n.t("kernel.dashboards.filterType")}
              <select
                data-testid="dashboard-filter-new-type"
                value={type()}
                onChange={(e) => setType(e.currentTarget.value as FilterType)}
                class={inputClass}
              >
                <For each={TYPES}>{(t) => <option value={t.type}>{i18n.t(t.key)}</option>}</For>
              </select>
            </label>
          </div>
          <Show when={fields() && fields()?.length === 0}>
            <p data-testid="dashboard-filter-new-nofields" class="text-[12px] text-text-tertiary">
              {i18n.t(
                fieldsFailed()
                  ? "kernel.dashboards.filterFieldsFailed"
                  : "kernel.dashboards.filterNoFields",
              )}
            </p>
          </Show>
          <Show when={field() !== ""}>
            <fieldset class="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 border-0 p-0">
              <legend class="mb-1 text-[12px] text-text-secondary">
                {i18n.t("kernel.dashboards.filterAppliesLabel")}
              </legend>
              <For each={carrying()}>
                {(t) => (
                  <label class="flex items-center gap-1.5 text-[12.5px] text-text">
                    <input
                      type="checkbox"
                      data-testid={`dashboard-filter-new-target-${targetKey(t)}`}
                      checked={picked().has(targetKey(t))}
                      onChange={(e) => toggle(targetKey(t), e.currentTarget.checked)}
                    />
                    {targetName(t)}
                  </label>
                )}
              </For>
            </fieldset>
          </Show>
          <Show when={problem()}>
            <p data-testid="dashboard-filter-new-error" class="text-[12px] text-text-secondary">
              {problem()}
            </p>
          </Show>
        </div>
      </Show>
    </section>
  )
}
