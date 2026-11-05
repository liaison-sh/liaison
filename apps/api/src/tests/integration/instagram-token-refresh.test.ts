// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Instagram-style long-lived token SELF-refresh, exercised via the real
// getTokenFromAccount against the privileged DB. Instagram Business Login tokens
// carry NO refresh_token; they renew by presenting the CURRENT access token to
// graph.instagram.com/refresh_access_token (grant_type=ig_refresh_token), which
// returns a fresh 60-day token. Covered by the `refreshUsesAccessToken` +
// `refreshTokenUrl` + `refreshGrantType` + `refreshWindowMs` connection knobs.
//
// Asserts: (1) a token inside the wide pre-expiry window self-refreshes -- the
// renewal GET carries ig_refresh_token + the current token, and the new token +
// ~60-day expiry are persisted; (2) a FAILED early refresh (token still valid)
// falls back to the stored token WITHOUT throwing (retries next call).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { connectionConfigRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { getTokenFromAccount } from "~/modules/apps/connections/service"

type Account = typeof connectedAccounts.$inferSelect

const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000
const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000

let orgId: string
let userId: string
let accountOk: Account
let accountFail: Account
let server: ReturnType<typeof Bun.serve> | null = null
let refreshUrl: string
let lastRefreshUrl = ""
let refreshShouldFail = false
let meAuth = ""

async function insertNearExpiryAccount(token: string): Promise<Account> {
  const [row] = await db
    .insert(connectedAccounts)
    .values({
      orgId,
      appName: "social",
      connectionName: "instagram",
      ownerType: "org",
      ownerId: null,
      providerType: "oauth2",
      identifier: `ig-${randomUUID().slice(0, 8)}`,
      accessTokenEncrypted: encryptSecret(
        token,
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountAccessToken,
      ),
      // Inside the 10-day refresh window, but NOT hard-expired (valid 5 more days).
      tokenExpiresAt: new Date(Date.now() + FIVE_DAYS_MS),
      status: "active",
      createdBy: userId,
    })
    .returning()
  return row
}

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'IG Refresh Test Org', ${`ig-refresh-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`ig-refresh-${suffix}@test.com`}, 'Installer', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user.id

  // Mock graph.instagram.com/refresh_access_token: capture the URL, and either
  // return a fresh 60-day token or (when the test flips the flag) fail with 500.
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      // The account-name lookup (displayNameUrl), made with the renewed token.
      if (new URL(req.url).pathname === "/me") {
        meAuth = req.headers.get("authorization") ?? ""
        return Response.json({ id: "17841400000000099", username: "renewed.handle" })
      }
      lastRefreshUrl = req.url
      if (refreshShouldFail) return new Response("upstream error", { status: 500 })
      return new Response(
        JSON.stringify({
          access_token: "REFRESHED_IG_TOKEN",
          token_type: "bearer",
          expires_in: 5_184_000,
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
  refreshUrl = `http://127.0.0.1:${server.port}/refresh_access_token`

  connectionConfigRegistry.set([orgId, "social", "instagram"], {
    type: "oauth2",
    authorizationUrl: "https://www.instagram.com/oauth/authorize",
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    scopes: ["instagram_business_basic"],
    allowedDomains: ["graph.instagram.com", "api.instagram.com"],
    refreshTokenUrl: refreshUrl,
    refreshGrantType: "ig_refresh_token",
    refreshUsesAccessToken: true,
    refreshWindowMs: TEN_DAYS_MS,
    displayNameUrl: `http://127.0.0.1:${server.port}/me?fields=username`,
    displayNameFields: ["username"],
  })

  accountOk = await insertNearExpiryAccount("OLD_TOKEN_OK")
  accountFail = await insertNearExpiryAccount("OLD_TOKEN_FAIL")
})

afterAll(async () => {
  server?.stop(true)
  resetAppRegistries()
  await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}`)
})

describe("Instagram long-lived token self-refresh", () => {
  it("renews a token inside the wide window via ig_refresh_token + persists the new token/expiry", async () => {
    refreshShouldFail = false
    const returned = await getTokenFromAccount(accountOk, env.ENCRYPTION_KEY)

    // Returns the freshly minted token.
    expect(returned).toBe("REFRESHED_IG_TOKEN")
    // The renewal presented the CURRENT token under the ig_refresh_token grant.
    expect(lastRefreshUrl).toContain("grant_type=ig_refresh_token")
    expect(lastRefreshUrl).toContain("access_token=OLD_TOKEN_OK")

    // The new token + a ~60-day expiry were persisted to the row.
    const [row] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, accountOk.id))
    const stored = decryptSecret(
      row.accessTokenEncrypted as string,
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountAccessToken,
    )
    expect(stored).toBe("REFRESHED_IG_TOKEN")
    const daysOut = (row.tokenExpiresAt!.getTime() - Date.now()) / (24 * 60 * 60 * 1000)
    expect(daysOut).toBeGreaterThan(55)
    // The renewal also (re)names the account, so a row stored without a name
    // heals on its next refresh.
    expect(meAuth).toBe("Bearer REFRESHED_IG_TOKEN")
    expect(row.displayName).toBe("renewed.handle")
  })

  it("a FAILED early refresh falls back to the still-valid stored token (no throw)", async () => {
    refreshShouldFail = true
    // The refresh 500s, but the token is still valid for ~5 days, so
    // getTokenFromAccount must return the stored token rather than throw.
    const returned = await getTokenFromAccount(accountFail, env.ENCRYPTION_KEY)
    expect(returned).toBe("OLD_TOKEN_FAIL")

    // The stored token is untouched (no bogus persist on failure).
    const [row] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, accountFail.id))
    const stored = decryptSecret(
      row.accessTokenEncrypted as string,
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountAccessToken,
    )
    expect(stored).toBe("OLD_TOKEN_FAIL")
  })
})
