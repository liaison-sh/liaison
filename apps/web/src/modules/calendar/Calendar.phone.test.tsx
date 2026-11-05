// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The calendar at phone width (M2-3 T19): the month and week grids become one
// agenda, derived from the SAME expanded occurrences the grids lay out, with a
// day strip to jump by, and a create flow that takes the whole screen.
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(async () => ({ data: [] })), post: vi.fn(async () => ({})) },
  store: {
    events: [] as any[],
    calendars: [{ id: "cal1", color: "#ff0000", selected: true }] as any[],
  },
  loadEventsForWindow: vi.fn(),
  loadCalendarsList: vi.fn(),
  focused: new Date(2026, 8, 16),
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => mocks.api,
  useOptionalApi: () => mocks.api,
}))
vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))
vi.mock("~/modules/calendar/calendar-store", () => ({
  calendarStore: mocks.store,
  createRequestedAt: () => 0,
  focusedDate: () => mocks.focused,
  setFocusedDate: (d: Date) => {
    mocks.focused = d
  },
  isCalendarVisible: () => true,
  loadAccountsList: vi.fn(),
  loadCalendarsList: mocks.loadCalendarsList,
  loadEventsForWindow: mocks.loadEventsForWindow,
  loadPreferredView: () => "month",
  persistPreferredView: vi.fn(),
}))
vi.mock("~/modules/calendar/EventDialog", () => ({ EventDialog: () => null }))

import {
  dayKey,
  groupOccurrencesByDay,
  occurrenceStart,
  occurrenceTimeLabel,
} from "~/modules/calendar/AgendaView"
import { CalendarShell } from "~/modules/calendar/CalendarShell"
import { setShellTier } from "~/tests/helpers/shell-tier"

function occ(over: Record<string, unknown> = {}) {
  return {
    eventId: "e1",
    calendarId: "cal1",
    title: "Standup",
    start: { dateTime: new Date(2026, 8, 16, 9, 0).toISOString() },
    end: { dateTime: new Date(2026, 8, 16, 9, 30).toISOString() },
    allDay: false,
    recurrenceComplex: false,
    ...over,
  } as never
}

describe("agenda grouping", () => {
  it("groups the occurrences by local day, in start order", () => {
    const days = groupOccurrencesByDay([
      occ({ eventId: "late", start: { dateTime: new Date(2026, 8, 16, 17, 0).toISOString() } }),
      occ({ eventId: "early", start: { dateTime: new Date(2026, 8, 16, 8, 0).toISOString() } }),
      occ({ eventId: "next", start: { dateTime: new Date(2026, 8, 17, 8, 0).toISOString() } }),
    ])
    expect(days.map((d) => d.key)).toEqual(["2026-09-16", "2026-09-17"])
    expect(days[0].occurrences.map((o) => o.eventId)).toEqual(["early", "late"])
  })

  it("reads an all-day point as the local day, never the UTC one", () => {
    const start = occurrenceStart(occ({ allDay: true, start: { date: "2026-09-16" } }))
    expect(dayKey(start as Date)).toBe("2026-09-16")
  })

  it("says 'all day' instead of a clock for an all-day occurrence", () => {
    expect(
      occurrenceTimeLabel(occ({ allDay: true, start: { date: "2026-09-16" } }), "en", "All day"),
    ).toBe("All day")
    expect(occurrenceTimeLabel(occ(), "en", "All day")).not.toBe("All day")
  })

  it("drops an occurrence with no usable start rather than grouping it under today", () => {
    expect(groupOccurrencesByDay([occ({ start: {} })])).toEqual([])
  })
})

describe("CalendarShell at phone width", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.focused = new Date(2026, 8, 16)
    mocks.store.events = [
      {
        eventId: "e1",
        calendarId: "cal1",
        title: "Standup",
        start: { dateTime: new Date(2026, 8, 16, 9, 0).toISOString() },
        end: { dateTime: new Date(2026, 8, 16, 9, 30).toISOString() },
      },
    ]
  })

  afterEach(() => {
    cleanup()
    setShellTier("desktop")
  })

  it("replaces the grid with an agenda and keeps the grid at desktop", () => {
    setShellTier("phone")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.getByTestId("calendar-agenda")).toBeInTheDocument()
    expect(screen.queryByTestId("calendar-month-grid")).toBeNull()
    cleanup()

    setShellTier("desktop")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.queryByTestId("calendar-agenda")).toBeNull()
  })

  it("gives the month title the header's room: New event is an icon button at phone", () => {
    setShellTier("phone")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    const btn = screen.getByTestId("calendar-new-event")
    expect(btn.getAttribute("aria-label")).toBeTruthy()
    expect(btn.textContent?.trim()).toBe("")
    expect(screen.getByTestId("calendar-title").textContent?.length).toBeGreaterThan(0)
    cleanup()

    setShellTier("desktop")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.getByTestId("calendar-new-event").textContent?.trim()).not.toBe("")
  })

  it("derives the agenda rows from the same events the grid lays out", () => {
    setShellTier("phone")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.getByTestId("calendar-agenda-day-2026-09-16")).toBeInTheDocument()
    const row = screen.getByTestId("calendar-agenda-event-e1")
    expect(row).toHaveTextContent("Standup")
    expect(screen.getByTestId("calendar-agenda-dot-e1").getAttribute("style")).toContain(
      "255, 0, 0",
    )
  })

  it("carries a day strip that jumps the focused date", () => {
    setShellTier("phone")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    const strip = screen.getByTestId("calendar-agenda-strip")
    expect(strip.querySelectorAll("button").length).toBe(7)
    fireEvent.click(screen.getByTestId("calendar-agenda-strip-2026-09-18"))
    expect(dayKey(mocks.focused)).toBe("2026-09-18")
  })

  it("hides the three way view switcher, which has no grids to switch between", () => {
    setShellTier("phone")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    // Computed, not the class string: a typo'd or overridden utility leaves
    // the switcher on screen while the substring check still passes.
    const style = document.createElement("style")
    // Source order matches the real sheet, where `hidden` wins over `flex`.
    style.textContent = ".flex { display: flex; }\n.hidden { display: none; }"
    document.head.appendChild(style)

    expect(getComputedStyle(screen.getByTestId("calendar-view-switcher")).display).toBe("none")
    cleanup()

    setShellTier("desktop")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(getComputedStyle(screen.getByTestId("calendar-view-switcher")).display).toBe("flex")
    style.remove()
  })

  // On the phone the list's scroll indicator sits on the right edge, over the
  // content, and a sticky day heading that runs to that edge paints over it:
  // the indicator vanished behind every heading as it scrolled past. The list
  // keeps a right gutter the headings stop short of.
  it("keeps the sticky day headings clear of the list's scroll indicator", () => {
    setShellTier("phone")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    const style = document.createElement("style")
    style.textContent = ".pr-2 { padding-right: 0.5rem; }"
    document.head.appendChild(style)

    const list = screen.getByTestId("calendar-agenda-list")
    expect(list.classList.contains("overflow-y-auto")).toBe(true)
    expect(getComputedStyle(list).paddingRight).toBe("0.5rem")
    const heading = screen.getByTestId("calendar-agenda-day-2026-09-16").querySelector("h3")
    expect(heading).not.toBeNull()
    expect(list.contains(heading)).toBe(true)
    style.remove()
  })

  it("says so when nothing is scheduled rather than showing an empty scroll", () => {
    mocks.store.events = []
    setShellTier("phone")
    render(() => <CalendarShell initialView="month" testId="calendar-month-tab" />)
    expect(screen.getByTestId("calendar-agenda-empty")).toBeInTheDocument()
  })
})
