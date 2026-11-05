// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn(), get: vi.fn(), delete: vi.fn() } as any,
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))

import { EventDialog } from "./EventDialog"

describe("EventDialog", () => {
  it("shows a validation error and does not save when the title is empty", async () => {
    const onSaved = vi.fn()
    render(() => (
      <EventDialog
        open={true}
        onOpenChange={() => {}}
        calendars={[
          { id: "cal-1", name: "Personal", color: null, accessRole: "owner", selected: true },
        ]}
        onSaved={onSaved}
      />
    ))
    const saveButton = screen.getByText("Save")
    fireEvent.click(saveButton)
    expect(await screen.findByText("Title is required")).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("rejects end before start", async () => {
    const onSaved = vi.fn()
    render(() => (
      <EventDialog
        open={true}
        onOpenChange={() => {}}
        calendars={[
          { id: "cal-1", name: "Personal", color: null, accessRole: "owner", selected: true },
        ]}
        onSaved={onSaved}
      />
    ))
    const titleInput = screen.getByTestId("event-title-input") as HTMLInputElement
    fireEvent.input(titleInput, { target: { value: "My event" } })
    const startInput = screen.getByTestId("event-start-input") as HTMLInputElement
    const endInput = screen.getByTestId("event-end-input") as HTMLInputElement
    fireEvent.input(startInput, { target: { value: "2026-07-10T10:00" } })
    fireEvent.input(endInput, { target: { value: "2026-07-10T09:00" } })
    fireEvent.click(screen.getByText("Save"))
    expect(await screen.findByText("End must be after start")).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("a recurring master is view-only: Save is disabled and the note is shown (editing an occurrence must not clobber the series)", () => {
    const onSaved = vi.fn()
    render(() => (
      <EventDialog
        open={true}
        onOpenChange={() => {}}
        calendars={[
          { id: "cal-1", name: "Personal", color: null, accessRole: "owner", selected: true },
        ]}
        event={{
          eventId: "gevt-master",
          calendarId: "cal-1",
          title: "Weekly Standup",
          description: null,
          location: null,
          start: { dateTime: "2026-07-06T09:00:00.000Z" },
          end: { dateTime: "2026-07-06T09:30:00.000Z" },
          allDay: false,
          recurrence: ["RRULE:FREQ=WEEKLY"],
          recurringEventId: null,
          originalStartTime: null,
          status: "confirmed",
        }}
        onSaved={onSaved}
      />
    ))
    expect(screen.getByTestId("event-recurring-note")).toBeTruthy()
    const saveButton = screen.getByText("Save") as HTMLButtonElement
    expect(saveButton.disabled).toBe(true)
  })

  it("toggling all-day switches the start/end inputs to date type", () => {
    render(() => (
      <EventDialog
        open={true}
        onOpenChange={() => {}}
        calendars={[
          { id: "cal-1", name: "Personal", color: null, accessRole: "owner", selected: true },
        ]}
        onSaved={() => {}}
      />
    ))
    const toggle = screen.getByTestId("event-allday-toggle") as HTMLInputElement
    fireEvent.click(toggle)
    const startInput = screen.getByTestId("event-start-input") as HTMLInputElement
    expect(startInput.type).toBe("date")
  })

  // Reported 2026-10-05: an event with attendees opened with Attendees empty. The dialog shows
  // them now, and Save must never uninvite anyone it was not asked to.
  // Opening the calendar and clicking New event before the calendar list has
  // loaded (seen on demo, 2026-10-12): the list arriving re-ran the open-time
  // reset, wiping what the user had typed, and a dialog that opened with no
  // calendar saved with calendarId "" (400 "invalid input syntax for type uuid").
  describe("calendar list arriving while the dialog is open", () => {
    const cal = { id: "cal-1", name: "Team", color: null, accessRole: "owner", selected: true }

    function createdParams(): Record<string, unknown> {
      const call = state.api.post.mock.calls.find((c: unknown[]) =>
        String(c[0]).endsWith("/create_event"),
      )
      expect(call).toBeDefined()
      return (call![1] as { params: Record<string, unknown> }).params
    }

    it("keeps the typed fields and saves on the calendar that arrived", async () => {
      state.api.post = vi.fn(async () => ({ eventId: "evt-new" }))
      const [calendars, setCalendars] = createSignal<(typeof cal)[]>([])
      const onOpenChange = vi.fn()
      render(() => (
        <EventDialog
          open={true}
          onOpenChange={onOpenChange}
          calendars={calendars()}
          onSaved={() => {}}
        />
      ))
      fireEvent.input(screen.getByTestId("event-title-input"), {
        target: { value: "Supplier call" },
      })
      fireEvent.input(screen.getByTestId("event-start-input"), {
        target: { value: "2026-10-12T15:00" },
      })
      fireEvent.input(screen.getByTestId("event-end-input"), {
        target: { value: "2026-10-12T15:30" },
      })
      setCalendars([cal])
      expect((screen.getByTestId("event-title-input") as HTMLInputElement).value).toBe(
        "Supplier call",
      )
      fireEvent.click(screen.getByText("Save"))
      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
      const params = createdParams()
      expect(params.calendarId).toBe("cal-1")
      expect(params.title).toBe("Supplier call")
      expect(params.start).toBe(new Date("2026-10-12T15:00").toISOString())
    })

    it("a reload of the same list does not reset the form", () => {
      const [calendars, setCalendars] = createSignal([cal])
      render(() => (
        <EventDialog
          open={true}
          onOpenChange={() => {}}
          calendars={calendars()}
          onSaved={() => {}}
        />
      ))
      fireEvent.input(screen.getByTestId("event-title-input"), {
        target: { value: "Preamp review" },
      })
      setCalendars([{ ...cal }])
      expect((screen.getByTestId("event-title-input") as HTMLInputElement).value).toBe(
        "Preamp review",
      )
    })
  })

  describe("attendees", () => {
    const calendars = [
      { id: "cal-1", name: "Personal", color: null, accessRole: "owner", selected: true },
    ]
    const event = {
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
        {
          email: "dana@acme.example",
          displayName: "Dana Girard",
          responseStatus: "needsAction",
        },
        { email: "avery@acme.example", responseStatus: "accepted", organizer: true },
      ],
    }

    function open(overrides: Record<string, unknown> = {}) {
      state.api.post = vi.fn(async () => ({ eventId: "evt-1" }))
      render(() => (
        <EventDialog
          open={true}
          onOpenChange={() => {}}
          calendars={calendars}
          event={{ ...event, ...overrides } as never}
          onSaved={() => {}}
        />
      ))
    }

    function savedParams(): Record<string, unknown> {
      const call = state.api.post.mock.calls.find((c: unknown[]) =>
        String(c[0]).endsWith("/update_event"),
      )
      expect(call).toBeDefined()
      return (call![1] as { params: Record<string, unknown> }).params
    }

    it("shows each attendee with name, email, response, and the organizer", () => {
      open()
      const rows = screen.getAllByTestId("event-attendee")
      expect(rows).toHaveLength(2)
      expect(rows[0]!.textContent).toContain("Dana Girard")
      expect(rows[0]!.textContent).toContain("dana@acme.example")
      expect(rows[0]!.textContent).toContain("Awaiting reply")
      expect(rows[1]!.textContent).toContain("Accepted")
      expect(rows[1]!.textContent).toContain("Organizer")
      expect(screen.getByTestId("event-attendees-no-invite")).toBeTruthy()
    })

    it("Save with the attendees untouched does not send an attendee list", async () => {
      open()
      fireEvent.input(screen.getByTestId("event-title-input"), {
        target: { value: "Point hebdo v2" },
      })
      fireEvent.click(screen.getByText("Save"))
      await waitFor(() => expect(state.api.post).toHaveBeenCalled())
      const params = savedParams()
      expect(params.title).toBe("Point hebdo v2")
      expect("attendees" in params).toBe(false)
    })

    it("saving an edited occurrence of a recurring meeting changes that occurrence only", async () => {
      open({
        recurringEventId: "gevt-master",
        originalStartTime: { dateTime: "2026-10-06T09:00:00.000Z" },
      })
      fireEvent.input(screen.getByTestId("event-title-input"), {
        target: { value: "Point hebdo (moved)" },
      })
      fireEvent.click(screen.getByText("Save"))
      await waitFor(() => expect(state.api.post).toHaveBeenCalled())
      expect(savedParams().scope).toBe("occurrence")
    })

    it("deleting an edited occurrence of a recurring meeting cancels that occurrence only", async () => {
      open({
        recurringEventId: "gevt-master",
        originalStartTime: { dateTime: "2026-10-06T09:00:00.000Z" },
      })
      fireEvent.click(screen.getByText("Delete"))
      await waitFor(() => expect(state.api.post).toHaveBeenCalled())
      const call = state.api.post.mock.calls.find((c: unknown[]) =>
        String(c[0]).endsWith("/delete_event"),
      )
      expect((call![1] as { params: Record<string, unknown> }).params).toEqual({
        eventId: "evt-1",
        scope: "occurrence",
      })
    })

    it("a plain event is saved without a scope", async () => {
      open()
      fireEvent.click(screen.getByText("Save"))
      await waitFor(() => expect(state.api.post).toHaveBeenCalled())
      expect("scope" in savedParams()).toBe(false)
    })

    it("removing one and adding one saves exactly the resulting list", async () => {
      open()
      fireEvent.click(screen.getAllByTestId("event-attendee-remove")[0]!)
      fireEvent.input(screen.getByTestId("event-attendee-input"), {
        target: { value: "new@example.com" },
      })
      fireEvent.click(screen.getByTestId("event-attendee-add"))
      expect(screen.getAllByTestId("event-attendee")).toHaveLength(2)
      fireEvent.click(screen.getByText("Save"))
      await waitFor(() => expect(state.api.post).toHaveBeenCalled())
      expect(savedParams().attendees).toEqual(["avery@acme.example", "new@example.com"])
    })

    it("refuses a malformed address instead of adding it", () => {
      open()
      fireEvent.input(screen.getByTestId("event-attendee-input"), {
        target: { value: "not-an-email" },
      })
      fireEvent.click(screen.getByTestId("event-attendee-add"))
      expect(screen.getAllByTestId("event-attendee")).toHaveLength(2)
      expect(screen.getByText("Not a valid email address: not-an-email")).toBeTruthy()
    })

    it("an address typed but not added is saved with the list", async () => {
      open()
      fireEvent.input(screen.getByTestId("event-attendee-input"), {
        target: { value: "typed@example.com" },
      })
      fireEvent.click(screen.getByText("Save"))
      await waitFor(() => expect(state.api.post).toHaveBeenCalled())
      expect(savedParams().attendees).toEqual([
        "dana@acme.example",
        "avery@acme.example",
        "typed@example.com",
      ])
    })

    it("a malformed address typed but not added blocks Save with the message", async () => {
      open()
      fireEvent.input(screen.getByTestId("event-attendee-input"), { target: { value: "oops" } })
      fireEvent.click(screen.getByText("Save"))
      expect(await screen.findByText("Not a valid email address: oops")).toBeTruthy()
      expect(state.api.post).not.toHaveBeenCalled()
    })

    it("a guest list Google would not accept from this account is shown read-only", () => {
      open({ attendeesEditable: false })
      expect(screen.getAllByTestId("event-attendee")).toHaveLength(2)
      expect(screen.queryByTestId("event-attendee-remove")).toBeNull()
      expect(screen.queryByTestId("event-attendee-input")).toBeNull()
      expect(screen.getByTestId("event-attendees-readonly")).toBeTruthy()
    })

    it("shows Google's refusal of the last change", () => {
      open({ pushError: "Invalid attendee email." })
      expect(screen.getByTestId("event-push-error").textContent).toBe(
        "Google refused this change: Invalid attendee email.",
      )
    })

    it("shows why a refused delete brought the event back", () => {
      open({ pushNotice: "deleting this event: You need to have writer access to this calendar." })
      expect(screen.getByTestId("event-push-error").textContent).toBe(
        "Google refused this change: deleting this event: You need to have writer access to this calendar.",
      )
    })
  })
})
