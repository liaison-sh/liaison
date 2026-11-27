// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An app role template that carries its app's approve scope makes the people
// in that role decide the cards their agents stage for that app (a payments
// app's billing tier decides the refunds and cancellations it requests), not
// only administrators. Registration seeds the app roles from each bundled
// manifest, as it does for every org; a person in the reading tier decides
// none of them, and Full Member gains no approve scope.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { extendFullMemberRole, flattenRoleScopes, seedManifestRoles } from "~/modules/apps/runtime"
import { eligibleApprovers } from "~/modules/permissions/eligible-approvers"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

type Roles = Record<string, { description?: string; extends?: string; scopes: string[] }>

const BUNDLED = join(import.meta.dir, "../../../../../bundled-apps")

/** Every bundled app with a reading `member` tier and a non-admin tier that decides its approvals. */
const cases = readdirSync(BUNDLED)
  .map((dir) => {
    try {
      return JSON.parse(readFileSync(join(BUNDLED, dir, "app.manifest.json"), "utf8")) as {
        name: string
        roles?: Roles
      }
    } catch {
      return null
    }
  })
  .flatMap((m) => {
    if (!m?.roles?.member) return []
    const approve = `${m.name}:approve`
    const decider = Object.keys(m.roles).find(
      (r) => r !== "admin" && flattenRoleScopes(m.roles!, r).includes(approve),
    )
    return decider ? [{ app: m.name, roles: m.roles, decider, approve }] : []
  })

let orgId = ""
const people = new Map<string, { decider: string; reader: string }>()

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  for (const c of cases) {
    await withSystemDb("app-role-approvers-seed", async (tx) => {
      await seedManifestRoles(tx, orgId, c.app, c.roles)
      await extendFullMemberRole(tx, orgId, c.roles)
    })
    const decider = (await minimal.person(orgId)).id
    const reader = (await minimal.person(orgId)).id
    await minimal.assignRole(decider, `${c.app}.${c.decider}`)
    await minimal.assignRole(reader, `${c.app}.member`)
    people.set(c.app, { decider, reader })
  }
})

afterAll(async () => {
  await releaseTestLock()
})

describe("app roles that decide their app's approvals", () => {
  it("covers the payments app's billing tier", () => {
    expect(cases.some((c) => c.decider === "billing")).toBe(true)
  })

  it("the deciding tier decides its app's cards; the reading tier does not", async () => {
    for (const c of cases) {
      const ids = new Set(
        await withPrivilegedDb(orgId, "app-role-approvers-test", (tx) =>
          eligibleApprovers(tx, orgId, c.approve, c.app),
        ),
      )
      const p = people.get(c.app)!
      expect(ids.has(p.decider), `${c.app}.${c.decider}`).toBe(true)
      expect(ids.has(p.reader), `${c.app}.member`).toBe(false)
    }
  })

  it("Full Member gains no approve scope from these apps", async () => {
    const rows = await sql<{ scope: string }[]>`
      SELECT g.scope FROM kernel.role_scope_grants g JOIN kernel.roles r ON r.id = g.role_id
       WHERE r.org_id = ${orgId} AND r.name = 'Full Member'`
    const approves = new Set(cases.map((c) => c.approve))
    expect(rows.map((r) => r.scope).filter((s) => approves.has(s))).toEqual([])
  })
})
