// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DASHBOARD TAB (`/dashboard/:id`). A toolbar at the top (title, the time
// range when a block follows one, who sees it, Refresh all), then the blocks on
// a grid by their width: one column on a phone, up to three on a wide panel.
// Each block reads its own data as the viewer, for the range shown, and fails
// alone.
//
// The range a dashboard opens on: the link's (`?range=&from=&to=&compare=`),
// else the one this person last picked here (kept by the server), else the
// dashboard's default. A pick is remembered for the person and written into the
// tab's URL, so a copied link carries it.
//
// Filters (when the dashboard declares some) sit in a row under the toolbar and
// follow the same rule, filter by filter: the link's (`?f.market=FR`), else the
// person's remembered values, else the dashboard's defaults.
//
// Picking a figure (a bar, a slice, a stage, a table row, a metric) opens the
// rows behind it in a panel on the right, beside the grid (over it on a phone).
import { RefreshCw } from "lucide-solid"
import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { tabStore, updateTabRoutePath } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import { BlockDrillPanel, openRecordLink } from "./BlockDrillPanel"
import { BlockCard } from "./blocks/BlockCard"
import {
  type BlockReadInfo,
  clearViewerRange,
  type Dashboard,
  type DashboardBlockSpec,
  type DrillTarget,
  type FilterValues,
  getBlockData,
  getBlockRows,
  getDashboard,
  getFilterOptions,
  saveViewerFilters,
  saveViewerRange,
} from "./dashboards-client"
import {
  DASHBOARD_TAB_TYPE,
  dashboardRevision,
  reloadDashboard,
  rememberDashboard,
} from "./dashboards-store"
import { FilterBar } from "./FilterBar"
import {
  defaultOf,
  effectiveFilters,
  filtersFromQuery,
  filtersKey,
  hasFiltersInQuery,
  sameFilters,
  withFiltersInPath,
  withoutFiltersInPath,
} from "./filters"
import { TimeRangePicker } from "./TimeRangePicker"
import {
  choiceFromQuery,
  choiceKey,
  compareWindowOf,
  type DayWindow,
  DEFAULT_CHOICE,
  formatWindow,
  initialChoice,
  isValidTimeRange,
  localToday,
  queryOf,
  type RangeChoice,
  resolveTimeRange,
  sameChoice,
  withChoiceInPath,
  withoutChoiceInPath,
} from "./time-range"

/** "Updated N min ago" moves on this often. */
const CLOCK_TICK_MS = 30_000

/** A dashboard's range as the server sent it, when it is one the web can use. */
function serverChoice(c: RangeChoice | undefined): RangeChoice | null {
  return c && isValidTimeRange(c.timeRange) && typeof c.compare === "string"
    ? { timeRange: c.timeRange, compare: c.compare }
    : null
}

/** The windows a block reported, keyed as the choice they answer. */
function windowsFromInfo(
  info: BlockReadInfo | undefined,
): { key: string; window: DayWindow; compareWindow: DayWindow | null } | null {
  const w = info?.window
  if (w?.mode !== "dashboard") return null
  const cw = info?.compareWindow ?? null
  const key = choiceKey({
    timeRange:
      w.preset === "custom" ? { preset: "custom", from: w.from, to: w.to } : { preset: w.preset },
    compare: cw ? cw.mode : "none",
  })
  return {
    key,
    window: { from: w.from, to: w.to },
    compareWindow: cw ? { from: cw.from, to: cw.to } : null,
  }
}

/** The grid span of a block's width, against the panel's own width (container queries). */
export function blockSpanClass(width: DashboardBlockSpec["width"]): string {
  if (width === 3) return "@2xl:col-span-2 @5xl:col-span-3"
  if (width === 2) return "@2xl:col-span-2"
  return ""
}

export const DashboardView: Component<{ entityId: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [tick, setTick] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const [pageVisible, setPageVisible] = createSignal(
    typeof document === "undefined" || document.visibilityState !== "hidden",
  )
  // The person's range as the server keeps it (their saved one, else the default), and the
  // one they picked in this tab.
  const [remembered, setRemembered] = createSignal<{ choice: RangeChoice; saved: boolean } | null>(
    null,
  )
  const [picked, setPicked] = createSignal<RangeChoice | null>(null)
  const [reported, setReported] = createSignal<ReturnType<typeof windowsFromInfo>>(null)
  // Filter values: the person's remembered ones as the server keeps them, and their picks here.
  const [rememberedFilters, setRememberedFilters] = createSignal<{
    values: FilterValues
    saved: boolean
  } | null>(null)
  const [pickedFilters, setPickedFilters] = createSignal<FilterValues | null>(null)
  const [drill, setDrill] = createSignal<{ block: DashboardBlockSpec; target: DrillTarget } | null>(
    null,
  )
  onMount(() => {
    const timer = setInterval(() => {
      if (pageVisible()) setNow(Date.now())
    }, CLOCK_TICK_MS)
    const onVisibility = () => {
      setPageVisible(document.visibilityState !== "hidden")
      setNow(Date.now())
    }
    document.addEventListener("visibilitychange", onVisibility)
    onCleanup(() => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    })
  })
  // Closing the tab cancels its block reads, queued or running, here and on the server.
  const reads = new AbortController()
  onCleanup(() => reads.abort())
  let shown: Dashboard | null = null

  // Keyed on the read revision too: an agent's open after a change, or Refresh all, reads the
  // spec again, and blocks added, removed or remapped show at once.
  const [dashboard] = createResource(
    () => [props.entityId, dashboardRevision(props.entityId)] as const,
    async ([id]) => {
      try {
        const d = await getDashboard(api, id)
        rememberDashboard(d)
        const saved = serverChoice(d.range)
        setRemembered({
          choice: saved ?? serverChoice(d.defaultRange) ?? DEFAULT_CHOICE,
          saved: d.range?.saved === true,
        })
        if (d.filters) {
          setRememberedFilters({ values: d.filters.values ?? {}, saved: d.filters.saved === true })
        }
        // The same version keeps the same object, so its blocks stay mounted (Refresh all then
        // refreshes them in place); a new version remounts them on the new spec.
        if (shown?.id !== d.id || shown.version !== d.version) shown = d
        return { ok: true as const, dashboard: shown }
      } catch (err) {
        const missing = err instanceof ApiError && (err.status === 404 || err.status === 403)
        return { ok: false as const, missing }
      }
    },
  )
  const loaded = () => {
    const r = dashboard()
    return r?.ok ? r.dashboard : null
  }

  // This dashboard's tab: its URL carries the range.
  const tab = () =>
    tabStore.tabs.find((t) => t.type === DASHBOARD_TAB_TYPE && t.entityId === props.entityId)
  const usesRange = () => loaded()?.usesTimeRange === true
  /** The range shown: the URL's, else the person's pick here, else the remembered one. */
  const choice = createMemo(
    () =>
      initialChoice(
        choiceFromQuery(queryOf(tab()?.routePath)),
        picked() ?? remembered()?.choice ?? null,
      ),
    undefined,
    { equals: sameChoice },
  )
  // A memo: the same key twice (the pick, then the URL it wrote) re-reads nothing.
  const rangeKey = createMemo(() => (usesRange() ? choiceKey(choice()) : undefined))

  /** The days shown: the server's (a block's read, or the dashboard's), else worked out here. */
  const windows = createMemo(() => {
    const c = choice()
    const key = choiceKey(c)
    const fromBlock = reported()
    if (fromBlock?.key === key) return fromBlock
    const d = loaded()
    const server = serverChoice(d?.range)
    if (d?.range && server && sameChoice(server, c)) {
      return { key, window: d.range.window, compareWindow: d.range.compareWindow }
    }
    const window = resolveTimeRange(c.timeRange, localToday(new Date(now())))
    return { key, window, compareWindow: compareWindowOf(c.timeRange.preset, window, c.compare) }
  })
  const rangeLabel = () => {
    const w = windows()
    const locale = i18n.locale()
    const range = formatWindow(w.window, locale)
    return w.compareWindow
      ? i18n.t("kernel.dashboards.rangeVs", {
          range,
          compare: formatWindow(w.compareWindow, locale),
        })
      : range
  }

  const pick = (next: RangeChoice) => {
    setPicked(next)
    setRemembered((r) => (r ? { ...r, saved: true } : { choice: next, saved: true }))
    const t = tab()
    if (t)
      updateTabRoutePath(
        t.id,
        withChoiceInPath(t.routePath ?? `/dashboard/${props.entityId}`, next),
      )
    // Remembered for this person; a failed save only means it is not remembered next time.
    void saveViewerRange(api, props.entityId, next).catch(() => {})
  }
  const resetRange = () => {
    const fallback = serverChoice(loaded()?.defaultRange) ?? DEFAULT_CHOICE
    setPicked(null)
    setRemembered({ choice: fallback, saved: false })
    const t = tab()
    if (t?.routePath) updateTabRoutePath(t.id, withoutChoiceInPath(t.routePath))
    // Forgetting the range forgets the filters too on the server: the ones the person keeps
    // are remembered again right after.
    const keep = rememberedFilters()?.saved ? filterValues() : null
    void clearViewerRange(api, props.entityId)
      .then(() => (keep ? saveViewerFilters(api, props.entityId, keep) : undefined))
      .catch(() => {})
  }
  // ── filters ────────────────────────────────────────────────────────────────
  const filterDefs = () => loaded()?.spec.filters ?? []
  const defaultFilters = (): FilterValues => {
    const d = loaded()
    const out: FilterValues = {}
    for (const def of filterDefs()) out[def.id] = d?.defaultFilters?.[def.id] ?? defaultOf(def)
    return out
  }
  /** The values shown: the link's, else the pick here, else the remembered ones, else defaults. */
  const filterValues = createMemo(
    () =>
      effectiveFilters(filterDefs(), {
        url: filtersFromQuery(queryOf(tab()?.routePath), filterDefs()),
        picked: pickedFilters(),
        remembered: rememberedFilters()?.values ?? null,
        defaults: defaultFilters(),
      }),
    undefined,
    { equals: sameFilters },
  )
  const filterKey = createMemo(() => (filterDefs().length ? filtersKey(filterValues()) : undefined))
  const wireFilters = () => (filterDefs().length ? filterValues() : undefined)

  const pickFilter = (id: string, values: string[]) => {
    const next = { ...filterValues(), [id]: values }
    if (sameFilters(next, filterValues())) return
    setPickedFilters(next)
    setRememberedFilters({ values: next, saved: true })
    const t = tab()
    if (t)
      updateTabRoutePath(
        t.id,
        withFiltersInPath(t.routePath ?? `/dashboard/${props.entityId}`, next),
      )
    void saveViewerFilters(api, props.entityId, next).catch(() => {})
  }
  const resetFilters = () => {
    const defaults = defaultFilters()
    setPickedFilters(null)
    setRememberedFilters({ values: defaults, saved: false })
    const t = tab()
    if (t?.routePath) updateTabRoutePath(t.id, withoutFiltersInPath(t.routePath))
    // `{}` forgets the person's filters; their range stays remembered.
    void saveViewerFilters(api, props.entityId, {}).catch(() => {})
  }
  const filtersChanged = () =>
    rememberedFilters()?.saved === true ||
    hasFiltersInQuery(queryOf(tab()?.routePath)) ||
    !sameFilters(filterValues(), defaultFilters())

  /** Does this block follow the dashboard's range (the server says; a fixed one keeps its own)? */
  const follows = (d: Dashboard, blockId: string) => d.blockTimeRange?.[blockId] !== "fixed"
  /** Blocks re-read on their own cadence only while this tab is the one on screen. */
  const onScreen = () => pageVisible() && (!tab() || tabStore.activeTabId === tab()?.id)

  return (
    <section data-testid="dashboard-view" class="flex h-full min-h-0 min-w-0 flex-col">
      <header
        data-testid="dashboard-toolbar"
        class="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2.5"
      >
        <h1
          data-testid="dashboard-title"
          class="min-w-0 flex-1 basis-40 truncate text-[14px] font-semibold text-text"
        >
          {loaded()?.title ?? ""}
        </h1>
        <Switch>
          <Match when={loaded()}>
            {(d) => (
              <>
                <Show when={usesRange()}>
                  <div data-testid="dashboard-range" class="min-w-0 max-w-full">
                    <TimeRangePicker
                      choice={choice()}
                      label={rangeLabel()}
                      window={windows().window}
                      saved={
                        remembered()?.saved === true ||
                        Object.keys(choiceFromQuery(queryOf(tab()?.routePath))).length > 0
                      }
                      onChange={(next) => {
                        if (!sameChoice(next, choice())) pick(next)
                      }}
                      onReset={resetRange}
                    />
                  </div>
                </Show>
                <span
                  data-testid="dashboard-visibility"
                  data-visibility={d().visibility}
                  class="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-text-tertiary"
                >
                  {d().visibility === "org"
                    ? i18n.t("kernel.dashboards.visibilityOrg")
                    : i18n.t("kernel.dashboards.visibilityPersonal")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="dashboard-refresh-all"
                  disabled={d().spec.blocks.length === 0}
                  onClick={() => {
                    reloadDashboard(d().id)
                    setTick((t) => t + 1)
                  }}
                >
                  <RefreshCw size={13} />
                  {i18n.t("kernel.dashboards.refreshAll")}
                </Button>
              </>
            )}
          </Match>
        </Switch>
      </header>
      <Show when={loaded() && filterDefs().length > 0}>
        <FilterBar
          filters={filterDefs()}
          values={filterValues()}
          onChange={pickFilter}
          canReset={filtersChanged()}
          onReset={resetFilters}
          loadOptions={(filterId) => {
            const { [filterId]: _own, ...others } = filterValues()
            return getFilterOptions(api, props.entityId, filterId, {
              ...(usesRange() ? { range: choice() } : {}),
              filters: others,
              signal: reads.signal,
            })
          }}
        />
      </Show>
      <div class="@container relative flex min-h-0 flex-1">
        <div class="min-h-0 min-w-0 flex-1 overflow-y-auto p-4">
          <Switch>
            <Match when={dashboard.loading && !dashboard()}>
              <div data-testid="dashboard-loading" class="space-y-3">
                <Skeleton class="h-24 w-full" />
                <Skeleton class="h-24 w-full" />
              </div>
            </Match>
            <Match when={dashboard() && !dashboard()?.ok}>
              <p
                data-testid="dashboard-not-found"
                class="py-8 text-center text-[13px] text-text-tertiary"
              >
                {(dashboard() as { missing?: boolean })?.missing
                  ? i18n.t("kernel.dashboards.notFound")
                  : i18n.t("kernel.dashboards.loadFailed")}
              </p>
            </Match>
            <Match when={loaded() && loaded()?.spec.blocks.length === 0}>
              <div data-testid="dashboard-empty" class="py-10 text-center">
                <p class="text-[13px] text-text-secondary">
                  {i18n.t("kernel.dashboards.emptyTitle")}
                </p>
                <p class="mt-1 text-[12.5px] text-text-tertiary">
                  {i18n.t("kernel.dashboards.emptyHint")}
                </p>
              </div>
            </Match>
            <Match when={loaded()}>
              {(d) => (
                <div
                  data-testid="dashboard-grid"
                  class="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3"
                >
                  <For each={d().spec.blocks}>
                    {(block) => (
                      <BlockCard
                        block={block}
                        class={cn(blockSpanClass(block.width))}
                        refreshTick={tick()}
                        rangeKey={follows(d(), block.id) ? rangeKey() : undefined}
                        filtersKey={filterKey()}
                        onDrill={(target) => setDrill({ block, target })}
                        showOwnWindow={usesRange() && !follows(d(), block.id)}
                        now={now()}
                        visible={onScreen()}
                        onRead={(info) => {
                          const w = windowsFromInfo(info)
                          if (w) setReported(w)
                        }}
                        load={(refresh) =>
                          getBlockData(api, d().id, block.id, {
                            refresh,
                            signal: reads.signal,
                            ...(usesRange() && follows(d(), block.id) ? { range: choice() } : {}),
                            ...(wireFilters() ? { filters: wireFilters() } : {}),
                          })
                        }
                      />
                    )}
                  </For>
                </div>
              )}
            </Match>
          </Switch>
        </div>
        <Show when={drill()}>
          {(open) => (
            <BlockDrillPanel
              blockId={open().block.id}
              blockTitle={open().block.title}
              target={open().target}
              load={(offset) => {
                const d = loaded()
                const b = open().block
                return getBlockRows(api, props.entityId, b.id, {
                  target: open().target,
                  offset,
                  ...(usesRange() && d && follows(d, b.id) ? { range: choice() } : {}),
                  ...(wireFilters() ? { filters: wireFilters() } : {}),
                  signal: reads.signal,
                })
              }}
              open={(link) => openRecordLink(api, link)}
              onClose={() => setDrill(null)}
            />
          )}
        </Show>
      </div>
    </section>
  )
}

export default DashboardView
