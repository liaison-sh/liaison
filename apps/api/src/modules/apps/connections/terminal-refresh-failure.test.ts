// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Verifies the PRE-EXISTING terminal-refresh-failure marking in
// `refreshOAuthAccessToken` (invoked via `getTokenFromAccount`): when a
// provider rejects an OAuth2 refresh_token grant with 400/401 (revoked /
// invalid_grant — the real-world "Google token expired" incident this feature
// responds to), the account is marked `status = 'error'` with a
// human-readable `statusMessage`. This is what makes the connection-health
// attention provider (`attention.ts`) an O(table-scan) health check instead
// of a live probe — the terminal state is already persisted by the time the
// feed reads it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
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
let tokenUrl: string

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Terminal Refresh Failure Org', ${`terminal-refresh-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`terminal-refresh-${suffix}@test.com`}, 'Installer', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user.id

  // Fake token endpoint: always rejects the refresh grant with the shape a
  // real provider (Google) returns for a revoked / expired grant.
  tokenServer = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
  })
  tokenUrl = `http://localhost:${tokenServer.port}/token`
})

afterAll(async () => {
  tokenServer?.stop(true)
  await db.execute(drizzleSql`DELETE FROM kernel.connected_accounts WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}`)
})

describe("connections.service terminal refresh failure", () => {
  it("connections.service.invalid-grant-marks-account-error", async () => {
    connectionConfigRegistry.set([orgId, "social", "google"], {
      type: "oauth2",
      allowedDomains: [],
      tokenUrl,
    })
    oauthClientResolverRegistry.set([orgId, "social", "google"], async () => ({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    }))

    const [account] = await db
      .insert(connectedAccounts)
      .values({
        orgId,
        appName: "social",
        connectionName: "google",
        ownerType: "user",
        ownerId: userId,
        providerType: "oauth2",
        identifier: "ops@example.com",
        accessTokenEncrypted: encryptSecret(
          "stale-access-token",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountAccessToken,
        ),
        refreshTokenEncrypted: encryptSecret(
          "revoked-refresh-token",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountRefreshToken,
        ),
        tokenExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
        status: "active",
        createdBy: userId,
      })
      .returning()

    // Pass env.ENCRYPTION_KEY explicitly — it's what encrypted the fixture's
    // tokens above. `getTokenFromAccount`'s default param snapshots
    // `service.ts`'s own module-load-time `process.env.ENCRYPTION_KEY`, which
    // can diverge from `env.ENCRYPTION_KEY` depending on cross-file import
    // order under a full suite run; passing it explicitly avoids that.
    await expect(getTokenFromAccount(account, env.ENCRYPTION_KEY)).rejects.toThrow(
      "requires re-authorization",
    )

    const [reloaded] = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.id, account.id))
    expect(reloaded.status).toBe("error")
    expect(reloaded.statusMessage).toMatch(/reconnect required/i)

    resetAppRegistries()
  })
})
