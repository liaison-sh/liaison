// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `GET /api/connections/:app/:connection/accounts` (settings overhaul P2, plan
 * §R1 P2-11): the accounts an app's settings page lists. A member sees the
 * org's own accounts and their own personal ones, never another person's
 * personal account nor a disconnected one; each row carries the name it is
 * shown by (S7: never a bare numeric id), whose it is, its health and whether
 * the access renews, and no secret. An app the caller may not see answers 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { connectedAccounts, users } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { settingsFixtureApp } from "~/modules/apps/__fixtures__/settings-app/descriptor"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { connectionAccountLabel } from "~/modules/apps/connections/service"
import { registerApps } from "~/modules/apps/runtime"
import { signAccessToken } from "~/modules/auth/jwt"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { invalidateScopeCatalog } from "~/modules/permissions/scope-catalog"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

// An in-tree app; its users hold its read scope (the manifests list's rule).
const APP = "calendar"
const CONN = "google-calendar"

async function mintToken(userId: string): Promise<string> {
  const [row] = await withSystemDb("accounts-route-mint", (db) =>
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
  const perms = await withPrivilegedDb(row.orgId, "accounts-route-perms", (tx) =>
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

interface AccountRow {
  id: string
  identifier: string
  label: string | null
  ownerType: "org" | "user"
  isMine: boolean
  status: string
  hasRefreshToken: boolean
  connectedByName: string | null
  [k: string]: unknown
}

async function getAccounts(
  token: string,
  appName = APP,
  conn = CONN,
): Promise<{ status: number; rows: AccountRow[] }> {
  const res = await app.request(`/api/connections/${appName}/${conn}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = (await res.json()) as { data?: AccountRow[] }
  return { status: res.status, rows: body.data ?? [] }
}

describe("GET /api/connections/:app/:connection/accounts", () => {
  let orgId: string
  let memberId: string
  let memberToken: string
  let otherToken: string
  /** A member holding no calendar scope: calendar is not an app they see. */
  let outsiderToken: string
  let adminToken: string
  const ids: Record<string, string> = {}

  async function insert(
    key: string,
    row: {
      ownerType: "org" | "user"
      ownerId: string | null
      identifier: string
      displayName?: string | null
      status?: "active" | "error" | "disconnected"
      statusMessage?: string
      refresh?: boolean
      createdBy: string
    },
  ): Promise<void> {
    const [r] = await withPrivilegedDb(orgId, "accounts-route-seed", (tx) =>
      tx
        .insert(connectedAccounts)
        .values({
          orgId,
          appName: APP,
          connectionName: CONN,
          ownerType: row.ownerType,
          ownerId: row.ownerId,
          providerType: "oauth2",
          identifier: row.identifier,
          displayName: row.displayName ?? null,
          accessTokenEncrypted: encryptSecret(
            `access-${key}`,
            env.ENCRYPTION_KEY,
            CryptoContext.connectedAccountAccessToken,
          ),
          refreshTokenEncrypted: row.refresh
            ? encryptSecret(
                `refresh-${key}`,
                env.ENCRYPTION_KEY,
                CryptoContext.connectedAccountRefreshToken,
              )
            : null,
          status: row.status ?? "active",
          statusMessage: row.statusMessage ?? null,
          createdBy: row.createdBy,
        })
        .returning({ id: connectedAccounts.id }),
    )
    ids[key] = r.id
  }

  beforeAll(async () => {
    await acquireTestLock()
    orgId = (await createTestOrg()).id
    await registerApps([settingsFixtureApp], orgId)
    invalidateScopeCatalog(orgId)
    const admin = await minimal.person(orgId, { role: "admin" })
    const member = await minimal.person(orgId, { role: "member" })
    const other = await minimal.person(orgId, { role: "member" })
    const outsider = await minimal.person(orgId, { role: "member" })
    await minimal.grantScope(member.id, "calendar:events:read")
    await minimal.grantScope(other.id, "calendar:events:read")
    memberId = member.id
    memberToken = await mintToken(member.id)
    otherToken = await mintToken(other.id)
    outsiderToken = await mintToken(outsider.id)
    adminToken = await mintToken(admin.id)
    // A connection of the scoped fixture app, so only visibility can refuse it.
    connectionConfigRegistry.set([orgId, "settingsfx", "remote"], {
      type: "credentials",
      allowedDomains: [],
      credentialFields: [{ name: "token", label: "Token", type: "password", required: true }],
    })

    await insert("mine", {
      ownerType: "user",
      ownerId: member.id,
      identifier: "member@example.com",
      refresh: true,
      createdBy: member.id,
    })
    await insert("org", {
      ownerType: "org",
      ownerId: null,
      identifier: "102938475610",
      createdBy: admin.id,
    })
    await insert("orgNamed", {
      ownerType: "org",
      ownerId: null,
      identifier: "554433",
      displayName: "Team calendar",
      status: "error",
      statusMessage: "invalid_grant: token revoked by ops@example.com",
      createdBy: admin.id,
    })
    await insert("others", {
      ownerType: "user",
      ownerId: other.id,
      identifier: "other@example.com",
      createdBy: other.id,
    })
    await insert("gone", {
      ownerType: "user",
      ownerId: member.id,
      identifier: "old@example.com",
      status: "disconnected",
      createdBy: member.id,
    })
  }, 180_000)

  afterAll(async () => {
    await releaseTestLock()
  })

  test("a member sees their own personal account and the org's, never another person's", async () => {
    const r = await getAccounts(memberToken)
    expect(r.status).toBe(200)
    const got = new Set(r.rows.map((a) => a.id))
    expect(got).toEqual(new Set([ids.mine, ids.org, ids.orgNamed]))

    const mine = r.rows.find((a) => a.id === ids.mine)
    expect(mine).toMatchObject({
      ownerType: "user",
      isMine: true,
      status: "active",
      hasRefreshToken: true,
      label: "member@example.com",
    })
    const org = r.rows.find((a) => a.id === ids.org)
    expect(org).toMatchObject({ ownerType: "org", isMine: false, hasRefreshToken: false })
    // A bare numeric id is no name.
    expect(org?.label).toBeNull()
    expect(r.rows.find((a) => a.id === ids.orgNamed)).toMatchObject({
      label: "Team calendar",
      status: "error",
    })
  })

  test("the other member sees their own account and the org's, not the first member's", async () => {
    const r = await getAccounts(otherToken)
    expect(r.status).toBe(200)
    expect(new Set(r.rows.map((a) => a.id))).toEqual(new Set([ids.others, ids.org, ids.orgNamed]))
    expect(r.rows.some((a) => a.identifier === "member@example.com")).toBe(false)
  })

  // L1: an org account's error details and who connected it are for the holders
  // of the connection's admin scope; any other member gets its name and health.
  test("a member gets an org account's label and status only, an admin its details", async () => {
    const member = (await getAccounts(memberToken)).rows.find((a) => a.id === ids.orgNamed)
    expect(member).toMatchObject({ label: "Team calendar", status: "error", ownerType: "org" })
    expect(member?.statusMessage ?? null).toBeNull()
    expect(member?.connectedByName ?? null).toBeNull()
    expect(member?.identifier ?? "").not.toBe("554433")
    expect(JSON.stringify(member)).not.toContain("ops@example.com")
    // The member's own personal account keeps its details.
    const mine = (await getAccounts(memberToken)).rows.find((a) => a.id === ids.mine)
    expect(mine?.identifier).toBe("member@example.com")

    const admin = (await getAccounts(adminToken)).rows.find((a) => a.id === ids.orgNamed)
    expect(admin?.statusMessage).toBe("invalid_grant: token revoked by ops@example.com")
    expect(admin?.identifier).toBe("554433")
    expect(typeof admin?.connectedByName).toBe("string")
  })

  test("no row carries a token or credential", async () => {
    const r = await getAccounts(memberToken)
    const text = JSON.stringify(r.rows)
    expect(text).not.toContain("Encrypted")
    expect(text).not.toContain("access-")
    expect(text).not.toContain("refresh-")
  })

  test("an unknown connection or app answers 404", async () => {
    expect((await getAccounts(memberToken, APP, "nope")).status).toBe(404)
    expect((await getAccounts(memberToken, "no-such-app", CONN)).status).toBe(404)
  })

  test("an app the caller may not see answers 404", async () => {
    expect(memberId).toBeTruthy()
    expect((await getAccounts(memberToken, "settingsfx", "remote")).status).toBe(404)
    expect((await getAccounts(outsiderToken)).status).toBe(404)
  })
})

describe("connectionAccountLabel (S7)", () => {
  test("display name, else a readable identifier, never a bare number", () => {
    expect(connectionAccountLabel({ displayName: " Support ", identifier: "1" })).toBe("Support")
    expect(connectionAccountLabel({ displayName: null, identifier: "@liaison" })).toBe("@liaison")
    expect(connectionAccountLabel({ displayName: "", identifier: "123456" })).toBeNull()
  })

  test("never a UUID (the person's own id, stored when the provider named no account)", () => {
    const uuid = "fc420f33-800d-4c3e-9a51-0d6f1b2c3e4a"
    expect(connectionAccountLabel({ displayName: null, identifier: uuid })).toBeNull()
    expect(connectionAccountLabel({ displayName: "My channel", identifier: uuid })).toBe(
      "My channel",
    )
  })
})
