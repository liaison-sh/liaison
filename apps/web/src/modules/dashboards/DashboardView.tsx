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
//
// Someone who may change the dashboard (the record's `canEdit`) gets an Edit toggle: in edit mode
// the title and description are fields, and each block can be renamed, moved (drag, or the arrow
// buttons), resized, duplicated or deleted. Each change is saved at once as one operation
// (`POST /:id/edit` with the version shown); Undo walks the changes back one at a time (a revert
// to the version before). A save that meets a newer version reloads the dashboard and says so.
// The toolbar also exports (PDF, and each block's CSV from its menu), opens the version history
// in a right-side panel (Restore), makes a personal copy, and says how to get the dashboard
// sent regularly (a routine the agent sets up).
import {
  CalendarClock,
  Copy,
  Download,
  History,
  Lock,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Undo2,
  Users,
  X,
} from "lucide-solid"
import {
  type Component,
  createEffect,
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
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { PopupMenu } from "~/ui/PopupMenu"
import { Skeleton } from "~/ui/Skeleton"
import { BlockDrillPanel, openRecordLink } from "./BlockDrillPanel"
import { BlockCard } from "./blocks/BlockCard"
import { ColourScopeProvider, createColourScope } from "./blocks/data-colour"
import { EditableTableBlock } from "./blocks/EditableTableBlock"
import { DashboardShareDialog } from "./DashboardShareDialog"
import {
  type BlockReadInfo,
  blockCsvPath,
  clearViewerRange,
  type Dashboard,
  type DashboardBlockSpec,
  type DrillTarget,
  dashboardPdfPath,
  downloadExport,
  duplicateDashboard,
  type EditOperation,
  editableTableOf,
  editDashboard,
  type FilterValues,
  getBlockData,
  getBlockRows,
  getDashboard,
  getFilterOptions,
  getVersion,
  isVersionConflict,
  listVersions,
  saveViewerFilters,
  saveViewerRange,
} from "./dashboards-client"
import {
  DASHBOARD_TAB_TYPE,
  dashboardRevision,
  loadDashboards,
  openDashboard,
  reloadDashboard,
  rememberDashboard,
} from "./dashboards-store"
import { dropTarget, gridColumns, type MoveDirection, moveTarget, UNDO_DEPTH } from "./edit-mode"
import { FilterBar } from "./FilterBar"
import { FilterEditor } from "./FilterEditor"
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
import { VersionHistoryPanel } from "./VersionHistoryPanel"

/** "Updated N min ago" moves on this often. */
const CLOCK_TICK_MS = 30_000
/** The longest a change waits for the dashboard reloaded after a conflict. */
const RELOAD_WAIT_MS = 5_000

/** The day `at` falls on in `timeZone` (YYYY-MM-DD), or null for a zone Intl does not know. */
function dayIn(at: number, timeZone: string | undefined): string | null {
  if (!timeZone) return null
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(at)
  } catch {
    return null
  }
}

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

/** What the grid keys a block by: a change to what it reads remounts it, a move or a rename does not. */
export function blockReadKey(b: DashboardBlockSpec): string {
  return `${b.id}\u0000${JSON.stringify([b.type, b.source, b.dataset, b.map, b.text, b.refreshSec, b.timeRange])}`
}

/** A file name from a title: letters, digits and dashes only. */
export function fileSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
  return slug || "dashboard"
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
  /** What had focus when the rows opened (a bar's pick, a table row): focus goes back on close. */
  let drillOpener: HTMLElement | null = null
  const openDrill = (block: DashboardBlockSpec, target: DrillTarget) => {
    if (!drill()) {
      const active = document.activeElement
      drillOpener = active instanceof HTMLElement && active !== document.body ? active : null
    }
    setHistoryOpen(false)
    setDrill({ block, target })
  }
  const closeDrill = () => {
    setDrill(null)
    const back = drillOpener
    drillOpener = null
    if (back?.isConnected) back.focus()
  }
  // Escape closes the rows from anywhere on the page while they are open (focus may be on the
  // grid after a pick), unless a menu or a dialog takes it first.
  createEffect(() => {
    if (!drill()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      const t = e.target
      if (t instanceof Element && t.closest('[role="menu"],[role="dialog"],[role="listbox"]'))
        return
      closeDrill()
    }
    document.addEventListener("keydown", onKey)
    onCleanup(() => document.removeEventListener("keydown", onKey))
  })
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
  /** The org's day when the dashboard was read: its `today` goes stale once the day turns. */
  let loadedDay: string | null = null

  // Keyed on the read revision too: an agent's open after a change, or Refresh all, reads the
  // spec again, and blocks added, removed or remapped show at once.
  const [dashboard, { mutate }] = createResource(
    () => [props.entityId, dashboardRevision(props.entityId)] as const,
    async ([id]) => {
      try {
        const d = await getDashboard(api, id)
        loadedDay = dayIn(Date.now(), d.timeZone)
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

  /** A dashboard the server answered (an edit, a restore): shown at once, before its event. */
  const show = (d: Dashboard) => {
    rememberDashboard(d)
    if (shown?.id !== d.id || shown.version !== d.version) shown = d
    mutate({ ok: true as const, dashboard: shown })
  }

  // ── edit mode ──────────────────────────────────────────────────────────────
  const [editing, setEditing] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  /**
   * Each change made here, newest last: the version before it (Undo reverts to it) and the
   * version it produced (Undo applies only while that one is still the version shown).
   */
  const [undoStack, setUndoStack] = createSignal<{ before: number; produced: number }[]>([])
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [shareOpen, setShareOpen] = createSignal(false)
  const [scheduleHint, setScheduleHint] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [exportOpen, setExportOpen] = createSignal(false)
  let dragged: string | null = null
  let grid: HTMLDivElement | undefined
  const canEdit = () => loaded()?.canEdit === true
  // Someone who can no longer edit (the dashboard moved, a scope went) leaves edit mode.
  createEffect(() => {
    if (editing() && loaded() && !canEdit()) setEditing(false)
  })

  /** Changes waiting for the one being saved: each is sent on the version the last produced. */
  let queue: Promise<boolean> = Promise.resolve(true)
  let pendingEdits = 0
  /** Bumped by a conflict: the changes queued before it are dropped. */
  let editGeneration = 0
  /** Set while a conflict waits for the reloaded dashboard: told each version that loads. */
  let onVersion: ((v: number | undefined) => void) | null = null
  createEffect(() => {
    const v = loaded()?.version
    onVersion?.(v)
  })
  /** Reloads the dashboard and waits (at most a few seconds) until a version other than `from` shows. */
  const reloadPast = (id: string, from: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        onVersion = null
        resolve()
      }
      const timer = setTimeout(done, RELOAD_WAIT_MS)
      onVersion = (v) => {
        if (v !== from) done()
      }
      reloadDashboard(id)
    })

  /** Undo would erase someone else's later change: nothing is sent, the history is offered. */
  const undoOverridden = () => {
    setUndoStack([])
    addToast({ type: "info", message: i18n.t("kernel.dashboards.undoOverridden") })
    setDrill(null)
    setHistoryOpen(true)
  }

  /**
   * Saves `operations` on the version shown, after any change still being saved. A newer
   * version saved meanwhile: the dashboard reloads and the person is told to make the change
   * again (Undo starts over, and the changes queued behind it are dropped).
   */
  function applyEdit(operations: EditOperation[], opts: { undo?: boolean } = {}) {
    pendingEdits++
    setSaving(true)
    const generation = editGeneration
    const run = async (): Promise<boolean> => {
      const d = loaded()
      if (!d || generation !== editGeneration) return false
      if (opts.undo && undoStack().at(-1)?.produced !== d.version) {
        undoOverridden()
        return false
      }
      try {
        const next = await editDashboard(api, d.id, d.version, operations)
        if (opts.undo) {
          // The revert is a new version with the same content: the change below it now
          // stands on that one.
          setUndoStack((s) => {
            const rest = s.slice(0, -1)
            const top = rest.at(-1)
            return top ? [...rest.slice(0, -1), { ...top, produced: next.version }] : rest
          })
        } else {
          setUndoStack((s) =>
            [...s, { before: d.version, produced: next.version }].slice(-UNDO_DEPTH),
          )
        }
        show(next)
        void loadDashboards(api)
        return true
      } catch (err) {
        if (isVersionConflict(err)) {
          editGeneration++
          setUndoStack([])
          addToast({ type: "info", message: i18n.t("kernel.dashboards.editConflict") })
          // Changes made from now on wait for the new version, so they are not sent stale.
          await reloadPast(d.id, d.version)
        } else {
          addToast({
            type: "error",
            message:
              err instanceof ApiError && err.message
                ? i18n.t("kernel.dashboards.editFailedWhy", { reason: err.message })
                : i18n.t("kernel.dashboards.editFailed"),
          })
        }
        return false
      }
    }
    queue = queue.then(run).finally(() => {
      pendingEdits--
      if (pendingEdits === 0) setSaving(false)
    })
    return queue
  }
  const undo = () => {
    const top = undoStack().at(-1)
    if (!top) return
    if (top.produced !== loaded()?.version) undoOverridden()
    else void applyEdit([{ op: "revert", toVersion: top.before }], { undo: true })
  }
  const restore = async (version: number) => {
    if (await applyEdit([{ op: "revert", toVersion: version }])) {
      addToast({
        type: "success",
        message: i18n.t("kernel.dashboards.historyRestored", { version }),
      })
    }
  }
  const moveBlock = (blockId: string, direction: MoveDirection) => {
    const d = loaded()
    if (!d) return
    const to = moveTarget(d.spec.blocks, blockId, direction, gridColumns(grid))
    if (to !== null) void applyEdit([{ op: "moveBlock", blockId, position: to }])
  }
  const dropOn = (targetId: string) => {
    const d = loaded()
    const from = dragged
    dragged = null
    if (!d || !from) return
    const to = dropTarget(d.spec.blocks, from, targetId)
    if (to !== null) void applyEdit([{ op: "moveBlock", blockId: from, position: to }])
  }
  const commitTitle = (el: HTMLInputElement) => {
    const d = loaded()
    const v = el.value.trim()
    if (!d) return
    if (!v) {
      el.value = d.title
      return
    }
    if (v !== d.title) void applyEdit([{ op: "setTitle", title: v }])
  }
  const commitDescription = (el: HTMLTextAreaElement) => {
    const d = loaded()
    if (!d) return
    const v = el.value.trim()
    if (v === (d.spec.description ?? "")) return
    void applyEdit([{ op: "setDescription", description: v === "" ? null : v }])
  }
  const duplicate = async () => {
    const d = loaded()
    if (!d) return
    try {
      const copy = await duplicateDashboard(api, d.id)
      rememberDashboard(copy)
      void loadDashboards(api)
      openDashboard(copy)
    } catch (err) {
      addToast({
        type: "error",
        message:
          err instanceof ApiError && err.message
            ? i18n.t("kernel.dashboards.duplicateFailedWhy", { reason: err.message })
            : i18n.t("kernel.dashboards.duplicateFailed"),
      })
    }
  }

  // ── exports ────────────────────────────────────────────────────────────────
  /** The range and filters the view shows: an export carries them. */
  const exportContext = () => ({
    ...(usesRange() ? { range: choice() } : {}),
    ...(wireFilters() ? { filters: wireFilters() } : {}),
  })
  const download = async (path: string, name: string) => {
    try {
      await downloadExport(api, path, name)
    } catch (err) {
      addToast({
        type: "error",
        message:
          err instanceof ApiError && err.message
            ? i18n.t("kernel.dashboards.exportFailedWhy", { reason: err.message })
            : i18n.t("kernel.dashboards.exportFailed"),
      })
    }
  }
  const exportPdf = () => {
    const d = loaded()
    if (d) void download(dashboardPdfPath(d.id, exportContext()), `${fileSlug(d.title)}.pdf`)
  }
  const exportBlock = (block: DashboardBlockSpec, kind: "data" | "rows") => {
    const d = loaded()
    if (!d) return
    // A block keeping its own window ignores the dashboard's range.
    const ctx = follows(d, block.id) ? exportContext() : { filters: wireFilters() }
    void download(
      blockCsvPath(d.id, block.id, kind, ctx),
      `${fileSlug(block.title)}${kind === "rows" ? "-rows" : ""}.csv`,
    )
  }

  /** The blocks by id, as the spec holds them now. */
  const blocksById = createMemo(() => {
    const out = new Map<string, DashboardBlockSpec>()
    for (const b of loaded()?.spec.blocks ?? []) out.set(b.id, b)
    return out
  })
  /** The grid's keys: a block stays mounted while what it reads stays the same. */
  const blockKeys = createMemo(() => (loaded()?.spec.blocks ?? []).map(blockReadKey), undefined, {
    equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]),
  })

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
    // Today as the org's calendar has it (the server's), never the browser's date.
    const window = resolveTimeRange(c.timeRange, d?.today ?? localToday(new Date(now())))
    return { key, window, compareWindow: compareWindowOf(c.timeRange.preset, window, c.compare) }
  })
  // A tab left open past the org's midnight reads the dashboard again, once, for the new today.
  createEffect(() => {
    const d = loaded()
    const day = d ? dayIn(now(), d.timeZone) : null
    if (!d || !day || !loadedDay || day === loadedDay) return
    loadedDay = day
    reloadDashboard(d.id)
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
    <section
      data-testid="dashboard-view"
      data-version={loaded()?.version}
      class="flex h-full min-h-0 min-w-0 flex-col"
    >
      <header
        data-testid="dashboard-toolbar"
        data-editing={editing() ? "true" : undefined}
        class="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2.5"
      >
        <Show
          when={editing() && loaded()}
          fallback={
            <h1
              data-testid="dashboard-title"
              class="min-w-0 flex-1 basis-40 truncate text-[14px] font-semibold text-text"
            >
              {loaded()?.title ?? ""}
            </h1>
          }
        >
          {(d) => (
            <input
              data-testid="dashboard-title-input"
              aria-label={i18n.t("kernel.dashboards.titleLabel")}
              value={d().title}
              maxLength={200}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  commitTitle(e.currentTarget)
                } else if (e.key === "Escape") {
                  e.currentTarget.value = d().title
                  e.currentTarget.blur()
                }
              }}
              onBlur={(e) => commitTitle(e.currentTarget)}
              class="h-8 min-w-0 flex-1 basis-40 rounded-md border border-border-subtle bg-bg px-2 text-[14px] font-semibold text-text outline-none focus:border-accent"
            />
          )}
        </Show>
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
                  data-restricted={d().visibility !== "org" && d().shared === true ? "" : undefined}
                  class="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-text-tertiary"
                >
                  {d().visibility === "org"
                    ? i18n.t("kernel.dashboards.visibilityOrg")
                    : d().shared
                      ? i18n.t("kernel.dashboards.visibilityRestricted")
                      : i18n.t("kernel.dashboards.visibilityPersonal")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="dashboard-share"
                  onClick={() => {
                    setShareOpen(true)
                  }}
                >
                  {d().visibility !== "org" && d().shared ? (
                    <Lock size={13} />
                  ) : (
                    <Users size={13} />
                  )}
                  {i18n.t("kernel.dashboards.share")}
                </Button>
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
                <PopupMenu open={exportOpen()} onOpenChange={setExportOpen}>
                  <PopupMenu.Trigger
                    data-testid="dashboard-export"
                    aria-label={i18n.t("kernel.dashboards.exportMenu")}
                    title={i18n.t("kernel.dashboards.exportMenu")}
                    class="flex h-7 items-center gap-1.5 rounded-sm border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                  >
                    <Download size={13} />
                    {i18n.t("kernel.dashboards.exportMenu")}
                  </PopupMenu.Trigger>
                  <PopupMenu.Content data-testid="dashboard-export-menu">
                    <PopupMenu.Item data-testid="dashboard-export-pdf" onSelect={exportPdf}>
                      {i18n.t("kernel.dashboards.exportPdf")}
                    </PopupMenu.Item>
                  </PopupMenu.Content>
                </PopupMenu>
                <Show when={canEdit()}>
                  <Button
                    variant={editing() ? "primary" : "outline"}
                    size="sm"
                    data-testid="dashboard-edit-toggle"
                    aria-pressed={editing()}
                    onClick={() => {
                      setEditing((e) => !e)
                      if (editing()) closeDrill()
                    }}
                  >
                    <Pencil size={13} />
                    {editing()
                      ? i18n.t("kernel.dashboards.editDone")
                      : i18n.t("kernel.dashboards.editStart")}
                  </Button>
                </Show>
                <Show when={editing()}>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="dashboard-undo"
                    disabled={saving() || undoStack().length === 0}
                    onClick={undo}
                  >
                    <Undo2 size={13} />
                    {i18n.t("kernel.dashboards.undo")}
                  </Button>
                </Show>
                <PopupMenu open={menuOpen()} onOpenChange={setMenuOpen}>
                  <PopupMenu.Trigger
                    data-testid="dashboard-menu"
                    aria-label={i18n.t("kernel.dashboards.moreMenu")}
                    title={i18n.t("kernel.dashboards.moreMenu")}
                    class="flex h-7 w-7 items-center justify-center rounded-sm border border-border text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                  >
                    <MoreHorizontal size={14} />
                  </PopupMenu.Trigger>
                  <PopupMenu.Content data-testid="dashboard-menu-content">
                    <PopupMenu.Item
                      data-testid="dashboard-history"
                      onSelect={() => {
                        setDrill(null)
                        setHistoryOpen(true)
                      }}
                    >
                      <History size={13} aria-hidden="true" />
                      {i18n.t("kernel.dashboards.historyMenu")}
                    </PopupMenu.Item>
                    <PopupMenu.Item data-testid="dashboard-duplicate" onSelect={duplicate}>
                      <Copy size={13} aria-hidden="true" />
                      {i18n.t("kernel.dashboards.duplicateDashboard")}
                    </PopupMenu.Item>
                    <PopupMenu.Item
                      data-testid="dashboard-send-regularly"
                      onSelect={() => setScheduleHint(true)}
                    >
                      <CalendarClock size={13} aria-hidden="true" />
                      {i18n.t("kernel.dashboards.sendRegularly")}
                    </PopupMenu.Item>
                  </PopupMenu.Content>
                </PopupMenu>
              </>
            )}
          </Match>
        </Switch>
      </header>
      <Show when={loaded()}>
        {(d) => (
          <Show
            when={editing()}
            fallback={
              <Show when={d().spec.description}>
                <p
                  data-testid="dashboard-description"
                  class="whitespace-pre-line border-b border-border-subtle px-4 py-2 text-[12.5px] text-text-secondary"
                >
                  {d().spec.description}
                </p>
              </Show>
            }
          >
            <div class="border-b border-border-subtle px-4 py-2">
              <textarea
                data-testid="dashboard-description-input"
                aria-label={i18n.t("kernel.dashboards.descriptionLabel")}
                placeholder={i18n.t("kernel.dashboards.descriptionPlaceholder")}
                value={d().spec.description ?? ""}
                maxLength={500}
                rows={2}
                onBlur={(e) => commitDescription(e.currentTarget)}
                class="w-full resize-y rounded-md border border-border-subtle bg-bg px-2 py-1.5 text-[12.5px] text-text outline-none placeholder:text-text-tertiary focus:border-accent"
              />
              <p class="mt-1 text-[11.5px] text-text-tertiary">
                {i18n.t("kernel.dashboards.editHint")}
              </p>
            </div>
          </Show>
        )}
      </Show>
      <Show when={editing() && loaded()}>
        {(d) => (
          <FilterEditor
            spec={d().spec}
            busy={saving()}
            apply={(operations) => applyEdit(operations)}
            loadFields={async (target) => {
              const out = await getBlockRows(api, d().id, target.blockId, {
                ...(target.layerId ? { target: { layer: target.layerId } } : {}),
                limit: 1,
                ...(usesRange() ? { range: choice() } : {}),
                filters: filterValues(),
              })
              return out.ok ? out.page.fields : null
            }}
          />
        )}
      </Show>
      <Show when={scheduleHint() && loaded()}>
        {(d) => (
          <div
            data-testid="dashboard-schedule-hint"
            role="status"
            class="flex items-start gap-2 border-b border-border-subtle bg-surface px-4 py-2 text-[12.5px] text-text-secondary"
          >
            <CalendarClock
              size={14}
              aria-hidden="true"
              class="mt-0.5 shrink-0 text-text-tertiary"
            />
            <p class="min-w-0 flex-1">
              {i18n.t("kernel.dashboards.sendRegularlyHint")}{" "}
              <span data-testid="dashboard-schedule-example" class="text-text">
                {i18n.t("kernel.dashboards.sendRegularlyExample", { title: d().title })}
              </span>
            </p>
            <button
              type="button"
              data-testid="dashboard-schedule-hint-close"
              aria-label={i18n.t("kernel.dashboards.drillClose")}
              title={i18n.t("kernel.dashboards.drillClose")}
              onClick={() => setScheduleHint(false)}
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
            >
              <X size={13} />
            </button>
          </div>
        )}
      </Show>
      <Show when={loaded() && filterDefs().length > 0}>
        <FilterBar
          filters={filterDefs()}
          values={filterValues()}
          onChange={pickFilter}
          canReset={filtersChanged()}
          onReset={resetFilters}
          loadOptions={(filterId, q) => {
            const { [filterId]: _own, ...others } = filterValues()
            return getFilterOptions(api, props.entityId, filterId, {
              ...(usesRange() ? { range: choice() } : {}),
              filters: others,
              signal: reads.signal,
              ...(q ? { q } : {}),
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
                // One colour scope for the whole dashboard: a status reads in one colour in
                // every block.
                <ColourScopeProvider value={createColourScope()}>
                  <div
                    ref={grid}
                    data-testid="dashboard-grid"
                    class="grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3"
                  >
                    <For each={blockKeys()}>
                      {(key) => {
                        const id = key.slice(0, key.indexOf("\u0000"))
                        const block = () => blocksById().get(id)!
                        return (
                          <Show when={blocksById().get(id)}>
                            <BlockCard
                              block={block()}
                              class={cn(blockSpanClass(block().width))}
                              today={d().today}
                              timeZone={d().timeZone}
                              onExport={(kind) => exportBlock(block(), kind)}
                              edit={
                                editing()
                                  ? {
                                      busy: saving(),
                                      rename: (title) =>
                                        void applyEdit([
                                          { op: "updateBlock", blockId: id, changes: { title } },
                                        ]),
                                      canMove: (dir) =>
                                        moveTarget(d().spec.blocks, id, dir, gridColumns(grid)) !==
                                        null,
                                      move: (dir) => moveBlock(id, dir),
                                      resize: (size) =>
                                        void applyEdit([
                                          { op: "resizeBlock", blockId: id, ...size },
                                        ]),
                                      duplicate: () =>
                                        void applyEdit([{ op: "duplicateBlock", blockId: id }]),
                                      remove: () =>
                                        void applyEdit([{ op: "removeBlock", blockId: id }]),
                                      onDragStart: () => {
                                        dragged = id
                                      },
                                      onDragEnd: () => {
                                        dragged = null
                                      },
                                      onDrop: () => dropOn(id),
                                    }
                                  : undefined
                              }
                              refreshTick={tick()}
                              rangeKey={follows(d(), id) ? rangeKey() : undefined}
                              filtersKey={filterKey()}
                              onDrill={(target) => openDrill(block(), target)}
                              showOwnWindow={usesRange() && !follows(d(), id)}
                              now={now()}
                              visible={onScreen()}
                              onRead={(info) => {
                                const w = windowsFromInfo(info)
                                if (w) setReported(w)
                              }}
                              content={(() => {
                                const editable = editableTableOf(block())
                                if (!editable) return undefined
                                return (refreshes: () => number) => (
                                  <EditableTableBlock
                                    tableId={editable.tableId}
                                    columns={editable.columns}
                                    staleAfterDays={editable.staleAfterDays}
                                    reloadKey={refreshes()}
                                    now={now()}
                                    testid={`table-block-${id}`}
                                  />
                                )
                              })()}
                              load={(refresh) =>
                                getBlockData(api, d().id, id, {
                                  refresh,
                                  signal: reads.signal,
                                  ...(usesRange() && follows(d(), id) ? { range: choice() } : {}),
                                  ...(wireFilters() ? { filters: wireFilters() } : {}),
                                })
                              }
                            />
                          </Show>
                        )
                      }}
                    </For>
                  </div>
                </ColourScopeProvider>
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
              contextKey={`${rangeKey() ?? ""}|${filterKey() ?? ""}`}
              windowNote={
                open().target.previous && windows().compareWindow
                  ? formatWindow(windows().compareWindow!, i18n.locale())
                  : undefined
              }
              load={(offset) => {
                const d = loaded()
                const b = open().block
                const t = open().target
                const cw = windows().compareWindow
                // A comparison bar's rows: the comparison window, as a custom range.
                const range =
                  t.previous && cw
                    ? {
                        timeRange: { preset: "custom" as const, from: cw.from, to: cw.to },
                        compare: "none" as const,
                      }
                    : choice()
                return getBlockRows(api, props.entityId, b.id, {
                  target: t,
                  offset,
                  ...(usesRange() && d && follows(d, b.id) ? { range } : {}),
                  ...(wireFilters() ? { filters: wireFilters() } : {}),
                  signal: reads.signal,
                })
              }}
              open={(link) => openRecordLink(api, link)}
              onClose={closeDrill}
            />
          )}
        </Show>
        <Show when={loaded()}>
          {(d) => (
            <DashboardShareDialog
              dashboardId={d().id}
              dashboardTitle={d().title}
              open={shareOpen()}
              onOpenChange={setShareOpen}
              onSaved={() => {
                reloadDashboard(d().id)
                void loadDashboards(api)
              }}
            />
          )}
        </Show>
        <Show when={historyOpen() && loaded()}>
          {(d) => (
            <VersionHistoryPanel
              revision={d().version}
              loadVersions={() => listVersions(api, d().id)}
              loadVersion={(v) => getVersion(api, d().id, v)}
              onRestore={canEdit() ? (v) => void restore(v) : undefined}
              busy={saving()}
              onClose={() => setHistoryOpen(false)}
            />
          )}
        </Show>
      </div>
    </section>
  )
}

export default DashboardView
