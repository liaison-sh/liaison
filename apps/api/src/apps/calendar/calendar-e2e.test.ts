// SPDX-License-Identifier: FSL-1.1-ALv2
// Task 9 — end-to-end backend journey: connect (org + personal) → import → initial sync from
// fixtures → incremental update+delete → local create/edit → push → echo suppressed → 410
// recovery, asserting persisted state across the whole chain in one continuous run. Also proves
// cross-org isolation and org member vs admin gating on org connect. Google is mocked only at
// the fetch seam boundary (fixture pages passed straight into the host sync functions, exactly
// as inbound-sync.test.ts / outbound-sync.test.ts do) — every other layer is the real DB.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  applyIncrementalSyncPages,
  applyInitialSyncPages,
  applyPushResult,
  createLocalEvent,
  getEventByGoogleId,
  onAccountConnected,
  recoverFromSyncTokenGone,
  runCalendarImport,
} from "~/apps/calendar/sync"
import { withSystemDb } from "~/db/privileged"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgAId: string
let orgAUserId: string
let orgAOtherUserId: string
let orgBId: string
let orgBUserId: string

async function registerCalendarSchemaFor(orgId: string) {
  const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
  const { resetAppRegistries } = await import("~/modules/apps/app-registries")
  const { registerApps } = await import("~/modules/apps/runtime")
  resetAppRegistries()
  await withSystemDb("calendar-e2e-fixture-reg", async (tx) => {
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
  const slug = `cal-e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("calendar-e2e-fixture", async (tx) => {
    const oa = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Calendar E2E Org A', ${`${slug}-a`})
      RETURNING id
    `)) as any
    orgAId = (oa.rows ?? oa)[0].id
    const ua = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgAId}::uuid, ${`owner-${slug}@x.test`}, 'Owner A', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    orgAUserId = (ua.rows ?? ua)[0].id
    const ub = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgAId}::uuid, ${`member-${slug}@x.test`}, 'Member A', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    orgAOtherUserId = (ub.rows ?? ub)[0].id

    const ob = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Calendar E2E Org B', ${`${slug}-b`})
      RETURNING id
    `)) as any
    orgBId = (ob.rows ?? ob)[0].id
    const ubOrg = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgBId}::uuid, ${`owner-${slug}-b@x.test`}, 'Owner B', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    orgBUserId = (ubOrg.rows ?? ubOrg)[0].id
  })
  await registerCalendarSchemaFor(orgAId)
  await registerCalendarSchemaFor(orgBId)
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

describe("calendar backend e2e journey", () => {
  it("org connect + personal connect → import → initial sync → incremental update+delete → local create → push → echo suppressed → 410 recovery, all in one continuous flow", async () => {
    await withSystemDb("calendar-e2e-journey", async (tx) => {
      // --- 1. Org-wide connect (admin-initiated) ---
      const orgConnectEvent = {
        orgId: orgAId,
        actorId: orgAUserId,
        data: {
          id: crypto.randomUUID(),
          appName: "calendar",
          ownerType: "org" as const,
          ownerId: null,
          identifier: "e2e-org@gmail.com",
          connectionName: "google-calendar",
        },
      }
      const { accountId: orgAccountId } = await onAccountConnected(
        tx as any,
        orgAId,
        orgConnectEvent,
        async () => {},
      )
      const { calendarIds: orgCalendarIds } = await runCalendarImport(
        tx as any,
        orgAId,
        orgAccountId,
        async () => [{ id: "gcal-e2e-org", summary: "Org Calendar" }],
        async () => {},
      )
      const orgCalendarId = orgCalendarIds[0]!

      // Both org members are granted the calendar:calaccess dimension for an org-wide connect.
      const orgGrants = (await tx.execute(drizzleSql`
        SELECT user_id FROM kernel.user_dimension_grants
        WHERE org_id = ${orgAId}::uuid AND dimension_key = 'calendar:calaccess'
      `)) as any
      const orgGrantUserIds = (orgGrants.rows ?? orgGrants).map(
        (r: { user_id: string }) => r.user_id,
      )
      expect(orgGrantUserIds).toContain(orgAUserId)
      expect(orgGrantUserIds).toContain(orgAOtherUserId)

      // --- 2. Personal connect (a different user) ---
      const personalConnectEvent = {
        orgId: orgAId,
        actorId: orgAOtherUserId,
        data: {
          id: crypto.randomUUID(),
          appName: "calendar",
          ownerType: "user" as const,
          ownerId: orgAOtherUserId,
          identifier: "e2e-personal@gmail.com",
          connectionName: "google-calendar",
        },
      }
      const { accountId: personalAccountId } = await onAccountConnected(
        tx as any,
        orgAId,
        personalConnectEvent,
        async () => {},
      )
      const { calendarIds: personalCalendarIds } = await runCalendarImport(
        tx as any,
        orgAId,
        personalAccountId,
        async () => [{ id: "gcal-e2e-personal" }],
        async () => {},
      )
      const personalCalendarId = personalCalendarIds[0]!

      // --- 3. Initial sync from Google fixtures on the org calendar ---
      await applyInitialSyncPages(tx as any, orgAId, orgCalendarId, orgAccountId, [
        {
          items: [
            {
              id: "evt-e2e-a",
              status: "confirmed",
              etag: '"e2e-a1"',
              summary: "All Hands",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
            {
              id: "evt-e2e-b",
              status: "confirmed",
              etag: '"e2e-b1"',
              summary: "To Be Cancelled",
              start: { dateTime: "2026-07-06T10:00:00Z" },
              end: { dateTime: "2026-07-06T10:30:00Z" },
              updated: "2026-07-01T00:00:00.000Z",
            },
          ],
          nextSyncToken: "e2e-tok-0",
        },
      ])
      expect((await getEventByGoogleId(tx as any, orgAId, orgCalendarId, "evt-e2e-a"))?.title).toBe(
        "All Hands",
      )

      // --- 4. Incremental sync: update evt-e2e-a, cancel-delete evt-e2e-b ---
      await applyIncrementalSyncPages(tx as any, orgAId, orgCalendarId, [
        {
          items: [
            {
              id: "evt-e2e-a",
              status: "confirmed",
              etag: '"e2e-a2"',
              summary: "All Hands (updated)",
              start: { dateTime: "2026-07-06T09:00:00Z" },
              end: { dateTime: "2026-07-06T09:30:00Z" },
              updated: "2026-07-02T00:00:00.000Z",
            },
            { id: "evt-e2e-b", status: "cancelled" },
          ],
          nextSyncToken: "e2e-tok-1",
        },
      ])
      expect((await getEventByGoogleId(tx as any, orgAId, orgCalendarId, "evt-e2e-a"))?.title).toBe(
        "All Hands (updated)",
      )
      expect(
        await getEventByGoogleId(tx as any, orgAId, orgCalendarId, "evt-e2e-b"),
      ).toBeUndefined()

      // --- 5. Local create → push → simulated echo (loop prevention end-to-end) ---
      const { eventId: localEventId } = await createLocalEvent(
        tx as any,
        orgAId,
        orgCalendarId,
        orgAccountId,
        {
          title: "Locally created",
          start: { dateTime: "2026-07-06T14:00:00Z" },
          end: { dateTime: "2026-07-06T14:30:00Z" },
        },
      )
      await applyPushResult(tx as any, orgAId, localEventId, {
        googleEventId: "evt-e2e-local",
        etag: '"e2e-local-1"',
        googleUpdatedAt: "2026-07-03T00:00:00.000Z",
      })
      // Inbound echo of our own push (same etag) must not clobber or duplicate.
      await applyIncrementalSyncPages(tx as any, orgAId, orgCalendarId, [
        {
          items: [
            {
              id: "evt-e2e-local",
              status: "confirmed",
              etag: '"e2e-local-1"',
              summary: "Echo (ignored)",
              start: { dateTime: "2026-07-06T14:00:00Z" },
              end: { dateTime: "2026-07-06T14:30:00Z" },
              updated: "2026-07-03T00:00:00.000Z",
            },
          ],
          nextSyncToken: "e2e-tok-2",
        },
      ])
      expect(
        (await getEventByGoogleId(tx as any, orgAId, orgCalendarId, "evt-e2e-local"))?.title,
      ).toBe("Locally created")
      const [dupCount] = (await tx.execute(drizzleSql`
        SELECT count(*)::int AS c FROM app_calendar.events WHERE calendar_id = ${orgCalendarId}::uuid AND google_event_id = 'evt-e2e-local'
      `)) as any
      expect(
        ((dupCount.rows ?? dupCount)[0] ?? (Array.isArray(dupCount) ? dupCount[0] : dupCount)).c,
      ).toBe(1)

      // --- 6. 410 recovery ---
      const jobs: Array<{ jobName: string; payload: Record<string, unknown> }> = []
      await recoverFromSyncTokenGone(tx as any, orgAId, orgCalendarId, async (jobName, payload) => {
        jobs.push({ jobName, payload })
      })
      expect(
        await getEventByGoogleId(tx as any, orgAId, orgCalendarId, "evt-e2e-a"),
      ).toBeUndefined()
      expect(jobs.filter((j) => j.jobName === "calendar-initial-sync").length).toBe(1)

      // --- 7. Personal calendar remains isolated from the org flow throughout ---
      const [personalCalRow] = (await tx.execute(drizzleSql`
        SELECT count(*)::int AS c FROM app_calendar.calendars WHERE id = ${personalCalendarId}::uuid
      `)) as any
      expect(
        (
          (personalCalRow.rows ?? personalCalRow)[0] ??
          (Array.isArray(personalCalRow) ? personalCalRow[0] : personalCalRow)
        ).c,
      ).toBe(1)
    })
  })

  it("cross-org isolation: org B has zero calendar rows visible from org A's data", async () => {
    await withSystemDb("calendar-e2e-cross-org", async (tx) => {
      const [rows] = (await tx.execute(drizzleSql`
        SELECT count(*)::int AS c FROM app_calendar.calendars WHERE org_id = ${orgBId}::uuid
      `)) as any
      const row = (rows.rows ?? rows)[0] ?? (Array.isArray(rows) ? rows[0] : rows)
      expect(row.c).toBe(0)
    })
  })

  it("org member vs admin gating: only a connect with ownerType=org grants org-wide visibility; a personal connect by a non-admin member stays scoped to that member", async () => {
    await withSystemDb("calendar-e2e-member-gating", async (tx) => {
      const memberPersonalEvent = {
        orgId: orgAId,
        actorId: orgAOtherUserId,
        data: {
          id: crypto.randomUUID(),
          appName: "calendar",
          ownerType: "user" as const,
          ownerId: orgAOtherUserId,
          identifier: "e2e-member-gating@gmail.com",
          connectionName: "google-calendar",
        },
      }
      const { accountId } = await onAccountConnected(
        tx as any,
        orgAId,
        memberPersonalEvent,
        async () => {},
      )
      await runCalendarImport(
        tx as any,
        orgAId,
        accountId,
        async () => [{ id: "gcal-member-gating" }],
        async () => {},
      )

      const grants = (await tx.execute(drizzleSql`
        SELECT user_id, dimension_values FROM kernel.user_dimension_grants
        WHERE org_id = ${orgAId}::uuid AND dimension_key = 'calendar:calaccess'
      `)) as any
      const rows = (grants.rows ?? grants) as Array<{ user_id: string; dimension_values: string[] }>
      const grantedForThisAccount = rows
        .filter((r) => r.dimension_values.includes(accountId))
        .map((r) => r.user_id)
      // Only the connecting member — NOT the org owner — is granted for this personal account.
      expect(grantedForThisAccount).toEqual([orgAOtherUserId])
      expect(grantedForThisAccount).not.toContain(orgAUserId)
    })
  })
})
