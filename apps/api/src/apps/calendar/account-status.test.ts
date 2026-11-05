// SPDX-License-Identifier: FSL-1.1-ALv2
// The calendar home said "connect your account" while Settings showed the Google Calendar
// connection as connected, and Disconnect did nothing. The calendar home and calendar settings
// read `list_accounts` (the app's own `accounts` rows under the caller's RLS); the connected
// label is the kernel connection. These tests pin the paths where the two disagreed.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql, type SQL } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import {
  callerCalendarAccountsNeedRepair,
  ensureCallerCalendarAccounts,
  onAccountConnected,
} from "~/apps/calendar/sync"
import { listAccountsForCaller } from "~/apps/calendar/tools"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgId: string
let adminId: string
let otherUserId: string

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-status-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("calendar-status-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Calendar Status Org', ${slug})
      RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`admin-${slug}@x.test`}, 'Admin', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    adminId = (u.rows ?? u)[0].id
    const u2 = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`other-${slug}@x.test`}, 'Other', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    otherUserId = (u2.rows ?? u2)[0].id
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

/** The reporter's shape: an org admin (`*`) whose token carries a direct calendar:calaccess
 * grant that does not (yet) name the account. */
function listAsAdmin(dimensionGrants: Record<string, string[]> = { "calendar:calaccess": [] }) {
  return withRlsContext(
    { actorType: "user", userId: adminId, orgId, scopes: ["*"], dimensionGrants },
    (tx) => listAccountsForCaller(tx, orgId),
  )
}

async function insertKernelConnection(
  ownerType: "user" | "org",
  ownerId: string | null,
  identifier: string,
): Promise<string> {
  return withSystemDb("calendar-status-kernel-conn", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      INSERT INTO kernel.connected_accounts
        (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, status, created_by)
      VALUES (gen_random_uuid(), ${orgId}::uuid, 'calendar', 'google-calendar', ${ownerType},
              ${ownerId}::uuid, 'oauth2', ${identifier}, 'active', ${adminId}::uuid)
      RETURNING id
    `)) as any
    return (r.rows ?? r)[0].id as string
  })
}

async function calaccessGrant(userId: string): Promise<string[]> {
  return withSystemDb("calendar-status-grant-read", async (tx) => {
    const r = (await tx.execute(drizzleSql`
      SELECT dimension_values FROM kernel.user_dimension_grants
      WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid AND dimension_key = 'calendar:calaccess'
    `)) as any
    return ((r.rows ?? r)[0]?.dimension_values as string[] | undefined) ?? []
  })
}

describe("calendar account status follows the kernel connection", () => {
  it("a reconnect of the same address by another user hands the account to that user", async () => {
    const email = `shared-${crypto.randomUUID()}@x.test`
    const firstConn = crypto.randomUUID()
    const secondConn = crypto.randomUUID()
    await withSystemDb("calendar-status-rebind", async (tx) => {
      await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: otherUserId,
          data: {
            id: firstConn,
            appName: "calendar",
            ownerType: "user",
            ownerId: otherUserId,
            identifier: email,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: adminId,
          data: {
            id: secondConn,
            appName: "calendar",
            ownerType: "user",
            ownerId: adminId,
            identifier: email,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
    })
    const mine = (await listAsAdmin()).filter((a) => a.identifier === email)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.connectedAccountId).toBe(secondConn)
    expect(mine[0]?.ownerType).toBe("user")
  })

  it("the connect event grants calendar:calaccess at once, before any import ran", async () => {
    const accountId = await withSystemDb("calendar-status-grant", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: adminId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "user",
            ownerId: adminId,
            identifier: `grant-${crypto.randomUUID()}@x.test`,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      return accountId
    })
    expect(await calaccessGrant(adminId)).toContain(accountId)
  })

  it("an active connection whose app account row is missing is repaired on read", async () => {
    const email = `lost-event-${crypto.randomUUID()}@x.test`
    const connId = await insertKernelConnection("user", adminId, email)
    expect((await listAsAdmin()).some((a) => a.identifier === email)).toBe(false)

    const first = await withSystemDb("calendar-status-ensure", (tx) =>
      ensureCallerCalendarAccounts(tx as any, orgId, adminId),
    )
    expect(first.repaired).toHaveLength(1)
    expect(first.jobs).toEqual([{ orgId, accountId: first.repaired[0] }])

    const listed = (await listAsAdmin()).filter((a) => a.identifier === email)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.connectedAccountId).toBe(connId)
    expect(listed[0]?.id).toBe(first.repaired[0] as string)
    expect(await calaccessGrant(adminId)).toContain(first.repaired[0] as string)

    // Idempotent: a healthy row is left alone and queues no import.
    const second = await withSystemDb("calendar-status-ensure-2", (tx) =>
      ensureCallerCalendarAccounts(tx as any, orgId, adminId),
    )
    expect(second.repaired).toEqual([])
    expect(second.jobs).toEqual([])
  })

  it("an app row marked disconnected while its kernel connection is active is revived on read", async () => {
    const email = `revive-${crypto.randomUUID()}@x.test`
    const connId = await insertKernelConnection("user", adminId, email)
    await withSystemDb("calendar-status-revive-setup", async (tx) => {
      await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: adminId,
          data: {
            id: connId,
            appName: "calendar",
            ownerType: "user",
            ownerId: adminId,
            identifier: email,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      await tx.execute(drizzleSql`
        UPDATE ${drizzleSql.raw(schemaRef("app_calendar"))}.accounts SET disconnected_at = now(), sync_status = 'disconnected'
        WHERE org_id = ${orgId}::uuid AND email_address = ${email}
      `)
    })
    expect((await listAsAdmin()).some((a) => a.identifier === email)).toBe(false)
    await withSystemDb("calendar-status-revive", (tx) =>
      ensureCallerCalendarAccounts(tx as any, orgId, adminId),
    )
    const listed = (await listAsAdmin()).filter((a) => a.identifier === email)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.connectedAccountId).toBe(connId)
  })

  it("another user's personal connection is never pulled into the caller's accounts", async () => {
    const email = `not-mine-${crypto.randomUUID()}@x.test`
    await insertKernelConnection("user", otherUserId, email)
    const out = await withSystemDb("calendar-status-not-mine", (tx) =>
      ensureCallerCalendarAccounts(tx as any, orgId, adminId),
    )
    expect(out.jobs.length).toBe(out.repaired.length)
    expect((await listAsAdmin()).some((a) => a.identifier === email)).toBe(false)
  })

  it("a healthy caller is answered by a read-only check and the ensure pass writes nothing", async () => {
    const email = `healthy-${crypto.randomUUID()}@x.test`
    await insertKernelConnection("user", adminId, email)
    expect(
      await withSystemDb("calendar-status-health-1", (tx) =>
        callerCalendarAccountsNeedRepair(tx as any, orgId, adminId),
      ),
    ).toBe(true)
    await withSystemDb("calendar-status-heal", (tx) =>
      ensureCallerCalendarAccounts(tx as any, orgId, adminId),
    )
    expect(
      await withSystemDb("calendar-status-health-2", (tx) =>
        callerCalendarAccountsNeedRepair(tx as any, orgId, adminId),
      ),
    ).toBe(false)

    const statements: string[] = []
    const out = await withSystemDb("calendar-status-healthy-ensure", (tx) =>
      ensureCallerCalendarAccounts(
        tracingDb(tx, (text) => {
          statements.push(text)
        }) as any,
        orgId,
        adminId,
      ),
    )
    expect(out.repaired).toEqual([])
    expect(statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s))).toEqual([])
  })

  it("a lost grant on a healthy row is flagged by the check and restored by the ensure pass", async () => {
    const email = `grant-lost-${crypto.randomUUID()}@x.test`
    await insertKernelConnection("user", adminId, email)
    const { repaired } = await withSystemDb("calendar-status-grant-lost-1", (tx) =>
      ensureCallerCalendarAccounts(tx as any, orgId, adminId),
    )
    const accountId = repaired[0] as string
    await withSystemDb("calendar-status-grant-lost-drop", (tx) =>
      tx.execute(drizzleSql`
        UPDATE kernel.user_dimension_grants
        SET dimension_values = dimension_values - ${accountId}
        WHERE user_id = ${adminId}::uuid AND org_id = ${orgId}::uuid AND dimension_key = 'calendar:calaccess'
      `),
    )
    expect(
      await withSystemDb("calendar-status-grant-lost-check", (tx) =>
        callerCalendarAccountsNeedRepair(tx as any, orgId, adminId),
      ),
    ).toBe(true)
    await withSystemDb("calendar-status-grant-lost-2", (tx) =>
      ensureCallerCalendarAccounts(tx as any, orgId, adminId),
    )
    expect(await calaccessGrant(adminId)).toContain(accountId)
  })

  it("two concurrent first reads both repair the missing row and converge on one account", async () => {
    const email = `race-${crypto.randomUUID()}@x.test`
    const connId = await insertKernelConnection("user", adminId, email)
    // Hold each transaction at its account INSERT until both got there, so both have already
    // seen the row missing: the race two first reads of list_accounts run in production.
    let arrived = 0
    let release!: () => void
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve
    })
    const run = () =>
      withSystemDb("calendar-status-race", (tx) =>
        ensureCallerCalendarAccounts(
          tracingDb(tx, async (text) => {
            if (/INSERT INTO\s+\S*accounts\b/i.test(text)) {
              arrived += 1
              if (arrived === 2) release()
              await Promise.race([bothArrived, new Promise((r) => setTimeout(r, 5_000))])
            }
          }) as any,
          orgId,
          adminId,
        ),
      )
    const results = await Promise.allSettled([run(), run()])
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"])
    const rows = await withSystemDb("calendar-status-race-read", async (tx) => {
      const r = (await tx.execute(drizzleSql`
        SELECT id, connected_account_id FROM ${drizzleSql.raw(schemaRef("app_calendar"))}.accounts
        WHERE org_id = ${orgId}::uuid AND email_address = ${email}
      `)) as any
      return (r.rows ?? r) as Array<{ id: string; connected_account_id: string }>
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.connected_account_id).toBe(connId)
    expect(await calaccessGrant(adminId)).toContain(rows[0]?.id as string)
  })
})

const dialect = new PgDialect()

/** Wraps a transaction so every statement's SQL text goes through `onSql` before it runs. */
function tracingDb<T extends { execute: (q: SQL) => unknown }>(
  tx: T,
  onSql: (text: string) => void | Promise<void>,
): T {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === "execute") {
        return async (q: SQL) => {
          await onSql(dialect.sqlToQuery(q).sql)
          return target.execute(q)
        }
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
