// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A password change, a password reset or a deactivation ends the person's push
// delivery: phone tokens removed, browser Web Push endpoints cleared, receipt
// credentials revoked. A push body carries a message preview, so a device
// someone else registered while they had the account must stop receiving them.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { passwordResets } from "~/db/schema/kernel"
import { generateToken, hashPassword, hashToken } from "~/lib/crypto"
import { changePassword } from "~/modules/auth/auth"
import { deactivateUser } from "~/modules/users/service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let admin: minimal.Session
let member: minimal.Session
let bystander: minimal.Session

beforeAll(async () => {
  await acquireTestLock()
  admin = await minimal.adminSession((await createTestOrg()).id)
  member = await minimal.session(admin.orgId, { role: "member" })
  bystander = await minimal.session(admin.orgId, { role: "member" })
  const hash = await hashPassword("old-password-123")
  await withSystemDb("test-push-pw-set", (db) =>
    db.execute(
      drizzleSql`UPDATE kernel.users SET password_hash = ${hash} WHERE id = ${member.userId}::uuid`,
    ),
  )
})

afterAll(async () => {
  await releaseTestLock()
})

/** One phone token, one browser endpoint and one receipt credential for `userId`. */
async function registerDevices(userId: string, tag: string) {
  const orgId = admin.orgId
  await withSystemDb("test-push-register", async (db) => {
    await db.execute(drizzleSql`
      INSERT INTO kernel.push_tokens (org_id, user_id, platform, token)
      VALUES (${orgId}::uuid, ${userId}::uuid, 'ios', ${`tok-${tag}-${userId}`})`)
    await db.execute(drizzleSql`
      INSERT INTO kernel.browser_push_subscriptions (org_id, user_id, device_id, endpoint, p256dh, auth)
      VALUES (${orgId}::uuid, ${userId}::uuid, ${`b-${tag}`},
              ${`https://push.example.test/${tag}-${userId}`}, 'k', 'a')`)
    await db.execute(drizzleSql`
      INSERT INTO kernel.notification_device_credentials
        (org_id, user_id, device_id, surface, token_hash, server_origin)
      VALUES (${orgId}::uuid, ${userId}::uuid, ${`b-${tag}`}, 'browser',
              ${hashToken(generateToken())}, 'http://localhost')`)
  })
}

async function deliveryOf(userId: string) {
  const [row] = (await withSystemDb("test-push-count", (db) =>
    db.execute(drizzleSql`
      SELECT
        (SELECT count(*)::int FROM kernel.push_tokens WHERE user_id = ${userId}::uuid) AS phones,
        (SELECT count(*)::int FROM kernel.browser_push_subscriptions
          WHERE user_id = ${userId}::uuid AND endpoint IS NOT NULL) AS browsers,
        (SELECT count(*)::int FROM kernel.notification_device_credentials
          WHERE user_id = ${userId}::uuid AND revoked_at IS NULL) AS credentials`),
  )) as unknown as Array<{ phones: number; browsers: number; credentials: number }>
  return { phones: row.phones, browsers: row.browsers, credentials: row.credentials }
}

const NONE = { phones: 0, browsers: 0, credentials: 0 }

describe("ending a person's credentials ends their push delivery", () => {
  it("a password change removes every phone token and browser endpoint of the person only", async () => {
    await registerDevices(member.userId, "change")
    await registerDevices(bystander.userId, "change")
    expect(await deliveryOf(member.userId)).toEqual({ phones: 1, browsers: 1, credentials: 1 })

    await changePassword(member.userId, "old-password-123", "new-password-456")

    const after = await deliveryOf(member.userId)
    console.log("after password change:", after)
    expect(after).toEqual(NONE)
    expect(await deliveryOf(bystander.userId)).toEqual({ phones: 1, browsers: 1, credentials: 1 })
  })

  it("a password reset removes every phone token and browser endpoint", async () => {
    await registerDevices(member.userId, "reset")
    const token = generateToken()
    await withSystemDb("test-push-pw-reset", (db) =>
      db.insert(passwordResets).values({
        userId: member.userId,
        orgId: admin.orgId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    )
    const res = await app.request("/api/auth/password-reset/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, newPassword: "Reset-Password-789" }),
    })
    expect(res.status).toBe(200)

    const after = await deliveryOf(member.userId)
    console.log("after password reset:", after)
    expect(after).toEqual(NONE)
  })

  it("a deactivation removes every phone token and browser endpoint", async () => {
    await registerDevices(member.userId, "deactivate")
    await withPrivilegedDb(admin.orgId, "test-push-deactivate", (tx) =>
      deactivateUser(tx, {
        targetId: member.userId,
        actorId: admin.userId,
        orgId: admin.orgId,
        actorScopes: ["*"],
      }),
    )
    const after = await deliveryOf(member.userId)
    console.log("after deactivation:", after)
    expect(after).toEqual(NONE)
  })
})
