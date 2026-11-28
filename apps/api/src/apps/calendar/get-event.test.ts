// SPDX-License-Identifier: FSL-1.1-ALv2
// get_event reads one event by id through the real handler, bridge and database (the event tab
// reopened after a reload), and sync keeps Google's per-event colour.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { FakeGoogleCalendar } from "./__fixtures__/google/fake-google-calendar"
import { createCalendarSyncHarness } from "./__fixtures__/google/sync-harness"

const OWNER = "owner@example.test"
let orgId: string
let userId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-get-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "Calendar Get Event Org", slug })
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

describe("get_event", () => {
  it("reads an event by its local id, a series by its Google id, and keeps its colour", async () => {
    const google = FakeGoogleCalendar.fromFixtures({ accountEmail: OWNER })
    google.updateEvent(OWNER, "timed0001", { colorId: "11" } as never)
    const h = createCalendarSyncHarness({ orgId, userId, google })
    await h.connect(OWNER)
    await h.drain()

    const row = await h.event(OWNER, "timed0001")
    const byId = (await h.tool("get_event", { eventId: row?.id })) as {
      eventId: string
      title: string
      colorId: string | null
    } | null
    expect(byId?.title).toBe("Design review")
    expect(byId?.colorId).toBe("11")

    const series = (await h.tool("get_event", { eventId: "weekly0001" })) as {
      eventId: string
      recurrence: string[] | null
    } | null
    expect(series?.eventId).toBe("weekly0001")
    expect(series?.recurrence?.[0]).toMatch(/^RRULE:/)

    expect(await h.tool("get_event", { eventId: crypto.randomUUID() })).toBeNull()
  })
})
