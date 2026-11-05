// SPDX-License-Identifier: FSL-1.1-ALv2
// Client-side recurrence expansion: turns the `list_events` rows of the fetched window (plain
// events, recurring masters, their exception rows) into the occurrences the month/week/day grids
// render, without a server round-trip per view change. The rule arithmetic lives in
// @liaison/shared (`expandRecurrence`), the same code the API uses, so both sides agree on a
// series' occurrences. A rule outside the supported subset is flagged "complex" and shows the
// master's own occurrence only (editing disabled for those in the dialog).
import { calendarPointToDate, expandRecurrence, utcDateString } from "@liaison/shared"
import type { CalendarEventDto, CalendarPoint } from "./calendar-api"

export type CalendarEventPoint = CalendarPoint

/**
 * CalendarEventLike — the input shape the expander needs. Aliased to the API DTO so there is a
 * SINGLE event type across the module (the two were structurally identical copy-paste twins;
 * unifying removes the `as any` casts at the call sites). `list_events` returns `CalendarEventDto`
 * with all these fields populated.
 */
export type CalendarEventLike = CalendarEventDto

export interface ExpandedOccurrence {
  eventId: string
  calendarId: string
  title: string | null
  start: CalendarEventPoint
  end: CalendarEventPoint
  allDay: boolean
  recurrenceComplex: boolean
}

function toDate(point: CalendarEventPoint | null | undefined): Date | null {
  return calendarPointToDate(point)
}

function overlaps(e: CalendarEventLike, windowStart: Date, windowEnd: Date): boolean {
  const start = toDate(e.start)
  const end = toDate(e.end)
  return !!start && !!end && start < windowEnd && end > windowStart
}

function ownOccurrence(e: CalendarEventLike, recurrenceComplex: boolean): ExpandedOccurrence {
  return {
    eventId: e.eventId,
    calendarId: e.calendarId,
    title: e.title,
    start: e.start!,
    end: e.end!,
    allDay: e.allDay,
    recurrenceComplex,
  }
}

/** The id a series' exception rows name in `recurringEventId`: Google's id of the master. */
function seriesKey(master: CalendarEventLike): string {
  return master.googleEventId ?? master.eventId
}

/**
 * expandEvents — given the fetched events for the window (masters, exceptions, plain events),
 * returns the flat list of occurrences to render: plain events pass through when they overlap
 * [windowStart, windowEnd]; a recurring master expands into its occurrences in the window.
 * Exceptions (Google rows with `recurringEventId` = the master's Google id) replace the
 * occurrence at their `originalStartTime`: a cancelled one removes it, a moved one shows at its
 * own time only (also when only one of its two slots is in the window).
 */
export function expandEvents(
  events: CalendarEventLike[],
  windowStart: Date,
  windowEnd: Date,
): ExpandedOccurrence[] {
  const masters = events.filter(
    (e) => !e.recurringEventId && e.recurrence && e.recurrence.length > 0,
  )
  const exceptionsBySeries = new Map<string, CalendarEventLike[]>()
  for (const e of events) {
    if (e.recurringEventId) {
      const list = exceptionsBySeries.get(e.recurringEventId) ?? []
      list.push(e)
      exceptionsBySeries.set(e.recurringEventId, list)
    }
  }

  const out: ExpandedOccurrence[] = []
  for (const e of events) {
    if (e.recurringEventId || (e.recurrence && e.recurrence.length > 0)) continue
    if (overlaps(e, windowStart, windowEnd)) out.push(ownOccurrence(e, false))
  }

  for (const master of masters) {
    out.push(
      ...expandMaster(
        master,
        exceptionsBySeries.get(seriesKey(master)) ?? [],
        windowStart,
        windowEnd,
      ),
    )
  }

  // An exception is a real instance with its own time: one whose master is not in the fetched
  // set (the server leaves out series with no occurrence in the window) still shows when moved
  // into the window.
  const listedSeries = new Set(masters.map(seriesKey))
  for (const [series, exceptions] of exceptionsBySeries) {
    if (listedSeries.has(series)) continue
    for (const ex of exceptions) {
      if (ex.status !== "cancelled" && overlaps(ex, windowStart, windowEnd)) {
        out.push(ownOccurrence(ex, false))
      }
    }
  }

  return out
}

function expandMaster(
  master: CalendarEventLike,
  exceptions: CalendarEventLike[],
  windowStart: Date,
  windowEnd: Date,
): ExpandedOccurrence[] {
  const out: ExpandedOccurrence[] = []
  const replaced = new Set<number>()
  for (const ex of exceptions) {
    const original = toDate(ex.originalStartTime)
    if (original) replaced.add(original.getTime())
    if (ex.status !== "cancelled" && overlaps(ex, windowStart, windowEnd)) {
      out.push(ownOccurrence(ex, false))
    }
  }

  const { complex, occurrences } = expandRecurrence(master, windowStart, windowEnd)
  if (complex) {
    if (overlaps(master, windowStart, windowEnd)) out.push(ownOccurrence(master, true))
    return out
  }

  for (const occ of occurrences) {
    if (replaced.has(occ.start.getTime())) continue
    out.push({
      eventId: master.eventId,
      calendarId: master.calendarId,
      title: master.title,
      start: master.allDay
        ? { date: utcDateString(occ.start) }
        : { ...master.start, dateTime: occ.start.toISOString() },
      end: master.allDay
        ? { date: utcDateString(occ.end) }
        : { ...master.end, dateTime: occ.end.toISOString() },
      allDay: master.allDay,
      recurrenceComplex: false,
    })
  }
  return out
}
