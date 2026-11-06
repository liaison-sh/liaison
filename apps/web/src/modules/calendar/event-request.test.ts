// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"

vi.mock("./EventDialog", () => ({ EventDialog: () => null }))

import { eventRequestOf } from "./CalendarShell"

describe("a calendar tab's id can ask for one event", () => {
  it("names the event and its day", () => {
    expect(eventRequestOf("event-abc@2026-11-06")).toEqual({ id: "abc", day: "2026-11-06" })
  })

  it("an event whose start cannot be read still names the event", () => {
    expect(eventRequestOf("event-abc@")).toEqual({ id: "abc", day: "" })
  })

  it("the tab's ordinary ids ask for nothing", () => {
    expect(eventRequestOf("month")).toBeNull()
    expect(eventRequestOf(undefined)).toBeNull()
  })
})
