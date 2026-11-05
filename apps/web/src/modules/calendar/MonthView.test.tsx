// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { startOfWeek, weekStartsOn } from "./date-utils"
import { MonthView } from "./MonthView"
import type { ExpandedOccurrence } from "./rrule-expand"

function occ(overrides: Partial<ExpandedOccurrence>): ExpandedOccurrence {
  return {
    eventId: "e1",
    calendarId: "cal-1",
    title: "Event",
    start: { dateTime: "2026-07-15T09:00:00" },
    end: { dateTime: "2026-07-15T09:30:00" },
    allDay: false,
    recurrenceComplex: false,
    ...overrides,
  }
}

describe("MonthView", () => {
  it("renders a timed event chip in its day cell", () => {
    render(() => (
      <MonthView
        year={2026}
        month={6}
        occurrences={[occ({ title: "Standup" })]}
        calendarColors={{}}
      />
    ))
    expect(screen.getByText("Standup")).toBeTruthy()
    const cell = screen.getByText("Standup").closest('[data-testid="calendar-day-cell"]')
    expect(cell?.getAttribute("data-date")).toBe("2026-07-15")
  })

  it("renders a multi-day event as a spanning band, not per-day chips", () => {
    render(() => (
      <MonthView
        year={2026}
        month={6}
        occurrences={[
          occ({
            eventId: "span",
            title: "Offsite",
            allDay: true,
            start: { date: "2026-07-13" },
            end: { date: "2026-07-17" },
          }),
        ]}
        calendarColors={{}}
      />
    ))
    const bands = screen.getAllByTestId("calendar-span-band")
    expect(bands).toHaveLength(1)
    expect(bands[0]!.textContent).toBe("Offsite")
  })

  it("shows an overflow indicator when a day exceeds the visible chip budget", () => {
    const occurrences = Array.from({ length: 5 }, (_, i) =>
      occ({ eventId: `e${i}`, title: `Event ${i}` }),
    )
    render(() => <MonthView year={2026} month={6} occurrences={occurrences} calendarColors={{}} />)
    expect(screen.getByTestId("calendar-overflow-indicator").textContent).toContain("3")
  })

  // A French calendar started its weeks on Sunday like a US one.
  it("a French month grid starts its weeks on Monday", () => {
    render(() => (
      <I18nProvider initialLocale="fr">
        <MonthView year={2026} month={6} occurrences={[]} calendarColors={{}} />
      </I18nProvider>
    ))
    const cells = screen.getAllByTestId("calendar-day-cell")
    // July 2026 begins on a Wednesday: the Monday grid opens on June 29.
    expect(cells[0]!.getAttribute("data-date")).toBe("2026-06-29")
    const header = screen.getByTestId("calendar-month-grid").firstElementChild
    expect(header?.firstElementChild?.textContent).toBe("lun.")
  })

  it("an English month grid keeps Sunday first", () => {
    render(() => <MonthView year={2026} month={6} occurrences={[]} calendarColors={{}} />)
    expect(screen.getAllByTestId("calendar-day-cell")[0]!.getAttribute("data-date")).toBe(
      "2026-06-28",
    )
  })

  it("the week containing a Sunday starts the Monday before, in French", () => {
    expect(weekStartsOn("fr")).toBe(1)
    expect(weekStartsOn("en")).toBe(0)
    const sunday = new Date(2026, 8, 20)
    expect(startOfWeek(sunday, weekStartsOn("fr")).getDate()).toBe(14)
    expect(startOfWeek(sunday, weekStartsOn("en")).getDate()).toBe(20)
  })
})
