// SPDX-License-Identifier: FSL-1.1-ALv2
// TicketsInbox — main list view: search, multi-select, smart-filter
// dispatch, and merge toolbar.

import { ChevronDown } from "lucide-solid"
import type { Component } from "solid-js"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { onEntityChange } from "~/framework/entity-changes"
import { cn } from "~/lib/cn"
import { capitalize, relativeTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { BulkActionToolbar } from "~/modules/shell/bulk/BulkActionToolbar"
import { openPhoneNavigator } from "~/modules/shell/phone-navigator-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab, tabStore } from "~/modules/shell/tab-store"
import { useWs } from "~/modules/shell/WsContext"
import { newTicketDialogOpen, setNewTicketDialogOpen } from "~/modules/tickets/new-ticket-dialog"
import { TicketAssignSheet } from "~/modules/tickets/TicketAssignSheet"
import { TicketFilterBar } from "~/modules/tickets/TicketFilterBar"
import { hasAgentDraft } from "~/modules/tickets/ticket-agent-draft"
import { loadInboxes, ticketInboxStore } from "~/modules/tickets/ticket-inbox-store"
import {
  filterRoutePath,
  loadTickets,
  paramsForSmartFilter,
  paramsFromRoutePath,
  refreshFilterCounts,
  type SmartFilter,
  searchOverridesView,
  setListParams,
  setReloadHook,
  ticketFilterCountStore,
  ticketListNeedsReload,
  ticketListStore,
  toggleSelection,
} from "~/modules/tickets/ticket-list-store"
import {
  TICKET_PILL_CLASS,
  TICKET_PILL_LABEL_KEY,
  TICKET_SLA_LABEL_KEY,
  ticketPhonePills,
  ticketSlaState,
  ticketViewChips,
} from "~/modules/tickets/ticket-phone-views"
import type { Ticket } from "~/modules/tickets/ticket-types"
import { ResponsiveList } from "~/ui/ResponsiveList"
import { SwipeRow } from "~/ui/SwipeRow"

// A ticket leaving the currently-filtered view (closed, merged away, a
// gated reply/close approved elsewhere) used to vanish from `ticketListStore.ids`
// the instant the WS event landed — every row below jumped up in the same
// frame. A click already in flight for the row now sitting at that position
// landed on the WRONG ticket (ticket 10344). `EXIT_TRANSITION_MS` is how long
// a removed row keeps its place (fading out, not clickable) before the list
// is allowed to actually close the gap.
const EXIT_TRANSITION_MS = 220

const NewTicketDialog = lazy(() =>
  import("./NewTicketDialog").then((m) => ({ default: m.NewTicketDialog })),
)
const TicketCloseDialog = lazy(() =>
  import("./TicketCloseDialog").then((m) => ({ default: m.TicketCloseDialog })),
)

/** A ticket status or priority chip in the reader's language. The raw value
 *  ("awaiting_customer", "normal") used to print as is, in English, under a
 *  French UI. An unknown value keeps its own words. */
export function ticketChipLabel(
  t: (key: string) => string,
  kind: "status" | "priority",
  value: string,
): string {
  const key = kind === "status" ? `tickets.status.${value}` : `tickets.${value}`
  const known =
    kind === "status"
      ? ["open", "awaiting_customer", "awaiting_followup", "closed"]
      : ["urgent", "high", "normal", "low"]
  return known.includes(value) ? t(key) : value.replace(/_/g, " ")
}

// Last-activity timestamp for the list row (the last message, inbound or
// outbound -- the same key the list sorts by, so date and order agree): relative
// for recent ("3 hours ago"), "Yesterday", then an absolute date for older.
function formatReceived(value: string | null | undefined, locale: string): string {
  if (!value) return ""
  const date = new Date(value)
  const time = date.getTime()
  if (Number.isNaN(time)) return ""
  const ms = Date.now() - time
  if (ms < 86_400_000 && ms >= 0) return relativeTime(date, locale, { style: "long" })
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) {
    return capitalize(new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day"))
  }
  const sameYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}

/** The row's SLA chip: the same state and words as the phone card. */
function slaLabelKey(ticket: {
  firstResponseAt?: string | null
  slaDeadline?: string | null
}): string | null {
  const state = ticketSlaState(ticket, Date.now())
  return state ? TICKET_SLA_LABEL_KEY[state] : null
}

export const TicketsInbox: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const ws = useWs()
  let lastWsStatus: string | null = null

  // --- Phone tier (M2-1 T10) ---
  // A JS branch, not a `md:` class pair: the swipe rail, the assignee sheet and
  // the select mode are stateful, and a second copy of them behind a media
  // query would be a second copy of the state as well.
  const phone = () => shellTier() === "phone"
  const [selectMode, setSelectMode] = createSignal(false)
  const [assignFor, setAssignFor] = createSignal<string | null>(null)
  const [closeFor, setCloseFor] = createSignal<string | null>(null)
  const [pillNow, setPillNow] = createSignal(Date.now())

  const chips = createMemo(() => ticketViewChips(ticketFilterCountStore.countByFilter))

  const activeChip = (): SmartFilter | undefined => ticketListStore.params.smartFilter

  const inboxName = (id: string | null | undefined): string | undefined =>
    id ? ticketInboxStore.inboxes.find((i) => i.id === id)?.name : undefined

  function selectView(filter: SmartFilter): void {
    // Same three steps the desktop sidebar's saved-view row takes: the tab's
    // routePath is what the reconciling effect below reads back, so writing the
    // params without it would be undone on the next store change.
    setListParams(paramsForSmartFilter(filter))
    openTab({
      type: "tickets:inbox",
      entityId: "inbox",
      label: i18n.t("tickets.tickets2"),
      routePath: filterRoutePath(filter),
    })
    void loadTickets(api)
  }

  // The chip row carries the counts; the desktop sidebar that normally
  // refreshes them is not mounted at phone width. Read REACTIVELY, not once at
  // mount: the tab stays mounted across a resize, so a window narrowed into
  // the phone tier used to show a chip row whose counts never loaded and whose
  // age pills never ticked.
  createEffect(() => {
    if (!phone()) return
    void refreshFilterCounts(api)
    const tick = setInterval(() => setPillNow(Date.now()), 60_000)
    onCleanup(() => clearInterval(tick))
  })

  // Rows the list holds are patched by the WS handlers; a ticket that is new,
  // enters the view or was missed during a disconnect needs a reload.
  onEntityChange(["tickets:ticket", "tickets:message"], (events) => {
    if (ticketListNeedsReload(events)) void loadTickets(api)
  })

  onMount(() => {
    setReloadHook(() => loadTickets(api))
    onCleanup(() => setReloadHook(null))
    // The "Move to inbox…" bulk action's picker form needs the org's inbox
    // list (see MoveTicketsToInboxForm) — load it up front so the dropdown
    // is populated the first time a user opens the action, without waiting
    // on the Settings page to have been visited first.
    if (!ticketInboxStore.loaded) void loadInboxes(api)
    // Reload after any bulk action so per-item status changes (close, merge,
    // assign, …) flush into the list without waiting for the next WS tick.
    const handleBulkComplete = (e: Event) => {
      const detail = (e as CustomEvent<{ app?: string }>).detail
      if (detail?.app === "tickets") void loadTickets(api)
    }
    window.addEventListener("bulk:dispatch-complete", handleBulkComplete)
    onCleanup(() => window.removeEventListener("bulk:dispatch-complete", handleBulkComplete))
    const activeInboxTab = tabStore.tabs.find(
      (tab) => tab.id === tabStore.activeTabId && tab.type === "tickets:inbox",
    )
    if (activeInboxTab?.routePath) {
      setListParams({
        ...paramsFromRoutePath(activeInboxTab.routePath),
        query: ticketListStore.params.query,
      })
      void loadTickets(api)
      return
    }
    if (!ticketListStore.loaded) void loadTickets(api)
  })

  // Reconcile list on WS reconnect.
  createEffect(() => {
    const s = ws.status()
    if (lastWsStatus !== "connected" && s === "connected" && lastWsStatus !== null) {
      void loadTickets(api)
    }
    lastWsStatus = s
  })

  // Re-derive list params from the active tab's routePath whenever it changes.
  // The tab persists across navigations, so a `page.goto('/tickets?filter=closed')`
  // doesn't remount the component — only the routePath updates.
  createEffect(() => {
    const activeInboxTab = tabStore.tabs.find(
      (tab) => tab.id === tabStore.activeTabId && tab.type === "tickets:inbox",
    )
    if (!activeInboxTab?.routePath) return
    const next = paramsFromRoutePath(activeInboxTab.routePath)
    const current = ticketListStore.params
    if (current.smartFilter === next.smartFilter && current.inboxId === next.inboxId) return
    setListParams({ ...next, query: ticketListStore.params.query })
    void loadTickets(api)
  })

  const items = createMemo(() => ticketListStore.ids.map((id) => ticketListStore.byId[id]))

  // Rows currently mid-exit-transition: still rendered (stale snapshot, last
  // known position), not clickable, visually collapsing. Reactive so the JSX
  // below can toggle the transition classes per row.
  const [exitingIds, setExitingIds] = createStore<Record<string, boolean>>({})
  // The list actually rendered — `items()` plus any row still mid-exit. Kept
  // in a signal (not a memo) because it is written from both the reconciling
  // effect below AND the exit-timeout callbacks.
  const [displayItems, setDisplayItems] = createSignal<Ticket[]>([])
  // Plain (non-reactive) bookkeeping: the effect's own view of "what was
  // rendered last" and "which ids already have an exit scheduled" — kept
  // outside Solid's reactivity so writing them never re-triggers the effect.
  let prevDisplay: Ticket[] = []
  const scheduledExitIds = new Set<string>()
  // Keyed by id (not a bare Set of handles) so a row that REAPPEARS before its
  // transition finishes can cancel exactly its own pending removal timer.
  const exitTimeoutsById = new Map<string, ReturnType<typeof setTimeout>>()
  onCleanup(() => {
    for (const t of exitTimeoutsById.values()) clearTimeout(t)
  })

  createEffect(() => {
    const current = items()
    const currentById = new Map(current.map((t) => [t.id, t]))
    const prevIndexById = new Map(prevDisplay.map((t, i) => [t.id, i]))

    // A row that was exiting but came back into the store before its
    // transition finished (e.g. reopened, or the WS event that dropped it
    // raced a reload that re-added it) must be un-exited: cancel its pending
    // removal timer and clear both bookkeeping sets. Left alone, it would
    // keep rendering invisible (pointer-events-none, opacity-0) until the
    // STALE timer fired and yanked it out of `prevDisplay` while it was still
    // live data — the ticket would vanish until some unrelated store change
    // happened to resync the list.
    let reappeared = false
    for (const id of scheduledExitIds) {
      if (!currentById.has(id)) continue
      scheduledExitIds.delete(id)
      const t = exitTimeoutsById.get(id)
      if (t !== undefined) {
        clearTimeout(t)
        exitTimeoutsById.delete(id)
      }
      reappeared = true
    }
    if (reappeared) {
      setExitingIds(
        produce((s) => {
          for (const id of Object.keys(s)) {
            if (currentById.has(id)) delete s[id]
          }
        }),
      )
    }

    // Build the merged render list in the STORE's current order (so a
    // reorder — e.g. a new message bumping a ticket to the front — is
    // reflected live) and re-insert any still-exiting row at ~its last known
    // position, instead of freezing the whole list to the order it had the
    // moment the first row started exiting.
    const merged: Ticket[] = [...current]
    const newlyRemoved: string[] = []
    for (const row of prevDisplay) {
      if (currentById.has(row.id)) continue
      if (!scheduledExitIds.has(row.id)) newlyRemoved.push(row.id)
      const idx = prevIndexById.get(row.id) ?? merged.length
      merged.splice(Math.min(idx, merged.length), 0, row)
    }

    if (newlyRemoved.length > 0) {
      for (const id of newlyRemoved) scheduledExitIds.add(id)
      setExitingIds(
        produce((s) => {
          for (const id of newlyRemoved) s[id] = true
        }),
      )
      for (const id of newlyRemoved) {
        const t = setTimeout(() => {
          exitTimeoutsById.delete(id)
          scheduledExitIds.delete(id)
          setExitingIds(id, false)
          prevDisplay = prevDisplay.filter((row) => row.id !== id)
          setDisplayItems(prevDisplay)
        }, EXIT_TRANSITION_MS)
        exitTimeoutsById.set(id, t)
      }
    }
    prevDisplay = merged
    setDisplayItems(merged)
  })

  function applySearch(q: string): void {
    setListParams({ ...ticketListStore.params, query: q })
    void loadTickets(api)
  }

  function openTicket(ticketId: string): void {
    openTab({ type: "tickets:ticket", entityId: ticketId, label: i18n.t("tickets.ticket") })
  }

  return (
    <div class="flex h-full flex-col" data-testid="tickets-inbox">
      <Show when={phone()}>
        {/* The screen's own large title, and the one control the phone top bar
            has no room for. G1: this tab type hides the shared phone top bar
            entirely (registerAppPhoneTopBarHidden in exports.ts), the same
            convention ChatsScreen/Work use for a root screen with a large
            title of its own. Hiding the bar took the navigator opener with it,
            and the chip row only carries the smart filters: per-inbox counts
            and saved views live in the registered TicketsSidebar, which was
            unreachable on a phone. So the large title IS the opener, exactly
            as the mail folder title is. */}
        <div
          class="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3"
          data-testid="tickets-phone-header"
        >
          <button
            type="button"
            data-testid="tickets-phone-title"
            aria-label={i18n.t("kernel.ticketsChooseView")}
            class="flex min-w-0 flex-1 items-center gap-1 rounded-md text-left"
            onClick={() => openPhoneNavigator()}
          >
            <h1 class="min-w-0 truncate text-[28px] font-bold leading-tight text-text">
              {i18n.t("kernel.ticketsTitle")}
            </h1>
            <ChevronDown size={20} class="shrink-0 text-text-tertiary" aria-hidden="true" />
          </button>
          <button
            type="button"
            data-testid="tickets-select-toggle"
            aria-pressed={selectMode()}
            class="flex min-h-11 items-center rounded-md px-2 text-[15px] text-accent"
            onClick={() => setSelectMode((v) => !v)}
          >
            {selectMode() ? i18n.t("kernel.ticketsSelectDone") : i18n.t("kernel.ticketsSelect")}
          </button>
        </div>
        <div
          class="flex shrink-0 gap-2 overflow-x-auto px-4 pb-2"
          data-testid="tickets-chip-row"
          data-tour-tier="phone"
          role="tablist"
        >
          <For each={chips()}>
            {(chip) => (
              <button
                type="button"
                role="tab"
                data-testid={`tickets-chip-${chip.id}`}
                data-active={activeChip() === chip.id ? "true" : "false"}
                aria-selected={activeChip() === chip.id}
                class={cn(
                  "flex min-h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px]",
                  activeChip() === chip.id
                    ? "bg-accent text-accent-foreground"
                    : "bg-surface-sunken text-text-secondary",
                )}
                onClick={() => selectView(chip.id)}
              >
                {i18n.t(chip.labelKey)}
                <Show when={chip.count !== undefined}>
                  <span
                    class="tabular-nums opacity-70"
                    data-testid={`tickets-chip-count-${chip.id}`}
                  >
                    {chip.count}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="flex items-center gap-2 border-b border-border p-3">
        <input
          type="search"
          class="flex-1 rounded border border-border bg-surface px-3 py-1.5 text-sm"
          placeholder={i18n.t("tickets.searchTickets")}
          data-testid="tickets-search-input"
          onInput={(e) => applySearch(e.currentTarget.value)}
        />
        <button
          type="button"
          class="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground"
          data-testid="tickets-new-ticket-button"
          onClick={() => setNewTicketDialogOpen(true)}
        >
          {i18n.t("tickets.newTicket")}
        </button>
      </div>
      {/* The desktop refinement row is five dropdowns wide: at phone width the
          chip row above IS the view picker, and the rest is reached from the
          navigator sheet. */}
      <Show when={!phone()}>
        <TicketFilterBar />
      </Show>

      <Show when={searchOverridesView()}>
        <div
          class="border-b border-border px-3 py-1 text-xs text-text-secondary"
          data-testid="tickets-search-scope-hint"
        >
          {i18n.t("tickets.searchAllScopeHint")}
        </div>
      </Show>

      <BulkActionToolbar app="tickets" viewId="inbox" />

      {/* min-h-0: without it Safari sizes this flex child to its content and the list never scrolls */}
      <div class="min-h-0 flex-1 overflow-y-auto" data-testid="tickets-list">
        <Show when={ticketListStore.error}>
          {(err) => (
            <div class="p-8 text-center text-error" data-testid="tickets-error">
              {err()}
            </div>
          )}
        </Show>
        <Show when={!ticketListStore.error && ticketListStore.searchUnavailable}>
          <div class="p-8 text-center text-text-secondary" data-testid="tickets-search-unavailable">
            {i18n.t("tickets.searchIsTemporarilyUnavailableFiltersAnd")}
          </div>
        </Show>
        <Show
          when={
            !ticketListStore.loading &&
            !ticketListStore.error &&
            !ticketListStore.searchUnavailable &&
            items().length === 0
          }
          fallback={null}
        >
          <div class="p-8 text-center text-text-secondary" data-testid="tickets-empty">
            {i18n.t("tickets.noTicketsMatchThisView")}
          </div>
        </Show>
        <Show when={!ticketListStore.searchUnavailable}>
          <ResponsiveList
            items={displayItems()}
            // The card's FRAME moves onto the SwipeRow below (its border, its
            // radius and its padding), so the swipe clips at the card's own
            // edge instead of 12px inside a frame that never moves.
            cardClass="mx-3 my-2 border-0 p-0"
            renderRow={(t, index) => (
              <div
                class={cn(
                  "flex items-center gap-3 border-b border-border-subtle p-3 max-h-48",
                  "transition-[opacity,transform,max-height,padding] duration-200 ease-in",
                  t.unread && "font-semibold",
                  exitingIds[t.id]
                    ? "pointer-events-none max-h-0 -translate-x-2 overflow-hidden !border-0 !p-0 opacity-0"
                    : "cursor-pointer hover:bg-surface-hover",
                )}
                data-testid={`tickets-list-row-${t.id}`}
                data-unread={t.unread ? "true" : "false"}
                data-exiting={exitingIds[t.id] ? "true" : "false"}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (exitingIds[t.id]) return
                  openTicket(t.id)
                }}
                onKeyDown={(e) => {
                  if (exitingIds[t.id]) return
                  if (e.key === "Enter" || e.key === " ") openTicket(t.id)
                }}
              >
                {/* The 44px finger target is the LABEL, never the control:
                    a checkbox stretched to 44px is a 44px checkbox. The label
                    forwards its own clicks to the input, so the whole square
                    toggles, and the glyph keeps the tier's size. */}
                <label
                  data-testid={`tickets-row-checkbox-hit-${t.id}`}
                  class="-my-2 flex h-11 w-11 shrink-0 items-center justify-center lg:m-0 lg:h-4 lg:w-4"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    data-touch-dense
                    class="h-[22px] w-[22px] shrink-0 lg:h-4 lg:w-4"
                    data-testid={`tickets-row-checkbox-${t.id}`}
                    checked={!!ticketListStore.selection[t.id]}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelection(t.id)}
                  />
                </label>
                <span
                  class={cn("h-2 w-2 rounded-full", t.unread ? "bg-accent" : "bg-transparent")}
                  data-testid={`tickets-unread-dot-${t.id}`}
                />
                <div class="min-w-0 flex-1 truncate">
                  <div class="flex min-w-0 items-center gap-2">
                    {/* The first row is the walk's entry point into the ticket
                        detail: the manifest nav directive subtab:tickets:detail
                        clicks this, since no ticket id is knowable up front. */}
                    <span
                      class="shrink-0 text-xs text-text-tertiary"
                      data-testid={index === 0 ? "tickets-tab-detail" : undefined}
                    >
                      #{t.handle}
                    </span>
                    {/* `min-w-0` IS WHAT MAKES `truncate` WORK IN A FLEX ROW.
                        Without it a flex item cannot shrink below its content,
                        so a long subject or preview pushed the row past the
                        window: the list's `overflow-y-auto` then computes
                        overflow-x to auto, the text was clipped mid-word and
                        the timestamp column scrolled out of sight. */}
                    <span class="min-w-0 truncate" data-testid={`tickets-row-subject-${t.id}`}>
                      {t.subject}
                    </span>
                    <Show when={t.mergedIntoTicketId}>
                      <span
                        class="rounded-full bg-surface-sunken px-1.5 py-0.5 text-[10px] text-text-tertiary"
                        data-testid={`tickets-row-merged-badge-${t.id}`}
                      >
                        {i18n.t("tickets.merged")}
                      </span>
                    </Show>
                  </div>
                  <div class="mt-1 flex min-w-0 items-center gap-2 text-xs text-text-secondary">
                    <span
                      class="max-w-[16rem] shrink-0 truncate"
                      data-testid={`tickets-row-contact-${t.id}`}
                    >
                      {t.contact?.name ?? t.contact?.email ?? i18n.t("tickets.noContact")}
                    </span>
                    <span class="shrink-0">·</span>
                    <span class="min-w-0 truncate" data-testid={`tickets-row-snippet-${t.id}`}>
                      {t.snippet ?? i18n.t("tickets.noPreview")}
                    </span>
                  </div>
                  <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-secondary">
                    <span
                      class="rounded-full bg-surface-sunken px-2 py-0.5"
                      data-testid={`tickets-row-status-${t.id}`}
                    >
                      {ticketChipLabel(i18n.t, "status", t.status)}
                    </span>
                    <span
                      class="rounded-full bg-surface-sunken px-2 py-0.5"
                      data-testid={`tickets-row-priority-${t.id}`}
                    >
                      {ticketChipLabel(i18n.t, "priority", t.priority)}
                    </span>
                    {/* Which side wrote. Rendered only when established —
                        `null` means nobody has, and an empty pill would read as
                        a classification rather than the absence of one. */}
                    <Show when={t.audience}>
                      <span
                        class="rounded-full bg-surface-sunken px-2 py-0.5 uppercase"
                        data-testid={`tickets-row-audience-${t.id}`}
                      >
                        {t.audience}
                      </span>
                    </Show>
                    {/* The owning desk. Only rendered when the ticket HAS one:
                        an org that files nothing by team must not carry an
                        empty pill on every row. */}
                    <Show when={t.team}>
                      <span
                        class="rounded-full bg-surface-sunken px-2 py-0.5"
                        data-testid={`tickets-row-team-${t.id}`}
                      >
                        {t.team}
                      </span>
                    </Show>
                    <Show when={t.category?.name}>
                      <span
                        class="rounded-full bg-surface-sunken px-2 py-0.5"
                        data-testid={`tickets-row-category-${t.id}`}
                      >
                        {t.category?.name}
                      </span>
                    </Show>
                    <Show when={slaLabelKey(t)}>
                      {(key) => (
                        <span
                          class="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-300"
                          data-testid={`tickets-row-sla-${t.id}`}
                        >
                          {i18n.t(key())}
                        </span>
                      )}
                    </Show>
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-3 text-right text-xs text-text-tertiary">
                  <Show when={t.assignee?.name}>
                    <span data-testid={`tickets-row-assignee-${t.id}`}>{t.assignee?.name}</span>
                  </Show>
                  <span
                    class="whitespace-nowrap tabular-nums text-text-tertiary"
                    title={t.lastMessageAt ?? undefined}
                    data-testid={`tickets-row-received-${t.id}`}
                  >
                    {formatReceived(t.lastMessageAt, i18n.locale())}
                  </span>
                </div>
              </div>
            )}
            renderCard={(t, index) => (
              <SwipeRow
                testid={`tickets-swipe-${t.id}`}
                class="border border-border"
                contentClass="p-3"
                actions={[
                  {
                    label: i18n.t("kernel.ticketAssign"),
                    tone: "accent",
                    onSelect: () => setAssignFor(t.id),
                  },
                  {
                    label: i18n.t("kernel.ticketClose"),
                    tone: "danger",
                    onSelect: () => setCloseFor(t.id),
                  },
                ]}
              >
                <div
                  class={cn("flex items-start gap-2", t.unread && "font-semibold")}
                  data-testid={`tickets-card-${t.id}`}
                  data-unread={t.unread ? "true" : "false"}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (selectMode()) toggleSelection(t.id)
                    else openTicket(t.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") openTicket(t.id)
                  }}
                >
                  <Show when={selectMode()}>
                    <label
                      data-testid={`tickets-card-checkbox-hit-${t.id}`}
                      class="-my-3 -ml-3 flex h-11 w-11 shrink-0 items-center justify-center"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        data-touch-dense
                        class="h-[22px] w-[22px] shrink-0"
                        data-testid={`tickets-card-checkbox-${t.id}`}
                        checked={!!ticketListStore.selection[t.id]}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelection(t.id)}
                      />
                    </label>
                  </Show>
                  <div class="flex min-w-0 flex-1 flex-col gap-1">
                    {/* Subject first: the card's identifying anchor (spec-responsive.md). */}
                    <span
                      class="text-[15px] leading-snug text-text"
                      data-testid={`tickets-card-subject-${t.id}`}
                    >
                      {t.subject}
                    </span>
                    {/* Line two: who wrote, which inbox, when. */}
                    <div class="flex items-center gap-1.5 text-xs text-text-secondary">
                      {/* The card is the VISIBLE markup below md, so it carries the
                          walk's entry point into the detail too: the row's copy of
                          this testid is the hidden twin there, and a driver
                          clicking it reaches nothing. */}
                      <span
                        class="shrink-0 text-text-tertiary"
                        data-testid={index === 0 ? "tickets-tab-detail" : undefined}
                      >
                        #{t.handle}
                      </span>
                      <span class="truncate" data-testid={`tickets-card-contact-${t.id}`}>
                        {t.contact?.name ?? t.contact?.email ?? i18n.t("tickets.noContact")}
                      </span>
                      {/* A separator belongs to the item it introduces, and is
                          rendered with it. A standalone one left a dangling
                          "·" at phone width whenever what followed it wrapped
                          to the next line, or was pushed to the far end of the
                          row by `ml-auto` and was never beside it at all. */}
                      <Show when={inboxName(t.sourceInboxId)}>
                        {(name) => (
                          <span class="truncate" data-testid={`tickets-card-inbox-${t.id}`}>
                            {"\u00b7 "}
                            {name()}
                          </span>
                        )}
                      </Show>
                      <span
                        class="ml-auto shrink-0 whitespace-nowrap tabular-nums text-text-tertiary"
                        data-testid={`tickets-card-activity-${t.id}`}
                      >
                        {formatReceived(t.lastMessageAt, i18n.locale())}
                      </span>
                    </div>
                    {/* Line three: the states an operator triages on. */}
                    <div
                      class="flex flex-wrap items-center gap-1.5 text-[11px]"
                      data-testid={`tickets-card-pills-${t.id}`}
                    >
                      <For
                        each={ticketPhonePills(t, {
                          hasAgentDraft: hasAgentDraft(t.id),
                          now: pillNow(),
                        })}
                      >
                        {(pill) => (
                          <span
                            class={cn("rounded-full px-2 py-0.5", TICKET_PILL_CLASS[pill])}
                            data-testid={`tickets-card-pill-${pill}-${t.id}`}
                          >
                            {i18n.t(
                              pill === "sla"
                                ? TICKET_SLA_LABEL_KEY[
                                    ticketSlaState(t, pillNow()) ?? "approaching"
                                  ]
                                : TICKET_PILL_LABEL_KEY[pill],
                            )}
                          </span>
                        )}
                      </For>
                      <span
                        class="rounded-full bg-surface-sunken px-2 py-0.5 text-text-secondary"
                        data-testid={`tickets-card-status-${t.id}`}
                      >
                        {ticketChipLabel(i18n.t, "status", t.status)}
                      </span>
                    </div>
                  </div>
                </div>
              </SwipeRow>
            )}
          />
        </Show>
        <Show when={ticketListStore.hasMore && !ticketListStore.searchUnavailable}>
          <div class="p-3 text-center">
            <button
              type="button"
              data-testid="tickets-load-more-button"
              class="rounded border border-border px-3 py-1.5 text-sm"
              onClick={() => loadTickets(api, true)}
            >
              {i18n.t("kernel.common.loadMore")}
            </button>
          </div>
        </Show>
      </div>

      <Show when={newTicketDialogOpen()}>
        <NewTicketDialog onClose={() => setNewTicketDialogOpen(false)} />
      </Show>

      {/* Swipe actions, as the surfaces a thumb can actually use: the same
          assignee picker and the same close flow (confirmation included) the
          desktop header offers, in a sheet instead of a popover. */}
      <Show when={assignFor()}>
        {(id) => (
          <TicketAssignSheet ticketId={id()} open={true} onClose={() => setAssignFor(null)} />
        )}
      </Show>
      <Show when={closeFor()}>
        {(id) => <TicketCloseDialog ticketId={id()} onClose={() => setCloseFor(null)} />}
      </Show>
    </div>
  )
}
