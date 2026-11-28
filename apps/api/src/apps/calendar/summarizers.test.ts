// SPDX-License-Identifier: FSL-1.1-ALv2
// The calendar's approval cards name the event (walk 2026-11-28: "Calendar: a record", "Event: a
// record", and a delete card that did not say which event).
import { describe, expect, it } from "bun:test"
import {
  summarizeCreateEvent,
  summarizeDeleteEvent,
  summarizeUpdateEvent,
} from "~/apps/calendar/summarizers"
import type { RlsClient } from "~/db"

const CAL = "00000000-0000-4000-8000-00000000ca01"
const EVT = "00000000-0000-4000-8000-00000000ca02"

/** The literal SQL text of a drizzle query (its string chunks), to tell the lookups apart. */
function sqlText(query: unknown): string {
  const out: string[] = []
  const walk = (node: unknown, depth: number) => {
    if (depth > 6 || node === null || typeof node !== "object") return
    const n = node as { value?: unknown; queryChunks?: unknown[] }
    if (Array.isArray(n.value)) for (const v of n.value) if (typeof v === "string") out.push(v)
    if (typeof n.value === "string") out.push(n.value)
    if (Array.isArray(n.queryChunks)) for (const c of n.queryChunks) walk(c, depth + 1)
  }
  walk(query, 0)
  return out.join(" ")
}

/** A transaction answering the two lookups the cards make: an event row, a calendar row. */
function fakeTx(opts: { fail?: boolean } = {}): RlsClient {
  const execute = async (query: unknown) => {
    if (opts.fail) throw new Error("relation does not exist")
    const text = sqlText(query)
    if (text.includes(".calendars")) return [{ name: "Team calendar" }]
    return [
      {
        title: "Pricing sync",
        start: { dateTime: "2026-12-02T10:00:00Z" },
        end: { dateTime: "2026-12-02T10:30:00Z" },
        calendar_id: CAL,
      },
    ]
  }
  return {
    execute,
    transaction: async (fn: (sp: unknown) => Promise<unknown>) => fn({ execute }),
  } as unknown as RlsClient
}

describe("calendar approval cards", () => {
  it("a delete names the event, its time and its calendar", async () => {
    const s = await summarizeDeleteEvent({ eventId: EVT }, { tx: fakeTx(), orgId: CAL })
    expect(s.title).toBe('Delete "Pricing sync"')
    expect(s.lines).toEqual([
      "When: 2026-12-02T10:00:00Z to 2026-12-02T10:30:00Z",
      "Calendar: Team calendar",
      "Nobody is emailed.",
    ])
    expect(JSON.stringify(s)).not.toContain("a record")
  })

  it("a create names its calendar and says who is emailed", async () => {
    const s = await summarizeCreateEvent(
      {
        calendarId: CAL,
        title: "Roadmap review",
        start: "2026-12-01T15:00:00Z",
        end: "2026-12-01T16:00:00Z",
        attendees: ["a@x.test", "b@x.test"],
        sendUpdates: "all",
        recurrence: [],
      },
      { tx: fakeTx(), orgId: CAL },
    )
    expect(s.title).toBe('Create "Roadmap review"')
    expect(s.lines).toContain("Calendar: Team calendar")
    expect(s.lines).toContain("Guests: a@x.test, b@x.test")
    expect(s.lines).toContain("Google emails every guest once approved.")
    expect(s.lines.join("\n")).not.toContain("empty list")
  })

  it("an update names the event it changes", async () => {
    const s = await summarizeUpdateEvent(
      { eventId: EVT, start: "2026-12-02T11:00:00Z", end: "2026-12-02T11:30:00Z" },
      { tx: fakeTx(), orgId: CAL },
    )
    expect(s.title).toBe('Update "Pricing sync"')
    expect(s.lines).toContain("New time: 2026-12-02T11:00:00Z to 2026-12-02T11:30:00Z")
    expect(s.lines).toContain("Calendar: Team calendar")
  })

  it("a lookup that fails leaves its line out and never throws", async () => {
    const s = await summarizeDeleteEvent(
      { eventId: "not-an-id" },
      { tx: fakeTx({ fail: true }), orgId: CAL },
    )
    expect(s.title).toBe("Delete a calendar event")
    expect(s.lines).toEqual(["Nobody is emailed."])
  })
})
