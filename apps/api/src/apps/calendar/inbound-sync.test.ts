// SPDX-License-Identifier: FSL-1.1-ALv2
// Task 4 — inbound sync: initial + incremental, echo suppression, LWW, 410 recovery.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  applyIncrementalSyncPages,
  applyInitialSyncPages,
  getEventByGoogleId,
  onAccountConnected,
  recoverFromSyncTokenGone,
  runCalendarImport,
} from "~/apps/calendar/sync"
import { withSystemDb } from "~/db/privileged"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgId: string
let userId: string

async function registerCalendarSchema() {
  const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
  const { resetAppRegistries } = await import("~/modules/apps/app-registries")
  const { registerApps } = await import("~/modules/apps/runtime")
  resetAppRegistries()
  await withSystemDb("calendar-inbound-fixture-reg", async (tx) => {
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
  const slug = `cal-inbound-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("calendar-inbound-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Calendar Inbound Org', ${slug})
      RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`owner-${slug}@x.test`}, 'Owner', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (u.rows ?? u)[0].id
  })
  await registerCalendarSchema()
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

async function seedCalendar(
  tx: any,
  entries: Array<{ id: string; summary?: string }> = [{ id: "gcal-in" }],
) {
  const event = {
    orgId,
    actorId: userId,
    data: {
      id: crypto.randomUUID(),
      appName: "calendar",
      ownerType: "user" as const,
      ownerId: userId,
      identifier: `inbound-${crypto.randomUUID()}@gmail.com`,
      connectionName: "google-calendar",
    },
  }
  const { accountId } = await onAccountConnected(tx, orgId, event, async () => {})
  const { calendarIds } = await runCalendarImport(
    tx,
    orgId,
    accountId,
    async () => entries,
    async () => {},
  )
  return { accountId, calendarId: calendarIds[0]! }
}

describe("calendar inbound sync", () => {
  it("initial sync persists a timed event, an all-day event, a recurring master, and an exception", async () => {
    await withSystemDb("calendar-initial-basic", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      const items = [
        {
          id: "evt-timed",
          status: "confirmed",
          etag: '"etag-1"',
          summary: "Standup",
          start: { dateTime: "2026-07-06T09:00:00Z" },
          end: { dateTime: "2026-07-06T09:30:00Z" },
          updated: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "evt-allday",
          status: "confirmed",
          etag: '"etag-2"',
          summary: "Company Holiday",
          start: { date: "2026-07-10" },
          end: { date: "2026-07-11" },
          updated: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "evt-master",
          status: "confirmed",
          etag: '"etag-3"',
          summary: "Weekly Sync",
          start: { dateTime: "2026-07-07T10:00:00Z" },
          end: { dateTime: "2026-07-07T10:30:00Z" },
          recurrence: ["RRULE:FREQ=WEEKLY;COUNT=5"],
          updated: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "evt-exception",
          status: "confirmed",
          etag: '"etag-4"',
          summary: "Weekly Sync (moved)",
          start: { dateTime: "2026-07-14T11:00:00Z" },
          end: { dateTime: "2026-07-14T11:30:00Z" },
          recurringEventId: "evt-master",
          originalStartTime: { dateTime: "2026-07-14T10:00:00Z" },
          updated: "2026-07-01T00:00:00.000Z",
        },
      ]
      const result = await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
        { items, nextSyncToken: "sync-tok-1" },
      ])
      expect(result.syncToken).toBe("sync-tok-1")

      const timed = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-timed")
      expect(timed?.all_day).toBe(false)
      expect(timed?.title).toBe("Standup")

      const allDay = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-allday")
      expect(allDay?.all_day).toBe(true)

      const master = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-master")
      expect(master?.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=5"])

      const exception = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-exception")
      expect(exception?.recurring_event_id).toBe("evt-master")
    })
  })

  it("persists hangoutLink from a Google event item and exposes it on the row", async () => {
    await withSystemDb("calendar-hangout-link", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any, [{ id: "gcal-hangout" }])
      await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
        {
          items: [
            {
              id: "evt-with-meet",
              status: "confirmed",
              etag: '"etag-meet-1"',
              summary: "Meet-linked event",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
              hangoutLink: "https://meet.google.com/abc-defg-hij",
            },
            {
              id: "evt-without-meet",
              status: "confirmed",
              etag: '"etag-meet-2"',
              summary: "No conferencing",
              start: { dateTime: "2026-07-06T11:00:00Z" },
              end: { dateTime: "2026-07-06T11:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
          ],
          nextSyncToken: "sync-tok-meet",
        },
      ])

      const withMeet = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-with-meet")
      expect(withMeet?.hangout_link).toBe("https://meet.google.com/abc-defg-hij")

      const withoutMeet = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-without-meet")
      expect(withoutMeet?.hangout_link).toBeNull()

      // Incremental update carrying a hangoutLink for the first time on an already-synced event.
      const updated = await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        {
          items: [
            {
              id: "evt-without-meet",
              status: "confirmed",
              etag: '"etag-meet-3"',
              summary: "No conferencing",
              start: { dateTime: "2026-07-06T11:00:00Z" },
              end: { dateTime: "2026-07-06T11:30:00Z" },
              updated: "2026-07-02T00:00:00.000Z",
              hangoutLink: "https://meet.google.com/xyz-later-added",
            },
          ],
          nextSyncToken: "sync-tok-meet-2",
        },
      ])
      expect(updated.syncToken).toBe("sync-tok-meet-2")
      const nowWithMeet = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-without-meet")
      expect(nowWithMeet?.hangout_link).toBe("https://meet.google.com/xyz-later-added")
    })
  })

  it("incremental sync applies update/create and cancelled-delete", async () => {
    await withSystemDb("calendar-incremental-basic", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
        {
          items: [
            {
              id: "evt-a",
              status: "confirmed",
              etag: '"a1"',
              summary: "A",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
            {
              id: "evt-b",
              status: "confirmed",
              etag: '"b1"',
              summary: "B",
              start: { dateTime: "2026-07-06T10:00:00Z" },
              end: { dateTime: "2026-07-06T10:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
          ],
          nextSyncToken: "tok-0",
        },
      ])

      const result = await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        {
          items: [
            {
              id: "evt-a",
              status: "confirmed",
              etag: '"a2"',
              summary: "A updated",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-02T00:00:00.000Z",
            },
            {
              id: "evt-b",
              status: "cancelled",
            },
            {
              id: "evt-c",
              status: "confirmed",
              etag: '"c1"',
              summary: "C new",
              start: { dateTime: "2026-07-06T11:00:00Z" },
              end: { dateTime: "2026-07-06T11:30:00Z" },
              updated: "2026-07-02T00:00:00.000Z",
            },
          ],
          nextSyncToken: "tok-1",
        },
      ])
      expect(result.syncToken).toBe("tok-1")

      const a = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-a")
      expect(a?.title).toBe("A updated")
      const b = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-b")
      expect(b).toBeUndefined()
      const c = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-c")
      expect(c?.title).toBe("C new")
    })
  })

  it("skips an inbound item whose etag matches the recorded push echo, but applies a foreign edit carrying the same marker with a NEWER etag", async () => {
    await withSystemDb("calendar-echo", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
        {
          items: [
            {
              id: "evt-echo",
              status: "confirmed",
              etag: '"echo-1"',
              summary: "Original",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
              extendedProperties: {
                private: {
                  liaisonSource: "liaison",
                  liaisonEventId: "local-x",
                  liaisonSyncVersion: "1",
                },
              },
            },
          ],
          nextSyncToken: "tok-0",
        },
      ])
      // Simulate: we pushed and Google returned etag "echo-1" (already recorded via initial sync
      // above as the current etag) — an inbound page repeating the SAME etag is our own echo.
      const echoResult = await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        {
          items: [
            {
              id: "evt-echo",
              status: "confirmed",
              etag: '"echo-1"',
              summary: "Echo (should be ignored)",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
              extendedProperties: {
                private: {
                  liaisonSource: "liaison",
                  liaisonEventId: "local-x",
                  liaisonSyncVersion: "1",
                },
              },
            },
          ],
          nextSyncToken: "tok-1",
        },
      ])
      expect(echoResult.syncToken).toBe("tok-1")
      const afterEcho = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-echo")
      expect(afterEcho?.title).toBe("Original")

      // Foreign edit: same marker (liaisonSyncVersion unchanged) but a genuinely NEW etag/updated —
      // must be applied, not treated as an echo.
      await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        {
          items: [
            {
              id: "evt-echo",
              status: "confirmed",
              etag: '"echo-2"',
              summary: "Foreign edit",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-03T00:00:00.000Z",
              extendedProperties: {
                private: {
                  liaisonSource: "liaison",
                  liaisonEventId: "local-x",
                  liaisonSyncVersion: "1",
                },
              },
            },
          ],
          nextSyncToken: "tok-2",
        },
      ])
      const afterForeign = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-echo")
      expect(afterForeign?.title).toBe("Foreign edit")
    })
  })

  it("LWW: an older remote update does not clobber a newer local edit; equal-timestamp tie favors Google", async () => {
    await withSystemDb("calendar-lww", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
        {
          items: [
            {
              id: "evt-lww",
              status: "confirmed",
              etag: '"lww-1"',
              summary: "Initial",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
          ],
          nextSyncToken: "tok-0",
        },
      ])
      // Bump local updatedAt ahead of the remote's next (older) update.
      await tx.execute(drizzleSql`
        UPDATE app_calendar.events SET updated_at = '2026-07-05T00:00:00.000Z', title = 'Newer Local'
        WHERE calendar_id = ${calendarId}::uuid AND google_event_id = 'evt-lww'
      `)
      await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        {
          items: [
            {
              id: "evt-lww",
              status: "confirmed",
              etag: '"lww-2"',
              summary: "Older remote (should not apply)",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-02T00:00:00.000Z", // older than local updatedAt
            },
          ],
          nextSyncToken: "tok-1",
        },
      ])
      const afterOlder = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-lww")
      expect(afterOlder?.title).toBe("Newer Local")

      // Equal-timestamp tie: remote updated === local updatedAt -> Google wins.
      await tx.execute(drizzleSql`
        UPDATE app_calendar.events SET updated_at = '2026-07-06T00:00:00.000Z'
        WHERE calendar_id = ${calendarId}::uuid AND google_event_id = 'evt-lww'
      `)
      await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        {
          items: [
            {
              id: "evt-lww",
              status: "confirmed",
              etag: '"lww-3"',
              summary: "Tie (Google wins)",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-06T00:00:00.000Z",
            },
          ],
          nextSyncToken: "tok-2",
        },
      ])
      const afterTie = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-lww")
      expect(afterTie?.title).toBe("Tie (Google wins)")
    })
  })

  it("empty incremental page advances the stored syncToken even though no rows change", async () => {
    await withSystemDb("calendar-empty-incremental", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
        { items: [], nextSyncToken: "tok-init" },
      ])
      const result = await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        { items: [], nextSyncToken: "tok-empty" },
      ])
      expect(result.syncToken).toBe("tok-empty")
      const [row] = (await tx.execute(drizzleSql`
        SELECT sync_token FROM app_calendar.calendars WHERE id = ${calendarId}::uuid
      `)) as any
      const r = (row.rows ?? row)[0] ?? (Array.isArray(row) ? row[0] : row)
      expect(r.sync_token).toBe("tok-empty")
    })
  })

  it("multi-page incremental joins items across pages and persists only the final page's nextSyncToken", async () => {
    await withSystemDb("calendar-multipage", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
        { items: [], nextSyncToken: "tok-init" },
      ])
      const result = await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        {
          items: [
            {
              id: "evt-p1",
              status: "confirmed",
              etag: '"p1"',
              summary: "Page1",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
          ],
          nextPageToken: "page-2",
        },
        {
          items: [
            {
              id: "evt-p2",
              status: "confirmed",
              etag: '"p2"',
              summary: "Page2",
              start: { dateTime: "2026-07-06T10:00:00Z" },
              end: { dateTime: "2026-07-06T10:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
          ],
          nextSyncToken: "tok-final",
        },
      ])
      expect(result.syncToken).toBe("tok-final")
      const p1 = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-p1")
      const p2 = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-p2")
      expect(p1?.title).toBe("Page1")
      expect(p2?.title).toBe("Page2")
    })
  })

  it("410 SyncTokenGone wipes only Google-born rows (preserving pending local-born rows) and re-triggers initial sync exactly once", async () => {
    await withSystemDb("calendar-410", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
        {
          items: [
            {
              id: "evt-google-born",
              status: "confirmed",
              etag: '"gb1"',
              summary: "Google born",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
          ],
          nextSyncToken: "tok-0",
        },
      ])
      // Local-born pending row (googleEventId IS NULL, pendingPush != 'none') must survive.
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, pending_push, calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'Local pending', 'create', ${accountId})
      `)

      const jobs: Array<{ jobName: string; payload: Record<string, unknown> }> = []
      await recoverFromSyncTokenGone(tx as any, orgId, calendarId, async (jobName, payload) => {
        jobs.push({ jobName, payload })
      })

      const googleBorn = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-google-born")
      expect(googleBorn).toBeUndefined()

      const [pendingRow] = (await tx.execute(drizzleSql`
        SELECT count(*)::int AS c FROM app_calendar.events
        WHERE calendar_id = ${calendarId}::uuid AND title = 'Local pending'
      `)) as any
      const pr =
        (pendingRow.rows ?? pendingRow)[0] ??
        (Array.isArray(pendingRow) ? pendingRow[0] : pendingRow)
      expect(pr.c).toBe(1)

      const [calRow] = (await tx.execute(drizzleSql`
        SELECT sync_token FROM app_calendar.calendars WHERE id = ${calendarId}::uuid
      `)) as any
      const cal = (calRow.rows ?? calRow)[0] ?? (Array.isArray(calRow) ? calRow[0] : calRow)
      expect(cal.sync_token).toBe(null)

      expect(jobs.filter((j) => j.jobName === "calendar-initial-sync").length).toBe(1)
    })
  })
})

// Regression (staging 2026-07-03): nothing ever flipped the account 'syncing' -> 'active'
// after the initial syncs completed, and streamed intermediate pages (no nextSyncToken)
// must not clobber a stored token or flip the account early.
describe("account active transition + streamed pages", () => {
  it("flips the account to active only when the last selected calendar stores its syncToken", async () => {
    await withSystemDb("calendar-active-flip", async (tx) => {
      const { accountId, calendarId } = await seedCalendar(tx as any, [
        { id: "gcal-x" },
        { id: "gcal-y" },
      ])
      const status = async () => {
        const r = (await tx.execute(drizzleSql`
          SELECT sync_status FROM app_calendar.accounts WHERE id = ${accountId}::uuid
        `)) as any
        return (r.rows ?? r)[0].sync_status
      }
      const calIds = (await tx.execute(drizzleSql`
        SELECT id FROM app_calendar.calendars WHERE account_id = ${accountId}::uuid ORDER BY google_calendar_id
      `)) as any
      const [calA, calB] = ((calIds.rows ?? calIds) as Array<{ id: string }>).map((r) => r.id)
      expect(await status()).toBe("syncing")

      // Intermediate streamed page (no nextSyncToken): no token stored, no flip.
      await applyInitialSyncPages(tx as any, orgId, calA!, accountId, [
        { items: [], nextPageToken: "p2" } as any,
      ])
      expect(await status()).toBe("syncing")

      // Final page for calendar A: token stored, but calendar B still pending -> no flip.
      await applyInitialSyncPages(tx as any, orgId, calA!, accountId, [
        { items: [], nextSyncToken: "tok-a" } as any,
      ])
      expect(await status()).toBe("syncing")

      // Final page for calendar B: all selected calendars synced -> active.
      await applyInitialSyncPages(tx as any, orgId, calB!, accountId, [
        { items: [], nextSyncToken: "tok-b" } as any,
      ])
      expect(await status()).toBe("active")
      void calendarId
    })
  })

  it("an intermediate incremental page does not null out the stored syncToken", async () => {
    await withSystemDb("calendar-stream-token", async (tx) => {
      const { calendarId } = await seedCalendar(tx as any, [{ id: "gcal-stream" }])
      await applyInitialSyncPages(tx as any, orgId, calendarId, "x", [
        { items: [], nextSyncToken: "tok-1" } as any,
      ])
      await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        { items: [], nextPageToken: "p2" } as any,
      ])
      const r = (await tx.execute(drizzleSql`
        SELECT sync_token FROM app_calendar.calendars WHERE id = ${calendarId}::uuid
      `)) as any
      expect((r.rows ?? r)[0].sync_token).toBe("tok-1")
    })
  })

  // #18 of the 2026-09-30 design audit: a sync page is written in a bounded number of
  // statements, not one upsert (and one read) per event inside the job's transaction.
  it("writes a sync page in a constant number of statements, whatever its size", async () => {
    await withSystemDb("calendar-batched-page", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any, [{ id: "gcal-batch" }])
      const statements: string[] = []
      const counting = new Proxy(tx as any, {
        get(target, prop, receiver) {
          if (prop === "execute") {
            return (query: unknown) => {
              statements.push(String(prop))
              return target.execute(query)
            }
          }
          return Reflect.get(target, prop, receiver)
        },
      })
      const page = (n: number, etag: string, updated: string) =>
        Array.from({ length: n }, (_, i) => ({
          id: `evt-batch-${i}`,
          status: "confirmed",
          etag: `"${etag}-${i}"`,
          summary: `Batch ${i} ${etag}`,
          start: { dateTime: "2026-07-06T09:00:00Z" },
          end: { dateTime: "2026-07-06T09:30:00Z" },
          updated,
        }))

      await applyInitialSyncPages(counting, orgId, calendarId, accountId, [
        { items: page(120, "a", "2026-07-01T00:00:00.000Z"), nextSyncToken: "tok-batch" },
      ])
      // One upsert, the token, the account roll-up. Was 120 upserts + 2.
      expect(statements.length).toBeLessThanOrEqual(4)

      statements.length = 0
      const incremental = [
        ...page(120, "b", "2027-07-01T00:00:00.000Z"),
        // One event listed twice: the LAST entry wins, as when items applied in order.
        {
          id: "evt-batch-0",
          status: "confirmed",
          etag: '"b-0-final"',
          summary: "Batch 0 final",
          start: { dateTime: "2026-07-06T09:00:00Z" },
          end: { dateTime: "2026-07-06T09:30:00Z" },
          updated: "2027-07-01T00:00:00.000Z",
        },
        { id: "evt-batch-1", status: "cancelled" },
      ]
      await applyIncrementalSyncPages(counting, orgId, calendarId, [
        { items: incremental, nextSyncToken: "tok-batch-2" },
      ])
      // Calendar read, one delete, one read of the page's rows, one upsert, the token.
      // Was one read and one upsert PER event.
      expect(statements.length).toBeLessThanOrEqual(6)
      expect((await getEventByGoogleId(tx as any, orgId, calendarId, "evt-batch-0"))?.title).toBe(
        "Batch 0 final",
      )
      expect(await getEventByGoogleId(tx as any, orgId, calendarId, "evt-batch-1")).toBeUndefined()
      expect((await getEventByGoogleId(tx as any, orgId, calendarId, "evt-batch-119"))?.title).toBe(
        "Batch 119 b",
      )
    })
  })
})
