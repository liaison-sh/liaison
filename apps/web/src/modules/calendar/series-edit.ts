// SPDX-License-Identifier: FSL-1.1-ALv2
// Editing one occurrence of a recurring meeting, this and the following ones, or the whole
// series: which occurrence a tab edits, how it shows, and what each choice sends. Kept out of the
// event tab so the time arithmetic is unit-tested in one place.
import type { CalendarEventDto, CalendarPoint, SeriesScope } from "./calendar-api"

/** How an event belongs to a recurring meeting, from the tab that opened it. */
export type SeriesContext =
  /** The series itself, opened at one of its occurrences (its original start). */
  | { kind: "master"; occurrence: CalendarPoint }
  /** An occurrence already edited, with its own row. */
  | { kind: "exception" }
  | null

export function isRecurringMaster(event: CalendarEventDto | null | undefined): boolean {
  return !!event && !event.recurringEventId && (event.recurrence?.length ?? 0) > 0
}

export function seriesContextOf(
  event: CalendarEventDto | null | undefined,
  occurrence: CalendarPoint | null,
): SeriesContext {
  if (!event) return null
  if (event.recurringEventId) return { kind: "exception" }
  if (!isRecurringMaster(event)) return null
  // Opened without an occurrence (a link to the series): its first one.
  const first = occurrence ?? event.start
  return first ? { kind: "master", occurrence: first } : null
}

function pointMs(point: CalendarPoint | null | undefined): number | null {
  if (point?.dateTime) return new Date(point.dateTime).getTime()
  if (point?.date) return new Date(`${point.date}T00:00:00Z`).getTime()
  return null
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const DAY_MS = 86_400_000

/** The series shown at one occurrence: the master's fields at that occurrence's time. */
export function occurrenceView(
  master: CalendarEventDto,
  occurrence: CalendarPoint,
): CalendarEventDto {
  const startMs = pointMs(master.start)
  const endMs = pointMs(master.end)
  const atMs = pointMs(occurrence)
  if (startMs === null || endMs === null || atMs === null) return master
  const duration = endMs - startMs
  if (master.allDay || occurrence.date) {
    const start = occurrence.date ?? new Date(atMs).toISOString().slice(0, 10)
    return {
      ...master,
      start: { date: start },
      end: { date: shiftDate(start, Math.round(duration / DAY_MS)) },
    }
  }
  return {
    ...master,
    start: { ...master.start, dateTime: new Date(atMs).toISOString() },
    end: { ...master.end, dateTime: new Date(atMs + duration).toISOString() },
  }
}

/** The occurrence's original start as the API takes it: a date (all-day series) or an instant. */
export function occurrenceStartParam(occurrence: CalendarPoint): string {
  if (occurrence.date) return occurrence.date
  return new Date(occurrence.dateTime ?? "").toISOString()
}

export interface TimesPayload {
  start: string
  end: string
  allDay: boolean
}

/**
 * The times a whole-series edit sends when the form moved the occurrence it was opened at: the
 * series' first occurrence moves by the same amount, with the form's length. Nothing when the
 * times did not change (the series keeps its own).
 */
export function seriesTimes(
  master: CalendarEventDto,
  occurrence: CalendarPoint,
  next: TimesPayload,
): Partial<TimesPayload> {
  const shown = occurrenceView(master, occurrence)
  if (next.allDay !== master.allDay) return next
  if (next.allDay) {
    const from = shown.start?.date
    const first = master.start?.date
    if (!from || !first) return next
    const moved = Math.round(
      (Date.parse(`${next.start}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
    )
    const length = Math.round(
      (Date.parse(`${next.end}T00:00:00Z`) - Date.parse(`${next.start}T00:00:00Z`)) / DAY_MS,
    )
    if (next.start === from && next.end === shown.end?.date) return {}
    const start = shiftDate(first, moved)
    return { start, end: shiftDate(start, length), allDay: true }
  }
  const fromMs = pointMs(shown.start)
  const firstMs = pointMs(master.start)
  const nextStart = Date.parse(next.start)
  const nextEnd = Date.parse(next.end)
  if (fromMs === null || firstMs === null) return next
  if (nextStart === fromMs && nextEnd === pointMs(shown.end)) return {}
  const start = firstMs + (nextStart - fromMs)
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + (nextEnd - nextStart)).toISOString(),
    allDay: false,
  }
}

/** The id and scope fields a change to a recurring meeting sends, for the scope chosen. */
export function scopeTarget(
  event: CalendarEventDto,
  context: Exclude<SeriesContext, null>,
  scope: SeriesScope,
): { eventId: string; scope: SeriesScope; occurrenceStart?: string } {
  if (context.kind === "exception" || scope === "series") {
    return { eventId: event.eventId, scope }
  }
  return {
    eventId: event.eventId,
    scope,
    occurrenceStart: occurrenceStartParam(context.occurrence),
  }
}
