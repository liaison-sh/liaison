// SPDX-License-Identifier: FSL-1.1-ALv2
//
// withPortalContext on the portal's own login (liaison_portal): it runs as the
// portal role, cannot step back to any other role, and opens only for an active
// external user.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import {
  PortalContextRefusedError,
  PortalUnavailableError,
  portalAvailable,
  withPortalContext,
} from "~/db/portal-rls"
import { insertSql } from "~/seed/factories/org/test-rows"

const ORG_ID = crypto.randomUUID()
const OTHER_ORG_ID = crypto.randomUUID()
const COMPANY_ID = crypto.randomUUID()
const EXTERNAL_ID = crypto.randomUUID()
const SUSPENDED_ID = crypto.randomUUID()
const MEMBER_ID = crypto.randomUUID()

beforeAll(async () => {
  for (const id of [ORG_ID, OTHER_ORG_ID]) {
    await sql.unsafe(
      insertSql("kernel.organizations", {
        id,
        name: "Portal context",
        slug: `portal-ctx-${id.slice(0, 8)}`,
      }),
    )
  }
  await sql.unsafe(
    insertSql("kernel.companies", {
      id: COMPANY_ID,
      org_id: ORG_ID,
      handle: "client-co",
      name: "Client Co",
    }),
  )
  await sql.unsafe(
    insertSql("kernel.users", [
      {
        id: EXTERNAL_ID,
        org_id: ORG_ID,
        email: `client-${EXTERNAL_ID.slice(0, 8)}@example.com`,
        name: "Client",
        user_type: "external",
        company_id: COMPANY_ID,
        status: "active",
      },
      {
        id: SUSPENDED_ID,
        org_id: ORG_ID,
        email: `gone-${SUSPENDED_ID.slice(0, 8)}@example.com`,
        name: "Gone",
        user_type: "external",
        company_id: COMPANY_ID,
        status: "deactivated",
      },
      {
        id: MEMBER_ID,
        org_id: ORG_ID,
        email: `member-${MEMBER_ID.slice(0, 8)}@example.com`,
        name: "Member",
        user_type: "member",
        company_id: null,
        status: "active",
      },
    ]),
  )
})

/** The database's own message behind drizzle's "Failed query" wrapper. */
function databaseMessage(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } }
  return e.cause?.message ?? e.message ?? String(err)
}

afterAll(async () => {
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG_ID}, ${OTHER_ORG_ID})`
})

describe.if(!portalAvailable())("withPortalContext without split logins", () => {
  test("refuses before anything runs: there is no portal login to fall back from", async () => {
    let ran = false
    await expect(
      withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async () => {
        ran = true
      }),
    ).rejects.toBeInstanceOf(PortalUnavailableError)
    expect(ran).toBe(false)
  })
})

describe.if(portalAvailable())("withPortalContext", () => {
  test("on the portal login, withPortalContext runs as liaison_portal and reads portal.me", async () => {
    const out = await withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async (tx) => {
      const [who] = extractRows<{ login: string; role: string }>(
        await tx.execute(
          drizzleSql`SELECT session_user::text AS login, current_user::text AS role`,
        ),
      )
      const me = extractRows<{ id: string; company_id: string }>(
        await tx.execute(drizzleSql`SELECT id, company_id FROM portal.me`),
      )
      const [scopes] = extractRows<{ scopes: string }>(
        await tx.execute(drizzleSql`SELECT rls_ctx.scopes() AS scopes`),
      )
      return { who, me, scopes }
    })
    expect(out.who).toEqual({ login: "liaison_portal", role: "liaison_portal" })
    expect(out.me).toEqual([{ id: EXTERNAL_ID, company_id: COMPANY_ID }])
    expect(out.scopes?.scopes).toBe("__none__")
  })

  test("a portal transaction runs on the portal login and cannot step back to the request login's rights", async () => {
    // RESET ROLE returns to the session's own role, which is the portal role itself.
    const reset = await withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async (tx) => {
      await tx.execute(drizzleSql`RESET ROLE`)
      return extractRows<{ login: string; role: string }>(
        await tx.execute(
          drizzleSql`SELECT session_user::text AS login, current_user::text AS role`,
        ),
      )[0]
    })
    expect(reset).toEqual({ login: "liaison_portal", role: "liaison_portal" })
    // Every other way to another role raises: the portal login is a member of no role.
    for (const step of [
      drizzleSql`SET LOCAL ROLE liaison_rls`,
      drizzleSql`SET LOCAL ROLE liaison_request`,
      drizzleSql`SET SESSION AUTHORIZATION liaison_request`,
      drizzleSql`SELECT set_config('role', 'liaison_rls', true)`,
      drizzleSql`SELECT set_config('role', 'liaison_app', true)`,
    ]) {
      const refused = await withPortalContext(
        { orgId: ORG_ID, userId: EXTERNAL_ID },
        async (tx) => {
          await tx.execute(step)
          return "stepped"
        },
      ).catch(databaseMessage)
      expect(refused).toMatch(/permission denied/i)
    }
    // After the reset, a kernel table is still denied, not filtered to zero rows.
    const denied = await withPortalContext({ orgId: ORG_ID, userId: EXTERNAL_ID }, async (tx) => {
      await tx.execute(drizzleSql`RESET ROLE`)
      await tx.execute(drizzleSql`SELECT 1 FROM kernel.users LIMIT 1`)
      return "read"
    }).catch(databaseMessage)
    expect(denied).toMatch(/permission denied/i)
  })

  test("refuses a member and runs nothing", async () => {
    let ran = false
    await expect(
      withPortalContext({ orgId: ORG_ID, userId: MEMBER_ID }, async () => {
        ran = true
      }),
    ).rejects.toBeInstanceOf(PortalContextRefusedError)
    expect(ran).toBe(false)
  })

  test("refuses an external user who is no longer active", async () => {
    await expect(
      withPortalContext({ orgId: ORG_ID, userId: SUSPENDED_ID }, async () => "ran"),
    ).rejects.toBeInstanceOf(PortalContextRefusedError)
  })

  test("refuses an id that is no user, and a value that is no id", async () => {
    await expect(
      withPortalContext({ orgId: ORG_ID, userId: crypto.randomUUID() }, async () => "ran"),
    ).rejects.toBeInstanceOf(PortalContextRefusedError)
    await expect(
      withPortalContext({ orgId: ORG_ID, userId: "not-a-uuid" }, async () => "ran"),
    ).rejects.toBeInstanceOf(PortalContextRefusedError)
  })

  test("portal.company_id returns the caller's company and nobody else's", async () => {
    const company = await withPortalContext(
      { orgId: ORG_ID, userId: EXTERNAL_ID },
      async (tx) =>
        extractRows<{ company_id: string | null }>(
          await tx.execute(drizzleSql`SELECT portal.company_id() AS company_id`),
        )[0]?.company_id,
    )
    expect(company).toBe(COMPANY_ID)
  })
})
