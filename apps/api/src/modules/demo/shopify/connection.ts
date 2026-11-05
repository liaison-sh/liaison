// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Installing the demo org's Shopify connection.
//
// `home_load` and every Shopify read resolve the shop domain off a
// `kernel.connected_accounts` row, so a demo org needs one or its whole commerce
// surface renders as "not connected". Demo mode REFUSES connections
// (`createCredentialConnection` and `startOAuthFlow` both throw for a demo org),
// which is the right default and stays exactly as it is: this function is not
// that path and does not weaken it.
//
// WHY A VISITOR CANNOT TURN THIS INTO A REAL CONNECTION
//
//   1. This function is not reachable from outside. It is called by the demo
//      SEEDER and by nothing else: no route mounts it, no sandbox bridge method
//      exposes it, no tool wraps it. `shopify-boundary.test.ts` asserts that.
//   2. It takes no credential and no shop. The domain is the fixed constant in
//      sentinel.ts and the token is the fixed sentinel, so a caller who controls
//      every argument still cannot point a demo org at a real store or store a
//      real secret.
//   3. The visitor-facing doors stay shut. `createCredentialConnection` and
//      `startOAuthFlow` refuse a demo org whether or not it already has this
//      row, so a visitor cannot re-connect over it with a real token.
//   4. Even a real token would be inert. For a demo org, `*.myshopify.com` is
//      answered from fixtures or refused, never put on the wire (provider.ts).
//
// The row is org-owned, which is why it is written through the privileged
// handle: the `connected_accounts` RLS policies make an org-owned, non-kernel
// insert impossible under `liaison_rls` (the same reason
// `createCredentialConnection` documents for its org-owned callers).
import { sql as drizzleSql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { DEMO_SHOP_DOMAIN, DEMO_SHOP_NAME, DEMO_SHOPIFY_SENTINEL_TOKEN } from "./sentinel"

/** The app and connection the bundled Shopify app resolves its client from. */
const APP_NAME = "shopify"
const CONNECTION_NAME = "shop"

export interface DemoShopifyConnection {
  connectionId: string
  shopDomain: string
}

/**
 * Give `orgId` the demo Shopify store, and reset whatever the previous tenant of
 * that org id had written to it.
 *
 * Idempotent: a second call reuses the existing row (so the id anything else
 * recorded stays valid) and refreshes the sentinel.
 */
export async function installDemoShopifyConnection(opts: {
  orgId: string
  /** The seeded admin, for `created_by`. */
  createdByUserId: string
}): Promise<DemoShopifyConnection> {
  const encrypted = encryptSecret(
    DEMO_SHOPIFY_SENTINEL_TOKEN,
    process.env.ENCRYPTION_KEY ?? "",
    CryptoContext.connectedAccountAccessToken,
  )
  const k = drizzleSql.raw(schemaRef("kernel"))
  const metadata = JSON.stringify({
    demo: true,
    fixtureProvider: "liaison-demo-shopify",
    note: "Demo fixtures. No real store, no real credential.",
  })

  const connectionId = await withPrivilegedDb(opts.orgId, "install-demo-shopify", async (tx) => {
    const result = await tx.execute(drizzleSql`
      INSERT INTO ${k}.connected_accounts
        (org_id, app_name, connection_name, owner_type, owner_id, provider_type,
         identifier, display_name, access_token_encrypted, token_expires_at,
         metadata, status, created_by)
      VALUES
        (${opts.orgId}::uuid, ${APP_NAME}, ${CONNECTION_NAME}, 'org', NULL, 'oauth2',
         ${DEMO_SHOP_DOMAIN}, ${DEMO_SHOP_NAME}, ${encrypted}, NULL,
         ${metadata}::jsonb, 'active', ${opts.createdByUserId}::uuid)
      ON CONFLICT (org_id, app_name, connection_name, identifier, owner_type)
        WHERE status = 'active'
      DO UPDATE SET
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        display_name = EXCLUDED.display_name,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    const row = rows[0] as { id?: string } | undefined
    if (!row?.id) throw new Error("demo Shopify connection was not written")
    return row.id
  })

  // A re-seed is a fresh store. Anything the previous occupant of this org id
  // tagged, shipped or refunded goes with it, on every process.
  const { forgetDemoShopifyStore } = await import("./replica")
  await forgetDemoShopifyStore(opts.orgId)

  return { connectionId, shopDomain: DEMO_SHOP_DOMAIN }
}
