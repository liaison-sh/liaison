// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { eligibleApprovers, scopeMatchesFragment } from "~/modules/permissions/eligible-approvers"
import { hasScope } from "~/modules/permissions/permissions"

const ORG = "00000000-0000-4000-8000-000000062001"
const ROLE = "00000000-0000-4000-8000-000000062002"
const DIRECT = "00000000-0000-4000-8000-000000062003"
const ROLE_USER = "00000000-0000-4000-8000-000000062004"
const WILDCARD = "00000000-0000-4000-8000-000000062005"
const PARENT = "00000000-0000-4000-8000-000000062006"
const PERCENT = "00000000-0000-4000-8000-000000062007"
const UNDERSCORE = "00000000-0000-4000-8000-000000062008"
const INACTIVE = "00000000-0000-4000-8000-000000062009"
const APP_GLOB = "00000000-0000-4000-8000-00000006200a"
const MID_GLOB = "00000000-0000-4000-8000-00000006200b"

describe("eligibleApprovers", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Eligible Org', 'eligible-org') ON CONFLICT DO NOTHING`
    for (const [id, status] of [
      [DIRECT, "active"],
      [ROLE_USER, "active"],
      [WILDCARD, "active"],
      [PARENT, "active"],
      [PERCENT, "active"],
      [UNDERSCORE, "active"],
      [INACTIVE, "deactivated"],
      [APP_GLOB, "active"],
      [MID_GLOB, "active"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
        VALUES (${id}, ${ORG}, ${`${id}@test.local`}, 'Eligible User', ${status}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES (${ROLE}, ${ORG}, 'approver') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${ROLE}, 'mail:approve') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${ROLE_USER}, ${ROLE}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES
      (${DIRECT}, ${ORG}, 'mail:approve'),
      (${ROLE_USER}, ${ORG}, 'mail:approve'),
      (${WILDCARD}, ${ORG}, '*'),
      (${PARENT}, ${ORG}, 'mail'),
      (${PERCENT}, ${ORG}, 'mail%'),
      (${UNDERSCORE}, ${ORG}, 'ma_l'),
      (${INACTIVE}, ${ORG}, 'mail:approve'),
      (${APP_GLOB}, ${ORG}, 'mail:*'),
      (${MID_GLOB}, ${ORG}, 'mail:*:x')
      ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id = ${ROLE}`
    await sql`DELETE FROM kernel.roles WHERE id = ${ROLE}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("matches direct, role, wildcard, and parent scopes without treating SQL wildcards as scope wildcards", async () => {
    const ids = await withPrivilegedDb(ORG, "eligible-approvers-test", (tx) =>
      eligibleApprovers(tx, ORG, "mail:approve"),
    )
    const set = new Set(ids)

    expect(set.has(DIRECT)).toBe(true)
    expect(set.has(ROLE_USER)).toBe(true)
    expect(set.has(WILDCARD)).toBe(true)
    expect(set.has(PARENT)).toBe(true)
    expect(set.has(PERCENT)).toBe(false)
    expect(set.has(UNDERSCORE)).toBe(false)
    expect(set.has(INACTIVE)).toBe(false)
    expect(ids.length).toBe(set.size)
  })

  // hasScope grants `<prefix>:*` everything under the prefix; the SQL predicate used to
  // honour only '*', an exact match and a bare parent, so a `mail:*` holder was never an
  // approver (nor a reader of a declared taint sink). Verifier finding, 2026-09-23.
  it("honours a trailing ':*' wildcard as hasScope does, and never a mid-segment one", async () => {
    const ids = new Set(
      await withPrivilegedDb(ORG, "eligible-approvers-test", (tx) =>
        eligibleApprovers(tx, ORG, "mail:approve"),
      ),
    )
    expect(ids.has(APP_GLOB)).toBe(true)
    expect(ids.has(MID_GLOB)).toBe(false)
  })

  it("the SQL predicate agrees with hasScope on every grant/required pair of the grid", async () => {
    const grants = [
      "*",
      "kpi",
      "kpi:*",
      "kpi:comments",
      "kpi:comments:*",
      "kpi:comments:read",
      "kpi:comments:write",
      "kpi:*:read",
      "kpi:comments:read:*",
      "kp",
      "kpi%",
      "kpi_",
      "kpi:c",
      "tickets:*",
      "",
      ":*",
      "kpi:comments:*:*",
    ]
    const required = [
      "kpi",
      "kpi:comments",
      "kpi:comments:read",
      "kpi:comments:read:x",
      "kpi:metrics:read",
      "kpi:*",
      "kpi:",
      "tickets:tickets:read",
      "kpix:comments:read",
    ]
    const mismatches: string[] = []
    for (const g of grants) {
      for (const r of required) {
        const rows = (await withPrivilegedDb(ORG, "eligible-approvers-parity", (tx) =>
          tx.execute(
            drizzleSql`SELECT ${scopeMatchesFragment(drizzleSql`${g}::text`, drizzleSql`${r}::text`)} AS m`,
          ),
        )) as unknown as { rows?: Array<{ m: boolean }> } | Array<{ m: boolean }>
        const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
        const sqlSays = list[0]?.m === true
        if (sqlSays !== hasScope(r, [g]))
          mismatches.push(`${JSON.stringify(g)} vs ${r}: sql=${sqlSays}`)
      }
    }
    expect(mismatches).toEqual([])
  })
})
