// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The fake Shopify Admin API (LIAISON_TEST_SHOPIFY_ADMIN_URL) and the invoicing
// app, through the real path. Invoicing never calls a store itself: its Shopify
// reads and writes (the order fetch of an order import, draft orders of a quote,
// variants and products for customs, the order searches of the buyer check) are
// cross-app calls to the Shopify app's tools, which run in the Shopify app's own
// sandbox, so they reach the store through the one rewrite of the Shopify app's
// egress (bridge/shopify-fake-admin.ts), under the same gate. Its own allowlist
// names no store and no box address, gate on or off.
//
// A paid order arrives as a real signed webhook at the real route, the outbox
// hands it to invoicing's real subscriber, and its order fetch goes out through
// the real egress bridge. The fake is a real HTTP server on 127.0.0.1, and no
// egress override is installed for the "on" case, so a request reaches the fake
// only because the bridge sent it there.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { createHmac, randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { flushEventHandlers } from "~/infra/events/event-bus"
import { processOutboxBatch } from "~/infra/events/outbox-worker"
import { CryptoContext, encryptSecret } from "~/lib/crypto"
import { env } from "~/lib/env"
import type { ShopifyFakeAdminGateInput } from "~/lib/shopify-fake-admin-gate"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { createEgressMethods } from "~/modules/apps/sandbox/bridge/egress"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { ShopifyFakeAdminTestAccess } from "~/modules/apps/sandbox/bridge/shopify-fake-admin"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { acquireTestLock, clearRedisPatterns, releaseTestLock } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const SHOP_DOMAIN = "fake-admin-invoicing-store.myshopify.com"
const SHOP_TOKEN = "shpat_fake_admin_invoicing_token_0123456789"
const WEBHOOK_SECRET = "shpss_fake_admin_invoicing_secret"
const ORG = "00000000-0000-4000-8000-0000000fa101"
const USER = "00000000-0000-4000-8000-0000000fa102"

function manifestOf(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
}

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = manifestOf(name)
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, version, "bundle.js"),
  }
}

/** One request the fake received. */
interface FakeHit {
  path: string
  operation: string
  orderId: string | null
  token: string | null
  shop: string | null
}

/** One request that went toward the store itself (gate off), caught where the transport sits. */
interface WireHit {
  url: string
  operation: string
  token: string | null
}

let fakeHits: FakeHit[] = []
let wireHits: WireHit[] = []

function operationOf(query: string): string {
  const named = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query)
  if (named) return named[1]!
  const field = /\{\s*([A-Za-z0-9_]+)/.exec(query)
  return field ? field[1]! : "unknown"
}

/** The fake's answers: an order fetch finds no order, so the import goes on with the webhook's. */
function answer(query: string): unknown {
  if (/\border\s*\(/.test(query)) return { order: null }
  return {}
}

let server: ReturnType<typeof Bun.serve>
let fakeOrigin = ""

const ON = (): ShopifyFakeAdminGateInput => ({
  value: fakeOrigin,
  declaredPrivate: true,
  baseUrl: "http://127.0.0.1:3000",
  managed: false,
})

/** A real instance: the setting present, the box neither labelled private nor loopback. */
const OFF_PUBLIC = (): ShopifyFakeAdminGateInput => ({
  value: fakeOrigin,
  declaredPrivate: false,
  baseUrl: "https://liaison.example.com",
  managed: false,
})

function recordTheWire(): void {
  SandboxBridgeTestAccess.setFetchInterceptsHost((host) => host.endsWith(".myshopify.com"))
  SandboxBridgeTestAccess.setFetch((async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string }
    wireHits.push({
      url: String(url),
      operation: operationOf(body.query ?? ""),
      token: headers["X-Shopify-Access-Token"] ?? null,
    })
    return new Response(JSON.stringify({ data: answer(body.query ?? "") }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch)
}

function paidOrder(id: number): Record<string, unknown> {
  return {
    id,
    name: `#FA-${id}`,
    currency: "EUR",
    total_price: "40.00",
    financial_status: "paid",
    customer: {
      id: 72001,
      email: "buyer@fake-admin-invoicing.example",
      first_name: "Fake",
      last_name: "Buyer",
    },
    billing_address: {
      address1: "1 rue Exemple",
      zip: "75002",
      city: "Paris",
      country_code: "FR",
    },
    line_items: [{ id: id + 1, variant_id: 93001, title: "Widget", quantity: 1, price: "40.00" }],
  }
}

/** A paid order arrives as a signed webhook; the outbox hands it to invoicing's subscriber. */
async function importOrder(id: number): Promise<void> {
  const body = JSON.stringify(paidOrder(id))
  const res = await app.request(`/webhooks/${ORG}/shopify/orders-create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-shopify-hmac-sha256": createHmac("sha256", WEBHOOK_SECRET)
        .update(body, "utf8")
        .digest("base64"),
      "x-shopify-webhook-id": `fake-admin-invoicing-${randomUUID()}`,
      "x-shopify-shop-domain": SHOP_DOMAIN,
    },
    body,
  })
  expect(res.status).toBe(200)
  for (let i = 0; i < 5; i++) {
    if ((await processOutboxBatch()) === 0) break
  }
  await flushEventHandlers()
}

/** The invoicing app's own egress, with its real allowlist. */
function invoicingBridge() {
  const manifest = manifestOf("invoicing")
  const network = (manifest.network ?? {}) as { allowedDomains?: string[] }
  return createEgressMethods({
    orgId: ORG,
    userId: USER,
    appName: "invoicing",
    actorType: "user",
    egress: async () => ({ allowedDomains: network.allowedDomains ?? [], manifest }),
    callerScopes: [],
    inheritedActor: { actorType: "user" as const },
    manifest,
    txDb: null,
    resolveCredentials: async () => ({}),
  } as unknown as BridgeContext)
}

const graphql = JSON.stringify({
  method: "POST",
  headers: {},
  body: '{"query":"{ shop { id } }"}',
})

describe("the fake Shopify Admin API and the invoicing app, through the real sandbox", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await clearRedisPatterns([`webhook:replay:${ORG}:*`])
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"

    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const u = new URL(req.url)
        const body = (await req.json().catch(() => ({}))) as {
          query?: string
          variables?: Record<string, unknown>
        }
        const query = body.query ?? ""
        fakeHits.push({
          path: u.pathname,
          operation: operationOf(query),
          orderId: typeof body.variables?.id === "string" ? body.variables.id : null,
          token: req.headers.get("x-shopify-access-token"),
          shop: req.headers.get("x-liaison-shop-domain"),
        })
        return Response.json({ data: answer(query) })
      },
    })
    fakeOrigin = `http://127.0.0.1:${server.port}`

    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Fake Admin Invoicing Org', 'fake-admin-invoicing-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'fake-admin-invoicing@test.com', 'hash', 'Fake Admin Invoicing Tester', 'active')
      ON CONFLICT (id) DO NOTHING`

    await initSandboxPool()
    await initWorkerPool()
    await registerApps(
      [bundledDescriptor("shopify") as never, bundledDescriptor("invoicing") as never],
      ORG,
    )

    await sql`UPDATE kernel.apps
      SET config = ${JSON.stringify({
        shopifyWebhookSecret: encryptSecret(
          WEBHOOK_SECRET,
          env.ENCRYPTION_KEY,
          CryptoContext.appConfigConnectionSecret,
        ),
      })}::jsonb
      WHERE org_id = ${ORG} AND name = 'shopify'`

    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.deferred_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_shopify.install_metadata WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'shopify'`
    await sql`INSERT INTO kernel.connected_accounts (
        id, org_id, app_name, connection_name, owner_type, owner_id,
        provider_type, identifier, status, created_by, access_token_encrypted
      ) VALUES (
        ${randomUUID()}, ${ORG}, 'shopify', 'shop', 'org', NULL,
        'oauth2', ${SHOP_DOMAIN}, 'active', ${USER},
        ${encryptSecret(SHOP_TOKEN, env.ENCRYPTION_KEY, CryptoContext.connectedAccountAccessToken)}
      )`
    await sql`INSERT INTO app_invoicing.issuer_profiles
      (id, org_id, legal_name, country, vat_id, default_currency, shopify_shop_id)
      VALUES (${randomUUID()}, ${ORG}, 'Fake Admin Issuer SAS', 'FR', 'FR41903000008', 'EUR', ${SHOP_DOMAIN})`
  }, 90_000)

  afterEach(() => {
    ShopifyFakeAdminTestAccess.setInputs(null)
    SandboxBridgeTestAccess.setFetch(null)
    SandboxBridgeTestAccess.setFetchInterceptsHost(null)
    fakeHits = []
    wireHits = []
  })

  afterAll(async () => {
    server?.stop(true)
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await sql`DELETE FROM app_invoicing.documents WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.deferred_events WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_invoicing.issuer_profiles WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_shopify.webhook_deliveries WHERE org_id = ${ORG}`
    await sql`DELETE FROM app_shopify.install_metadata WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.connected_accounts WHERE org_id = ${ORG} AND app_name = 'shopify'`
    await releaseTestLock()
  }, 60_000)

  it("on a labelled private box, an invoicing order import fetches its order from the fake, with the store's token", async () => {
    ShopifyFakeAdminTestAccess.setInputs(ON())

    await importOrder(7_300_101)

    const fetches = fakeHits.filter((h) => h.operation === "OrderGet")
    expect(fetches.map((h) => h.orderId)).toContain("gid://shopify/Order/7300101")
    for (const hit of fakeHits) {
      expect(hit.path).toBe("/admin/api/2026-04/graphql.json")
      expect(hit.token).toBe(SHOP_TOKEN)
      expect(hit.shop).toBe(SHOP_DOMAIN)
    }
  }, 120_000)

  it("with the setting on a real instance, an invoicing order import sends nothing to the fake and fetches from the store", async () => {
    ShopifyFakeAdminTestAccess.setInputs(OFF_PUBLIC())
    recordTheWire()

    await importOrder(7_300_202)

    expect(fakeHits).toEqual([])
    expect(wireHits.map((h) => h.operation)).toContain("OrderGet")
    for (const hit of wireHits) {
      expect(new URL(hit.url).hostname).toBe(SHOP_DOMAIN)
      expect(hit.token).toBe(SHOP_TOKEN)
    }
  }, 120_000)

  it("an invoicing request naming the fake origin is refused when the gate is off", async () => {
    ShopifyFakeAdminTestAccess.setInputs(OFF_PUBLIC())
    await expect(
      invoicingBridge().fetch(`${fakeOrigin}/admin/api/2026-04/graphql.json`, graphql),
    ).rejects.toThrow(/not in allowlist/)
    expect(fakeHits).toEqual([])
  })

  it("an invoicing request naming the fake origin is refused even with the gate on", async () => {
    ShopifyFakeAdminTestAccess.setInputs(ON())
    await expect(
      invoicingBridge().fetch(`${fakeOrigin}/admin/api/2026-04/graphql.json`, graphql),
    ).rejects.toThrow(/not in allowlist/)
    expect(fakeHits).toEqual([])
  })

  it("an invoicing request naming a store directly is refused, gate on or off", async () => {
    for (const inputs of [ON(), OFF_PUBLIC()]) {
      ShopifyFakeAdminTestAccess.setInputs(inputs)
      await expect(
        invoicingBridge().fetch(`https://${SHOP_DOMAIN}/admin/api/2026-04/graphql.json`, graphql),
      ).rejects.toThrow(/not in allowlist/)
    }
    expect(fakeHits).toEqual([])
  })
})
