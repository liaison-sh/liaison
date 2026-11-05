// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression: the QA seed route `/api/_test/grants/set-user-scopes` must be able
// to seed PRIVILEGED kernel scopes (e.g. kernel:users:admin) — scenario 21's
// bootstrap creates a limited-admin this way, and Playwright RBAC tests depend on
// it. It previously ran as a bare system actor and 500'd on two RLS layers:
//   1. user_scope_grants WITH CHECK gates privileged scopes behind
//      kernel.session_is_admin() (app.current_scopes = '*'); a system actor has
//      no '*' scope.
//   2. setUserScopes bumps the target's permission_version, a kernel.users UPDATE
//      that users_update_rls evaluates as `id = current_user_id::uuid` — and a
//      system actor's empty current_user_id makes that cast `''::uuid` throw.
// The route now seeds AS the org's '*'-scoped admin, with RLS fully enforced.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { buildTestApp } from "~/tests/helpers/build-app"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const ADMIN = crypto.randomUUID()
const TARGET = crypto.randomUUID()

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'GrantRouteOrg', ${`grant-route-${ORG.slice(0, 8)}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN}, ${ORG}, ${`admin-${ADMIN.slice(0, 8)}@t.com`}, 'Route Admin')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${TARGET}, ${ORG}, ${`target-${TARGET.slice(0, 8)}@t.com`}, 'Route Target')`
  // The admin holds '*' directly — this is whom the route resolves and acts as.
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope) VALUES (${ADMIN}, ${ORG}, '*')`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.app_scope_grant_audit WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("POST /api/_test/grants/set-user-scopes", () => {
  test("seeds a PRIVILEGED kernel scope by acting as the org admin (regression: used to 500 under RLS)", async () => {
    const app = await buildTestApp()
    const res = await app.request("/api/_test/grants/set-user-scopes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: TARGET,
        orgId: ORG,
        callingApp: "kernel",
        scopes: ["kernel:users:admin", "kernel:threads:read"],
      }),
    })
    expect(res.status).toBe(200)
    const grants = await sql<{ scope: string }[]>`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${TARGET} AND org_id = ${ORG} ORDER BY scope`
    const scopes = grants.map((g) => g.scope)
    expect(scopes).toContain("kernel:users:admin")
    expect(scopes).toContain("kernel:threads:read")
  })

  test("'set' semantics: a follow-up call REPLACES the kernel grant set (privileged scope removed)", async () => {
    const app = await buildTestApp()
    const res = await app.request("/api/_test/grants/set-user-scopes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: TARGET,
        orgId: ORG,
        callingApp: "kernel",
        scopes: ["kernel:threads:read"],
      }),
    })
    expect(res.status).toBe(200)
    const grants = await sql<{ scope: string }[]>`
      SELECT scope FROM kernel.user_scope_grants
      WHERE user_id = ${TARGET} AND org_id = ${ORG} AND scope LIKE 'kernel:%' ORDER BY scope`
    expect(grants.map((g) => g.scope)).toEqual(["kernel:threads:read"])
  })

  test("returns 500 with a clear message when the org has no '*'-scoped admin to seed as", async () => {
    const ORPHAN_ORG = crypto.randomUUID()
    const ORPHAN_USER = crypto.randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORPHAN_ORG}, 'NoAdminOrg', ${`no-admin-${ORPHAN_ORG.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ORPHAN_USER}, ${ORPHAN_ORG}, ${`orphan-${ORPHAN_USER.slice(0, 8)}@t.com`}, 'Orphan')`
    try {
      const app = await buildTestApp()
      const res = await app.request("/api/_test/grants/set-user-scopes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: ORPHAN_USER,
          orgId: ORPHAN_ORG,
          callingApp: "kernel",
          scopes: ["kernel:threads:read"],
        }),
      })
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error?: { message?: string } }
      expect(body.error?.message ?? "").toContain("no '*'-scoped admin")
    } finally {
      await sql`DELETE FROM kernel.users WHERE org_id = ${ORPHAN_ORG}`
      await sql`DELETE FROM kernel.organizations WHERE id = ${ORPHAN_ORG}`
    }
  })
})
