// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An organization's Google Drive connection shares only the shared drives an
// admin chose (drive-scope.ts), resolved from the connected account the lookup
// lands on: the agent tools through the Drive bridge and the Knowledge source
// registry read the org account with its chosen drives, a person's own account
// with their whole Drive. An org account made before shared drives existed
// reads nothing and raises an attention item for admins until they choose.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { sql } from "drizzle-orm"
import { createGoogleDriveBridgeExtension } from "~/apps/google-drive/bridge"
import { resolveDriveAccess } from "~/apps/google-drive/drive-access"
import {
  chooseSharedDrives,
  SharedDrivesError,
  sharedDrivesState,
} from "~/apps/google-drive/shared-drives"
import type { KnowledgeActor } from "~/apps/knowledge/service"
import { registerDefaultKnowledgeSources } from "~/apps/knowledge/source-registry"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withRlsContext } from "~/db/rls"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { OutboundFetchTestAccess } from "~/lib/outbound-fetch"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ADMIN_SCOPES = ["google-drive:accounts:admin", "google-drive:accounts:read"]
const MEMBER_SCOPES = ["google-drive:accounts:read"]

let orgId: string
let admin: string
let member: string

async function user(name: string): Promise<string> {
  const [u] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.users
        (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${name}-${Date.now()}@shared-drives.test`},
              ${name}, 'active', 'h', 1, 1)
      RETURNING id`),
  )
  return u!.id
}

async function driveAccount(
  owner: { type: "org" } | { type: "user"; id: string },
  identifier: string,
  token: string,
): Promise<string> {
  const ownerId = owner.type === "user" ? owner.id : null
  const [row] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
         access_token_encrypted, status, created_by, updated_at, metadata)
      VALUES (${orgId}::uuid, 'google-drive', 'drive', ${owner.type}, ${ownerId}::uuid, 'oauth2',
              ${identifier},
              ${encryptSecret(token, env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)},
              'active', ${admin}::uuid, now(),
              ${JSON.stringify({ grantedOAuthScopes: ["https://www.googleapis.com/auth/drive.readonly"] })}::jsonb)
      RETURNING id`),
  )
  return row!.id
}

const DOC = "text/plain"
/** Files by id: one in the connecting account's My Drive, one per shared drive. */
const FILES: Record<string, { name: string; driveId?: string }> = {
  mydrive01: { name: "personal notes" },
  teamfile1: { name: "team plan", driveId: "DRIVE_TEAM" },
  otherfil1: { name: "other plan", driveId: "DRIVE_OTHER" },
}

/** Google's answers; which token asked is recorded, so a test sees whose Drive was read. */
function fakeDrive(): Array<{ url: string; token: string }> {
  const calls: Array<{ url: string; token: string }> = []
  OutboundFetchTestAccess.setFetch((async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const auth = new Headers(init?.headers).get("authorization") ?? ""
    calls.push({ url: url.toString(), token: auth.replace("Bearer ", "") })
    const path = url.pathname.replace(/^.*\/drive\/v3/, "")
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } })
    if (path === "/drives") {
      return json({
        drives: [
          { id: "DRIVE_TEAM", name: "Team" },
          { id: "DRIVE_OTHER", name: "Other" },
        ],
      })
    }
    if (path === "/files") {
      const driveId = url.searchParams.get("driveId")
      return json({
        files: Object.entries(FILES)
          .filter(([, f]) => !driveId || f.driveId === driveId)
          .map(([id, f]) => ({ id, name: f.name, mimeType: DOC, driveId: f.driveId })),
      })
    }
    const id = /^\/files\/([^/?]+)/.exec(path)?.[1] ?? ""
    const f = FILES[id]
    if (!f) return new Response("{}", { status: 404 })
    if (url.searchParams.get("alt") === "media") return new Response(`text of ${id}`)
    return json({
      id,
      name: f.name,
      mimeType: DOC,
      driveId: f.driveId,
      capabilities: { canDownload: true },
    })
  }) as never)
  return calls
}

function asUser(userId: string, scopes: string[]) {
  return { actorType: "user" as const, orgId, userId, scopes, dimensionGrants: {} }
}

async function bridgeRead(userId: string, scopes: string[], driveFileId: string) {
  return withRlsContext(asUser(userId, scopes), async (tx) => {
    const bridge = createGoogleDriveBridgeExtension({
      appName: "google-drive",
      orgId,
      userId,
      txDb: tx,
      actorType: "user",
      callerScopes: scopes,
    })
    return JSON.parse(await bridge.drive_read!(JSON.stringify({ driveFileId })))
  })
}

beforeAll(async () => {
  await acquireTestLock()
  const [org] = extractRows<{ id: string }>(
    await db.execute(sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'SharedDrives', ${`shared-drives-${Date.now()}`})
      RETURNING id`),
  )
  orgId = org!.id
  admin = await user("admin")
  member = await user("member")
  // An org connection made before shared drives existed: nothing chosen.
  await driveAccount({ type: "org" }, "ops@acme.example", "org-token")
})

afterEach(() => OutboundFetchTestAccess.setFetch(null))

afterAll(async () => {
  await db.execute(sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}::uuid`)
  await releaseTestLock()
})

describe("an organization's Drive connection", () => {
  it("made before shared drives: reads nothing, and its admins are told to pick", async () => {
    const access = await withRlsContext(asUser(member, MEMBER_SCOPES), (tx) =>
      resolveDriveAccess(tx, orgId, member),
    )
    expect(access.ownerType).toBe("org")
    expect(access.readScope).toEqual({ kind: "sharedDrives", drives: [] })

    const calls = fakeDrive()
    const read = await bridgeRead(member, MEMBER_SCOPES, "mydrive01")
    expect(read).toMatchObject({ error: { code: "shared_drives_not_chosen" } })
    expect(calls).toEqual([])

    const state = await sharedDrivesState({ orgId, userId: member, scopes: MEMBER_SCOPES })
    expect(state).toMatchObject({ canManage: false, accounts: [{ needsSharedDrives: true }] })
  })

  it("a member without the Drive read scope does not see the organization's connections", async () => {
    await expect(sharedDrivesState({ orgId, userId: member, scopes: [] })).rejects.toMatchObject({
      code: "forbidden",
    })
  })

  it("only an admin chooses, and only drives the connecting account is a member of", async () => {
    fakeDrive()
    await expect(
      chooseSharedDrives({ orgId, userId: member, scopes: MEMBER_SCOPES }, {}, ["Team"]),
    ).rejects.toBeInstanceOf(SharedDrivesError)
    await expect(
      chooseSharedDrives({ orgId, userId: admin, scopes: ADMIN_SCOPES }, {}, ["Finance"]),
    ).rejects.toMatchObject({ code: "not_a_member" })
    const chosen = await chooseSharedDrives({ orgId, userId: admin, scopes: ADMIN_SCOPES }, {}, [
      "team",
    ])
    expect(chosen).toMatchObject({
      changed: true,
      account: { sharedDrives: [{ id: "DRIVE_TEAM", name: "Team" }], needsSharedDrives: false },
    })
  })

  it("with a drive chosen: the agent reads that drive, never My Drive or another drive", async () => {
    fakeDrive()
    expect(await bridgeRead(member, MEMBER_SCOPES, "teamfile1")).toMatchObject({
      content: "text of teamfile1",
    })
    for (const id of ["mydrive01", "otherfil1"]) {
      expect(await bridgeRead(member, MEMBER_SCOPES, id)).toMatchObject({
        error: { code: "outside_shared_drives" },
      })
    }
  })

  it("the Knowledge source registry lists only the chosen drive through the org connection", async () => {
    fakeDrive()
    const items = await withRlsContext(asUser(member, MEMBER_SCOPES), async (tx) => {
      const registry = registerDefaultKnowledgeSources({
        tx,
        orgId,
        userId: member,
        scopes: MEMBER_SCOPES,
      })
      const [drive] = registry.listEnabled({} as KnowledgeActor)
      const content = await drive!.fetchRemoteContent?.(
        { sourceEntityId: "mydrive01" },
        {} as KnowledgeActor,
        "sync",
      )
      expect(content).toEqual({ status: "unavailable" })
      return (await drive!.listFolder?.({ folderRef: "root0000" }, {} as KnowledgeActor))?.items
    })
    expect(items?.map((i) => i.externalId)).toEqual(["teamfile1"])
  })

  it("a person's own Drive connection still reads their own My Drive", async () => {
    await driveAccount({ type: "user", id: admin }, "admin@acme.example", "admin-token")
    const calls = fakeDrive()
    expect(await bridgeRead(admin, ADMIN_SCOPES, "mydrive01")).toMatchObject({
      content: "text of mydrive01",
    })
    expect(calls.every((c) => c.token === "admin-token")).toBe(true)
  })
})
