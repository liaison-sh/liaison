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
  activateTab: vi.fn(),
  tabStore: { activeTabId: "calendar-tab", tabs: [] },
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

/** The `datetime-local` value an instant shows as in the test's zone. */
function toLocal(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
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

  it("an edited occurrence asks which occurrences, then saves that one only", async () => {
    setCalendarStore("events", [{ ...timed, recurringEventId: "gevt-master" }])
    openTab("evt-1")
    fireEvent.click(screen.getByTestId("event-save"))
    expect(state.api.post).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByTestId("event-scope-occurrence"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(params("update_event")).toMatchObject({ eventId: "evt-1", scope: "occurrence" })
  })

  it("a series opens at the occurrence clicked; this and following sends its original start", async () => {
    setCalendarStore("events", [{ ...timed, recurrence: ["RRULE:FREQ=WEEKLY"] }])
    openTab("evt-1~20261020T090000Z")
    expect((screen.getByTestId("event-start-input") as HTMLInputElement).value).toBe(
      toLocal("2026-10-20T09:00:00.000Z"),
    )
    fireEvent.input(screen.getByTestId("event-title-input"), { target: { value: "Point v3" } })
    fireEvent.click(screen.getByTestId("event-save"))
    fireEvent.click(await screen.findByTestId("event-scope-following"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(params("update_event")).toMatchObject({
      eventId: "evt-1",
      scope: "following",
      occurrenceStart: "2026-10-20T09:00:00.000Z",
      title: "Point v3",
      start: "2026-10-20T09:00:00.000Z",
    })
  })

  it("all events from an occurrence moves the whole series only when the time moved", async () => {
    setCalendarStore("events", [{ ...timed, recurrence: ["RRULE:FREQ=WEEKLY"] }])
    openTab("evt-1~20261020T090000Z")
    fireEvent.click(screen.getByTestId("event-save"))
    fireEvent.click(await screen.findByTestId("event-scope-series"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    const sent = params("update_event")
    expect(sent).toMatchObject({ eventId: "evt-1", scope: "series" })
    expect("start" in sent).toBe(false)
    expect("occurrenceStart" in sent).toBe(false)
  })

  it("deleting one occurrence of a series asks, then cancels that occurrence", async () => {
    setCalendarStore("events", [{ ...timed, recurrence: ["RRULE:FREQ=WEEKLY"] }])
    openTab("evt-1~20261020T090000Z")
    fireEvent.click(screen.getByTestId("event-delete"))
    fireEvent.click(await screen.findByTestId("event-scope-occurrence"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(params("delete_event")).toMatchObject({
      eventId: "evt-1",
      scope: "occurrence",
      occurrenceStart: "2026-10-20T09:00:00.000Z",
    })
    expect(state.toasts).toHaveLength(0)
  })

  it("a series' repeat rule is editable and a rule change cannot target one occurrence", async () => {
    setCalendarStore("events", [{ ...timed, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=TU"] }])
    openTab("evt-1~20261020T090000Z")
    fireEvent.input(screen.getByTestId("event-repeat-interval"), { target: { value: "2" } })
    fireEvent.click(screen.getByTestId("event-repeat-day-TH"))
    fireEvent.click(screen.getByTestId("event-save"))
    await screen.findByTestId("event-scope-following")
    expect(screen.queryByTestId("event-scope-occurrence")).toBeNull()
    fireEvent.click(screen.getByTestId("event-scope-series"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(params("update_event").recurrence).toEqual(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH"])
  })

  it("a rule the editor cannot show is kept, with the note", () => {
    setCalendarStore("events", [
      { ...timed, recurrence: ["RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR"] },
    ])
    openTab("evt-1")
    expect(screen.queryByTestId("event-recurrence-select")).toBeNull()
    expect(screen.getByTestId("event-recurring-note")).toBeTruthy()
  })

  it("added guests are invited by default; untick to save without emailing them", async () => {
    openTab("evt-1")
    fireEvent.input(screen.getByTestId("event-attendee-input"), {
      target: { value: "noa@partner.example" },
    })
    fireEvent.click(screen.getByTestId("event-attendee-add"))
    const box = screen.getByTestId("event-send-invitations") as HTMLInputElement
    expect(box.checked).toBe(true)
    fireEvent.click(screen.getByTestId("event-save"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(params("update_event").sendUpdates).toBe("all")
  })

  it("without new guests nobody is emailed unless the box is ticked", async () => {
    openTab("evt-1")
    expect((screen.getByTestId("event-send-invitations") as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByTestId("event-save"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect("sendUpdates" in params("update_event")).toBe(false)
  })

  it("answers an invitation the account received", async () => {
    const invited: CalendarEventDto = {
      ...timed,
      attendees: [
        { email: "boss@partner.example", organizer: true, responseStatus: "accepted" },
        { email: "me@acme.example", self: true, responseStatus: "needsAction" },
      ],
    }
    setCalendarStore("events", [invited])
    openTab("evt-1")
    fireEvent.click(screen.getByTestId("event-rsvp-declined"))
    await waitFor(() => expect(state.api.post).toHaveBeenCalled())
    expect(params("respond_to_event")).toEqual({ eventId: "evt-1", response: "declined" })
    await waitFor(() =>
      expect(screen.getByTestId("event-rsvp-declined").getAttribute("aria-pressed")).toBe("true"),
    )
  })

  it("an event the account organizes shows no answer buttons", () => {
    openTab("evt-1")
    expect(screen.queryByTestId("event-rsvp")).toBeNull()
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
