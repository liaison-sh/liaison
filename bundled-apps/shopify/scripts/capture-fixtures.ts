#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
// Captures GraphQL response fixtures from the seeded dev store. The Phase 16
// unit tests (under liaison/bundled-apps/shopify/src/) import these JSON files at
// test time so no live Shopify call is needed in the deterministic CI path.
//
// Run AFTER dev-store-seed.ts has succeeded.
//
// Run: bun run liaison/bundled-apps/shopify/scripts/capture-fixtures.ts
//
// Fixture location: liaison/bundled-apps/shopify/src/__fixtures__/shopify/<name>.json
//
// Each fixture file's content is the verbatim GraphQL response body (data +
// extensions) so tests get a high-fidelity sample including pagination
// envelopes and cost metadata.

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { graphqlThrottled, loadShopifyEnv } from "./_shopify-client.ts"

interface FixtureSpec {
  name: string
  query: string
  variables?: Record<string, unknown>
  /** If true, skip with a warning when access is denied (instead of failing).
   * Use for fixtures that depend on Shopify-restricted scopes (e.g. read_users)
   * that may not be granted on every dev store. */
  skipOnAccessDenied?: boolean
}

const FIXTURES: FixtureSpec[] = [
  {
    name: "orders-search",
    query: `
      query OrdersSearch($q: String!, $first: Int!) {
        orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              id name email displayFinancialStatus displayFulfillmentStatus createdAt
              currentTotalPriceSet { presentmentMoney { amount currencyCode } shopMoney { amount currencyCode } }
              customer { id email firstName lastName }
              lineItems(first: 5) {
                edges { node { id title quantity variant { id sku } originalUnitPriceSet { presentmentMoney { amount currencyCode } } } }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `,
    variables: { q: "tag:liaison-seed", first: 10 },
  },
  {
    name: "orders-get",
    // Wrapped to pick the first seeded order ID up-front.
    query: `
      query OrdersFirst { orders(first: 1, query: "tag:liaison-seed") { edges { node { id } } } }
    `,
  },
  {
    name: "customers-search",
    query: `
      query CustomersSearch($q: String!, $first: Int!) {
        customers(first: $first, query: $q) {
          edges {
            node {
              id email firstName lastName tags
              defaultAddress { countryCode countryCodeV2 }
              numberOfOrders
              amountSpent { amount currencyCode }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `,
    variables: { q: "tag:liaison-seed", first: 10 },
  },
  {
    name: "products-search",
    query: `
      query ProductsSearch($q: String!, $first: Int!) {
        products(first: $first, query: $q) {
          edges {
            node {
              id title vendor status totalInventory
              variants(first: 3) { edges { node { id sku price inventoryQuantity } } }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `,
    variables: { q: "tag:liaison-seed", first: 10 },
  },
  {
    name: "markets-list",
    query: `
      query Markets {
        markets(first: 10) {
          edges {
            node {
              id name handle enabled
              currencySettings { baseCurrency { currencyCode } localCurrencies }
              regions(first: 10) { edges { node { id name ... on MarketRegionCountry { code } } } }
            }
          }
        }
      }
    `,
  },
  {
    name: "staff-members",
    skipOnAccessDenied: true,
    query: `
      query StaffMembers {
        staffMembers(first: 20) {
          edges {
            node {
              id name email active isShopOwner
              accountType
              privateData { accountSettingsUrl }
            }
          }
        }
      }
    `,
  },
  {
    name: "shop",
    query: `
      query Shop {
        shop {
          id name email myshopifyDomain primaryDomain { url host }
          currencyCode
          plan { displayName }
          ianaTimezone
        }
      }
    `,
  },
  {
    name: "locations",
    query: `
      query Locations {
        locations(first: 10) {
          edges { node { id name address { countryCode } } }
        }
      }
    `,
  },
]

const FIXTURE_DIR = resolve(
  import.meta.dirname ?? new URL(".", import.meta.url).pathname,
  "..",
  "src",
  "__fixtures__",
  "shopify",
)

async function captureOne(
  env: ReturnType<typeof loadShopifyEnv>,
  spec: FixtureSpec,
): Promise<void> {
  try {
    const result = await graphqlThrottled(env, spec.query, spec.variables)
    const filePath = resolve(FIXTURE_DIR, `${spec.name}.json`)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(result, null, 2) + "\n", "utf8")
    console.log(`✓ ${spec.name}.json (${JSON.stringify(result).length} bytes)`)
  } catch (err) {
    const msg = (err as Error).message
    if (spec.skipOnAccessDenied && /access denied|not approved/i.test(msg)) {
      console.warn(`⚠ ${spec.name}.json — SKIPPED (${msg.split(":").slice(-1)[0]?.trim()})`)
      console.warn(`  (Restricted scope — enable in Partner Dashboard's API access if needed.)`)
      return
    }
    throw err
  }
}

async function captureOrdersGet(env: ReturnType<typeof loadShopifyEnv>): Promise<void> {
  // Look up the first seeded order, then fetch its full detail shape.
  const head = await graphqlThrottled<{ orders: { edges: Array<{ node: { id: string } }> } }>(
    env,
    `query { orders(first: 1, query: "tag:liaison-seed", sortKey: CREATED_AT) { edges { node { id } } } }`,
  )
  const id = head.data?.orders?.edges?.[0]?.node?.id
  if (!id) {
    console.warn("⚠ orders-get: no seeded order found; skipping (run dev-store-seed.ts first).")
    return
  }
  const detail = await graphqlThrottled(
    env,
    `
      query OrderGet($id: ID!) {
        order(id: $id) {
          id name email phone note tags createdAt updatedAt
          displayFinancialStatus displayFulfillmentStatus
          currentTotalPriceSet { presentmentMoney { amount currencyCode } shopMoney { amount currencyCode } }
          subtotalPriceSet { presentmentMoney { amount currencyCode } }
          totalShippingPriceSet { presentmentMoney { amount currencyCode } }
          totalTaxSet { presentmentMoney { amount currencyCode } }
          customer { id email firstName lastName }
          shippingAddress { name address1 address2 city province country zip countryCode }
          billingAddress { name address1 city country }
          lineItems(first: 50) {
            edges { node { id title quantity variant { id sku title } originalUnitPriceSet { presentmentMoney { amount currencyCode } } } }
          }
          fulfillments(first: 10) {
            id status createdAt
            trackingInfo { number company url }
          }
          refunds { id createdAt totalRefundedSet { presentmentMoney { amount currencyCode } } }
          metafields(first: 5) { edges { node { id namespace key value type } } }
        }
      }
    `,
    { id },
  )
  const filePath = resolve(FIXTURE_DIR, "orders-get.json")
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(detail, null, 2) + "\n", "utf8")
  console.log(`✓ orders-get.json (resolved id=${id})`)
}

async function main() {
  const env = loadShopifyEnv()
  console.log(`→ Capturing fixtures from ${env.domain} (API ${env.apiVersion})\n`)
  console.log(`  Writing to ${FIXTURE_DIR}\n`)

  for (const spec of FIXTURES) {
    if (spec.name === "orders-get") {
      await captureOrdersGet(env)
    } else {
      await captureOne(env, spec)
    }
  }

  console.log(
    "\n✅ Fixtures captured. Commit them to git so unit tests are deterministic across machines.",
  )
}

main().catch((err) => {
  console.error("\n❌ Capture failed:", err.message)
  process.exit(1)
})
