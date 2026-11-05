// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The calendar at phone width (M2-3 T19).
//
// A month grid at 390px is 7 columns of about 50px: a day cell fits a number
// and a coloured smear, never a title, so the surface that tells you what your
// day holds tells you nothing. The same occurrences read as an AGENDA: one
// header per day, one row per event with its time, its title and its
// calendar's colour, in the order the day happens. A day strip across the top
// keeps the "jump to a date" the grid used to provide.
//
// The grouping is exported as a pure function because that is the part worth
// pinning: it is the SAME `expandEvents` output the month and week views lay
// out, regrouped, never a second source of events.
import { type Component, createMemo, For, Show } from "solid-js"
import type { ExpandedOccurrence } from "./rrule-expand"

export interface AgendaDay {
  /** Local calendar day, `YYYY-MM-DD`, stable to sort and to key on. */
  key: string
  date: Date
  occurrences: ExpandedOccurrence[]
}

/** When an occurrence starts, as a local Date. All-day points carry a date
 *  only, which is read as local midnight so the row lands on the day the
 *  viewer sees rather than the day UTC was on. */
export function occurrenceStart(occurrence: ExpandedOccurrence): Date | null {
  const point = occurrence.start
  if (point?.dateTime) return new Date(point.dateTime)
  if (point?.date) {
    const [y, m, d] = point.date.split("-").map((n) => Number.parseInt(n, 10))
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
    return new Date(y, m - 1, d)
  }
  return null
}

export function dayKey(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0")
  const day = `${date.getDate()}`.padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * The agenda: days that actually hold something, each with its occurrences in
 * start order. A day with nothing on it is not a row, because a phone agenda
 * that lists every empty day is a scroll with no information in it.
 */
export function groupOccurrencesByDay(occurrences: ExpandedOccurrence[]): AgendaDay[] {
  const byKey = new Map<string, AgendaDay>()
  for (const occurrence of occurrences) {
    const start = occurrenceStart(occurrence)
    if (!start) continue
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate())
    const key = dayKey(date)
    const existing = byKey.get(key)
    if (existing) existing.occurrences.push(occurrence)
    else byKey.set(key, { key, date, occurrences: [occurrence] })
  }
  const days = [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
  for (const day of days) {
    day.occurrences.sort((a, b) => {
      const sa = occurrenceStart(a)?.getTime() ?? 0
      const sb = occurrenceStart(b)?.getTime() ?? 0
      return sa - sb
    })
  }
  return days
}

/** The time column on a row: an all-day occurrence says so instead of a clock. */
export function occurrenceTimeLabel(
  occurrence: ExpandedOccurrence,
  locale: string,
  allDayLabel: string,
): string {
  if (occurrence.allDay) return allDayLabel
  const start = occurrenceStart(occurrence)
  if (!start) return ""
  return start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
}

export interface AgendaViewProps {
  occurrences: ExpandedOccurrence[]
  calendarColors: Record<string, string>
  /** The day the strip centres its week on. */
  focusedDate: Date
  /** The seven days of the strip, in order. */
  stripDays: Date[]
  locale: string
  allDayLabel: string
  emptyLabel: string
  onSelectEvent: (eventId: string) => void
  onSelectDay: (day: Date) => void
}

export const AgendaView: Component<AgendaViewProps> = (props) => {
  const days = createMemo(() => groupOccurrencesByDay(props.occurrences))

  return (
    <div data-testid="calendar-agenda" class="flex min-h-0 flex-1 flex-col">
      {/* Day strip: what the grid's "tap a day" used to be. */}
      <div
        data-testid="calendar-agenda-strip"
        class="flex shrink-0 items-stretch gap-1 overflow-x-auto border-b border-border px-2 py-2"
      >
        <For each={props.stripDays}>
          {(day) => {
            const selected = () => dayKey(day) === dayKey(props.focusedDate)
            return (
              <button
                type="button"
                data-testid={`calendar-agenda-strip-${dayKey(day)}`}
                aria-pressed={selected() ? "true" : "false"}
                onClick={() => props.onSelectDay(day)}
                class="flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center rounded-lg px-1 py-1 text-text-secondary"
                classList={{
                  "bg-surface-active text-text": selected(),
                  "hover:bg-surface-hover": !selected(),
                }}
              >
                <span class="text-[11px] uppercase">
                  {day.toLocaleDateString(props.locale, { weekday: "narrow" })}
                </span>
                <span class="text-[16px] font-semibold tabular-nums">{day.getDate()}</span>
              </button>
            )
          }}
        </For>
      </div>

      {/* The right gutter keeps the sticky day headings off the scroll
          indicator: on the phone it is drawn over the content at the right
          edge, and a heading running to that edge painted over it. */}
      <div data-testid="calendar-agenda-list" class="min-h-0 flex-1 overflow-y-auto pb-8 pr-2">
        <Show
          when={days().length > 0}
          fallback={
            <p
              data-testid="calendar-agenda-empty"
              class="px-4 py-6 text-[14px] text-text-secondary"
            >
              {props.emptyLabel}
            </p>
          }
        >
          <For each={days()}>
            {(day) => (
              <section data-testid={`calendar-agenda-day-${day.key}`}>
                <h3 class="sticky top-0 bg-bg px-4 pb-1 pt-3 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
                  {day.date.toLocaleDateString(props.locale, {
                    weekday: "long",
                    day: "numeric",
                    month: "long",
                  })}
                </h3>
                <For each={day.occurrences}>
                  {(occurrence) => (
                    <button
                      type="button"
                      data-testid={`calendar-agenda-event-${occurrence.eventId}`}
                      onClick={() => props.onSelectEvent(occurrence.eventId)}
                      class="flex min-h-[52px] w-full items-center gap-3 px-4 text-left hover:bg-surface-hover"
                    >
                      {/* Wide enough for a 12 hour clock ("09:00 AM"): at 52px
                          it wrapped onto two lines and pushed the row's title
                          off its baseline. */}
                      <span class="w-[68px] shrink-0 whitespace-nowrap text-[12px] tabular-nums text-text-secondary">
                        {occurrenceTimeLabel(occurrence, props.locale, props.allDayLabel)}
                      </span>
                      <span
                        aria-hidden="true"
                        data-testid={`calendar-agenda-dot-${occurrence.eventId}`}
                        class="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          "background-color":
                            props.calendarColors[occurrence.calendarId] ?? "#2563eb",
                        }}
                      />
                      <span class="min-w-0 flex-1 truncate text-[16px] text-text">
                        {occurrence.title ?? ""}
                      </span>
                    </button>
                  )}
                </For>
              </section>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
