// SPDX-License-Identifier: FSL-1.1-ALv2

import { Bug, LogOut, MonitorDown, PanelLeft } from "lucide-solid"
import type { JSX } from "solid-js"
import {
  type Component,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { Portal } from "solid-js/web"
import {
  type ActivityBarEntry,
  getActivityBarEntries,
  registryLabel,
  resolveRegisteredTabType,
} from "~/framework/app-registry"
import { cn } from "~/lib/cn"
import {
  desktopDownloadUrl,
  detectDesktopOs,
  orderedDesktopDownloads,
} from "~/lib/desktop-downloads"
import { inWrappedShell } from "~/modules/auth/auth-store"
import { BugReportDialog } from "~/modules/bug-report/BugReportDialog"
import DesktopServersMenu from "~/modules/desktop/DesktopServersMenu"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  fitRailEntries,
  RAIL_FOLD_DELAY_MS,
  RAIL_GAP_PX,
  RAIL_OPEN_INTENT_MS,
  RAIL_SLOT_PX,
  railCapacity,
  railColumnCount,
  railGridCell,
} from "~/modules/shell/activity-bar-fit"
import {
  applyActivityBarOrder,
  moveActivityBarEntry,
} from "~/modules/shell/activity-bar-order-store"
import { appIconColor } from "~/modules/shell/app-color"
import { attentionStore } from "~/modules/shell/attention-store"
import { hideFromSidebar, isHiddenFromSidebar } from "~/modules/shell/sidebar-visibility"
import { openTab, tabStore } from "~/modules/shell/tab-store"
import { toggleTabletSidebar } from "~/modules/shell/tablet-sidebar-store"
import { useWs } from "~/modules/shell/WsContext"
import { ToursHelpButton } from "~/modules/tours/ToursMenu"
import { PopupMenu } from "~/ui/PopupMenu"
import { Tooltip } from "~/ui/Tooltip"

interface ActivityBarProps {
  onLogout?: () => void
  /** Shell layout tier. Only the tablet tier exposes the sidebar drawer toggle.
   *  Phone does not render this component at all: it has five fixed seats of
   *  its own (`PhoneTabBar`), so there is no `bar` layout here any more. The
   *  prop still accepts the whole tier union so the shell can pass its signal
   *  straight through. */
  tier?: "desktop" | "tablet" | "phone"
  style?: JSX.CSSProperties
}

/** "+N" control's name: how many apps are folded away. */
const moreAppsLabel = (t: ReturnType<typeof useI18n>["t"], count: number): string =>
  count === 1 ? t("kernel.nav.moreAppsOne", { count }) : t("kernel.nav.moreAppsMany", { count })

export const ActivityBar: Component<ActivityBarProps> = (props) => {
  const i18n = useI18n()
  const ws = useWs()
  // The apps the person hid from their sidebar are left out here (and on the
  // phone Work list): "+N", drag-reorder and the fit all work on what shows.
  // They still open from search, the command palette and links.
  const topEntries = createMemo(() =>
    applyActivityBarOrder(
      getActivityBarEntries().filter((e) => e.position !== "bottom" && !isHiddenFromSidebar(e.id)),
    ),
  )

  const [draggedId, setDraggedId] = createSignal<string | null>(null)
  const [dropTargetId, setDropTargetId] = createSignal<string | null>(null)
  const [bugReportOpen, setBugReportOpen] = createSignal(false)
  const [desktopMenuOpen, setDesktopMenuOpen] = createSignal(false)
  // A shell (desktop or mobile) sets its server address before the app loads;
  // a browser has none. Inside a shell the app is already installed, so the
  // offer would be noise, and on a phone shell it would be wrong.
  const offersDesktopApp = !inWrappedShell()
  const visitorOs = detectDesktopOs(navigator)

  const handleDrop = (targetId: string) => {
    const dragged = draggedId()
    if (dragged) {
      moveActivityBarEntry(
        topEntries().map((e) => e.id),
        dragged,
        targetId,
      )
    }
    endDrag()
  }

  const bottomEntries = createMemo(() =>
    [...getActivityBarEntries()]
      .filter((e) => e.position === "bottom")
      .sort((a, b) => a.order - b.order),
  )

  const activeTabType = createMemo(() => {
    const activeTab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    return resolveRegisteredTabType(activeTab?.type ?? "") ?? activeTab?.type
  })

  const isActive = (entry: ActivityBarEntry) => {
    const type = activeTabType()
    if (!type) return false
    return type === entry.tabAction.type || (entry.activeForTabTypes?.includes(type) ?? false)
  }

  // Tablet, the iPad pattern: the rail stays put while the drawer is open
  // beside it. Tapping ANOTHER app opens that app, which swaps what the drawer
  // shows (the sidebar follows the active tab) without the drawer ever coming
  // down. Tapping the app you are already in has no tab to open, so it toggles
  // the drawer instead: open it if it is closed, close it if it is showing.
  // Every other tier keeps the plain "open the app" click.
  const activateEntry = (entry: ActivityBarEntry): void => {
    if (props.tier === "tablet" && isActive(entry)) {
      toggleTabletSidebar()
      return
    }
    openTab({ ...entry.tabAction, preview: false })
  }

  // Right-click (or the ContextMenu key / Shift+F10) on an app opens a small
  // menu beside it. The menu is the shared PopupMenu, anchored on an invisible
  // box laid over the app's button: a left click still opens the app.
  const [entryMenu, setEntryMenu] = createSignal<{
    id: string
    label: string
    box: { top: number; left: number; width: number; height: number }
  } | null>(null)
  let entryMenuOpener: HTMLElement | null = null
  const openEntryMenu = (entry: ActivityBarEntry, el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    entryMenuOpener = el
    setEntryMenu({
      id: entry.id,
      label: registryLabel(i18n.t, entry),
      box: { top: r.top, left: r.left, width: r.width, height: r.height },
    })
  }

  const railBottomEntries = bottomEntries
  // 44px minimum hit area wherever a finger is the pointer (the tablet rail).
  // Desktop keeps the denser 34px square. The real geometry check lives in the
  // layout oracle; this only wires the sizing.
  const isTouchTier = () => props.tier === "tablet"
  const buttonClass = (extra?: string) =>
    cn(
      "relative flex items-center justify-center rounded-md transition-all duration-150",
      isTouchTier() ? "min-h-11 min-w-11 shrink-0" : "h-[34px] w-[34px]",
      extra,
    )

  const hasAttention = (entry: ActivityBarEntry) =>
    // Kernel entry renders its own dot via HomeIconWithDot — skip the bar-level overlay.
    entry.appId !== "kernel" && attentionStore.attentionForApp(entry.appId).length > 0

  // Overflow. The app column draws what fits in its measured height; when not
  // every app does, its last slot becomes a "+N" control. Pointing at it (a
  // short hover intent), clicking it, or dragging an app onto it opens the
  // rail into as many columns as every app needs, laid over the sidebar
  // rather than pushing the layout. The height is observed, so a window
  // resize, an install, an uninstall or a reorder recomputes the split.
  let appsColumnRef: HTMLDivElement | undefined
  let appsTrackRef: HTMLDivElement | undefined
  let railRef: HTMLElement | undefined
  let moreButtonRef: HTMLButtonElement | undefined
  const appsTrackId = createUniqueId()
  const [columnHeight, setColumnHeight] = createSignal<number | null>(null)
  const [railOpen, setRailOpen] = createSignal(false)
  onMount(() => {
    const column = appsColumnRef
    if (!column) return
    const measure = () => setColumnHeight(column.clientHeight)
    const ro = new ResizeObserver(measure)
    ro.observe(column)
    measure()
    onCleanup(() => ro.disconnect())
  })
  const slotPx = () => (isTouchTier() ? RAIL_SLOT_PX.tablet : RAIL_SLOT_PX.desktop)
  const capacity = createMemo(() => railCapacity(columnHeight(), slotPx(), RAIL_GAP_PX))
  const railFit = createMemo(() =>
    fitRailEntries(
      topEntries().map((e) => e.id),
      capacity(),
      topEntries().find((e) => isActive(e))?.id ?? null,
    ),
  )
  const entriesById = createMemo(() => new Map(topEntries().map((e) => [e.id, e])))
  const pick = (ids: string[]) =>
    ids.flatMap((id) => {
      const entry = entriesById().get(id)
      return entry ? [entry] : []
    })
  const overflowEntries = createMemo(() => pick(railFit().overflow))
  // Open only while something is folded away: when everything fits again (a
  // taller window, an uninstall) the rail is one column whatever the flag says.
  const expanded = () => railOpen() && overflowEntries().length > 0
  // Folded, the rail draws what fits; open, every app in rail order: column one
  // top to bottom, then the folded apps from the bottom up (railGridCell), so
  // they start beside "+N", where the pointer already is.
  const railTopEntries = createMemo(() => (expanded() ? topEntries() : pick(railFit().visible)))
  const railColumns = createMemo(() =>
    expanded() ? railColumnCount(topEntries().length, capacity()) : 1,
  )
  // A badge on an app folded away shows as a dot on "+N", in the danger tone
  // if any of them carries a danger count; a plain attention dot carries over
  // the same way. Nothing a folded app was signalling goes unseen.
  const moreBadge = createMemo(() =>
    overflowEntries().reduce((sum, e) => sum + Math.max(0, e.badge?.() ?? 0), 0),
  )
  const moreBadgeTone = createMemo(() =>
    overflowEntries().some((e) => (e.badge?.() ?? 0) > 0 && e.badgeTone !== "warning")
      ? "danger"
      : "warning",
  )
  const moreAttention = createMemo(() => overflowEntries().some(hasAttention))

  let openTimer: ReturnType<typeof setTimeout> | undefined
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const clearTimers = () => {
    clearTimeout(openTimer)
    clearTimeout(closeTimer)
    openTimer = undefined
    closeTimer = undefined
  }
  onCleanup(clearTimers)
  /** Opens the rail. `focusFolded` moves focus to the first app that was
   *  folded away, so a keyboard opening lands where it meant to go (the "+N"
   *  control itself leaves the rail once it is open). */
  const openRail = (focusFolded: boolean) => {
    clearTimers()
    if (expanded()) return
    const firstFolded = overflowEntries()[0]?.id
    setRailOpen(true)
    if (focusFolded && firstFolded) {
      appsTrackRef
        ?.querySelector<HTMLElement>(`[data-rail-entry="${CSS.escape(firstFolded)}"]`)
        ?.focus()
    }
  }
  /** Folds the rail. Focus that was on an app that folds away, or any Escape,
   *  goes back to "+N" rather than dropping to the page. */
  const closeRail = (returnFocus: boolean) => {
    clearTimers()
    if (!railOpen()) return
    const focusWasInRail = appsTrackRef?.contains(document.activeElement) ?? false
    setRailOpen(false)
    if (!focusWasInRail) return
    const focused = document.activeElement
    const lost = !focused || focused === document.body || !appsTrackRef?.contains(focused)
    if (returnFocus || lost) moreButtonRef?.focus()
  }
  const scheduleClose = () => {
    clearTimeout(closeTimer)
    if (!expanded() || draggedId()) return
    closeTimer = setTimeout(() => closeRail(false), RAIL_FOLD_DELAY_MS)
  }
  const cancelClose = () => {
    clearTimeout(closeTimer)
    closeTimer = undefined
  }
  // A press outside the open rail (the touch way to fold it), Escape, or the
  // focus leaving the rail fold it.
  const onDocumentPointerDown = (e: PointerEvent) => {
    if (!expanded()) return
    const target = e.target
    if (target instanceof Node && railRef?.contains(target)) return
    closeRail(false)
  }
  const onDocumentKeyDown = (e: KeyboardEvent) => {
    if (!expanded() || e.key !== "Escape") return
    closeRail(true)
  }
  onMount(() => {
    document.addEventListener("pointerdown", onDocumentPointerDown, true)
    document.addEventListener("keydown", onDocumentKeyDown)
    onCleanup(() => {
      document.removeEventListener("pointerdown", onDocumentPointerDown, true)
      document.removeEventListener("keydown", onDocumentKeyDown)
    })
  })
  // After a drag the browser may not send the rail a pointerleave at all: the
  // drag's start cancelled the pointer (pointercancel, with its own leave,
  // ignored mid-drag), so the pointer's next move out of the rail can come as
  // a plain move elsewhere. The first move after a drop that ended over the
  // rail decides instead: outside the rail, it folds as if the pointer had
  // just left; inside, the rail's own enter and leave take over again.
  let afterDragMove: ((e: PointerEvent) => void) | undefined
  const stopAfterDragWatch = () => {
    if (afterDragMove) document.removeEventListener("pointermove", afterDragMove, true)
    afterDragMove = undefined
  }
  onCleanup(stopAfterDragWatch)
  const endDrag = () => {
    setDraggedId(null)
    setDropTargetId(null)
    stopAfterDragWatch()
    if (!expanded()) return
    // The open rail stayed open through the drag; once it ends with the
    // pointer elsewhere, it folds as if the pointer had just left.
    if (!railRef?.matches(":hover")) {
      scheduleClose()
      return
    }
    afterDragMove = (e: PointerEvent) => {
      stopAfterDragWatch()
      const target = e.target
      if (e.pointerType !== "touch" && !(target instanceof Node && railRef?.contains(target)))
        scheduleClose()
    }
    document.addEventListener("pointermove", afterDragMove, true)
  }

  return (
    <nav
      ref={railRef}
      data-testid="activity-bar"
      data-tour-tier="wide"
      // Non-test hook: the tablet drawer asks whether an outside interaction
      // landed on the rail, and a `data-testid` is not a contract to build on.
      data-activity-rail=""
      data-rail-open={expanded() ? "true" : "false"}
      // Open, the rail's columns spill over the sidebar: the rail stays in its
      // grid cell (nothing reflows) and is lifted above its neighbours.
      class={cn(
        "relative flex h-full min-h-0 min-w-0 flex-col items-center gap-1 border-r border-border-subtle bg-bg py-3",
        expanded() ? "z-40 overflow-visible" : "overflow-hidden",
      )}
      style={props.style}
      onPointerEnter={cancelClose}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") scheduleClose()
      }}
      onFocusOut={(e) => {
        const next = e.relatedTarget
        if (expanded() && next instanceof Node && !railRef?.contains(next)) closeRail(false)
      }}
    >
      {/* Activity-bar clicks are deliberate app navigation, not a glance —
          both entry lists open with preview:false so the app home anchors
          permanently (like kernel Home) and opening an entity from inside
          the app can't replace it under the one-preview-tab policy. */}
      {/* Tablet only: the sidebar is a rail that opens into an overlay drawer,
          so it needs an explicit toggle. Desktop docks it, phone never renders
          it. */}
      <Show when={props.tier === "tablet"}>
        <Tooltip openDelay={0} placement="right" content={i18n.t("kernel.toggleSidebar")}>
          <button
            type="button"
            aria-label={i18n.t("kernel.toggleSidebar")}
            data-testid="activity-sidebar-toggle"
            onClick={() => toggleTabletSidebar()}
            class={buttonClass(
              "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary",
            )}
          >
            <PanelLeft size={18} />
          </button>
        </Tooltip>
      </Show>

      {/* The app entries fill their own column, the bottom entries stay
          pinned below it. The column is measured; the track inside it is a
          plain column while folded and, open, an overlay grid anchored on the
          column's top left corner whose first column sits exactly where the
          folded one does. `w-full` keeps the active-entry bar (6px left of the
          button) inside the clip box. */}
      <div
        ref={appsColumnRef}
        data-testid="activity-bar-apps"
        class={cn("relative min-h-0 w-full flex-1", !expanded() && "overflow-hidden")}
      >
        <div
          ref={appsTrackRef}
          id={appsTrackId}
          data-testid="activity-bar-apps-track"
          data-columns={railColumns()}
          class={
            expanded()
              ? "absolute inset-y-0 left-0 grid grid-flow-col content-start justify-items-center gap-y-1 rounded-br-md border-r border-border bg-bg shadow-lg"
              : "flex h-full w-full flex-col items-center gap-1"
          }
          style={
            expanded()
              ? {
                  width: `calc(100% * ${railColumns()})`,
                  "grid-template-rows": `repeat(${Math.max(1, capacity())}, ${slotPx()}px)`,
                  "grid-template-columns": `repeat(${railColumns()}, minmax(0, 1fr))`,
                }
              : undefined
          }
        >
          <For each={railTopEntries()}>
            {(entry, index) => (
              <Tooltip
                openDelay={0}
                placement="right"
                content={registryLabel(i18n.t, entry)}
                triggerStyle={
                  expanded()
                    ? (() => {
                        const cell = railGridCell(index(), capacity())
                        return { "grid-row": `${cell.row}`, "grid-column": `${cell.column}` }
                      })()
                    : undefined
                }
              >
                <button
                  type="button"
                  aria-label={registryLabel(i18n.t, entry)}
                  data-testid={`activity-${entry.label.toLowerCase().replace(/\s+/g, "-")}`}
                  // The rail is desktop only: a tour beat pointing at an entry needs a phone anchor.
                  data-tour-tier="wide"
                  data-rail-entry={entry.id}
                  aria-current={isActive(entry) ? "page" : undefined}
                  onClick={() => activateEntry(entry)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    openEntryMenu(entry, e.currentTarget)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                      e.preventDefault()
                      e.stopPropagation()
                      openEntryMenu(entry, e.currentTarget)
                    }
                  }}
                  draggable={true}
                  onDragStart={(e) => {
                    setDraggedId(entry.id)
                    e.dataTransfer?.setData("text/plain", entry.id)
                    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
                  }}
                  onDragOver={(e) => {
                    if (!draggedId()) return
                    e.preventDefault()
                    if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
                    setDropTargetId(entry.id)
                  }}
                  onDragLeave={() => {
                    if (dropTargetId() === entry.id) setDropTargetId(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    handleDrop(entry.id)
                  }}
                  onDragEnd={endDrag}
                  class={buttonClass(
                    cn(
                      isActive(entry)
                        ? "bg-accent-glow text-accent"
                        : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary",
                      draggedId() === entry.id && "opacity-40",
                      dropTargetId() === entry.id &&
                        draggedId() !== entry.id &&
                        "ring-1 ring-accent",
                    ),
                  )}
                >
                  <Show when={isActive(entry)}>
                    <span class="absolute left-[-6px] top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-r-sm bg-accent" />
                  </Show>
                  {/* The app's own colour, so the rail is read by shape AND hue
                    rather than label by label. The active and hover states are
                    carried by the pill background and the accent bar beside it,
                    which stay legible under any icon colour. */}
                  <span
                    data-app-glyph={entry.appId}
                    class="flex items-center justify-center"
                    style={{ color: appIconColor(entry.appId) }}
                  >
                    <entry.icon size={18} />
                  </span>
                  <Show when={hasAttention(entry)}>
                    <span
                      data-testid={`activity-bar-attention-${entry.appId}`}
                      class="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent"
                    />
                  </Show>
                  <Show when={(entry.badge?.() ?? 0) > 0}>
                    <span
                      data-testid={`activity-bar-badge-${entry.label.toLowerCase().replace(/\s+/g, "-")}`}
                      data-tone={entry.badgeTone ?? "danger"}
                      class="pointer-events-none absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none tabular-nums"
                      classList={{
                        "bg-danger text-white": entry.badgeTone !== "warning",
                        "bg-warning text-black": entry.badgeTone === "warning",
                      }}
                    >
                      {(entry.badge?.() ?? 0) > 99 ? "99+" : entry.badge?.()}
                    </span>
                  </Show>
                </button>
              </Tooltip>
            )}
          </For>
          <Show when={overflowEntries().length > 0}>
            <FoldGuard onGone={() => closeRail(false)} />
          </Show>
          <Show when={overflowEntries().length > 0 && !expanded()}>
            <Tooltip
              openDelay={0}
              placement="right"
              content={moreAppsLabel(i18n.t, overflowEntries().length)}
            >
              <button
                ref={moreButtonRef}
                type="button"
                aria-label={moreAppsLabel(i18n.t, overflowEntries().length)}
                aria-expanded={expanded()}
                aria-controls={appsTrackId}
                data-testid="activity-bar-more"
                data-overflow-count={overflowEntries().length}
                onClick={() => openRail(true)}
                onPointerEnter={(e) => {
                  if (e.pointerType === "touch") return
                  clearTimeout(openTimer)
                  openTimer = setTimeout(() => openRail(false), RAIL_OPEN_INTENT_MS)
                }}
                onPointerLeave={() => {
                  clearTimeout(openTimer)
                  openTimer = undefined
                }}
                onDragOver={(e) => {
                  // Dragging an app onto "+N" opens the rail, so any slot,
                  // folded or not, can take it.
                  if (!draggedId()) return
                  e.preventDefault()
                  openRail(false)
                }}
                class={buttonClass(
                  cn(
                    "shrink-0 font-mono text-[11px] font-medium tracking-[0.02em]",
                    draggedId()
                      ? "bg-surface-hover text-text-primary"
                      : "text-text-tertiary hover:bg-surface-hover hover:text-text-primary",
                  ),
                )}
              >
                +{overflowEntries().length}
                <Show
                  when={moreBadge() > 0}
                  fallback={
                    <Show when={moreAttention()}>
                      <span
                        data-testid="activity-bar-more-attention"
                        class="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent"
                      />
                    </Show>
                  }
                >
                  <span
                    data-testid="activity-bar-more-badge"
                    data-tone={moreBadgeTone()}
                    data-count={moreBadge()}
                    class="pointer-events-none absolute right-0.5 top-0.5 h-2 w-2 rounded-full"
                    classList={{
                      "bg-danger": moreBadgeTone() === "danger",
                      "bg-warning": moreBadgeTone() === "warning",
                    }}
                  />
                </Show>
              </button>
            </Tooltip>
          </Show>
        </div>
      </div>

      <For each={railBottomEntries()}>
        {(entry) => (
          <Tooltip openDelay={0} placement="right" content={registryLabel(i18n.t, entry)}>
            <button
              type="button"
              aria-label={registryLabel(i18n.t, entry)}
              data-testid={`activity-${entry.label.toLowerCase().replace(/\s+/g, "-")}`}
              data-tour-tier="wide"
              data-rail-entry={entry.id}
              aria-current={isActive(entry) ? "page" : undefined}
              onClick={() => activateEntry(entry)}
              class={buttonClass(
                isActive(entry)
                  ? "bg-accent-glow text-accent"
                  : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary",
              )}
            >
              <Show when={isActive(entry)}>
                <span class="absolute left-[-6px] top-1/2 h-[18px] w-[3px] -translate-y-1/2 rounded-r-sm bg-accent" />
              </Show>
              {/* The app's own colour, so the rail is read by shape AND hue
                  rather than label by label. The active and hover states are
                  carried by the pill background and the accent bar beside it,
                  which stay legible under any icon colour. */}
              <span
                data-app-glyph={entry.appId}
                class="flex items-center justify-center"
                style={{ color: appIconColor(entry.appId) }}
              >
                <entry.icon size={18} />
              </span>
              <Show when={hasAttention(entry)}>
                <span
                  data-testid={`activity-bar-attention-${entry.appId}`}
                  class="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent"
                />
              </Show>
            </button>
          </Tooltip>
        )}
      </For>

      {/* Directly under Settings: the one place a browser visitor learns there
          is a desktop app. Rows are real links to the stable installer names. */}
      <Show when={offersDesktopApp}>
        <PopupMenu open={desktopMenuOpen()} onOpenChange={setDesktopMenuOpen} placement="right-end">
          <Tooltip openDelay={0} placement="right" content={i18n.t("kernel.desktopApp.get")}>
            <PopupMenu.Trigger
              aria-label={i18n.t("kernel.desktopApp.get")}
              data-testid="activity-desktop-app"
              class={buttonClass(
                desktopMenuOpen()
                  ? "bg-surface-hover text-text-secondary"
                  : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary",
              )}
            >
              <MonitorDown size={18} />
            </PopupMenu.Trigger>
          </Tooltip>
          <PopupMenu.Content
            aria-label={i18n.t("kernel.desktopApp.menuLabel")}
            data-testid="desktop-app-menu"
            class="w-64"
          >
            <For each={orderedDesktopDownloads(visitorOs)}>
              {(download) => (
                <PopupMenu.LinkItem
                  href={desktopDownloadUrl(download)}
                  download
                  data-testid={`desktop-app-${download.id}`}
                >
                  <span class="flex min-w-0 flex-col">
                    <span>{i18n.t(download.labelKey)}</span>
                    <Show when={download.os === visitorOs}>
                      <span class="text-[11px] text-text-tertiary">
                        {i18n.t("kernel.desktopApp.recommended")}
                      </span>
                    </Show>
                  </span>
                </PopupMenu.LinkItem>
              )}
            </For>
          </PopupMenu.Content>
        </PopupMenu>
      </Show>

      <Show when={ws.status() !== "connected"}>
        <Tooltip
          openDelay={0}
          placement="right"
          content={
            ws.status() === "connecting" || ws.status() === "reconnecting"
              ? i18n.t("kernel.nav.reconnecting")
              : i18n.t("kernel.nav.disconnected")
          }
        >
          <div
            role="status"
            data-testid="ws-status-indicator"
            data-ws-status={ws.status()}
            class={cn(
              "flex items-center justify-center",
              isTouchTier() ? "min-h-11 min-w-11" : "h-[34px] w-[34px]",
            )}
            aria-label={i18n.t("kernel.nav.connectionStatus", { status: ws.status() })}
          >
            <div
              class={cn(
                "h-2 w-2 rounded-full",
                ws.status() === "connecting" || ws.status() === "reconnecting"
                  ? "bg-warning animate-pulse"
                  : "bg-error",
              )}
            />
          </div>
        </Tooltip>
      </Show>

      {/* "Show me how": the guided tours for the installed apps. */}
      <ToursHelpButton buttonClass={buttonClass} />

      <Tooltip openDelay={0} placement="right" content={i18n.t("kernel.bugReport.title")}>
        <button
          type="button"
          aria-label={i18n.t("kernel.bugReport.title")}
          data-testid="activity-bug-report"
          onClick={() => setBugReportOpen(true)}
          class={buttonClass("text-text-tertiary hover:bg-surface-hover hover:text-text-secondary")}
        >
          <Bug size={18} />
        </button>
      </Tooltip>
      {/* Mounted lazily: the dialog resolves useApi() at setup, and the bar can
          render in contexts (tests, storybook-style harnesses) without an
          ApiProvider. Only an opened dialog needs the API. */}
      <Show when={bugReportOpen()}>
        <BugReportDialog open={bugReportOpen()} onOpenChange={setBugReportOpen} />
      </Show>

      {/* The desktop's server switcher. On Windows and Linux it is the only
          one: the shell draws no menu strip in the window there. */}
      <DesktopServersMenu
        buttonClass={buttonClass(
          "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary",
        )}
      />

      <Tooltip openDelay={0} placement="right" content={i18n.t("kernel.logOut")}>
        <button
          type="button"
          aria-label={i18n.t("kernel.logOut")}
          data-testid="activity-log-out"
          onClick={() => props.onLogout?.()}
          class={buttonClass("text-text-tertiary hover:bg-surface-hover hover:text-text-secondary")}
        >
          <LogOut size={18} />
        </button>
      </Tooltip>
      {/* An app's menu (right-click). Its anchor is a fixed box laid over the
          app's button, portalled out of the rail so the rail's own controls
          stay what they are; it takes no pointer or tab stop, and the menu is portalled. */}
      <PopupMenu
        open={entryMenu() !== null}
        onOpenChange={(open) => {
          if (!open) setEntryMenu(null)
        }}
        placement="right-start"
      >
        <Portal>
          <div
            class="pointer-events-none fixed"
            style={
              entryMenu()
                ? {
                    top: `${entryMenu()?.box.top}px`,
                    left: `${entryMenu()?.box.left}px`,
                    width: `${entryMenu()?.box.width}px`,
                    height: `${entryMenu()?.box.height}px`,
                  }
                : { top: "0", left: "0", width: "0", height: "0" }
            }
          >
            <PopupMenu.Trigger
              tabIndex={-1}
              aria-label={i18n.t("kernel.nav.railEntryMenu", { app: entryMenu()?.label ?? "" })}
              data-testid="activity-entry-menu-anchor"
              class="block h-full w-full"
            >
              {null}
            </PopupMenu.Trigger>
          </div>
        </Portal>
        <PopupMenu.Content
          aria-label={i18n.t("kernel.nav.railEntryMenu", { app: entryMenu()?.label ?? "" })}
          data-testid="activity-entry-menu"
          onCloseAutoFocus={(e) => {
            // Back to the app it was opened on, or (it was just hidden) the rail.
            e.preventDefault()
            const opener = entryMenuOpener
            entryMenuOpener = null
            if (opener?.isConnected) opener.focus()
            else appsTrackRef?.querySelector<HTMLElement>("[data-rail-entry]")?.focus()
          }}
        >
          <PopupMenu.Item
            data-testid="activity-entry-hide"
            onSelect={() => {
              const id = entryMenu()?.id
              if (id) void hideFromSidebar(id)
            }}
          >
            {i18n.t("kernel.nav.hideFromSidebar")}
          </PopupMenu.Item>
        </PopupMenu.Content>
      </PopupMenu>
    </nav>
  )
}

/** Present while some app is folded away. When everything fits again (a
 *  taller window, an uninstall) the open flag goes with it, so the rail does
 *  not spring back open the next time something overflows. */
const FoldGuard: Component<{ onGone: () => void }> = (props) => {
  onCleanup(() => props.onGone())
  return null
}
