// SPDX-License-Identifier: FSL-1.1-ALv2
// The time grid's polish (slice 11): "+N" in the all-day band, overnight events drawn in the
// grid on both days, per-event colour, declined meetings faded, the second zone's hour rail, and
// "today" moving at midnight.
import { render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
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

const allDay = (id: string) =>
  occ({
    eventId: id,
    title: id,
    allDay: true,
    start: { date: "2026-07-15" },
    end: { date: "2026-07-16" },
  })

afterEach(() => vi.useRealTimers())

describe("TimeGridView polish", () => {
  it("shows three lanes and '+N' on a day with more all-day events than fit", () => {
    const onShowDay = vi.fn()
    render(() => (
      <TimeGridView
        rangeStart={new Date(2026, 6, 12)}
        dayCount={7}
        occurrences={["a", "b", "c", "d", "e"].map(allDay)}
        calendarColors={{}}
        onShowDay={onShowDay}
      />
    ))
    expect(screen.getAllByTestId("calendar-span-band")).toHaveLength(3)
    const more = screen.getByTestId("calendar-allday-more")
    expect(more.textContent).toContain("2")
    more.click()
    expect(onShowDay.mock.calls[0]?.[0].getDate()).toBe(15)
  })

  it("draws a timed event that crosses midnight in the grid on both days", () => {
    render(() => (
      <TimeGridView
        rangeStart={new Date(2026, 6, 12)}
        dayCount={7}
        occurrences={[
          occ({
            start: { dateTime: "2026-07-15T22:00:00" },
            end: { dateTime: "2026-07-16T02:00:00" },
          }),
        ]}
        calendarColors={{}}
      />
    ))
    expect(screen.queryByTestId("calendar-allday-row")).toBeNull()
    const blocks = screen.getAllByTestId("calendar-timed-event") as HTMLElement[]
    expect(blocks).toHaveLength(2)
    expect(blocks.map((b) => b.style.top).sort()).toEqual(["0px", `${22 * 48}px`])
  })

  it("uses the event's own colour and fades a declined meeting", () => {
    render(() => (
      <TimeGridView
        rangeStart={new Date(2026, 6, 12)}
        dayCount={7}
        occurrences={[occ({ colorId: "11", declined: true })]}
        calendarColors={{ "cal-1": "#123456" }}
      />
    ))
    const block = screen.getByTestId("calendar-timed-event") as HTMLElement
    expect(block.style.borderLeft).toContain("rgb(213, 0, 0)")
    expect(block.dataset.declined).toBe("true")
    expect(block.className).toContain("opacity-60")
  })

  it("adds the second zone's hour rail and labels both zones", () => {
    render(() => (
      <TimeGridView
        rangeStart={new Date(2026, 6, 12)}
        dayCount={1}
        occurrences={[]}
        calendarColors={{}}
        secondaryTimeZone="Asia/Tokyo"
      />
    ))
    expect(screen.getByTestId("calendar-secondary-rail")).toBeTruthy()
    expect(screen.getByTestId("calendar-secondary-zone-label").getAttribute("title")).toBe(
      "Asia/Tokyo",
    )
    expect(screen.getByTestId("calendar-zone-label")).toBeTruthy()
  })

  it("moves today's highlight to the next day at midnight", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    vi.setSystemTime(new Date(2026, 6, 15, 23, 59, 30))
    render(() => (
      <TimeGridView
        rangeStart={new Date(2026, 6, 12)}
        dayCount={7}
        occurrences={[]}
        calendarColors={{}}
      />
    ))
    expect(screen.getAllByTestId("calendar-now-line")).toHaveLength(1)
    const todayCol = () =>
      (
        screen
          .getByTestId("calendar-now-line")
          .closest("[data-testid^='calendar-day-column-']") as HTMLElement
      ).dataset.testid
    expect(todayCol()).toContain("Jul 15")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(todayCol()).toContain("Jul 16")
  })
})
