// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { narrowPendingApprovalForTaint } from "~/modules/approvals/taint-narrow"
import {
  eligibleApprovers,
  eligibleApproversWithDimension,
  everyMemberScopeFragment,
  scopeMatchesFragment,
} from "~/modules/permissions/eligible-approvers"
import { KERNEL_EVERY_MEMBER_SCOPES } from "~/modules/permissions/every-member-scopes"
import { hasScope, loadEffectivePermissions } from "~/modules/permissions/permissions"

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

// A real scope check adds the computed every-member scopes to the stored grants. An approver is
// exactly who that check says holds the scope: nobody it refuses, nobody it accepts left out.
describe("eligibleApprovers counts what a real scope check counts", () => {
  const EM_ORG = "00000000-0000-4000-8000-000000062101"
  const OTHER_ORG = "00000000-0000-4000-8000-000000062102"
  const MEMBER = "00000000-0000-4000-8000-000000062103"
  const STORED = "00000000-0000-4000-8000-000000062104"
  const SUSPENDED = "00000000-0000-4000-8000-000000062105"
  const DEACTIVATED = "00000000-0000-4000-8000-000000062106"
  const LISTED = "00000000-0000-4000-8000-000000062107"
  const STAR = "00000000-0000-4000-8000-000000062108"
  const OUTSIDER = "00000000-0000-4000-8000-000000062109"
  const PEOPLE = [MEMBER, STORED, SUSPENDED, DEACTIVATED, LISTED, STAR]

  const OPEN = "emopen:connection:read"
  const REMOVED = "emgone:things:read"
  const RESTRICTED = "emclosed:things:read"
  const OTHER_ORG_ONLY = "emother:things:read"

  beforeAll(async () => {
    for (const [id, slug] of [
      [EM_ORG, "every-member-org"],
      [OTHER_ORG, "every-member-other"],
    ] as const) {
      await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${id}, 'Every Member', ${slug}) ON CONFLICT DO NOTHING`
    }
    for (const [id, status] of [
      [MEMBER, "active"],
      [STORED, "active"],
      [SUSPENDED, "suspended"],
      [DEACTIVATED, "deactivated"],
      [LISTED, "active"],
      [STAR, "active"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
        VALUES (${id}, ${EM_ORG}, ${`${id}@test.local`}, 'Every Member', ${status}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
      VALUES (${OUTSIDER}, ${OTHER_ORG}, ${`${OUTSIDER}@test.local`}, 'Outsider', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES
      (${STORED}, ${EM_ORG}, 'emopen:policy:read'),
      (${STORED}, ${EM_ORG}, 'mail:approve'),
      (${MEMBER}, ${EM_ORG}, 'mail:approve'),
      (${STAR}, ${EM_ORG}, '*')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.apps (org_id, name, version, status, access_mode, every_member_scopes) VALUES
      (${EM_ORG}, 'emopen', '1.0.0', 'active', 'everyone', ${`{${OPEN}}`}::text[]),
      (${EM_ORG}, 'emgone', '1.0.0', 'removed', 'everyone', ${`{${REMOVED}}`}::text[]),
      (${EM_ORG}, 'emclosed', '1.0.0', 'active', 'restricted', ${`{${RESTRICTED}}`}::text[]),
      (${OTHER_ORG}, 'emother', '1.0.0', 'active', 'everyone', ${`{${OTHER_ORG_ONLY}}`}::text[])
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.org_app_access (org_id, app, principal_type, principal_id)
      VALUES (${EM_ORG}, 'emclosed', 'user', ${LISTED}) ON CONFLICT DO NOTHING`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.org_app_access WHERE org_id = ${EM_ORG}`
    await sql`DELETE FROM kernel.apps WHERE org_id IN (${EM_ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${EM_ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id IN (${EM_ORG}, ${OTHER_ORG})`
    await sql`DELETE FROM kernel.organizations WHERE id IN (${EM_ORG}, ${OTHER_ORG})`
  })

  const approvers = async (scope: string, toolApp?: string) =>
    new Set(
      await withPrivilegedDb(EM_ORG, "every-member-test", (tx) =>
        eligibleApprovers(tx, EM_ORG, scope, toolApp),
      ),
    )

  it("equals hasScope over loadEffectivePermissions, person by person, scope by scope", async () => {
    const scopes = [
      OPEN,
      "emopen:policy:read",
      "emopen:connection",
      "emopen",
      "emopen:connection:read:x",
      "emopen:*",
      REMOVED,
      RESTRICTED,
      OTHER_ORG_ONLY,
      "mail:approve",
      "kernel:approvals:admin",
      ...KERNEL_EVERY_MEMBER_SCOPES,
    ]
    const effective = new Map<string, string[]>()
    for (const person of PEOPLE) {
      const { scopes: held } = await withPrivilegedDb(EM_ORG, "every-member-test", (tx) =>
        loadEffectivePermissions(tx, person, EM_ORG),
      )
      effective.set(person, held)
    }
    const diverged: string[] = []
    for (const scope of scopes) {
      const eligible = await approvers(scope)
      for (const person of PEOPLE) {
        // Eligibility is for active people; a real check of the others is never reached by one.
        const real =
          hasScope(scope, effective.get(person) ?? []) &&
          person !== SUSPENDED &&
          person !== DEACTIVATED
        if (real !== eligible.has(person)) diverged.push(`${scope} / ${person}: real=${real}`)
      }
    }
    expect(diverged).toEqual([])
  })

  it("an active member holds the every-member scope with no stored grant", async () => {
    expect((await approvers(OPEN)).has(MEMBER)).toBe(true)
  })

  it("it widens nothing: another scope of the app, a parent, an inactive person, a removed app, another org", async () => {
    expect((await approvers("emopen:policy:read")).has(MEMBER)).toBe(false)
    expect((await approvers("emopen")).has(MEMBER)).toBe(false)
    const open = await approvers(OPEN)
    expect(open.has(SUSPENDED)).toBe(false)
    expect(open.has(DEACTIVATED)).toBe(false)
    expect(open.has(OUTSIDER)).toBe(false)
    expect((await approvers(REMOVED)).has(MEMBER)).toBe(false)
    expect((await approvers(OTHER_ORG_ONLY)).has(MEMBER)).toBe(false)
  })

  it("a restricted app's every-member scope stays with the people who keep the app, whichever tool is decided", async () => {
    for (const toolApp of [undefined, "emopen"]) {
      const held = await approvers(RESTRICTED, toolApp)
      expect(held.has(MEMBER)).toBe(false)
      expect(held.has(LISTED)).toBe(true)
      expect(held.has(STAR)).toBe(true)
    }
  })

  it("a deciding scope with a dimension: the every-member scope is judged the same, and the constraint still holds", async () => {
    const withDim = await withPrivilegedDb(EM_ORG, "every-member-test", (tx) =>
      eligibleApproversWithDimension(tx, EM_ORG, OPEN, { key: "emopen:region", values: ["eu"] }),
    )
    expect(withDim).toContain(STAR)
    expect(withDim).not.toContain(MEMBER)
    await sql`INSERT INTO kernel.user_dimension_grants (user_id, org_id, dimension_key, dimension_values)
      VALUES (${MEMBER}, ${EM_ORG}, 'emopen:region', '["eu"]'::jsonb) ON CONFLICT DO NOTHING`
    try {
      const granted = await withPrivilegedDb(EM_ORG, "every-member-test", (tx) =>
        eligibleApproversWithDimension(tx, EM_ORG, OPEN, { key: "emopen:region", values: ["eu"] }),
      )
      expect(granted).toContain(MEMBER)
    } finally {
      await sql`DELETE FROM kernel.user_dimension_grants WHERE org_id = ${EM_ORG}`
    }
  })

  it("a tainted turn that read an every-member scope has a decider, and still none for a scope nobody holds", async () => {
    const row = {
      tool_name: "mail:reply",
      approve_scope: "mail:approve",
      requested_by: STORED,
      resource_owner_id: null,
      notify_user_ids: [STORED, MEMBER],
      dimension_constraint: null,
      metadata: null,
    }
    const parked = await withPrivilegedDb(EM_ORG, "every-member-test", (tx) =>
      narrowPendingApprovalForTaint(tx, EM_ORG, row as never, [OPEN]),
    )
    expect(parked).toMatchObject({ ok: true, mustHold: [OPEN] })
    if (parked.ok) expect(parked.notifyUserIds).toContain(MEMBER)
    const refused = await withPrivilegedDb(EM_ORG, "every-member-test", (tx) =>
      narrowPendingApprovalForTaint(tx, EM_ORG, row as never, [RESTRICTED]),
    )
    expect(refused.ok).toBe(false)
  })

  it("the SQL function matches grants as hasScope does, on the same grid", async () => {
    const grants = [
      "*",
      "kpi",
      "kpi:*",
      "kpi:comments",
      "kpi:comments:*",
      "kpi:comments:read",
      "kpi:*:read",
      "kp",
      "kpi%",
      ":*",
    ]
    const required = [
      "kpi",
      "kpi:comments",
      "kpi:comments:read",
      "kpi:metrics:read",
      "kpi:*",
      "tickets:tickets:read",
      "kpix:comments:read",
    ]
    const mismatches: string[] = []
    await sql`INSERT INTO kernel.apps (org_id, name, version, every_member_scopes) VALUES (${EM_ORG}, 'emgrid', '1.0.0', '{}'::text[]) ON CONFLICT DO NOTHING`
    try {
      for (const g of grants) {
        await sql`UPDATE kernel.apps SET every_member_scopes = ${`{"${g}"}`}::text[] WHERE org_id = ${EM_ORG} AND name = 'emgrid'`
        for (const r of required) {
          const rows = (await withPrivilegedDb(EM_ORG, "every-member-grid", (tx) =>
            tx.execute(
              drizzleSql`SELECT ${everyMemberScopeFragment(EM_ORG, drizzleSql`${MEMBER}::uuid`, drizzleSql`${r}`)} AS m`,
            ),
          )) as unknown as { rows?: Array<{ m: boolean }> } | Array<{ m: boolean }>
          const list = Array.isArray(rows) ? rows : (rows.rows ?? [])
          if ((list[0]?.m === true) !== hasScope(r, [g])) mismatches.push(`${g} vs ${r}`)
        }
      }
    } finally {
      await sql`DELETE FROM kernel.apps WHERE org_id = ${EM_ORG} AND name = 'emgrid'`
    }
    expect(mismatches).toEqual([])
  })
})
