// SPDX-License-Identifier: FSL-1.1-ALv2
// Invitations and RSVP against the stateful fake Google Calendar: a person sends invitations
// directly (sendUpdates reaches Google), an agent's notifying write or delete waits for a human
// approval and nothing reaches Google before it, and the account's own answer to an invitation
// (yes, no, maybe) is pushed onto its attendee entry.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { FakeGoogleCalendar } from "~/apps/calendar/__fixtures__/google/fake-google-calendar"
import { createCalendarSyncHarness } from "~/apps/calendar/__fixtures__/google/sync-harness"
import { seedConnectedAccountRow } from "~/seed/factories/org/platform-rows"
import { seedOrgRow, seedUserRow } from "~/seed/factories/org/rows"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

const OWNER = "owner@example.test"
const TEAM = "team0001@group.calendar.google.com"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-invitations-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  orgId = await seedOrgRow({ name: "Calendar Invitations Org", slug })
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
  const team = await h.calendar(TEAM)
  return { google, h, email, teamId: team?.id as string }
}

const MEETING = {
  title: "Roadmap review",
  start: "2026-12-01T14:00:00.000Z",
  end: "2026-12-01T15:00:00.000Z",
  attendees: ["guest.one@partner.test", "guest.two@partner.test"],
}

describe("G12 / D3: invitations", () => {
  it("a person sends invitations directly: Google gets sendUpdates=all, once", async () => {
    const { google, h, teamId } = await connected()
    const created = (await h.tool("create_event", {
      ...MEETING,
      calendarId: teamId,
      sendUpdates: "all",
    })) as { eventId: string }
    expect(created.eventId).toBeTruthy()
    expect(h.approvals).toEqual([])
    await h.drain()
    const inserts = google.requestsFor("events.insert")
    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.query.sendUpdates).toBe("all")
    const row = (await h.events(TEAM)).find((r) => r.id === created.eventId)
    expect(row?.send_updates).toBeNull()

    // A later edit without the choice notifies nobody.
    await h.tool("update_event", { eventId: created.eventId, title: "Roadmap review (v2)" })
    await h.drain()
    expect(google.requestsFor("events.update").at(-1)?.query.sendUpdates).toBe("none")
  })

  it("without sendUpdates nobody is emailed and an agent is not stopped", async () => {
    const { google, h, teamId } = await connected()
    h.callAs("agent")
    const created = (await h.tool("create_event", { ...MEETING, calendarId: teamId })) as {
      eventId: string
    }
    expect(created.eventId).toBeTruthy()
    expect(h.approvals).toEqual([])
    await h.drain()
    expect(google.requestsFor("events.insert")[0]?.query.sendUpdates).toBe("none")
  })

  it("a write result says whether guests were emailed and whether the calendar reaches Google", async () => {
    const { h, teamId, email } = await connected()
    h.callAs("agent")
    // No Google credential behind the account (a seeded calendar): Liaison only, nobody emailed.
    const local = (await h.tool("create_event", { ...MEETING, calendarId: teamId })) as Record<
      string,
      unknown
    >
    expect(local).toMatchObject({ google: "not_connected", guestsEmailed: false })
    expect(String(local.notice)).toContain("Liaison only")

    // The account's Google connection is active: the event syncs, the guests were not emailed.
    await seedConnectedAccountRow({
      orgId,
      appName: "calendar",
      connectionName: "google-calendar",
      ownerType: "user",
      ownerId: userId,
      providerType: "oauth2",
      identifier: email,
      status: "active",
      createdBy: userId,
    })
    const synced = (await h.tool("create_event", { ...MEETING, calendarId: teamId })) as Record<
      string,
      unknown
    >
    expect(synced).toMatchObject({ google: "syncing", guestsEmailed: false })
    expect(String(synced.notice)).toContain("NOT emailed")
    const moved = (await h.tool("update_event", {
      eventId: synced.eventId,
      start: "2026-12-01T16:00:00.000Z",
      end: "2026-12-01T17:00:00.000Z",
    })) as Record<string, unknown>
    expect(moved).toMatchObject({ google: "syncing", guestsEmailed: false })
  })

  it("an agent's invitation waits for approval; nothing reaches Google before it", async () => {
    const { google, h, teamId } = await connected()
    h.callAs("agent")
    const parked = (await h.tool("create_event", {
      ...MEETING,
      calendarId: teamId,
      sendUpdates: "all",
    })) as { status: string; approval_id: string }
    expect(parked.status).toBe("pending_approval")
    expect(h.approvals).toHaveLength(1)
    expect(h.approvals[0]?.tool_name).toBe("calendar:create_event")
    expect(h.approvals[0]?.summary).toContain("Roadmap review")
    expect(h.approvals[0]?.summary_detail?.lines?.join("\n")).toContain("guest.one@partner.test")
    expect(h.approvals[0]?.summary_detail?.lines?.join("\n")).toMatch(/^Calendar: \S/m)
    await h.drain()
    expect(google.requestsFor("events.insert")).toHaveLength(0)
    expect((await h.events(TEAM)).some((r) => r.title === "Roadmap review")).toBe(false)

    const approved = (await h.approve(parked.approval_id)) as { eventId: string }
    expect(approved.eventId).toBeTruthy()
    await h.drain()
    const inserts = google.requestsFor("events.insert")
    expect(inserts).toHaveLength(1)
    expect(inserts[0]?.query.sendUpdates).toBe("all")
  })

  it("an agent's delete waits for approval; a person's goes through", async () => {
    const { google, h } = await connected()
    const lunch = await h.event(TEAM, "teamlunch01")
    h.callAs("agent")
    const parked = (await h.tool("delete_event", { eventId: lunch?.id })) as {
      status: string
      approval_id: string
    }
    expect(parked.status).toBe("pending_approval")
    expect(h.approvals[0]?.tool_name).toBe("calendar:delete_event")
    await h.drain()
    expect(google.getEvent(TEAM, "teamlunch01")?.status).toBe("confirmed")

    await h.approve(parked.approval_id)
    await h.drain()
    expect(google.getEvent(TEAM, "teamlunch01")?.status).toBe("cancelled")

    const { google: g2, h: h2 } = await connected()
    const lunch2 = await h2.event(TEAM, "teamlunch01")
    await h2.tool("delete_event", { eventId: lunch2?.id, sendUpdates: "all" })
    expect(h2.approvals).toEqual([])
    await h2.drain()
    const deletes = g2.requestsFor("events.delete")
    expect(deletes).toHaveLength(1)
    expect(deletes[0]?.query.sendUpdates).toBe("all")
  })
})

describe("G12: RSVP", () => {
  it("the account's answer to an invitation reaches its attendee entry on Google", async () => {
    const { google, h, email } = await connected()
    const invite = google.createEvent(OWNER, {
      summary: "Partner sync",
      start: { dateTime: "2026-12-02T10:00:00Z", timeZone: "UTC" },
      end: { dateTime: "2026-12-02T10:30:00Z", timeZone: "UTC" },
      organizer: { email: "boss@partner.test" },
      attendees: [
        { email: "boss@partner.test", organizer: true, responseStatus: "accepted" },
        { email, self: true, responseStatus: "needsAction" },
      ],
    })
    await h.notify(OWNER)
    await h.drain()
    const row = await h.event(OWNER, invite.id)
    const answered = (await h.tool("respond_to_invitation", {
      eventId: row?.id,
      response: "declined",
    })) as { response: string }
    expect(answered.response).toBe("declined")
    await h.drain()
    const attendees = google.getEvent(OWNER, invite.id)?.attendees ?? []
    expect(attendees.find((a) => a.email === email)?.responseStatus).toBe("declined")
    expect(attendees.find((a) => a.email === "boss@partner.test")?.responseStatus).toBe("accepted")
    const after = await h.event(OWNER, invite.id)
    expect(after?.rsvp_request).toBeNull()
  })

  it("an event the account is not a guest of cannot be answered", async () => {
    const { h, teamId } = await connected()
    const own = (await h.tool("create_event", {
      calendarId: teamId,
      title: "Focus time",
      start: "2026-12-03T09:00:00.000Z",
      end: "2026-12-03T10:00:00.000Z",
    })) as { eventId: string }
    await expect(
      h.tool("respond_to_invitation", { eventId: own.eventId, response: "accepted" }),
    ).rejects.toThrow(/only a guest can reply/)
  })
})
