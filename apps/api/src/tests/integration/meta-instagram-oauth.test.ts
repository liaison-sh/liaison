// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Kernel OAuth2 provider-quirk knobs, exercised via the REAL startOAuthFlow +
// handleOAuthCallback against the privileged DB. These are ADDITIVE + opt-in;
// the tests assert BOTH the new Instagram-Business-Login behaviour AND that a
// connection which declares none of the knobs keeps the standard behaviour
// (space-joined scopes, PKCE on, single token exchange).
//
// New knobs covered:
//   - scopeSeparator: "," (Meta wants comma-joined scopes, not space)
//   - usePkce: false   (no code_challenge in authorize, no code_verifier in exchange)
//   - longLivedTokenUrl + longLivedTokenGrantType: a SECOND exchange that swaps the
//     short-lived token for a long-lived one
//   - identifierFromTokenField: "user_id" (Instagram returns the account id in the
//     token response — no id_token / userinfo)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { apps, connectedAccounts, oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import { connectionConfigRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { classifyConnectionHealth } from "~/modules/apps/connections/attention"
import {
  ConnectionHeldByOtherOwnerError,
  describeConnectionAccounts,
  handleOAuthCallback,
  healUnnamedConnectionAccounts,
  OAuthAccountChoiceError,
  OAuthStartRefusedError,
  reconcileAppConnections,
  resetAccountNameLookupCooldowns,
  startOAuthFlow,
} from "~/modules/apps/connections/service"

const OAUTH_STATE_PREFIX = "oauth:state"
const CLIENT_ID = "ig-client-id"
const CLIENT_SECRET = "ig-client-secret"
const IG_USER_ID = "17841400000000042"

let orgId: string
let userId: string
let shortServer: ReturnType<typeof Bun.serve> | null = null
let longServer: ReturnType<typeof Bun.serve> | null = null
let shortTokenUrl: string
let longTokenUrl: string
let shortRequestBody = ""
let longRequestUrl = ""

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'IG OAuth Test Org', ${`ig-oauth-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`ig-oauth-${suffix}@test.com`}, 'Installer', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user.id

  await db
    .insert(apps)
    .values({ orgId, name: "social", version: "0.2.0", config: null })
    .onConflictDoNothing()

  // Instagram Business Login uses a DEDICATED Instagram app client.
  await db.insert(oauthProviders).values({
    orgId,
    name: "social:instagram",
    issuerUrl: "https://app-connection.invalid/social:instagram",
    clientId: CLIENT_ID,
    clientSecretEncrypted: encryptSecret(
      CLIENT_SECRET,
      env.ENCRYPTION_KEY,
      CryptoContext.oauthProviderClientSecret,
    ),
  })
  // A standard connection (no quirk knobs) sharing the same client, for the
  // defaults-unchanged assertions.
  await db.insert(oauthProviders).values({
    orgId,
    name: "social:standard",
    issuerUrl: "https://app-connection.invalid/social:standard",
    clientId: CLIENT_ID,
    clientSecretEncrypted: encryptSecret(
      CLIENT_SECRET,
      env.ENCRYPTION_KEY,
      CryptoContext.oauthProviderClientSecret,
    ),
  })

  // Short-lived token endpoint (api.instagram.com/oauth/access_token): captures the
  // request body (to assert PKCE-off) and returns user_id + a short-lived token.
  shortServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      shortRequestBody = await req.text()
      return new Response(
        JSON.stringify({
          access_token: "SHORT_IG_TOKEN",
          user_id: IG_USER_ID,
          permissions: ["instagram_business_basic"],
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
  shortTokenUrl = `http://127.0.0.1:${shortServer.port}/oauth/access_token`

  // Long-lived token endpoint (graph.instagram.com/access_token): captures the URL
  // (to assert the ig_exchange_token GET params) and returns the 60-day token.
  longServer = Bun.serve({
    port: 0,
    fetch: (req) => {
      longRequestUrl = req.url
      return new Response(
        JSON.stringify({
          access_token: "LONG_IG_TOKEN",
          token_type: "bearer",
          expires_in: 5_184_000,
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  })
  longTokenUrl = `http://127.0.0.1:${longServer.port}/access_token`

  connectionConfigRegistry.set([orgId, "social", "instagram"], {
    type: "oauth2",
    authorizationUrl: "https://www.instagram.com/oauth/authorize",
    // Real HTTPS host so startOAuthFlow's endpoint validation passes; the callback
    // instead uses the 127.0.0.1 tokenUrl carried in the seeded OAuth state.
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    scopes: [
      "instagram_business_basic",
      "instagram_business_manage_comments",
      "instagram_business_manage_messages",
    ],
    scopeSeparator: ",",
    usePkce: false,
    longLivedTokenUrl: longTokenUrl,
    longLivedTokenGrantType: "ig_exchange_token",
    identifierFromTokenField: "user_id",
    allowedDomains: ["graph.instagram.com", "api.instagram.com"],
  })

  connectionConfigRegistry.set([orgId, "social", "standard"], {
    type: "oauth2",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["scope_a", "scope_b"],
    allowedDomains: ["accounts.google.com", "oauth2.googleapis.com"],
  })
})

afterAll(async () => {
  shortServer?.stop(true)
  longServer?.stop(true)
  resetAppRegistries()
  await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
  await db.delete(oauthProviders).where(eq(oauthProviders.orgId, orgId))
  await db.delete(apps).where(eq(apps.orgId, orgId))
})

describe("kernel OAuth2 provider-quirk knobs (Instagram Business Login)", () => {
  it("authorize URL: comma-joined scopes and NO PKCE challenge when the connection opts out", async () => {
    const url = new URL(
      await startOAuthFlow(orgId, userId, "social", "instagram", { ownerType: "org" }),
    )
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID)
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("state")).toBeTruthy()
    // Comma-joined (Meta), not space-joined.
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_comments,instagram_business_manage_messages",
    )
    // PKCE suppressed.
    expect(url.searchParams.get("code_challenge")).toBeNull()
    expect(url.searchParams.get("code_challenge_method")).toBeNull()
  })

  it("authorize URL: a connection with NO knobs keeps space-joined scopes + PKCE (defaults unchanged)", async () => {
    const url = new URL(
      await startOAuthFlow(orgId, userId, "social", "standard", { ownerType: "org" }),
    )
    expect(url.searchParams.get("scope")).toBe("scope_a scope_b")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBeTruthy()
  })

  it("callback: swaps short->long-lived token, stores user_id as identifier, omits code_verifier", async () => {
    const state = randomUUID()
    await redis.set(
      `${OAUTH_STATE_PREFIX}:${state}`,
      JSON.stringify({
        orgId,
        userId,
        appName: "social",
        connectionName: "instagram",
        codeVerifier: "unused-verifier",
        tokenUrl: shortTokenUrl,
        ownerType: "org",
        ownerId: null,
      }),
      "EX",
      900,
    )

    await handleOAuthCallback("ig-auth-code", state)

    const [row] = await db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, "social"),
          eq(connectedAccounts.connectionName, "instagram"),
        ),
      )
      .limit(1)

    expect(row).toBeDefined()
    // Identifier came straight from the token response's user_id.
    expect(row.identifier).toBe(IG_USER_ID)
    expect(row.status).toBe("active")

    // The STORED token is the LONG-lived one (short->long swap happened).
    const storedToken = decryptSecret(
      row.accessTokenEncrypted!,
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountAccessToken,
    )
    expect(storedToken).toBe("LONG_IG_TOKEN")
    // Expiry reflects the long-lived 60-day window (not the short-lived one).
    expect(row.tokenExpiresAt).toBeTruthy()
    expect(row.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * 24 * 3600 * 1000)

    // PKCE off -> the code exchange sent NO code_verifier.
    expect(shortRequestBody).toContain("grant_type=authorization_code")
    expect(shortRequestBody).not.toContain("code_verifier")

    // The long-lived exchange was a GET with the ig_exchange_token grant + the short token.
    expect(longRequestUrl).toContain("grant_type=ig_exchange_token")
    expect(longRequestUrl).toContain("access_token=SHORT_IG_TOKEN")
    expect(longRequestUrl).toContain("client_secret=")
  })

  // Seed one active instagram row for IG_USER_ID under the given owner and a
  // callback state for a PERSONAL connect by `connectingUserId`.
  async function seedHeldRowAndPersonalState(
    holder: { ownerType: "org"; ownerId: null } | { ownerType: "user"; ownerId: string },
    connectingUserId: string,
  ): Promise<{ heldId: string; state: string }> {
    await db
      .delete(connectedAccounts)
      .where(
        and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.connectionName, "instagram")),
      )
    const [held] = await db
      .insert(connectedAccounts)
      .values({
        orgId,
        appName: "social",
        connectionName: "instagram",
        ownerType: holder.ownerType,
        ownerId: holder.ownerId,
        providerType: "oauth2",
        identifier: IG_USER_ID,
        accessTokenEncrypted: encryptSecret(
          "HELD_TOKEN",
          env.ENCRYPTION_KEY,
          CryptoContext.connectedAccountAccessToken,
        ),
        status: "active",
        createdBy: userId,
      })
      .returning()
    const state = randomUUID()
    await redis.set(
      `${OAUTH_STATE_PREFIX}:${state}`,
      JSON.stringify({
        orgId,
        userId: connectingUserId,
        appName: "social",
        connectionName: "instagram",
        codeVerifier: "unused-verifier",
        tokenUrl: shortTokenUrl,
        ownerType: "user",
        ownerId: connectingUserId,
      }),
      "EX",
      900,
    )
    return { heldId: held.id, state }
  }

  async function instagramRows() {
    return db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.connectionName, "instagram"),
          eq(connectedAccounts.identifier, IG_USER_ID),
        ),
      )
  }

  it("callback: a PERSONAL reconnect over an ORG-owned active connection is refused and leaves the org row active", async () => {
    // The unique index `connected_accounts_unique_active_idx` (org, app,
    // connection, identifier WHERE active) is not owner-scoped, so storing the
    // personal grant would have to retire the org's shared row. It used to, and
    // the org connection silently became one member's. Refuse instead.
    const { heldId, state } = await seedHeldRowAndPersonalState(
      { ownerType: "org", ownerId: null },
      userId,
    )

    const err = await handleOAuthCallback("ig-auth-code-personal", state).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectionHeldByOtherOwnerError)
    expect((err as ConnectionHeldByOtherOwnerError).heldBy).toBe("org")
    // A member (no admin scope on the connection) is told what THEY can do,
    // never to reconnect the shared connection.
    const message = (err as ConnectionHeldByOtherOwnerError).message
    expect(message).toContain("already connected for the whole organization")
    expect(message).toContain("ask an admin")
    expect(message).not.toContain("organization connection")
    // The refusal also lands in the person's attention feed: a committed
    // `connected_account:refuse` event the kernel translation turns into a
    // system alert for them (the redirect's toast is gone in seconds).
    const notices = extractRows<{ payload: Record<string, any> }>(
      await db.execute(drizzleSql`
        SELECT payload FROM kernel.pending_events
        WHERE org_id = ${orgId}
          AND payload->>'entity' = 'connected_account'
          AND payload->>'action' = 'refuse'
      `),
    )
    expect(notices).toHaveLength(1)
    expect(notices[0].payload.data.notifyUserId).toBe(userId)
    expect(notices[0].payload.data.reason).toBe("connect_refused")
    expect(notices[0].payload.data.summary).toContain("ask an admin")

    const rows = await instagramRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(heldId)
    expect(rows[0].ownerType).toBe("org")
    expect(rows[0].status).toBe("active")
    expect(rows[0].disconnectedAt).toBeNull()
    expect(
      decryptSecret(
        rows[0].accessTokenEncrypted!,
        env.ENCRYPTION_KEY,
        CryptoContext.connectedAccountAccessToken,
      ),
    ).toBe("HELD_TOKEN")
  })

  it("callback: a PERSONAL reconnect over ANOTHER member's personal connection is refused", async () => {
    const [other] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`ig-other-${randomUUID()}@test.com`}, 'Other', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    const { heldId, state } = await seedHeldRowAndPersonalState(
      { ownerType: "user", ownerId: other.id },
      userId,
    )

    const err = await handleOAuthCallback("ig-auth-code-other", state).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectionHeldByOtherOwnerError)
    expect((err as ConnectionHeldByOtherOwnerError).heldBy).toBe("user")

    const rows = await instagramRows()
    expect(rows.filter((r) => r.status === "active").map((r) => r.id)).toEqual([heldId])
  })

  it("callback: a PERSONAL reconnect supersedes the SAME owner's previous personal row", async () => {
    const { heldId, state } = await seedHeldRowAndPersonalState(
      { ownerType: "user", ownerId: userId },
      userId,
    )

    await handleOAuthCallback("ig-auth-code-own", state)

    const rows = await instagramRows()
    const active = rows.filter((r) => r.status === "active")
    expect(active).toHaveLength(1)
    expect(active[0].id).not.toBe(heldId)
    expect(active[0].ownerType).toBe("user")
    expect(active[0].ownerId).toBe(userId)
    expect(rows.find((r) => r.id === heldId)?.status).toBe("disconnected")
  })

  it("callback: an ORG reconnect supersedes the org's previous row (no duplicate-key error)", async () => {
    const { heldId } = await seedHeldRowAndPersonalState(
      { ownerType: "org", ownerId: null },
      userId,
    )
    const state = randomUUID()
    await redis.set(
      `${OAUTH_STATE_PREFIX}:${state}`,
      JSON.stringify({
        orgId,
        userId,
        appName: "social",
        connectionName: "instagram",
        codeVerifier: "unused-verifier",
        tokenUrl: shortTokenUrl,
        ownerType: "org",
        ownerId: null,
      }),
      "EX",
      900,
    )

    await handleOAuthCallback("ig-auth-code-org", state)

    const rows = await instagramRows()
    const active = rows.filter((r) => r.status === "active")
    expect(active).toHaveLength(1)
    expect(active[0].ownerType).toBe("org")
    expect(active[0].id).not.toBe(heldId)
    expect(rows.find((r) => r.id === heldId)?.status).toBe("disconnected")
  })

  it("describeConnectionAccounts: the org's rows and the caller's own, with owner, connector, health and expiry", async () => {
    await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
    const [other] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}, ${`ig-desc-${randomUUID()}@test.com`}, 'Someone Else', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    const expires = new Date(Date.now() + 3 * 24 * 3600 * 1000)
    const base = { orgId, appName: "social", providerType: "oauth2", createdBy: userId } as const
    await db.insert(connectedAccounts).values([
      {
        ...base,
        connectionName: "facebook",
        ownerType: "org",
        ownerId: null,
        identifier: "fb-org",
        status: "error",
        statusMessage: "refresh failed",
        tokenExpiresAt: expires,
        refreshTokenEncrypted: "opaque-refresh-ciphertext",
      },
      {
        ...base,
        connectionName: "facebook",
        ownerType: "user",
        ownerId: userId,
        identifier: "fb-mine",
        status: "active",
      },
      {
        ...base,
        connectionName: "facebook",
        ownerType: "user",
        ownerId: other.id,
        identifier: "fb-theirs",
        status: "active",
        createdBy: other.id,
      },
      {
        ...base,
        connectionName: "facebook",
        ownerType: "org",
        ownerId: null,
        identifier: "fb-old",
        status: "disconnected",
      },
      {
        ...base,
        connectionName: "instagram",
        ownerType: "org",
        ownerId: null,
        identifier: "ig-org",
        status: "active",
      },
    ])

    const rows = await describeConnectionAccounts(orgId, userId, "social", "facebook")
    const byId = new Map(rows.map((r) => [r.identifier, r]))
    expect([...byId.keys()].sort()).toEqual(["fb-mine", "fb-org"])
    expect(byId.get("fb-org")).toMatchObject({
      ownerType: "org",
      isMine: false,
      status: "error",
      statusMessage: "refresh failed",
      tokenExpiresAt: expires.toISOString(),
      connectedByName: "Installer",
      hasRefreshToken: true,
    })
    expect(byId.get("fb-mine")).toMatchObject({
      ownerType: "user",
      isMine: true,
      status: "active",
      hasRefreshToken: false,
    })
    // No secret column ever leaves the kernel.
    expect(JSON.stringify(rows)).not.toContain("Encrypted")
    expect(JSON.stringify(rows)).not.toContain("opaque-refresh-ciphertext")
    await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
  })

  it("callback (facebook-shaped): long-lived swap carries the short token as fb_exchange_token + client_id", async () => {
    // Facebook's fb_exchange_token grant differs from Instagram's ig_exchange_token:
    // the short-lived token rides under `fb_exchange_token` (not `access_token`) and
    // client_id is REQUIRED. Without this the FB token stays short-lived (~1-2h) and
    // the connection dies within hours (observed on Fabrikam prod: FB findings stopped
    // hours after each connect). Assert the request shape the two knobs produce.
    await db
      .insert(oauthProviders)
      .values({
        orgId,
        name: "social:facebook",
        issuerUrl: "https://app-connection.invalid/social:facebook",
        clientId: CLIENT_ID,
        clientSecretEncrypted: encryptSecret(
          CLIENT_SECRET,
          env.ENCRYPTION_KEY,
          CryptoContext.oauthProviderClientSecret,
        ),
      })
      .onConflictDoNothing()

    connectionConfigRegistry.set([orgId, "social", "facebook"], {
      type: "oauth2",
      authorizationUrl: "https://www.facebook.com/v21.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
      scopes: ["pages_read_engagement"],
      scopeSeparator: ",",
      longLivedTokenUrl: longTokenUrl,
      longLivedTokenGrantType: "fb_exchange_token",
      longLivedTokenParamName: "fb_exchange_token",
      longLivedIncludeClientId: true,
      allowedDomains: ["graph.facebook.com"],
    })

    const state = randomUUID()
    await redis.set(
      `${OAUTH_STATE_PREFIX}:${state}`,
      JSON.stringify({
        orgId,
        userId,
        appName: "social",
        connectionName: "facebook",
        codeVerifier: "unused-verifier",
        tokenUrl: shortTokenUrl,
        ownerType: "org",
        ownerId: null,
      }),
      "EX",
      900,
    )

    await handleOAuthCallback("fb-auth-code", state)

    // The long-lived exchange presented the short token under fb_exchange_token, WITH
    // client_id, and NOT under the instagram-style access_token param.
    expect(longRequestUrl).toContain("grant_type=fb_exchange_token")
    expect(longRequestUrl).toContain("fb_exchange_token=SHORT_IG_TOKEN")
    expect(longRequestUrl).toContain("client_id=ig-client-id")
    expect(longRequestUrl).toContain("client_secret=")
    expect(longRequestUrl).not.toContain("access_token=SHORT_IG_TOKEN")

    // The stored token is the long-lived one from the swap.
    const [row] = await db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, "social"),
          eq(connectedAccounts.connectionName, "facebook"),
        ),
      )
      .limit(1)
    expect(row.status).toBe("active")
    const stored = decryptSecret(
      row.accessTokenEncrypted!,
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountAccessToken,
    )
    expect(stored).toBe("LONG_IG_TOKEN")
  })

  it("callback (facebook-shaped): records the grant from grantedScopesUrl, so a missing permission is flagged", async () => {
    // Facebook's token response carries no `scope`, and the user may untick any
    // permission in the dialog. A grant without pages_manage_metadata left the
    // Page unsubscribed from webhooks while nothing told the operator to
    // reconnect, because no grant was ever recorded to compare against.
    let permissionsAuth = ""
    const permissionsServer = Bun.serve({
      port: 0,
      fetch: (req) => {
        permissionsAuth = req.headers.get("authorization") ?? ""
        return Response.json({
          data: [
            { permission: "pages_read_engagement", status: "granted" },
            { permission: "pages_manage_metadata", status: "declined" },
          ],
        })
      },
    })
    try {
      connectionConfigRegistry.set([orgId, "social", "facebook"], {
        type: "oauth2",
        authorizationUrl: "https://www.facebook.com/v21.0/dialog/oauth",
        tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
        scopes: ["pages_read_engagement", "pages_manage_metadata"],
        scopeSeparator: ",",
        longLivedTokenUrl: longTokenUrl,
        longLivedTokenGrantType: "fb_exchange_token",
        longLivedTokenParamName: "fb_exchange_token",
        longLivedIncludeClientId: true,
        grantedScopesUrl: `http://127.0.0.1:${permissionsServer.port}/me/permissions`,
        allowedDomains: ["graph.facebook.com"],
      })
      const state = randomUUID()
      await redis.set(
        `${OAUTH_STATE_PREFIX}:${state}`,
        JSON.stringify({
          orgId,
          userId,
          appName: "social",
          connectionName: "facebook",
          codeVerifier: "unused-verifier",
          tokenUrl: shortTokenUrl,
          ownerType: "org",
          ownerId: null,
        }),
        "EX",
        900,
      )

      await handleOAuthCallback("fb-auth-code-scopes", state)

      const [row] = await db
        .select()
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.orgId, orgId),
            eq(connectedAccounts.connectionName, "facebook"),
            eq(connectedAccounts.status, "active"),
          ),
        )
        .limit(1)
      // The lookup used the long-lived token, and only granted permissions count.
      expect(permissionsAuth).toBe("Bearer LONG_IG_TOKEN")
      expect(row.metadata).toEqual({ grantedOAuthScopes: ["pages_read_engagement"] })
      expect(classifyConnectionHealth(row)).toEqual({
        reason: "missing_scopes",
        missingScopes: ["pages_manage_metadata"],
      })
    } finally {
      permissionsServer.stop(true)
    }
  })

  it("callback (instagram-shaped): records the grant from the token response's permissions", async () => {
    const state = randomUUID()
    await redis.set(
      `${OAUTH_STATE_PREFIX}:${state}`,
      JSON.stringify({
        orgId,
        userId,
        appName: "social",
        connectionName: "instagram",
        codeVerifier: "unused-verifier",
        tokenUrl: shortTokenUrl,
        ownerType: "org",
        ownerId: null,
      }),
      "EX",
      900,
    )
    await handleOAuthCallback("ig-auth-code-scopes", state)
    const [row] = await db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.connectionName, "instagram"),
          eq(connectedAccounts.status, "active"),
        ),
      )
      .limit(1)
    expect(row.metadata).toEqual({ grantedOAuthScopes: ["instagram_business_basic"] })
  })

  // A Meta account has no email: its identifier is a numeric id, so without a
  // stored display name Settings shows "Unnamed account". The connection's
  // displayNameUrl/displayNameFields name it at connect and on reconcile.
  describe("account display name (displayNameUrl)", () => {
    let meServer: ReturnType<typeof Bun.serve> | null = null
    let meAuth = ""
    let meBody: Record<string, unknown> = {}
    let meStatus = 200
    let meHits = 0
    let meUrl = ""

    beforeAll(() => {
      meServer = Bun.serve({
        port: 0,
        fetch: (req) => {
          meHits++
          meAuth = req.headers.get("authorization") ?? ""
          return Response.json(meBody, { status: meStatus })
        },
      })
      meUrl = `http://127.0.0.1:${meServer.port}/me`
    })
    afterAll(() => {
      meServer?.stop(true)
    })

    async function connect(connectionName: string, code: string) {
      const state = randomUUID()
      await redis.set(
        `${OAUTH_STATE_PREFIX}:${state}`,
        JSON.stringify({
          orgId,
          userId,
          appName: "social",
          connectionName,
          codeVerifier: "unused-verifier",
          tokenUrl: shortTokenUrl,
          ownerType: "org",
          ownerId: null,
        }),
        "EX",
        900,
      )
      await handleOAuthCallback(code, state)
      const [row] = await db
        .select()
        .from(connectedAccounts)
        .where(
          and(
            eq(connectedAccounts.orgId, orgId),
            eq(connectedAccounts.connectionName, connectionName),
            eq(connectedAccounts.status, "active"),
          ),
        )
        .limit(1)
      return row
    }

    it("instagram: stores the account username as the display name at connect", async () => {
      connectionConfigRegistry.set([orgId, "social", "instagram"], {
        ...connectionConfigRegistry.get([orgId, "social", "instagram"])!,
        displayNameUrl: `${meUrl}?fields=username,name`,
        displayNameFields: ["username", "name"],
      })
      meBody = { id: IG_USER_ID, username: "brand.handle", name: "Brand" }
      const row = await connect("instagram", "ig-auth-code-name")
      expect(row.identifier).toBe(IG_USER_ID)
      expect(meAuth).toBe("Bearer LONG_IG_TOKEN")
      expect(row.displayName).toBe("brand.handle")
    })

    it("facebook: stores the managed Page names, else the user name, at connect", async () => {
      connectionConfigRegistry.set([orgId, "social", "facebook"], {
        type: "oauth2",
        authorizationUrl: "https://www.facebook.com/v21.0/dialog/oauth",
        tokenUrl: "https://graph.facebook.com/v21.0/oauth/access_token",
        scopes: ["pages_read_engagement"],
        scopeSeparator: ",",
        longLivedTokenUrl: longTokenUrl,
        longLivedTokenGrantType: "fb_exchange_token",
        longLivedTokenParamName: "fb_exchange_token",
        longLivedIncludeClientId: true,
        displayNameUrl: meUrl,
        displayNameFields: ["accounts.data[].name", "name"],
        allowedDomains: ["graph.facebook.com"],
      })
      meBody = {
        id: "1000000001",
        name: "Pat Admin",
        accounts: {
          data: [
            { id: "2001", name: "Acme Studio" },
            { id: "2002", name: "Acme Shop" },
          ],
        },
      }
      const row = await connect("facebook", "fb-auth-code-name")
      expect(row.displayName).toBe("Acme Studio, Acme Shop")

      meBody = { id: "1000000001", name: "Pat Admin", accounts: { data: [] } }
      const again = await connect("facebook", "fb-auth-code-name-2")
      expect(again.displayName).toBe("Pat Admin")
    })

    it("a failed name lookup still connects, without a name", async () => {
      meBody = {}
      const row = await connect("instagram", "ig-auth-code-noname")
      expect(row.status).toBe("active")
      expect(row.displayName).toBeNull()
    })

    it("reconcile names an existing unnamed connection", async () => {
      await db
        .update(connectedAccounts)
        .set({ displayName: null })
        .where(and(eq(connectedAccounts.orgId, orgId), eq(connectedAccounts.status, "active")))
      meBody = { id: IG_USER_ID, username: "renamed.handle" }
      const { reconciled } = await reconcileAppConnections(orgId, userId, "social", "instagram")
      expect(reconciled.length).toBe(1)
      const [row] = await db
        .select()
        .from(connectedAccounts)
        .where(eq(connectedAccounts.id, reconciled[0].id))
      expect(row.displayName).toBe("renamed.handle")
    })

    // An account connected before its connection declared the lookup heals on
    // the read path: listing it for Settings looks its name up in the background.
    it("listing an unnamed account names it; a failed lookup waits out its cooldown", async () => {
      resetAccountNameLookupCooldowns()
      await db
        .update(connectedAccounts)
        .set({ displayName: null })
        .where(
          and(
            eq(connectedAccounts.orgId, orgId),
            eq(connectedAccounts.connectionName, "instagram"),
            eq(connectedAccounts.status, "active"),
          ),
        )
      const unnamed = await describeConnectionAccounts(orgId, userId, "social", "instagram")
      expect(unnamed.length).toBeGreaterThan(0)
      expect(unnamed.every((a) => a.displayName === null)).toBe(true)

      // The provider fails: nothing throws, nothing is stored, and the next
      // views within the cooldown do not ask the provider again.
      meStatus = 500
      meHits = 0
      await healUnnamedConnectionAccounts(orgId, "social", "instagram", unnamed)
      expect(meHits).toBe(unnamed.length)
      await healUnnamedConnectionAccounts(orgId, "social", "instagram", unnamed)
      expect(meHits).toBe(unnamed.length)
      const still = await describeConnectionAccounts(orgId, userId, "social", "instagram")
      expect(still.every((a) => a.displayName === null)).toBe(true)

      // Past the cooldown the provider answers: the next listing has the name.
      resetAccountNameLookupCooldowns()
      meStatus = 200
      meBody = { id: IG_USER_ID, username: "healed.handle" }
      await healUnnamedConnectionAccounts(orgId, "social", "instagram", still)
      const named = await describeConnectionAccounts(orgId, userId, "social", "instagram")
      expect(named.every((a) => a.displayName === "healed.handle")).toBe(true)

      // A named account is never looked up again, and its name is never cleared.
      meHits = 0
      meBody = {}
      await healUnnamedConnectionAccounts(orgId, "social", "instagram", named)
      expect(meHits).toBe(0)
    })
  })
})

// A Facebook Login for Business configuration (Meta's Unified login): the
// authorize request carries the deployment's configuration id from the app's
// config, and the account comes from a follow-up listing that can hold several.
describe("kernel OAuth2: authorizeConfigParams + identifierFromUserinfoPath", () => {
  let accountsServer: ReturnType<typeof Bun.serve> | null = null
  let accountsBody: unknown = {}
  let accountsAuth = ""

  beforeAll(async () => {
    await db
      .insert(oauthProviders)
      .values({
        orgId,
        name: "social:configured",
        issuerUrl: "https://app-connection.invalid/social:configured",
        clientId: CLIENT_ID,
        clientSecretEncrypted: encryptSecret(
          CLIENT_SECRET,
          env.ENCRYPTION_KEY,
          CryptoContext.oauthProviderClientSecret,
        ),
      })
      .onConflictDoNothing()
    accountsServer = Bun.serve({
      port: 0,
      fetch: (req) => {
        accountsAuth = req.headers.get("authorization") ?? ""
        return Response.json(accountsBody)
      },
    })
    connectionConfigRegistry.set([orgId, "social", "configured"], {
      type: "oauth2",
      authorizationUrl: "https://www.facebook.com/v26.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v26.0/oauth/access_token",
      scopes: [],
      usePkce: false,
      extraParams: { override_default_response_type: "true" },
      authorizeConfigParams: {
        config_id: { configKey: "loginConfigurationId", pattern: "^[0-9]{1,30}$" },
      },
      userinfoUrl: `http://127.0.0.1:${accountsServer.port}/me/assigned_accounts?fields=id,username`,
      identifierFromUserinfoPath: "data[].id",
      accountNameField: "username",
      allowedDomains: ["graph.facebook.com", "www.facebook.com"],
    })
  })

  afterAll(() => {
    accountsServer?.stop(true)
  })

  async function setAppConfig(config: Record<string, unknown> | null) {
    await db
      .update(apps)
      .set({ config })
      .where(and(eq(apps.orgId, orgId), eq(apps.name, "social")))
  }

  async function seedState(accountChoice?: string): Promise<string> {
    const state = randomUUID()
    await redis.set(
      `${OAUTH_STATE_PREFIX}:${state}`,
      JSON.stringify({
        orgId,
        userId,
        appName: "social",
        connectionName: "configured",
        codeVerifier: "unused-verifier",
        tokenUrl: shortTokenUrl,
        ownerType: "org",
        ownerId: null,
        ...(accountChoice ? { accountChoice } : {}),
      }),
      "EX",
      900,
    )
    return state
  }

  async function configuredRows() {
    return db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.connectionName, "configured"),
          eq(connectedAccounts.status, "active"),
        ),
      )
  }

  it("start: refuses while the configuration id is not set, then sends it with the fixed extras", async () => {
    await setAppConfig(null)
    const refused = await startOAuthFlow(orgId, userId, "social", "configured", {
      ownerType: "org",
    }).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(OAuthStartRefusedError)
    expect((refused as OAuthStartRefusedError).code).toBe("missing_setting")
    expect((refused as OAuthStartRefusedError).message).toContain("loginConfigurationId")

    await setAppConfig({ loginConfigurationId: "1&scope=everything" })
    const invalid = await startOAuthFlow(orgId, userId, "social", "configured", {
      ownerType: "org",
    }).catch((e: unknown) => e)
    expect((invalid as OAuthStartRefusedError).code).toBe("missing_setting")

    await setAppConfig({ loginConfigurationId: "1667793288221018" })
    const url = new URL(
      await startOAuthFlow(orgId, userId, "social", "configured", { ownerType: "org" }),
    )
    expect(url.searchParams.get("config_id")).toBe("1667793288221018")
    expect(url.searchParams.get("override_default_response_type")).toBe("true")
    expect(url.searchParams.get("response_type")).toBe("code")
    // No scopes declared: the configuration carries them, `scope` is not sent.
    expect(url.searchParams.get("scope")).toBeNull()
  })

  it("callback: one account at the path is the identifier, named from the same entry", async () => {
    accountsBody = { data: [{ id: "17841400000000101", username: "brand_one" }] }
    await handleOAuthCallback("code-one", await seedState())
    const rows = await configuredRows()
    expect(rows.map((r) => [r.identifier, r.displayName])).toEqual([
      ["17841400000000101", "brand_one"],
    ])
    expect(accountsAuth).toBe("Bearer SHORT_IG_TOKEN")
    await db.delete(connectedAccounts).where(eq(connectedAccounts.connectionName, "configured"))
  })

  it("callback: several accounts and no choice stores nothing and names them", async () => {
    accountsBody = {
      data: [
        { id: "17841400000000101", username: "brand_one" },
        { id: "17841400000000102", username: "brand_two" },
      ],
    }
    const err = await handleOAuthCallback("code-two", await seedState()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OAuthAccountChoiceError)
    expect((err as OAuthAccountChoiceError).code).toBe("account_choice_required")
    expect((err as OAuthAccountChoiceError).message).toContain("brand_one (17841400000000101)")
    expect((err as OAuthAccountChoiceError).message).toContain("brand_two (17841400000000102)")
    expect(await configuredRows()).toEqual([])
  })

  it("callback: several accounts and the flow started for one connects that one", async () => {
    await handleOAuthCallback("code-three", await seedState("17841400000000102"))
    const rows = await configuredRows()
    expect(rows.map((r) => [r.identifier, r.displayName])).toEqual([
      ["17841400000000102", "brand_two"],
    ])
    // A system-user token without expires_in never expires and never refreshes.
    expect(rows[0].tokenExpiresAt).toBeNull()
    await db.delete(connectedAccounts).where(eq(connectedAccounts.connectionName, "configured"))
  })

  it("callback: no account at the path stores nothing", async () => {
    accountsBody = { data: [] }
    const err = await handleOAuthCallback("code-four", await seedState()).catch((e: unknown) => e)
    expect((err as Error).message).toContain("gave access to no account")
    expect(await configuredRows()).toEqual([])
  })
})
