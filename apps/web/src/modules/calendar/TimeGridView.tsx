// SPDX-License-Identifier: FSL-1.1-ALv2
// Time grid — shared by the Day (1 column) and Week (7 columns) views. Timed events are
// positioned absolutely by minute (top/height %), overlapping events share the column width
// (layoutDayColumns), spanning/all-day events render as lanes in a sticky header band, and a
// live accent "now" filament tracks the current minute on today's column.
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { isSameDay, weekDays } from "./date-utils"
import { isSpanning, layoutDayColumns, layoutWeekSegments, type WeekSegment } from "./layout"
import type { ExpandedOccurrence } from "./rrule-expand"

export interface TimeGridViewProps {
  /** first visible day (for week: the week start; for day: the day itself) */
  rangeStart: Date
  /** 1 = day view, 7 = week view */
  dayCount: 1 | 7
  occurrences: ExpandedOccurrence[]
  calendarColors: Record<string, string>
  onSelectEvent?: (eventId: string) => void
  onSelectSlot?: (start: Date) => void
}

const HOUR_PX = 48
const SPAN_LANE_PX = 24

function nowMinutes(): number {
  const n = new Date()
  return n.getHours() * 60 + n.getMinutes()
}

export const TimeGridView: Component<TimeGridViewProps> = (props) => {
  const i18n = useI18n()
  const days = createMemo(() =>
    props.dayCount === 7
      ? weekDays(props.rangeStart)
      : [
          new Date(
            props.rangeStart.getFullYear(),
            props.rangeStart.getMonth(),
            props.rangeStart.getDate(),
          ),
        ],
  )
  const today = new Date()
  const hours = Array.from({ length: 24 }, (_, h) => h)

  const isTabActive = useTabIsActive()
  const [nowMin, setNowMin] = createSignal(nowMinutes())
  createEffect(() => {
    const t = setInterval(() => {
      if (isTabActive()) setNowMin(nowMinutes())
    }, 60_000)
    onCleanup(() => clearInterval(t))
  })
  // Recompute once immediately on reactivation so the "now" line isn't stale
  // by up to 60s the moment the user switches back to this tab.
  createEffect(() => {
    if (isTabActive()) setNowMin(nowMinutes())
  })

  const spanSegments = createMemo<WeekSegment[]>(() => {
    // Only genuinely spanning (multi-day / all-day) events belong in the band — timed
    // single-day events render as positioned blocks below.
    const spanning = props.occurrences.filter((o) => isSpanning(o))
    // layoutWeekSegments expects 7 days; pad a day view to a single-day "week" window.
    const ds = days()
    if (ds.length === 7) return layoutWeekSegments(ds, spanning)
    const d = ds[0]!
    const padded = Array.from(
      { length: 7 },
      (_, i) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + i),
    )
    return layoutWeekSegments(padded, spanning).filter((s) => s.startCol === 0)
  })
  const spanLaneCount = createMemo(() =>
    Math.min(
      4,
      spanSegments().reduce((m, s) => Math.max(m, s.lane + 1), 0),
    ),
  )

  const gridTemplate = () => `3.5rem repeat(${props.dayCount}, minmax(0, 1fr))`

  let scrollRef: HTMLDivElement | undefined
  createEffect(() => {
    // Scroll ~8:00 into view on mount / range change. (Guarded: jsdom has no scrollTo.)
    void props.rangeStart
    if (typeof scrollRef?.scrollTo === "function") scrollRef.scrollTo({ top: 7.5 * HOUR_PX })
  })

  return (
    <div
      class="flex h-full min-h-0 flex-col"
      data-testid={props.dayCount === 7 ? "calendar-week-grid" : "calendar-day-grid"}
    >
      {/* Day headers */}
      <div class="grid border-b border-border" style={{ "grid-template-columns": gridTemplate() }}>
        <div />
        <For each={days()}>
          {(day) => {
            const isToday = isSameDay(day, today)
            return (
              <div class="flex items-baseline gap-1.5 px-2 py-1.5">
                <span class="text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">
                  {day.toLocaleDateString(i18n.locale(), { weekday: "short" })}
                </span>
                <span
                  class={`flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-sm tabular-nums ${
                    isToday ? "bg-accent font-semibold text-accent-foreground" : "text-text"
                  }`}
                >
                  {day.getDate()}
                </span>
              </div>
            )
          }}
        </For>
      </div>

      {/* All-day / spanning lanes */}
      <Show when={spanLaneCount() > 0}>
        <div
          class="grid border-b border-border"
          style={{ "grid-template-columns": gridTemplate() }}
          data-testid="calendar-allday-row"
        >
          <div class="py-1 pr-2 text-right text-[10px] uppercase tracking-wide text-text-tertiary">
            {i18n.t("calendar.allDay")}
          </div>
          <div
            class="relative col-span-full col-start-2 grid gap-y-px py-0.5"
            style={{
              "grid-template-columns": `repeat(${props.dayCount}, minmax(0, 1fr))`,
              "min-height": `${spanLaneCount() * SPAN_LANE_PX}px`,
            }}
          >
            <For each={spanSegments().filter((s) => s.lane < 4)}>
              {(seg) => {
                const color = props.calendarColors[seg.occ.calendarId] ?? "#2563eb"
                const endCol = Math.min(seg.endCol, props.dayCount - 1)
                return (
                  <button
                    type="button"
                    class={`col-start-[var(--cs)] col-end-[var(--ce)] row-start-[var(--lane)] mx-px flex h-[20px] min-w-0 items-center truncate px-1.5 text-xs font-medium leading-[20px] hover:brightness-110 ${
                      seg.continuesLeft ? "rounded-l-none" : "rounded-l"
                    } ${seg.continuesRight || seg.endCol > endCol ? "rounded-r-none" : "rounded-r"}`}
                    style={{
                      "--cs": String(seg.startCol + 1),
                      "--ce": String(endCol + 2),
                      "--lane": String(seg.lane + 1),
                      "background-color": `color-mix(in srgb, ${color} 22%, var(--color-bg))`,
                      "border-left": seg.continuesLeft ? "none" : `3px solid ${color}`,
                      color: `color-mix(in srgb, ${color} 70%, var(--color-text))`,
                    }}
                    data-testid="calendar-span-band"
                    onClick={() => props.onSelectEvent?.(seg.occ.eventId)}
                  >
                    {seg.occ.title ?? i18n.t("calendar.untitledEvent")}
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>

      {/* Scrollable time grid */}
      <div class="min-h-0 flex-1 overflow-y-auto" ref={scrollRef}>
        <div
          class="relative grid"
          style={{ "grid-template-columns": gridTemplate(), height: `${24 * HOUR_PX}px` }}
        >
          {/* time rail */}
          <div class="relative border-r border-border-subtle">
            <For each={hours}>
              {(hour) => (
                <Show when={hour > 0}>
                  <span
                    class="absolute right-2 -translate-y-1/2 text-[11px] tabular-nums text-text-tertiary"
                    style={{ top: `${hour * HOUR_PX}px` }}
                  >
                    {new Date(2026, 0, 1, hour).toLocaleTimeString(i18n.locale(), {
                      hour: "numeric",
                    })}
                  </span>
                </Show>
              )}
            </For>
          </div>
          {/* day columns */}
          <For each={days()}>
            {(day) => {
              const blocks = createMemo(() => layoutDayColumns(day, props.occurrences))
              const isToday = isSameDay(day, today)
              return (
                <div
                  class="relative border-r border-border-subtle last:border-r-0"
                  data-testid={`calendar-day-column-${day.toDateString()}`}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect()
                    const min = ((e.clientY - rect.top) / HOUR_PX) * 60
                    const snapped = Math.floor(min / 30) * 30
                    props.onSelectSlot?.(
                      new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, snapped),
                    )
                  }}
                  onKeyDown={() => {}}
                  role="presentation"
                >
                  {/* hour lines */}
                  <For each={hours}>
                    {(hour) => (
                      <div
                        class="absolute inset-x-0 border-t border-border-subtle"
                        style={{ top: `${hour * HOUR_PX}px` }}
                      />
                    )}
                  </For>
                  {/* now filament */}
                  <Show when={isToday}>
                    <div
                      class="pointer-events-none absolute inset-x-0 z-20"
                      style={{ top: `${(nowMin() / 60) * HOUR_PX}px` }}
                      data-testid="calendar-now-line"
                    >
                      <div class="relative h-px bg-accent">
                        <span class="absolute -left-1 -top-[3px] h-[7px] w-[7px] rounded-full bg-accent" />
                      </div>
                    </div>
                  </Show>
                  {/* event blocks */}
                  <For each={blocks()}>
                    {(block) => {
                      const color = props.calendarColors[block.occ.calendarId] ?? "#2563eb"
                      const top = (block.startMin / 60) * HOUR_PX
                      const height = Math.max(
                        18,
                        ((block.endMin - block.startMin) / 60) * HOUR_PX - 2,
                      )
                      const width = 100 / block.cols
                      const startD = block.occ.start?.dateTime
                        ? new Date(block.occ.start.dateTime)
                        : null
                      return (
                        <button
                          type="button"
                          class="absolute z-10 flex min-w-0 flex-col overflow-hidden rounded-md px-1.5 py-0.5 text-left shadow-[0_1px_2px_rgba(0,0,0,0.08)] transition-[filter,box-shadow] hover:z-30 hover:shadow-[0_2px_8px_rgba(0,0,0,0.16)] hover:brightness-105"
                          style={{
                            top: `${top}px`,
                            height: `${height}px`,
                            left: `calc(${block.col * width}% + 1px)`,
                            width: `calc(${width}% - 3px)`,
                            "background-color": `color-mix(in srgb, ${color} 16%, var(--color-bg))`,
                            "border-left": `3px solid ${color}`,
                          }}
                          data-testid="calendar-timed-event"
                          onClick={(e) => {
                            e.stopPropagation()
                            props.onSelectEvent?.(block.occ.eventId)
                          }}
                        >
                          <span
                            class="truncate text-xs font-medium leading-4"
                            style={{ color: `color-mix(in srgb, ${color} 65%, var(--color-text))` }}
                          >
                            {block.occ.title ?? i18n.t("calendar.untitledEvent")}
                          </span>
                          <Show when={height >= 34 && startD}>
                            <span class="truncate text-[11px] tabular-nums text-text-tertiary">
                              {startD?.toLocaleTimeString(i18n.locale(), {
                                hour: "numeric",
                                minute: "2-digit",
                              })}
                            </span>
                          </Show>
                        </button>
                      )
                    }}
                  </For>
                </div>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
