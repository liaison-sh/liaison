// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Provider-side revocation on disconnect: a connection declaring `revocationUrl`
// has its grant revoked (refresh token POSTed, RFC 7009) and its tokens deleted;
// a provider failure never blocks the disconnect; a grant another active
// connection of the org still uses (same account, same endpoint) is kept.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { connectionConfigRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import {
  revokeConnectionGrant,
  revokeOnDisconnectEvent,
  runConnectionTeardown,
} from "~/modules/apps/connections/revoke"
import { disconnectConnection } from "~/modules/apps/connections/service"

let orgId: string
let userId: string
let server: ReturnType<typeof Bun.serve> | null = null
let revokeUrl: string
let replyStatus = 200
let replyBody = "{}"
const received: Array<Record<string, string>> = []

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Revoke On Disconnect Org', ${`revoke-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`revoke-${suffix}@test.com`}, 'Owner', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user.id
  server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      received.push(Object.fromEntries(new URLSearchParams(await req.text())))
      return new Response(replyBody, {
        status: replyStatus,
        headers: { "content-type": "application/json" },
      })
    },
  })
  revokeUrl = `http://localhost:${server.port}/revoke`
})

afterEach(() => {
  received.length = 0
  replyStatus = 200
  replyBody = "{}"
  resetAppRegistries()
})

afterAll(async () => {
  server?.stop(true)
  await db.execute(drizzleSql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}`)
})

function declare(appName: string, connectionName: string, withRevocation = true): void {
  connectionConfigRegistry.set([orgId, appName, connectionName], {
    type: "oauth2",
    allowedDomains: [],
    tokenUrl: "https://oauth2.example.test/token",
    ...(withRevocation ? { revocationUrl: revokeUrl } : {}),
  })
}

async function insertConnection(opts: {
  appName: string
  connectionName: string
  identifier: string
  refreshToken?: string | null
}): Promise<string> {
  const [row] = await db
    .insert(connectedAccounts)
    .values({
      orgId,
      appName: opts.appName,
      connectionName: opts.connectionName,
      ownerType: "user",
      ownerId: userId,
      providerType: "oauth2",
      identifier: opts.identifier,
      accessTokenEncrypted: encryptSecret(
        "access-token",
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountAccessToken,
      ),
      refreshTokenEncrypted:
        opts.refreshToken === null
          ? null
          : encryptSecret(
              opts.refreshToken ?? "refresh-token",
              env.ENCRYPTION_KEY,
              CryptoContext.connectedAccountRefreshToken,
            ),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      status: "active",
      createdBy: userId,
    })
    .returning({ id: connectedAccounts.id })
  return row.id
}

async function disconnect(id: string): Promise<void> {
  await withPrivilegedDb(orgId, "revoke-test", (tx) => disconnectConnection(tx, orgId, userId, id))
  // Committed: the caller runs what it staged, as the disconnect route does.
  await runConnectionTeardown(id)
}

async function reload(id: string) {
  const [row] = await db.select().from(connectedAccounts).where(eq(connectedAccounts.id, id))
  return row
}

describe("connections revoke on disconnect", () => {
  it("revokes the refresh token at the provider and deletes the stored tokens", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({
      appName: "mail",
      connectionName: "gmail",
      identifier: "solo@example.com",
      refreshToken: "the-refresh-token",
    })

    await disconnect(id)

    expect(received).toEqual([{ token: "the-refresh-token", token_type_hint: "refresh_token" }])
    const row = await reload(id)
    expect(row.status).toBe("disconnected")
    expect(row.accessTokenEncrypted).toBeNull()
    expect(row.refreshTokenEncrypted).toBeNull()
    expect(row.tokenExpiresAt).toBeNull()
  })

  it("sends the access token when no refresh token is stored", async () => {
    declare("calendar", "google-calendar")
    const id = await insertConnection({
      appName: "calendar",
      connectionName: "google-calendar",
      identifier: "access-only@example.com",
      refreshToken: null,
    })
    await disconnect(id)
    expect(received).toEqual([{ token: "access-token", token_type_hint: "access_token" }])
  })

  it("still disconnects and deletes the tokens when the provider refuses", async () => {
    declare("mail", "gmail")
    replyStatus = 503
    const id = await insertConnection({
      appName: "mail",
      connectionName: "gmail",
      identifier: "provider-down@example.com",
    })
    await disconnect(id)
    expect(received).toHaveLength(1)
    const row = await reload(id)
    expect(row.status).toBe("disconnected")
    expect(row.refreshTokenEncrypted).toBeNull()
  })

  it("keeps the grant while another active connection uses the same account", async () => {
    declare("mail", "gmail")
    declare("calendar", "google-calendar")
    const mailId = await insertConnection({
      appName: "mail",
      connectionName: "gmail",
      identifier: "Shared@Example.com",
    })
    const calendarId = await insertConnection({
      appName: "calendar",
      connectionName: "google-calendar",
      identifier: "shared@example.com",
    })

    await disconnect(mailId)
    // One Google grant serves both: revoking it would cut Calendar.
    expect(received).toHaveLength(0)
    expect((await reload(mailId)).refreshTokenEncrypted).toBeNull()
    expect((await reload(calendarId)).status).toBe("active")

    // The last connection of the account goes: now the grant is revoked.
    await disconnect(calendarId)
    expect(received).toHaveLength(1)
  })

  it("keeps the grant while another org of the instance uses the same account", async () => {
    declare("mail", "gmail")
    // The other org's apps are not registered in this process: its row's endpoint
    // falls back to this org's config for the same app and connection.
    const otherOrg = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'Revoke Other Org', ${`revoke-other-${randomUUID()}`})
        RETURNING id
      `),
    )[0]!.id
    const otherUser = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${otherOrg}, ${`other-${randomUUID()}@test.com`}, 'Other', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )[0]!.id
    const [other] = await db
      .insert(connectedAccounts)
      .values({
        orgId: otherOrg,
        appName: "mail",
        connectionName: "gmail",
        ownerType: "user",
        ownerId: otherUser,
        providerType: "oauth2",
        identifier: "two-orgs@example.com",
        refreshTokenEncrypted: encryptSecret(
          "other-org-refresh",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountRefreshToken,
        ),
        status: "active",
        createdBy: otherUser,
      })
      .returning({ id: connectedAccounts.id })
    const id = await insertConnection({
      appName: "mail",
      connectionName: "gmail",
      identifier: "Two-Orgs@example.com",
    })
    try {
      await disconnect(id)
      expect(received).toHaveLength(0)
      expect((await reload(id)).refreshTokenEncrypted).toBeNull()
      expect((await reload(other!.id)).status).toBe("active")

      // Once the other org's connection is gone, a disconnect revokes.
      await db
        .update(connectedAccounts)
        .set({ status: "disconnected" })
        .where(eq(connectedAccounts.id, other!.id))
      const again = await insertConnection({
        appName: "mail",
        connectionName: "gmail",
        identifier: "two-orgs@example.com",
      })
      await disconnect(again)
      expect(received).toHaveLength(1)
    } finally {
      await db.execute(drizzleSql`DELETE FROM kernel.connected_accounts WHERE org_id = ${otherOrg}`)
      await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${otherOrg}`)
      await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${otherOrg}`)
    }
  })

  it("revokes nothing when the disconnect transaction rolls back", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({
      appName: "mail",
      connectionName: "gmail",
      identifier: "rolled-back@example.com",
    })
    await expect(
      withPrivilegedDb(orgId, "revoke-test-rollback", async (tx) => {
        await disconnectConnection(tx, orgId, userId, id)
        // Nothing reached the provider while the transaction was open.
        expect(received).toHaveLength(0)
        throw new Error("caller failed after the disconnect")
      }),
    ).rejects.toThrow("caller failed")
    // No commit: no caller runs the staged revocation, and no event is published.
    expect(received).toHaveLength(0)
    const row = await reload(id)
    expect(row.status).toBe("active")
    expect(row.refreshTokenEncrypted).not.toBeNull()
  })

  it("the committed disconnect event runs a revocation its caller did not", async () => {
    declare("mail", "gmail")
    const id = await insertConnection({
      appName: "mail",
      connectionName: "gmail",
      identifier: "event-path@example.com",
    })
    // An app tool's disconnect: the transaction is not the caller's to follow.
    await withPrivilegedDb(orgId, "revoke-test-event", (tx) =>
      disconnectConnection(tx, orgId, userId, id),
    )
    expect(received).toHaveLength(0)
    await revokeOnDisconnectEvent({
      app: "kernel",
      entity: "connected_account",
      action: "disconnect",
      entityId: id,
    })
    expect(received).toHaveLength(1)
    // Taken once: a second delivery (or a late direct call) does nothing.
    await revokeOnDisconnectEvent({
      app: "kernel",
      entity: "connected_account",
      action: "disconnect",
      entityId: id,
    })
    expect(await runConnectionTeardown(id)).toEqual([])
    expect(received).toHaveLength(1)
  })

  it("does not call anything for a connection that declares no revocation endpoint", async () => {
    declare("social", "youtube", false)
    const id = await insertConnection({
      appName: "social",
      connectionName: "youtube",
      identifier: "no-endpoint@example.com",
    })
    await disconnect(id)
    expect(received).toHaveLength(0)
    expect((await reload(id)).accessTokenEncrypted).toBeNull()
  })

  it("reports an already revoked token as already invalid", async () => {
    declare("mail", "gmail")
    replyStatus = 400
    replyBody = JSON.stringify({ error: "invalid_token" })
    const outcome = await revokeConnectionGrant({
      id: randomUUID(),
      orgId,
      appName: "mail",
      connectionName: "gmail",
      providerType: "oauth2",
      identifier: "gone@example.com",
      accessTokenEncrypted: null,
      refreshTokenEncrypted: encryptSecret(
        "stale",
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountRefreshToken,
      ),
    })
    expect(outcome).toEqual({ status: "already_invalid" })
  })
})
