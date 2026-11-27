// SPDX-License-Identifier: FSL-1.1-ALv2
// The event form's values and the payload they save as, kept out of the components so the
// all-day rules are unit-tested in one place.
//
// All-day events are calendar DATES end to end: the form shows the inclusive last day, Google
// stores the exclusive day after it (`end.date` = last day + 1). A date never goes through
// `Date#toISOString`, which shifted a local evening onto the next day west of UTC and turned a
// one-day event into a zero-length one (end = start).
import type { CalendarEventDto, CalendarListItem, CreateEventInput } from "./calendar-api"

export interface EventFormValues {
  title: string
  description: string
  location: string
  allDay: boolean
  /** `YYYY-MM-DDTHH:MM`, local wall clock, for a timed event. */
  startLocal: string
  endLocal: string
  /** `YYYY-MM-DD`, for an all-day event; `endDate` is the LAST day shown (inclusive). */
  startDate: string
  endDate: string
  calendarId: string
  meet: boolean
}

const pad = (n: number) => String(n).padStart(2, "0")

export function toLocalDateValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function toLocalInputValue(date: Date): string {
  return `${toLocalDateValue(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `YYYY-MM-DD` plus `days`, as a calendar date (no time zone involved). */
export function addDays(dateValue: string, days: number): string {
  const [y, m, d] = dateValue.split("-").map(Number) as [number, number, number]
  return toLocalDateValue(new Date(y, m - 1, d + days))
}

/** The next half hour from `now` (a new event starts on the grid, not at 14:57). */
export function nextHalfHour(now: Date = new Date()): Date {
  const d = new Date(now)
  d.setSeconds(0, 0)
  const onMark = now.getSeconds() === 0 && now.getMilliseconds() === 0
  if (onMark && (d.getMinutes() === 0 || d.getMinutes() === 30)) return d
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60)
  return d
}

/** A calendar the signed-in user may write to: Google's owner or writer, or a local calendar. */
export function isWritableCalendar(cal: Pick<CalendarListItem, "accessRole">): boolean {
  return cal.accessRole === null || cal.accessRole === "owner" || cal.accessRole === "writer"
}

export interface FormDefaults {
  start?: Date
  end?: Date
  allDay?: boolean
  title?: string
  calendarId?: string
}

/** The form for an existing event, or for a new one from `defaults`. */
export function formFromEvent(
  event: CalendarEventDto | null | undefined,
  defaults: FormDefaults,
  calendars: CalendarListItem[],
): EventFormValues {
  const writable = calendars.filter((c) => c.selected !== false && isWritableCalendar(c))
  const fallbackCalendar = defaults.calendarId ?? writable[0]?.id ?? calendars[0]?.id ?? ""
  if (event) {
    const allDay = event.allDay || Boolean(event.start?.date)
    const startDate = event.start?.date ?? toLocalDateValue(pointDate(event.start) ?? new Date())
    const endExclusive = event.end?.date
    const start = pointDate(event.start) ?? new Date()
    const end = pointDate(event.end) ?? new Date(start.getTime() + 30 * 60_000)
    return {
      title: event.title ?? "",
      description: event.description ?? "",
      location: event.location ?? "",
      allDay,
      startLocal: toLocalInputValue(start),
      endLocal: toLocalInputValue(end),
      startDate,
      // Google's all-day end is exclusive; the form shows the last day.
      endDate: endExclusive ? maxDate(startDate, addDays(endExclusive, -1)) : startDate,
      calendarId: event.calendarId,
      meet: Boolean(event.hangoutLink),
    }
  }
  const start = defaults.start ?? nextHalfHour()
  const end = defaults.end ?? new Date(start.getTime() + 30 * 60_000)
  const startDate = toLocalDateValue(start)
  const lastDay = defaults.end && defaults.allDay ? addDays(toLocalDateValue(end), -1) : startDate
  return {
    title: defaults.title ?? "",
    description: "",
    location: "",
    allDay: defaults.allDay ?? false,
    startLocal: toLocalInputValue(start),
    endLocal: toLocalInputValue(end),
    startDate,
    endDate: maxDate(startDate, lastDay),
    calendarId: fallbackCalendar,
    meet: false,
  }
}

/** Ticking "All day" keeps the day the event was on (it used to blank both date fields). */
export function withAllDay(form: EventFormValues, allDay: boolean): EventFormValues {
  if (allDay === form.allDay) return form
  if (allDay) {
    const startDate = form.startLocal.slice(0, 10) || form.startDate
    const endDate = maxDate(startDate, form.endLocal.slice(0, 10) || startDate)
    return { ...form, allDay, startDate, endDate }
  }
  const startLocal = `${form.startDate}T${form.startLocal.slice(11) || "09:00"}`
  const endLocal = `${form.startDate}T${form.endLocal.slice(11) || "09:30"}`
  return { ...form, allDay, startLocal, endLocal: endLocal > startLocal ? endLocal : startLocal }
}

/** Why the form cannot be saved, else null (an i18n key). */
export function validateForm(form: EventFormValues): string | null {
  if (!form.title.trim()) return "calendar.titleRequired"
  if (form.allDay) {
    if (!form.startDate || !form.endDate) return "calendar.endBeforeStart"
    return form.endDate < form.startDate ? "calendar.endBeforeStart" : null
  }
  const start = new Date(form.startLocal)
  const end = new Date(form.endLocal)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "calendar.endBeforeStart"
  return end <= start ? "calendar.endBeforeStart" : null
}

/** The start / end / allDay a save sends: dates for all-day (exclusive end), instants otherwise. */
export function timesPayload(form: EventFormValues): {
  start: string
  end: string
  allDay: boolean
} {
  if (form.allDay) {
    return { start: form.startDate, end: addDays(form.endDate, 1), allDay: true }
  }
  return {
    start: new Date(form.startLocal).toISOString(),
    end: new Date(form.endLocal).toISOString(),
    allDay: false,
  }
}

export function createPayload(
  form: EventFormValues,
  extra: { recurrence?: string[]; attendees?: string[] } = {},
): CreateEventInput {
  return {
    calendarId: form.calendarId,
    title: form.title.trim(),
    description: form.description,
    location: form.location,
    ...timesPayload(form),
    ...(extra.recurrence ? { recurrence: extra.recurrence } : {}),
    ...(extra.attendees && extra.attendees.length > 0 ? { attendees: extra.attendees } : {}),
    ...(form.meet ? { conference: "google_meet" as const } : {}),
  }
}

function pointDate(point: { date?: string; dateTime?: string } | null | undefined): Date | null {
  if (point?.dateTime) return new Date(point.dateTime)
  if (point?.date) {
    const [y, m, d] = point.date.split("-").map(Number) as [number, number, number]
    return new Date(y, m - 1, d)
  }
  return null
}

function maxDate(a: string, b: string): string {
  return b > a ? b : a
}
