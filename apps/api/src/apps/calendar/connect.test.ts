// SPDX-License-Identifier: FSL-1.1-ALv2
// Task 3 — connect lifecycle: onAccountConnected, calendar import, reconnect idempotency,
// deselect/select, org vs personal ownerType routing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import {
  describeCalendarListFailure,
  findCalendarsByAccountId,
  getAccountById,
  grantOrgCalendarAccessToUser,
  onAccountConnected,
  recordCalendarImportFailure,
  requestCalendarReimport,
  runCalendarImport,
  setCalendarSelectedAndSync,
} from "~/apps/calendar/sync"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgId: string
let userId: string
let otherUserId: string

async function registerCalendarSchema() {
  const { calendarAppManifest } = await import("~/apps/calendar/manifest-descriptor")
  const { resetAppRegistries } = await import("~/modules/apps/app-registries")
  const { registerApps } = await import("~/modules/apps/runtime")
  resetAppRegistries()
  await withSystemDb("calendar-connect-fixture-reg", async (tx) => {
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
  const slug = `cal-connect-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await withSystemDb("calendar-connect-fixture", async (tx) => {
    const o = (await tx.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'Calendar Connect Org', ${slug})
      RETURNING id
    `)) as any
    orgId = (o.rows ?? o)[0].id
    const u = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`owner-${slug}@x.test`}, 'Owner', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    userId = (u.rows ?? u)[0].id
    const u2 = (await tx.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`member-${slug}@x.test`}, 'Member', 'active', 'h', 1, 1) RETURNING id
    `)) as any
    otherUserId = (u2.rows ?? u2)[0].id
  })
  await registerCalendarSchema()
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_calendar")
})

function connectedAccountEvent(
  ownerType: "user" | "org",
  ownerId: string | null,
  identifier: string,
) {
  return {
    orgId,
    actorId: userId,
    data: {
      id: crypto.randomUUID(),
      appName: "calendar",
      ownerType,
      ownerId,
      identifier,
      connectionName: "google-calendar",
    },
  }
}

describe("calendar connect lifecycle", () => {
  it("creates a personal account row with ownerType=user on connect", async () => {
    await withSystemDb("calendar-connect-test", async (tx) => {
      const event = connectedAccountEvent("user", userId, "personal@gmail.com")
      const { accountId, created } = await onAccountConnected(
        tx as any,
        orgId,
        event,
        async () => {},
      )
      expect(created).toBe(true)
      const account = await getAccountById(tx as any, orgId, accountId)
      expect(account?.owner_type).toBe("user")
      expect(account?.owner_id).toBe(userId)
      expect(account?.sync_status).toBe("pre-sync")
    })
  })

  it("creates an org account row with ownerType=org (ownerId null) on org connect", async () => {
    await withSystemDb("calendar-connect-test-org", async (tx) => {
      const event = connectedAccountEvent("org", null, "shared@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      const account = await getAccountById(tx as any, orgId, accountId)
      expect(account?.owner_type).toBe("org")
      expect(account?.owner_id).toBe(null)
    })
  })

  it("reconnect of an existing account (same email) is idempotent — no duplicate row", async () => {
    await withSystemDb("calendar-connect-idem", async (tx) => {
      const email = "idempotent@gmail.com"
      const first = await onAccountConnected(
        tx as any,
        orgId,
        connectedAccountEvent("user", userId, email),
        async () => {},
      )
      const second = await onAccountConnected(
        tx as any,
        orgId,
        connectedAccountEvent("user", userId, email),
        async () => {},
      )
      expect(second.accountId).toBe(first.accountId)
      expect(second.created).toBe(false)
    })
  })

  it("import upserts calendars for a personal account and enqueues one initial-sync per selected calendar", async () => {
    await withSystemDb("calendar-import-personal", async (tx) => {
      const event = connectedAccountEvent("user", userId, "import-personal@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      const jobs: Array<{ jobName: string; payload: Record<string, unknown> }> = []
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [
          { id: "gcal-1", summary: "Personal", accessRole: "owner" },
          { id: "gcal-2", summary: "Work", accessRole: "owner" },
        ],
        async (jobName, payload) => {
          jobs.push({ jobName, payload })
        },
      )
      expect(calendarIds.length).toBe(2)
      const rows = await findCalendarsByAccountId(tx as any, orgId, accountId)
      expect(rows.length).toBe(2)
      expect(rows.every((r) => r.selected)).toBe(true)
      const initialSyncJobs = jobs.filter((j) => j.jobName === "calendar-initial-sync")
      expect(initialSyncJobs.length).toBe(2)
    })
  })

  it("account with zero calendars: import completes with no enqueued syncs, status active", async () => {
    await withSystemDb("calendar-import-empty", async (tx) => {
      const event = connectedAccountEvent("user", userId, "empty@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      const jobs: any[] = []
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [],
        async (jobName, payload) => {
          jobs.push({ jobName, payload })
        },
      )
      expect(calendarIds.length).toBe(0)
      expect(jobs.length).toBe(0)
      const account = await getAccountById(tx as any, orgId, accountId)
      expect(account?.sync_status).toBe("active")
    })
  })

  it("re-importing the same account (reconnect) does not duplicate calendar rows", async () => {
    await withSystemDb("calendar-import-reconnect", async (tx) => {
      const event = connectedAccountEvent("user", userId, "reconnect-import@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      const entries = [{ id: "gcal-r1", summary: "Reconnect Cal", accessRole: "owner" }]
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => entries,
        async () => {},
      )
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => entries,
        async () => {},
      )
      const rows = await findCalendarsByAccountId(tx as any, orgId, accountId)
      expect(rows.length).toBe(1)
    })
  })

  it("grants the calendar:calaccess dimension to the connecting user for a personal account", async () => {
    await withSystemDb("calendar-grant-personal", async (tx) => {
      const event = connectedAccountEvent("user", userId, "grant-personal@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [],
        async () => {},
      )
      const grants = (await tx.execute(drizzleSql`
        SELECT dimension_values FROM kernel.user_dimension_grants
        WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid AND dimension_key = 'calendar:calaccess'
      `)) as any
      const rows = grants.rows ?? grants
      expect(rows.length).toBe(1)
      expect((rows[0].dimension_values as string[]).includes(accountId)).toBe(true)
    })
  })

  it("grants the calendar:calaccess dimension to EVERY active org member for an org-wide account", async () => {
    await withSystemDb("calendar-grant-org", async (tx) => {
      const event = connectedAccountEvent("org", null, "grant-org@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [],
        async () => {},
      )
      const grants = (await tx.execute(drizzleSql`
        SELECT user_id, dimension_values FROM kernel.user_dimension_grants
        WHERE org_id = ${orgId}::uuid AND dimension_key = 'calendar:calaccess'
      `)) as any
      const rows = (grants.rows ?? grants) as Array<{ user_id: string; dimension_values: string[] }>
      const grantedUserIds = rows
        .filter((r) => r.dimension_values.includes(accountId))
        .map((r) => r.user_id)
      expect(grantedUserIds).toContain(userId)
      expect(grantedUserIds).toContain(otherUserId)
    })
  })

  it("deselecting a calendar purges its local events and stops the watch channel", async () => {
    await withSystemDb("calendar-deselect", async (tx) => {
      const event = connectedAccountEvent("user", userId, "deselect@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-desel", summary: "To Deselect" }],
        async () => {},
      )
      const calendarId = calendarIds[0]!
      // Seed a fake watch channel + an event row directly.
      await tx.execute(drizzleSql`
        UPDATE app_calendar.calendars SET watch_channel_id = 'chan-1', watch_resource_id = 'res-1',
          watch_expiration = now(), sync_token = 'tok-1'
        WHERE id = ${calendarId}::uuid
      `)
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'Some Event', ${accountId})
      `)

      const jobs: any[] = []
      await setCalendarSelectedAndSync(
        tx as any,
        orgId,
        calendarId,
        false,
        async (jobName, payload) => {
          jobs.push({ jobName, payload })
        },
        { isAdmin: false, userId },
      )

      const [calRow] = (await tx.execute(drizzleSql`
        SELECT selected, watch_channel_id, sync_token FROM app_calendar.calendars WHERE id = ${calendarId}::uuid
      `)) as any
      const cal = (calRow.rows ?? calRow)[0] ?? (Array.isArray(calRow) ? calRow[0] : calRow)
      expect(cal.selected).toBe(false)
      expect(cal.watch_channel_id).toBe(null)

      const evts = (await tx.execute(drizzleSql`
        SELECT count(*)::int AS c FROM app_calendar.events WHERE calendar_id = ${calendarId}::uuid
      `)) as any
      const evtRows = evts.rows ?? evts
      expect(evtRows[0].c).toBe(0)
      expect(jobs.length).toBe(0)
    })
  })

  it("re-selecting a deselected calendar re-enqueues initial sync", async () => {
    await withSystemDb("calendar-reselect", async (tx) => {
      const event = connectedAccountEvent("user", userId, "reselect@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-resel", summary: "To Reselect" }],
        async () => {},
      )
      const calendarId = calendarIds[0]!
      await setCalendarSelectedAndSync(tx as any, orgId, calendarId, false, async () => {}, {
        isAdmin: false,
        userId,
      })
      const jobs: any[] = []
      await setCalendarSelectedAndSync(
        tx as any,
        orgId,
        calendarId,
        true,
        async (jobName, payload) => {
          jobs.push({ jobName, payload })
        },
        { isAdmin: false, userId },
      )
      expect(jobs.some((j) => j.jobName === "calendar-initial-sync")).toBe(true)
    })
  })

  it("a non-admin member cannot toggle an ORG calendar (destructive deselect is admin-gated)", async () => {
    await withSystemDb("calendar-setselected-org-gate", async (tx) => {
      const event = connectedAccountEvent("org", null, "orgcal-gate@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-org-gate", summary: "Org Cal" }],
        async () => {},
      )
      const calendarId = calendarIds[0]!
      // Non-admin member (any userId) — must be rejected for an org calendar.
      await expect(
        setCalendarSelectedAndSync(tx as any, orgId, calendarId, false, async () => {}, {
          isAdmin: false,
          userId,
        }),
      ).rejects.toThrow(/org calendar requires the calendar admin scope/)
      // An admin may toggle it.
      const jobs: any[] = []
      await setCalendarSelectedAndSync(
        tx as any,
        orgId,
        calendarId,
        false,
        async (jobName, payload) => {
          jobs.push({ jobName, payload })
        },
        { isAdmin: true, userId },
      )
      const [calRow] = (await tx.execute(drizzleSql`
        SELECT selected FROM app_calendar.calendars WHERE id = ${calendarId}::uuid
      `)) as any
      const cal = (calRow.rows ?? calRow)[0] ?? (Array.isArray(calRow) ? calRow[0] : calRow)
      expect(cal.selected).toBe(false)
    })
  })

  it("a member cannot toggle another user's PERSONAL calendar", async () => {
    await withSystemDb("calendar-setselected-personal-gate", async (tx) => {
      const event = connectedAccountEvent("user", userId, "personal-gate@gmail.com")
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-personal-gate", summary: "My Cal" }],
        async () => {},
      )
      const calendarId = calendarIds[0]!
      // otherUserId is NOT the owner — rejected.
      await expect(
        setCalendarSelectedAndSync(tx as any, orgId, calendarId, false, async () => {}, {
          isAdmin: false,
          userId: otherUserId,
        }),
      ).rejects.toThrow(/only the owning user may toggle a personal calendar/)
    })
  })
})

// Production 2026-10-05: Google refused calendarList.list (403 SERVICE_DISABLED) and the account
// stayed 'active' with zero calendars and no error. A failed import now marks the account
// 'error' with a readable message; a later successful import (retry or reconnect) clears it.
describe("calendar import failure", () => {
  const ACTIVATION_URL =
    "https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123"
  const serviceDisabledBody = JSON.stringify({
    error: {
      code: 403,
      message: `Google Calendar API has not been used in project 123 before or it is disabled. Enable it by visiting ${ACTIVATION_URL} then retry.`,
      errors: [{ reason: "accessNotConfigured" }],
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          metadata: { activationUrl: ACTIVATION_URL },
        },
      ],
    },
  })

  it("describes SERVICE_DISABLED as an API to enable, with the activation URL and Google's message", () => {
    const { reason, message } = describeCalendarListFailure(403, serviceDisabledBody)
    expect(reason).toBe("SERVICE_DISABLED")
    expect(message).toContain("Google Calendar API is not enabled in the Google Cloud project")
    expect(message).toContain(`at ${ACTIVATION_URL}`)
    expect(message).toContain("has not been used in project 123")
  })

  it("describes any other refusal with its status, reason and Google's message", () => {
    const body = JSON.stringify({
      error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" },
    })
    expect(describeCalendarListFailure(401, body)).toEqual({
      reason: "UNAUTHENTICATED",
      message:
        "Google Calendar refused to list this account's calendars (HTTP 401, UNAUTHENTICATED): Invalid Credentials",
    })
    expect(describeCalendarListFailure(502, "Bad Gateway").message).toContain("HTTP 502")
  })

  it("a failed import marks the account error, and a later successful import clears it", async () => {
    await withSystemDb("calendar-import-failure", async (tx) => {
      const event = connectedAccountEvent(
        "user",
        userId,
        `import-fail-${crypto.randomUUID()}@gmail.com`,
      )
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      await recordCalendarImportFailure(tx as any, orgId, accountId, 403, serviceDisabledBody)
      const failed = await getAccountById(tx as any, orgId, accountId)
      expect(failed?.sync_status).toBe("error")
      expect(failed?.last_sync_error).toContain(ACTIVATION_URL)

      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "gcal-after-fix", summary: "Fixed" }],
        async () => {},
      )
      const recovered = await getAccountById(tx as any, orgId, accountId)
      expect(recovered?.sync_status).toBe("syncing")
      expect(recovered?.last_sync_error).toBeNull()
    })
  })

  it("retry_import re-enqueues the import for the owner; nobody else can see the account to retry it", async () => {
    const accountId = await withSystemDb("calendar-retry-setup", async (tx) => {
      const event = connectedAccountEvent("user", userId, `retry-${crypto.randomUUID()}@gmail.com`)
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [],
        async () => {},
      )
      await recordCalendarImportFailure(tx as any, orgId, accountId, 403, serviceDisabledBody)
      return accountId
    })
    const grants = await withSystemDb("calendar-retry-grants", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
        SELECT dimension_key, dimension_values FROM kernel.user_dimension_grants
        WHERE user_id = ${userId}::uuid AND org_id = ${orgId}::uuid
      `)) as any
      const out: Record<string, string[]> = {}
      for (const r of (rows.rows ?? rows) as Array<{
        dimension_key: string
        dimension_values: string[]
      }>) {
        out[r.dimension_key] = r.dimension_values
      }
      return out
    })

    // Another user, even an admin holding wildcard grants, cannot see the personal account.
    await expect(
      withRlsContext(
        {
          actorType: "user",
          userId: otherUserId,
          orgId,
          scopes: ["*"],
          dimensionGrants: { "*": ["*"] },
        },
        (tx) =>
          requestCalendarReimport(tx, orgId, accountId, async () => {}, {
            isAdmin: true,
            userId: otherUserId,
          }),
      ),
    ).rejects.toThrow(/not found/)

    const jobs: Array<{ jobName: string; payload: Record<string, unknown> }> = []
    await withRlsContext(
      {
        actorType: "user",
        userId,
        orgId,
        scopes: ["calendar:events:read", "calendar:events:write", "calendar:accounts:read"],
        dimensionGrants: grants,
      },
      (tx) =>
        requestCalendarReimport(
          tx,
          orgId,
          accountId,
          async (jobName, payload) => {
            jobs.push({ jobName, payload })
          },
          { isAdmin: false, userId },
        ),
    )
    expect(jobs).toEqual([{ jobName: "calendar-import", payload: { orgId, accountId } }])
  })

  it("retrying an org account import requires the calendar admin scope", async () => {
    await withSystemDb("calendar-retry-org", async (tx) => {
      const event = connectedAccountEvent("org", null, `retry-org-${crypto.randomUUID()}@gmail.com`)
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      await expect(
        requestCalendarReimport(tx as any, orgId, accountId, async () => {}, {
          isAdmin: false,
          userId,
        }),
      ).rejects.toThrow(/requires the calendar admin scope/)
      const jobs: string[] = []
      await requestCalendarReimport(
        tx as any,
        orgId,
        accountId,
        async (jobName) => {
          jobs.push(jobName)
        },
        { isAdmin: true, userId },
      )
      expect(jobs).toEqual(["calendar-import"])
    })
  })
})

// set_selected ran its UPDATE under the caller's own RLS context. The member role carries no
// scope that may write `calendars`, so a member toggling their OWN personal calendar matched
// 0 rows and the call reported success while nothing changed.
describe("set_selected under the caller's RLS context", () => {
  const MEMBER_SCOPES = [
    "calendar:events:read",
    "calendar:events:write",
    "calendar:calendars:read",
    "calendar:accounts:read",
  ]

  async function grantsOf(uid: string): Promise<Record<string, string[]>> {
    return withSystemDb("calendar-setselected-grants", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
        SELECT dimension_key, dimension_values FROM kernel.user_dimension_grants
        WHERE user_id = ${uid}::uuid AND org_id = ${orgId}::uuid
      `)) as any
      const out: Record<string, string[]> = {}
      for (const r of (rows.rows ?? rows) as Array<{
        dimension_key: string
        dimension_values: string[]
      }>) {
        out[r.dimension_key] = r.dimension_values
      }
      return out
    })
  }

  async function connectWithEvent(ownerType: "user" | "org", tag: string) {
    return withSystemDb("calendar-setselected-setup", async (tx) => {
      const event = connectedAccountEvent(
        ownerType,
        ownerType === "user" ? userId : null,
        `${tag}-${crypto.randomUUID()}@gmail.com`,
      )
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      const { calendarIds } = await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: `gcal-${tag}`, summary: tag }],
        async () => {},
      )
      const calendarId = calendarIds[0]!
      await tx.execute(drizzleSql`
        INSERT INTO app_calendar.events (id, org_id, calendar_id, title, google_event_id, calaccess)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${calendarId}::uuid, 'mirrored', 'g-1', ${accountId})
      `)
      return { accountId, calendarId }
    })
  }

  async function calendarState(calendarId: string) {
    return withSystemDb("calendar-setselected-state", async (tx) => {
      const c = (await tx.execute(drizzleSql`
        SELECT selected FROM app_calendar.calendars WHERE id = ${calendarId}::uuid
      `)) as any
      const e = (await tx.execute(drizzleSql`
        SELECT count(*)::int AS n FROM app_calendar.events WHERE calendar_id = ${calendarId}::uuid
      `)) as any
      return {
        selected: (c.rows ?? c)[0].selected as boolean,
        events: (e.rows ?? e)[0].n as number,
      }
    })
  }

  it("the owner holding only the member role deselects and reselects their personal calendar", async () => {
    const { calendarId } = await connectWithEvent("user", "member-own")
    const asOwner = {
      actorType: "user" as const,
      userId,
      orgId,
      scopes: MEMBER_SCOPES,
      dimensionGrants: await grantsOf(userId),
    }
    await withRlsContext(asOwner, (tx) =>
      setCalendarSelectedAndSync(tx, orgId, calendarId, false, async () => {}, {
        isAdmin: false,
        userId,
      }),
    )
    expect(await calendarState(calendarId)).toEqual({ selected: false, events: 0 })

    const jobs: string[] = []
    await withRlsContext(asOwner, (tx) =>
      setCalendarSelectedAndSync(
        tx,
        orgId,
        calendarId,
        true,
        async (jobName) => {
          jobs.push(jobName)
        },
        { isAdmin: false, userId },
      ),
    )
    expect((await calendarState(calendarId)).selected).toBe(true)
    expect(jobs).toEqual(["calendar-initial-sync"])
  })

  it("a calendar admin (admin role scopes) toggles an org calendar", async () => {
    const { calendarId } = await connectWithEvent("org", "admin-org")
    await withRlsContext(
      {
        actorType: "user",
        userId: otherUserId,
        orgId,
        scopes: [...MEMBER_SCOPES, "calendar:accounts:admin"],
        dimensionGrants: await grantsOf(otherUserId),
      },
      (tx) =>
        setCalendarSelectedAndSync(tx, orgId, calendarId, false, async () => {}, {
          isAdmin: true,
          userId: otherUserId,
        }),
    )
    expect(await calendarState(calendarId)).toEqual({ selected: false, events: 0 })
  })

  it("reports a failure instead of succeeding when the row could not be written", async () => {
    const { calendarId } = await connectWithEvent("user", "readonly")
    await expect(
      withRlsContext(
        {
          actorType: "user",
          userId,
          orgId,
          scopes: ["calendar:events:read", "calendar:calendars:read", "calendar:accounts:read"],
          dimensionGrants: await grantsOf(userId),
        },
        (tx) =>
          setCalendarSelectedAndSync(tx, orgId, calendarId, false, async () => {}, {
            isAdmin: false,
            userId,
          }),
      ),
    ).rejects.toThrow(/could not update calendar/)
    expect(await calendarState(calendarId)).toEqual({ selected: true, events: 1 })
  })
})

// The bridge decided "calendar admin" with a literal includes("calendar:accounts:admin"), so an
// org admin whose grant is the wildcard '*' (or 'calendar:*' / 'calendar') was refused org
// calendar management although every RLS policy accepts those grants.
describe("calendar admin check through the bridge honours wildcard grants", () => {
  for (const grant of ["*", "calendar:*", "calendar"]) {
    it(`a caller holding '${grant}' may deselect an org calendar`, async () => {
      const calendarId = await withSystemDb("calendar-wildcard-admin-setup", async (tx) => {
        const event = connectedAccountEvent("org", null, `wild-${crypto.randomUUID()}@gmail.com`)
        const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
        const { calendarIds } = await runCalendarImport(
          tx as any,
          orgId,
          accountId,
          async () => [{ id: "gcal-wild", summary: "Org" }],
          async () => {},
        )
        return calendarIds[0]!
      })
      const { createCalendarMethods } = await import("~/modules/apps/sandbox/bridge/calendar")
      await withRlsContext(
        { actorType: "user", userId, orgId, scopes: [grant], dimensionGrants: { "*": ["*"] } },
        async (tx) => {
          const methods = createCalendarMethods({
            callerScopes: [grant],
            orgId,
            userId,
            txDb: tx,
            requireApp: () => {},
          } as any)
          await methods.calendar_setSelected(JSON.stringify({ calendarId, selected: false }))
        },
      )
      const row = await withSystemDb("calendar-wildcard-admin-check", async (tx) => {
        const r = (await tx.execute(
          drizzleSql`SELECT selected FROM app_calendar.calendars WHERE id = ${calendarId}::uuid`,
        )) as any
        return (r.rows ?? r)[0]
      })
      expect(row.selected).toBe(false)
    })
  }

  it("a member scope set is still not an admin", async () => {
    const { isCalendarAdmin } = await import("~/modules/apps/sandbox/bridge/calendar")
    expect(isCalendarAdmin(["calendar:events:write", "calendar:accounts:read"])).toBe(false)
    expect(isCalendarAdmin(["calendar:accounts:admin"])).toBe(true)
    expect(isCalendarAdmin(["calendar:accounts:*"])).toBe(true)
    expect(isCalendarAdmin(["mail:*"])).toBe(false)
    expect(isCalendarAdmin(undefined)).toBe(false)
  })
})

// Regression (deferred item closed 2026-07-03): a user who registers AFTER an org calendar was
// connected received no calendar:calaccess grants (import-time fan-out only covers users active
// at import) — org calendars were invisible to them. grantOrgCalendarAccessToUser is wired to
// kernel/user:registered via the manifest's onUserRegistered handler.
describe("late-joiner grant fan-out (kernel/user:registered)", () => {
  it("grants org-account calaccess to a user who joins after the org connect", async () => {
    await withSystemDb("calendar-late-joiner", async (tx) => {
      const { accountId } = await onAccountConnected(
        tx as any,
        orgId,
        {
          orgId,
          actorId: userId,
          data: {
            id: crypto.randomUUID(),
            appName: "calendar",
            ownerType: "org",
            ownerId: userId,
            identifier: `late-join-${crypto.randomUUID()}@x.test`,
            connectionName: "google-calendar",
          },
        },
        async () => {},
      )
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [{ id: "lj-cal" }],
        async () => {},
      )

      // New user registers AFTER the import-time fan-out.
      const nu = (await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`late-${crypto.randomUUID()}@x.test`}, 'Late Joiner', 'active', 'h', 1, 1)
        RETURNING id
      `)) as any
      const lateUserId = (nu.rows ?? nu)[0].id as string

      const before = (await tx.execute(drizzleSql`
        SELECT dimension_values FROM kernel.user_dimension_grants
        WHERE user_id = ${lateUserId}::uuid AND org_id = ${orgId}::uuid AND dimension_key = 'calendar:calaccess'
      `)) as any
      expect(((before.rows ?? before) as unknown[]).length).toBe(0)

      const granted = await grantOrgCalendarAccessToUser(tx as any, orgId, lateUserId)
      expect(granted).toBeGreaterThanOrEqual(1)

      const after = (await tx.execute(drizzleSql`
        SELECT dimension_values FROM kernel.user_dimension_grants
        WHERE user_id = ${lateUserId}::uuid AND org_id = ${orgId}::uuid AND dimension_key = 'calendar:calaccess'
      `)) as any
      const values = ((after.rows ?? after) as Array<{ dimension_values: unknown }>)[0]!
        .dimension_values as string[]
      expect(values).toContain(accountId)

      // Idempotent: re-running does not duplicate the grant value.
      await grantOrgCalendarAccessToUser(tx as any, orgId, lateUserId)
      const again = (await tx.execute(drizzleSql`
        SELECT dimension_values FROM kernel.user_dimension_grants
        WHERE user_id = ${lateUserId}::uuid AND org_id = ${orgId}::uuid AND dimension_key = 'calendar:calaccess'
      `)) as any
      const values2 = ((again.rows ?? again) as Array<{ dimension_values: unknown }>)[0]!
        .dimension_values as string[]
      expect(values2.filter((v) => v === accountId)).toHaveLength(1)
    })
  })
})

// Delivery no longer depends on an in-process recording: `resolveGrantInvalidations`
// resolves the affected user(s) and their thread ids from the queued kernel
// permission event plus the database, at delivery time (FX8,
// grant-invalidation.ts). So the coverage these calendar grant paths owe is
// that each one queues, in the SAME transaction as its write, a `user_dimension`
// event naming its target(s) via `data.targetUserId`.
describe("calendar grants queue the permission event that carries the invalidation", () => {
  beforeEach(async () => {
    await withSystemDb("calendar-gi-clear", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}::uuid`)
    })
  })

  async function connectAndImport(ownerType: "user" | "org", ownerId: string | null) {
    return withSystemDb("calendar-gi-import", async (tx) => {
      const event = connectedAccountEvent(ownerType, ownerId, `gi-${crypto.randomUUID()}@gmail.com`)
      const { accountId } = await onAccountConnected(tx as any, orgId, event, async () => {})
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [],
        async () => {},
      )
      return accountId
    })
  }

  async function queuedUserDimensionEvents(): Promise<Array<Record<string, any>>> {
    return withSystemDb("calendar-gi-read", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${orgId}::uuid
          AND payload->>'app' = 'kernel'
          AND payload->>'entity' = 'user_dimension'
      `)) as any
      return ((rows.rows ?? rows) as Array<{ payload: Record<string, any> }>).map((r) => r.payload)
    })
  }

  async function queuedTargets(): Promise<string[]> {
    return (await queuedUserDimensionEvents())
      .map((p) => p.data.targetUserId as string)
      .sort((a, b) => a.localeCompare(b))
  }

  it("a personal import queues a user_dimension grant event naming the owning user only", async () => {
    await connectAndImport("user", userId)
    const events = await queuedUserDimensionEvents()
    expect(events).toHaveLength(1)
    expect(events[0].action).toBe("grant")
    expect(events[0].data.targetUserId).toBe(userId)
  })

  it("an org import queues one event per active member, and a re-import queues nothing", async () => {
    await withSystemDb("calendar-gi-deactivated", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`gone-${crypto.randomUUID()}@x.test`}, 'Gone', 'deactivated', 'h', 1, 1)
      `)
    })
    const accountId = await connectAndImport("org", null)
    const active = await withSystemDb("calendar-gi-active", async (tx) => {
      const rows = (await tx.execute(drizzleSql`
        SELECT id FROM kernel.users WHERE org_id = ${orgId}::uuid AND status = 'active' ORDER BY id
      `)) as any
      return ((rows.rows ?? rows) as Array<{ id: string }>).map((r) => r.id)
    })
    expect(active).toContain(userId)
    expect(active).toContain(otherUserId)
    expect(await queuedTargets()).toEqual([...active].sort((x, y) => x.localeCompare(y)))

    await withSystemDb("calendar-gi-clear-reimport", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}::uuid`)
    })
    await withSystemDb("calendar-gi-reimport", async (tx) => {
      await runCalendarImport(
        tx as any,
        orgId,
        accountId,
        async () => [],
        async () => {},
      )
    })
    expect(await queuedTargets()).toEqual([])
  })

  it("a late joiner grant queues an event naming that user only, and a re-run queues nothing", async () => {
    await connectAndImport("org", null)
    await withSystemDb("calendar-gi-clear-late", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}::uuid`)
    })
    const lateUserId = await withSystemDb("calendar-gi-late-user", async (tx) => {
      const nu = (await tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`gi-late-${crypto.randomUUID()}@x.test`}, 'Late', 'active', 'h', 1, 1)
        RETURNING id
      `)) as any
      return (nu.rows ?? nu)[0].id as string
    })
    await withSystemDb("calendar-gi-late-grant", async (tx) => {
      await grantOrgCalendarAccessToUser(tx as any, orgId, lateUserId)
    })
    expect(await queuedTargets()).toEqual([lateUserId])

    await withSystemDb("calendar-gi-clear-regrant", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM kernel.pending_events WHERE org_id = ${orgId}::uuid`)
    })
    await withSystemDb("calendar-gi-late-regrant", async (tx) => {
      await grantOrgCalendarAccessToUser(tx as any, orgId, lateUserId)
    })
    expect(await queuedTargets()).toEqual([])
  })
})
