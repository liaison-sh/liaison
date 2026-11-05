// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A password change or reset ends the person's MCP connections.
//
// An MCP connection is a standing credential of the person (refresh token
// `<connId>.<secret>`, 15-minute access tokens with the person's scopes). Whoever
// held the account for a while can consent one to their own client. The owner
// then changes or resets the password, which ends every sign-in session; the
// connection must end with them: its live access token refused at once and its
// refresh token unable to mint. A connection made after the change works.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { passwordResets } from "~/db/schema/kernel"
import { generateToken, hashPassword, hashToken } from "~/lib/crypto"
import { changePassword } from "~/modules/auth/auth"
import { invalidateAuthCache } from "~/modules/auth/auth-state"
import {
  createMcpConnection,
  mintAccessToken,
  refreshAccessToken,
  resolveConnectionFromToken,
} from "~/modules/mcp/connection-service"
import { cleanupSeededOrg, grantScope, seedOrgWithUser } from "~/modules/mcp/test-helpers"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let userId = ""

beforeAll(async () => {
  await acquireTestLock()
  ;({ orgId, userId } = await seedOrgWithUser())
  await grantScope(orgId, userId, "kernel:threads:read")
  const hash = await hashPassword("old-password-123")
  await withSystemDb("test-mcp-pw-set", (db) =>
    db.execute(
      drizzleSql`UPDATE kernel.users SET password_hash = ${hash} WHERE id = ${userId}::uuid`,
    ),
  )
})

afterAll(async () => {
  await cleanupSeededOrg(orgId)
  await releaseTestLock()
})

async function openConnection(label: string) {
  const conn = await createMcpConnection({ orgId, userId, clientId: "some-client", label })
  const { token } = await mintAccessToken(conn.connection.id)
  return { refreshToken: conn.refreshToken, token }
}

async function outcome(conn: { refreshToken: string; token: string }) {
  const access = await resolveConnectionFromToken(conn.token).then(
    () => "accepted",
    (err: Error) => `refused: ${err.message}`,
  )
  const refresh = await refreshAccessToken(conn.refreshToken).then(
    () => "minted",
    (err: Error) => `refused: ${err.message}`,
  )
  return { access, refresh }
}

describe("a password change or reset ends the person's MCP connections", () => {
  it("a password change refuses the old access token and refresh token; a later connection works", async () => {
    const before = await openConnection("before the change")

    await changePassword(userId, "old-password-123", "new-password-456")

    const after = await outcome(before)
    console.log("after password change:", after)
    expect(after.access).toStartWith("refused")
    expect(after.refresh).toStartWith("refused")

    const fresh = await outcome(await openConnection("after the change"))
    expect(fresh).toEqual({ access: "accepted", refresh: "minted" })
  })

  it("a password reset refuses the old access token and refresh token; a later connection works", async () => {
    const before = await openConnection("before the reset")

    const token = generateToken()
    await withSystemDb("test-mcp-pw-reset", (db) =>
      db.insert(passwordResets).values({
        userId,
        orgId,
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

    const after = await outcome(before)
    console.log("after password reset:", after)
    expect(after.access).toStartWith("refused")
    expect(after.refresh).toStartWith("refused")

    const fresh = await outcome(await openConnection("after the reset"))
    expect(fresh).toEqual({ access: "accepted", refresh: "minted" })
  })

  it("an access token minted before any credential change is refused; the connection refreshes", async () => {
    const conn = await openConnection("across a second-factor change")
    // A credential change that keeps connections (turning a second factor off)
    // still bumps the auth version: tokens minted before it stop resolving.
    await withSystemDb("test-mcp-auth-bump", (db) =>
      db.execute(
        drizzleSql`UPDATE kernel.users SET auth_version = auth_version + 1 WHERE id = ${userId}::uuid`,
      ),
    )
    invalidateAuthCache(userId)
    expect(await outcome(conn)).toEqual({
      access: "refused: mcp token predates a credential change",
      refresh: "minted",
    })
  })
})
