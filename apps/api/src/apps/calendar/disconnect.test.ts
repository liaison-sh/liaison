// SPDX-License-Identifier: FSL-1.1-ALv2
// Disconnecting a Google Calendar account left its calendars and events listed (LIF-17
// follow-up). Disconnect now deletes what was stored for that account, and only that account;
// a reconnect imports it again from Google. A disconnect whose event has not reached the app
// yet (or never did) is caught up when the accounts are next listed.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  ensureCallerCalendarAccounts,
  onAccountConnected,
  onAccountDisconnected,
  reconcileDisconnectedCalendarAccounts,
  runCalendarImport,
} from "~/apps/calendar/sync"
import {
  listAccountsForCaller,
  listCalendarsForCaller,
  listEventsForCaller,
} from "~/apps/calendar/tools"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgId: string
let userId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-disconnect-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("calendar-disconnect-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Calendar Disconnect Org', ${slug})
      RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`user-${slug}@x.test`}, 'User', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (u.rows ?? u)[0].id
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
  await registerApps([calendarAppManifest as any], orgId)
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

interface SeededAccount {
  connectionId: string
  accountId: string
  calendarId: string
  email: string
  tag: string
}

/** A kernel connection, its app account, one imported calendar holding a plain event, a
 * recurring master with one exception, and a sync log row. */
async function seedAccount(label: string): Promise<SeededAccount> {
  const tag = `${label}-${crypto.randomUUID().slice(0, 8)}`
  const email = `${tag}@x.test`
  return withSystemDb("calendar-disconnect-seed", async (tx) => {
    const c = (await tx.execute(drizzleSql`
      INSERT INTO kernel.connected_accounts
        (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by)
      VALUES (gen_random_uuid(), ${orgId}::uuid, 'calendar', 'google-calendar', 'user',
              ${userId}::uuid, 'oauth2', ${email}, 'active', ${userId}::uuid)
      RETURNING id
    `)) as any
    const connectionId = (c.rows ?? c)[0].id as string
    const { accountId } = await onAccountConnected(
      tx as any,
      orgId,
      {
        orgId,
        actorId: userId,
        data: {
          id: connectionId,
          appName: "calendar",
          ownerType: "user",
          ownerId: userId,
          identifier: email,
          connectionName: "google-calendar",
        },
      },
      async () => {},
    )
    const { calendarIds } = await runCalendarImport(
      tx as any,
      orgId,
      accountId,
      async () => [{ id: `gcal-${tag}`, summary: `Calendar ${tag}` }],
      async () => {},
    )
    const calendarId = calendarIds[0]!
    await tx.execute(drizzleSql`
      INSERT INTO app_calendar.events
        (id, org_id, calendar_id, google_event_id, title, start, "end", calaccess)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, ${`plain${tag}`}, ${`plain ${tag}`},
              '{"dateTime":"2026-10-14T10:00:00Z"}'::jsonb, '{"dateTime":"2026-10-14T11:00:00Z"}'::jsonb,
              ${accountId})
    `)
    await tx.execute(drizzleSql`
      INSERT INTO app_calendar.events
        (id, org_id, calendar_id, google_event_id, title, start, "end", recurrence, calaccess)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, ${`series${tag}`}, ${`series ${tag}`},
              '{"dateTime":"2026-10-05T09:00:00Z"}'::jsonb, '{"dateTime":"2026-10-05T09:30:00Z"}'::jsonb,
              '["RRULE:FREQ=DAILY"]'::jsonb, ${accountId})
    `)
    await tx.execute(drizzleSql`
      INSERT INTO app_calendar.events
        (id, org_id, calendar_id, google_event_id, title, recurring_event_id, original_start_time,
         status, calaccess)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, ${`series${tag}_20261013T090000Z`},
              ${`exception ${tag}`}, ${`series${tag}`}, '{"dateTime":"2026-10-13T09:00:00Z"}'::jsonb,
              'cancelled', ${accountId})
    `)
    await tx.execute(drizzleSql`
      INSERT INTO app_calendar.sync_log (id, org_id, calendar_id, operation, status, calaccess)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'initial-sync', 'ok', ${accountId})
    `)
    return { connectionId, accountId, calendarId, email, tag }
  })
}

/** What DELETE /connections/:id does before it emits the disconnect event. */
async function disconnectKernelConnection(connectionId: string): Promise<void> {
  await withSystemDb("calendar-disconnect-kernel", async (tx) => {
    await tx.execute(drizzleSql`
      UPDATE kernel.connected_accounts SET status = 'disconnected', disconnected_at = now()
      WHERE id = ${connectionId}::uuid
    `)
  })
}

async function storedFor(accountId: string) {
  return withSystemDb("calendar-disconnect-count", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      SELECT
        (SELECT count(*)::int FROM app_calendar.calendars WHERE account_id = ${accountId}::uuid) AS calendars,
        (SELECT count(*)::int FROM app_calendar.events WHERE calaccess = ${accountId}) AS events,
        (SELECT count(*)::int FROM app_calendar.sync_log WHERE calaccess = ${accountId}) AS logs,
        (SELECT sync_status FROM app_calendar.accounts WHERE id = ${accountId}::uuid) AS status,
        (SELECT disconnected_at IS NOT NULL FROM app_calendar.accounts WHERE id = ${accountId}::uuid) AS disconnected
    `)) as any
    return (r.rows ?? r)[0] as {
      calendars: number
      events: number
      logs: number
      status: string
      disconnected: boolean
    }
  })
}

async function grants(): Promise<Record<string, string[]>> {
  return withSystemDb("calendar-disconnect-grants", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      SELECT dimension_key, dimension_values FROM kernel.user_dimension_grants
      WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid
    `)) as any
    const out: Record<string, string[]> = {}
    for (const row of (r.rows ?? r) as Array<{
      dimension_key: string
      dimension_values: string[]
    }>) {
      out[row.dimension_key] = row.dimension_values
    }
    return out
  })
}

async function asUser<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  return withRlsContext(
    {
      actorType: "user",
      userId,
      orgId,
      scopes: ["calendar:events:read", "calendar:calendars:read", "calendar:accounts:read"],
      dimensionGrants: await grants(),
    },
    fn,
  )
}

const week = { timeMin: "2026-10-12T00:00:00Z", timeMax: "2026-10-19T00:00:00Z" }

describe("disconnecting a calendar account", () => {
  it("deletes that account's calendars, events and sync log, and nothing of another account", async () => {
    const gone = await seedAccount("gone")
    const kept = await seedAccount("kept")
    expect(await storedFor(gone.accountId)).toMatchObject({ calendars: 1, events: 3, logs: 1 })

    await disconnectKernelConnection(gone.connectionId)
    await withSystemDb("calendar-disconnect-event", (tx) =>
      onAccountDisconnected(tx as any, orgId, {
        orgId,
        data: { id: gone.connectionId, appName: "calendar" },
      }),
    )

    expect(await storedFor(gone.accountId)).toEqual({
      calendars: 0,
      events: 0,
      logs: 0,
      status: "disconnected",
      disconnected: true,
    })
    expect(await storedFor(kept.accountId)).toMatchObject({
      calendars: 1,
      events: 3,
      logs: 1,
      disconnected: false,
    })

    const calendars = await asUser((tx) => listCalendarsForCaller(tx, orgId))
    expect(calendars.map((c) => c.id)).not.toContain(gone.calendarId)
    expect(calendars.map((c) => c.id)).toContain(kept.calendarId)
    const titles = (await asUser((tx) => listEventsForCaller(tx, orgId, week))).map((e) => e.title)
    expect(titles.filter((t) => t?.endsWith(gone.tag))).toEqual([])
    expect(titles).toContain(`plain ${kept.tag}`)
  })

  it("a reconnect of the same address imports its calendars again", async () => {
    const account = await seedAccount("again")
    await disconnectKernelConnection(account.connectionId)
    await withSystemDb("calendar-disconnect-again", (tx) =>
      onAccountDisconnected(tx as any, orgId, {
        orgId,
        data: { id: account.connectionId, appName: "calendar" },
      }),
    )
    const jobs: Array<Record<string, unknown>> = []
    const revived = await withSystemDb("calendar-reconnect", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "user",
            ownerId: userId,
            identifier: account.email,
            connectionName: "google-calendar",
          },
        },
        async (_job, payload) => {
          jobs.push(payload)
        },
      )
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: `gcal-${account.tag}`, summary: `Calendar ${account.tag}` }],
        async () => {},
      )
      return accountId
    })
    expect(revived).toBe(account.accountId)
    expect(jobs).toEqual([{ orgId, accountId: account.accountId }])
    const calendars = await asUser((tx) => listCalendarsForCaller(tx, orgId))
    expect(calendars.map((c) => c.name)).toContain(`Calendar ${account.tag}`)
  })

  it("catches up a disconnect the app has not processed, and clears data a past disconnect left", async () => {
    const pending = await seedAccount("pending")
    const legacy = await seedAccount("legacy")
    const live = await seedAccount("live")
    await withSystemDb("calendar-disconnect-kernel-only", async (tx) => {
      // The kernel connection is disconnected; its event has not reached the app yet.
      await tx.execute(drizzleSql`
        UPDATE kernel.connected_accounts SET status = 'disconnected', disconnected_at = now()
        WHERE id = ${pending.connectionId}::uuid
      `)
      // A disconnect from before deletion existed: account marked, its data still stored.
      await tx.execute(drizzleSql`
        UPDATE kernel.connected_accounts SET status = 'disconnected', disconnected_at = now()
        WHERE id = ${legacy.connectionId}::uuid
      `)
      await tx.execute(drizzleSql`
        UPDATE app_calendar.accounts SET sync_status = 'disconnected', disconnected_at = now()
        WHERE id = ${legacy.accountId}::uuid
      `)
    })
    // What Settings reads right after the click: the account is still listed.
    expect((await asUser((tx) => listAccountsForCaller(tx, orgId))).map((a) => a.id)).toContain(
      pending.accountId,
    )

    const purged = await withSystemDb("calendar-disconnect-reconcile", (tx) =>
      reconcileDisconnectedCalendarAccounts(tx as any, orgId),
    )
    expect([...purged].sort()).toEqual([pending.accountId, legacy.accountId].sort())

    expect(await storedFor(pending.accountId)).toMatchObject({
      calendars: 0,
      events: 0,
      logs: 0,
      disconnected: true,
    })
    expect(await storedFor(legacy.accountId)).toMatchObject({ calendars: 0, events: 0, logs: 0 })
    expect(await storedFor(live.accountId)).toMatchObject({
      calendars: 1,
      events: 3,
      logs: 1,
      disconnected: false,
    })
    const accounts = (await asUser((tx) => listAccountsForCaller(tx, orgId))).map((a) => a.id)
    expect(accounts).not.toContain(pending.accountId)
    expect(accounts).toContain(live.accountId)

    // Nothing left to do: a second pass purges nothing.
    const again = await withSystemDb("calendar-disconnect-reconcile-2", (tx) =>
      reconcileDisconnectedCalendarAccounts(tx as any, orgId),
    )
    expect(again).toEqual([])
  })

  // A Google re-auth: the OAuth callback marks the old kernel connection disconnected, inserts
  // a new active one for the same address and emits only `create`. Until that event is
  // processed the app row still points at the old connection. Nothing may be deleted then.
  it("a re-auth of the same address deletes nothing, and the row is rebound", async () => {
    const account = await seedAccount("reauth")
    const newConnectionId = await withSystemDb("calendar-reauth-callback", async (tx) => {
      await tx.execute(drizzleSql`
        UPDATE app_calendar.events SET pending_push = 'update'
        WHERE calaccess = ${account.accountId} AND title = ${`plain ${account.tag}`}
      `)
      await tx.execute(drizzleSql`
        UPDATE kernel.connected_accounts SET status = 'disconnected', disconnected_at = now()
        WHERE id = ${account.connectionId}::uuid
      `)
      const c = (await tx.execute(drizzleSql`
        INSERT INTO kernel.connected_accounts
          (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by)
        VALUES (gen_random_uuid(), ${orgId}::uuid, 'calendar', 'google-calendar', 'user',
                ${userId}::uuid, 'oauth2', ${account.email}, 'active', ${userId}::uuid)
        RETURNING id
      `)) as any
      return (c.rows ?? c)[0].id as string
    })
    const before = await storedFor(account.accountId)

    // The list_accounts read in that window, and a late disconnect event for the old
    // connection: neither touches the account.
    const purged = await withSystemDb("calendar-reauth-reconcile", (tx) =>
      reconcileDisconnectedCalendarAccounts(tx as any, orgId),
    )
    expect(purged).not.toContain(account.accountId)
    await withSystemDb("calendar-reauth-old-event", (tx) =>
      onAccountDisconnected(tx as any, orgId, {
        orgId,
        data: { id: account.connectionId, appName: "calendar" },
      }),
    )
    expect(await storedFor(account.accountId)).toEqual(before)
    expect(before).toMatchObject({ calendars: 1, events: 3, logs: 1, disconnected: false })

    const { repaired } = await withSystemDb("calendar-reauth-rebind", (tx) =>
      ensureCallerCalendarAccounts(tx as any, orgId, userId),
    )
    expect(repaired).toContain(account.accountId)
    const bound = await withSystemDb("calendar-reauth-bound", async (tx) => {
      const r = (await tx.execute(drizzleSql`
        SELECT connected_account_id FROM app_calendar.accounts WHERE id = ${account.accountId}::uuid
      `)) as any
      return (r.rows ?? r)[0].connected_account_id as string
    })
    expect(bound).toBe(newConnectionId)
    expect(await storedFor(account.accountId)).toMatchObject({ calendars: 1, events: 3, logs: 1 })
  })
})
