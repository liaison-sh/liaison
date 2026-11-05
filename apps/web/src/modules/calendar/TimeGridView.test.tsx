// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import type { ExpandedOccurrence } from "./rrule-expand"
import { TimeGridView } from "./TimeGridView"

function occ(overrides: Partial<ExpandedOccurrence>): ExpandedOccurrence {
  return {
    eventId: "e1",
    calendarId: "cal-1",
    title: "Event",
    start: { dateTime: "2026-07-15T09:00:00" },
    end: { dateTime: "2026-07-15T10:00:00" },
    allDay: false,
    recurrenceComplex: false,
    ...overrides,
  }
}

describe("TimeGridView", () => {
  it("week mode renders 7 day columns and positions a timed event block", () => {
    render(() => (
      <TimeGridView
        rangeStart={new Date(2026, 6, 12)}
        dayCount={7}
        occurrences={[occ({ title: "Standup" })]}
        calendarColors={{}}
      />
    ))
    expect(screen.getByTestId("calendar-week-grid")).toBeTruthy()
    const block = screen.getByTestId("calendar-timed-event")
    expect(block.textContent).toContain("Standup")
    // 9:00 with HOUR_PX=48 → top 432px
    expect((block as HTMLElement).style.top).toBe("432px")
  })

  it("day mode renders a single-column grid with the same event", () => {
    render(() => (
      <TimeGridView
        rangeStart={new Date(2026, 6, 15)}
        dayCount={1}
        occurrences={[occ({})]}
        calendarColors={{}}
      />
    ))
    expect(screen.getByTestId("calendar-day-grid")).toBeTruthy()
    expect(screen.getByTestId("calendar-timed-event")).toBeTruthy()
  })

  it("all-day events render in the spanning band row, not the time grid", () => {
    render(() => (
      <TimeGridView
        rangeStart={new Date(2026, 6, 12)}
        dayCount={7}
        occurrences={[
          occ({
            eventId: "ad",
            title: "Holiday",
            allDay: true,
            start: { date: "2026-07-14" },
            end: { date: "2026-07-15" },
          }),
        ]}
        calendarColors={{}}
      />
    ))
    expect(screen.getByTestId("calendar-allday-row")).toBeTruthy()
    expect(screen.getByTestId("calendar-span-band").textContent).toBe("Holiday")
    expect(screen.queryByTestId("calendar-timed-event")).toBeNull()
  })
})

describe("TimeGridView — now-line ticker gated on tab activity", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not advance the now-line while the tab is inactive across ticks; catches up on reactivation", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 15, 9, 0, 0))
    const today = new Date(2026, 6, 15)

    const [isActive, setIsActive] = createSignal(false)
    render(() => (
      <TabVisibilityProvider value={isActive}>
        <TimeGridView rangeStart={today} dayCount={1} occurrences={[]} calendarColors={{}} />
      </TabVisibilityProvider>
    ))

    const initialTop = (screen.getByTestId("calendar-now-line") as HTMLElement).style.top
    expect(initialTop).toBe("432px") // 9:00 -> (9*60/60)*48

    // Advance real clock + two interval ticks while inactive.
    vi.setSystemTime(new Date(2026, 6, 15, 11, 0, 0))
    vi.advanceTimersByTime(60_000 * 2)
    expect((screen.getByTestId("calendar-now-line") as HTMLElement).style.top).toBe(initialTop)

    // Reactivate — recomputes once immediately to the current (mocked) time.
    setIsActive(true)
    const reactivatedTop = Number.parseFloat(
      (screen.getByTestId("calendar-now-line") as HTMLElement).style.top,
    )
    // Must have caught up close to 11:00 (528px) — nowhere near the stale 9:00
    // (432px) value it was frozen at while inactive.
    expect(reactivatedTop).toBeGreaterThan(500)
    expect(reactivatedTop).not.toBe(Number.parseFloat(initialTop))
  })
})
