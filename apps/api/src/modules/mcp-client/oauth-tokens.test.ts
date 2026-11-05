// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Token lifecycle (S27, A15): the refresh is single-flight ACROSS processes
// (an advisory lock on the connection, the row re-read under it), a rotated
// refresh token is persisted in the same transaction, `resource` rides every
// refresh, and only invalid_grant / 400 / 401 means "sign in again" while a
// network error or a 5xx is retried with backoff.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { eq } from "drizzle-orm"
import { buildMcpWorld, type McpTestWorld } from "~/apps/mcp-manager/test-helpers/world"
import { withSystemDb } from "~/db/privileged"
import { mcpConnections } from "~/db/schema/app_mcp_manager"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { needsProactiveRefresh, tokenFingerprint } from "./credentials"
import { makeTokenRefresher } from "./oauth-tokens"
import { decryptSecretsBlob, encryptSecretsBlob, type McpOAuthMetadata } from "./secrets"
import {
  type OAuthFixtureHandle,
  signInDirectly,
  startOAuthMcpFixture,
} from "./transports/fixtures/oauth-mcp-server"

describe("OAuth token refresh", () => {
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

  async function seedSignedIn(): Promise<{
    id: string
    accessToken: string
    refreshToken: string
  }> {
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
    const id = await withSystemDb("oauth-tokens-seed", async (db) => {
      const [row] = await db
        .insert(mcpConnections)
        .values({
          orgId: world.org.id,
          slug: `tok-${crypto.randomUUID().slice(0, 6)}`,
          displayName: "Token test",
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
    return { id, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
  }

  async function stored(id: string) {
    const [row] = await withSystemDb("oauth-tokens-read", (db) =>
      db.select().from(mcpConnections).where(eq(mcpConnections.id, id)),
    )
    return {
      blob: decryptSecretsBlob(row.secretsEncrypted),
      meta: (row.oauthMetadata ?? {}) as McpOAuthMetadata,
    }
  }

  it("two processes refreshing at once POST once and both end on the new token", async () => {
    const conn = await seedSignedIn()
    // Two refreshers stand for two API processes: no in-process single flight
    // is shared between them, only the database.
    const a = makeTokenRefresher()
    const b = makeTokenRefresher()
    const seen = tokenFingerprint(conn.accessToken)
    const [ra, rb] = await Promise.all([
      a.refresh(conn.id, { seenTokenFingerprint: seen }),
      b.refresh(conn.id, { seenTokenFingerprint: seen }),
    ])
    expect(ra.ok).toBe(true)
    expect(rb.ok).toBe(true)
    // A second POST would have replayed the rotated (now dead) refresh token.
    expect(fixture.stats.refreshPosts).toBe(1)
    const after = await stored(conn.id)
    expect(after.blob.accessToken).not.toBe(conn.accessToken)
    expect(after.blob.refreshToken).not.toBe(conn.refreshToken)
  })

  it("sends resource on the refresh and persists expiry and the rotated refresh token", async () => {
    const conn = await seedSignedIn()
    const res = await makeTokenRefresher().refresh(conn.id, {
      seenTokenFingerprint: tokenFingerprint(conn.accessToken),
    })
    expect(res.ok).toBe(true)
    const last = fixture.stats.tokenRequests.at(-1)
    expect(last?.grant_type).toBe("refresh_token")
    expect(last?.resource).toBe(fixture.mcpUrl)
    const after = await stored(conn.id)
    const expiresAt = Date.parse(after.meta.expiresAt ?? "")
    expect(expiresAt).toBeGreaterThan(Date.now())
    expect(expiresAt).toBeLessThan(Date.now() + 10_000)
    expect(after.blob.refreshToken).not.toBe(conn.refreshToken)
  })

  it("adopts a token another process already refreshed, without a POST", async () => {
    const conn = await seedSignedIn()
    const res = await makeTokenRefresher().refresh(conn.id, {
      seenTokenFingerprint: tokenFingerprint("a-token-this-process-held-before"),
    })
    expect(res.ok).toBe(true)
    expect(fixture.stats.refreshPosts).toBe(0)
  })

  it("invalid_grant → needs a new sign-in", async () => {
    const conn = await seedSignedIn()
    fixture.revokeRefreshTokens()
    const res = await makeTokenRefresher().refresh(conn.id, {
      seenTokenFingerprint: tokenFingerprint(conn.accessToken),
    })
    expect(res).toMatchObject({ ok: false, kind: "invalid_grant" })
  })

  it("a 503 from the token endpoint is retried, and the retry succeeds", async () => {
    const conn = await seedSignedIn()
    fixture.failNextTokenRequests(1, 503)
    const res = await makeTokenRefresher({ backoffMs: [5, 5] }).refresh(conn.id, {
      seenTokenFingerprint: tokenFingerprint(conn.accessToken),
    })
    expect(res.ok).toBe(true)
    expect(fixture.stats.refreshPosts).toBe(2)
  })

  it("a token endpoint that stays down is transient, not a lost sign-in", async () => {
    const conn = await seedSignedIn()
    fixture.failNextTokenRequests(10, 503)
    const res = await makeTokenRefresher({ backoffMs: [5, 5] }).refresh(conn.id, {
      seenTokenFingerprint: tokenFingerprint(conn.accessToken),
    })
    expect(res).toMatchObject({ ok: false, kind: "transient" })
    expect(fixture.stats.refreshPosts).toBe(3)
    // The refresh token was never spent, so a later retry can still succeed.
    const after = await stored(conn.id)
    expect(after.blob.refreshToken).toBe(conn.refreshToken)
  })
})

describe("needsProactiveRefresh", () => {
  const now = 1_000_000_000_000
  it("refreshes within 60 s of expiry", () => {
    expect(needsProactiveRefresh({ isOAuth: true, expiresAt: now + 59_000 }, now)).toBe(true)
    expect(needsProactiveRefresh({ isOAuth: true, expiresAt: now - 1 }, now)).toBe(true)
  })
  it("leaves a token with more than 60 s alone", () => {
    expect(needsProactiveRefresh({ isOAuth: true, expiresAt: now + 61_000 }, now)).toBe(false)
  })
  it("cannot judge a token with no expiry, nor a bearer connection", () => {
    expect(needsProactiveRefresh({ isOAuth: true, expiresAt: null }, now)).toBe(false)
    expect(needsProactiveRefresh({ isOAuth: false, expiresAt: now }, now)).toBe(false)
  })
})
