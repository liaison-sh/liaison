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
  For,
  Match,
  on,
  Show,
  Switch,
  untrack,
} from "solid-js"
import { onEntityChange } from "~/framework/entity-changes"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { AgendaView } from "./AgendaView"
import {
  type CalendarConnectionDto,
  type CalendarEventDto,
  type CalendarPoint,
  canRetryCalendarImport,
  retryCalendarImport,
  type SeriesScope,
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
  patchEventLocally,
  persistPreferredView,
  reloadCurrentWindow,
  setFocusedDate,
  updateCalendarEvent,
} from "./calendar-store"
import { startOfMonthGrid, startOfWeek, weekDays, weekStartsOn } from "./date-utils"
import { addDays, nextHalfHour, toLocalDateValue } from "./event-form"
import { openEventTab, openNewEventTab } from "./event-tabs"
import { MonthView } from "./MonthView"
import { QuickCreate, type QuickCreateRequest } from "./QuickCreate"
import { expandEvents } from "./rrule-expand"
import {
  occurrenceView,
  scopeTarget,
  seriesContextOf,
  seriesTimes,
  type TimesPayload,
} from "./series-edit"
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
  const [quick, setQuick] = createSignal<QuickCreateRequest | null>(null)
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
      selectEvent(id)
    })
  })

  // Sidebar "+ Create" requests open a new event tab (cross-tree signal). Only a request made
  // while this shell is mounted counts: the effect used to fire on the shell's first run too, so
  // reopening the calendar tab reopened the create form unasked.
  createEffect(
    on(
      createRequestedAt,
      (at) => {
        if (at !== 0) untrack(() => openCreate())
      },
      { defer: true },
    ),
  )

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

  /** A new event: the quick-create card at `anchor` when the grid was clicked, else the full tab. */
  function openCreate(start?: Date, anchor?: { x: number; y: number }, allDay = false): void {
    const from = start ?? nextHalfHour()
    if (!anchor || phone()) {
      openNewEventTab({ start: from, allDay }, i18n.t("calendar.newEvent"))
      return
    }
    const end = allDay
      ? new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1)
      : new Date(from.getTime() + 30 * 60_000)
    setQuick({ start: from, end, allDay, x: anchor.x, y: anchor.y })
  }

  /** An event the grid may drag: a timed event in the week and day grids, any event to another
   * day in the month (an all-day one keeps its length in days). A recurring meeting asks which
   * occurrences move once dropped. */
  function canDrag(eventId: string): boolean {
    const e = calendarStore.events.find((x) => x.eventId === eventId)
    return !!e && !!(e.start?.dateTime || e.start?.date)
  }

  /** A drop on a recurring meeting waits here for "this / following / all". */
  const [pendingMove, setPendingMove] = createSignal<{
    event: CalendarEventDto
    occurrence: CalendarPoint | null
    times: TimesPayload
  } | null>(null)

  /** Move or resize: painted at once, saved behind it, put back with a note if refused, and
   * undoable for a few seconds once saved. A recurring meeting asks which occurrences first. */
  async function moveEvent(
    eventId: string,
    start: Date,
    end: Date,
    occurrence?: CalendarPoint | null,
  ): Promise<void> {
    const event = calendarStore.events.find((e) => e.eventId === eventId)
    if (!event) return
    const times = { start: start.toISOString(), end: end.toISOString(), allDay: false }
    if (seriesContextOf(event, occurrence ?? null)) {
      setPendingMove({ event, occurrence: occurrence ?? null, times })
      return
    }
    await moveOneOff(event, times)
  }

  async function moveOneOff(event: CalendarEventDto, times: TimesPayload): Promise<void> {
    const eventId = event.eventId
    const point = (template: CalendarPoint | null, value: string): CalendarPoint =>
      times.allDay
        ? { date: value }
        : { dateTime: value, ...(template?.timeZone ? { timeZone: template.timeZone } : {}) }
    const before = patchEventLocally(eventId, {
      start: point(event.start, times.start),
      end: point(event.end, times.end),
    })
    if (!before) return
    try {
      await updateCalendarEvent(api, { eventId, ...times })
    } catch (err) {
      patchEventLocally(eventId, before)
      addToast({
        message: i18n.t("calendar.moveFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
        type: "error",
      })
      return
    }
    void reloadCurrentWindow(api)
    addToast({
      message: i18n.t("calendar.eventMoved"),
      type: "info",
      durationMs: 8000,
      action: {
        label: i18n.t("calendar.undo"),
        onClick: () => {
          const back = times.allDay
            ? { start: before.start?.date, end: before.end?.date }
            : { start: before.start?.dateTime, end: before.end?.dateTime }
          if (!back.start || !back.end) return
          patchEventLocally(eventId, before)
          void updateCalendarEvent(api, {
            eventId,
            start: back.start,
            end: back.end,
            allDay: times.allDay,
          })
            .then(() => reloadCurrentWindow(api))
            .catch(() => reloadCurrentWindow(api))
        },
      },
    })
  }

  /** The drop on a recurring meeting, for the occurrences chosen. */
  async function moveSeries(scope: SeriesScope): Promise<void> {
    const move = pendingMove()
    setPendingMove(null)
    if (!move) return
    const ctx = seriesContextOf(move.event, move.occurrence)
    if (!ctx) return
    const target = scopeTarget(move.event, ctx, scope)
    const timeFields =
      scope === "series"
        ? ctx.kind === "master"
          ? seriesTimes(move.event, ctx.occurrence, move.times)
          : move.times
        : move.times
    try {
      await updateCalendarEvent(api, {
        eventId: target.eventId,
        scope: target.scope,
        ...(target.occurrenceStart ? { occurrenceStart: target.occurrenceStart } : {}),
        ...timeFields,
      })
      addToast({ message: i18n.t("calendar.eventMoved"), type: "info" })
    } catch (err) {
      addToast({
        message: i18n.t("calendar.moveFailed", {
          message: err instanceof Error ? err.message : String(err),
        }),
        type: "error",
      })
    }
    void reloadCurrentWindow(api)
  }

  /** A month drop: the same time on another day; an all-day event keeps its length in days. */
  function moveEventToDay(eventId: string, day: Date, occurrence?: CalendarPoint | null): void {
    const event = calendarStore.events.find((e) => e.eventId === eventId)
    if (!event) return
    const ctx = seriesContextOf(event, occurrence ?? null)
    const shown = ctx?.kind === "master" ? occurrenceView(event, ctx.occurrence) : event
    if (shown.start?.date && shown.end?.date) {
      const from = shown.start.date
      const target = toLocalDateValue(day)
      if (target === from) return
      const days = Math.round(
        (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
      )
      const times = { start: target, end: addDays(shown.end.date, days), allDay: true }
      if (ctx) setPendingMove({ event, occurrence: occurrence ?? null, times })
      else void moveOneOff(event, times)
      return
    }
    if (!shown.start?.dateTime || !shown.end?.dateTime) return
    const start = new Date(shown.start.dateTime)
    const end = new Date(shown.end.dateTime)
    const next = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      start.getHours(),
      start.getMinutes(),
    )
    if (next.getTime() === start.getTime()) return
    void moveEvent(
      eventId,
      next,
      new Date(next.getTime() + (end.getTime() - start.getTime())),
      occurrence,
    )
  }

  function selectEvent(eventId: string, start?: CalendarPoint | null): void {
    const event = calendarStore.events.find((e) => e.eventId === eventId)
    if (event) openEventTab(event, i18n.t("calendar.untitledEvent"), start)
  }

  function refresh(): void {
    void reloadCurrentWindow(api)
  }

  // Live: a sync page, a push result, an agent's or a teammate's write announces
  // `calendar/event:changed` (or another event entity change); the open window refetches once per
  // burst. A reconnect's resync arrives here too, so whatever was missed while offline heals.
  onEntityChange(
    ["calendar:event", "calendar:calendar", "calendar:account"],
    (events) => {
      if (events.some((e) => e.resync || e.entity !== "event")) {
        void loadCalendarsList(api)
        void loadAccountsList(api)
      }
      refresh()
    },
    { debounceMs: 400, maxWaitMs: 2000 },
  )

  // `calendars` lists unticked calendars too (for Settings); the views show the ticked ones.
  const selectedCalendars = createMemo(() => calendarStore.calendars.filter((c) => c.selected))
  const hasAnyCalendars = createMemo(() => selectedCalendars().length > 0)

  return (
    <div
      class="flex h-full min-h-0 flex-col"
      data-testid={props.testId}
      aria-busy={calendarStore.loading}
    >
      {/* Header */}
      <div
        class={`relative flex items-center border-b border-border px-3 py-2 ${phone() ? "gap-2" : "gap-3"}`}
      >
        {/* Loading: a thin bar over the header's bottom edge, only while a window with nothing
            cached is on its way (a cached window paints at once and refreshes silently). It
            overlays the border, so nothing below moves. */}
        <Show when={calendarStore.loading}>
          <div
            class="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden"
            aria-hidden="true"
          >
            <div
              class="calendar-loading-bar absolute inset-y-0 w-1/3 bg-[color-mix(in_srgb,var(--color-accent)_45%,transparent)]"
              data-testid="calendar-loading"
            />
          </div>
        </Show>
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

      <Show when={calendarStore.error}>
        {(message) => (
          <div
            class="flex items-center gap-3 border-b border-border-subtle bg-[color-mix(in_srgb,var(--color-border)_20%,transparent)] px-3 py-1.5 text-xs text-text-secondary"
            role="status"
            data-testid="calendar-events-error"
          >
            <span class="min-w-0 flex-1 truncate" title={message()}>
              {i18n.t("calendar.eventsLoadFailed")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              data-testid="calendar-events-retry"
              onClick={() => {
                void loadCalendarsList(api)
                refresh()
              }}
            >
              {i18n.t("calendar.retry")}
            </Button>
          </div>
        )}
      </Show>

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
                <Button data-testid="calendar-empty-connect" onClick={openCalendarSettings}>
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
              onSelectEvent={selectEvent}
              onSelectDay={(day) => setFocusedDate(new Date(day))}
            />
          </Match>
          <Match when={!phone() && view() === "month"}>
            <MonthView
              year={focusedDate().getFullYear()}
              month={focusedDate().getMonth()}
              occurrences={occurrences()}
              calendarColors={calendarColors()}
              onSelectEvent={selectEvent}
              onSelectDay={(day, anchor) => openCreate(day, anchor, true)}
              canDrag={canDrag}
              onMoveEventToDay={moveEventToDay}
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
              onSelectEvent={selectEvent}
              onSelectSlot={(start, anchor) => openCreate(start, anchor)}
              onCreateRange={(start, end, anchor) =>
                setQuick({ start, end, allDay: false, x: anchor.x, y: anchor.y })
              }
              onMoveEvent={(eventId, start, end, occurrence) =>
                void moveEvent(eventId, start, end, occurrence)
              }
              canDrag={canDrag}
            />
          </Match>
        </Switch>
      </Show>

      <Dialog open={pendingMove() !== null} onOpenChange={(open) => !open && setPendingMove(null)}>
        <Dialog.Content>
          <Dialog.Title>{i18n.t("calendar.scopeMoveTitle")}</Dialog.Title>
          <div class="mt-2 flex flex-col gap-1" data-testid="move-scope-dialog">
            <For each={["occurrence", "following", "series"] as SeriesScope[]}>
              {(scope) => (
                <Button
                  variant="outline"
                  onClick={() => void moveSeries(scope)}
                  data-testid={`move-scope-${scope}`}
                >
                  {i18n.t(`calendar.scope.${scope}`)}
                </Button>
              )}
            </For>
          </div>
          <div class="mt-4 flex justify-end">
            <Button
              variant="ghost"
              onClick={() => setPendingMove(null)}
              data-testid="move-scope-cancel"
            >
              {i18n.t("calendar.cancel")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>

      <Show when={quick()}>
        {(request) => (
          <QuickCreate
            request={request()}
            calendars={selectedCalendars()}
            onClose={() => setQuick(null)}
          />
        )}
      </Show>
    </div>
  )
}
