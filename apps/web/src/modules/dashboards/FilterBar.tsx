// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARD'S FILTERS, under its toolbar: one control per filter the
// dashboard declares. A select or a multi is a button reading "Market: All" /
// "Market: FR" that opens a menu of the values (a static list, or the values
// the source holds, read when the menu opens); a multi's ticks apply together
// when its menu closes, so one menu session is one read of the blocks; a text
// filter is a small field, applied on Enter or when it loses focus. "All" is the empty state. A reset
// goes back to the dashboard's defaults. The row wraps on a phone.
//
// A menu whose values come from a source has a search box at its top: the server searches every
// value (`?q=`), so a value past the first 200 listed can still be found. A long static list is
// searched in place.
import { Check, ListFilter, RotateCcw, Search } from "lucide-solid"
import { type Component, createSignal, For, onCleanup, Show } from "solid-js"
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
  loadOptions: (filterId: string, q?: string) => Promise<FilterOptionsResult>
}

/** A static list longer than this gets a search box too. */
const STATIC_SEARCH_MIN = 10
/** The pause after typing before the server is asked. */
export const FILTER_SEARCH_DEBOUNCE_MS = 250

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
                loadOptions={(q) => props.loadOptions(def.id, q)}
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
  loadOptions: (q?: string) => Promise<FilterOptionsResult>
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const [state, setState] = createSignal<OptionsState>({ status: "idle" })
  const multi = () => props.def.type === "multi"
  const all = () => i18n.t("kernel.dashboards.filterAll")
  // A multi's ticks while its menu is open: applied once, when it closes.
  const [draft, setDraft] = createSignal<string[] | null>(null)
  const current = () => draft() ?? props.values
  const commit = () => {
    const d = draft()
    setDraft(null)
    if (!d) return
    const same = d.length === props.values.length && d.every((v) => props.values.includes(v))
    if (!same) props.onChange(d)
  }
  let seq = 0
  const [query, setQuery] = createSignal("")
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(searchTimer))
  const fixed = () => staticOptions(props.def)
  /** The menu has a search box: values read from a source, or a long static list. */
  const searchable = () => {
    const f = fixed()
    return !f || f.length > STATIC_SEARCH_MIN
  }

  const load = async (q = query()) => {
    const f = fixed()
    if (f) {
      setState({ status: "ready", options: f, truncated: false })
      return
    }
    const mine = ++seq
    // The options shown stay while they are read again (the range or another filter moved).
    if (state().status !== "ready") setState({ status: "loading" })
    const r = await props.loadOptions(q.trim() || undefined)
    if (mine !== seq) return
    setState(
      r.ok ? { status: "ready", options: r.options, truncated: r.truncated } : { status: "error" },
    )
  }
  const search = (q: string) => {
    setQuery(q)
    clearTimeout(searchTimer)
    if (fixed()) return
    searchTimer = setTimeout(() => void load(q), FILTER_SEARCH_DEBOUNCE_MS)
  }
  /** The options, with the values picked first kept even when the source no longer holds them. */
  const options = () => {
    const s = state()
    let listed = s.status === "ready" ? s.options : []
    const q = query().trim().toLowerCase()
    // A static list is searched here; a source's values were searched by the server.
    if (q && fixed()) listed = listed.filter((o) => o.toLowerCase().includes(q))
    const missing = q ? [] : current().filter((v) => !listed.includes(v))
    return [...missing, ...listed]
  }
  const toggle = (v: string) => {
    if (!multi()) {
      props.onChange([v])
      return
    }
    const now = current()
    setDraft(now.includes(v) ? now.filter((x) => x !== v) : [...now, v])
  }
  const text = () => valueText(current(), all())

  return (
    <PopupMenu
      open={open()}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) {
          setQuery("")
          void load("")
        } else {
          clearTimeout(searchTimer)
          commit()
        }
      }}
    >
      <PopupMenu.Trigger
        data-testid={`dashboard-filter-${props.def.id}`}
        data-filter-type={props.def.type}
        data-value={current().join(",")}
        aria-label={i18n.t("kernel.dashboards.filterAria", {
          label: props.def.label,
          value: text(),
        })}
        title={`${props.def.label}: ${current().join(", ") || all()}`}
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
        <Show when={searchable()}>
          <div class="flex items-center gap-1.5 border-b border-border-subtle px-2.5 py-1.5">
            <Search size={12} aria-hidden="true" class="shrink-0 text-text-tertiary" />
            <input
              type="search"
              data-testid={`dashboard-filter-search-${props.def.id}`}
              aria-label={i18n.t("kernel.dashboards.filterSearch", { label: props.def.label })}
              placeholder={i18n.t("kernel.dashboards.filterSearchPlaceholder")}
              value={query()}
              maxLength={200}
              ref={(el) => setTimeout(() => el.focus(), 0)}
              onInput={(e) => search(e.currentTarget.value)}
              // The menu's own keys (type to jump, arrows) must not take the letters typed here.
              onKeyDown={(e) => {
                if (e.key !== "Escape" && e.key !== "Tab" && e.key !== "ArrowDown") {
                  e.stopPropagation()
                }
              }}
              class="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] text-text outline-none placeholder:text-text-tertiary"
            />
          </div>
        </Show>
        <PopupMenu.Group>
          <PopupMenu.Label>{props.def.label}</PopupMenu.Label>
          <PopupMenu.Item
            data-testid={`dashboard-filter-all-${props.def.id}`}
            onSelect={() => {
              if (!multi()) {
                props.onChange([])
                return
              }
              setDraft([])
              commit()
            }}
          >
            <Check size={13} aria-hidden="true" class={current().length === 0 ? "" : "invisible"} />
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
                  class={current().includes(option) ? "" : "invisible"}
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
          <p
            data-testid={`dashboard-filter-truncated-${props.def.id}`}
            class="px-3 py-1.5 text-[12px] text-text-tertiary"
          >
            {i18n.t(
              searchable()
                ? "kernel.dashboards.filterTruncatedSearch"
                : "kernel.dashboards.filterTruncated",
            )}
          </p>
        </Show>
        <Show when={query().trim() !== "" && state().status === "ready" && options().length === 0}>
          <p
            data-testid={`dashboard-filter-nomatch-${props.def.id}`}
            class="px-3 py-1.5 text-[12px] text-text-tertiary"
          >
            {i18n.t("kernel.dashboards.filterNoMatch")}
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
