// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Deep-review cluster 3 — production Shopify OAuth must establish the connection.
//
// The shipped `handleOAuthCallback` stored `identifier = userId` (a Liaison UUID)
// for every provider. Shopify provides no id_token/userinfo email, so the stored
// identifier never matched `SHOPIFY_DOMAIN_RE` (`<shop>.myshopify.com`) and the
// app's `onConnectionEstablished` handler dropped the event — webhook
// subscriptions were never registered. This test drives the REAL callback path
// for a Shopify-shaped provider (no id_token, `?shop=` on the callback) against
// the real privileged DB and asserts:
//   1. the persisted connection `identifier` matches SHOPIFY_DOMAIN_RE, and
//   2. the webhook signing secret is persisted into `apps.config` so the
//      sandboxed HMAC verifier's `config_get("shopifyWebhookSecret")` is
//      non-null in production (deep-review cluster 2 item 2).
//   3. the callback is checked before any code is exchanged: Shopify's hmac
//      (keyed with the client secret) must be present and right, and its
//      `shop` must name the store the flow was started for. The stored
//      identifier always comes from the state, never from the query.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { and, sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { apps, connectedAccounts, oauthProviders } from "~/db/schema/kernel"
import { CryptoContext, decryptSecret, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import {
  connectionConfigRegistry,
  initializedOrgRuntimes,
  resetAppRegistries,
} from "~/modules/apps/app-registries"
import { handleOAuthCallback, OAuthCallbackRefusedError } from "~/modules/apps/connections/service"
import { resetOrgRuntimeForTest } from "~/tests/helpers/org-runtime"

// Matches the app-side `SHOPIFY_DOMAIN_RE` in bundled-apps/shopify/src/connection.ts.
const SHOPIFY_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i
const OAUTH_STATE_PREFIX = "oauth:state"
const CLIENT_SECRET = "shpss_test_webhook_signing_secret"

let orgId: string
let userId: string
let tokenServer: ReturnType<typeof Bun.serve> | null = null
let tokenUrl: string
/** How many times the token endpoint was asked: a refused callback asks nothing. */
let exchanges = 0

/** The callback's parameters, signed as Shopify signs them (or with `hmac` overridden). */
function signed(params: Record<string, string>, hmac?: string): Record<string, string> {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&")
  return {
    ...params,
    hmac: hmac ?? createHmac("sha256", CLIENT_SECRET).update(message).digest("hex"),
  }
}

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Shopify OAuth Test Org', ${`shopify-oauth-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`shopify-oauth-${suffix}@test.com`}, 'Installer', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user.id

  // The Shopify app must already be installed before OAuth runs — seed a row
  // (config null) so the secret-persist path UPDATEs an existing row.
  await db
    .insert(apps)
    .values({ orgId, name: "shopify", version: "1.0.0", config: null })
    .onConflictDoNothing()

  // Seed the OAuth provider credentials (the fallback `resolveOAuthClientConfig`
  // path). For Shopify the client secret doubles as the webhook signing secret.
  await db.insert(oauthProviders).values({
    orgId,
    name: "shopify:shop",
    issuerUrl: "https://test-store.myshopify.com",
    clientId: "shopify-client-id",
    clientSecretEncrypted: encryptSecret(
      CLIENT_SECRET,
      env.ENCRYPTION_KEY,
      CryptoContext.oauthProviderClientSecret,
    ),
  })

  // Stand up a local token endpoint that mimics Shopify: returns an access
  // token, NO id_token, NO userinfo. fetchWithRedirectValidation allows private
  // hosts in test mode for the token exchange.
  tokenServer = Bun.serve({
    port: 0,
    fetch: () => {
      exchanges++
      return new Response(
        JSON.stringify({ access_token: "shpat_test_offline_token", token_type: "bearer" }),
        {
          headers: { "content-type": "application/json" },
        },
      )
    },
  })
  tokenUrl = `http://127.0.0.1:${tokenServer.port}/admin/oauth/access_token`

  connectionConfigRegistry.set([orgId, "shopify", "shop"], {
    type: "oauth2",
    authorizationUrl: "https://test-store.myshopify.com/admin/oauth/authorize",
    tokenUrl,
    scopes: ["read_orders"],
    allowedDomains: ["*.myshopify.com"],
    // Declarative normalization, mirroring the bundled Shopify manifest.
    templateVars: {
      shop: {
        lowercase: true,
        pattern: "^[a-z0-9][a-z0-9-]*(\\.myshopify\\.com)?$",
        appendSuffix: ".myshopify.com",
      },
    },
    identifierVar: "shop",
    callbackSignature: "hmac-sha256-query",
    clientSecretConfigKey: "shopifyWebhookSecret",
  })
})

afterAll(async () => {
  tokenServer?.stop(true)
  resetAppRegistries()
  await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
  await db.delete(oauthProviders).where(eq(oauthProviders.orgId, orgId))
  await db.delete(apps).where(eq(apps.orgId, orgId))
})

async function seedState(shopDomain: string | null): Promise<string> {
  const state = randomUUID()
  await redis.set(
    `${OAUTH_STATE_PREFIX}:${state}`,
    JSON.stringify({
      orgId,
      userId,
      appName: "shopify",
      connectionName: "shop",
      codeVerifier: "test-verifier",
      tokenUrl,
      ownerType: "org",
      ownerId: null,
      shopDomain,
    }),
    "EX",
    900,
  )
  return state
}

describe("Shopify OAuth callback establishes a shop-domain connection", () => {
  it("stores the shop the flow started for when the signed callback names the same one", async () => {
    const state = await seedState("callback-store.myshopify.com")
    await handleOAuthCallback(
      "auth-code-1",
      state,
      signed({ code: "auth-code-1", shop: "CALLBACK-STORE.myshopify.com", state, timestamp: "1" }),
    )

    const [row] = await db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, "shopify"),
          eq(connectedAccounts.identifier, "callback-store.myshopify.com"),
        ),
      )
      .limit(1)

    expect(row).toBeDefined()
    expect(SHOPIFY_DOMAIN_RE.test(row.identifier)).toBe(true)
  })

  it("uses the shop carried through OAuth state and persists the webhook secret", async () => {
    const state = await seedState("state-store.myshopify.com")
    // No ?shop= on the callback: the state names the store.
    await handleOAuthCallback("auth-code-2", state, signed({ code: "auth-code-2", state }))

    const [row] = await db
      .select()
      .from(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.orgId, orgId),
          eq(connectedAccounts.appName, "shopify"),
          eq(connectedAccounts.identifier, "state-store.myshopify.com"),
        ),
      )
      .limit(1)
    expect(row).toBeDefined()
    expect(SHOPIFY_DOMAIN_RE.test(row.identifier)).toBe(true)

    // The signing secret (= client secret) is now readable via apps.config —
    // this is exactly what the sandboxed HMAC verifier's config_get reads.
    const [appRow] = await db
      .select()
      .from(apps)
      .where(and(eq(apps.orgId, orgId), eq(apps.name, "shopify")))
      .limit(1)
    const config = appRow.config as { shopifyWebhookSecret?: string } | null
    // The secret is mirrored ENCRYPTED-at-rest (AAD-bound to appConfigConnectionSecret,
    // decrypted only at the config_get bridges). Assert it round-trips to the client
    // secret the sandboxed HMAC verifier ultimately reads.
    expect(config?.shopifyWebhookSecret).toBeDefined()
    expect(
      decryptSecret(
        config!.shopifyWebhookSecret!,
        env.ENCRYPTION_KEY,
        CryptoContext.appConfigConnectionSecret,
      ),
    ).toBe(CLIENT_SECRET)
  })

  it("never takes the shop from the query: a state without one is refused", async () => {
    const state = await seedState(null)
    await expect(
      handleOAuthCallback(
        "auth-code-3",
        state,
        signed({ code: "auth-code-3", shop: "callback-store.myshopify.com", state }),
      ),
    ).rejects.toThrow(/could not resolve a connection identifier/)
  })

  it("refuses a callback naming another shop than the flow started for, before any exchange", async () => {
    const before = exchanges
    const state = await seedState("victim-store.myshopify.com")
    await expect(
      handleOAuthCallback(
        "auth-code-4",
        state,
        signed({ code: "auth-code-4", shop: "attacker-store.myshopify.com", state }),
      ),
    ).rejects.toBeInstanceOf(OAuthCallbackRefusedError)
    expect(exchanges).toBe(before)
    const rows = await db
      .select()
      .from(connectedAccounts)
      .where(eq(connectedAccounts.identifier, "attacker-store.myshopify.com"))
    expect(rows).toHaveLength(0)
  })

  it("refuses a callback whose hmac is missing or wrong, before any exchange", async () => {
    const before = exchanges
    const missing = await seedState("hmac-store.myshopify.com")
    await expect(
      handleOAuthCallback("auth-code-5", missing, {
        code: "auth-code-5",
        shop: "hmac-store.myshopify.com",
        state: missing,
      }),
    ).rejects.toBeInstanceOf(OAuthCallbackRefusedError)
    const wrong = await seedState("hmac-store.myshopify.com")
    await expect(
      handleOAuthCallback(
        "auth-code-6",
        wrong,
        signed(
          { code: "auth-code-6", shop: "hmac-store.myshopify.com", state: wrong },
          "ab".repeat(32),
        ),
      ),
    ).rejects.toBeInstanceOf(OAuthCallbackRefusedError)
    // Signed, then one parameter changed after signing.
    const tampered = await seedState("hmac-store.myshopify.com")
    const params = signed({
      code: "auth-code-7",
      shop: "hmac-store.myshopify.com",
      state: tampered,
    })
    await expect(
      handleOAuthCallback("auth-code-7", tampered, { ...params, timestamp: "2" }),
    ).rejects.toBeInstanceOf(OAuthCallbackRefusedError)
    expect(exchanges).toBe(before)
  })
})

// Boot registers no org: the unauthenticated callback may be the first touch
// of its org in this process. It sets the org up before it reads the
// connection declaration from the org's registries, so a fresh process does
// not see the connection as undeclared.
describe("OAuth callback: first touch of an org not set up in this process", () => {
  let freshOrgId: string
  let freshUserId: string

  beforeAll(async () => {
    const suffix = randomUUID()
    const [org] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.organizations (id, name, slug)
        VALUES (gen_random_uuid(), 'OAuth First Touch Org', ${`oauth-first-touch-${suffix}`})
        RETURNING id
      `),
    )
    freshOrgId = org.id
    const [user] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${freshOrgId}, ${`oauth-first-touch-${suffix}@test.com`}, 'Installer', 'active', 'hash', 1, 1)
        RETURNING id
      `),
    )
    freshUserId = user.id
  })

  afterAll(() => {
    resetOrgRuntimeForTest(freshOrgId)
  })

  it("sets the org up before reading its connection declaration", async () => {
    expect(initializedOrgRuntimes.has(freshOrgId)).toBe(false)
    expect(connectionConfigRegistry.get([freshOrgId, "shopify", "shop"])).toBeUndefined()
    const state = randomUUID()
    await redis.set(
      `${OAUTH_STATE_PREFIX}:${state}`,
      JSON.stringify({
        orgId: freshOrgId,
        userId: freshUserId,
        appName: "shopify",
        connectionName: "shop",
        codeVerifier: "test-verifier",
        tokenUrl,
        ownerType: "org",
        ownerId: null,
        shopDomain: "first-touch.myshopify.com",
      }),
      "EX",
      900,
    )
    // The grant itself may stop later (no provider credentials for this org);
    // what matters is that the org's setup ran first.
    await handleOAuthCallback("auth-code-ft", state, { code: "auth-code-ft", state }).catch(
      () => undefined,
    )
    expect(initializedOrgRuntimes.has(freshOrgId)).toBe(true)
  })
})
