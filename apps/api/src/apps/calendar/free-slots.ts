// SPDX-License-Identifier: FSL-1.1-ALv2
// Free slot search for `find_free_slots` and the event tab's "Find a time" strip: pure
// interval arithmetic. The busy intervals come from the caller's synced calendars
// (`busyFromEvents`) and from Google's free/busy answer for the attendees; this module only
// intersects them with working hours in one zone.
import {
  calendarPointToDate,
  expandRecurrence,
  instantOfWallClock,
  isoInTimeZone,
  wallClockIn,
} from "@liaison/shared"

export interface Interval {
  start: number
  end: number
}

export interface WorkingHours {
  /** "HH:MM", in `timeZone`. */
  start: string
  /** "HH:MM", in `timeZone`; after `start`. */
  end: string
  /** Weekdays a slot may fall on, 0 = Sunday .. 6 = Saturday. */
  days: number[]
}

export const DEFAULT_WORKING_HOURS: WorkingHours = {
  start: "09:00",
  end: "18:00",
  days: [1, 2, 3, 4, 5],
}

export interface FreeSlot {
  /** ISO 8601 with the zone's offset. */
  start: string
  end: string
}

export interface FindSlotsInput {
  windowStart: Date
  windowEnd: Date
  durationMinutes: number
  timeZone: string
  workingHours: WorkingHours
  busy: Interval[]
  /** No slot starts before this instant (now). */
  notBefore: Date
  /** Slot starts are on multiples of this many minutes of the wall clock. */
  stepMinutes: number
  maxResults: number
  /** At most this many slots per day, so a week's answer is not one morning. */
  maxPerDay: number
}

const MINUTE_MS = 60_000

/** "HH:MM" as minutes after midnight, or null. "24:00" is the end of the day. */
export function parseClock(value: unknown): number | null {
  if (typeof value !== "string") return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (mi > 59 || h > 24 || (h === 24 && mi !== 0)) return null
  return h * 60 + mi
}

/** Busy intervals sorted and merged (touching intervals join). */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start)
  const out: Interval[] = []
  for (const i of sorted) {
    const last = out[out.length - 1]
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end)
    else out.push({ ...i })
  }
  return out
}

/** The calendar days (in `timeZone`) the window touches, as { year, month, day }. */
function daysOfWindow(start: Date, end: Date, timeZone: string) {
  const days: { year: number; month: number; day: number }[] = []
  const first = wallClockIn(start, timeZone)
  let cursor = Date.UTC(first.year, first.month - 1, first.day)
  // Walk calendar dates; compare each day's local midnight with the window end.
  for (let i = 0; i < 400; i++) {
    const d = new Date(cursor)
    const day = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
    const midnight = instantOfWallClock({ ...day, hour: 0, minute: 0 }, timeZone)
    if (midnight.getTime() >= end.getTime()) break
    days.push(day)
    cursor += 86_400_000
  }
  return days
}

/**
 * The free slots of `durationMinutes` inside working hours, in time order, that overlap no busy
 * interval. Each day yields at most `maxPerDay` slots, the next one starting where the previous
 * one ended, so the answer offers distinct choices across the days.
 */
export function findFreeSlots(input: FindSlotsInput): FreeSlot[] {
  const { timeZone, durationMinutes, stepMinutes } = input
  const workStart = parseClock(input.workingHours.start) ?? 9 * 60
  const workEnd = parseClock(input.workingHours.end) ?? 18 * 60
  const busy = mergeIntervals(input.busy)
  const durationMs = durationMinutes * MINUTE_MS
  const lower = Math.max(input.windowStart.getTime(), input.notBefore.getTime())
  const upper = input.windowEnd.getTime()
  const slots: FreeSlot[] = []
  if (durationMinutes <= 0 || workEnd <= workStart) return slots

  for (const day of daysOfWindow(input.windowStart, input.windowEnd, timeZone)) {
    if (slots.length >= input.maxResults) break
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay()
    if (!input.workingHours.days.includes(weekday)) continue
    let perDay = 0
    for (let minute = workStart; minute + durationMinutes <= workEnd; minute += stepMinutes) {
      if (perDay >= input.maxPerDay || slots.length >= input.maxResults) break
      const start = instantOfWallClock(
        { ...day, hour: Math.floor(minute / 60), minute: minute % 60 },
        timeZone,
      ).getTime()
      const end = start + durationMs
      if (start < lower || end > upper) continue
      // A spring-forward gap may map two wall times to one instant: keep slots strictly apart.
      const last = slots[slots.length - 1]
      if (last && start < Date.parse(last.end)) continue
      if (busy.some((b) => b.start < end && b.end > start)) continue
      slots.push({
        start: isoInTimeZone(new Date(start), timeZone),
        end: isoInTimeZone(new Date(end), timeZone),
      })
      perDay++
    }
  }
  return slots
}

/** What `busyFromEvents` reads of an event (the `list_events` wire shape). */
export interface BusyEventLike {
  eventId: string
  start: unknown
  end: unknown
  allDay: boolean
  status: string
  recurrence: string[] | null
  recurringEventId: string | null
  originalStartTime: unknown
  transparency?: string | null
  eventType?: string | null
  attendees: { email: string; responseStatus?: string; self?: boolean }[]
}

/**
 * Whether an event blocks its calendar's owner: Google's busy/free (`transparency`) when the
 * event has one; without it a timed event is busy and an all-day one free (Google's own default
 * for all-day events, and what rows synced before transparency was kept fall back to). A
 * meeting the owner declined and a working-location marker never block.
 */
export function eventBlocks(event: BusyEventLike, selfEmails: ReadonlySet<string>): boolean {
  if (event.status === "cancelled") return false
  if (event.eventType === "workingLocation") return false
  const me = event.attendees.find((a) => a.self === true || selfEmails.has(a.email.toLowerCase()))
  if (me?.responseStatus === "declined") return false
  if (event.transparency === "transparent") return false
  if (event.transparency === "opaque") return true
  return !event.allDay
}

/** An all-day `{ date }` point as the instant its day starts in `timeZone`. */
function allDayInstant(point: unknown, timeZone: string): number | null {
  const date = (point as { date?: unknown } | null)?.date
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const [year, month, day] = date.split("-").map(Number) as [number, number, number]
  return instantOfWallClock({ year, month, day, hour: 0, minute: 0 }, timeZone).getTime()
}

/**
 * The busy intervals of a `list_events` answer over a window: recurring series expanded, their
 * exceptions applied (a cancelled occurrence frees its slot, a moved one blocks its new time),
 * all-day events read as whole days in `timeZone`.
 */
export function busyFromEvents(
  events: BusyEventLike[],
  windowStart: Date,
  windowEnd: Date,
  timeZone: string,
  selfEmails: ReadonlySet<string>,
): Interval[] {
  const out: Interval[] = []
  const push = (e: BusyEventLike, start: number | null, end: number | null) => {
    if (start === null || end === null || end <= start) return
    if (!eventBlocks(e, selfEmails)) return
    out.push({ start, end })
  }
  const span = (e: BusyEventLike, s: unknown, en: unknown): [number | null, number | null] =>
    e.allDay
      ? [allDayInstant(s, timeZone), allDayInstant(en, timeZone)]
      : [calendarPointToDate(s)?.getTime() ?? null, calendarPointToDate(en)?.getTime() ?? null]

  const replaced = new Map<string, Set<number>>()
  for (const e of events) {
    if (!e.recurringEventId) continue
    const original = calendarPointToDate(e.originalStartTime)
    if (!original) continue
    const set = replaced.get(e.recurringEventId) ?? new Set<number>()
    set.add(original.getTime())
    replaced.set(e.recurringEventId, set)
  }
  for (const e of events) {
    const isMaster = !e.recurringEventId && Array.isArray(e.recurrence) && e.recurrence.length > 0
    if (!isMaster) {
      push(e, ...span(e, e.start, e.end))
      continue
    }
    const skip = replaced.get(e.eventId) ?? new Set<number>()
    const { complex, occurrences } = expandRecurrence(e, windowStart, windowEnd)
    if (complex) {
      push(e, ...span(e, e.start, e.end))
      continue
    }
    for (const occ of occurrences) {
      if (skip.has(occ.start.getTime())) continue
      if (e.allDay) {
        const s = occ.start.toISOString().slice(0, 10)
        const en = occ.end.toISOString().slice(0, 10)
        push(e, allDayInstant({ date: s }, timeZone), allDayInstant({ date: en }, timeZone))
      } else {
        push(e, occ.start.getTime(), occ.end.getTime())
      }
    }
  }
  return mergeIntervals(out)
}

/** Google's freeBusy answer for one calendar, as intervals; null when Google reported errors. */
export function busyFromGoogle(
  entry: { busy?: { start?: string; end?: string }[]; errors?: { reason?: string }[] } | undefined,
): { busy: Interval[]; error: string | null } {
  if (!entry) return { busy: [], error: "notFound" }
  if (Array.isArray(entry.errors) && entry.errors.length > 0) {
    return { busy: [], error: entry.errors[0]?.reason ?? "unknown" }
  }
  const busy: Interval[] = []
  for (const b of entry.busy ?? []) {
    const start = b.start ? Date.parse(b.start) : Number.NaN
    const end = b.end ? Date.parse(b.end) : Number.NaN
    if (Number.isFinite(start) && Number.isFinite(end)) busy.push({ start, end })
  }
  return { busy: mergeIntervals(busy), error: null }
}

/** The Google scope `freebusy.query` needs, asked for incrementally (manifest `optionalScopes`). */
export const FREE_BUSY_SCOPE = "https://www.googleapis.com/auth/calendar.freebusy"
