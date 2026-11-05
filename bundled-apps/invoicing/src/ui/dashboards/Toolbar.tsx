// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared dashboard toolbar — date-range fields, segmented filters (status /
// market / channel), and an "Export CSV" action. Each dashboard mounts this
// above its table; the toolbar emits the current `DashboardFilter` upward via
// `onChange` so the dashboard re-runs its search and re-renders.
import { tr } from "../i18n"
import { type Component, createEffect, createSignal, type JSX, onCleanup, Show } from "solid-js"
import { Button, dateRangeInputClass, inputClass, Segmented } from "../kit"
import type { ChannelFilter, DashboardFilter, MarketFilter, SortOrder, StatusFilter } from "./types"

interface ToolbarProps {
  filter: DashboardFilter
  onChange: (next: DashboardFilter) => void
  onExportCsv?: () => void
  /** Statuses to surface as segments — dashboards differ here. */
  statusOptions?: StatusFilter[]
  /** Extra controls (e.g. a Group-by segmented control) rendered right-aligned
   *  before the Export action. */
  trailing?: JSX.Element
}

const STATUS_LABEL: Record<StatusFilter, string> = {
  all: "All",
  issued: "Issued",
  paid: "Paid",
  overdue: "Overdue",
  refunded: "Refunded",
}
const MARKET_OPTS: ReadonlyArray<{ value: MarketFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "eu", label: "EU" },
  { value: "non_eu", label: "Non-EU" },
]
const CHANNEL_OPTS: ReadonlyArray<{ value: ChannelFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "shopify", label: "Shopify" },
  { value: "manual", label: "Manual" },
]
const SORT_OPTS: ReadonlyArray<{ value: SortOrder; label: string }> = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
]
const DEFAULT_STATUS: StatusFilter[] = ["all", "issued", "paid", "overdue", "refunded"]

/**
 * WHAT THE SEARCH BOX SAYS IT SEARCHES, at each width.
 *
 * "Search number or customer" is the hint a desktop toolbar has room for. In
 * the phone toolbar the box shares its line with the Filters disclosure and
 * the hint was cut mid word, which reads as a rendering fault rather than as a
 * hint. The phone gets the one word that always fits; the field's aria-label
 * carries the full meaning at every width.
 */
export const SEARCH_PLACEHOLDER_WIDE = "Search number or customer"
export const SEARCH_PLACEHOLDER_PHONE = "Search"

export function searchPlaceholder(isPhone: boolean): string {
  return tr(isPhone ? SEARCH_PLACEHOLDER_PHONE : SEARCH_PLACEHOLDER_WIDE)
}

/**
 * THE PHONE TIER, the same 640px boundary the shell switches its own surface
 * on (@liaison/app-ui's card tables use it too). Below it the date range, the
 * three segmented groups, the group-by switch and Export CSV wrapped into four
 * stacked lines and pushed the table off the first screen, so they collapse
 * behind one disclosure. Above it nothing is hidden and there is no
 * disclosure at all: a desktop toolbar is already one line.
 */
const PHONE_QUERY = "(max-width: 639px)"

/** Reactive `true` while `query` matches. `false` wherever `matchMedia` is
 *  absent, so a non-DOM render is the full, uncollapsed toolbar. */
function createMediaMatch(query: string): () => boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => false
  const list = window.matchMedia(query)
  const [matches, setMatches] = createSignal(list.matches)
  const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
  if (typeof list.addEventListener === "function") {
    list.addEventListener("change", onChange)
    onCleanup(() => list.removeEventListener("change", onChange))
  }
  return matches
}

export const Toolbar: Component<ToolbarProps> = (props) => {
  const set = <K extends keyof DashboardFilter>(k: K, v: DashboardFilter[K]) =>
    props.onChange({ ...props.filter, [k]: v })

  const isPhone = createMediaMatch(PHONE_QUERY)
  const [filtersOpen, setFiltersOpen] = createSignal(false)
  /** Everything but the search box is behind the disclosure at phone width. */
  const showFilters = () => !isPhone() || filtersOpen()

  // Search box holds a local draft so typing stays instant; the committed
  // filter (which re-runs the server search) is updated on a short debounce
  // rather than on every keystroke. Keep the draft in sync when the filter is
  // reset/changed externally.
  const [queryDraft, setQueryDraft] = createSignal(props.filter.query)
  createEffect(() => setQueryDraft(props.filter.query))
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => debounceTimer && clearTimeout(debounceTimer))
  const onQueryInput = (v: string) => {
    setQueryDraft(v)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (v !== props.filter.query) set("query", v)
    }, 250)
  }

  const statusOpts = () =>
    (props.statusOptions ?? DEFAULT_STATUS).map((s) => ({ value: s, label: tr(STATUS_LABEL[s]) }))

  return (
    <div
      data-testid="invoicing-dashboard-toolbar"
      class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border-subtle px-4 py-2.5"
    >
      {/* Free-text search — document number or customer name */}
      <input
        type="search"
        value={queryDraft()}
        onInput={(e) => onQueryInput(e.currentTarget.value)}
        data-testid="invoicing-dashboard-search"
        aria-label={tr("Search documents")}
        placeholder={searchPlaceholder(isPhone())}
        class={`${inputClass} w-full max-w-[15rem]`}
      />

      {/* The disclosure exists at phone width only, so the desktop toolbar's
          markup is exactly what it always was. */}
      <Show when={isPhone()}>
        <button
          type="button"
          data-testid="invoicing-dashboard-filters-toggle"
          aria-expanded={filtersOpen()}
          onClick={() => setFiltersOpen((v) => !v)}
          class="rounded-lg border border-border-subtle px-2.5 py-1 text-[12px] font-medium text-text-secondary"
        >
          {tr("Filters")}
        </button>
      </Show>

      <Show when={showFilters()}>
        <>
        {/* Date range: one unit. The pair never splits; it wraps to the next
            toolbar line as a whole, and on a 390 px phone the two fields shrink
            rather than overflow the right edge. The fields take an explicit
            width (dateRangeInputClass has no `w-full`): with the kit's
            `w-full` each field filled the row and the pair stacked. */}
        <div
          data-testid="invoicing-dashboard-date-range"
          class="flex min-w-0 max-w-full flex-nowrap items-center gap-1.5"
        >
          <input
            type="date"
            value={props.filter.date_from ?? ""}
            onInput={(e) => set("date_from", e.currentTarget.value || null)}
            data-testid="invoicing-dashboard-date-from"
            aria-label={tr("From date")}
            class={`${dateRangeInputClass} w-[8.5rem] min-w-0 shrink`}
          />
          <span class="text-text-tertiary">{tr("to")}</span>
          <input
            type="date"
            value={props.filter.date_to ?? ""}
            onInput={(e) => set("date_to", e.currentTarget.value || null)}
            data-testid="invoicing-dashboard-date-to"
            aria-label={tr("To date")}
            class={`${dateRangeInputClass} w-[8.5rem] min-w-0 shrink`}
          />
        </div>

        <Segmented
          options={SORT_OPTS.map((o) => ({ ...o, label: tr(o.label) }))}
          value={props.filter.sort}
          onChange={(v) => set("sort", v)}
          testidPrefix="invoicing-dashboard-sort"
          ariaLabel={tr("Sort by date")}
        />
        <Segmented
          options={statusOpts()}
          value={props.filter.status}
          onChange={(v) => set("status", v)}
          testidPrefix="invoicing-dashboard-status"
          ariaLabel={tr("Filter by status")}
        />
        <Segmented
          options={MARKET_OPTS.map((o) => ({ ...o, label: tr(o.label) }))}
          value={props.filter.market as MarketFilter}
          onChange={(v) => set("market", v)}
          testidPrefix="invoicing-dashboard-market"
          ariaLabel={tr("Filter by market")}
        />
        <Segmented
          options={CHANNEL_OPTS.map((o) => ({ ...o, label: tr(o.label) }))}
          value={props.filter.channel}
          onChange={(v) => set("channel", v)}
          testidPrefix="invoicing-dashboard-channel"
          ariaLabel={tr("Filter by channel")}
        />

        <div class="flex-1" />
        {props.trailing}
        <Show when={!!props.onExportCsv}>
          <Button variant="secondary" testid="invoicing-dashboard-export" onClick={props.onExportCsv}>
            {tr("Export CSV")}
          </Button>
        </Show>
        </>
      </Show>
    </div>
  )
}
