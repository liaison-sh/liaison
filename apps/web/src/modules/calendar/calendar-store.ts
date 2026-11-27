// SPDX-License-Identifier: FSL-1.1-ALv2
// Calendar module store — fetches calendars + events for the visible window, tracks per-user
// calendar toggles (persisted in localStorage — lightweight, no server round-trip needed for a
// pure display preference).
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import {
  createEvent as apiCreateEvent,
  deleteEvent as apiDeleteEvent,
  updateEvent as apiUpdateEvent,
  type CalendarConnectionDto,
  type CalendarEventDto,
  type CalendarListItem,
  type CreateEventInput,
  type DeleteEventOptions,
  listCalendarConnections,
  listCalendars,
  listEvents,
  type UpdateEventInput,
} from "./calendar-api"

const HIDDEN_CALENDARS_KEY = "liaison.calendar.hiddenCalendarIds"
const VIEW_KEY = "liaison.calendar.view"

export type CalendarView = "day" | "week" | "month"

export function loadPreferredView(): CalendarView | null {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (raw === "day" || raw === "week" || raw === "month") return raw
  } catch {
    // ignore — caller falls back to the tab's initial view
  }
  return null
}

export function persistPreferredView(view: CalendarView): void {
  try {
    localStorage.setItem(VIEW_KEY, view)
  } catch {
    // best-effort
  }
}

function loadHiddenCalendarIds(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_CALENDARS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as string[]
    return new Set(parsed)
  } catch {
    return new Set()
  }
}

function persistHiddenCalendarIds(ids: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify([...ids]))
  } catch {
    // best-effort — a private-browsing localStorage failure shouldn't crash the calendar.
  }
}

interface CalendarStoreState {
  calendars: CalendarListItem[]
  /** Connected Google accounts visible to the caller (their own personal ones + org ones). */
  accounts: CalendarConnectionDto[]
  /** False until the first accounts fetch answers: the home screen waits on it before
   * offering "Connect", so a connected user never sees the connect prompt flash. */
  accountsLoaded: boolean
  /** Why the last accounts fetch failed, else null. A failed fetch is not "no account": the
   * home must not offer "Connect" for an account it merely could not read. */
  accountsError: string | null
  events: CalendarEventDto[]
  hiddenCalendarIds: string[]
  loading: boolean
  error: string | null
}

/**
 * Cross-tree UI coordination signals — the sidebar (rendered in the shell's sidebar slot,
 * a separate component tree from the tab) drives the active view: mini-month click focuses a
 * date, "+ Create" opens the event dialog. The shell tab subscribes to both.
 */
export const [focusedDate, setFocusedDate] = createSignal<Date>(new Date())
export const [createRequestedAt, setCreateRequestedAt] = createSignal<number>(0)

export function requestCreateEvent(): void {
  setCreateRequestedAt(Date.now())
}

export const [calendarStore, setCalendarStore] = createStore<CalendarStoreState>({
  calendars: [],
  accounts: [],
  accountsLoaded: false,
  accountsError: null,
  events: [],
  hiddenCalendarIds: [...loadHiddenCalendarIds()],
  loading: false,
  error: null,
})

export async function loadCalendarsList(api: ApiClient): Promise<void> {
  try {
    setCalendarStore("calendars", await listCalendars(api))
  } catch (err) {
    // Shown by the events banner: a failed calendar list leaves the previous one in place.
    setCalendarStore("error", err instanceof Error ? err.message : String(err))
  }
}

export async function loadAccountsList(api: ApiClient): Promise<void> {
  try {
    setCalendarStore("accounts", await listCalendarConnections(api))
    setCalendarStore("accountsError", null)
  } catch (err) {
    setCalendarStore("accountsError", err instanceof Error ? err.message : String(err))
  } finally {
    setCalendarStore("accountsLoaded", true)
  }
}

/** How many fetched windows are kept for instant back-and-forth navigation. */
const WINDOW_CACHE_SIZE = 12

/** The events of the windows fetched this session, most recent last. A cached window paints at
 * once and is refetched behind it (stale while revalidate), so navigating back never flashes
 * empty and never shows stale data for longer than one fetch. */
const windowCache = new Map<string, CalendarEventDto[]>()
/** The window the views asked for last: only its answer may write the store. */
let latestWindowKey: string | null = null
let latestRequestId = 0

function windowKey(timeMin: string, timeMax: string): string {
  return `${timeMin}|${timeMax}`
}

function rememberWindow(key: string, events: CalendarEventDto[]): void {
  windowCache.delete(key)
  windowCache.set(key, events)
  while (windowCache.size > WINDOW_CACHE_SIZE) {
    const oldest = windowCache.keys().next().value
    if (oldest === undefined) break
    windowCache.delete(oldest)
  }
}

/** Forget every fetched window (a change arrived): the next read of each goes to the server. */
export function invalidateEventWindows(): void {
  windowCache.clear()
}

/**
 * loadEventsForWindow — the events of one window. A window already fetched paints from the
 * cache at once; the fetch still runs and replaces it. Only the answer to the LATEST request
 * writes the store, so two quick "next" clicks cannot leave the older, slower week on screen.
 * While a window with no cached copy loads, the previous events stay (the views cut them to
 * their own range) and `loading` is set; a failed fetch sets `error` and keeps what is shown.
 */
export async function loadEventsForWindow(
  api: ApiClient,
  timeMin: string,
  timeMax: string,
): Promise<void> {
  const key = windowKey(timeMin, timeMax)
  const requestId = ++latestRequestId
  latestWindowKey = key
  const cached = windowCache.get(key)
  if (cached) setCalendarStore("events", cached)
  else setCalendarStore("loading", true)
  try {
    const events = await listEvents(api, { timeMin, timeMax })
    rememberWindow(key, events)
    if (requestId !== latestRequestId) return
    setCalendarStore({ events, error: null })
  } catch (err) {
    if (requestId !== latestRequestId) return
    setCalendarStore("error", err instanceof Error ? err.message : String(err))
  } finally {
    if (requestId === latestRequestId) setCalendarStore("loading", false)
  }
}

/** Refetch the window the views show, after a change (a sync, a save, a teammate's edit). */
export async function reloadCurrentWindow(api: ApiClient): Promise<void> {
  if (!latestWindowKey) return
  invalidateEventWindows()
  const [timeMin, timeMax] = latestWindowKey.split("|") as [string, string]
  await loadEventsForWindow(api, timeMin, timeMax)
}

export function toggleCalendarVisibility(calendarId: string): void {
  const hidden = new Set(calendarStore.hiddenCalendarIds)
  if (hidden.has(calendarId)) hidden.delete(calendarId)
  else hidden.add(calendarId)
  setCalendarStore("hiddenCalendarIds", [...hidden])
  persistHiddenCalendarIds(hidden)
}

export function isCalendarVisible(calendarId: string): boolean {
  return !calendarStore.hiddenCalendarIds.includes(calendarId)
}

/**
 * Changes an event in the store at once (an optimistic move or resize: painted in the same frame
 * as the drop) and answers what it was, so a refusal can put it back.
 */
export function patchEventLocally(
  eventId: string,
  patch: Pick<CalendarEventDto, "start" | "end">,
): Pick<CalendarEventDto, "start" | "end"> | null {
  const current = calendarStore.events.find((e) => e.eventId === eventId)
  if (!current) return null
  const before = { start: current.start, end: current.end }
  setCalendarStore("events", (e) => e.eventId === eventId, patch)
  return before
}

export async function createCalendarEvent(api: ApiClient, input: CreateEventInput): Promise<void> {
  await apiCreateEvent(api, input)
}

export async function updateCalendarEvent(api: ApiClient, input: UpdateEventInput): Promise<void> {
  await apiUpdateEvent(api, input)
}

export async function deleteCalendarEvent(
  api: ApiClient,
  eventId: string,
  options: DeleteEventOptions = {},
): Promise<void> {
  await apiDeleteEvent(api, eventId, options)
}

/**
 * resetCalendarStore — clears all session-scoped store state on logout/session teardown (registered
 * below via onSessionTeardown, like every other module store). Hidden-calendar prefs are a
 * per-user localStorage display preference, so they are re-read from storage rather than wiped.
 */
export function resetCalendarStore(): void {
  invalidateEventWindows()
  latestWindowKey = null
  latestRequestId++
  setCalendarStore({
    calendars: [],
    accounts: [],
    accountsLoaded: false,
    accountsError: null,
    events: [],
    hiddenCalendarIds: [...loadHiddenCalendarIds()],
    loading: false,
    error: null,
  })
}

onSessionTeardown(resetCalendarStore)
