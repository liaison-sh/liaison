// SPDX-License-Identifier: FSL-1.1-ALv2
// An edit of an OAuth connection racing a token refresh (S27): the edit is
// never lost, and neither is the refresh token the server rotated. The edit
// waits for the in-flight refresh (one lock per connection), then merges onto
// the row the refresh wrote.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { errorHandler } from "~/middleware/error-handler"
import { tokenFingerprint } from "~/modules/mcp-client/credentials"
import { makeTokenRefresher } from "~/modules/mcp-client/oauth-tokens"
import {
  decryptSecretsBlob,
  encryptSecretsBlob,
  type McpOAuthMetadata,
} from "~/modules/mcp-client/secrets"
import {
  type OAuthFixtureHandle,
  signInDirectly,
  startOAuthMcpFixture,
} from "~/modules/mcp-client/transports/fixtures/oauth-mcp-server"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { mcpManagerRoutes } from "./routes"
import { buildMcpWorld, type McpTestWorld } from "./test-helpers/world"

function appAs(actor: UserContext) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", actor.userId)
    c.set("orgId", actor.orgId)
    c.set("scopes", actor.scopes as AppEnv["Variables"]["scopes"])
    c.set("dimensionGrants", actor.dimensionGrants ?? {})
    await next()
  })
  app.route("/apps/mcp-manager", mcpManagerRoutes)
  app.onError(errorHandler)
  return app
}

describe("an OAuth connection edited while its token refreshes", () => {
  let world: McpTestWorld
  let fixture: OAuthFixtureHandle
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)
  beforeEach(async () => {
    world = await buildMcpWorld()
    fixture = await startOAuthMcpFixture()
  })
  afterEach(async () => {
    await fixture.close()
  })

  async function seedSignedIn() {
    const tokens = await signInDirectly(fixture)
    const meta: McpOAuthMetadata = {
      clientId: tokens.clientId,
      clientIdSource: "dcr",
      issuer: fixture.issuer,
      clientIssuer: fixture.issuer,
      authorizationServerUrl: fixture.issuer,
      authorizationEndpoint: `${fixture.issuer}/authorize`,
      tokenEndpoint: `${fixture.issuer}/token`,
      tokenEndpointAuthMethod: "none",
      resource: fixture.mcpUrl,
      scope: "mcp:tools",
      expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    }
    const id = await withSystemDb("refresh-edit-race-seed", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: `race-${crypto.randomUUID().slice(0, 6)}`,
          displayName: "Race",
          transport: "http",
          httpUrl: fixture.mcpUrl,
          authFlavor: "oauth_dcr",
          oauthMetadata: meta as Record<string, unknown>,
          secretsEncrypted: encryptSecretsBlob({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          }),
          createdBy: world.admin.userId,
        })
        .returning({ id: mcpConnections.id })
      return row.id
    })
    return { id, ...tokens }
  }

  async function stored(id: string) {
    const [row] = await withSystemDb("refresh-edit-race-read", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    return {
      blob: decryptSecretsBlob(row.secretsEncrypted),
      meta: (row.oauthMetadata ?? {}) as McpOAuthMetadata,
    }
  }

  it("an edit committed during the token request survives, with the rotated refresh token", async () => {
    const conn = await seedSignedIn()
    fixture.setOptions({ tokenDelayMs: 1_500 })
    const refreshing = makeTokenRefresher().refresh(conn.id, {
      seenTokenFingerprint: tokenFingerprint(conn.accessToken),
    })
    // The refresh is now holding its token request.
    await new Promise((r) => setTimeout(r, 400))
    const res = await appAs(world.admin).request(`/apps/mcp-manager/connections/${conn.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oauthClientSecret: "edited-secret" }),
    })
    expect(res.status).toBe(200)
    expect((await refreshing).ok).toBe(true)
    expect(fixture.stats.refreshPosts).toBe(1)

    const after = await stored(conn.id)
    expect(after.blob.oauthClientSecret).toBe("edited-secret")
    expect(after.blob.accessToken).not.toBe(conn.accessToken)
    expect(after.blob.refreshToken).not.toBe(conn.refreshToken)
    // The refresh's expiry is kept too.
    expect(Date.parse(after.meta.expiresAt ?? "")).toBeGreaterThan(Date.now())
  }, 30_000)
})
