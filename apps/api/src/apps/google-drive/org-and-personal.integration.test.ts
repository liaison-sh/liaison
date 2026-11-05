// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One Google account, two Drive connections: the organization's (it reads only
// the Shared Drives an admin chose) and the same person's own (their My Drive).
// The Drive connection declares `orgAndPersonalCoexist`, so a personal connect
// of the account the org holds stores a second row instead of being refused,
// and each row keeps its own tokens and reads only its own scope, through the
// REAL callback (handleOAuthCallback) and the real read paths (the agent's
// Drive bridge, the Knowledge sync's source lookup). Another member still
// cannot connect that account as their own.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import driveManifest from "~/apps/google-drive/app.manifest.json"
import { createGoogleDriveBridgeExtension } from "~/apps/google-drive/bridge"
import { resolveDriveAccess } from "~/apps/google-drive/drive-access"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { redis } from "~/lib/redis"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import {
  ConnectionHeldByOtherOwnerError,
  handleOAuthCallback,
} from "~/modules/apps/connections/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ACCOUNT = "ops@acme.example"
const SCOPES = ["google-drive:accounts:read"]

let orgId: string
let alice: string
let bob: string
let tokenServer: ReturnType<typeof Bun.serve> | null = null
let tokenUrl: string
let nextAccessToken = ""

async function user(name: string): Promise<string> {
  const [u] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${name}-${randomUUID()}@org-personal.test`},
              ${name}, 'active', 'h', 1, 1)
      RETURNING id`),
  )
  return u!.id
}

function idToken(email: string): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${part({ alg: "none" })}.${part({ email })}.sig`
}

/** A callback state, as startOAuthFlow stores it, for `owner` connecting the account. */
async function state(owner: { type: "org" } | { type: "user"; id: string }, by: string) {
  const s = randomUUID()
  await redis.set(
    `oauth:state:${s}`,
    JSON.stringify({
      orgId,
      userId: by,
      appName: "google-drive",
      connectionName: "drive",
      codeVerifier: "unused-verifier",
      tokenUrl,
      ownerType: owner.type,
      ownerId: owner.type === "user" ? owner.id : null,
    }),
    "EX",
    900,
  )
  return s
}

async function driveRows() {
  return extractRows<{
    id: string
    owner_type: string
    owner_id: string | null
    status: string
    access_token_encrypted: string | null
    metadata: Record<string, unknown> | null
  }>(
    await db.execute(sql`SELECT id, owner_type, owner_id::text AS owner_id, status,
        access_token_encrypted, metadata
      FROM kernel.connected_accounts
      WHERE org_id = ${orgId}::uuid AND app_name = 'google-drive' AND identifier = ${ACCOUNT}
      ORDER BY created_at`),
  )
}

const tokenOf = (row: { access_token_encrypted: string | null }) =>
  decryptSecret(
    row.access_token_encrypted!,
    env.ENCRYPTION_KEY,
    CryptoContext.connectedAccountAccessToken,
  )

const DOC = "text/plain"
const FILES: Record<string, { name: string; driveId?: string }> = {
  mydrive01: { name: "my notes" },
  teamfile1: { name: "team plan", driveId: "DRIVE_TEAM" },
}

/** Google Drive's answers; records which token asked. */
function fakeDrive(): string[] {
  const tokens: string[] = []
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    tokens.push((new Headers(init?.headers).get("authorization") ?? "").replace("Bearer ", ""))
    const id = /\/files\/([^/?]+)/.exec(url.pathname)?.[1] ?? ""
    const f = FILES[id]
    if (!f) return new Response("{}", { status: 404 })
    if (url.searchParams.get("alt") === "media") return new Response(`text of ${id}`)
    return new Response(
      JSON.stringify({
        id,
        name: f.name,
        mimeType: DOC,
        driveId: f.driveId,
        capabilities: { canDownload: true },
      }),
      { headers: { "content-type": "application/json" } },
    )
  }) as never)
  return tokens
}

async function bridgeRead(userId: string, driveFileId: string) {
  return withRlsContext(
    { actorType: "user" as const, orgId, userId, scopes: SCOPES, dimensionGrants: {} },
    async (tx) => {
      const bridge = createGoogleDriveBridgeExtension({
        appName: "google-drive",
        orgId,
        userId,
        txDb: tx,
        actorType: "user",
        callerScopes: SCOPES,
      })
      return JSON.parse(await bridge.drive_read!(JSON.stringify({ driveFileId })))
    },
  )
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'OrgAndPersonalDrive', ${`org-personal-${randomUUID()}`})
      RETURNING id`),
  )
  orgId = org!.id
  alice = await user("alice")
  bob = await user("bob")
  await db.execute(sql`INSERT INTO kernel.apps (org_id, name, version)
    VALUES (${orgId}::uuid, 'google-drive', ${driveManifest.version}) ON CONFLICT DO NOTHING`)
  await db.insert(oauthProviders).values({
    orgId,
    name: "google-drive:drive",
    issuerUrl: "https://app-connection.invalid/google-drive:drive",
    clientId: "drive-client",
    clientSecretEncrypted: encryptSecret(
      "drive-secret",
      env.ENCRYPTION_KEY,
      CryptoContext.oauthProviderClientSecret,
    ),
  })
  tokenServer = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        JSON.stringify({
          access_token: nextAccessToken,
          refresh_token: `refresh-${nextAccessToken}`,
          expires_in: 3600,
          id_token: idToken(ACCOUNT),
          scope: "openid email https://www.googleapis.com/auth/drive.readonly",
        }),
        { headers: { "content-type": "application/json" } },
      ),
  })
  tokenUrl = `http://127.0.0.1:${tokenServer.port}/token`
  // The shipped manifest's connection, as the runtime registers it.
  connectionConfigRegistry.set(
    [orgId, "google-drive", "drive"],
    driveManifest.connections.drive as never,
  )
  // The org's connection of the account, with one shared drive chosen.
  await db.execute(sql`INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
       access_token_encrypted, status, created_by, metadata)
    VALUES (${orgId}::uuid, 'google-drive', 'drive', 'org', NULL, 'oauth2', ${ACCOUNT},
            ${encryptSecret("org-token", env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)},
            'active', ${alice}::uuid,
            ${JSON.stringify({
              grantedOAuthScopes: ["https://www.googleapis.com/auth/drive.readonly"],
              sharedDrives: [{ id: "DRIVE_TEAM", name: "Team" }],
            })}::jsonb)`)
})

afterEach(() => OutboundFetchTestAccess.setFetch(null))

afterAll(async () => {
  tokenServer?.stop(true)
  connectionConfigRegistry.deleteByPrefix([orgId])
  await db.execute(sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}::uuid`)
  await db.execute(sql`DELETE FROM kernel.oauth_providers WHERE org_id = ${orgId}::uuid`)
  await releaseTestLock()
})

describe("one Google account connected for the organization and as a member's own Drive", () => {
  it("the declared knob is on for Drive only (mail, calendar and tickets keep one owner)", () => {
    expect(driveManifest.connections.drive.orgAndPersonalCoexist).toBe(true)
  })

  it("a personal connect of the account the org holds adds a second row; the org's is untouched", async () => {
    nextAccessToken = "alice-personal-token"
    await handleOAuthCallback("code-personal", await state({ type: "user", id: alice }, alice))

    const rows = (await driveRows()).filter((r) => r.status === "active")
    expect(rows.map((r) => [r.owner_type, r.owner_id])).toEqual([
      ["org", null],
      ["user", alice],
    ])
    const [orgRow, personal] = rows
    expect(tokenOf(orgRow!)).toBe("org-token")
    expect(orgRow!.metadata).toMatchObject({ sharedDrives: [{ id: "DRIVE_TEAM" }] })
    expect(tokenOf(personal!)).toBe("alice-personal-token")
    // The org's chosen drives never follow the account into the personal row.
    expect(personal!.metadata?.sharedDrives).toBeUndefined()
  })

  it("each row reads only its own scope: the person their My Drive, everyone else the chosen drive", async () => {
    // Alice's agent reads through her own row, with her own token.
    let tokens = fakeDrive()
    expect(await bridgeRead(alice, "mydrive01")).toMatchObject({ content: "text of mydrive01" })
    expect(new Set(tokens)).toEqual(new Set(["alice-personal-token"]))

    // Bob has no Drive of his own: the org's row, which never reads My Drive.
    tokens = fakeDrive()
    expect(await bridgeRead(bob, "mydrive01")).toMatchObject({
      error: { code: "outside_shared_drives" },
    })
    expect(await bridgeRead(bob, "teamfile1")).toMatchObject({ content: "text of teamfile1" })
    expect(new Set(tokens)).toEqual(new Set(["org-token"]))

    // A Knowledge sync reads through the row of its source's kind.
    const viaSource = (owner: Parameters<typeof resolveDriveAccess>[3]) =>
      resolveDriveAccess(db as never, orgId, alice, owner)
    const orgSource = await viaSource({
      identifier: ACCOUNT,
      sourceOwner: { kind: "org", creatorId: alice },
    })
    expect(orgSource.ownerType).toBe("org")
    expect(orgSource.token).toBe("org-token")
    expect(orgSource.readScope).toEqual({
      kind: "sharedDrives",
      drives: [{ id: "DRIVE_TEAM", name: "Team" }],
    })
    const personalSource = await viaSource({
      identifier: ACCOUNT,
      sourceOwner: { kind: "user", userId: alice },
    })
    expect(personalSource.ownerType).toBe("user")
    expect(personalSource.token).toBe("alice-personal-token")
    expect(personalSource.readScope).toEqual({ kind: "all" })
    // Bob's personal folder from this account never reads Alice's own row.
    const bobSource = await viaSource({
      identifier: ACCOUNT,
      sourceOwner: { kind: "user", userId: bob },
    })
    expect(bobSource.ownerType).toBe("org")
  })

  it("an org reconnect replaces only the org's row, and the personal row keeps its tokens", async () => {
    const before = (await driveRows()).filter((r) => r.status === "active")
    nextAccessToken = "org-token-2"
    await handleOAuthCallback("code-org", await state({ type: "org" }, alice))

    const rows = await driveRows()
    const active = rows.filter((r) => r.status === "active")
    expect(active.map((r) => r.owner_type).sort()).toEqual(["org", "user"])
    const personal = active.find((r) => r.owner_type === "user")!
    expect(personal.id).toBe(before.find((r) => r.owner_type === "user")!.id)
    expect(tokenOf(personal)).toBe("alice-personal-token")
    const orgRow = active.find((r) => r.owner_type === "org")!
    expect(tokenOf(orgRow)).toBe("org-token-2")
    // A reconnect of the org's account keeps sharing the same drives, never more.
    expect(orgRow.metadata).toMatchObject({ sharedDrives: [{ id: "DRIVE_TEAM" }] })
  })

  it("another member's personal connect of that account is still refused", async () => {
    nextAccessToken = "bob-token"
    const err = await handleOAuthCallback(
      "code-bob",
      await state({ type: "user", id: bob }, bob),
    ).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectionHeldByOtherOwnerError)
    expect((err as ConnectionHeldByOtherOwnerError).heldBy).toBe("user")
    const active = (await driveRows()).filter((r) => r.status === "active")
    expect(active.some((r) => r.owner_id === bob)).toBe(false)
  })
})
