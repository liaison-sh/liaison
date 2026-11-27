// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The app roles a finance person is given decide the money cards their agent
// stages: a refund or a cancellation (Stripe billing). Registration seeds the
// app roles from the manifests, as it does for every org; a person holding
// only the reading tier decides none of them, and Full Member gains no
// approve scope.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db/connection"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { extendFullMemberRole, seedManifestRoles } from "~/modules/apps/runtime"
import { eligibleApprovers } from "~/modules/permissions/eligible-approvers"

type Roles = Record<string, { description?: string; extends?: string; scopes: string[] }>

const ORG = "00000000-0000-4000-8000-0000000b2e31"
const BILLING = "00000000-0000-4000-8000-0000000b2e32"
const READER = "00000000-0000-4000-8000-0000000b2e33"

const stripeRoles = (
  JSON.parse(
    readFileSync(
      join(import.meta.dir, "../../../../../bundled-apps/stripe/app.manifest.json"),
      "utf8",
    ),
  ) as { roles: Roles }
).roles

async function assign(userId: string, roleName: string): Promise<void> {
  await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id)
    SELECT ${userId}, id, ${ORG} FROM kernel.roles WHERE org_id = ${ORG} AND name = ${roleName}
    ON CONFLICT DO NOTHING`
}

const deciders = (scope: string, app: string) =>
  withPrivilegedDb(ORG, "money-role-approvers-test", (tx) => eligibleApprovers(tx, ORG, scope, app))

describe("money cards reach the app roles that request them", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Money roles', 'money-roles-b2e3') ON CONFLICT (id) DO NOTHING`
    for (const id of [BILLING, READER]) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status)
        VALUES (${id}, ${ORG}, ${`${id}@test.local`}, 'Money User', 'active') ON CONFLICT DO NOTHING`
    }
    await withSystemDb("money-role-approvers-seed", async (tx) => {
      await seedManifestRoles(tx, ORG, "stripe", stripeRoles)
      await extendFullMemberRole(tx, ORG, stripeRoles)
    })
    await assign(BILLING, "stripe.billing")
    await assign(READER, "stripe.member")
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("a Stripe billing person decides refund and cancellation cards; a Stripe reader does not", async () => {
    const ids = new Set(await deciders("stripe:approve", "stripe"))
    expect(ids.has(BILLING)).toBe(true)
    expect(ids.has(READER)).toBe(false)
  })

  it("Full Member gains no approve scope from the money apps", async () => {
    const rows = await sql<{ scope: string }[]>`
      SELECT g.scope FROM kernel.role_scope_grants g JOIN kernel.roles r ON r.id = g.role_id
       WHERE r.org_id = ${ORG} AND r.name = 'Full Member'`
    expect(rows.map((r) => r.scope).filter((s) => s.endsWith(":approve"))).toEqual([])
  })
})
