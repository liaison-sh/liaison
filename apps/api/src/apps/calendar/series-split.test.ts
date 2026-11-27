// SPDX-License-Identifier: FSL-1.1-ALv2
// "This and following" against the stateful fake Google Calendar: an edit or delete of one
// occurrence and every later one splits the series like Google does (the old series ends before
// it, a new series carries the edit), from the first occurrence it is the whole series, and the
// exceptions after the split leave the old series.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { FakeGoogleCalendar } from "~/apps/calendar/__fixtures__/google/fake-google-calendar"
import { createCalendarSyncHarness } from "~/apps/calendar/__fixtures__/google/sync-harness"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const OWNER = "owner@example.test"
// Fixture series: Mondays 09:00 Europe/Paris from 2026-10-19, COUNT=6; the 2 Nov occurrence is
// moved to 11:00 (an exception), the 9 Nov one is cancelled.
const SERIES = "weekly0001"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-series-split-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "Calendar Series Split Org", slug })
  userId = await seedUserRow({
    orgId,
    email: `owner-${slug}@x.test`,
    name: "Owner",
    status: "active",
    passwordHash: "h",
  })
  const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
  const { resetAppRegistries, setDeclaredEmits } = await import("~/modules/apps/app-registries")
  const { registerApps } = await import("~/modules/apps/runtime")
  resetAppRegistries()
  setDeclaredEmits(
    "*",
    "kernel",
    new Set(["connected_account:create", "connected_account:disconnect"]),
  )
  await registerApps([calendarAppManifest], orgId)
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

async function connected() {
  const email = `owner-${crypto.randomUUID().slice(0, 8)}@example.test`
  const google = FakeGoogleCalendar.fromFixtures({ accountEmail: email })
  const h = createCalendarSyncHarness({ orgId, userId, google })
  await h.connect(email)
  await h.drain()
  const master = await h.event(OWNER, SERIES)
  if (!master) throw new Error("fixture series not synced")
  return { google, h, masterId: master.id as string }
}

describe("G14: this and following", () => {
  it("an edit from an occurrence on splits the series in Google and here", async () => {
    const { google, h, masterId } = await connected()
    const result = (await h.tool("update_event", {
      eventId: masterId,
      scope: "following",
      occurrenceStart: "2026-11-16T08:00:00.000Z",
      title: "Weekly sync (new format)",
      start: "2026-11-16T09:00:00.000Z",
      end: "2026-11-16T09:30:00.000Z",
    })) as { eventId: string; scope: string; previousSeriesId: string }
    expect(result.scope).toBe("following")
    expect(result.previousSeriesId).toBe(masterId)
    expect(result.eventId).not.toBe(masterId)
    await h.drain()

    // The old series ends with its fourth occurrence (COUNT shared between the two series).
    expect(google.getEvent(OWNER, SERIES)?.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4",
    ])
    expect(google.getEvent(OWNER, SERIES)?.summary).toBe("Weekly sync")
    // The new series starts at the moved time, with the rest of the COUNT and a time zone.
    const inserted = google
      .listEvents(OWNER)
      .find((e) => e.summary === "Weekly sync (new format)" && e.recurrence)
    expect(inserted?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2"])
    expect(new Date(inserted?.start?.dateTime as string).toISOString()).toBe(
      "2026-11-16T09:00:00.000Z",
    )
    expect(inserted?.start?.timeZone).toBe("Europe/Paris")
    const row = (await h.events(OWNER)).find((r) => r.id === result.eventId)
    expect(row?.pending_push).toBe("none")
    expect(row?.google_event_id).toBe(inserted?.id)
    expect(google.unhandled).toEqual([])
  })

  it("from an edited occurrence: its exceptions move out, a cancelled one stays cancelled", async () => {
    const { google, h, masterId } = await connected()
    const moved = await h.event(OWNER, `${SERIES}_20261102T080000Z`)
    const result = (await h.tool("update_event", {
      eventId: moved?.id,
      scope: "following",
      title: "Weekly sync (renamed)",
    })) as { eventId: string; scope: string }
    expect(result.scope).toBe("following")
    await h.drain()

    expect(google.getEvent(OWNER, SERIES)?.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2",
    ])
    const inserted = google
      .listEvents(OWNER)
      .find((e) => e.summary === "Weekly sync (renamed)" && e.recurrence)
    // Starts at the occurrence's original slot, keeps the 9 Nov cancellation.
    expect(inserted?.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4",
      "EXDATE:20261109T080000Z",
    ])
    expect(new Date(inserted?.start?.dateTime as string).toISOString()).toBe(
      "2026-11-02T08:00:00.000Z",
    )
    const rows = await h.events(OWNER)
    expect(rows.filter((r) => r.recurring_event_id === SERIES)).toEqual([])
    expect(rows.find((r) => r.id === masterId)?.title).toBe("Weekly sync")
  })

  it("delete from an occurrence on ends the series before it", async () => {
    const { google, h, masterId } = await connected()
    const result = (await h.tool("delete_event", {
      eventId: masterId,
      scope: "following",
      occurrenceStart: "2026-11-23T08:00:00.000Z",
    })) as { scope: string }
    expect(result.scope).toBe("following")
    await h.drain()
    expect(google.getEvent(OWNER, SERIES)?.status).toBe("confirmed")
    expect(google.getEvent(OWNER, SERIES)?.recurrence).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5",
    ])
    expect(google.requestsFor("events.insert")).toHaveLength(0)
  })

  it("from the first occurrence it is the whole series", async () => {
    const { google, h, masterId } = await connected()
    const result = (await h.tool("update_event", {
      eventId: masterId,
      scope: "following",
      occurrenceStart: "2026-10-19T07:00:00.000Z",
      title: "Weekly sync (all)",
    })) as { eventId: string; scope: string }
    expect(result).toMatchObject({ eventId: masterId, scope: "series" })
    await h.drain()
    expect(google.getEvent(OWNER, SERIES)?.summary).toBe("Weekly sync (all)")
    expect(google.requestsFor("events.insert")).toHaveLength(0)
  })

  it("a recurring meeting without a scope names the three choices; a wrong start is refused", async () => {
    const { h, masterId } = await connected()
    await expect(h.tool("update_event", { eventId: masterId, title: "x" })).rejects.toThrow(
      /"following"/,
    )
    await expect(
      h.tool("update_event", {
        eventId: masterId,
        scope: "following",
        occurrenceStart: "2026-11-17T08:00:00.000Z",
        title: "x",
      }),
    ).rejects.toThrow(/no occurrence starting/)
  })
})
