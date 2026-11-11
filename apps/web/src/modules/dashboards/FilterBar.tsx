// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARD'S FILTERS, under its toolbar: one control per filter the
// dashboard declares. A select or a multi is a button reading "Market: All" /
// "Market: FR" that opens a menu of the values (a static list, or the values
// the source holds, read when the menu opens); a text filter is a small field,
// applied on Enter or when it loses focus. "All" is the empty state. A reset
// goes back to the dashboard's defaults. The row wraps on a phone.
import { Check, ListFilter, RotateCcw } from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { PopupMenu } from "~/ui/PopupMenu"
import type { DashboardFilterDef, FilterOptionsResult, FilterValues } from "./dashboards-client"
import { staticOptions, valueText } from "./filters"

export interface FilterBarProps {
  filters: DashboardFilterDef[]
  values: FilterValues
  onChange: (filterId: string, values: string[]) => void
  /** Shown when the values differ from the dashboard's defaults. */
  canReset: boolean
  onReset: () => void
  /** Reads a filter's options from the server (for the range and the other values shown). */
  loadOptions: (filterId: string) => Promise<FilterOptionsResult>
}

export const FilterBar: Component<FilterBarProps> = (props) => {
  const i18n = useI18n()
  return (
    <fieldset
      data-testid="dashboard-filters"
      aria-label={i18n.t("kernel.dashboards.filtersAria")}
      class="m-0 flex min-w-0 flex-wrap items-center gap-2 border-0 border-b border-border-subtle px-4 py-2"
    >
      <ListFilter size={13} aria-hidden="true" class="shrink-0 text-text-tertiary" />
      <For each={props.filters}>
        {(def) => (
          <Show
            when={def.type === "text"}
            fallback={
              <ChoiceFilter
                def={def}
                values={props.values[def.id] ?? []}
                onChange={(v) => props.onChange(def.id, v)}
                loadOptions={() => props.loadOptions(def.id)}
              />
            }
          >
            <TextFilter
              def={def}
              value={props.values[def.id]?.[0] ?? ""}
              onChange={(v) => props.onChange(def.id, v === "" ? [] : [v])}
            />
          </Show>
        )}
      </For>
      <Show when={props.canReset}>
        <Button
          variant="ghost"
          size="sm"
          data-testid="dashboard-filters-reset"
          onClick={() => props.onReset()}
        >
          <RotateCcw size={12} />
          {i18n.t("kernel.dashboards.filtersReset")}
        </Button>
      </Show>
    </fieldset>
  )
}

type OptionsState =
  | { status: "idle" | "loading" }
  | { status: "ready"; options: string[]; truncated: boolean }
  | { status: "error" }

const ChoiceFilter: Component<{
  def: DashboardFilterDef
  values: string[]
  onChange: (values: string[]) => void
  loadOptions: () => Promise<FilterOptionsResult>
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const [state, setState] = createSignal<OptionsState>({ status: "idle" })
  const multi = () => props.def.type === "multi"
  const all = () => i18n.t("kernel.dashboards.filterAll")
  let seq = 0

  const load = async () => {
    const fixed = staticOptions(props.def)
    if (fixed) {
      setState({ status: "ready", options: fixed, truncated: false })
      return
    }
    const mine = ++seq
    // The options shown stay while they are read again (the range or another filter moved).
    if (state().status !== "ready") setState({ status: "loading" })
    const r = await props.loadOptions()
    if (mine !== seq) return
    setState(
      r.ok ? { status: "ready", options: r.options, truncated: r.truncated } : { status: "error" },
    )
  }
  /** The options, with the values picked first kept even when the source no longer holds them. */
  const options = () => {
    const s = state()
    const listed = s.status === "ready" ? s.options : []
    const missing = props.values.filter((v) => !listed.includes(v))
    return [...missing, ...listed]
  }
  const toggle = (v: string) => {
    if (!multi()) {
      props.onChange([v])
      return
    }
    props.onChange(
      props.values.includes(v) ? props.values.filter((x) => x !== v) : [...props.values, v],
    )
  }
  const text = () => valueText(props.values, all())

  return (
    <PopupMenu
      open={open()}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) void load()
      }}
    >
      <PopupMenu.Trigger
        data-testid={`dashboard-filter-${props.def.id}`}
        data-filter-type={props.def.type}
        data-value={props.values.join(",")}
        aria-label={i18n.t("kernel.dashboards.filterAria", {
          label: props.def.label,
          value: text(),
        })}
        title={`${props.def.label}: ${props.values.join(", ") || all()}`}
        class="flex h-8 min-w-0 max-w-full items-center gap-1 rounded-md border border-border px-2.5 text-[12.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
      >
        <span class="shrink-0 text-text-tertiary">{props.def.label}:</span>
        <span data-testid={`dashboard-filter-value-${props.def.id}`} class="truncate">
          {text()}
        </span>
      </PopupMenu.Trigger>
      <PopupMenu.Content
        data-testid={`dashboard-filter-menu-${props.def.id}`}
        class="max-h-[60vh] min-w-[12rem] overflow-y-auto"
      >
        <PopupMenu.Group>
          <PopupMenu.Label>{props.def.label}</PopupMenu.Label>
          <PopupMenu.Item
            data-testid={`dashboard-filter-all-${props.def.id}`}
            onSelect={() => props.onChange([])}
          >
            <Check
              size={13}
              aria-hidden="true"
              class={props.values.length === 0 ? "" : "invisible"}
            />
            {all()}
          </PopupMenu.Item>
          <For each={options()}>
            {(option, i) => (
              <PopupMenu.Item
                data-testid={`dashboard-filter-option-${props.def.id}-${i()}`}
                textValue={option}
                closeOnSelect={!multi()}
                onSelect={() => toggle(option)}
              >
                <Check
                  size={13}
                  aria-hidden="true"
                  class={props.values.includes(option) ? "" : "invisible"}
                />
                <span class="truncate">{option}</span>
              </PopupMenu.Item>
            )}
          </For>
        </PopupMenu.Group>
        <Show when={state().status === "loading"}>
          <p
            data-testid={`dashboard-filter-loading-${props.def.id}`}
            class="px-3 py-1.5 text-[12px] text-text-tertiary"
          >
            {i18n.t("kernel.dashboards.filterLoading")}
          </p>
        </Show>
        <Show when={state().status === "error"}>
          <p
            data-testid={`dashboard-filter-error-${props.def.id}`}
            class="px-3 py-1.5 text-[12px] text-text-tertiary"
          >
            {i18n.t("kernel.dashboards.filterOptionsFailed")}
          </p>
        </Show>
        <Show
          when={(() => {
            const s = state()
            return s.status === "ready" && s.truncated
          })()}
        >
          <p class="px-3 py-1.5 text-[12px] text-text-tertiary">
            {i18n.t("kernel.dashboards.filterTruncated")}
          </p>
        </Show>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

const TextFilter: Component<{
  def: DashboardFilterDef
  value: string
  onChange: (value: string) => void
}> = (props) => {
  const i18n = useI18n()
  const commit = (raw: string) => {
    const v = raw.trim()
    if (v !== props.value) props.onChange(v)
  }
  return (
    <label class="flex h-8 min-w-0 max-w-full items-center gap-1 rounded-md border border-border px-2.5 text-[12.5px] text-text-secondary focus-within:border-accent">
      <span class="shrink-0 text-text-tertiary">{props.def.label}:</span>
      <input
        type="search"
        data-testid={`dashboard-filter-${props.def.id}`}
        data-filter-type="text"
        value={props.value}
        maxLength={200}
        placeholder={i18n.t("kernel.dashboards.filterAll")}
        aria-label={props.def.label}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value)
        }}
        onBlur={(e) => commit(e.currentTarget.value)}
        class="w-28 min-w-0 bg-transparent text-text outline-none placeholder:text-text-tertiary"
      />
    </label>
  )
}
