// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Seeds the dogfood Shopify dev store with a KNOWN customs-bearing product so
// the customs e2e can assert we actually *retrieve* HS code + country of origin
// (native InventoryItem fields) AND the `custom.customs_description` metafield —
// not merely that the GraphQL shape carries the keys.
//
// Idempotent: ensures the `custom.customs_description` metafield DEFINITION
// exists (Product owner), then find-or-creates a dedicated test product by
// handle and (re)sets its customs fields. Safe to call on every real-creds run;
// it never touches the store's real catalog (only its own dedicated product).
//
// Runs against the REAL store via the Admin GraphQL API with the offline token —
// gated by the same SHOPIFY_DEV_STORE_* creds the e2e is gated on.

const HANDLE = "liaison-e2e-customs-test"
const TITLE = "Liaison E2E — Customs Test Product"
// Shopify normalizes harmonizedSystemCode to digits-only on storage (it strips
// the dotted separators), so seed + assert the normalized form it returns.
export const EXPECTED_CUSTOMS = {
  hsCode: "92071000",
  countryOfOrigin: "FR",
  customsDescription: "Electronic musical instrument controller (E2E fixture)",
} as const

const METAFIELD_NAMESPACE = "custom"
const METAFIELD_KEY = "customs_description"

interface SeedOpts {
  shopDomain: string
  token: string
  apiVersion: string
}

export interface SeededCustomsProduct {
  productId: string
  variantId: string
  inventoryItemId: string
  handle: string
  hsCode: string
  countryOfOrigin: string
  customsDescription: string
}

async function admin<T>(
  opts: SeedOpts,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const url = `https://${opts.shopDomain}/admin/api/${opts.apiVersion}/graphql.json`
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": opts.token,
    },
    body: JSON.stringify({ query, variables }),
  })
  const text = await res.text()
  if (res.status !== 200) {
    throw new Error(`Shopify Admin ${res.status}: ${text.slice(0, 500)}`)
  }
  const json = JSON.parse(text) as { data?: T; errors?: Array<{ message?: string }> }
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Shopify Admin GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`)
  }
  return json.data as T
}

/** Ensure the `custom.customs_description` metafield definition exists (Product owner). */
async function ensureMetafieldDefinition(opts: SeedOpts): Promise<void> {
  const data = await admin<{
    metafieldDefinitionCreate: {
      createdDefinition: { id: string } | null
      userErrors: Array<{ code?: string; message: string }>
    }
  }>(
    opts,
    `mutation CreateDef($def: MetafieldDefinitionInput!) {
      metafieldDefinitionCreate(definition: $def) {
        createdDefinition { id }
        userErrors { code message }
      }
    }`,
    {
      def: {
        name: "Customs Description",
        namespace: METAFIELD_NAMESPACE,
        key: METAFIELD_KEY,
        description: "Plain-language goods description for customs/commercial invoices.",
        type: "single_line_text_field",
        ownerType: "PRODUCT",
      },
    },
  )
  const errs = data.metafieldDefinitionCreate.userErrors
  // TAKEN = definition already exists → idempotent success.
  const blocking = errs.filter((e) => e.code !== "TAKEN")
  if (blocking.length > 0) {
    throw new Error(
      `metafieldDefinitionCreate failed: ${blocking.map((e) => e.message).join("; ")}`,
    )
  }
}

async function findProductByHandle(opts: SeedOpts): Promise<{
  productId: string
  variantId: string
  inventoryItemId: string
} | null> {
  const data = await admin<{
    products: {
      edges: Array<{
        node: {
          id: string
          variants: { edges: Array<{ node: { id: string; inventoryItem: { id: string } } }> }
        }
      }>
    }
  }>(
    opts,
    `query FindProduct($q: String!) {
      products(first: 1, query: $q) {
        edges { node { id variants(first: 1) { edges { node { id inventoryItem { id } } } } } }
      }
    }`,
    { q: `handle:${HANDLE}` },
  )
  const node = data.products.edges[0]?.node
  if (!node) return null
  const variant = node.variants.edges[0]?.node
  if (!variant) return null
  return { productId: node.id, variantId: variant.id, inventoryItemId: variant.inventoryItem.id }
}

async function createProduct(opts: SeedOpts): Promise<{
  productId: string
  variantId: string
  inventoryItemId: string
}> {
  const data = await admin<{
    productCreate: {
      product: {
        id: string
        variants: { edges: Array<{ node: { id: string; inventoryItem: { id: string } } }> }
      } | null
      userErrors: Array<{ field?: string[]; message: string }>
    }
  }>(
    opts,
    `mutation ProductCreate($input: ProductInput!) {
      productCreate(input: $input) {
        product { id variants(first: 1) { edges { node { id inventoryItem { id } } } } }
        userErrors { field message }
      }
    }`,
    { input: { title: TITLE, handle: HANDLE, status: "ACTIVE", productType: "Test Fixture" } },
  )
  const errs = data.productCreate.userErrors
  if (errs.length > 0)
    throw new Error(`productCreate failed: ${errs.map((e) => e.message).join("; ")}`)
  const product = data.productCreate.product
  const variant = product?.variants.edges[0]?.node
  if (!product || !variant) throw new Error("productCreate returned no default variant")
  return { productId: product.id, variantId: variant.id, inventoryItemId: variant.inventoryItem.id }
}

async function setInventoryCustoms(opts: SeedOpts, inventoryItemId: string): Promise<void> {
  const data = await admin<{
    inventoryItemUpdate: {
      inventoryItem: {
        harmonizedSystemCode: string | null
        countryCodeOfOrigin: string | null
      } | null
      userErrors: Array<{ message: string }>
    }
  }>(
    opts,
    `mutation InvUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) {
        inventoryItem { harmonizedSystemCode countryCodeOfOrigin }
        userErrors { message }
      }
    }`,
    {
      id: inventoryItemId,
      input: {
        harmonizedSystemCode: EXPECTED_CUSTOMS.hsCode,
        countryCodeOfOrigin: EXPECTED_CUSTOMS.countryOfOrigin,
      },
    },
  )
  const errs = data.inventoryItemUpdate.userErrors
  if (errs.length > 0)
    throw new Error(`inventoryItemUpdate failed: ${errs.map((e) => e.message).join("; ")}`)
}

async function setCustomsDescription(opts: SeedOpts, productId: string): Promise<void> {
  const data = await admin<{
    metafieldsSet: { userErrors: Array<{ field?: string[]; message: string }> }
  }>(
    opts,
    `mutation SetMeta($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }`,
    {
      metafields: [
        {
          ownerId: productId,
          namespace: METAFIELD_NAMESPACE,
          key: METAFIELD_KEY,
          type: "single_line_text_field",
          value: EXPECTED_CUSTOMS.customsDescription,
        },
      ],
    },
  )
  const errs = data.metafieldsSet.userErrors
  if (errs.length > 0)
    throw new Error(`metafieldsSet failed: ${errs.map((e) => e.message).join("; ")}`)
}

/**
 * Idempotently ensure a dedicated test product on the dogfood store carries HS
 * code + country of origin + the `custom.customs_description` metafield. Returns
 * the product identifiers + the expected values for the e2e to assert against.
 */
export async function seedShopifyCustomsProduct(opts: SeedOpts): Promise<SeededCustomsProduct> {
  await ensureMetafieldDefinition(opts)
  const product = (await findProductByHandle(opts)) ?? (await createProduct(opts))
  await setInventoryCustoms(opts, product.inventoryItemId)
  await setCustomsDescription(opts, product.productId)
  return {
    ...product,
    handle: HANDLE,
    hsCode: EXPECTED_CUSTOMS.hsCode,
    countryOfOrigin: EXPECTED_CUSTOMS.countryOfOrigin,
    customsDescription: EXPECTED_CUSTOMS.customsDescription,
  }
}

// Standalone runner: `bun run apps/web/src/tests/e2e/invoicing/helpers/seed-shopify-customs.ts`
if (import.meta.main) {
  const shopDomain = process.env.SHOPIFY_DEV_STORE_DOMAIN
  const token = process.env.SHOPIFY_DEV_STORE_OFFLINE_TOKEN
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? "2026-01"
  if (!shopDomain || !token) {
    throw new Error(
      "Set SHOPIFY_DEV_STORE_DOMAIN + SHOPIFY_DEV_STORE_OFFLINE_TOKEN (e.g. source .env.test)",
    )
  }
  seedShopifyCustomsProduct({ shopDomain, token, apiVersion })
    .then((p) => {
      // eslint-disable-next-line no-console
      console.log("[seed-shopify-customs] seeded:", JSON.stringify(p, null, 2))
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[seed-shopify-customs] FAILED:", err)
      process.exit(1)
    })
}
