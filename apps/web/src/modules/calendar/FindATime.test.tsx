// SPDX-License-Identifier: FSL-1.1-ALv2
// "Find a time" in the event tab: asks find_free_slots for the event's length, a picked slot
// fills the form, and a missing free/busy permission offers Allow (incremental consent).
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { post: vi.fn(), get: vi.fn() } as any,
  connect: vi.fn(),
}))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/modules/settings/oauth-connect", () => ({ connectWithOAuth: state.connect }))

import { FindATime, searchWindow, toLocalInput } from "./FindATime"

const FB = "https://www.googleapis.com/auth/calendar.freebusy"

beforeEach(() => {
  state.api.post.mockReset()
  state.connect.mockReset()
})

describe("FindATime", () => {
  it("asks for the event's length with the guests and fills the form with a picked slot", async () => {
    state.api.post.mockResolvedValue({
      timeZone: "UTC",
      durationMinutes: 45,
      slots: [{ start: "2026-12-07T10:00:00Z", end: "2026-12-07T10:45:00Z" }],
      attendees: [{ email: "a@x.test", status: "checked" }],
    })
    const onPick = vi.fn()
    render(() => (
      <FindATime
        attendees={["a@x.test"]}
        startLocal="2030-12-07T09:00"
        endLocal="2030-12-07T09:45"
        onPick={onPick}
      />
    ))
    fireEvent.click(screen.getByTestId("event-find-time-search"))
    await waitFor(() => expect(screen.getAllByTestId("event-find-time-slot")).toHaveLength(1))
    const [path, body] = state.api.post.mock.calls[0] as [
      string,
      { params: Record<string, unknown> },
    ]
    expect(path).toBe("/apps/calendar/tools/find_free_slots")
    expect(body.params).toMatchObject({ durationMinutes: 45, attendees: ["a@x.test"] })
    fireEvent.click(screen.getByTestId("event-find-time-slot"))
    expect(onPick).toHaveBeenCalledWith({
      startLocal: toLocalInput("2026-12-07T10:00:00Z"),
      endLocal: toLocalInput("2026-12-07T10:45:00Z"),
    })
  })

  it("offers Allow when the free/busy permission is missing, and asks only for that scope", async () => {
    state.api.post.mockResolvedValue({
      timeZone: "UTC",
      durationMinutes: 30,
      slots: [],
      attendees: [{ email: "a@x.test", status: "needs_consent" }],
      consent: { needed: true, scope: FB, message: "" },
    })
    render(() => (
      <FindATime
        attendees={["a@x.test"]}
        startLocal="2030-12-07T09:00"
        endLocal="2030-12-07T09:30"
        onPick={() => {}}
      />
    ))
    fireEvent.click(screen.getByTestId("event-find-time-search"))
    await waitFor(() => screen.getByTestId("event-find-time-allow"))
    expect(screen.getByTestId("event-find-time-none")).toBeTruthy()
    fireEvent.click(screen.getByTestId("event-find-time-allow"))
    expect(state.connect).toHaveBeenCalledWith(
      state.api,
      "/connections/calendar/google-calendar/authorize",
      { mode: "personal", scopes: [FB] },
    )
  })

  it("names the guests Google does not show", async () => {
    state.api.post.mockResolvedValue({
      timeZone: "UTC",
      durationMinutes: 30,
      slots: [{ start: "2026-12-07T10:00:00Z", end: "2026-12-07T10:30:00Z" }],
      attendees: [{ email: "out@else.test", status: "unknown", reason: "notFound" }],
    })
    render(() => (
      <FindATime attendees={["out@else.test"]} startLocal="" endLocal="" onPick={() => {}} />
    ))
    fireEvent.click(screen.getByTestId("event-find-time-search"))
    await waitFor(() =>
      expect(screen.getByTestId("event-find-time-unknown").textContent).toContain("out@else.test"),
    )
  })
})

describe("searchWindow", () => {
  it("starts at the event's day, never before now, and spans a week", () => {
    const now = new Date("2026-12-01T12:00:00Z")
    const past = searchWindow("2020-01-01T09:00", now)
    expect(past.timeMin).toBe(now.toISOString())
    const future = searchWindow("2026-12-10T15:00", now)
    const min = new Date(future.timeMin)
    expect(min.getHours()).toBe(0)
    expect(Date.parse(future.timeMax) - Date.parse(future.timeMin)).toBe(7 * 86_400_000)
  })
})
