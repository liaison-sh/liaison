// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S20 / A3 / A24-4 / A24-5 / D20: an app restricted to selected roles and
// people. Two users, one listed role:
//  - A holds `tickets:*` through the LISTED role: keeps the app,
//  - B holds `tickets:*` through ANOTHER role, not listed: loses every tickets
//    scope at effective-scope resolution (prefix grants included), so the
//    manifest, the app's routes, its approvals (RLS notified-approver branch)
//    and the eligible-approver audience all leave B out, and B's personal
//    agent ceiling is recomputed without them,
//  - an org admin (`*`) is exempt,
//  - a token minted before the change is refused (permission_version_mismatch).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { app } from "~/app"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel"
import { setOrgAppAccess } from "~/modules/apps/org-app-service"
import { eligibleApprovers } from "~/modules/permissions/eligible-approvers"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let admin: minimal.Session
let a: minimal.Session
let b: minimal.Session
let listedRole: string
let otherRole: string
let approvalId: string

async function scopesOf(userId: string, orgId: string): Promise<string[]> {
  return (
    await withPrivilegedDb(orgId, "test-perms", (tx) => loadEffectivePermissions(tx, userId, orgId))
  ).scopes
}

async function visibleApprovals(userId: string, orgId: string): Promise<number> {
  const perms = await withPrivilegedDb(orgId, "test-perms", (tx) =>
    loadEffectivePermissions(tx, userId, orgId),
  )
  return withRlsContext(
    {
      actorType: "user",
      userId,
      orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
      roles: perms.roles,
    },
    async (tx) => {
      const [r] = extractRows<{ n: number }>(
        await tx.execute(
          drizzleSql`SELECT count(*)::int AS n FROM kernel.approval_requests WHERE id = ${approvalId}`,
        ),
      )
      return r?.n ?? -1
    },
  )
}

beforeAll(async () => {
  await acquireTestLock()
  admin = await minimal.adminSession((await createTestOrg()).id)
  a = await minimal.session(admin.orgId, { role: "member" })
  b = await minimal.session(admin.orgId, { role: "member" })
  const orgId = admin.orgId
  listedRole = randomUUID()
  otherRole = randomUUID()
  await sql`INSERT INTO kernel.roles (id, org_id, name) VALUES
    (${listedRole}, ${orgId}, 'p3-support'), (${otherRole}, ${orgId}, 'p3-other')`
  for (const role of [listedRole, otherRole]) {
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${role}, 'tickets:*')`
    // A deciding scope of ANOTHER app, as a tool's manifest `approveScope` may name.
    await sql`INSERT INTO kernel.role_scope_grants (role_id, scope) VALUES (${role}, 'p3x:approve')`
  }
  await sql`INSERT INTO kernel.user_roles (user_id, role_id, org_id) VALUES
    (${a.userId}, ${listedRole}, ${orgId}), (${b.userId}, ${otherRole}, ${orgId})`
  for (const u of [a, b]) {
    await withPrivilegedDb(orgId, "test-seed-personal-agent", (tx) =>
      tx.insert(agents).values({
        orgId,
        kind: "personal",
        handle: `@p3-${randomUUID().slice(0, 8)}`,
        displayName: "Liaison",
        ownerUserId: u.userId,
        scopeCeiling: ["tickets:*"],
      }),
    )
  }
  const threadId = await minimal.thread(orgId, admin.userId)
  approvalId = randomUUID()
  await sql`INSERT INTO kernel.approval_requests (id, org_id, handle, thread_id,
      originating_thread_id, tool_name, tool_params, current_payload, expires_at,
      notify_user_ids, requested_by)
    VALUES (${approvalId}, ${orgId}, ${`p3-${approvalId.slice(0, 8)}`}, ${threadId}, ${threadId},
      'tickets:tickets_reply', '{}'::jsonb, '{}'::jsonb, now() + interval '1 day',
      ARRAY[${a.userId}, ${b.userId}]::uuid[], ${admin.userId})`
}, 120_000)

afterAll(async () => {
  await sql`DELETE FROM kernel.approval_requests WHERE id = ${approvalId}`
  await releaseTestLock()
})

describe("restricted app access", () => {
  it("discriminator: before the restriction both members hold tickets and see the approval", async () => {
    for (const u of [a, b]) {
      expect(await scopesOf(u.userId, admin.orgId)).toContain("tickets:*")
      expect(await visibleApprovals(u.userId, admin.orgId)).toBe(1)
    }
    const audience = await withPrivilegedDb(admin.orgId, "t", (tx) =>
      eligibleApprovers(tx, admin.orgId, "tickets:approve"),
    )
    expect(audience).toEqual(expect.arrayContaining([a.userId, b.userId]))
  })

  it("restricted to one role: the listed member keeps it, the other loses it everywhere, admin exempt", async () => {
    const staleB = b.bearer
    await setOrgAppAccess(admin.orgId, "tickets", {
      mode: "restricted",
      roleIds: [listedRole],
      userIds: [],
    })
    const orgId = admin.orgId

    // Effective scopes (token mint, MCP tokens, jobs, approvals all read these).
    expect(await scopesOf(a.userId, orgId)).toContain("tickets:*")
    expect((await scopesOf(b.userId, orgId)).filter((s) => s.startsWith("tickets"))).toEqual([])
    expect(await scopesOf(admin.userId, orgId)).toContain("*")

    // A token minted before the change is refused.
    const stale = await app.request("/api/apps/manifests", {
      headers: { Authorization: `Bearer ${staleB}` },
    })
    // permission_version_mismatch (logged as the reason): the client refreshes.
    expect(stale.status).toBe(401)

    // Fresh tokens: B has no tickets manifest and its routes answer 403.
    const tokenA = await minimal.token(a.userId)
    const tokenB = await minimal.token(b.userId)
    const feed = async (tok: string) =>
      (
        (await (
          await app.request("/api/apps/manifests", { headers: { Authorization: `Bearer ${tok}` } })
        ).json()) as { data: Array<{ name: string }> }
      ).data.map((d) => d.name)
    expect(await feed(tokenA)).toContain("tickets")
    expect(await feed(tokenB)).not.toContain("tickets")
    const route = await app.request("/api/apps/tickets/connections", {
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    expect(route.status).toBe(403)

    // Approvals: B (notified, holding tickets:approve through the other role)
    // no longer reads the tickets approval; A still does.
    expect(await visibleApprovals(a.userId, orgId)).toBe(1)
    expect(await visibleApprovals(b.userId, orgId)).toBe(0)
    const audience = await withPrivilegedDb(orgId, "t", (tx) =>
      eligibleApprovers(tx, orgId, "tickets:approve"),
    )
    expect(audience).toContain(a.userId)
    expect(audience).not.toContain(b.userId)
    // A tickets tool whose deciding scope belongs to another app: the TOOL's app
    // decides the restriction (as the approval_requests_select policy does).
    const crossApp = await withPrivilegedDb(orgId, "t", (tx) =>
      eligibleApprovers(tx, orgId, "p3x:approve", "tickets"),
    )
    expect(crossApp).toContain(a.userId)
    expect(crossApp).not.toContain(b.userId)

    // B's personal agent ceiling is recomputed without the app.
    const [ceil] = await withPrivilegedDb(orgId, "t", (tx) =>
      tx
        .select({ scopeCeiling: agents.scopeCeiling })
        .from(agents)
        .where(eq(agents.ownerUserId, b.userId)),
    )
    expect((ceil?.scopeCeiling ?? []).filter((s) => s.startsWith("tickets"))).toEqual([])
  }, 60_000)

  it("listing B directly restores it; back to everyone restores all", async () => {
    await setOrgAppAccess(admin.orgId, "tickets", {
      mode: "restricted",
      roleIds: [listedRole],
      userIds: [b.userId],
    })
    expect(await scopesOf(b.userId, admin.orgId)).toContain("tickets:*")
    await setOrgAppAccess(admin.orgId, "tickets", { mode: "everyone", roleIds: [], userIds: [] })
    expect(await visibleApprovals(b.userId, admin.orgId)).toBe(1)
  }, 60_000)
})
