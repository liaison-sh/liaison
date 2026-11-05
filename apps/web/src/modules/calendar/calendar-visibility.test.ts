// SPDX-License-Identifier: FSL-1.1-ALv2
// Coherence regression — the per-calendar visibility toggle (CalendarSidebar -> store) must
// actually remove a calendar's events from what the month/week grids render. The tabs feed
// `calendarStore.events.filter(e => isCalendarVisible(e.calendarId))` into expandEvents; this
// exercises exactly that pipeline (store predicate + expander) so a regression that stops the
// toggle from filtering is caught without mounting the full provider tree.
import { beforeEach, describe, expect, it } from "vitest"
import type { CalendarEventDto } from "./calendar-api"
import {
  calendarStore,
  isCalendarVisible,
  resetCalendarStore,
  setCalendarStore,
  toggleCalendarVisibility,
} from "./calendar-store"
import { expandEvents } from "./rrule-expand"

function evt(calendarId: string, eventId: string): CalendarEventDto {
  return {
    eventId,
    calendarId,
    title: `Event ${eventId}`,
    description: null,
    location: null,
    start: { dateTime: "2026-07-15T09:00:00.000Z" },
    end: { dateTime: "2026-07-15T09:30:00.000Z" },
    allDay: false,
    recurrence: null,
    recurringEventId: null,
    originalStartTime: null,
    status: "confirmed",
  }
}

function visibleOccurrences() {
  const visible = calendarStore.events.filter((e) => isCalendarVisible(e.calendarId))
  return expandEvents(visible, new Date("2026-07-01T00:00:00Z"), new Date("2026-08-01T00:00:00Z"))
}

describe("per-calendar visibility toggle filters rendered events", () => {
  beforeEach(() => {
    localStorage.clear()
    resetCalendarStore()
    setCalendarStore("events", [evt("cal-A", "a1"), evt("cal-B", "b1")])
  })

  it("both calendars' events render when nothing is hidden", () => {
    const ids = visibleOccurrences().map((o) => o.eventId)
    expect(ids).toContain("a1")
    expect(ids).toContain("b1")
  })

  it("toggling a calendar off removes its events; toggling back on restores them", () => {
    toggleCalendarVisibility("cal-B")
    expect(isCalendarVisible("cal-B")).toBe(false)
    let ids = visibleOccurrences().map((o) => o.eventId)
    expect(ids).toContain("a1")
    expect(ids).not.toContain("b1")

    toggleCalendarVisibility("cal-B")
    ids = visibleOccurrences().map((o) => o.eventId)
    expect(ids).toContain("b1")
  })
})
