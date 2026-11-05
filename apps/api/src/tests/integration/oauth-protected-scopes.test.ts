// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Protected scopes (connections/protected-scopes.ts): a scope the provider grants
// only after approving the app (Shopify's read_all_orders) is requested by the
// OAuth start only when the org opted in through the app's settings toggle, or
// when the store being reconnected already holds it. Otherwise the authorize
// request leaves it out, so a store whose app was never approved still connects.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql, eq } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { apps, connectedAccounts } from "~/db/schema/kernel"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import { connectionConfigRegistry, resetAppRegistries } from "~/modules/apps/app-registries"
import { startOAuthFlow } from "~/modules/apps/connections/service"

type ShopifyInstanceVars = { SHOPIFY_APP_CLIENT_ID?: string; SHOPIFY_APP_CLIENT_SECRET?: string }
const mutableEnv = env as ShopifyInstanceVars
const saved = { ...mutableEnv }

const BASE_SCOPES = ["read_orders", "write_orders"]

let orgId: string
let userId: string

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'Protected scopes org', ${`protected-scopes-${suffix}`})
      RETURNING id
    `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}, ${`protected-scopes-${suffix}@test.com`}, 'Admin', 'active', 'hash', 1, 1)
      RETURNING id
    `),
  )
  userId = user.id
  await db
    .insert(apps)
    .values({ orgId, name: "shopify", version: "1.0.0", config: null })
    .onConflictDoNothing()
  connectionConfigRegistry.set([orgId, "shopify", "shop"], {
    type: "oauth2",
    authorizationUrl: "https://{shop}/admin/oauth/authorize",
    tokenUrl: "https://{shop}/admin/oauth/access_token",
    scopes: BASE_SCOPES,
    protectedScopes: [{ scope: "read_all_orders", setting: "fullOrderHistory" }],
    scopeSeparator: ",",
    allowedDomains: ["*.myshopify.com"],
    templateVars: {
      shop: {
        lowercase: true,
        pattern: "^[a-z0-9][a-z0-9-]*(\\.myshopify\\.com)?$",
        appendSuffix: ".myshopify.com",
      },
    },
    identifierVar: "shop",
  })
  mutableEnv.SHOPIFY_APP_CLIENT_ID = "instance-client-id"
  mutableEnv.SHOPIFY_APP_CLIENT_SECRET = "instance-client-secret"
})

afterEach(async () => {
  await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
  await db.execute(
    drizzleSql`UPDATE kernel.organizations SET settings = settings - 'shopify' WHERE id = ${orgId}::uuid`,
  )
})

afterAll(async () => {
  mutableEnv.SHOPIFY_APP_CLIENT_ID = saved.SHOPIFY_APP_CLIENT_ID
  mutableEnv.SHOPIFY_APP_CLIENT_SECRET = saved.SHOPIFY_APP_CLIENT_SECRET
  resetAppRegistries()
  await db.delete(connectedAccounts).where(eq(connectedAccounts.orgId, orgId))
  await db.delete(apps).where(eq(apps.orgId, orgId))
  await db.execute(drizzleSql`DELETE FROM kernel.users WHERE org_id = ${orgId}::uuid`)
  await db.execute(drizzleSql`DELETE FROM kernel.organizations WHERE id = ${orgId}::uuid`)
})

/** The scopes the authorize URL asks for when `shop` (re)connects. */
async function requestedScopes(shop: string): Promise<string[]> {
  const url = await startOAuthFlow(orgId, userId, "shopify", "shop", { ownerType: "org", shop })
  return (new URL(url).searchParams.get("scope") ?? "").split(",")
}

async function optIn(): Promise<void> {
  await db.execute(drizzleSql`
    UPDATE kernel.organizations
    SET settings = jsonb_set(settings, '{shopify}', '{"fullOrderHistory": true}'::jsonb)
    WHERE id = ${orgId}::uuid
  `)
}

async function seedAccount(identifier: string, metadata: Record<string, unknown> | null) {
  await db.insert(connectedAccounts).values({
    orgId,
    appName: "shopify",
    connectionName: "shop",
    ownerType: "org",
    ownerId: null,
    providerType: "oauth2",
    identifier,
    accessTokenEncrypted: encryptSecret(
      "shpat_test",
      env.ENCRYPTION_KEY,
      CryptoContext.connectedAccountAccessToken,
    ),
    status: "active",
    createdBy: userId,
    metadata,
  })
}

describe("OAuth start: protected scopes", () => {
  it("leaves read_all_orders out when the org did not opt in and the store holds no grant", async () => {
    expect(await requestedScopes("fresh-store")).toEqual(BASE_SCOPES)
  })

  it("asks for read_all_orders once the org turned on full order history", async () => {
    await optIn()
    expect(await requestedScopes("fresh-store")).toEqual([...BASE_SCOPES, "read_all_orders"])
  })

  it("keeps read_all_orders when the store being reconnected already holds it", async () => {
    await seedAccount("held-store.myshopify.com", {
      grantedOAuthScopes: ["write_orders", "read_all_orders"],
    })
    expect(await requestedScopes("held-store")).toEqual([...BASE_SCOPES, "read_all_orders"])
    // Another store of the same org does not inherit that grant.
    expect(await requestedScopes("other-store")).toEqual(BASE_SCOPES)
  })

  it("leaves it out on reconnect when the recorded grant lacks it", async () => {
    await seedAccount("window-store.myshopify.com", { grantedOAuthScopes: ["write_orders"] })
    expect(await requestedScopes("window-store")).toEqual(BASE_SCOPES)
  })

  it("keeps it for a store whose grant was never recorded", async () => {
    await seedAccount("legacy-store.myshopify.com", null)
    expect(await requestedScopes("legacy-store")).toEqual([...BASE_SCOPES, "read_all_orders"])
  })
})
