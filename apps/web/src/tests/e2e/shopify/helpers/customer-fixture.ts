// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 E2E harness H3 — paired customer fixtures.
//
// Each helper returns a structurally-honest pair: a `graphql` shape that
// the mock can serve when an op named `customers` (or similar) is
// requested, and a `webhook` shape matching the Shopify
// `customers/create` webhook body the kernel route receives. The two
// are kept in lockstep so the test asserts the same identity flowing
// through both bulk-backfill (GraphQL) and webhook ingestion paths.

export interface CustomerFixture {
  shopifyId: string
  email: string
  firstName: string
  lastName: string
}

export interface CustomerGraphqlNode {
  id: string
  email: string
  firstName: string
  lastName: string
  tags: string[]
  defaultAddress: { country: string; countryCode: string } | null
  createdAt: string
  updatedAt: string
}

export interface CustomerWebhookBody {
  // Shopify webhook payloads carry many more fields than we model; the index
  // signature keeps the body assignable to `Record<string, unknown>` (the
  // dispatchTestWebhook body param) without dropping the typed fields below.
  [key: string]: unknown
  id: number
  email: string
  first_name: string
  last_name: string
  tags: string
  created_at: string
  updated_at: string
  default_address: { country: string; country_code: string } | null
}

/** Shopify uses `gid://shopify/Customer/<numeric>` for GraphQL ids. */
function gid(numeric: string): string {
  return `gid://shopify/Customer/${numeric}`
}

/** Stable timestamps so visual goldens don't drift. */
const FIXED_CREATED = "2026-05-01T12:00:00Z"
const FIXED_UPDATED = "2026-05-01T12:00:00Z"

export function customerFixture(opts: {
  numericId?: string
  email: string
  firstName?: string
  lastName?: string
}): CustomerFixture {
  return {
    shopifyId: gid(opts.numericId ?? "1"),
    email: opts.email,
    firstName: opts.firstName ?? "Test",
    lastName: opts.lastName ?? "User",
  }
}

export function customerGraphqlNode(f: CustomerFixture): CustomerGraphqlNode {
  return {
    id: f.shopifyId,
    email: f.email,
    firstName: f.firstName,
    lastName: f.lastName,
    tags: [],
    defaultAddress: { country: "France", countryCode: "FR" },
    createdAt: FIXED_CREATED,
    updatedAt: FIXED_UPDATED,
  }
}

/** Webhook payload mirrors Shopify's REST-shape `customers/create` body. */
export function customerWebhookBody(f: CustomerFixture): CustomerWebhookBody {
  // Extract numeric id from `gid://shopify/Customer/<n>`
  const numeric = Number(f.shopifyId.split("/").pop() ?? "0")
  return {
    id: numeric,
    email: f.email,
    first_name: f.firstName,
    last_name: f.lastName,
    tags: "",
    created_at: FIXED_CREATED,
    updated_at: FIXED_UPDATED,
    default_address: { country: "France", country_code: "FR" },
  }
}

/**
 * Build a multi-customer GraphQL `customers` response the mock can serve.
 * Used by S1 (post-install backfill seeds N contacts).
 */
export function customersGraphqlResponse(fixtures: CustomerFixture[]): unknown {
  return {
    data: {
      customers: {
        nodes: fixtures.map(customerGraphqlNode),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    extensions: {
      cost: {
        actualQueryCost: fixtures.length,
        throttleStatus: {
          currentlyAvailable: 1999,
          maximumAvailable: 2000,
          restoreRate: 100,
        },
      },
    },
  }
}
