// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { deactivateUser, reactivateUser, UserAuthorityError } from "~/modules/users/service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

describe("deactivation respects authority", () => {
  let orgId: string
  let admin1: minimal.Session
  let admin2: minimal.Session
  let member: minimal.Session
  const MANAGER = ["kernel:users:admin"]

  const deactivate = (target: string, actor: string, actorScopes: string[]) =>
    withPrivilegedDb(orgId, "test-deactivate", (tx) =>
      deactivateUser(tx, { targetId: target, actorId: actor, orgId, actorScopes }),
    )

  beforeAll(async () => {
    await acquireTestLock()
    // A fresh org's bootstrap admin is its only wildcard holder.
    admin1 = await minimal.adminSession((await createTestOrg()).id)
    orgId = admin1.orgId
    member = await minimal.session(orgId, { role: "member" })
  })

  afterAll(async () => {
    await releaseTestLock()
  })

  it("a delegated user manager cannot deactivate or reactivate a wildcard admin", async () => {
    await expect(deactivate(admin1.userId, member.userId, MANAGER)).rejects.toBeInstanceOf(
      UserAuthorityError,
    )
    await expect(
      withPrivilegedDb(orgId, "test-reactivate", (tx) =>
        reactivateUser(tx, {
          targetId: admin1.userId,
          actorId: member.userId,
          orgId,
          actorScopes: MANAGER,
        }),
      ),
    ).rejects.toBeInstanceOf(UserAuthorityError)
    const [row] = await sql`SELECT status FROM kernel.users WHERE id = ${admin1.userId}`
    expect(row.status).toBe("active")
  })

  it("the last active admin cannot be deactivated, even by a wildcard caller", async () => {
    await expect(deactivate(admin1.userId, member.userId, ["*"])).rejects.toMatchObject({
      code: "LAST_ADMIN",
    })
  })

  it("with a second admin, an admin can deactivate the other; a manager can still deactivate a member", async () => {
    admin2 = await minimal.session(orgId, { role: "admin" })
    const done = await deactivate(admin2.userId, admin1.userId, ["*"])
    expect(done?.id).toBe(admin2.userId)
    // A manager whose own scopes cover a member's (the member grants plus
    // users:admin) may deactivate that member.
    const other = await minimal.session(orgId, { role: "member" })
    const { loadEffectivePermissions } = await import("~/modules/permissions/permissions")
    const memberScopes = (
      await withPrivilegedDb(orgId, "test-member-scopes", (tx) =>
        loadEffectivePermissions(tx, other.userId, orgId),
      )
    ).scopes
    const memberDone = await deactivate(other.userId, member.userId, [...memberScopes, ...MANAGER])
    expect(memberDone?.id).toBe(other.userId)
  })
})
