// SPDX-License-Identifier: FSL-1.1-ALv2
// Sidebar mini-month — Google-Calendar-style minimap: compact 7×6 grid, event-density dots,
// today as a filled accent circle, click to focus the main view on that day.
import { type Component, createEffect, createMemo, createSignal, For, on } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { calendarStore, focusedDate, isCalendarVisible, setFocusedDate } from "./calendar-store"
import { isSameDay, monthGridDays, weekdayLabels, weekStartsOn } from "./date-utils"
import { occurrenceDaySpan } from "./layout"
import { expandEvents } from "./rrule-expand"
import { createToday } from "./today"

export const MiniMonth: Component = () => {
  const i18n = useI18n()
  const [cursor, setCursor] = createSignal(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  )
  const today = createToday()
  // The month shown follows the main view: navigating there (or Today) brings the mini month
  // along; its own arrows still browse freely until the main view moves again.
  createEffect(
    on(focusedDate, (d) => setCursor(new Date(d.getFullYear(), d.getMonth(), 1)), { defer: false }),
  )
  const firstDay = () => weekStartsOn(i18n.locale())
  const days = createMemo(() =>
    monthGridDays(cursor().getFullYear(), cursor().getMonth(), firstDay()),
  )

  const eventDays = createMemo(() => {
    // Occurrences, not rows: every day of a recurring series gets its dot.
    const set = new Set<string>()
    const grid = days()
    const first = grid[0]
    const last = grid[grid.length - 1]
    if (!first || !last) return set
    const windowEnd = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1)
    for (const occ of expandEvents(calendarStore.events, first, windowEnd)) {
      if (!isCalendarVisible(occ.calendarId)) continue
      const span = occurrenceDaySpan(occ)
      if (!span) continue
      for (
        let d = span.first;
        d <= span.last;
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)
      ) {
        set.add(d.toDateString())
      }
    }
    return set
  })

  const weekdayLetters = createMemo(() => weekdayLabels(i18n.locale(), firstDay(), "narrow"))

  return (
    <div class="select-none" data-testid="calendar-mini-month">
      <div class="mb-1 flex items-center justify-between px-1">
        <span class="text-xs font-semibold capitalize text-text">
          {cursor().toLocaleDateString(i18n.locale(), { month: "long", year: "numeric" })}
        </span>
        <div class="flex">
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded-full text-text-secondary hover:bg-[color-mix(in_srgb,var(--color-border)_50%,transparent)]"
            aria-label={i18n.t("calendar.prevMonth")}
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
          >
            ‹
          </button>
          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded-full text-text-secondary hover:bg-[color-mix(in_srgb,var(--color-border)_50%,transparent)]"
            aria-label={i18n.t("calendar.nextMonth")}
            onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
          >
            ›
          </button>
        </div>
      </div>
      <div class="grid grid-cols-7 text-center">
        <For each={weekdayLetters()}>
          {(letter) => <span class="py-0.5 text-[10px] text-text-tertiary">{letter}</span>}
        </For>
        <For each={days()}>
          {(day) => {
            const inMonth = () => day.getMonth() === cursor().getMonth()
            const isToday = () => isSameDay(day, today())
            const isFocused = () => isSameDay(day, focusedDate())
            return (
              <button
                type="button"
                class={`relative mx-auto flex h-6 w-6 items-center justify-center rounded-full text-[11px] tabular-nums transition-colors ${
                  isToday()
                    ? "bg-accent font-semibold text-accent-foreground"
                    : isFocused()
                      ? "bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] font-medium text-accent"
                      : inMonth()
                        ? "text-text hover:bg-[color-mix(in_srgb,var(--color-border)_50%,transparent)]"
                        : "text-text-tertiary hover:bg-[color-mix(in_srgb,var(--color-border)_40%,transparent)]"
                }`}
                data-testid="calendar-mini-day"
                onClick={() => setFocusedDate(new Date(day))}
              >
                {day.getDate()}
                <span
                  class={`absolute bottom-0 h-[3px] w-[3px] rounded-full ${
                    eventDays().has(day.toDateString()) && !isToday()
                      ? "bg-accent"
                      : "bg-transparent"
                  }`}
                />
              </button>
            )
          }}
        </For>
      </div>
    </div>
  )
}
