// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The event tab (full create and edit; it replaced the event modal). Ported from the modal's
// cases, plus the all-day regression seen on a walk (2026-11-27): ticking "All day" blanked both
// date fields and the event was saved on today; an all-day event reopened with blank dates.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn(), get: vi.fn(), delete: vi.fn() } as any,
  evicted: [] as string[],
  toasts: [] as Array<{ message: string; action?: { label: string; onClick: () => void } }>,
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  evictTabByEntity: (_type: string, id: string) => state.evicted.push(id),
}))
vi.mock("~/modules/shell/toast-store", () => ({
  addToast: (t: (typeof state.toasts)[number]) => {
    state.toasts.push(t)
    return "1"
  },
}))

import { CalendarEventTab } from "./CalendarEventTab"
import type { CalendarEventDto } from "./calendar-api"
import { resetCalendarStore, setCalendarStore } from "./calendar-store"
import { openNewEventTab } from "./event-tabs"

const calendars = [
  { id: "cal-1", name: "Team", color: null, accessRole: "owner", selected: true },
  { id: "cal-hol", name: "Holidays", color: null, accessRole: "reader", selected: true },
]

const timed: CalendarEventDto = {
  eventId: "evt-1",
  calendarId: "cal-1",
  title: "Point hebdo",
  description: null,
  location: null,
  start: { dateTime: "2026-10-06T09:00:00.000Z" },
  end: { dateTime: "2026-10-06T09:30:00.000Z" },
  allDay: false,
  recurrence: null,
  recurringEventId: null,
  originalStartTime: null,
  status: "confirmed",
  attendees: [
    { email: "dana@acme.example", displayName: "Dana Girard", responseStatus: "needsAction" },
    { email: "avery@acme.example", responseStatus: "accepted", organizer: true },
  ],
}

const allDay: CalendarEventDto = {
  ...timed,
  eventId: "evt-ad",
  title: "Offsite",
  start: { date: "2026-12-03" },
  end: { date: "2026-12-05" },
  allDay: true,
  attendees: [],
}

function params(tool: string): Record<string, unknown> {
  const call = state.api.post.mock.calls.find((c: unknown[]) => String(c[0]).endsWith(`/${tool}`))
  expect(call).toBeDefined()
  return (call![1] as { params: Record<string, unknown> }).params
}

function openTab(entityId: string) {
  render(() => <CalendarEventTab entityId={entityId} />)
}

beforeEach(() => {
  resetCalendarStore()
  setCalendarStore({ calendars, events: [timed, allDay] })
  state.api.post = vi.fn(async () => ({ eventId: "evt-new" }))
  state.evicted = []
  state.toasts = []
})

describe("event tab: new event", () => {
  it("refuses an empty title and an end before the start", async () => {
    openTab(openNewEventTab({ start: new Date(2026, 6, 10, 10, 0) }, "New event"))
    fireEvent.click(screen.getByTestId("event-save"))
    expect(await screen.findByText("Title is required")).toBeTruthy()
    fireEvent.input(screen.getByTestId("event-title-input"), { target: { value: "My event" } })
    fireEvent.input(screen.getByTestId("event-end-input"), {
      target: { value: "2026-07-10T09:00" },
    })
    fireEvent.click(screen.getByTestId("event-save"))
    expect(await screen.findByText("End must be after start")).toBeTruthy()
    expect(state.api.post).not.toHaveBeenCalled()
  })

  it("ticking All day keeps the chosen day and saves a one-day event with an exclusive end", async () => {
    openTab(openNewEventTab({ start: new Date(2026, 11, 3, 14, 0) }, "New event"))
    fireEvent.input(screen.getByTestId("event-title-input"), { target: { value: "Inventory" } })
    fireEvent.click(screen.getByTestId("event-allday-toggle"))
    const start = screen.getByTestId("event-start-input") as HTMLInputElement
    const end = screen.getByTestId("event-end-input") as HTMLInputElement
    expect(start.type).toBe("date")
    expect(start.value).toBe("2026-12-03")
    expect(end.value).toBe("2026-12-03")
    fireEvent.click(screen.getByTestId("event-save"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    const sent = params("create_event")
    expect(sent).toMatchObject({ start: "2026-12-03", end: "2026-12-04", allDay: true })
    await waitFor(() => expect(state.evicted).toHaveLength(1))
  })

  it("offers only calendars the user can write to, and sends a Meet when asked", async () => {
    openTab(openNewEventTab({ start: new Date(2026, 6, 10, 10, 0) }, "New event"))
    const options = Array.from(
      (screen.getByTestId("event-calendar-select") as HTMLSelectElement).options,
    ).map((o) => o.value)
    expect(options).toEqual(["cal-1"])
    fireEvent.input(screen.getByTestId("event-title-input"), { target: { value: "Call" } })
    fireEvent.click(screen.getByTestId("event-meet-toggle"))
    fireEvent.click(screen.getByTestId("event-save"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(params("create_event")).toMatchObject({ calendarId: "cal-1", conference: "google_meet" })
  })
})

describe("event tab: existing event", () => {
  it("an all-day event opens on its own dates (inclusive end) and keeps them on save", async () => {
    openTab("evt-ad")
    const start = screen.getByTestId("event-start-input") as HTMLInputElement
    const end = screen.getByTestId("event-end-input") as HTMLInputElement
    expect(start.value).toBe("2026-12-03")
    expect(end.value).toBe("2026-12-04")
    fireEvent.click(screen.getByTestId("event-save"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(params("update_event")).toMatchObject({
      eventId: "evt-ad",
      start: "2026-12-03",
      end: "2026-12-05",
      allDay: true,
    })
  })

  it("shows the attendees and never sends an untouched list", async () => {
    openTab("evt-1")
    const rows = screen.getAllByTestId("event-attendee")
    expect(rows[0]!.textContent).toContain("Dana Girard")
    expect(rows[1]!.textContent).toContain("Organizer")
    fireEvent.input(screen.getByTestId("event-title-input"), { target: { value: "Point v2" } })
    fireEvent.click(screen.getByTestId("event-save"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    const sent = params("update_event")
    expect(sent.title).toBe("Point v2")
    expect("attendees" in sent).toBe(false)
    expect("scope" in sent).toBe(false)
  })

  it("an occurrence of a recurring meeting saves that occurrence only", async () => {
    setCalendarStore("events", [{ ...timed, recurringEventId: "gevt-master" }])
    openTab("evt-1")
    fireEvent.click(screen.getByTestId("event-save"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(params("update_event").scope).toBe("occurrence")
  })

  it("a recurring master is read-only, with the note", () => {
    setCalendarStore("events", [{ ...timed, recurrence: ["RRULE:FREQ=WEEKLY"] }])
    openTab("evt-1")
    expect((screen.getByTestId("event-save") as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId("event-recurring-note")).toBeTruthy()
  })

  it("delete asks first, then offers Undo, which puts the event back", async () => {
    openTab("evt-1")
    fireEvent.click(screen.getByTestId("event-delete"))
    expect(state.api.post).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId("event-delete-confirm"))
    await waitFor(() => expect(state.toasts).toHaveLength(1))
    expect(params("delete_event")).toMatchObject({ eventId: "evt-1" })
    state.toasts[0]!.action!.onClick()
    await waitFor(() =>
      expect(params("create_event")).toMatchObject({
        calendarId: "cal-1",
        title: "Point hebdo",
        start: "2026-10-06T09:00:00.000Z",
        attendees: ["dana@acme.example", "avery@acme.example"],
      }),
    )
  })

  it("a refused delete says why and keeps the tab open", async () => {
    state.api.post = vi.fn(async () => {
      throw new Error("Forbidden")
    })
    openTab("evt-1")
    fireEvent.click(screen.getByTestId("event-delete"))
    fireEvent.click(await screen.findByTestId("event-delete-confirm"))
    expect((await screen.findByTestId("event-error")).textContent).toContain("Forbidden")
    expect(state.evicted).toHaveLength(0)
  })
})
