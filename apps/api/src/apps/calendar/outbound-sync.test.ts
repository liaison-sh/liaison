// SPDX-License-Identifier: FSL-1.1-ALv2
// Task 5 — outbound sync: local mutation -> pendingPush -> push job, conflicts (412 LWW),
// concurrent-edit race, retry exhaustion, revoked token, echo round-trip.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  applyIncrementalSyncPages,
  applyInitialSyncPages,
  applyPushResult,
  applyRemoteDeletion,
  createLocalEvent,
  deleteLocalEvent,
  finalizeRemoteDelete,
  findStalePendingPushes,
  getEventByGoogleId,
  getEventById,
  handlePushConflict,
  markPushRejected,
  notePushFailure,
  onAccountConnected,
  recordPushFailure,
  resolveUpdateTarget,
  restoreRefusedDelete,
  revertEventToGoogle,
  runCalendarImport,
  setCalendarSelectedAndSync,
  updateLocalEvent,
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
  await withSystemDb("calendar-outbound-fixture-reg", async (tx) => {
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
  const slug = `cal-outbound-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("calendar-outbound-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Calendar Outbound Org', ${slug})
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

async function seedCalendar(tx: any) {
  const event = {
    orgId,
    actorId: userId,
    data: {
      id: crypto.randomUUID(),
      appName: "calendar",
      ownerType: "user" as const,
      ownerId: userId,
      identifier: `outbound-${crypto.randomUUID()}@gmail.com`,
      connectionName: "google-calendar",
    },
  }
  const { accountId } = await onAccountConnected(tx, orgId, event, async () => {})
  const { calendarIds } = await runCalendarImport(
    tx,
    orgId,
    accountId,
    async () => [{ id: "gcal-out" }],
    async () => {},
  )
  return { accountId, calendarId: calendarIds[0]! }
}

describe("calendar outbound sync", () => {
  it("create stamps pendingPush=create and bumps liaisonSyncVersion; push result stores googleEventId+etag+googleUpdatedAt", async () => {
    await withSystemDb("calendar-create-push", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
        title: "New event",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      const beforePush = await getEventById(tx as any, orgId, eventId)
      expect(beforePush?.pending_push).toBe("create")
      expect(beforePush?.liaison_sync_version).toBe(1)

      await applyPushResult(tx as any, orgId, eventId, {
        googleEventId: "evt-created-1",
        etag: '"push-etag-1"',
        googleUpdatedAt: "2026-07-06T00:00:00.000Z",
      })
      const after = await getEventById(tx as any, orgId, eventId)
      expect(after?.google_event_id).toBe("evt-created-1")
      expect(after?.etag).toBe('"push-etag-1"')
      expect(after?.pending_push).toBe("none")
    })
  })

  it("412 with a newer remote -> remote wins locally (LWW); equal-timestamp tie -> Google wins", async () => {
    await withSystemDb("calendar-412-newer", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
        title: "Local edit",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      await applyPushResult(tx as any, orgId, eventId, {
        googleEventId: "evt-412",
        etag: '"old-etag"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      await updateLocalEvent(tx as any, orgId, eventId, { title: "Local edit v2" })

      const result = await handlePushConflict(tx as any, orgId, eventId, {
        remoteEtag: '"remote-etag"',
        // RELATIVE, not a literal. The local row's updated_at is now(), so a
        // hardcoded date is only "newer than local" until the calendar reaches
        // it: this line said 2026-07-10 and the test had been failing on every
        // machine since that day, reporting "retry" instead of "remote-won".
        remoteUpdated: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        remoteSnapshot: {
          title: "Remote wins",
          start: { dateTime: "2026-07-06T09:00:00Z" },
          end: { dateTime: "2026-07-06T09:30:00Z" },
        },
      })
      expect(result.outcome).toBe("remote-won")
      const after = await getEventById(tx as any, orgId, eventId)
      expect(after?.title).toBe("Remote wins")
      expect(after?.pending_push).toBe("none")
    })
  })

  it("412 with an older remote -> re-push succeeds on retry (stale-payload local wins)", async () => {
    await withSystemDb("calendar-412-older", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
        title: "Local edit",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      await applyPushResult(tx as any, orgId, eventId, {
        googleEventId: "evt-412-older",
        etag: '"old-etag"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      await updateLocalEvent(tx as any, orgId, eventId, { title: "Local edit v2" })
      const localAfterUpdate = await getEventById(tx as any, orgId, eventId)

      const result = await handlePushConflict(tx as any, orgId, eventId, {
        remoteEtag: '"remote-etag-stale"',
        remoteUpdated: "2026-06-01T00:00:00.000Z", // older than local's captured payload version
        remoteSnapshot: { title: "should not apply" },
        capturedSyncVersion: localAfterUpdate!.liaison_sync_version, // push captured the current (v2) payload
      })
      expect(result.outcome).toBe("retry")
      const after = await getEventById(tx as any, orgId, eventId)
      expect(after?.pending_push).toBe("update")
      expect(after?.title).toBe("Local edit v2")
    })
  })

  it("concurrent-edit race: a local edit lands while a push is in flight -> the NEWEST payload is what gets pushed, pendingPush not prematurely cleared", async () => {
    await withSystemDb("calendar-race", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
        title: "Version N",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      await applyPushResult(tx as any, orgId, eventId, {
        googleEventId: "evt-race",
        etag: '"race-etag"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      const capturedBefore = await getEventById(tx as any, orgId, eventId)
      const capturedSyncVersion = capturedBefore!.liaison_sync_version

      // A concurrent local edit lands WHILE the push (using capturedSyncVersion) is in flight.
      await updateLocalEvent(tx as any, orgId, eventId, { title: "Version N+1 (concurrent)" })

      const result = await handlePushConflict(tx as any, orgId, eventId, {
        remoteEtag: '"remote-etag"',
        remoteUpdated: "2026-06-01T00:00:00.000Z", // older -> would normally re-push
        remoteSnapshot: { title: "stale payload" },
        capturedSyncVersion, // the version this in-flight push captured BEFORE the concurrent edit
      })
      expect(result.outcome).toBe("abort-stale")
      const after = await getEventById(tx as any, orgId, eventId)
      expect(after?.title).toBe("Version N+1 (concurrent)")
      expect(after?.pending_push).toBe("update")
      expect(after?.liaison_sync_version).toBeGreaterThan(capturedSyncVersion)
    })
  })

  it("recordPushFailure (called on 412 exhaustion by the push handler) leaves pendingPush set and logs a sanitized sync_log entry — the actual 3-attempt recursion is driven in push-handlers.test.ts", async () => {
    await withSystemDb("calendar-412-exhaust", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
        title: "Flaky",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      await recordPushFailure(
        tx as any,
        orgId,
        eventId,
        calendarId,
        "EtagMismatch",
        "retry exhaustion after 3 attempts",
      )
      const after = await getEventById(tx as any, orgId, eventId)
      expect(after?.pending_push).not.toBe("none")

      const [logRow] = (await tx.execute(drizzleSql`
        SELECT operation, status, error_kind, detail FROM app_calendar.sync_log
        WHERE calendar_id = ${calendarId}::uuid ORDER BY created_at DESC LIMIT 1
      `)) as any
      const log = (logRow.rows ?? logRow)[0] ?? (Array.isArray(logRow) ? logRow[0] : logRow)
      expect(log.error_kind).toBe("EtagMismatch")
      expect(log.detail).not.toContain("Bearer")
    })
  })

  // Changed 2026-10-05 (re-review): a create never acknowledged may already exist on Google
  // (committed, answer lost, or in flight), so its deletion is sent by the deterministic id; a
  // 404 there is fine. Skipping Google left an orphan that came back with the next sync.
  it("delete of a never-acknowledged local create deletes it on Google by its deterministic id", async () => {
    await withSystemDb("calendar-delete-local-only", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
        title: "Never pushed",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      const result = await deleteLocalEvent(tx as any, orgId, eventId)
      expect(result.needsGooglePush).toBe(true)
      expect(result.googleEventId).toBe(eventId.replace(/-/g, ""))
      // Kept as a tombstone until Google confirms (changed 2026-10-05: delete retries).
      const after = await getEventById(tx as any, orgId, eventId)
      expect(after?.deleted_at).toBeTruthy()
      expect(after?.pending_push).toBe("delete")
      expect(after?.google_event_id).toBe(eventId.replace(/-/g, ""))
    })
  })

  it("revoked token (recordPushFailure with AuthRevoked) parks the mutation without clearing pendingPush", async () => {
    await withSystemDb("calendar-revoked", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
        title: "Parked",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      await recordPushFailure(tx as any, orgId, eventId, calendarId, "AuthRevoked", "token revoked")
      const after = await getEventById(tx as any, orgId, eventId)
      expect(after?.pending_push).toBe("create")
    })
  })

  it("full loop: local create -> push -> simulated inbound etag echo -> no duplicate row and no re-push, THEN a genuinely different Google-authored etag IS applied", async () => {
    await withSystemDb("calendar-full-loop", async (tx) => {
      const { calendarId, accountId } = await seedCalendar(tx as any)
      const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
        title: "Loop event",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      await applyPushResult(tx as any, orgId, eventId, {
        googleEventId: "evt-loop",
        etag: '"loop-etag-1"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })

      // Simulated inbound incremental page: our own echo (same etag) must not duplicate or change anything.
      await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        {
          items: [
            {
              id: "evt-loop",
              status: "confirmed",
              etag: '"loop-etag-1"',
              summary: "Loop event (echo)",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
          ],
          nextSyncToken: "tok-echo",
        },
      ])
      const [countRow] = (await tx.execute(drizzleSql`
        SELECT count(*)::int AS c FROM app_calendar.events WHERE calendar_id = ${calendarId}::uuid AND google_event_id = 'evt-loop'
      `)) as any
      const cr =
        (countRow.rows ?? countRow)[0] ?? (Array.isArray(countRow) ? countRow[0] : countRow)
      expect(cr.c).toBe(1)
      const afterEcho = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-loop")
      expect(afterEcho?.title).toBe("Loop event") // unchanged by the echo

      // A genuinely different (Google-authored) etag for the SAME event IS applied.
      await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
        {
          items: [
            {
              id: "evt-loop",
              status: "confirmed",
              etag: '"loop-etag-2"',
              summary: "Loop event (real remote change)",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-05T00:00:00.000Z",
            },
          ],
          nextSyncToken: "tok-real",
        },
      ])
      const afterReal = await getEventByGoogleId(tx as any, orgId, calendarId, "evt-loop")
      expect(afterReal?.title).toBe("Loop event (real remote change)")
    })
  })

  // The edit dialog showed no attendees and the update tool replaced the stored attendee
  // objects with bare email strings: kept attendees lost responseStatus/organizer/self/
  // optional/comment (and Google expects objects). An edit names the attendee list by email;
  // the stored objects of kept attendees must survive it.
  describe("attendees", () => {
    const dana = {
      email: "dana@acme.example",
      displayName: "Dana Girard",
      responseStatus: "accepted",
      organizer: true,
      self: false,
      optional: false,
      comment: "Je serai là",
    }

    async function seedWithAttendees(tx: any) {
      const { calendarId, accountId } = await seedCalendar(tx)
      const { eventId } = await createLocalEvent(tx, orgId, calendarId, accountId, {
        title: "Weekly",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
        attendees: [dana, { email: "maxime@acme.example", responseStatus: "tentative" }],
      })
      return eventId
    }

    it("an edit that does not name attendees leaves them untouched", async () => {
      await withSystemDb("calendar-attendees-untouched", async (tx) => {
        const eventId = await seedWithAttendees(tx)
        await updateLocalEvent(tx as any, orgId, eventId, { title: "Weekly v2" })
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.attendees).toEqual([
          dana,
          { email: "maxime@acme.example", responseStatus: "tentative" },
        ])
      })
    })

    it("an edit naming attendees by email keeps the stored objects of those kept and adds new ones", async () => {
      await withSystemDb("calendar-attendees-merge", async (tx) => {
        const eventId = await seedWithAttendees(tx)
        await updateLocalEvent(tx as any, orgId, eventId, {
          attendees: ["Dana@Acme.example", "new@example.com"],
        })
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.attendees).toEqual([dana, { email: "new@example.com" }])
      })
    })

    it("a new event stores attendee objects, never bare strings", async () => {
      await withSystemDb("calendar-attendees-create", async (tx) => {
        const { calendarId, accountId } = await seedCalendar(tx as any)
        const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
          title: "New",
          start: { dateTime: "2026-07-06T09:00:00Z" },
          end: { dateTime: "2026-07-06T09:30:00Z" },
          attendees: ["a@example.com"],
        })
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.attendees).toEqual([{ email: "a@example.com" }])
      })
    })
  })

  describe("attendees: the base of a local edit, and Google's version", () => {
    async function pushedEvent(tx: any, attendees: unknown[]) {
      const { calendarId, accountId } = await seedCalendar(tx)
      const { eventId } = await createLocalEvent(tx, orgId, calendarId, accountId, {
        title: "Synced",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
        attendees,
      })
      await applyPushResult(tx, orgId, eventId, {
        googleEventId: `gevt-${crypto.randomUUID()}`,
        etag: '"e1"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      return { eventId, calendarId }
    }

    it("a title-only edit records no attendee base; the first attendee edit records the list it started from", async () => {
      await withSystemDb("calendar-attendees-base", async (tx) => {
        const { eventId } = await pushedEvent(tx, [
          { email: "a@example.com", responseStatus: "accepted" },
        ])
        await updateLocalEvent(tx as any, orgId, eventId, { title: "Renamed" })
        expect((await getEventById(tx as any, orgId, eventId))?.attendees_base).toBeNull()

        await updateLocalEvent(tx as any, orgId, eventId, {
          attendees: ["a@example.com", "b@example.com"],
        })
        await updateLocalEvent(tx as any, orgId, eventId, { attendees: ["b@example.com"] })
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.attendees_base).toEqual([
          { email: "a@example.com", responseStatus: "accepted" },
        ])
      })
    })

    it("a successful push clears the base and stores the attendees Google kept", async () => {
      await withSystemDb("calendar-attendees-refresh", async (tx) => {
        const { eventId } = await pushedEvent(tx, [{ email: "a@example.com" }])
        await updateLocalEvent(tx as any, orgId, eventId, {
          attendees: ["a@example.com", "c@example.com"],
        })
        const before = await getEventById(tx as any, orgId, eventId)
        await applyPushResult(tx as any, orgId, eventId, {
          googleEventId: before!.google_event_id!,
          etag: '"e2"',
          googleUpdatedAt: "2026-07-02T00:00:00.000Z",
          remote: {
            attendees: [{ email: "a@example.com", responseStatus: "accepted" }],
            organizer: { email: "boss@example.com", self: false },
            guestsCanModify: false,
          },
        })
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.attendees_base).toBeNull()
        expect(row?.attendees).toEqual([{ email: "a@example.com", responseStatus: "accepted" }])
        expect(row?.organizer_self).toBe(false)
        expect(row?.guests_can_modify).toBe(false)
      })
    })

    it("a refused push (403) puts Google's version on the row and logs it", async () => {
      await withSystemDb("calendar-attendees-revert", async (tx) => {
        const { eventId, calendarId } = await pushedEvent(tx, [{ email: "a@example.com" }])
        await updateLocalEvent(tx as any, orgId, eventId, {
          title: "Local",
          attendees: ["x@example.com"],
        })
        await revertEventToGoogle(
          tx as any,
          orgId,
          eventId,
          {
            id: "ignored",
            summary: "Google title",
            attendees: [{ email: "a@example.com" }],
            recurrence: ["RRULE:FREQ=WEEKLY"],
            updated: "2026-07-03T00:00:00.000Z",
          },
          "refused",
        )
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.title).toBe("Google title")
        expect(row?.attendees).toEqual([{ email: "a@example.com" }])
        expect(row?.recurrence).toEqual(["RRULE:FREQ=WEEKLY"])
        expect(row?.pending_push).toBe("none")
        expect(row?.attendees_base).toBeNull()
        const logs = (await tx.execute(drizzleSql`
          SELECT error_kind FROM app_calendar.sync_log WHERE calendar_id = ${calendarId}::uuid
        `)) as any
        expect((logs.rows ?? logs).map((r: { error_kind: string }) => r.error_kind)).toContain(
          "Forbidden",
        )
      })
    })

    it("a 412 won by Google keeps Google's attendees and recurrence", async () => {
      await withSystemDb("calendar-attendees-412", async (tx) => {
        const { eventId } = await pushedEvent(tx, [{ email: "a@example.com" }])
        await updateLocalEvent(tx as any, orgId, eventId, { title: "Local" })
        const result = await handlePushConflict(tx as any, orgId, eventId, {
          remoteEtag: '"r"',
          remoteUpdated: new Date(Date.now() + 60_000).toISOString(),
          remoteSnapshot: {
            title: "Remote",
            start: { dateTime: "2026-07-06T09:00:00Z" },
            end: { dateTime: "2026-07-06T09:30:00Z" },
            attendees: [{ email: "a@example.com", responseStatus: "declined" }],
            recurrence: ["RRULE:FREQ=DAILY"],
          },
        })
        expect(result.outcome).toBe("remote-won")
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.attendees).toEqual([{ email: "a@example.com", responseStatus: "declined" }])
        expect(row?.recurrence).toEqual(["RRULE:FREQ=DAILY"])
      })
    })
  })

  describe("push robustness", () => {
    it("an edit made while a push was in flight stays pending and keeps its base", async () => {
      await withSystemDb("calendar-push-inflight", async (tx) => {
        const { calendarId, accountId } = await seedCalendar(tx as any)
        const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
          title: "v1",
          start: { dateTime: "2026-07-06T09:00:00Z" },
          end: { dateTime: "2026-07-06T09:30:00Z" },
          attendees: ["a@example.com"],
        })
        // The create push read version 1 ...
        const pushedVersion = (await getEventById(tx as any, orgId, eventId))!.liaison_sync_version
        // ... and while it was in flight the user edited the title and the guests.
        await updateLocalEvent(tx as any, orgId, eventId, {
          title: "v2",
          attendees: ["a@example.com", "b@example.com"],
        })
        await applyPushResult(tx as any, orgId, eventId, {
          googleEventId: "gevt-inflight",
          etag: '"e1"',
          googleUpdatedAt: "2026-07-06T00:00:00.000Z",
          remote: { summary: "v1", attendees: [{ email: "a@example.com" }] },
          syncVersion: pushedVersion,
        })
        const row = await getEventById(tx as any, orgId, eventId)
        // Google's id is known, so the queued follow-up updates instead of creating twice ...
        expect(row?.google_event_id).toBe("gevt-inflight")
        expect(row?.pending_push).toBe("update")
        // ... and it still carries the newer edit and its attendee base.
        expect(row?.title).toBe("v2")
        expect(row?.attendees).toEqual([{ email: "a@example.com" }, { email: "b@example.com" }])
        expect(row?.attendees_base).toEqual([{ email: "a@example.com" }])

        // When the follow-up push (reading the current version) lands, the row is settled.
        await applyPushResult(tx as any, orgId, eventId, {
          googleEventId: "gevt-inflight",
          etag: '"e2"',
          googleUpdatedAt: "2026-07-06T00:01:00.000Z",
          syncVersion: row!.liaison_sync_version,
        })
        const settled = await getEventById(tx as any, orgId, eventId)
        expect(settled?.pending_push).toBe("none")
        expect(settled?.attendees_base).toBeNull()
      })
    })

    it("stale pending creates and updates are found for the periodic retry; fresh ones are not", async () => {
      await withSystemDb("calendar-push-stale", async (tx) => {
        const { calendarId, accountId } = await seedCalendar(tx as any)
        const make = async (title: string) =>
          (
            await createLocalEvent(tx as any, orgId, calendarId, accountId, {
              title,
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
            })
          ).eventId
        const stale = await make("stale")
        const fresh = await make("fresh")
        const done = await make("done")
        await applyPushResult(tx as any, orgId, done, {
          googleEventId: `gevt-${crypto.randomUUID()}`,
          etag: '"e"',
          googleUpdatedAt: "2026-07-06T00:00:00.000Z",
        })
        await tx.execute(drizzleSql`
          UPDATE app_calendar.events SET updated_at = now() - interval '2 hours'
          WHERE id IN (${stale}::uuid, ${done}::uuid)
        `)
        const ids = (await findStalePendingPushes(tx as any, orgId, 30)).map((r) => r.id)
        expect(ids).toContain(stale)
        expect(ids).not.toContain(fresh)
        expect(ids).not.toContain(done)
      })
    })

    it("an inbound event whose organizer omits `self` and that omits guestsCanModify stores false for both", async () => {
      await withSystemDb("calendar-organizer-flags", async (tx) => {
        const { calendarId, accountId } = await seedCalendar(tx as any)
        await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
          {
            items: [
              {
                id: "gevt-theirs",
                summary: "Their meeting",
                start: { dateTime: "2026-07-07T09:00:00Z" },
                end: { dateTime: "2026-07-07T09:30:00Z" },
                organizer: { email: "boss@example.com" },
              },
              {
                id: "gevt-mine",
                summary: "My meeting",
                start: { dateTime: "2026-07-07T10:00:00Z" },
                end: { dateTime: "2026-07-07T10:30:00Z" },
                organizer: { email: "me@example.com", self: true },
                guestsCanModify: true,
              },
            ],
          },
        ])
        const theirs = await getEventByGoogleId(tx as any, orgId, calendarId, "gevt-theirs")
        const mine = await getEventByGoogleId(tx as any, orgId, calendarId, "gevt-mine")
        const flags = async (id: string) => {
          const r = (await tx.execute(drizzleSql`
            SELECT organizer_self, guests_can_modify FROM app_calendar.events WHERE id = ${id}::uuid
          `)) as any
          return (r.rows ?? r)[0]
        }
        expect(await flags(theirs!.id)).toEqual({ organizer_self: false, guests_can_modify: false })
        expect(await flags(mine!.id)).toEqual({ organizer_self: true, guests_can_modify: true })
      })
    })
  })

  describe("pushes Google will never accept", () => {
    async function pendingEdit(tx: any) {
      const { calendarId, accountId } = await seedCalendar(tx)
      const { eventId } = await createLocalEvent(tx, orgId, calendarId, accountId, {
        title: "v1",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      await applyPushResult(tx, orgId, eventId, {
        googleEventId: `gevt-${crypto.randomUUID()}`,
        etag: '"e"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      await updateLocalEvent(tx, orgId, eventId, { title: "refused title" })
      return eventId
    }

    it("a rejected push stops being pending, keeps the local values, records the message, and is not swept", async () => {
      await withSystemDb("calendar-push-rejected", async (tx) => {
        const eventId = await pendingEdit(tx as any)
        await markPushRejected(tx as any, orgId, eventId, "Invalid attendee email.")
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.pending_push).toBe("none")
        expect(row?.push_error).toBe("Invalid attendee email.")
        expect(row?.title).toBe("refused title")
        await tx.execute(drizzleSql`
          UPDATE app_calendar.events SET updated_at = now() - interval '2 hours' WHERE id = ${eventId}::uuid
        `)
        const swept = (await findStalePendingPushes(tx as any, orgId, 30)).map((r) => r.id)
        expect(swept).not.toContain(eventId)

        // A new local edit clears the error and is pushed again.
        await updateLocalEvent(tx as any, orgId, eventId, { title: "fixed title" })
        const again = await getEventById(tx as any, orgId, eventId)
        expect(again?.push_error).toBeNull()
        expect(again?.pending_push).toBe("update")
      })
    })

    it("an event gone on Google is deleted locally with its pending edit", async () => {
      await withSystemDb("calendar-push-gone", async (tx) => {
        const eventId = await pendingEdit(tx as any)
        await applyRemoteDeletion(tx as any, orgId, eventId)
        expect(await getEventById(tx as any, orgId, eventId)).toBeUndefined()
      })
    })
  })

  describe("bounded attempts and version-conditioned outcomes", () => {
    async function pending(tx: any, title = "v") {
      const { calendarId, accountId } = await seedCalendar(tx)
      const { eventId } = await createLocalEvent(tx, orgId, calendarId, accountId, {
        title,
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      await applyPushResult(tx, orgId, eventId, {
        googleEventId: `gevt-${crypto.randomUUID()}`,
        etag: '"e"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      const { syncVersion } = await updateLocalEvent(tx, orgId, eventId, {
        title: `${title} edited`,
      })
      return { eventId, accountId, syncVersion }
    }

    it("failed attempts are counted on the row, reset by a new edit, and ignored for a newer version", async () => {
      await withSystemDb("calendar-push-attempts", async (tx) => {
        const { eventId, syncVersion } = await pending(tx as any)
        expect((await notePushFailure(tx as any, orgId, eventId, syncVersion))?.attempts).toBe(1)
        expect((await notePushFailure(tx as any, orgId, eventId, syncVersion))?.attempts).toBe(2)
        const { syncVersion: next } = await updateLocalEvent(tx as any, orgId, eventId, {
          title: "newer",
        })
        expect(await notePushFailure(tx as any, orgId, eventId, syncVersion)).toBeNull()
        expect((await notePushFailure(tx as any, orgId, eventId, next))?.attempts).toBe(1)
      })
    })

    it("the sweep goes least recently attempted first, skips a just-attempted row and an account to reconnect", async () => {
      await withSystemDb("calendar-push-sweep-order", async (tx) => {
        const a = await pending(tx as any, "a")
        const b = await pending(tx as any, "b")
        const c = await pending(tx as any, "c")
        const reauth = await pending(tx as any, "reauth")
        await tx.execute(drizzleSql`
          UPDATE app_calendar.events SET updated_at = now() - interval '5 hours'
          WHERE id IN (${a.eventId}::uuid, ${b.eventId}::uuid, ${c.eventId}::uuid, ${reauth.eventId}::uuid)
        `)
        // a was tried 1h ago, b 3h ago, c just now.
        await tx.execute(
          drizzleSql`UPDATE app_calendar.events SET last_push_attempt_at = now() - interval '1 hour' WHERE id = ${a.eventId}::uuid`,
        )
        await tx.execute(
          drizzleSql`UPDATE app_calendar.events SET last_push_attempt_at = now() - interval '3 hours' WHERE id = ${b.eventId}::uuid`,
        )
        await tx.execute(
          drizzleSql`UPDATE app_calendar.events SET last_push_attempt_at = now() WHERE id = ${c.eventId}::uuid`,
        )
        await tx.execute(
          drizzleSql`UPDATE app_calendar.accounts SET sync_status = 'reauth-required' WHERE id = ${reauth.accountId}::uuid`,
        )
        const ids = (await findStalePendingPushes(tx as any, orgId, 30, 500)).map((r) => r.id)
        expect(ids).not.toContain(c.eventId)
        expect(ids).not.toContain(reauth.eventId)
        expect(ids.indexOf(b.eventId)).toBeGreaterThanOrEqual(0)
        expect(ids.indexOf(b.eventId)).toBeLessThan(ids.indexOf(a.eventId))
      })
    })

    it("a refusal, a deletion or a revert for an older version leaves the newer edit pending", async () => {
      await withSystemDb("calendar-push-versioned-outcomes", async (tx) => {
        const { eventId, syncVersion: old } = await pending(tx as any)
        await updateLocalEvent(tx as any, orgId, eventId, { title: "newest" })
        await markPushRejected(tx as any, orgId, eventId, "Invalid", old)
        await applyRemoteDeletion(tx as any, orgId, eventId, old)
        await revertEventToGoogle(
          tx as any,
          orgId,
          eventId,
          { id: "x", summary: "Google title", updated: "2026-07-03T00:00:00.000Z" },
          "refused",
          old,
        )
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.title).toBe("newest")
        expect(row?.pending_push).toBe("update")
        expect(row?.push_error).toBeNull()
      })
    })
  })

  // Re-review 2026-10-05 (blocker): Google committed our insert, we never got the answer, and
  // the webhook/poll import arrived first. It matched on google_event_id only, so it imported a
  // second row; the 409-adopt then hit the unique (calendar, google id) index and threw forever.
  describe("our own create coming back through the import before its answer", () => {
    async function pendingCreate(tx: any, title = "Created here") {
      const { calendarId, accountId } = await seedCalendar(tx)
      const { eventId } = await createLocalEvent(tx, orgId, calendarId, accountId, {
        title,
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      return { eventId, calendarId, googleId: eventId.replace(/-/g, "") }
    }

    async function rowsFor(tx: any, calendarId: string, googleId: string) {
      const r = (await tx.execute(drizzleSql`
        SELECT id, title, pending_push FROM app_calendar.events
        WHERE calendar_id = ${calendarId}::uuid AND google_event_id = ${googleId}
      `)) as any
      return (r.rows ?? r) as Array<{ id: string; title: string; pending_push: string }>
    }

    it("the import attaches the event to the pending row, and the adopting push then succeeds", async () => {
      await withSystemDb("calendar-attach-reviewer-scenario", async (tx) => {
        const { eventId, calendarId, googleId } = await pendingCreate(tx as any)
        await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
          {
            items: [
              {
                id: googleId,
                status: "confirmed",
                etag: '"committed"',
                updated: new Date(Date.now() + 60_000).toISOString(),
                summary: "Created here",
                start: { dateTime: "2026-07-06T09:00:00Z" },
                end: { dateTime: "2026-07-06T09:30:00Z" },
              },
            ],
            nextSyncToken: "tok-1",
          },
        ])
        let rows = await rowsFor(tx as any, calendarId, googleId)
        expect(rows.map((r) => r.id)).toEqual([eventId])

        // The push that was in flight now hears 409 and adopts: no unique violation, no throw.
        const result = await applyPushResult(tx as any, orgId, eventId, {
          googleEventId: googleId,
          etag: '"committed"',
          googleUpdatedAt: "2026-07-06T00:00:00.000Z",
          syncVersion: 1,
        })
        expect(result.rowExists).toBe(true)
        rows = await rowsFor(tx as any, calendarId, googleId)
        expect(rows).toEqual([{ id: eventId, title: "Created here", pending_push: "none" }])
      })
    })

    it("a local edit made after the create was sent survives the attach and stays pending", async () => {
      await withSystemDb("calendar-attach-keeps-edit", async (tx) => {
        const { eventId, calendarId, googleId } = await pendingCreate(tx as any)
        await updateLocalEvent(tx as any, orgId, eventId, { title: "Edited since" })
        await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
          {
            items: [
              {
                id: googleId,
                status: "confirmed",
                etag: '"committed"',
                // Google's commit time is before the local edit.
                updated: "2026-01-01T00:00:00.000Z",
                summary: "Created here",
              },
            ],
            nextSyncToken: "tok-2",
          },
        ])
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.google_event_id).toBe(googleId)
        expect(row?.title).toBe("Edited since")
        // Google has it now: the queued push updates it rather than creating it again.
        expect(row?.pending_push).toBe("update")
        expect((await rowsFor(tx as any, calendarId, googleId)).length).toBe(1)
      })
    })

    it("a cancellation of our pending create deletes the pending row", async () => {
      await withSystemDb("calendar-attach-cancelled", async (tx) => {
        const { eventId, calendarId, googleId } = await pendingCreate(tx as any)
        await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
          { items: [{ id: googleId, status: "cancelled" }], nextSyncToken: "tok-3" },
        ])
        expect(await getEventById(tx as any, orgId, eventId)).toBeUndefined()
      })
    })

    it("a copy imported before this fix does not make the push throw: the copy goes, the user's row stays", async () => {
      await withSystemDb("calendar-attach-legacy-copy", async (tx) => {
        const { eventId, calendarId, googleId } = await pendingCreate(tx as any)
        const { calaccess } = (await getEventById(tx as any, orgId, eventId))!
        await tx.execute(drizzleSql`
          INSERT INTO app_calendar.events (id, org_id, calendar_id, google_event_id, title, calaccess)
          VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, ${googleId}, 'imported copy', ${calaccess})
        `)
        await applyPushResult(tx as any, orgId, eventId, {
          googleEventId: googleId,
          etag: '"committed"',
          googleUpdatedAt: "2026-07-06T00:00:00.000Z",
          syncVersion: 1,
        })
        const rows = await rowsFor(tx as any, calendarId, googleId)
        expect(rows.map((r) => r.id)).toEqual([eventId])
      })
    })

    // Changed 2026-10-05: a deleted row is now a tombstone until Google confirms, so the
    // in-flight create lands on it and the tombstone's own push deletes the event on Google.
    it("a create landing after the row was deleted leaves the tombstone pending its Google delete", async () => {
      await withSystemDb("calendar-attach-deleted-inflight", async (tx) => {
        const { eventId, googleId } = await pendingCreate(tx as any)
        await deleteLocalEvent(tx as any, orgId, eventId)
        const result = await applyPushResult(tx as any, orgId, eventId, {
          googleEventId: googleId,
          etag: '"e"',
          googleUpdatedAt: "2026-07-06T00:00:00.000Z",
          syncVersion: 1,
        })
        expect(result.rowExists).toBe(true)
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.pending_push).toBe("delete")
        expect(row?.deleted_at).toBeTruthy()
        expect(row?.google_event_id).toBe(googleId)
      })
    })

    it("a failing version reports how long it has been failing; a new edit resets it", async () => {
      await withSystemDb("calendar-failing-for", async (tx) => {
        const { eventId } = await pendingCreate(tx as any)
        await tx.execute(drizzleSql`
          UPDATE app_calendar.events SET push_attempts = 3,
            first_push_failure_at = now() - interval '25 hours' WHERE id = ${eventId}::uuid
        `)
        const failure = await notePushFailure(tx as any, orgId, eventId, 1)
        expect(failure?.attempts).toBe(4)
        expect(failure!.failingForMs).toBeGreaterThan(24 * 60 * 60 * 1000)
        const { syncVersion } = await updateLocalEvent(tx as any, orgId, eventId, {
          title: "again",
        })
        const fresh = await notePushFailure(tx as any, orgId, eventId, syncVersion)
        expect(fresh?.attempts).toBe(1)
        expect(fresh!.failingForMs).toBeLessThan(60_000)
      })
    })
  })

  // Coordinator 2026-10-05: a Google delete that failed was lost (logged only), and the import
  // then brought the event back. A local delete is now a tombstone until Google confirms.
  describe("a local delete waiting to reach Google", () => {
    async function syncedEvent(tx: any) {
      const { calendarId, accountId } = await seedCalendar(tx)
      const { eventId } = await createLocalEvent(tx, orgId, calendarId, accountId, {
        title: "On Google",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      const googleId = `gevt-${crypto.randomUUID()}`
      await applyPushResult(tx, orgId, eventId, {
        googleEventId: googleId,
        etag: '"e"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      return { eventId, calendarId, accountId, googleId }
    }

    it("is hidden from the calendar, not resurrected by the import, and swept until Google confirms", async () => {
      await withSystemDb("calendar-tombstone", async (tx) => {
        const { eventId, calendarId, googleId } = await syncedEvent(tx as any)
        const { needsGooglePush } = await deleteLocalEvent(tx as any, orgId, eventId)
        expect(needsGooglePush).toBe(true)

        // Google still has it, edited after our delete: the import must not bring it back.
        await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
          {
            items: [
              {
                id: googleId,
                status: "confirmed",
                etag: '"edited-on-google"',
                updated: new Date(Date.now() + 60_000).toISOString(),
                summary: "Edited on Google",
              },
            ],
            nextSyncToken: "tok-t",
          },
        ])
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.deleted_at).toBeTruthy()
        expect(row?.pending_push).toBe("delete")
        expect(row?.title).toBe("On Google")

        const { listEventsForCaller } = await import("~/apps/calendar/tools")
        const visible = await listEventsForCaller(tx as any, orgId, {
          calendarId,
          timeMin: "2026-07-06T00:00:00Z",
          timeMax: "2026-07-07T00:00:00Z",
        })
        expect(visible.map((e) => e.eventId)).not.toContain(eventId)
        await expect(
          updateLocalEvent(tx as any, orgId, eventId, { title: "edit a deleted event" }),
        ).rejects.toThrow(/not found/)

        await tx.execute(drizzleSql`
          UPDATE app_calendar.events SET updated_at = now() - interval '2 hours' WHERE id = ${eventId}::uuid
        `)
        expect(
          (await findStalePendingPushes(tx as any, orgId, 30, 500)).map((r) => r.id),
        ).toContain(eventId)

        await finalizeRemoteDelete(tx as any, orgId, eventId)
        expect(await getEventById(tx as any, orgId, eventId)).toBeUndefined()
      })
    })

    it("a delete Google refuses for good brings the event back with the refusal", async () => {
      await withSystemDb("calendar-tombstone-refused", async (tx) => {
        const { eventId } = await syncedEvent(tx as any)
        const { syncVersion } = await deleteLocalEvent(tx as any, orgId, eventId)
        await markPushRejected(
          tx as any,
          orgId,
          eventId,
          "deleting this event: You need to have writer access to this calendar.",
          syncVersion!,
        )
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.deleted_at).toBeNull()
        expect(row?.pending_push).toBe("none")
        expect(row?.push_error).toContain("deleting this event")
      })
    })
  })

  describe("follow-ups: full sync, refused delete, deselect, tombstones", () => {
    async function synced(tx: any, title = "Synced") {
      const { calendarId, accountId } = await seedCalendar(tx)
      const { eventId } = await createLocalEvent(tx, orgId, calendarId, accountId, {
        title,
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      const googleId = `gevt-${crypto.randomUUID()}`
      await applyPushResult(tx, orgId, eventId, {
        googleEventId: googleId,
        etag: '"e1"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      return { eventId, calendarId, accountId, googleId }
    }

    it("a full sync does not overwrite a pending local edit newer than Google's version", async () => {
      await withSystemDb("calendar-full-sync-gate", async (tx) => {
        const { eventId, calendarId, accountId, googleId } = await synced(tx as any)
        await updateLocalEvent(tx as any, orgId, eventId, { title: "Local edit, not pushed yet" })
        await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
          {
            items: [
              {
                id: googleId,
                status: "confirmed",
                etag: '"older-on-google"',
                updated: "2026-07-02T00:00:00.000Z",
                summary: "Google's older title",
              },
            ],
            nextSyncToken: "tok-full",
          },
        ])
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.title).toBe("Local edit, not pushed yet")
        expect(row?.pending_push).toBe("update")
      })
    })

    it("a full sync still applies a Google change newer than the local row", async () => {
      await withSystemDb("calendar-full-sync-newer", async (tx) => {
        const { eventId, calendarId, accountId, googleId } = await synced(tx as any)
        await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
          {
            items: [
              {
                id: googleId,
                status: "confirmed",
                etag: '"newer"',
                updated: new Date(Date.now() + 60_000).toISOString(),
                summary: "Changed on Google",
              },
            ],
            nextSyncToken: "tok-full-2",
          },
        ])
        expect((await getEventById(tx as any, orgId, eventId))?.title).toBe("Changed on Google")
      })
    })

    it("a refused delete brings the event back with Google's current values and the reason", async () => {
      await withSystemDb("calendar-refused-delete-refresh", async (tx) => {
        const { eventId } = await synced(tx as any)
        const { syncVersion } = await deleteLocalEvent(tx as any, orgId, eventId)
        const { pendingRestored } = await restoreRefusedDelete(
          tx as any,
          orgId,
          eventId,
          "deleting this event: You need to have writer access to this calendar.",
          syncVersion!,
          {
            id: "ignored",
            status: "confirmed",
            etag: '"current"',
            updated: "2026-07-05T00:00:00.000Z",
            summary: "Renamed on Google meanwhile",
          },
        )
        expect(pendingRestored).toBe(false)
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.deleted_at).toBeNull()
        expect(row?.title).toBe("Renamed on Google meanwhile")
        expect(row?.pending_push).toBe("none")
        // The reason is a notice (re-review 2026-10-05), not a push error.
        expect(row?.push_notice).toContain("writer access")
        expect(row?.push_error).toBeNull()
      })
    })

    it("a refused delete that had superseded a local edit restores that edit, pending", async () => {
      await withSystemDb("calendar-refused-delete-pending", async (tx) => {
        const { eventId } = await synced(tx as any)
        await updateLocalEvent(tx as any, orgId, eventId, { title: "My unsent edit" })
        const { syncVersion } = await deleteLocalEvent(tx as any, orgId, eventId)
        const { pendingRestored } = await restoreRefusedDelete(
          tx as any,
          orgId,
          eventId,
          "deleting this event: Invalid",
          syncVersion!,
          { id: "ignored", status: "confirmed", summary: "Google's title" },
        )
        expect(pendingRestored).toBe(true)
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.title).toBe("My unsent edit")
        expect(row?.pending_push).toBe("update")
        expect(row?.deleted_at).toBeNull()
        expect(row?.push_notice).toContain("deleting this event")
        expect(row?.push_error).toBeNull()
      })
    })

    it("deselecting a calendar keeps a tombstone that still owes Google its delete", async () => {
      await withSystemDb("calendar-deselect-tombstone", async (tx) => {
        const { eventId, calendarId } = await synced(tx as any)
        const other = await createLocalEvent(
          tx as any,
          orgId,
          calendarId,
          (await getEventById(tx as any, orgId, eventId))!.calaccess,
          {
            title: "plain",
            start: { dateTime: "2026-07-06T11:00:00Z" },
            end: { dateTime: "2026-07-06T11:30:00Z" },
          },
        )
        await applyPushResult(tx as any, orgId, other.eventId, {
          googleEventId: `gevt-${crypto.randomUUID()}`,
          etag: '"e"',
          googleUpdatedAt: "2026-07-01T00:00:00.000Z",
        })
        await deleteLocalEvent(tx as any, orgId, eventId)
        await setCalendarSelectedAndSync(tx as any, orgId, calendarId, false, async () => {}, {
          isAdmin: true,
          userId,
        })
        expect((await getEventById(tx as any, orgId, eventId))?.pending_push).toBe("delete")
        expect(await getEventById(tx as any, orgId, other.eventId)).toBeUndefined()
      })
    })
  })

  describe("re-review: refused-delete notice, deselected calendar, full-sync reset", () => {
    async function synced(tx: any, title = "Synced") {
      const { calendarId, accountId } = await seedCalendar(tx)
      const { eventId } = await createLocalEvent(tx, orgId, calendarId, accountId, {
        title,
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      const googleId = `gevt-${crypto.randomUUID()}`
      await applyPushResult(tx, orgId, eventId, {
        googleEventId: googleId,
        etag: '"e1"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      return { eventId, calendarId, accountId, googleId }
    }

    it("a restored pending edit is swept like any push, and its notice clears when the push lands", async () => {
      await withSystemDb("calendar-restore-swept", async (tx) => {
        const { eventId, googleId } = await synced(tx as any)
        await updateLocalEvent(tx as any, orgId, eventId, { title: "Unsent edit" })
        const { syncVersion } = await deleteLocalEvent(tx as any, orgId, eventId)
        await restoreRefusedDelete(
          tx as any,
          orgId,
          eventId,
          "deleting this event: No",
          syncVersion!,
          null,
        )
        await tx.execute(drizzleSql`
          UPDATE app_calendar.events SET updated_at = now() - interval '2 hours' WHERE id = ${eventId}::uuid
        `)
        const swept = (await findStalePendingPushes(tx as any, orgId, 30, 500)).map((r) => r.id)
        expect(swept).toContain(eventId)

        const row = await getEventById(tx as any, orgId, eventId)
        await applyPushResult(tx as any, orgId, eventId, {
          googleEventId: googleId,
          etag: '"e2"',
          googleUpdatedAt: "2026-07-07T00:00:00.000Z",
          syncVersion: row!.liaison_sync_version,
        })
        const after = await getEventById(tx as any, orgId, eventId)
        expect(after?.pending_push).toBe("none")
        expect(after?.push_notice).toBeNull()
      })
    })

    it("a refused delete on a calendar switched off since is dropped locally, not brought back", async () => {
      await withSystemDb("calendar-restore-deselected", async (tx) => {
        const { eventId, calendarId } = await synced(tx as any)
        const { syncVersion } = await deleteLocalEvent(tx as any, orgId, eventId)
        await setCalendarSelectedAndSync(tx as any, orgId, calendarId, false, async () => {}, {
          isAdmin: true,
          userId,
        })
        await restoreRefusedDelete(
          tx as any,
          orgId,
          eventId,
          "deleting this event: No",
          syncVersion!,
          {
            id: "ignored",
            status: "confirmed",
            summary: "Google's copy",
          },
        )
        expect(await getEventById(tx as any, orgId, eventId)).toBeUndefined()
      })
    })

    it("a full sync resets a refused change (push_error, nothing pending) to Google's version", async () => {
      await withSystemDb("calendar-full-sync-resets-refused", async (tx) => {
        const { eventId, calendarId, accountId, googleId } = await synced(tx as any)
        const { syncVersion } = await updateLocalEvent(tx as any, orgId, eventId, {
          title: "Refused edit",
        })
        await markPushRejected(tx as any, orgId, eventId, "Invalid", syncVersion)
        await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
          {
            items: [
              {
                id: googleId,
                status: "confirmed",
                etag: '"google"',
                // Older than the refused local edit: only the refusal lets Google's win.
                updated: "2026-07-02T00:00:00.000Z",
                summary: "Google's title",
              },
            ],
            nextSyncToken: "tok-reset",
          },
        ])
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.title).toBe("Google's title")
        expect(row?.push_error).toBeNull()
      })
    })
  })

  describe("re-review: a refused change whose Google etag never moved", () => {
    async function synced(tx: any) {
      const { calendarId, accountId } = await seedCalendar(tx)
      const { eventId } = await createLocalEvent(tx, orgId, calendarId, accountId, {
        title: "Google's title",
        start: { dateTime: "2026-07-06T09:00:00Z" },
        end: { dateTime: "2026-07-06T09:30:00Z" },
      })
      const googleId = `gevt-${crypto.randomUUID()}`
      await applyPushResult(tx, orgId, eventId, {
        googleEventId: googleId,
        etag: '"e1"',
        googleUpdatedAt: "2026-07-01T00:00:00.000Z",
      })
      return { eventId, calendarId, accountId, googleId }
    }

    it("a full sync resets a refused change even though Google's etag is the one we stored", async () => {
      await withSystemDb("calendar-refused-same-etag", async (tx) => {
        const { eventId, calendarId, accountId, googleId } = await synced(tx as any)
        const { syncVersion } = await updateLocalEvent(tx as any, orgId, eventId, {
          title: "Refused edit",
        })
        await markPushRejected(tx as any, orgId, eventId, "Invalid", syncVersion)
        // Google never took the edit: its copy, and its etag, are unchanged.
        await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
          {
            items: [
              {
                id: googleId,
                status: "confirmed",
                etag: '"e1"',
                updated: "2026-07-01T00:00:00.000Z",
                summary: "Google's title",
              },
            ],
            nextSyncToken: "tok-same-etag",
          },
        ])
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.title).toBe("Google's title")
        expect(row?.push_error).toBeNull()
      })
    })

    it("an echo of our own successful write is still skipped", async () => {
      await withSystemDb("calendar-echo-still-skipped", async (tx) => {
        const { eventId, calendarId, accountId, googleId } = await synced(tx as any)
        await tx.execute(drizzleSql`
          UPDATE app_calendar.events SET title = 'Local value' WHERE id = ${eventId}::uuid
        `)
        await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
          {
            items: [
              {
                id: googleId,
                status: "confirmed",
                etag: '"e1"',
                updated: new Date(Date.now() + 60_000).toISOString(),
                summary: "Echo body",
              },
            ],
            nextSyncToken: "tok-echo",
          },
        ])
        expect((await getEventById(tx as any, orgId, eventId))?.title).toBe("Local value")
      })
    })

    it("an import that brings Google's version clears a refused-delete notice", async () => {
      await withSystemDb("calendar-import-clears-notice", async (tx) => {
        const { eventId, calendarId, googleId } = await synced(tx as any)
        const { syncVersion } = await deleteLocalEvent(tx as any, orgId, eventId)
        await restoreRefusedDelete(
          tx as any,
          orgId,
          eventId,
          "deleting this event: No",
          syncVersion!,
          null,
        )
        expect((await getEventById(tx as any, orgId, eventId))?.push_notice).toContain("No")
        await applyIncrementalSyncPages(tx as any, orgId, calendarId, [
          {
            items: [
              {
                id: googleId,
                status: "confirmed",
                etag: '"e9"',
                updated: new Date(Date.now() + 60_000).toISOString(),
                summary: "Changed on Google",
              },
            ],
            nextSyncToken: "tok-notice",
          },
        ])
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.title).toBe("Changed on Google")
        expect(row?.push_notice).toBeNull()
      })
    })
  })

  describe("Google Meet conferencing", () => {
    const MEET = "https://meet.google.com/abc-defg-hij"

    it("a create asking for a Meet records the request; the push result stores Google's link and clears it", async () => {
      await withSystemDb("calendar-meet-create", async (tx) => {
        const { calendarId, accountId } = await seedCalendar(tx as any)
        const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
          title: "Sync with a colleague",
          start: { dateTime: "2026-07-06T11:00:00Z" },
          end: { dateTime: "2026-07-06T11:30:00Z" },
          conference: "add",
        })
        const before = await getEventById(tx as any, orgId, eventId)
        expect(before?.conference_request).toBe("add")
        expect(before?.location).toBeNull()
        await applyPushResult(tx as any, orgId, eventId, {
          googleEventId: "evt-meet-1",
          etag: '"m1"',
          googleUpdatedAt: "2026-07-06T00:00:00.000Z",
          hangoutLink: MEET,
          syncVersion: before!.liaison_sync_version,
        })
        const after = await getEventById(tx as any, orgId, eventId)
        expect(after?.hangout_link).toBe(MEET)
        expect(after?.conference_request).toBeNull()
        expect(after?.pending_push).toBe("none")
      })
    })

    it("an update can add or remove the Meet of an existing event, alongside time and guests", async () => {
      await withSystemDb("calendar-meet-update", async (tx) => {
        const { calendarId, accountId } = await seedCalendar(tx as any)
        const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
          title: "Existing",
          start: { dateTime: "2026-07-06T09:00:00Z" },
          end: { dateTime: "2026-07-06T09:30:00Z" },
        })
        await applyPushResult(tx as any, orgId, eventId, {
          googleEventId: "evt-meet-2",
          etag: '"m2"',
          googleUpdatedAt: "2026-07-01T00:00:00.000Z",
        })
        await updateLocalEvent(tx as any, orgId, eventId, {
          conference: "add",
          start: { dateTime: "2026-07-06T11:00:00Z" },
          end: { dateTime: "2026-07-06T11:30:00Z" },
          attendees: ["guest@acme.example"],
        })
        const added = await getEventById(tx as any, orgId, eventId)
        expect(added?.conference_request).toBe("add")
        expect(added?.pending_push).toBe("update")
        expect(added?.start).toEqual({ dateTime: "2026-07-06T11:00:00Z" })
        expect((added!.attendees as Array<{ email: string }>).map((a) => a.email)).toEqual([
          "guest@acme.example",
        ])
        // A later edit that does not mention the conference keeps the pending request.
        await updateLocalEvent(tx as any, orgId, eventId, { title: "Renamed" })
        expect((await getEventById(tx as any, orgId, eventId))?.conference_request).toBe("add")
        await updateLocalEvent(tx as any, orgId, eventId, { conference: "remove" })
        expect((await getEventById(tx as any, orgId, eventId))?.conference_request).toBe("remove")
      })
    })

    it("a refused push drops the conference request so it is not re-sent forever", async () => {
      await withSystemDb("calendar-meet-refused", async (tx) => {
        const { calendarId, accountId } = await seedCalendar(tx as any)
        const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
          title: "Refused meet",
          start: { dateTime: "2026-07-06T09:00:00Z" },
          end: { dateTime: "2026-07-06T09:30:00Z" },
          conference: "add",
        })
        await markPushRejected(tx as any, orgId, eventId, "Invalid conference type value.", 1)
        const row = await getEventById(tx as any, orgId, eventId)
        expect(row?.conference_request).toBeNull()
        expect(row?.push_error).toBe("Invalid conference type value.")
      })
    })

    it("an inbound event's Meet link is read from conferenceData when hangoutLink is absent", async () => {
      await withSystemDb("calendar-meet-inbound", async (tx) => {
        const { calendarId, accountId } = await seedCalendar(tx as any)
        await applyInitialSyncPages(tx as any, orgId, calendarId, accountId, [
          {
            items: [
              {
                id: "g-inbound-meet",
                status: "confirmed",
                etag: '"i1"',
                updated: "2026-07-01T00:00:00.000Z",
                summary: "Inbound",
                start: { dateTime: "2026-07-06T09:00:00Z" },
                end: { dateTime: "2026-07-06T09:30:00Z" },
                conferenceData: {
                  entryPoints: [
                    { entryPointType: "phone", uri: "tel:+1-555-0100" },
                    { entryPointType: "video", uri: MEET },
                  ],
                },
              },
            ],
            nextSyncToken: "tok-meet",
          },
        ])
        const row = await getEventByGoogleId(tx as any, orgId, calendarId, "g-inbound-meet")
        expect(row?.hangout_link).toBe(MEET)
      })
    })
  })

  describe("recurring meetings: which event an update changes", () => {
    async function seedSeries(tx: any) {
      const { calendarId, accountId } = await seedCalendar(tx)
      const masterId = `gmaster${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`
      await applyInitialSyncPages(tx, orgId, calendarId, accountId, [
        {
          items: [
            {
              id: masterId,
              status: "confirmed",
              etag: '"m"',
              updated: "2026-07-01T00:00:00.000Z",
              summary: "Weekly sync",
              start: { dateTime: "2026-07-06T09:00:00Z", timeZone: "Europe/Paris" },
              end: { dateTime: "2026-07-06T09:30:00Z", timeZone: "Europe/Paris" },
              recurrence: ["RRULE:FREQ=WEEKLY;COUNT=5"],
              attendees: [{ email: "guest@acme.example" }],
            },
            {
              id: `${masterId}_20260720T090000Z`,
              status: "confirmed",
              etag: '"x"',
              updated: "2026-07-01T00:00:00.000Z",
              summary: "Weekly sync (moved)",
              recurringEventId: masterId,
              originalStartTime: { dateTime: "2026-07-20T09:00:00Z" },
              start: { dateTime: "2026-07-20T10:00:00Z" },
              end: { dateTime: "2026-07-20T10:30:00Z" },
            },
          ],
          nextSyncToken: `tok-${masterId}`,
        },
      ])
      const master = await getEventByGoogleId(tx, orgId, calendarId, masterId)
      const exception = await getEventByGoogleId(
        tx,
        orgId,
        calendarId,
        `${masterId}_20260720T090000Z`,
      )
      return { calendarId, masterId, master: master!, exception: exception! }
    }

    it("a recurring master without a scope is refused with a question for the user, by Google id or local id", async () => {
      await withSystemDb("calendar-recurring-ask", async (tx) => {
        const { masterId, master } = await seedSeries(tx as any)
        for (const eventId of [masterId, master.id]) {
          const err = await resolveUpdateTarget(tx as any, orgId, { eventId }).catch((e) => e)
          expect(err).toBeInstanceOf(Error)
          expect(err.status).toBe(422)
          expect(err.message).toContain("recurring")
          expect(err.message).toContain("Ask the user")
          expect(err.message).toContain('scope: "occurrence"')
          expect(err.message).toContain('scope: "series"')
        }
      })
    })

    it('scope "series" on the master, by the Google id list_events returns, edits the master row', async () => {
      await withSystemDb("calendar-recurring-series", async (tx) => {
        const { masterId, master } = await seedSeries(tx as any)
        const target = await resolveUpdateTarget(tx as any, orgId, {
          eventId: masterId,
          scope: "series",
        })
        expect(target).toEqual({ eventId: master.id, scope: "series" })
      })
    })

    it('scope "occurrence" on the master materializes that one instance under Google\'s instance id, once', async () => {
      await withSystemDb("calendar-recurring-occurrence", async (tx) => {
        const { calendarId, masterId } = await seedSeries(tx as any)
        const target = await resolveUpdateTarget(tx as any, orgId, {
          eventId: masterId,
          scope: "occurrence",
          occurrenceStart: "2026-07-13T09:00:00Z",
        })
        expect(target.scope).toBe("occurrence")
        const row = await getEventById(tx as any, orgId, target.eventId)
        expect(row?.google_event_id).toBe(`${masterId}_20260713T090000Z`)
        expect(row?.recurring_event_id).toBe(masterId)
        expect(row?.calendar_id).toBe(calendarId)
        expect(row?.title).toBe("Weekly sync")
        expect(row?.start).toEqual({
          dateTime: "2026-07-13T09:00:00.000Z",
          timeZone: "Europe/Paris",
        })
        expect(row?.end).toEqual({ dateTime: "2026-07-13T09:30:00.000Z", timeZone: "Europe/Paris" })
        expect(row?.recurrence).toBeNull()
        // The same occurrence resolves to the same row.
        const again = await resolveUpdateTarget(tx as any, orgId, {
          eventId: masterId,
          scope: "occurrence",
          occurrenceStart: "2026-07-13T11:00:00+02:00",
        })
        expect(again.eventId).toBe(target.eventId)
        // Editing it leaves the series alone and queues an update of the instance on Google.
        await updateLocalEvent(tx as any, orgId, target.eventId, {
          start: { dateTime: "2026-07-13T11:00:00Z" },
          end: { dateTime: "2026-07-13T11:30:00Z" },
        })
        const edited = await getEventById(tx as any, orgId, target.eventId)
        expect(edited?.pending_push).toBe("update")
        const master = await getEventByGoogleId(tx as any, orgId, calendarId, masterId)
        expect(master?.start).toEqual({
          dateTime: "2026-07-06T09:00:00Z",
          timeZone: "Europe/Paris",
        })
        expect(master?.pending_push).toBe("none")
      })
    })

    it("an occurrence the series does not have, or a missing occurrenceStart, is refused", async () => {
      await withSystemDb("calendar-recurring-bad-occurrence", async (tx) => {
        const { masterId } = await seedSeries(tx as any)
        const missing = await resolveUpdateTarget(tx as any, orgId, {
          eventId: masterId,
          scope: "occurrence",
        }).catch((e) => e)
        expect(missing.status).toBe(422)
        expect(missing.message).toContain("occurrenceStart")
        const wrong = await resolveUpdateTarget(tx as any, orgId, {
          eventId: masterId,
          scope: "occurrence",
          occurrenceStart: "2026-07-14T09:00:00Z",
        }).catch((e) => e)
        expect(wrong.status).toBe(422)
        expect(wrong.message).toContain("2026-07-14T09:00:00")
        const recurrenceChange = await resolveUpdateTarget(tx as any, orgId, {
          eventId: masterId,
          scope: "occurrence",
          occurrenceStart: "2026-07-13T09:00:00Z",
          changesRecurrence: true,
        }).catch((e) => e)
        expect(recurrenceChange.status).toBe(422)
      })
    })

    it("an occurrence already edited on Google (exception row) needs a scope too; occurrence edits it, series edits the master", async () => {
      await withSystemDb("calendar-recurring-exception", async (tx) => {
        const { master, exception } = await seedSeries(tx as any)
        const ask = await resolveUpdateTarget(tx as any, orgId, { eventId: exception.id }).catch(
          (e) => e,
        )
        expect(ask.status).toBe(422)
        expect(ask.message).toContain("Ask the user")
        expect(
          await resolveUpdateTarget(tx as any, orgId, {
            eventId: exception.id,
            scope: "occurrence",
          }),
        ).toEqual({ eventId: exception.id, scope: "occurrence" })
        expect(
          await resolveUpdateTarget(tx as any, orgId, { eventId: exception.id, scope: "series" }),
        ).toEqual({ eventId: master.id, scope: "series" })
        // Asking for the moved occurrence through the master finds that same row.
        const viaMaster = await resolveUpdateTarget(tx as any, orgId, {
          eventId: master.google_event_id!,
          scope: "occurrence",
          occurrenceStart: "2026-07-20T09:00:00Z",
        })
        expect(viaMaster.eventId).toBe(exception.id)
      })
    })

    it("delete_event on a series without a scope is refused with the same question, naming delete_event", async () => {
      await withSystemDb("calendar-recurring-delete-ask", async (tx) => {
        const { masterId } = await seedSeries(tx as any)
        const err = await resolveUpdateTarget(tx as any, orgId, {
          eventId: masterId,
          tool: "delete_event",
        }).catch((e) => e)
        expect(err.status).toBe(422)
        expect(err.message).toContain("Ask the user")
        expect(err.message).toContain("delete_event")
        expect(err.message).not.toContain("update_event")
      })
    })

    it("deleting one occurrence cancels only that instance: tombstoned on its Google instance id, shown cancelled, and kept cancelled once Google confirms", async () => {
      await withSystemDb("calendar-recurring-delete-occurrence", async (tx) => {
        const { calendarId, masterId, master } = await seedSeries(tx as any)
        const target = await resolveUpdateTarget(tx as any, orgId, {
          eventId: masterId,
          scope: "occurrence",
          occurrenceStart: "2026-07-13T09:00:00Z",
          tool: "delete_event",
        })
        const del = await deleteLocalEvent(tx as any, orgId, target.eventId)
        expect(del.needsGooglePush).toBe(true)
        expect(del.googleEventId).toBe(`${masterId}_20260713T090000Z`)
        const { listEventsForCaller } = await import("~/apps/calendar/tools")
        const window = {
          calendarId,
          timeMin: "2026-07-01T00:00:00Z",
          timeMax: "2026-08-31T00:00:00Z",
        }
        const occurrenceOf = async () =>
          (await listEventsForCaller(tx as any, orgId, window)).find(
            (e) => e.recurringEventId === masterId && e.eventId === target.eventId,
          )
        // While the delete is on its way, the occurrence already reads as cancelled.
        expect((await occurrenceOf())?.status).toBe("cancelled")
        // The series itself is untouched.
        expect((await getEventById(tx as any, orgId, master.id))?.deleted_at ?? null).toBeNull()
        await finalizeRemoteDelete(tx as any, orgId, target.eventId)
        const row = await getEventById(tx as any, orgId, target.eventId)
        expect(row?.status).toBe("cancelled")
        expect(row?.deleted_at ?? null).toBeNull()
        expect(row?.pending_push).toBe("none")
        expect((await occurrenceOf())?.status).toBe("cancelled")
      })
    })

    it('deleting with scope "series" deletes the master (by the Google id list_events returns)', async () => {
      await withSystemDb("calendar-recurring-delete-series", async (tx) => {
        const { masterId, master, exception } = await seedSeries(tx as any)
        const target = await resolveUpdateTarget(tx as any, orgId, {
          eventId: exception.id,
          scope: "series",
          tool: "delete_event",
        })
        expect(target.eventId).toBe(master.id)
        const del = await deleteLocalEvent(tx as any, orgId, target.eventId)
        expect(del).toMatchObject({ needsGooglePush: true, googleEventId: masterId })
      })
    })

    it("a plain event ignores scope", async () => {
      await withSystemDb("calendar-recurring-plain", async (tx) => {
        const { calendarId, accountId } = await seedCalendar(tx as any)
        const { eventId } = await createLocalEvent(tx as any, orgId, calendarId, accountId, {
          title: "One-off",
          start: { dateTime: "2026-07-06T09:00:00Z" },
          end: { dateTime: "2026-07-06T09:30:00Z" },
        })
        expect(await resolveUpdateTarget(tx as any, orgId, { eventId })).toEqual({
          eventId,
          scope: null,
        })
      })
    })
  })
})
