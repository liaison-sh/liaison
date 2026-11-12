// SPDX-License-Identifier: FSL-1.1-ALv2
//
// toy-shop — a tiny, throwaway, non-liaison fixture adapter (success
// criterion 9 in the pipeline spec: "portability genuinely exercised").
// Authored purely by following
// `.claude/skills/database-adapter-authoring/SKILL.md`, against a small
// imaginary 3-table shop schema that is NOT part of liaison's own database
// — proving the connector adapts to a foreign schema, not just describing
// how `liaison-self` was built.
//
// Imaginary target schema (not migrated anywhere — this is a catalog-shape
// fixture only, exercised by validateCatalog/registerAdapter, never
// connected to a real database):
//
//   shop.customers(id, email, display_name, created_at, password_hash)
//   shop.orders(id, customer_id, status, total_cents, placed_at)
//   shop.products(id, sku, name, price_cents, api_secret)
//
// `shop.customers.password_hash` and `shop.products.api_secret` are
// deliberately present in the imaginary schema but deliberately ABSENT from
// every read's `columns`/`sql` below — Step 3 of the authoring skill's
// secret-column checklist applied by hand, since there is no shared
// `SECRET_COLUMNS` constant for a foreign schema (that constant only covers
// liaison's own tables).
//
// THIS IS A FIXTURE, NOT A SELECTABLE PRODUCTION ADAPTER. It registers into
// the same db-core adapter registry as `liaison-self` (so its own test can
// exercise `registerAdapter`/`getAdapter` end-to-end), but no deployment
// should ever set `LIAISON_DATABASE_ADAPTER=toy-shop` against a real
// database — the tables referenced here don't exist in liaison's schema.

import type { ReadCatalog } from "@liaison/db-core"
import { registerAdapter, validateCatalog } from "@liaison/db-core"

export const toyShopCatalog: ReadCatalog = {
  adapter: "toy-shop",
  reads: {
    customer_by_email: {
      description: "Look up a toy-shop customer by email.",
      domain: "catalog",
      sql: "SELECT id, email, display_name, created_at FROM shop.customers WHERE email = :email",
      params: { email: { type: "string", description: "Customer email" } },
      columns: ["id", "email", "display_name", "created_at"],
      tables: ["shop.customers"],
      maxRows: 1,
    },
    recent_orders_by_customer: {
      description: "List a customer's recent orders, most recent first.",
      domain: "orders",
      sql: "SELECT id, customer_id, status, total_cents, placed_at FROM shop.orders WHERE customer_id = :customerId ORDER BY placed_at DESC",
      params: { customerId: { type: "string", description: "Customer UUID" } },
      columns: ["id", "customer_id", "status", "total_cents", "placed_at"],
      tables: ["shop.orders"],
      maxRows: 50,
    },
    products_by_sku_prefix: {
      description: "Search toy-shop products by SKU prefix.",
      domain: "inventory",
      sql: "SELECT id, sku, name, price_cents FROM shop.products WHERE sku LIKE :skuPrefix ORDER BY sku",
      params: {
        skuPrefix: { type: "string", description: "SKU prefix, e.g. 'WID-' (caller appends %)" },
      },
      columns: ["id", "sku", "name", "price_cents"],
      tables: ["shop.products"],
      maxRows: 100,
    },
  },
}

// Validate + register at import time, same discipline as liaison-self.ts —
// an invalid fixture catalog should fail fast, not silently at first use.
export const validatedToyShopCatalog = validateCatalog(toyShopCatalog)
registerAdapter(toyShopCatalog)
