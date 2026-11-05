// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Restricted scopes in a real authorize URL: the Drive mode is decided from the
// address being connected (the connect's account hint, sent on as login_hint),
// and a reconnect keeps drive.readonly only for the ACTIVE account with that
// same address, never another account or a disconnected row.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { connectedAccounts } from "~/db/schema/kernel"
import { env } from "~/lib/env"
import { connectionConfigRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { startOAuthFlow } from "~/modules/apps/connections/service"

const READ = "https://www.googleapis.com/auth/drive.readonly"
const FILE = "https://www.googleapis.com/auth/drive.file"

type DriveVars = {
  GOOGLE_DRIVE_OAUTH_CLIENT_ID?: string
  GOOGLE_DRIVE_OAUTH_CLIENT_SECRET?: string
  GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED?: boolean
}
const mutableEnv = env as DriveVars
const saved: DriveVars = { ...mutableEnv }

let orgId: string
let userId: string

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Restricted scopes org', ${`restricted-${suffix}`})
      RETURNING id`),
  )
  orgId = org!.id
  // A personal sign-in address: no DNS lookup decides it.
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`restricted-${suffix}@gmail.com`}, 'Ana', 'active', 'hash', 1, 1)
      RETURNING id`),
  )
  userId = user!.id
  mutableEnv.GOOGLE_DRIVE_OAUTH_CLIENT_ID = "instance-drive.apps.googleusercontent.com"
  mutableEnv.GOOGLE_DRIVE_OAUTH_CLIENT_SECRET = "instance-drive-secret"
  mutableEnv.GOOGLE_OAUTH_RESTRICTED_SCOPES_VERIFIED = false
  connectionConfigRegistry.set([orgId, "google-drive", "drive"], {
    type: "oauth2",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", READ, FILE],
    restrictedScopes: [READ],
    allowedDomains: [],
  })
})

afterAll(async () => {
  Object.assign(mutableEnv, saved)
  resetAppRegistries()
  await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}::uuid`)
})

async function account(identifier: string, granted: string[], status = "active") {
  await db.execute(drizzleSql`INSERT INTO kernel.connected_accounts
      (org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier,
       status, created_by, updated_at, metadata)
    VALUES (${orgId}::uuid, 'google-drive', 'drive', 'user', ${userId}::uuid, 'oauth2',
            ${identifier}, ${status}, ${userId}::uuid, now(),
            ${JSON.stringify({ grantedOAuthScopes: granted })}::jsonb)`)
}

async function authorize(accountHint?: string) {
  const url = new URL(
    await startOAuthFlow(orgId, userId, "google-drive", "drive", {
      ownerType: "user",
      ...(accountHint ? { accountHint } : {}),
    }),
  )
  return {
    scopes: (url.searchParams.get("scope") ?? "").split(" "),
    hint: url.searchParams.get("login_hint"),
  }
}

describe("restricted scopes follow the account being connected", () => {
  it("a personal address on the unverified instance client asks for drive.file only, on that account", async () => {
    const plain = await authorize()
    expect(plain.scopes).toContain(FILE)
    expect(plain.scopes).not.toContain(READ)
    expect(plain.hint).toBeNull()

    const hinted = await authorize("Ana.Other@gmail.com")
    expect(hinted.scopes).not.toContain(READ)
    expect(hinted.hint).toBe("ana.other@gmail.com")
  })

  it("another account's full grant, or a disconnected row, never brings drive.readonly back", async () => {
    await account("full-elsewhere@gmail.com", [READ, FILE])
    await account("was-full@gmail.com", [READ, FILE], "disconnected")
    expect((await authorize("new-one@gmail.com")).scopes).not.toContain(READ)
    expect((await authorize("was-full@gmail.com")).scopes).not.toContain(READ)
    expect((await authorize()).scopes).not.toContain(READ)
  })

  it("reconnecting the same active account that holds drive.readonly keeps it", async () => {
    await account("kept-full@gmail.com", [READ, FILE])
    expect((await authorize("kept-full@gmail.com")).scopes).toContain(READ)
  })
})
