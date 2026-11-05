// SPDX-License-Identifier: FSL-1.1-ALv2
// The Mail settings page's mailbox types toggle (settings overhaul P2 T8): the
// `gmail` field reads and writes through the providers.get / providers.set
// tools, which carry the scopes of GET / PATCH /api/mail/providers. A member
// is refused by the route and by the tool itself (S17); a mail admin turns
// Gmail on, and the Google client stays kernel:org:admin (P2-12, no widening).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { listMailProviders } from "~/modules/mail/provider-settings"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

async function mintToken(userId: string): Promise<string> {
  const [row] = await withSystemDb("mail-settings-mint", (db) =>
    db
      .select({
        orgId: users.orgId,
        name: users.name,
        authVersion: users.authVersion,
        permissionVersion: users.permissionVersion,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  )
  if (!row) throw new Error(`mintToken: user ${userId} missing`)
  const perms = await withPrivilegedDb(row.orgId, "mail-settings-perms", (tx) =>
    loadEffectivePermissions(tx, userId, row.orgId),
  )
  return signAccessToken(
    {
      userId,
      orgId: row.orgId,
      name: row.name,
      authVersion: row.authVersion,
      permissionVersion: row.permissionVersion,
      roles: perms.roles,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants,
    },
    env.JWT_SECRET,
    60 * 60,
  )
}

async function request(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json()) as any }
}

describe("Mail settings page: mailbox types and the Google client", () => {
  let orgId: string
  let memberToken: string
  let mailAdminToken: string

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    const member = await minimal.person(orgId, { role: "member" })
    memberToken = await mintToken(member.id)
    const lead = await minimal.person(orgId, { role: "member" })
    // A mail admin reads the mailboxes too (GET /api/mail/providers needs
    // mail:accounts:read, which mail:accounts:admin does not imply).
    await minimal.grantScope(lead.id, "mail:accounts:read")
    await minimal.grantScope(lead.id, "mail:accounts:admin")
    mailAdminToken = await mintToken(lead.id)
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  test("a member: no mailbox-type value on read, the write refused by the route and by the tool", async () => {
    const read = await request(memberToken, "GET", "/api/apps/mail/settings/org")
    expect(read.status).toBe(200)
    expect(read.body.data.values.gmail).toBeUndefined()
    const write = await request(memberToken, "PATCH", "/api/apps/mail/settings/org", {
      path: "gmail",
      value: true,
    })
    expect(write.status).toBe(403)
    const tool = await request(memberToken, "POST", "/api/apps/run-tool", {
      toolName: "mail:providers.set",
      params: { gmail: true },
    })
    expect(tool.status).toBe(403)
    expect((await listMailProviders(orgId))[0]?.enabled).toBe(false)
  })

  test("a mail admin turns Gmail on through the toggle; it reads back and the REST view agrees", async () => {
    const before = await request(mailAdminToken, "GET", "/api/apps/mail/settings/org")
    expect(before.body.data.errors).toBeUndefined()
    expect(before.body.data.values.gmail).toBe(false)
    const write = await request(mailAdminToken, "PATCH", "/api/apps/mail/settings/org", {
      path: "gmail",
      value: true,
    })
    expect(write.status).toBe(200)
    const after = await request(mailAdminToken, "GET", "/api/apps/mail/settings/org")
    expect(after.body.data.values.gmail).toBe(true)
    const rest = await request(mailAdminToken, "GET", "/api/mail/providers")
    expect(rest.body.data[0]).toMatchObject({ id: "gmail", enabled: true })
  })

  test("a mail admin alone cannot set the workspace's Google client (kernel:org:admin)", async () => {
    const res = await request(mailAdminToken, "PATCH", "/api/settings/integrations/google", {
      clientId: "123456789-orgtest.apps.googleusercontent.com",
      clientSecret: "google-client-secret",
    })
    expect(res.status).toBe(403)
  })
})
