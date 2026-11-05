#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
// Idempotent dev-store seed for Phase 16 testing. Brings the connected dev
// store to a known baseline: 5 products with per-market pricing, 10 customers,
// 15 historical orders distributed across markets.
//
// Idempotency: every seeded entity carries the tag `liaison-seed` and an
// external identifier; re-running the script skips entities that already
// exist with that tag.
//
// GraphQL mutation shapes pinned against API version SHOPIFY_API_VERSION
// (default 2026-01). If Shopify ships breaking schema changes, the affected
// mutation will return errors with `extensions.code` — the script aborts
// loudly so the user can re-pin the API version and regenerate fixtures.
//
// Run: bun run liaison/bundled-apps/shopify/scripts/dev-store-seed.ts
//
// What it writes comes from ./dev-store-catalog.ts: a fiction catalog by default, or the module
// LIAISON_SHOPIFY_DEV_STORE_CATALOG names (a store seeded with its own catalog).

import { graphqlThrottled, loadShopifyEnv } from "./_shopify-client.ts"
import {
  type CatalogCustomerSpec,
  type FulfilledOrderSpec,
  LOW_STOCK_THRESHOLD,
  loadDevStoreCatalog,
} from "./dev-store-catalog.ts"

const CATALOG = await loadDevStoreCatalog()
const PRODUCTS = CATALOG.products
const CUSTOMERS = CATALOG.customers
const CATALOG_PRODUCTS = CATALOG.catalogProducts
const CATALOG_CUSTOMERS = CATALOG.catalogCustomers
const CATALOG_FULFILLED_ORDERS = CATALOG.fulfilledOrders
const CATALOG_INVENTORY = CATALOG.inventory
const SECONDARY_LOCATION = CATALOG.secondaryLocation

interface Counts {
  marketsConfirmed: number
  productsCreated: number
  productsSkipped: number
  customersCreated: number
  customersSkipped: number
  ordersCreated: number
  ordersSkipped: number
}

const SEED_TAG = "liaison-seed"

// We don't prescribe specific market handles — the seed adapts to whatever
// the dev store has enabled (Shopify's default seed gives "us" + "canada",
// some dev-store templates give other sets). We just require ≥ 2 enabled
// markets so multi-market filtering tests have something to filter on.
const MIN_ENABLED_MARKETS = 2


// Market handles are resolved at runtime from the dev store's enabled set.
// Customers are distributed across whatever markets exist via round-robin.

async function confirmMarkets(env: ReturnType<typeof loadShopifyEnv>): Promise<{ count: number; handles: string[] }> {
  const q = `
    query {
      markets(first: 25) {
        edges { node { id name handle enabled currencySettings { baseCurrency { currencyCode } } } }
      }
    }
  `
  const res = await graphqlThrottled<{ markets: { edges: Array<{ node: { handle: string; enabled: boolean } }> } }>(env, q)
  const enabled = (res.data?.markets.edges ?? []).filter((e) => e.node.enabled).map((e) => e.node.handle)
  if (enabled.length < MIN_ENABLED_MARKETS) {
    throw new Error(
      `Dev store has ${enabled.length} enabled Market(s); minimum is ${MIN_ENABLED_MARKETS}. ` +
        `Add at least one more in dev-store admin → Settings → Markets.`,
    )
  }
  return { count: enabled.length, handles: enabled }
}

async function existingTaggedIds(
  env: ReturnType<typeof loadShopifyEnv>,
  resource: "products" | "customers" | "orders",
): Promise<Set<string>> {
  const q = `
    query {
      ${resource}(first: 100, query: "tag:${SEED_TAG}") {
        edges { node { id tags } }
      }
    }
  `
  const res = await graphqlThrottled<{ [k: string]: { edges: Array<{ node: { id: string; tags: string[] } }> } }>(env, q)
  const out = new Set<string>()
  for (const e of res.data?.[resource]?.edges ?? []) {
    out.add(e.node.id)
  }
  return out
}

async function findByExternalTag(
  env: ReturnType<typeof loadShopifyEnv>,
  resource: "products" | "customers",
  externalId: string,
): Promise<string | null> {
  const q = `
    query {
      ${resource}(first: 1, query: "tag:${externalId}") {
        edges { node { id } }
      }
    }
  `
  const res = await graphqlThrottled<{ [k: string]: { edges: Array<{ node: { id: string } }> } }>(env, q)
  const id = res.data?.[resource]?.edges?.[0]?.node?.id
  return id ?? null
}

async function createProduct(
  env: ReturnType<typeof loadShopifyEnv>,
  spec: (typeof PRODUCTS)[number],
): Promise<void> {
  const existing = await findByExternalTag(env, "products", spec.externalId)
  if (existing) return

  // Newer ProductInput shape (2024-10+): no `variants` field — Shopify creates
  // a Default Title variant automatically. Price is set on that default variant
  // via productVariantsBulkUpdate after creation.
  const create = await graphqlThrottled<{
    productCreate: {
      product: { id: string; variants: { edges: Array<{ node: { id: string } }> } } | null
      userErrors: Array<{ field: string[]; message: string }>
    }
  }>(
    env,
    `
      mutation ProductCreate($input: ProductInput!) {
        productCreate(input: $input) {
          product { id variants(first: 1) { edges { node { id } } } }
          userErrors { field message }
        }
      }
    `,
    {
      input: {
        title: spec.title,
        tags: [SEED_TAG, spec.externalId],
        status: "ACTIVE",
      },
    },
  )
  const ue = create.data?.productCreate?.userErrors ?? []
  if (ue.length > 0) throw new Error(`productCreate ${spec.externalId}: ${ue.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
  const productId = create.data?.productCreate?.product?.id
  const defaultVariantId = create.data?.productCreate?.product?.variants?.edges?.[0]?.node?.id
  if (!productId || !defaultVariantId) {
    throw new Error(`productCreate ${spec.externalId}: missing product/variant id in response`)
  }

  // Set the default variant's price. ProductVariantsBulkUpdate is the
  // sanctioned post-create pricing path in API 2024-10+.
  const update = await graphqlThrottled<{
    productVariantsBulkUpdate: {
      product: { id: string } | null
      userErrors: Array<{ field: string[]; message: string }>
    }
  }>(
    env,
    `
      mutation VariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          product { id }
          userErrors { field message }
        }
      }
    `,
    {
      productId,
      variants: [{ id: defaultVariantId, price: spec.basePriceEur }],
    },
  )
  const ue2 = update.data?.productVariantsBulkUpdate?.userErrors ?? []
  if (ue2.length > 0) throw new Error(`productVariantsBulkUpdate ${spec.externalId}: ${ue2.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
}

async function createCustomer(
  env: ReturnType<typeof loadShopifyEnv>,
  spec: (typeof CUSTOMERS)[number],
  marketHandle: string,
): Promise<void> {
  const existing = await findByExternalTag(env, "customers", spec.externalId)
  if (existing) return

  const m = `
    mutation CustomerCreate($input: CustomerInput!) {
      customerCreate(input: $input) {
        customer { id email }
        userErrors { field message }
      }
    }
  `
  const input = {
    firstName: spec.firstName,
    lastName: spec.lastName,
    email: spec.email,
    tags: [SEED_TAG, spec.externalId, `market:${marketHandle}`],
  }
  const res = await graphqlThrottled<{ customerCreate: { customer: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> } }>(env, m, { input })
  const ue = res.data?.customerCreate?.userErrors ?? []
  if (ue.length > 0) throw new Error(`customerCreate ${spec.externalId}: ${ue.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
}

async function createHistoricalDraftOrder(
  env: ReturnType<typeof loadShopifyEnv>,
  idx: number,
  customerExternalId: string,
  productExternalId: string,
): Promise<void> {
  const externalId = `liaison-seed-order-${String(idx).padStart(3, "0")}`
  const lookup = await graphqlThrottled<{ draftOrders: { edges: Array<{ node: { id: string } }> } }>(
    env,
    `
      query { draftOrders(first: 1, query: "tag:${externalId}") { edges { node { id } } } }
    `,
  )
  if ((lookup.data?.draftOrders?.edges ?? []).length > 0) return

  // Look up the customer ID (via tag) and product's first variant ID.
  // Linking by ID avoids Shopify's email-domain validation that rejects
  // `.test` TLDs in order inputs (even when the customer record exists).
  const customerId = await findByExternalTag(env, "customers", customerExternalId)
  if (!customerId) throw new Error(`Cannot seed order ${externalId}: customer ${customerExternalId} not found`)
  const prod = await graphqlThrottled<{ products: { edges: Array<{ node: { variants: { edges: Array<{ node: { id: string } }> } } }> } }>(
    env,
    `query { products(first: 1, query: "tag:${productExternalId}") { edges { node { variants(first: 1) { edges { node { id } } } } } } }`,
  )
  const variantId = prod.data?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node?.id
  if (!variantId) throw new Error(`Cannot seed order ${externalId}: product ${productExternalId} has no variant`)

  const create = await graphqlThrottled<{ draftOrderCreate: { draftOrder: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> } }>(
    env,
    `
      mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id }
          userErrors { field message }
        }
      }
    `,
    {
      input: {
        purchasingEntity: { customerId },
        tags: [SEED_TAG, externalId],
        lineItems: [{ variantId, quantity: 1 + (idx % 3) }],
      },
    },
  )
  const ue = create.data?.draftOrderCreate?.userErrors ?? []
  if (ue.length > 0) throw new Error(`draftOrderCreate ${externalId}: ${ue.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
  const draftId = create.data?.draftOrderCreate?.draftOrder?.id
  if (!draftId) throw new Error(`draftOrderCreate ${externalId}: no draft id returned`)

  // Complete the draft → real order.
  const complete = await graphqlThrottled<{ draftOrderComplete: { draftOrder: { order: { id: string } | null } | null; userErrors: Array<{ field: string[]; message: string }> } }>(
    env,
    `
      mutation DraftOrderComplete($id: ID!) {
        draftOrderComplete(id: $id, paymentPending: false) {
          draftOrder { order { id } }
          userErrors { field message }
        }
      }
    `,
    { id: draftId },
  )
  const ue2 = complete.data?.draftOrderComplete?.userErrors ?? []
  if (ue2.length > 0) throw new Error(`draftOrderComplete ${externalId}: ${ue2.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
}

// ── Scenario catalog anchors ─────────────────────────────────────────────────
// SKU'd products, named customers (dealers among them) and a fulfilled order with tracking, so
// scenario reads like `variants_search` by SKU or `orders_search` by email find real rows. The
// tracked per-location inventory levels are set afterwards (seedCatalogInventory).

/** Resolve a tagged product's first variant id (for the already-seeded path). */
async function findVariantIdByProductTag(
  env: ReturnType<typeof loadShopifyEnv>,
  externalId: string,
): Promise<string | null> {
  const res = await graphqlThrottled<{ products: { edges: Array<{ node: { variants: { edges: Array<{ node: { id: string } }> } } }> } }>(
    env,
    `query { products(first: 1, query: "tag:${externalId}") { edges { node { variants(first: 1) { edges { node { id } } } } } } }`,
  )
  return res.data?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node?.id ?? null
}

/** Create a product with an explicit variant SKU (the default-variant pricing path + an
 *  `inventoryItem.sku` so `variants_search`/SKU lookups in the catalog scenarios resolve).
 *  Returns the default variant's id (resolved from the live store when already seeded), so the
 *  caller can build orders WITHOUT a same-run tag re-search (Shopify's search index lags). */
async function createCatalogProduct(
  env: ReturnType<typeof loadShopifyEnv>,
  spec: (typeof CATALOG_PRODUCTS)[number],
): Promise<string> {
  const existing = await findByExternalTag(env, "products", spec.externalId)
  if (existing) {
    const variantId = await findVariantIdByProductTag(env, spec.externalId)
    if (!variantId) throw new Error(`createCatalogProduct ${spec.externalId}: existing product has no variant`)
    return variantId
  }

  const create = await graphqlThrottled<{
    productCreate: {
      product: { id: string; variants: { edges: Array<{ node: { id: string } }> } } | null
      userErrors: Array<{ field: string[]; message: string }>
    }
  }>(
    env,
    `
      mutation ProductCreate($input: ProductInput!) {
        productCreate(input: $input) {
          product { id variants(first: 1) { edges { node { id } } } }
          userErrors { field message }
        }
      }
    `,
    { input: { title: spec.title, tags: [SEED_TAG, spec.externalId], status: "ACTIVE" } },
  )
  const ue = create.data?.productCreate?.userErrors ?? []
  if (ue.length > 0) throw new Error(`productCreate ${spec.externalId}: ${ue.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
  const productId = create.data?.productCreate?.product?.id
  const defaultVariantId = create.data?.productCreate?.product?.variants?.edges?.[0]?.node?.id
  if (!productId || !defaultVariantId) throw new Error(`productCreate ${spec.externalId}: missing product/variant id`)

  const update = await graphqlThrottled<{
    productVariantsBulkUpdate: { userErrors: Array<{ field: string[]; message: string }> }
  }>(
    env,
    `
      mutation VariantsUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          product { id }
          userErrors { field message }
        }
      }
    `,
    {
      productId,
      // SKU lives on the inventory item; leave `tracked` at its default (untracked) so the
      // seeded order is always fulfillable without seeding per-location inventory levels.
      variants: [{ id: defaultVariantId, price: spec.priceEur, inventoryItem: { sku: spec.sku } }],
    },
  )
  const ue2 = update.data?.productVariantsBulkUpdate?.userErrors ?? []
  if (ue2.length > 0) throw new Error(`productVariantsBulkUpdate ${spec.externalId}: ${ue2.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
  return defaultVariantId
}

/** Create a named catalog customer with a shipping address (used by find-order +
 *  backfill-contact scenarios). Idempotent on the external-id tag; returns the customer id
 *  (fresh or existing) so the caller skips a same-run tag re-search (search index lags). */
async function createCatalogCustomer(env: ReturnType<typeof loadShopifyEnv>, spec: CatalogCustomerSpec): Promise<string> {
  const existing = await findByExternalTag(env, "customers", spec.externalId)
  if (existing) return existing
  const res = await graphqlThrottled<{
    customerCreate: { customer: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> }
  }>(
    env,
    `
      mutation CustomerCreate($input: CustomerInput!) {
        customerCreate(input: $input) { customer { id } userErrors { field message } }
      }
    `,
    {
      input: {
        firstName: spec.firstName,
        lastName: spec.lastName,
        email: spec.email,
        tags: [SEED_TAG, spec.externalId, ...(spec.extraTags ?? [])],
        addresses: [
          {
            address1: spec.address1,
            city: spec.city,
            ...(spec.provinceCode ? { provinceCode: spec.provinceCode } : {}),
            countryCode: spec.countryCode,
            zip: spec.zip,
            ...(spec.company ? { company: spec.company } : {}),
          },
        ],
      },
    },
  )
  const ue = res.data?.customerCreate?.userErrors ?? []
  if (ue.length > 0) throw new Error(`customerCreate ${spec.externalId}: ${ue.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
  const id = res.data?.customerCreate?.customer?.id
  if (!id) throw new Error(`customerCreate ${spec.externalId}: no customer id returned`)
  return id
}

/** Create a PAID order for the customer and fulfill it with a tracking number, so the
 *  order surfaces a non-empty fulfillment + tracking to orders_get / fulfillments_get.
 *  Idempotent on the order external-id tag. `customerId`/`variantId` are passed in (resolved
 *  by the caller from the create responses) to avoid a same-run tag re-search. */
async function createFulfilledOrder(
  env: ReturnType<typeof loadShopifyEnv>,
  spec: FulfilledOrderSpec,
  customerId: string,
  variantId: string,
): Promise<void> {
  // Already-seeded? The completed order keeps the draft's tags.
  const existingOrder = await graphqlThrottled<{ orders: { edges: Array<{ node: { id: string } }> } }>(
    env,
    `query { orders(first: 1, query: "tag:${spec.externalId}") { edges { node { id } } } }`,
  )
  if ((existingOrder.data?.orders?.edges ?? []).length > 0) return

  const draft = await graphqlThrottled<{ draftOrderCreate: { draftOrder: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> } }>(
    env,
    `
      mutation DraftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) { draftOrder { id } userErrors { field message } }
      }
    `,
    {
      input: {
        purchasingEntity: { customerId },
        tags: [SEED_TAG, spec.externalId],
        lineItems: [{ variantId, quantity: 1 }],
      },
    },
  )
  const due = draft.data?.draftOrderCreate?.userErrors ?? []
  if (due.length > 0) throw new Error(`draftOrderCreate ${spec.externalId}: ${due.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
  const draftId = draft.data?.draftOrderCreate?.draftOrder?.id
  if (!draftId) throw new Error(`draftOrderCreate ${spec.externalId}: no draft id`)

  const complete = await graphqlThrottled<{
    draftOrderComplete: { draftOrder: { order: { id: string } | null } | null; userErrors: Array<{ field: string[]; message: string }> }
  }>(
    env,
    `
      mutation DraftOrderComplete($id: ID!) {
        draftOrderComplete(id: $id, paymentPending: false) {
          draftOrder { order { id } }
          userErrors { field message }
        }
      }
    `,
    { id: draftId },
  )
  const cue = complete.data?.draftOrderComplete?.userErrors ?? []
  if (cue.length > 0) throw new Error(`draftOrderComplete ${spec.externalId}: ${cue.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
  const orderId = complete.data?.draftOrderComplete?.draftOrder?.order?.id
  if (!orderId) throw new Error(`draftOrderComplete ${spec.externalId}: no order id`)

  // Fulfill: resolve the order's OPEN fulfillment order, then fulfillmentCreateV2 with tracking.
  const foRes = await graphqlThrottled<{
    order: { fulfillmentOrders: { edges: Array<{ node: { id: string; status: string } }> } } | null
  }>(
    env,
    `query GetFO($id: ID!) { order(id: $id) { fulfillmentOrders(first: 10) { edges { node { id status } } } } }`,
    { id: orderId },
  )
  const fo = (foRes.data?.order?.fulfillmentOrders?.edges ?? []).find((e) => e.node.status === "OPEN" || e.node.status === "IN_PROGRESS")
  const fulfillmentOrderId = fo?.node?.id
  if (!fulfillmentOrderId) throw new Error(`createFulfilledOrder ${spec.externalId}: no open fulfillment order on ${orderId}`)

  const ff = await graphqlThrottled<{
    fulfillmentCreateV2: {
      fulfillment: { id: string; status: string } | null
      userErrors: Array<{ field: string[]; message: string }>
    }
  }>(
    env,
    `
      mutation FulfillmentCreate($fulfillment: FulfillmentV2Input!) {
        fulfillmentCreateV2(fulfillment: $fulfillment) {
          fulfillment { id status trackingInfo { number url company } }
          userErrors { field message }
        }
      }
    `,
    {
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId }],
        trackingInfo: { company: spec.carrier, number: spec.trackingNumber, url: spec.trackingUrl },
        notifyCustomer: false,
      },
    },
  )
  const fue = ff.data?.fulfillmentCreateV2?.userErrors ?? []
  if (fue.length > 0) throw new Error(`fulfillmentCreateV2 ${spec.externalId}: ${fue.map((e) => `${e.field?.join(".")}: ${e.message}`).join("; ")}`)
}

// ── Per-location tracked inventory (marco-stock-check / set-inventory / low-stock-watcher) ─────
// The stock-check class needs the catalog SKUs TRACKED with per-location on-hand levels, a couple
// genuinely LOW (under LOW_STOCK_THRESHOLD) and the rest healthy. Two locations: the store's primary
// ("Shop location") + the catalog's named secondary location.

/** Resolve the two seed locations: the primary ("Shop location" if present, else the first active)
 *  and the catalog's secondary location, naming an active non-primary location after it if absent. */
async function resolveSeedLocations(
  env: ReturnType<typeof loadShopifyEnv>,
): Promise<{ primaryId: string; secondaryId: string }> {
  const res = await graphqlThrottled<{ locations: { edges: Array<{ node: { id: string; name: string; isActive: boolean } }> } }>(
    env,
    `query { locations(first: 20) { edges { node { id name isActive } } } }`,
  )
  const active = (res.data?.locations?.edges ?? []).map((e) => e.node).filter((n) => n.isActive)
  if (active.length < 2) throw new Error(`dev store has ${active.length} active locations; need ≥2 for per-location inventory`)
  const primary = active.find((l) => l.name === "Shop location") ?? active[0]!
  // Designate the second location: an existing one with the catalog's name if present, else any
  // active non-primary location. Always (idempotently) set its name + address: a renamed dev-store
  // location otherwise keeps its default Canadian address, which reads as nonsensical fixture data
  // and undermines the location-split scenarios.
  const secondary = active.find((l) => l.name === SECONDARY_LOCATION.name) ?? active.find((l) => l.id !== primary.id)
  if (!secondary) throw new Error(`no secondary location to designate as ${SECONDARY_LOCATION.name}`)
  const edit = await graphqlThrottled<{ locationEdit: { location: { id: string } | null; userErrors: Array<{ field: string[]; message: string }> } }>(
    env,
    `
      mutation LocationEdit($id: ID!, $input: LocationEditInput!) {
        locationEdit(id: $id, input: $input) { location { id name } userErrors { field message } }
      }
    `,
    {
      id: secondary.id,
      input: {
        name: SECONDARY_LOCATION.name,
        address: SECONDARY_LOCATION.address,
      },
    },
  )
  const ue = edit.data?.locationEdit?.userErrors ?? []
  if (ue.length > 0) throw new Error(`locationEdit(${SECONDARY_LOCATION.name}): ${ue.map((e) => e.message).join("; ")}`)
  return { primaryId: primary.id, secondaryId: secondary.id }
}

/** Resolve a tagged product's first variant + inventoryItem ids. */
async function resolveVariantInventoryItem(
  env: ReturnType<typeof loadShopifyEnv>,
  productExternalId: string,
): Promise<{ variantId: string; inventoryItemId: string } | null> {
  const res = await graphqlThrottled<{
    products: { edges: Array<{ node: { variants: { edges: Array<{ node: { id: string; inventoryItem: { id: string } } }> } } }> }
  }>(
    env,
    `query { products(first: 1, query: "tag:${productExternalId}") { edges { node { variants(first: 1) { edges { node { id inventoryItem { id } } } } } } } }`,
  )
  const node = res.data?.products?.edges?.[0]?.node?.variants?.edges?.[0]?.node
  if (!node?.id || !node?.inventoryItem?.id) return null
  return { variantId: node.id, inventoryItemId: node.inventoryItem.id }
}

/** Enable inventory tracking on a variant's inventory item (idempotent). */
async function enableTracking(env: ReturnType<typeof loadShopifyEnv>, variantId: string, sku: string): Promise<void> {
  // ProductVariantsBulkUpdate needs the owning productId; resolve it from the variant.
  const v = await graphqlThrottled<{ productVariant: { product: { id: string } } | null }>(
    env,
    `query($id: ID!) { productVariant(id: $id) { product { id } } }`,
    { id: variantId },
  )
  const productId = v.data?.productVariant?.product?.id
  if (!productId) throw new Error(`enableTracking ${sku}: no product for variant ${variantId}`)
  const res = await graphqlThrottled<{ productVariantsBulkUpdate: { userErrors: Array<{ field: string[]; message: string }> } }>(
    env,
    `
      mutation VariantsTrack($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) { product { id } userErrors { field message } }
      }
    `,
    { productId, variants: [{ id: variantId, inventoryItem: { tracked: true } }] },
  )
  const ue = res.data?.productVariantsBulkUpdate?.userErrors ?? []
  if (ue.length > 0) throw new Error(`enableTracking ${sku}: ${ue.map((e) => e.message).join("; ")}`)
}

/** Activate the inventory item at a location (idempotent — "already activated" is fine) then set
 *  the authoritative on-hand quantity. */
async function setLocationOnHand(
  env: ReturnType<typeof loadShopifyEnv>,
  inventoryItemId: string,
  locationId: string,
  quantity: number,
  sku: string,
): Promise<void> {
  const act = await graphqlThrottled<{ inventoryActivate: { userErrors: Array<{ field: string[]; message: string }> } }>(
    env,
    `
      mutation InventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
          inventoryLevel { id }
          userErrors { field message }
        }
      }
    `,
    { inventoryItemId, locationId },
  )
  const actUe = act.data?.inventoryActivate?.userErrors ?? []
  // "already activated / stocked at this location" is the idempotent re-run path → ignore.
  const blocking = actUe.filter((e) => !/already|stocked/i.test(e.message))
  if (blocking.length > 0) throw new Error(`inventoryActivate ${sku}: ${blocking.map((e) => e.message).join("; ")}`)

  const set = await graphqlThrottled<{ inventorySetOnHandQuantities: { userErrors: Array<{ field: string[]; message: string }> } }>(
    env,
    `
      mutation InventorySetOnHand($input: InventorySetOnHandQuantitiesInput!) {
        inventorySetOnHandQuantities(input: $input) {
          inventoryAdjustmentGroup { id }
          userErrors { field message }
        }
      }
    `,
    {
      input: {
        reason: "correction",
        setQuantities: [{ inventoryItemId, locationId, quantity }],
      },
    },
  )
  const ue = set.data?.inventorySetOnHandQuantities?.userErrors ?? []
  if (ue.length > 0) throw new Error(`inventorySetOnHand ${sku}@${locationId}: ${ue.map((e) => e.message).join("; ")}`)
}

async function seedCatalogInventory(env: ReturnType<typeof loadShopifyEnv>): Promise<void> {
  console.log("\n→ Seeding per-location tracked inventory (stock-check class)…")
  const { primaryId, secondaryId } = await resolveSeedLocations(env)
  for (const t of CATALOG_INVENTORY) {
    const ids = await resolveVariantInventoryItem(env, t.productExternalId)
    if (!ids) throw new Error(`seedCatalogInventory: ${t.sku} (${t.productExternalId}) not found: run seedCatalogAnchors first`)
    await enableTracking(env, ids.variantId, t.sku)
    await setLocationOnHand(env, ids.inventoryItemId, primaryId, t.primaryQty, t.sku)
    await setLocationOnHand(env, ids.inventoryItemId, secondaryId, t.secondaryQty, t.sku)
  }
  const lowSkus = CATALOG_INVENTORY.filter((t) => t.primaryQty + t.secondaryQty < LOW_STOCK_THRESHOLD)
    .map((t) => t.sku)
    .join(", ")
  console.log(
    `✓ inventory: ${CATALOG_INVENTORY.map((t) => `${t.sku}(${t.primaryQty}/${t.secondaryQty})`).join(", ")} across Shop location + ${SECONDARY_LOCATION.name} (low: ${lowSkus})`,
  )
}

async function seedCatalogAnchors(env: ReturnType<typeof loadShopifyEnv>): Promise<void> {
  console.log("\n→ Seeding deep-week-sim catalog anchors (products/customers/fulfilled orders)…")
  // Resolve ids from the create responses (or existing rows) and thread them — Shopify's
  // tag-search index lags, so a same-run "find the thing I just made by tag" intermittently 404s.
  const variantByProductExternalId = new Map<string, string>()
  for (const p of CATALOG_PRODUCTS) variantByProductExternalId.set(p.externalId, await createCatalogProduct(env, p))
  console.log(`✓ catalog products: ${CATALOG_PRODUCTS.map((p) => p.sku).join(", ")}`)
  const customerByExternalId = new Map<string, string>()
  for (const c of CATALOG_CUSTOMERS) customerByExternalId.set(c.externalId, await createCatalogCustomer(env, c))
  console.log(`✓ catalog customers: ${CATALOG_CUSTOMERS.map((c) => c.email).join(", ")}`)
  for (const o of CATALOG_FULFILLED_ORDERS) {
    const customerId = customerByExternalId.get(o.customerExternalId)
    const variantId = variantByProductExternalId.get(o.productExternalId)
    if (!customerId) throw new Error(`seedCatalogAnchors: order ${o.externalId} references unseeded customer ${o.customerExternalId}`)
    if (!variantId) throw new Error(`seedCatalogAnchors: order ${o.externalId} references unseeded product ${o.productExternalId}`)
    await createFulfilledOrder(env, o, customerId, variantId)
  }
  console.log(`✓ fulfilled orders: ${CATALOG_FULFILLED_ORDERS.map((o) => o.externalId).join(", ")}`)
}

async function main() {
  const env = loadShopifyEnv()
  console.log(`→ Seeding ${env.domain} (API ${env.apiVersion})…\n`)

  const counts: Counts = {
    marketsConfirmed: 0,
    productsCreated: 0,
    productsSkipped: 0,
    customersCreated: 0,
    customersSkipped: 0,
    ordersCreated: 0,
    ordersSkipped: 0,
  }

  // 1. Markets — confirm only, never create (per setup doc step 3).
  const marketsInfo = await confirmMarkets(env)
  counts.marketsConfirmed = marketsInfo.count
  console.log(`✓ ${marketsInfo.count} markets confirmed enabled: ${marketsInfo.handles.join(", ")}`)

  // 2. Products.
  const existingProductTags = await existingTaggedIds(env, "products")
  for (const spec of PRODUCTS) {
    const before = existingProductTags.size
    await createProduct(env, spec)
    const after = await existingTaggedIds(env, "products")
    if (after.size > before) counts.productsCreated++
    else counts.productsSkipped++
  }
  console.log(`✓ products: ${counts.productsCreated} created, ${counts.productsSkipped} skipped`)

  // 3. Customers — round-robin across whatever markets are enabled.
  for (let i = 0; i < CUSTOMERS.length; i++) {
    const spec = CUSTOMERS[i]!
    const marketHandle = marketsInfo.handles[i % marketsInfo.handles.length]!
    const existing = await findByExternalTag(env, "customers", spec.externalId)
    if (existing) {
      counts.customersSkipped++
    } else {
      await createCustomer(env, spec, marketHandle)
      counts.customersCreated++
    }
  }
  console.log(`✓ customers: ${counts.customersCreated} created, ${counts.customersSkipped} skipped`)

  // 4. Historical orders (15: one per customer-product pair, modulo array length).
  const TOTAL_ORDERS = 15
  for (let i = 0; i < TOTAL_ORDERS; i++) {
    const cust = CUSTOMERS[i % CUSTOMERS.length]!
    const prod = PRODUCTS[i % PRODUCTS.length]!
    const externalId = `liaison-seed-order-${String(i + 1).padStart(3, "0")}`
    const lookup = await graphqlThrottled<{ draftOrders: { edges: Array<{ node: { id: string } }> } }>(
      env,
      `query { draftOrders(first: 1, query: "tag:${externalId}") { edges { node { id } } } }`,
    )
    if ((lookup.data?.draftOrders?.edges ?? []).length > 0) {
      counts.ordersSkipped++
      continue
    }
    await createHistoricalDraftOrder(env, i + 1, cust.externalId, prod.externalId)
    counts.ordersCreated++
  }
  console.log(`✓ orders: ${counts.ordersCreated} created, ${counts.ordersSkipped} skipped`)

  // 5. Deep-week-sim catalog anchors (SKU'd products + named customers + a fulfilled order
  //    with tracking) so the shopify works_today scenarios resolve against the live store.
  await seedCatalogAnchors(env)

  // 6. Per-location tracked inventory for the catalog SKUs (stock-check / set-inventory class).
  await seedCatalogInventory(env)

  console.log("\n✅ Seed complete.")
  console.log(JSON.stringify(counts, null, 2))
}

main().catch((err) => {
  console.error("\n❌ Seed failed:", err.message)
  process.exit(1)
})
