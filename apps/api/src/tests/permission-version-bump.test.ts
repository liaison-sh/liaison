// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function readPermissionVersion(userId: string): Promise<number> {
  const [row] = await withSystemDb("read-permission-version", async (db) =>
    db
      .select({ permissionVersion: users.permissionVersion })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!row) throw new Error(`user ${userId} not found`)
  return row.permissionVersion
}

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

describe("permissionVersion bumps on every grant/revoke", () => {
  test("bumps on role assignment", async () => {
    const u = await minimal.person((await createTestOrg()).id)
    const before = await readPermissionVersion(u.id)
    await minimal.assignRole(u.id, "admin")
    expect(await readPermissionVersion(u.id)).toBe(before + 1)
  })

  test("bumps on role revoke", async () => {
    const u = await minimal.person((await createTestOrg()).id)
    await minimal.assignRole(u.id, "admin")
    const before = await readPermissionVersion(u.id)
    await minimal.revokeRole(u.id, "admin")
    expect(await readPermissionVersion(u.id)).toBeGreaterThan(before)
  })

  test("bumps on scope grant", async () => {
    const u = await minimal.person((await createTestOrg()).id)
    const before = await readPermissionVersion(u.id)
    await minimal.grantScope(u.id, "kernel:files:read")
    expect(await readPermissionVersion(u.id)).toBeGreaterThan(before)
  })

  test("bumps on scope revoke", async () => {
    const u = await minimal.person((await createTestOrg()).id)
    await minimal.grantScope(u.id, "kernel:files:read")
    const before = await readPermissionVersion(u.id)
    await minimal.revokeScope(u.id, "kernel:files:read")
    expect(await readPermissionVersion(u.id)).toBeGreaterThan(before)
  })

  test("bumping permissionVersion revokes outstanding JWTs (defense-in-depth, spec Amendment 1)", async () => {
    const sess = await minimal.adminSession((await createTestOrg()).id)
    const before = await app.request("/api/credits/balance", {
      headers: { authorization: `Bearer ${sess.bearer}`, accept: "application/json" },
    })
    expect(before.status).toBe(200)
    await minimal.grantScope(sess.userId, "kernel:files:read")
    const after = await app.request("/api/credits/balance", {
      headers: { authorization: `Bearer ${sess.bearer}`, accept: "application/json" },
    })
    expect(after.status).toBe(401)
  })
})
