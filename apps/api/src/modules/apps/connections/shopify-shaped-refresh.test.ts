// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify issues non-expiring offline tokens today (Liaison never asks for
// `expiring=1`). Should it ever return an expiring one, with refresh_token and
// expires_in, the generic refresh path must keep the store connected: post the
// refresh grant to the store's own token URL (`https://{shop}/...`, filled from
// the account's identifier with the connection's rule), store the new access
// token, the rotated refresh token and the expiry, and hand the new token out.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import {
  connectionConfigRegistry,
  oauthClientResolverRegistry,
  resetAppRegistries,
} from "~/modules/apps/app-registries"
import { getTokenFromAccount } from "~/modules/apps/connections/service"

let orgId: string
let userId: string
let tokenServer: ReturnType<typeof Bun.serve> | null = null
const seen: Array<{ path: string; body: URLSearchParams }> = []

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Shopify Refresh Org', ${`shopify-refresh-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`shopify-refresh-${suffix}@test.com`}, 'Installer', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user.id

  // The store's token endpoint, answering with the shape Shopify documents for
  // an expiring offline token.
  tokenServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      seen.push({ path: new URL(req.url).pathname, body: new URLSearchParams(await req.text()) })
      return Response.json({
        access_token: "shpat_new-access-token",
        scope: "read_orders,write_orders",
        expires_in: 3600,
        refresh_token: "shprt_rotated-refresh-token",
        refresh_token_expires_in: 7776000,
      })
    },
  })
})

afterAll(async () => {
  tokenServer?.stop(true)
  await db.execute(drizzleSql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}`)
  resetAppRegistries()
})

describe("a Shopify-shaped expiring token", () => {
  it("refreshes at the store's token URL and stores the new tokens and expiry", async () => {
    const store = `localhost:${tokenServer?.port}`
    connectionConfigRegistry.set([orgId, "shopify", "shop"], {
      type: "oauth2",
      allowedDomains: [],
      tokenUrl: "http://{shop}/admin/oauth/access_token",
      identifierVar: "shop",
      templateVars: { shop: { lowercase: true, pattern: "^localhost:[0-9]+$" } },
    })
    oauthClientResolverRegistry.set([orgId, "shopify", "shop"], async () => ({
      clientId: "shopify-client-id",
      clientSecret: "shopify-client-secret",
    }))

    const [account] = await db
      .insert(connectedAccounts)
      .values({
        orgId,
        appName: "shopify",
        connectionName: "shop",
        ownerType: "org",
        providerType: "oauth2",
        identifier: store,
        accessTokenEncrypted: encryptSecret(
          "shpat_expired-access-token",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountAccessToken,
        ),
        refreshTokenEncrypted: encryptSecret(
          "shprt_first-refresh-token",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountRefreshToken,
        ),
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
        status: "active",
        createdBy: userId,
      })
      .returning()

    const before = Date.now()
    const token = await getTokenFromAccount(account, env.ENCRYPTION_KEY)
    expect(token).toBe("shpat_new-access-token")

    expect(seen).toHaveLength(1)
    expect(seen[0]?.path).toBe("/admin/oauth/access_token")
    expect(seen[0]?.body.get("grant_type")).toBe("refresh_token")
    expect(seen[0]?.body.get("refresh_token")).toBe("shprt_first-refresh-token")
    expect(seen[0]?.body.get("client_id")).toBe("shopify-client-id")

    const [stored] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, account.id))
    expect(stored.status).toBe("active")
    expect(
      decryptSecret(
        stored.accessTokenEncrypted ?? "",
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountAccessToken,
      ),
    ).toBe("shpat_new-access-token")
    expect(
      decryptSecret(
        stored.refreshTokenEncrypted ?? "",
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountRefreshToken,
      ),
    ).toBe("shprt_rotated-refresh-token")
    const expiresAt = stored.tokenExpiresAt?.getTime() ?? 0
    expect(expiresAt).toBeGreaterThanOrEqual(before + 3600 * 1000 - 5000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 5000)

    // The next read uses the stored token: no second refresh.
    const [reloaded] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, account.id))
    expect(await getTokenFromAccount(reloaded, env.ENCRYPTION_KEY)).toBe("shpat_new-access-token")
    expect(seen).toHaveLength(1)
  })

  it("never substitutes an identifier the connection's rule refuses", async () => {
    const [account] = await db
      .insert(connectedAccounts)
      .values({
        orgId,
        appName: "shopify",
        connectionName: "shop",
        ownerType: "org",
        providerType: "oauth2",
        identifier: "evil.example/steal",
        accessTokenEncrypted: encryptSecret(
          "shpat_expired",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountAccessToken,
        ),
        refreshTokenEncrypted: encryptSecret(
          "shprt_x",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountRefreshToken,
        ),
        tokenExpiresAt: new Date(Date.now() - 60 * 1000),
        status: "active",
        createdBy: userId,
      })
      .returning()
    const calls = seen.length
    await expect(getTokenFromAccount(account, env.ENCRYPTION_KEY)).rejects.toThrow(
      "requires re-authorization",
    )
    expect(seen).toHaveLength(calls)
  })
})
