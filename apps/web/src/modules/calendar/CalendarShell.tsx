// SPDX-License-Identifier: FSL-1.1-ALv2
// Calendar shell — one component for the whole calendar surface: header (title, Today, ‹ ›,
// Day/Week/Month segmented switcher), the active view, and the event dialog. Both manifest tab
// types (month/week) render this shell; the segmented control switches views in place and the
// preference persists per user.

import { Plus } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  Match,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"
import { AgendaView } from "./AgendaView"
import {
  type CalendarConnectionDto,
  canRetryCalendarImport,
  retryCalendarImport,
} from "./calendar-api"
import {
  type CalendarView,
  calendarStore,
  createRequestedAt,
  focusedDate,
  isCalendarVisible,
  loadAccountsList,
  loadCalendarsList,
  loadEventsForWindow,
  loadPreferredView,
  persistPreferredView,
  setFocusedDate,
} from "./calendar-store"
import { startOfMonthGrid, startOfWeek, weekDays, weekStartsOn } from "./date-utils"
import { EventDialog } from "./EventDialog"
import { MonthView } from "./MonthView"
import { expandEvents } from "./rrule-expand"
import { TimeGridView } from "./TimeGridView"

export interface CalendarShellProps {
  initialView: CalendarView
  /** stable per-tab testid kept for the e2e journey */
  testId: string
  /** The tab's id. `event-<id>@<YYYY-MM-DD>` asks to open that event on that day. */
  entityId?: string
}

/** The event a calendar tab's id asks to open, as `open_app` writes it. */
export function eventRequestOf(entityId: string | undefined): { id: string; day: string } | null {
  const found = /^event-([^@]+)@(\d{4}-\d{2}-\d{2})?$/.exec(entityId ?? "")
  return found ? { id: found[1]!, day: found[2] ?? "" } : null
}

const VIEWS: CalendarView[] = ["day", "week", "month"]

export type CalendarHomeState =
  | { kind: "loading" }
  | { kind: "connect" }
  | { kind: "loadError"; message: string }
  | { kind: "error"; account: CalendarConnectionDto }
  | { kind: "syncing"; account: CalendarConnectionDto }
  | { kind: "empty" }

/**
 * What the calendar home shows when there is no calendar to display. "Connect" only when the
 * caller has no visible account at all: a connected account with zero calendars is either still
 * importing, failed (its error is shown), or has no calendar selected for sync.
 */
export function calendarHomeState(
  accounts: CalendarConnectionDto[],
  accountsLoaded: boolean,
  accountsError: string | null = null,
): CalendarHomeState {
  if (!accountsLoaded) return { kind: "loading" }
  if (accounts.length === 0 && accountsError) return { kind: "loadError", message: accountsError }
  if (accounts.length === 0) return { kind: "connect" }
  const failed = accounts.find((a) => a.status === "error" || a.status === "reauth-required")
  if (failed) return { kind: "error", account: failed }
  const syncing = accounts.find((a) => a.status === "pre-sync" || a.status === "syncing")
  if (syncing) return { kind: "syncing", account: syncing }
  return { kind: "empty" }
}

export const CalendarShell: Component<CalendarShellProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const firstDay = () => weekStartsOn(i18n.locale())
  const [view, setView] = createSignal<CalendarView>(loadPreferredView() ?? props.initialView)
  const [dialogOpen, setDialogOpen] = createSignal(false)
  const [editingEventId, setEditingEventId] = createSignal<string | null>(null)
  const [defaultStart, setDefaultStart] = createSignal<Date | undefined>(undefined)
  // At phone width the grid is replaced by an agenda; the view switcher and
  // the grid navigation belong to a surface that has columns to switch between.
  const phone = () => shellTier() === "phone"

  createEffect(() => {
    void loadCalendarsList(api)
    void loadAccountsList(api)
  })

  const homeState = createMemo(() =>
    calendarHomeState(
      calendarStore.accounts,
      calendarStore.accountsLoaded,
      calendarStore.accountsError,
    ),
  )
  const [retryQueued, setRetryQueued] = createSignal(false)
  const [retryError, setRetryError] = createSignal<string | null>(null)

  function openCalendarSettings(): void {
    openTab({
      type: "kernel:settings",
      entityId: "settings",
      label: i18n.t("calendar.connectionsSettingsLabel"),
      routePath: "/settings/apps/calendar",
    })
  }

  async function retryImport(accountId: string): Promise<void> {
    setRetryError(null)
    try {
      await retryCalendarImport(api, accountId)
    } catch (err) {
      setRetryQueued(false)
      setRetryError(err instanceof Error ? err.message : String(err))
      return
    }
    setRetryQueued(true)
    // The import runs as a background job: look again once it had time to finish.
    setTimeout(() => {
      void loadAccountsList(api)
      void loadCalendarsList(api)
    }, 5000)
  }

  // The agent opened one event: go to its day, and open it once that window has loaded.
  const [requestedEventId, setRequestedEventId] = createSignal<string | null>(null)
  createEffect(
    on(
      () => props.entityId,
      (entityId) => {
        const request = eventRequestOf(entityId)
        if (!request) return
        if (request.day) setFocusedDate(new Date(`${request.day}T12:00:00`))
        setRequestedEventId(request.id)
      },
    ),
  )
  createEffect(() => {
    const id = requestedEventId()
    if (!id || !calendarStore.events.some((e) => e.eventId === id)) return
    untrack(() => {
      setRequestedEventId(null)
      setEditingEventId(id)
      setDialogOpen(true)
    })
  })

  // Sidebar "+ Create" requests open the dialog here (cross-tree signal).
  createEffect(() => {
    if (createRequestedAt() === 0) return
    untrack(() => {
      setEditingEventId(null)
      setDefaultStart(new Date())
      setDialogOpen(true)
    })
  })

  const range = createMemo(() => {
    const d = focusedDate()
    // The phone agenda is a month of days regardless of the persisted view:
    // there is no grid to switch between, and a one day agenda on a phone is
    // a screen that ends before the week does.
    if (phone()) {
      const start = new Date(d.getFullYear(), d.getMonth(), 1)
      return { start, end: new Date(d.getFullYear(), d.getMonth() + 1, 1) }
    }
    if (view() === "day") {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate())
      return { start, end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) }
    }
    if (view() === "week") {
      const start = startOfWeek(d, firstDay())
      return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) }
    }
    const start = new Date(d.getFullYear(), d.getMonth(), 1)
    return { start, end: new Date(d.getFullYear(), d.getMonth() + 1, 1) }
  })

  // Fetch a padded window (±1 view span) so quick navigation doesn't flash empty.
  createEffect(() => {
    const { start, end } = range()
    const pad = end.getTime() - start.getTime()
    void loadEventsForWindow(
      api,
      new Date(start.getTime() - pad).toISOString(),
      new Date(end.getTime() + pad).toISOString(),
    )
  })

  const occurrences = createMemo(() => {
    const { start, end } = range()
    const visible = calendarStore.events.filter((e) => isCalendarVisible(e.calendarId))
    // Month view lays out the whole 6-week grid — expand over it, not just the month.
    if (view() === "month" && !phone()) {
      const gridStart = startOfMonthGrid(start.getFullYear(), start.getMonth(), firstDay())
      const gridEnd = new Date(
        gridStart.getFullYear(),
        gridStart.getMonth(),
        gridStart.getDate() + 42,
      )
      return expandEvents(visible, gridStart, gridEnd)
    }
    return expandEvents(visible, start, end)
  })

  const calendarColors = createMemo(() => {
    const map: Record<string, string> = {}
    for (const cal of calendarStore.calendars) map[cal.id] = cal.color ?? "#2563eb"
    return map
  })

  const editingEvent = createMemo(
    () => calendarStore.events.find((e) => e.eventId === editingEventId()) ?? null,
  )

  const title = createMemo(() => {
    const d = focusedDate()
    if (phone()) return d.toLocaleDateString(i18n.locale(), { month: "long", year: "numeric" })
    if (view() === "day") {
      return d.toLocaleDateString(i18n.locale(), {
        weekday: "long",
        day: "numeric",
        month: "long",
      })
    }
    if (view() === "week") {
      const start = startOfWeek(d, firstDay())
      const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
      const sameMonth = start.getMonth() === end.getMonth()
      const left = start.toLocaleDateString(i18n.locale(), {
        day: "numeric",
        month: sameMonth ? undefined : "short",
      })
      const right = end.toLocaleDateString(i18n.locale(), {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
      return `${left} - ${right}`
    }
    return d.toLocaleDateString(i18n.locale(), { month: "long", year: "numeric" })
  })

  function step(direction: 1 | -1): void {
    const d = focusedDate()
    if (phone()) {
      setFocusedDate(new Date(d.getFullYear(), d.getMonth() + direction, 1))
      return
    }
    if (view() === "day") {
      setFocusedDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + direction))
    } else if (view() === "week") {
      setFocusedDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7 * direction))
    } else {
      setFocusedDate(new Date(d.getFullYear(), d.getMonth() + direction, 1))
    }
  }

  function switchView(v: CalendarView): void {
    setView(v)
    persistPreferredView(v)
  }

  function openCreate(start?: Date): void {
    setEditingEventId(null)
    setDefaultStart(start ?? new Date())
    setDialogOpen(true)
  }

  function refresh(): void {
    const { start, end } = range()
    const pad = end.getTime() - start.getTime()
    void loadEventsForWindow(
      api,
      new Date(start.getTime() - pad).toISOString(),
      new Date(end.getTime() + pad).toISOString(),
    )
  }

  // `calendars` lists unticked calendars too (for Settings); the views show the ticked ones.
  const selectedCalendars = createMemo(() => calendarStore.calendars.filter((c) => c.selected))
  const hasAnyCalendars = createMemo(() => selectedCalendars().length > 0)

  return (
    <div class="flex h-full min-h-0 flex-col" data-testid={props.testId}>
      {/* Header */}
      <div
        class={`flex items-center border-b border-border px-3 py-2 ${phone() ? "gap-2" : "gap-3"}`}
      >
        <Button variant="ghost" size="sm" onClick={() => setFocusedDate(new Date())}>
          {i18n.t("calendar.today")}
        </Button>
        <div class="flex items-center">
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-full text-text-secondary hover:bg-[color-mix(in_srgb,var(--color-border)_50%,transparent)]"
            aria-label={i18n.t("calendar.previous")}
            data-testid="calendar-nav-prev"
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-full text-text-secondary hover:bg-[color-mix(in_srgb,var(--color-border)_50%,transparent)]"
            aria-label={i18n.t("calendar.next")}
            data-testid="calendar-nav-next"
            onClick={() => step(1)}
          >
            ›
          </button>
        </div>
        <h2
          data-testid="calendar-title"
          class="min-w-0 flex-1 truncate text-base font-semibold capitalize tabular-nums text-text"
        >
          {title()}
        </h2>
        {/* Segmented view switcher: desktop and tablet only, since the phone
            renders one agenda rather than three grids. */}
        <div
          classList={{ hidden: phone() }}
          class="flex rounded-lg border border-border-subtle bg-[color-mix(in_srgb,var(--color-border)_25%,transparent)] p-0.5"
          data-testid="calendar-view-switcher"
          role="tablist"
        >
          {VIEWS.map((v) => (
            <button
              type="button"
              role="tab"
              aria-selected={view() === v}
              class={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-all ${
                view() === v
                  ? "bg-bg text-text shadow-[0_1px_2px_rgba(0,0,0,0.1)]"
                  : "text-text-secondary hover:text-text"
              }`}
              data-testid={`calendar-view-${v}`}
              onClick={() => switchView(v)}
            >
              {i18n.t(`calendar.view.${v}`)}
            </button>
          ))}
        </div>
        {/* At phone width the labelled button took the room the month title
            needed ("Sept…" at 390px): there it is a "+" with the same label
            for assistive tech. */}
        <Show
          when={phone()}
          fallback={
            <Button size="sm" data-testid="calendar-new-event" onClick={() => openCreate()}>
              {i18n.t("calendar.newEvent")}
            </Button>
          }
        >
          <Button
            size="sm"
            class="h-8 w-8 shrink-0 px-0"
            data-testid="calendar-new-event"
            aria-label={i18n.t("calendar.newEvent")}
            onClick={() => openCreate()}
          >
            <Plus size={16} aria-hidden="true" />
          </Button>
        </Show>
      </div>

      <Show
        when={hasAnyCalendars()}
        fallback={
          <div
            class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
            data-testid="calendar-empty-state"
          >
            <Switch>
              <Match when={homeState().kind === "connect"}>
                <p class="text-sm text-text-secondary">{i18n.t("calendar.noCalendarsYet")}</p>
                <Button
                  fullWidth
                  data-testid="calendar-empty-connect"
                  onClick={openCalendarSettings}
                >
                  {i18n.t("calendar.connectCta")}
                </Button>
              </Match>
              <Match
                when={(() => {
                  const st = homeState()
                  return st.kind === "loadError" ? st.message : undefined
                })()}
              >
                {(message) => (
                  <>
                    <p
                      class="text-sm text-error break-words"
                      data-testid="calendar-accounts-load-error"
                    >
                      {i18n.t("calendar.accountsLoadFailed", { message: message() })}
                    </p>
                    <Button
                      variant="outline"
                      data-testid="calendar-open-settings"
                      onClick={openCalendarSettings}
                    >
                      {i18n.t("calendar.openSettings")}
                    </Button>
                  </>
                )}
              </Match>
              <Match
                when={(() => {
                  const st = homeState()
                  return st.kind === "error" ? st.account : undefined
                })()}
              >
                {(account) => (
                  <div
                    class="flex max-w-md flex-col items-center gap-3"
                    data-testid="calendar-import-error"
                  >
                    <p class="text-sm font-medium text-text">
                      {i18n.t("calendar.importFailed", { email: account().identifier })}
                    </p>
                    <p
                      class="text-xs text-error break-words"
                      data-testid="calendar-import-error-message"
                    >
                      {account().status === "reauth-required"
                        ? i18n.t("calendar.reauthRequired")
                        : (account().lastSyncError ?? i18n.t("calendar.importFailedNoDetail"))}
                    </p>
                    <Show when={retryQueued()}>
                      <p class="text-xs text-text-secondary" data-testid="calendar-retry-queued">
                        {i18n.t("calendar.retryQueued")}
                      </p>
                    </Show>
                    <Show when={retryError()}>
                      {(message) => (
                        <p
                          class="text-xs text-error break-words"
                          data-testid="calendar-import-retry-error"
                        >
                          {message()}
                        </p>
                      )}
                    </Show>
                    <div class="flex flex-wrap gap-2">
                      <Show
                        when={account().status === "error" && canRetryCalendarImport(account())}
                      >
                        <Button
                          data-testid="calendar-import-retry"
                          onClick={() => void retryImport(account().id)}
                        >
                          {i18n.t("calendar.retryImport")}
                        </Button>
                      </Show>
                      <Button
                        variant="outline"
                        data-testid="calendar-open-settings"
                        onClick={openCalendarSettings}
                      >
                        {i18n.t("calendar.openSettings")}
                      </Button>
                    </div>
                  </div>
                )}
              </Match>
              <Match when={homeState().kind === "syncing"}>
                <p class="text-sm text-text-secondary" data-testid="calendar-syncing">
                  {i18n.t("calendar.importInProgress")}
                </p>
              </Match>
              <Match when={homeState().kind === "empty"}>
                <p class="text-sm text-text-secondary" data-testid="calendar-none-selected">
                  {i18n.t("calendar.noCalendarSelected")}
                </p>
                <Button
                  fullWidth
                  variant="outline"
                  data-testid="calendar-open-settings"
                  onClick={openCalendarSettings}
                >
                  {i18n.t("calendar.openSettings")}
                </Button>
              </Match>
            </Switch>
          </div>
        }
      >
        <Switch>
          <Match when={phone()}>
            <AgendaView
              occurrences={occurrences()}
              calendarColors={calendarColors()}
              focusedDate={focusedDate()}
              stripDays={weekDays(startOfWeek(focusedDate(), firstDay()))}
              locale={i18n.locale()}
              allDayLabel={i18n.t("calendar.allDay")}
              emptyLabel={i18n.t("kernel.calendarAgendaEmpty")}
              onSelectEvent={(eventId) => {
                setEditingEventId(eventId)
                setDialogOpen(true)
              }}
              onSelectDay={(day) => setFocusedDate(new Date(day))}
            />
          </Match>
          <Match when={!phone() && view() === "month"}>
            <MonthView
              year={focusedDate().getFullYear()}
              month={focusedDate().getMonth()}
              occurrences={occurrences()}
              calendarColors={calendarColors()}
              onSelectEvent={(eventId) => {
                setEditingEventId(eventId)
                setDialogOpen(true)
              }}
              onSelectDay={(day) => openCreate(new Date(day.setHours(9, 0, 0, 0)))}
              onFocusDay={(day) => {
                setFocusedDate(new Date(day))
                switchView("day")
              }}
            />
          </Match>
          <Match when={!phone() && view() !== "month"}>
            <TimeGridView
              rangeStart={
                view() === "week" ? startOfWeek(focusedDate(), firstDay()) : focusedDate()
              }
              dayCount={view() === "week" ? 7 : 1}
              occurrences={occurrences()}
              calendarColors={calendarColors()}
              onSelectEvent={(eventId) => {
                setEditingEventId(eventId)
                setDialogOpen(true)
              }}
              onSelectSlot={(start) => openCreate(start)}
            />
          </Match>
        </Switch>
      </Show>

      <EventDialog
        open={dialogOpen()}
        onOpenChange={setDialogOpen}
        calendars={selectedCalendars()}
        event={editingEvent()}
        defaultStart={defaultStart()}
        onSaved={refresh}
      />
    </div>
  )
}
