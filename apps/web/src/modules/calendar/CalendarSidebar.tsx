// SPDX-License-Identifier: FSL-1.1-ALv2
// Calendar sidebar — + Create pill, mini-month minimap, and the per-calendar visibility list
// with Google-style colored check squares.
import { type Component, For } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  calendarStore,
  isCalendarVisible,
  requestCreateEvent,
  toggleCalendarVisibility,
} from "./calendar-store"
import { MiniMonth } from "./MiniMonth"

const CalendarSidebar: Component = () => {
  const i18n = useI18n()
  return (
    <div class="flex h-full flex-col gap-4 overflow-y-auto p-3" data-testid="calendar-sidebar">
      <button
        type="button"
        class="flex items-center gap-2 self-start rounded-full border border-border-subtle bg-surface py-2 pl-3 pr-5 text-sm font-medium text-text shadow-[0_1px_3px_rgba(0,0,0,0.12)] transition-shadow hover:shadow-[0_3px_8px_rgba(0,0,0,0.18)]"
        data-testid="calendar-create-button"
        onClick={() => requestCreateEvent()}
      >
        <span class="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-base font-normal leading-none text-accent-foreground">
          +
        </span>
        {i18n.t("calendar.create")}
      </button>

      <MiniMonth />

      <div>
        <h3 class="mb-1 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-text-tertiary">
          {i18n.t("calendar.myCalendars")}
        </h3>
        <ul class="flex flex-col">
          <For each={calendarStore.calendars.filter((c) => c.selected)}>
            {(cal) => {
              const color = cal.color ?? "#2563eb"
              return (
                <li>
                  <label class="relative flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-text hover:bg-[color-mix(in_srgb,var(--color-border)_35%,transparent)]">
                    {/* Invisible but clickable overlay (sr-only inputs time out under Playwright) */}
                    <input
                      type="checkbox"
                      class="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                      checked={isCalendarVisible(cal.id)}
                      onChange={() => toggleCalendarVisibility(cal.id)}
                      data-testid={`calendar-toggle-${cal.id}`}
                    />
                    <span
                      class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border text-[9px] font-bold text-white"
                      style={{
                        "border-color": color,
                        "background-color": isCalendarVisible(cal.id) ? color : "transparent",
                      }}
                    >
                      {isCalendarVisible(cal.id) ? "✓" : ""}
                    </span>
                    <span class="truncate">{cal.name}</span>
                  </label>
                </li>
              )
            }}
          </For>
        </ul>
      </div>
    </div>
  )
}

export default CalendarSidebar
