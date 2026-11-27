// SPDX-License-Identifier: FSL-1.1-ALv2
// The window read on indexed instants: the events table's point_time_columns trigger keeps
// start_at / end_at / original_start_at from the jsonb points, and list_events' window bounds
// are index range scans on them, not a cast over the whole history.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { type SQL, sql as drizzleSql } from "drizzle-orm"
import { onAccountConnected, runCalendarImport } from "~/apps/calendar/sync"
import { listEventsForCaller } from "~/apps/calendar/tools"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgId: string
let userId: string
let accountId: string
let calendarId: string

const rowsOf = <T>(result: unknown): T[] =>
  Array.isArray(result) ? (result as T[]) : (((result as { rows?: T[] }).rows ?? []) as T[])

beforeAll(async () => {
  await acquireAppSchemaJsLock("app_calendar")
  const slug = `cal-window-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("calendar-window-fixture", async (tx) => {
    orgId = rowsOf<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Window Org', ${slug})
        RETURNING id`),
    )[0]!.id
    userId = rowsOf<{ id: string }>(
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`u-${slug}@x.test`}, 'U', 'active', 'h', 1, 1) RETURNING id`),
    )[0]!.id
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
  await registerApps([calendarAppManifest as never], orgId)
  await withSystemDb("calendar-window-account", async (tx) => {
    const connected = await onAccountConnected(
      tx as never,
      orgId,
      {
        orgId,
        actorId: userId,
        data: {
          id: crypto.randomUUID(),
          appName: "calendar",
          ownerType: "user",
          ownerId: userId,
          identifier: `window-${slug}@x.test`,
          connectionName: "google-calendar",
        },
      },
      async () => {},
    )
    accountId = connected.accountId
    const { calendarIds } = await runCalendarImport(
      tx as never,
      orgId,
      accountId,
      async () => [{ id: `window-${slug}`, summary: "Main" }],
      async () => {},
    )
    calendarId = calendarIds[0] as string
  })
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

async function grants(): Promise<Record<string, string[]>> {
  return withSystemDb("calendar-window-grants", async (tx) => {
    const out: Record<string, string[]> = {}
    for (const r of rowsOf<{ dimension_key: string; dimension_values: string[] }>(
      await tx.execute(drizzleSql`
        SELECT dimension_key, dimension_values FROM kernel.user_dimension_grants
        WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid`),
    )) {
      out[r.dimension_key] = r.dimension_values
    }
    return out
  })
}

describe("calendar events: indexed time columns", () => {
  it("the trigger writes each point as an instant on insert and on update, NULL when unreadable", async () => {
    const read = await withSystemDb("calendar-window-trigger", async (tx) => {
      const insert = async (title: string, start: unknown, end: unknown, original?: unknown) =>
        rowsOf<{ id: string }>(
          await tx.execute(drizzleSql`
            INSERT INTO app_calendar.events (id, org_id, calendar_id, title, start, "end", original_start_time, calaccess)
            VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, ${title},
                    ${JSON.stringify(start)}::jsonb, ${JSON.stringify(end)}::jsonb,
                    ${original === undefined ? null : JSON.stringify(original)}::jsonb, ${accountId})
            RETURNING id`),
        )[0]!.id
      const timed = await insert(
        "timed",
        { dateTime: "2026-10-14T10:00:00+02:00", timeZone: "Europe/Paris" },
        { dateTime: "2026-10-14T11:30:00+02:00" },
        { dateTime: "2026-10-13T09:00:00Z" },
      )
      const allDay = await insert("all-day", { date: "2026-10-15" }, { date: "2026-10-16" })
      const broken = await insert("broken", { dateTime: "2026-13-45T99:00:00Z" }, { nothing: 1 })
      await tx.execute(drizzleSql`
        UPDATE app_calendar.events SET start = '{"dateTime":"2026-10-14T12:00:00Z"}'::jsonb
        WHERE id = ${timed}::uuid`)
      const q = async (id: string) =>
        rowsOf<{ s: string | null; e: string | null; o: string | null }>(
          await tx.execute(drizzleSql`
            SELECT to_char(start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS s,
                   to_char(end_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS e,
                   to_char(original_start_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS o
            FROM app_calendar.events WHERE id = ${id}::uuid`),
        )[0]
      return { timed: await q(timed), allDay: await q(allDay), broken: await q(broken) }
    })
    expect(read.timed).toEqual({ s: "2026-10-14T12:00", e: "2026-10-14T09:30", o: "2026-10-13T09:00" })
    expect(read.allDay).toEqual({ s: "2026-10-15T00:00", e: "2026-10-16T00:00", o: null })
    expect(read.broken).toEqual({ s: null, e: null, o: null })
  })

  it("a week read over 50k events of history uses the time indexes, never a sequential scan", async () => {
    await withSystemDb("calendar-window-history", async (tx) => {
      // Four years of history, one event every ~40 minutes, then one week of the window.
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, google_event_id, title, start, "end", calaccess)
        SELECT gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'hist' || g, 'history ' || g,
               jsonb_build_object('dateTime', to_char(t, 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
               jsonb_build_object('dateTime', to_char(t + interval '30 minutes', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')),
               ${accountId}
        FROM generate_series(1, 50000) AS g,
             LATERAL (SELECT timestamptz '2022-01-01 00:00Z' + g * interval '40 minutes' AS t) AS slot`)
      await tx.execute(drizzleSql`ANALYZE app_calendar.events`)
    })
    const plans: string[] = []
    const events = await withRlsContext(
      {
        actorType: "user",
        userId,
        orgId,
        scopes: ["calendar:calendars:read", "calendar:events:read"],
        dimensionGrants: await grants(),
      },
      (tx) => {
        const explaining = new Proxy(tx, {
          get(target, key) {
            const value = Reflect.get(target, key)
            if (key === "execute") {
              return async (query: SQL) => {
                const plan = rowsOf<{ "QUERY PLAN": string }>(
                  await target.execute(drizzleSql`EXPLAIN ${query}`),
                )
                plans.push(plan.map((r) => r["QUERY PLAN"]).join("\n"))
                return target.execute(query)
              }
            }
            return typeof value === "function" ? value.bind(target) : value
          },
        })
        return listEventsForCaller(explaining, orgId, {
          timeMin: "2025-06-02T00:00:00Z",
          timeMax: "2025-06-09T00:00:00Z",
        })
      },
    )
    // About 252 history events fall in that week (one every 40 minutes).
    expect(events.filter((e) => e.title?.startsWith("history ")).length).toBeGreaterThan(240)
    const [plain, , exceptions] = plans
    expect(plain).toMatch(/idx_app_calendar_events_(start|end)_at/)
    expect(plain).not.toMatch(/Seq Scan on events/)
    expect(exceptions).not.toMatch(/Seq Scan on events/)
  }, 120_000)
})
