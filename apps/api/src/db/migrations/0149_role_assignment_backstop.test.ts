// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0149: assigning a role that grants a privileged scope needs an admin session at
// the policy level, like a direct privileged scope grant already did. A role made
// of app scopes only stays assignable by whoever the application lets assign it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as dsql } from "drizzle-orm"
import { sql } from "~/db"
import { withRlsContext } from "~/db/rls"

const ORG = "00000000-0000-4000-8000-0000000d7001"
const MEMBER = "00000000-0000-4000-8000-0000000d7011"
const TARGET = "00000000-0000-4000-8000-0000000d7012"
const ADMIN_ROLE = "00000000-0000-4000-8000-0000000d7021"
const APP_ROLE = "00000000-0000-4000-8000-0000000d7022"

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Backstop', 'backstop-org') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES
    (${MEMBER}, ${ORG}, 'bs-member@test.com', 'M'), (${TARGET}, ${ORG}, 'bs-target@test.com', 'T')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES
    (${ADMIN_ROLE}, ${ORG}, 'bs-admin'), (${APP_ROLE}, ${ORG}, 'bs-app') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES
    (${ADMIN_ROLE}, '*'), (${APP_ROLE}, 'tickets:tickets:read')`
})
afterAll(async () => {
  await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (${ADMIN_ROLE}, ${APP_ROLE})`
  await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

function assign(scopes: string[], roleId: string) {
  return withRlsContext(
    { actorType: "user", userId: MEMBER, orgId: ORG, scopes, dimensionGrants: {} },
    (tx) =>
      tx.execute(
        dsql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES (${TARGET}, ${roleId}, ${ORG})`,
      ),
  )
}

describe("0149 role assignment backstop", () => {
  it("refuses a non-admin session assigning a role with a privileged scope", async () => {
    await expect(assign(["kernel:threads:write"], ADMIN_ROLE)).rejects.toThrow()
  })

  it("lets an admin session assign it", async () => {
    await assign(["kernel:users:admin"], ADMIN_ROLE)
    const rows =
      await sql`SELECT 1 FROM kernel.user_roles WHERE user_id = ${TARGET} AND role_id = ${ADMIN_ROLE}`
    expect(rows.length).toBe(1)
  })

  it("leaves a role of app scopes only to the application's own check", async () => {
    await assign(["tickets:tickets:read"], APP_ROLE)
    const rows =
      await sql`SELECT 1 FROM kernel.user_roles WHERE user_id = ${TARGET} AND role_id = ${APP_ROLE}`
    expect(rows.length).toBe(1)
  })
})
