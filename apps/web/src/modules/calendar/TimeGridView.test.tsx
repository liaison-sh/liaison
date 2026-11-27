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

describe("TimeGridView drag", () => {
  // jsdom has no layout: each day column is 100 px wide from x = 56, the grid starts at y = 0.
  function layOut() {
    const cols = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="calendar-day-column-"]'),
    )
    cols.forEach((col, i) => {
      col.getBoundingClientRect = () =>
        ({ left: 56 + i * 100, right: 156 + i * 100, top: 0, bottom: 1152 }) as DOMRect
    })
    return cols
  }
  const pointer = (type: string, x: number, y: number) =>
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }) as PointerEvent

  function week(handlers: Record<string, unknown>, canDrag = true) {
    render(() => (
      <TimeGridView
        rangeStart={new Date(2026, 6, 12)}
        dayCount={7}
        occurrences={[occ({ title: "Standup" })]}
        calendarColors={{}}
        canDrag={() => canDrag}
        {...handlers}
      />
    ))
    return layOut()
  }

  it("a drag over empty slots creates that range (14:00 to 16:00)", () => {
    const onCreateRange = vi.fn()
    const cols = week({ onCreateRange })
    cols[1]!.dispatchEvent(pointer("pointerdown", 100, 14 * 48 + 2))
    document.dispatchEvent(pointer("pointermove", 100, 15 * 48 + 40))
    expect(screen.getByTestId("calendar-drag-ghost")).toBeTruthy()
    document.dispatchEvent(pointer("pointerup", 100, 15 * 48 + 40))
    const [start, end] = onCreateRange.mock.calls[0] as [Date, Date]
    expect([start.getDate(), start.getHours(), start.getMinutes()]).toEqual([13, 14, 0])
    expect([end.getHours(), end.getMinutes()]).toEqual([16, 0])
  })

  it("dragging an event two hours down and one day right moves it there", () => {
    const onMoveEvent = vi.fn()
    week({ onMoveEvent })
    const block = screen.getByTestId("calendar-timed-event")
    // The event is on Wednesday 15 (column 3).
    block.dispatchEvent(pointer("pointerdown", 360, 9 * 48 + 10))
    document.dispatchEvent(pointer("pointermove", 460, 11 * 48 + 10))
    document.dispatchEvent(pointer("pointerup", 460, 11 * 48 + 10))
    const [id, start, end] = onMoveEvent.mock.calls[0] as [string, Date, Date]
    expect(id).toBe("e1")
    expect([start.getDate(), start.getHours()]).toEqual([16, 11])
    expect([end.getDate(), end.getHours()]).toEqual([16, 12])
  })

  it("dragging the bottom edge resizes; Esc cancels a drag; a still click opens the event", () => {
    const onMoveEvent = vi.fn()
    const onSelectEvent = vi.fn()
    week({ onMoveEvent, onSelectEvent })
    const handle = screen.getByTestId("calendar-event-resize")
    handle.dispatchEvent(pointer("pointerdown", 360, 10 * 48))
    document.dispatchEvent(pointer("pointermove", 360, 10 * 48 + 24))
    document.dispatchEvent(pointer("pointerup", 360, 10 * 48 + 24))
    const [, , end] = onMoveEvent.mock.calls[0] as [string, Date, Date]
    expect([end.getHours(), end.getMinutes()]).toEqual([10, 30])

    const block = screen.getByTestId("calendar-timed-event")
    block.dispatchEvent(pointer("pointerdown", 360, 9 * 48 + 10))
    document.dispatchEvent(pointer("pointermove", 360, 12 * 48))
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))
    document.dispatchEvent(pointer("pointerup", 360, 12 * 48))
    expect(onMoveEvent).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("calendar-drag-ghost")).toBeNull()

    block.dispatchEvent(pointer("pointerdown", 360, 9 * 48 + 10))
    document.dispatchEvent(pointer("pointerup", 361, 9 * 48 + 11))
    expect(onSelectEvent).toHaveBeenCalledWith("e1")
  })

  it("an event that may not be dragged only opens", () => {
    const onMoveEvent = vi.fn()
    const onSelectEvent = vi.fn()
    week({ onMoveEvent, onSelectEvent }, false)
    const block = screen.getByTestId("calendar-timed-event")
    block.dispatchEvent(pointer("pointerdown", 360, 9 * 48 + 10))
    document.dispatchEvent(pointer("pointermove", 360, 12 * 48))
    document.dispatchEvent(pointer("pointerup", 360, 12 * 48))
    expect(onMoveEvent).not.toHaveBeenCalled()
    expect(onSelectEvent).toHaveBeenCalledWith("e1")
    expect(screen.queryByTestId("calendar-event-resize")).toBeNull()
  })
})
