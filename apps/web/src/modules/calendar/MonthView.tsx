// SPDX-License-Identifier: FSL-1.1-ALv2
// Month view — week rows with Google-style spanning lanes for multi-day/all-day events and
// dot+time lines for single-day timed events. Event colors come from the calendar's own color
// as a tint (color-mix), never solid white-on-color blocks.
import { type Component, createMemo, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { isSameDay, monthGridDays, weekdayLabels, weekStartsOn } from "./date-utils"
import { isSpanning, layoutWeekSegments, occStartDate, type WeekSegment } from "./layout"
import type { ExpandedOccurrence } from "./rrule-expand"

export interface MonthViewProps {
  year: number
  month: number // 0-indexed
  occurrences: ExpandedOccurrence[]
  calendarColors: Record<string, string>
  onSelectEvent?: (eventId: string) => void
  onSelectDay?: (day: Date) => void
  onFocusDay?: (day: Date) => void
}

const MAX_LANES = 2
const MAX_TIMED = 2

function timeLabel(occ: ExpandedOccurrence, locale: string): string {
  const d = occStartDate(occ)
  if (!d) return ""
  return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
}

export const MonthView: Component<MonthViewProps> = (props) => {
  const i18n = useI18n()
  const firstDay = () => weekStartsOn(i18n.locale())
  const days = createMemo(() => monthGridDays(props.year, props.month, firstDay()))
  const weeks = createMemo(() => {
    const all = days()
    const rows: Date[][] = []
    for (let w = 0; w < 6; w++) rows.push(all.slice(w * 7, w * 7 + 7))
    return rows
  })
  const today = new Date()

  const spanning = createMemo(() => props.occurrences.filter((o) => isSpanning(o)))
  const timedByDay = createMemo(() => {
    const map = new Map<string, ExpandedOccurrence[]>()
    for (const occ of props.occurrences) {
      if (isSpanning(occ)) continue
      const d = occStartDate(occ)
      if (!d) continue
      const key = d.toDateString()
      const list = map.get(key) ?? []
      list.push(occ)
      map.set(key, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => (occStartDate(a)?.getTime() ?? 0) - (occStartDate(b)?.getTime() ?? 0))
    }
    return map
  })

  const weekdayNames = createMemo(() => weekdayLabels(i18n.locale(), firstDay(), "short"))

  return (
    <div class="flex h-full flex-col" data-testid="calendar-month-grid">
      <div class="grid grid-cols-7 border-b border-border">
        <For each={weekdayNames()}>
          {(name) => (
            <div class="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
              {name}
            </div>
          )}
        </For>
      </div>
      <div class="grid flex-1 grid-rows-6">
        <For each={weeks()}>
          {(weekRow) => {
            const segments = createMemo(() => layoutWeekSegments(weekRow, spanning()))
            const visibleSegments = createMemo(() => segments().filter((s) => s.lane < MAX_LANES))
            const hiddenSpanCountByCol = createMemo(() => {
              const counts = Array.from({ length: 7 }, () => 0)
              for (const s of segments()) {
                if (s.lane < MAX_LANES) continue
                for (let c = s.startCol; c <= s.endCol; c++) counts[c] = (counts[c] ?? 0) + 1
              }
              return counts
            })
            return (
              <div class="relative grid grid-cols-7 border-b border-border-subtle">
                {/* day cells */}
                <For each={weekRow}>
                  {(day, col) => {
                    const inMonth = day.getMonth() === props.month
                    const isToday = isSameDay(day, today)
                    const timed = createMemo(() => timedByDay().get(day.toDateString()) ?? [])
                    const hiddenCount = createMemo(
                      () =>
                        Math.max(0, timed().length - MAX_TIMED) +
                        (hiddenSpanCountByCol()[col()] ?? 0),
                    )
                    return (
                      <div
                        class={`group relative flex min-h-[6.5rem] cursor-pointer flex-col border-r border-border-subtle px-1 pb-1 last:border-r-0 transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_4%,transparent)] ${inMonth ? "" : "bg-[color-mix(in_srgb,var(--color-border)_18%,transparent)]"}`}
                        data-testid="calendar-day-cell"
                        data-date={`${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`}
                        onClick={() => props.onSelectDay?.(day)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") props.onSelectDay?.(day)
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <div class="flex justify-end pt-1">
                          <span
                            class={`flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums ${
                              isToday
                                ? "bg-accent font-semibold text-accent-foreground"
                                : inMonth
                                  ? "text-text"
                                  : "text-text-tertiary"
                            }`}
                          >
                            {day.getDate()}
                          </span>
                        </div>
                        {/* spacer reserving room for the spanning lanes overlay */}
                        <div style={{ height: `${MAX_LANES * 22}px` }} class="shrink-0" />
                        <For each={timed().slice(0, MAX_TIMED)}>
                          {(occ) => {
                            const color = props.calendarColors[occ.calendarId] ?? "#2563eb"
                            return (
                              <button
                                type="button"
                                class="mt-px flex w-full min-w-0 items-center gap-1 rounded px-1 py-px text-left text-xs leading-4 transition-colors hover:bg-[color-mix(in_srgb,var(--color-border)_40%,transparent)]"
                                data-testid="calendar-event-chip"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  props.onSelectEvent?.(occ.eventId)
                                }}
                              >
                                <span
                                  class="h-2 w-2 shrink-0 rounded-full"
                                  style={{ "background-color": color }}
                                />
                                <span class="shrink-0 tabular-nums text-text-tertiary">
                                  {timeLabel(occ, i18n.locale())}
                                </span>
                                <span class="truncate text-text">
                                  {occ.title ?? i18n.t("calendar.untitledEvent")}
                                </span>
                              </button>
                            )
                          }}
                        </For>
                        <Show when={hiddenCount() > 0}>
                          <button
                            type="button"
                            class="mt-px w-full rounded px-1 text-left text-[11px] font-medium text-text-secondary hover:bg-[color-mix(in_srgb,var(--color-border)_40%,transparent)]"
                            data-testid="calendar-overflow-indicator"
                            onClick={(e) => {
                              e.stopPropagation()
                              props.onFocusDay?.(day)
                            }}
                          >
                            {i18n.t("calendar.moreEvents", { count: hiddenCount() })}
                          </button>
                        </Show>
                      </div>
                    )
                  }}
                </For>
                {/* spanning lanes overlay */}
                <div
                  class="pointer-events-none absolute inset-x-0 grid grid-cols-7 gap-y-px"
                  style={{ top: "2rem" }}
                >
                  <For each={visibleSegments()}>
                    {(seg: WeekSegment) => {
                      const color = props.calendarColors[seg.occ.calendarId] ?? "#2563eb"
                      return (
                        <button
                          type="button"
                          class={`pointer-events-auto col-start-[var(--cs)] col-end-[var(--ce)] row-start-[var(--lane)] mx-px flex h-[20px] min-w-0 items-center truncate px-1.5 text-xs font-medium leading-[20px] transition-transform hover:brightness-110 ${
                            seg.continuesLeft ? "rounded-l-none" : "rounded-l"
                          } ${seg.continuesRight ? "rounded-r-none" : "rounded-r"}`}
                          style={{
                            "--cs": String(seg.startCol + 1),
                            "--ce": String(seg.endCol + 2),
                            "--lane": String(seg.lane + 1),
                            "background-color": `color-mix(in srgb, ${color} 22%, var(--color-bg))`,
                            "border-left": seg.continuesLeft ? "none" : `3px solid ${color}`,
                            color: `color-mix(in srgb, ${color} 70%, var(--color-text))`,
                          }}
                          data-testid="calendar-span-band"
                          onClick={(e) => {
                            e.stopPropagation()
                            props.onSelectEvent?.(seg.occ.eventId)
                          }}
                        >
                          {seg.occ.title ?? i18n.t("calendar.untitledEvent")}
                        </button>
                      )
                    }}
                  </For>
                </div>
              </div>
            )
          }}
        </For>
      </div>
    </div>
  )
}
