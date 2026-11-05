// SPDX-License-Identifier: FSL-1.1-ALv2
// Task 7 — agent tools: visibility RLS boundary (real DB), recurrence window expansion,
// create-via-tool parity, schema/attendee validation.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { getCalendarById, onAccountConnected, runCalendarImport } from "~/apps/calendar/sync"
import {
  expandRecurringEvent,
  isWellFormedEmail,
  listAccountsForCaller,
  listCalendarsForCaller,
  listEventsForCaller,
  resolveConferenceIntent,
  searchEventsForCaller,
} from "~/apps/calendar/tools"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgId: string
let userAId: string
let userBId: string

async function registerCalendarSchema() {
  const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
  const { resetAppRegistries } = await import("~/modules/apps/app-registries")
  const { registerApps } = await import("~/modules/apps/runtime")
  resetAppRegistries()
  await withSystemDb("calendar-tools-fixture-reg", async (tx) => {
    await tx.execute(
      drizzleSql`DELETE FROM kernel.apps WHERE org_id = ${orgId}::uuid AND name = 'calendar'`,
    )
  })
  const { setDeclaredEmits } = await import("~/modules/apps/app-registries")
  setDeclaredEmits(
    "*",
    "kernel",
    new Set(["connected_account:create", "connected_account:disconnect"]),
  )
  await registerApps([calendarAppManifest as any], orgId)
}

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-tools-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("calendar-tools-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Calendar Tools Org', ${slug})
      RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
    const ua = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`usera-${slug}@x.test`}, 'User A', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userAId = (ua.rows ?? ua)[0].id
    const ub = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`userb-${slug}@x.test`}, 'User B', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userBId = (ub.rows ?? ub)[0].id
  })
  await registerCalendarSchema()
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

async function grantsForUser(userId: string): Promise<Record<string, string[]>> {
  return withSystemDb("calendar-tools-grants", async (tx) => {
    const rows = (await tx.execute(drizzleSql`
      SELECT dimension_key, dimension_values FROM kernel.user_dimension_grants
      WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid
    `)) as any
    const list = rows.rows ?? rows
    const grants: Record<string, string[]> = {}
    for (const r of list as Array<{ dimension_key: string; dimension_values: string[] }>) {
      grants[r.dimension_key] = r.dimension_values
    }
    return grants
  })
}

describe("calendar agent tools", () => {
  it("personal calendar visibility: user A cannot list/see user B's personal events; org events visible to both", async () => {
    // User A connects a PERSONAL account.
    const personalAccountId = await withSystemDb("calendar-tools-personal-a", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userAId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "user",
            ownerId: userAId,
            identifier: `tools-personal-${crypto.randomUUID()}@gmail.com`,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-personal" }],
        async () => {},
      )
      const calendarId = calendarIds[0]!
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'A private event',
                '{"dateTime":"2026-07-06T09:00:00Z"}'::jsonb, '{"dateTime":"2026-07-06T09:30:00Z"}'::jsonb, ${accountId})
      `)
      return accountId
    })

    // Org-wide account (org connect) — visible to everyone.
    const orgAccountId = await withSystemDb("calendar-tools-org", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userAId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "org",
            ownerId: null,
            identifier: `tools-org-${crypto.randomUUID()}@gmail.com`,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-org" }],
        async () => {},
      )
      const calendarId = calendarIds[0]!
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'Org all-hands',
                '{"dateTime":"2026-07-06T12:00:00Z"}'::jsonb, '{"dateTime":"2026-07-06T13:00:00Z"}'::jsonb, ${accountId})
      `)
      return accountId
    })

    const grantsA = await grantsForUser(userAId)
    const grantsB = await grantsForUser(userBId)
    expect(grantsA["calendar:calaccess"]).toContain(personalAccountId)
    expect(grantsA["calendar:calaccess"]).toContain(orgAccountId)
    expect(grantsB["calendar:calaccess"] ?? []).not.toContain(personalAccountId)
    expect(grantsB["calendar:calaccess"] ?? []).toContain(orgAccountId)

    const windowParams = { timeMin: "2026-07-06T00:00:00Z", timeMax: "2026-07-07T00:00:00Z" }

    const eventsForA = await withRlsContext(
      {
        actorType: "user",
        userId: userAId,
        orgId,
        scopes: ["calendar:events:read"],
        dimensionGrants: grantsA,
      },
      (tx) => listEventsForCaller(tx, orgId, windowParams),
    )
    const titlesForA = eventsForA.map((e) => e.title)
    expect(titlesForA).toContain("A private event")
    expect(titlesForA).toContain("Org all-hands")

    const eventsForB = await withRlsContext(
      {
        actorType: "user",
        userId: userBId,
        orgId,
        scopes: ["calendar:events:read"],
        dimensionGrants: grantsB,
      },
      (tx) => listEventsForCaller(tx, orgId, windowParams),
    )
    const titlesForB = eventsForB.map((e) => e.title)
    expect(titlesForB).not.toContain("A private event")
    expect(titlesForB).toContain("Org all-hands")
  })

  it("list_events exposes hangoutLink persisted on the row", async () => {
    const calendarId = await withSystemDb("calendar-tools-hangout-setup", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userAId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "org",
            ownerId: null,
            identifier: `tools-hangout-${crypto.randomUUID()}@gmail.com`,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-hangout-tools" }],
        async () => {},
      )
      const calId = calendarIds[0]!
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", hangout_link, calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${calId}::uuid, 'Meet-linked planning',
                '{"dateTime":"2026-07-06T14:00:00Z"}'::jsonb, '{"dateTime":"2026-07-06T14:30:00Z"}'::jsonb,
                'https://meet.google.com/tools-test-link', ${accountId})
      `)
      return calId
    })

    const events = await withRlsContext(
      {
        actorType: "user",
        userId: userAId,
        orgId,
        scopes: ["calendar:events:read"],
        dimensionGrants: await grantsForUser(userAId),
      },
      (tx) =>
        listEventsForCaller(tx, orgId, {
          calendarId,
          timeMin: "2026-07-06T00:00:00Z",
          timeMax: "2026-07-07T00:00:00Z",
        }),
    )
    const meetEvent = events.find((e) => e.title === "Meet-linked planning")
    expect(meetEvent?.hangoutLink).toBe("https://meet.google.com/tools-test-link")
  })

  it("list_events and search_events return the event's attendees", async () => {
    const attendees = [
      {
        email: "dana@acme.example",
        displayName: "Dana Girard",
        responseStatus: "needsAction",
        organizer: true,
        self: false,
        optional: true,
        comment: "not part of the DTO",
      },
      "legacy@example.com",
    ]
    const calendarId = await withSystemDb("calendar-tools-attendees-setup", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userAId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "org",
            ownerId: null,
            identifier: `tools-attendees-${crypto.randomUUID()}@gmail.com`,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-attendees-tools" }],
        async () => {},
      )
      const calId = calendarIds[0]!
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", attendees, calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${calId}::uuid, 'Attendee review',
                '{"dateTime":"2026-07-08T14:00:00Z"}'::jsonb, '{"dateTime":"2026-07-08T14:30:00Z"}'::jsonb,
                ${JSON.stringify(attendees)}::jsonb, ${accountId})
      `)
      return calId
    })
    const ctx = {
      actorType: "user" as const,
      userId: userAId,
      orgId,
      scopes: ["calendar:events:read"],
      dimensionGrants: await grantsForUser(userAId),
    }
    const expected = [
      {
        email: "dana@acme.example",
        displayName: "Dana Girard",
        responseStatus: "needsAction",
        organizer: true,
        self: false,
        optional: true,
      },
      { email: "legacy@example.com" },
    ]
    const events = await withRlsContext(ctx, (tx) =>
      listEventsForCaller(tx, orgId, {
        calendarId,
        timeMin: "2026-07-08T00:00:00Z",
        timeMax: "2026-07-09T00:00:00Z",
      }),
    )
    expect(events.find((e) => e.title === "Attendee review")?.attendees).toEqual(expected)
    const hits = await withRlsContext(ctx, (tx) =>
      searchEventsForCaller(tx, orgId, "Attendee review"),
    )
    expect((hits[0] as { attendees?: unknown }).attendees).toEqual(expected)
  })

  it("an event this account does not organize is not attendee-editable unless guests may modify it", async () => {
    const calendarId = await withSystemDb("calendar-tools-editable-setup", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userAId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "org",
            ownerId: null,
            identifier: `tools-editable-${crypto.randomUUID()}@gmail.com`,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-editable-tools" }],
        async () => {},
      )
      const calId = calendarIds[0]!
      for (const [title, organizerSelf, guestsCanModify] of [
        ["Mine", true, null],
        ["Theirs locked", false, false],
        ["Theirs open", false, true],
        ["Local only", null, null],
      ] as const) {
        await tx.execute(drizzleSql`
          INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", organizer_self, guests_can_modify, calaccess)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${calId}::uuid, ${title},
                  '{"dateTime":"2026-07-09T14:00:00Z"}'::jsonb, '{"dateTime":"2026-07-09T14:30:00Z"}'::jsonb,
                  ${organizerSelf}::boolean, ${guestsCanModify}::boolean, ${accountId})
        `)
      }
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", push_error, calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${calId}::uuid, 'Refused',
                '{"dateTime":"2026-07-09T15:00:00Z"}'::jsonb, '{"dateTime":"2026-07-09T15:30:00Z"}'::jsonb,
                'Invalid attendee email.', ${accountId})
      `)
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", push_notice, calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${calId}::uuid, 'Delete refused',
                '{"dateTime":"2026-07-09T16:00:00Z"}'::jsonb, '{"dateTime":"2026-07-09T16:30:00Z"}'::jsonb,
                'deleting this event: You need to have writer access to this calendar.', ${accountId})
      `)
      return calId
    })
    const events = await withRlsContext(
      {
        actorType: "user",
        userId: userAId,
        orgId,
        scopes: ["calendar:events:read"],
        dimensionGrants: await grantsForUser(userAId),
      },
      (tx) =>
        listEventsForCaller(tx, orgId, {
          calendarId,
          timeMin: "2026-07-09T00:00:00Z",
          timeMax: "2026-07-10T00:00:00Z",
        }),
    )
    const editable = Object.fromEntries(events.map((e) => [e.title, e.attendeesEditable]))
    expect(editable).toEqual({
      Mine: true,
      "Theirs locked": false,
      "Theirs open": true,
      "Local only": true,
      Refused: true,
      "Delete refused": true,
    })
    // Google's refusal of the last change is part of the event, for the dialog.
    expect(events.find((e) => e.title === "Refused")?.pushError).toBe("Invalid attendee email.")
    expect(events.find((e) => e.title === "Mine")?.pushError).toBeNull()
    expect(events.find((e) => e.title === "Mine")?.pushNotice).toBeNull()
    expect(events.find((e) => e.title === "Delete refused")?.pushNotice).toBe(
      "deleting this event: You need to have writer access to this calendar.",
    )
  })

  it("update_event tells the caller attendees is the complete list and that nobody is emailed", async () => {
    const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
    const description = (calendarAppManifest as any).tools.update_event.description as string
    expect(description).toContain("COMPLETE guest list")
    expect(description).toContain("omit it to keep the current guests")
    expect(description).toContain("No invitation or update email is sent")
  })

  it("search respects the same RLS visibility boundary", async () => {
    const grantsB = await grantsForUser(userBId)
    const results = await withRlsContext(
      {
        actorType: "user",
        userId: userBId,
        orgId,
        scopes: ["calendar:events:read"],
        dimensionGrants: grantsB,
      },
      (tx) => searchEventsForCaller(tx, orgId, "private"),
    )
    expect(results.find((r) => r.title === "A private event")).toBeUndefined()
  })

  it("recurrence window expansion: a weekly event with 8 occurrences, window covers exactly 3 (straddling start, inside, straddling end)", () => {
    const master = {
      id: "master-1",
      calendar_id: "cal-1",
      title: "Weekly Standup",
      description: null,
      location: null,
      start: { dateTime: "2026-07-01T09:00:00.000Z" },
      end: { dateTime: "2026-07-01T09:30:00.000Z" },
      all_day: false,
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=8"],
      recurring_event_id: null,
      original_start_time: null,
      status: "confirmed",
    }
    // Occurrences: 07-01, 07-08, 07-15, 07-22, 07-29, 08-05, 08-12, 08-19.
    // Window straddles start of 07-15 occurrence and end of 07-29 occurrence, fully covers 07-22.
    const windowStart = new Date("2026-07-15T09:15:00.000Z") // mid-occurrence of 07-15 (straddles start)
    const windowEnd = new Date("2026-07-29T09:15:00.000Z") // mid-occurrence of 07-29 (straddles end)
    const occurrences = expandRecurringEvent(master, [], windowStart, windowEnd)
    const starts = occurrences.map((o) => (o.start as { dateTime: string }).dateTime)
    expect(starts).toEqual([
      "2026-07-15T09:00:00.000Z",
      "2026-07-22T09:00:00.000Z",
      "2026-07-29T09:00:00.000Z",
    ])
  })

  it("rejects a malformed attendee email at the tool boundary", () => {
    expect(isWellFormedEmail("not-an-email")).toBe(false)
    expect(isWellFormedEmail("valid@example.com")).toBe(true)
  })

  it("conference intent: google_meet adds, none removes, and a product name in location becomes a real Meet", () => {
    expect(resolveConferenceIntent({ conference: "google_meet" }, "create")).toEqual({
      conference: "add",
      location: undefined,
    })
    expect(resolveConferenceIntent({}, "create")).toEqual({
      conference: undefined,
      location: undefined,
    })
    // On create there is nothing to remove.
    expect(resolveConferenceIntent({ conference: "none" }, "create").conference).toBeUndefined()
    expect(resolveConferenceIntent({ conference: "none" }, "update").conference).toBe("remove")
    // "Google Meet" typed into location is not a link: it becomes a conference request, and the
    // location is dropped (on update it is cleared, since it held only the product name).
    expect(resolveConferenceIntent({ location: "Google Meet" }, "create")).toEqual({
      conference: "add",
      location: undefined,
    })
    expect(resolveConferenceIntent({ location: " google meet " }, "update")).toEqual({
      conference: "add",
      location: "",
    })
    expect(resolveConferenceIntent({ location: "Hangouts Meet" }, "create").conference).toBe("add")
    // A real place, or an explicit link, is kept as it is.
    expect(resolveConferenceIntent({ location: "Room 4" }, "create")).toEqual({
      conference: undefined,
      location: "Room 4",
    })
    expect(
      resolveConferenceIntent({ location: "https://meet.google.com/abc-defg-hij" }, "create"),
    ).toEqual({ conference: undefined, location: "https://meet.google.com/abc-defg-hij" })
    expect(() => resolveConferenceIntent({ conference: "zoom" }, "create")).toThrow(/google_meet/)
  })

  it("resolves the Google 'primary' alias to the account's primary calendar (no 22P02 uuid crash)", async () => {
    // Regression (prod alert: WHERE id=$::uuid with param 'primary' -> 22P02): agents (and Google's
    // own API) address the default calendar as the literal 'primary'; it must resolve to a concrete
    // row BEFORE the uuid-typed query. Google's primary calendar is the one whose calendar id equals
    // the account email, so import an entry whose id == the account identifier email.
    const primaryEmail = `primary-${crypto.randomUUID()}@gmail.com`
    let primaryAccountId = ""
    const primaryCalId = await withSystemDb("calendar-tools-primary-setup", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userAId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "org",
            ownerId: null,
            identifier: primaryEmail,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        // The primary calendar's Google id IS the account email; a second, non-primary calendar.
        async () => [{ id: primaryEmail }, { id: "gcal-secondary" }],
        async () => {},
      )
      primaryAccountId = accountId
      // Return the primary calendar's uuid (the one whose google id is the email).
      const rows = (await tx.execute(drizzleSql`
        SELECT id FROM app_calendar.calendars
        WHERE org_id = ${orgId}::uuid AND google_calendar_id = ${primaryEmail}
      `)) as any
      return (rows.rows ?? rows)[0].id as string
    })

    // Ensure the caller holds calaccess for the primary account (the real prod
    // fan-out grants org-account access to active members; make it deterministic).
    await withSystemDb("calendar-tools-primary-grant", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_dimension_grants (id, user_id, org_id, dimension_key, dimension_values)
        VALUES (gen_random_uuid(), ${userAId}::uuid, ${orgId}::uuid, 'calendar:calaccess', ${JSON.stringify([primaryAccountId])}::jsonb)
        ON CONFLICT (user_id, org_id, dimension_key) DO UPDATE
          SET dimension_values = kernel.user_dimension_grants.dimension_values || ${JSON.stringify([primaryAccountId])}::jsonb
      `)
    })

    const grantsA = await grantsForUser(userAId)
    // Resolving 'primary' reads the calendars + accounts tables, whose RLS requires these
    // read scopes (see the member-role regression note below), not just events:read.
    const actorCtx = {
      actorType: "user" as const,
      userId: userAId,
      orgId,
      scopes: ["calendar:events:read", "calendar:calendars:read", "calendar:accounts:read"],
      dimensionGrants: grantsA,
    }

    // getCalendarById('primary') resolves to the primary row, not a uuid-cast crash.
    const resolved = await withRlsContext(actorCtx, (tx) => getCalendarById(tx, orgId, "primary"))
    expect(resolved?.id).toBe(primaryCalId)

    // list_events with calendarId='primary' must run cleanly (would 22P02 before the fix).
    const events = await withRlsContext(actorCtx, (tx) =>
      listEventsForCaller(tx, orgId, {
        calendarId: "primary",
        timeMin: "2026-07-06T00:00:00Z",
        timeMax: "2026-07-07T00:00:00Z",
      }),
    )
    expect(Array.isArray(events)).toBe(true)
  })

  // The primary-alias rejections (none/ambiguous) are agent-correctable input
  // errors: they must carry a typed 4xx status + code so execute-tool logs them
  // at warn (a plain Error there pages the prod watchdog as a critical).
  it("primary-alias rejection throws a typed 422 invalid_params, not a plain Error", async () => {
    // Second connected account whose primary calendar also exists -> "primary" ambiguous.
    // Provisioned through the same real connect+import path as the first fixture.
    const secondEmail = `primary2-${crypto.randomUUID()}@gmail.com`
    await withSystemDb("calendar-tools-primary-ambiguous-setup", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userAId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "org",
            ownerId: null,
            identifier: secondEmail,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: secondEmail }],
        async () => {},
      )
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_dimension_grants (id, user_id, org_id, dimension_key, dimension_values)
        VALUES (gen_random_uuid(), ${userAId}::uuid, ${orgId}::uuid, 'calendar:calaccess', ${JSON.stringify([accountId])}::jsonb)
        ON CONFLICT (user_id, org_id, dimension_key) DO UPDATE
          SET dimension_values = kernel.user_dimension_grants.dimension_values || ${JSON.stringify([accountId])}::jsonb
      `)
    })
    // Grants must be read AFTER the second account's calaccess grant lands, or
    // RLS hides the second primary and "primary" resolves unambiguously.
    const actorCtx = {
      actorType: "user" as const,
      userId: userAId,
      orgId,
      scopes: ["calendar:events:read", "calendar:calendars:read", "calendar:accounts:read"],
      dimensionGrants: await grantsForUser(userAId),
    }
    let thrown: any
    try {
      await withRlsContext(actorCtx, (tx) => getCalendarById(tx, orgId, "primary"))
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeDefined()
    expect(thrown.status).toBe(422)
    expect(thrown.code).toBe("invalid_params")
    expect(String(thrown.message)).toContain("ambiguous")
  })
})

// Regression (found by agent-calendar.scenario.test.ts, 2026-07-03): the member role bundle
// granted only calendar:events:* while the generated RLS on the calendars/accounts tables
// independently requires calendar:calendars:*/calendar:accounts:* — so a plain member could
// never list calendars or accounts. The member bundle now carries the read scopes; this test
// derives the caller's scopes FROM THE MANIFEST so any future bundle regression fails here.
describe("member role bundle can read calendars and accounts", () => {
  it("listCalendarsForCaller + listAccountsForCaller work with exactly the member scopes", async () => {
    const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
    const memberScopes = (calendarAppManifest as any).roles.member.scopes as string[]
    expect(memberScopes).toContain("calendar:calendars:read")
    expect(memberScopes).toContain("calendar:accounts:read")

    const { listAccountsForCaller, listCalendarsForCaller } = await import("~/apps/calendar/tools")

    await withSystemDb("calendar-tools-member-role", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userAId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "org",
            ownerId: userAId,
            identifier: `member-role-${crypto.randomUUID()}@x.test`,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "member-role-cal", summary: "Org calendar" }],
        async () => {},
      )
    })

    const grantsB = await grantsForUser(userBId)
    const asMember = {
      actorType: "user" as const,
      userId: userBId,
      orgId,
      scopes: memberScopes,
      dimensionGrants: grantsB,
    }
    const calendars = await withRlsContext(asMember, (tx) => listCalendarsForCaller(tx, orgId))
    expect(calendars.map((c) => c.name)).toContain("Org calendar")

    const accounts = await withRlsContext(asMember, (tx) => listAccountsForCaller(tx, orgId))
    expect(accounts.some((a) => a.identifier.startsWith("member-role-"))).toBe(true)

    // Sanity: with ONLY the old events scopes the same reads return nothing (RLS gate).
    const asOldMember = { ...asMember, scopes: ["calendar:events:read", "calendar:events:write"] }
    const calendarsOld = await withRlsContext(asOldMember, (tx) =>
      listCalendarsForCaller(tx, orgId),
    )
    expect(calendarsOld.map((c) => c.name)).not.toContain("Org calendar")
  })

  it("a personal account, its calendars, events and sync log stay owner-only even for an admin holding wildcard scopes and dimensions", async () => {
    const tag = crypto.randomUUID()
    const { personalAccountId, personalCalendarId, orgAccountId } = await withSystemDb(
      "calendar-tools-wildcard-setup",
      async (tx) => {
        const connect = async (ownerType: "user" | "org", identifier: string, gcal: string) => {
          const { accountId } = await onAccountConnected(
            tx as any,
            orgId,
            {
              orgId,
              actorId: userAId,
              data: {
                id: crypto.randomUUID(),
                appName: "calendar",
                ownerType,
                ownerId: ownerType === "user" ? userAId : null,
                identifier,
                connectionName: "google-calendar",
              },
            },
            async () => {},
          )
          const { calendarIds } = await runCalendarImport(
            tx as any,
            orgId,
            accountId,
            async () => [{ id: gcal, summary: `cal-${gcal}` }],
            async () => {},
          )
          const calendarId = calendarIds[0]!
          await tx.execute(drizzleSql`
            INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", calaccess)
            VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, ${`evt-${gcal}`},
                    '{"dateTime":"2026-07-09T09:00:00Z"}'::jsonb, '{"dateTime":"2026-07-09T09:30:00Z"}'::jsonb, ${accountId})
          `)
          await tx.execute(drizzleSql`
            INSERT INTO app_calendar.sync_log (id, org_id, calendar_id, operation, status, detail, calaccess)
            VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'push', 'error', ${`log-${gcal}`}, ${accountId})
          `)
          return { accountId, calendarId }
        }
        const personal = await connect(
          "user",
          `wild-personal-${tag}@gmail.com`,
          `wild-personal-${tag}`,
        )
        const org = await connect("org", `wild-org-${tag}@gmail.com`, `wild-org-${tag}`)
        return {
          personalAccountId: personal.accountId,
          personalCalendarId: personal.calendarId,
          orgAccountId: org.accountId,
        }
      },
    )

    // User B is an org admin: every scope and the wildcard dimension grant.
    const asAdmin = {
      actorType: "user" as const,
      userId: userBId,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    const windowParams = { timeMin: "2026-07-09T00:00:00Z", timeMax: "2026-07-10T00:00:00Z" }

    const accounts = await withRlsContext(asAdmin, (tx) => listAccountsForCaller(tx, orgId))
    expect(accounts.map((a) => a.id)).not.toContain(personalAccountId)
    expect(accounts.map((a) => a.id)).toContain(orgAccountId)

    const calendars = await withRlsContext(asAdmin, (tx) => listCalendarsForCaller(tx, orgId))
    expect(calendars.map((c) => c.id)).not.toContain(personalCalendarId)
    expect(calendars.map((c) => c.name)).toContain(`cal-wild-org-${tag}`)

    const events = await withRlsContext(asAdmin, (tx) =>
      listEventsForCaller(tx, orgId, windowParams),
    )
    expect(events.map((e) => e.title)).not.toContain(`evt-wild-personal-${tag}`)
    expect(events.map((e) => e.title)).toContain(`evt-wild-org-${tag}`)

    const found = await withRlsContext(asAdmin, (tx) =>
      searchEventsForCaller(tx, orgId, "evt-wild"),
    )
    expect(found.map((e) => e.title)).not.toContain(`evt-wild-personal-${tag}`)

    const logs = await withRlsContext(asAdmin, async (tx) => {
      const r = (await tx.execute(
        drizzleSql`SELECT detail FROM app_calendar.sync_log WHERE detail LIKE ${`log-wild-%-${tag}`}`,
      )) as any
      return ((r.rows ?? r) as Array<{ detail: string }>).map((x) => x.detail)
    })
    expect(logs).toEqual([`log-wild-org-${tag}`])

    // The admin cannot write the personal rows either (UPDATE silently matches 0 rows).
    const updated = await withRlsContext(asAdmin, async (tx) => {
      const r = (await tx.execute(drizzleSql`
        UPDATE app_calendar.accounts SET display_name = 'hijacked'
        WHERE id = ${personalAccountId}::uuid RETURNING id
      `)) as any
      return (r.rows ?? r).length
    })
    expect(updated).toBe(0)

    // The owner still sees all of their personal data, wildcard grants or not.
    const asOwner = {
      actorType: "user" as const,
      userId: userAId,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    const ownerAccounts = await withRlsContext(asOwner, (tx) => listAccountsForCaller(tx, orgId))
    expect(ownerAccounts.map((a) => a.id)).toContain(personalAccountId)
    const ownerEvents = await withRlsContext(asOwner, (tx) =>
      listEventsForCaller(tx, orgId, windowParams),
    )
    expect(ownerEvents.map((e) => e.title)).toContain(`evt-wild-personal-${tag}`)
  })
})

// LIF-31: ended series showed every week, exceptions never applied, and one week's read
// shipped every master and exception of the org (one exception query per master).
describe("list_events reads only what the window needs", () => {
  const week = { timeMin: "2026-10-12T00:00:00Z", timeMax: "2026-10-19T00:00:00Z" }

  async function seedSeriesFixture(tag: string) {
    return withSystemDb("calendar-tools-window-setup", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userAId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "user",
            ownerId: userAId,
            identifier: `window-${tag}@x.test`,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [
          { id: `window-main-${tag}`, summary: `Main ${tag}` },
          { id: `window-off-${tag}`, summary: `Unticked ${tag}` },
        ],
        async () => {},
      )
      const [calendarId, offCalendarId] = calendarIds as [string, string]
      await tx.execute(drizzleSql`
        UPDATE app_calendar.calendars SET selected = false WHERE id = ${offCalendarId}::uuid
      `)
      const insert = async (row: {
        title: string
        googleId?: string
        start?: object | null
        end?: object | null
        recurrence?: string[]
        recurringEventId?: string
        originalStart?: object
        status?: string
        allDay?: boolean
      }) => {
        await tx.execute(drizzleSql`
          INSERT INTO app_calendar.events
            (id, org_id, calendar_id, google_event_id, title, start, "end", recurrence,
             recurring_event_id, original_start_time, status, all_day, calaccess)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, ${row.googleId ?? null},
                  ${`${row.title} ${tag}`},
                  ${row.start ? JSON.stringify(row.start) : null}::jsonb,
                  ${row.end ? JSON.stringify(row.end) : null}::jsonb,
                  ${row.recurrence ? JSON.stringify(row.recurrence) : null}::jsonb,
                  ${row.recurringEventId ?? null},
                  ${row.originalStart ? JSON.stringify(row.originalStart) : null}::jsonb,
                  ${row.status ?? "confirmed"}, ${row.allDay ?? false}, ${accountId})
        `)
      }
      const paris = (dateTime: string) => ({ dateTime, timeZone: "Europe/Paris" })
      await insert({
        title: "plain-in",
        googleId: `plainin${tag}`,
        start: { dateTime: "2026-10-14T10:00:00Z" },
        end: { dateTime: "2026-10-14T11:00:00Z" },
      })
      await insert({
        title: "plain-out",
        googleId: `plainout${tag}`,
        start: { dateTime: "2025-03-01T10:00:00Z" },
        end: { dateTime: "2025-03-01T11:00:00Z" },
      })
      await insert({
        title: "ended-until",
        googleId: `ended${tag}`,
        start: paris("2021-01-04T09:00:00+01:00"),
        end: paris("2021-01-04T10:00:00+01:00"),
        recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20210602T215959Z"],
      })
      await insert({
        title: "ended-exception",
        googleId: `ended${tag}_20210301T080000Z`,
        recurringEventId: `ended${tag}`,
        originalStart: paris("2021-03-01T09:00:00+01:00"),
        status: "cancelled",
      })
      // A weekly five-day all-day block whose last occurrence (06-11 Jan 2025) starts on its
      // UNTIL day and runs past it.
      await insert({
        title: "long-block",
        googleId: `longblock${tag}`,
        start: { date: "2024-12-30" },
        end: { date: "2025-01-04" },
        recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20250106"],
        allDay: true,
      })
      await insert({
        title: "ended-count",
        googleId: `counted${tag}`,
        start: { dateTime: "2020-01-01T08:00:00Z" },
        end: { dateTime: "2020-01-01T08:30:00Z" },
        recurrence: ["RRULE:FREQ=DAILY;COUNT=10"],
      })
      await insert({
        title: "active",
        googleId: `active${tag}`,
        start: paris("2025-01-06T09:00:00+01:00"),
        end: paris("2025-01-06T10:00:00+01:00"),
        recurrence: ["RRULE:FREQ=WEEKLY"],
      })
      await insert({
        title: "cancelled-in",
        googleId: `active${tag}_20261012T070000Z`,
        recurringEventId: `active${tag}`,
        originalStart: paris("2026-10-12T09:00:00+02:00"),
        status: "cancelled",
      })
      await insert({
        title: "moved-in",
        googleId: `active${tag}_20261005T070000Z`,
        recurringEventId: `active${tag}`,
        originalStart: paris("2026-10-05T09:00:00+02:00"),
        start: paris("2026-10-16T09:00:00+02:00"),
        end: paris("2026-10-16T10:00:00+02:00"),
      })
      await insert({
        title: "old-exception",
        googleId: `active${tag}_20250203T080000Z`,
        recurringEventId: `active${tag}`,
        originalStart: paris("2025-02-03T09:00:00+01:00"),
        start: paris("2025-02-03T15:00:00+01:00"),
        end: paris("2025-02-03T16:00:00+01:00"),
      })
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${offCalendarId}::uuid, ${`unticked ${tag}`},
                '{"dateTime":"2026-10-14T12:00:00Z"}'::jsonb, '{"dateTime":"2026-10-14T13:00:00Z"}'::jsonb,
                ${accountId})
      `)
      return { calendarId, offCalendarId }
    })
  }

  it("returns in-window plain events, live series and the exceptions touching the window, in three queries", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    await seedSeriesFixture(tag)
    const grants = await grantsForUser(userAId)
    let queries = 0
    const events = await withRlsContext(
      {
        actorType: "user",
        userId: userAId,
        orgId,
        scopes: ["calendar:calendars:read", "calendar:events:read"],
        dimensionGrants: grants,
      },
      (tx) => {
        const counting = new Proxy(tx, {
          get(target, key) {
            const value = Reflect.get(target, key)
            if (key === "execute") {
              return (...args: unknown[]) => {
                queries++
                return (value as (...a: unknown[]) => unknown).apply(target, args)
              }
            }
            return typeof value === "function" ? value.bind(target) : value
          },
        })
        return listEventsForCaller(counting, orgId, week)
      },
    )
    const mine = events
      .filter((e) => e.title?.endsWith(` ${tag}`))
      .map((e) => e.title?.replace(` ${tag}`, ""))
      .sort()
    expect(mine).toEqual(["active", "cancelled-in", "moved-in", "plain-in"])
    const master = events.find((e) => e.title === `active ${tag}`)
    expect(master?.googleEventId).toBe(`active${tag}`)
    expect(queries).toBeLessThanOrEqual(3)
  })

  it("leaves a series ended by UNTIL out of the SQL read, and keeps one whose last occurrence runs into the window", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    await seedSeriesFixture(tag)
    const grants = await grantsForUser(userAId)
    const read = async (params: { timeMin: string; timeMax: string }) => {
      const returned: string[] = []
      const events = await withRlsContext(
        {
          actorType: "user",
          userId: userAId,
          orgId,
          scopes: ["calendar:calendars:read", "calendar:events:read"],
          dimensionGrants: grants,
        },
        (tx) => {
          const recording = new Proxy(tx, {
            get(target, key) {
              const value = Reflect.get(target, key)
              if (key === "execute") {
                return async (...args: unknown[]) => {
                  const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(
                    target,
                    args,
                  )
                  const rows = Array.isArray(result)
                    ? result
                    : ((result as { rows?: unknown[] }).rows ?? [])
                  for (const r of rows as Array<{ title?: string }>) {
                    if (r.title) returned.push(r.title)
                  }
                  return result
                }
              }
              return typeof value === "function" ? value.bind(target) : value
            },
          })
          return listEventsForCaller(recording, orgId, params)
        },
      )
      return { returned, titles: events.map((e) => e.title) }
    }

    // The ended master never leaves the database (not merely dropped afterwards).
    const { returned } = await read(week)
    expect(returned).not.toContain(`ended-until ${tag}`)

    const jan = await read({ timeMin: "2025-01-09T00:00:00Z", timeMax: "2025-01-16T00:00:00Z" })
    expect(jan.titles).toContain(`long-block ${tag}`)
  })

  it("lists every calendar of a connected account with its selected flag, for the settings checkboxes", async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const { offCalendarId } = await seedSeriesFixture(tag)
    const grants = await grantsForUser(userAId)
    const calendars = await withRlsContext(
      {
        actorType: "user",
        userId: userAId,
        orgId,
        scopes: ["calendar:calendars:read", "calendar:events:read"],
        dimensionGrants: grants,
      },
      (tx) => listCalendarsForCaller(tx, orgId),
    )
    const off = calendars.find((c) => c.id === offCalendarId)
    expect(off).toBeDefined()
    expect(off?.selected).toBe(false)
    expect(calendars.find((c) => c.name === `Main ${tag}`)?.selected).toBe(true)
  })

  it("expandRecurringEvent reads basic-format UNTIL, keeps wall-clock time across DST and reaches old DAILY series", () => {
    const base = {
      calendar_id: "cal-1",
      title: "Series",
      description: null,
      location: null,
      all_day: false,
      recurring_event_id: null,
      original_start_time: null,
      status: "confirmed",
    }
    const ended = {
      ...base,
      id: "ended",
      start: { dateTime: "2021-01-04T09:00:00+01:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2021-01-04T10:00:00+01:00", timeZone: "Europe/Paris" },
      recurrence: ["RRULE:FREQ=WEEKLY;UNTIL=20210602T215959Z"],
    }
    expect(expandRecurringEvent(ended, [], new Date(week.timeMin), new Date(week.timeMax))).toEqual(
      [],
    )

    const winterStart = {
      ...base,
      id: "dst",
      start: { dateTime: "2026-01-05T09:00:00+01:00", timeZone: "Europe/Paris" },
      end: { dateTime: "2026-01-05T10:00:00+01:00", timeZone: "Europe/Paris" },
      recurrence: ["RRULE:FREQ=WEEKLY"],
    }
    const cancelled = {
      ...base,
      id: "dst-cancelled",
      start: null,
      end: null,
      recurrence: null,
      recurring_event_id: "dst",
      original_start_time: { dateTime: "2026-07-06T09:00:00+02:00" },
      status: "cancelled",
    }
    const july = expandRecurringEvent(
      winterStart,
      [cancelled],
      new Date("2026-07-01T00:00:00Z"),
      new Date("2026-07-15T00:00:00Z"),
    )
    expect(july.map((o) => (o.start as { dateTime: string }).dateTime)).toEqual([
      "2026-07-13T07:00:00.000Z",
    ])

    const oldDaily = {
      ...base,
      id: "old-daily",
      start: { dateTime: "2019-01-07T07:30:00Z" },
      end: { dateTime: "2019-01-07T07:45:00Z" },
      recurrence: ["RRULE:FREQ=DAILY"],
    }
    expect(
      expandRecurringEvent(oldDaily, [], new Date(week.timeMin), new Date(week.timeMax)),
    ).toHaveLength(7)
  })
})
