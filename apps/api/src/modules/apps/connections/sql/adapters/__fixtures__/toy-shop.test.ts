// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Proves success criterion 9 (portability): a second, non-liaison fixture
// adapter — authored purely by following
// `.claude/skills/database-adapter-authoring/SKILL.md` — loads, validates,
// registers, and renders a readonly-role grants file cleanly through the
// exact same db-core machinery `liaison-self` uses. No connector source was
// read to write `toy-shop.ts`; this test confirms the result actually works.

import { describe, expect, test } from "bun:test"
import { getAdapter, renderReadonlyGrants } from "@liaison/db-core"
import { toyShopCatalog, validatedToyShopCatalog } from "./toy-shop"

describe("toy-shop fixture adapter — portability proof", () => {
  test("validates cleanly (import-time validateCatalog did not throw)", () => {
    expect(validatedToyShopCatalog.adapter).toBe("toy-shop")
    expect(Object.keys(validatedToyShopCatalog.reads)).toHaveLength(3)
  })

  test("registers into the shared db-core adapter registry and is resolvable by name", () => {
    const resolved = getAdapter("toy-shop")
    expect(resolved).toBeDefined()
    expect(resolved?.adapter).toBe("toy-shop")
    expect(Object.keys(resolved?.reads ?? {}).sort()).toEqual([
      "customer_by_email",
      "products_by_sku_prefix",
      "recent_orders_by_customer",
    ])
  })

  test("every read declares a non-empty column allow-list and touches at least one table", () => {
    for (const [name, read] of Object.entries(toyShopCatalog.reads)) {
      expect(read.columns.length, `${name}.columns should be non-empty`).toBeGreaterThan(0)
      expect(read.tables.length, `${name}.tables should be non-empty`).toBeGreaterThan(0)
    }
  })

  test("no read's column allow-list references the imaginary schema's secret-shaped columns", () => {
    const secretShaped = ["password_hash", "api_secret"]
    for (const [name, read] of Object.entries(toyShopCatalog.reads)) {
      for (const col of read.columns) {
        expect(secretShaped, `${name}.columns should not include ${col}`).not.toContain(col)
      }
      for (const secret of secretShaped) {
        expect(read.sql.toLowerCase(), `${name}.sql should not reference ${secret}`).not.toContain(
          secret,
        )
      }
    }
  })

  test("grants-renderer renders a well-formed allow-list grants SQL from this catalog", () => {
    // renderReadonlyGrants requires a RESOLVED catalog (grantColumns filled
    // in) — use validatedToyShopCatalog, the output of validateCatalog, same
    // as production adapter registration does.
    const { sql, schemas, tables } = renderReadonlyGrants(validatedToyShopCatalog)

    expect(schemas).toEqual(["shop"])
    expect(tables.sort()).toEqual(["shop.customers", "shop.orders", "shop.products"])

    // Role bootstrap + read-only defaults.
    expect(sql).toContain("CREATE ROLE liaison_readonly")
    expect(sql).toContain("ALTER ROLE liaison_readonly SET default_transaction_read_only = on")

    // Allow-list grants, one per touched table, and USAGE on the one schema.
    // S1 fail-closed model: EVERY grant is column-scoped, even on this
    // foreign schema db-core has never heard of (no SECRET_COLUMNS entries
    // for `shop.*` at all) — safety no longer depends on SECRET_COLUMNS
    // coverage, so a bare full-row grant is never emitted, for ANY table.
    expect(sql).toContain("GRANT USAGE ON SCHEMA shop TO liaison_readonly")
    expect(sql).toContain(
      "GRANT SELECT (created_at, display_name, email, id) ON shop.customers TO liaison_readonly",
    )
    expect(sql).toContain(
      "GRANT SELECT (customer_id, id, placed_at, status, total_cents) ON shop.orders TO liaison_readonly",
    )
    expect(sql).toContain(
      "GRANT SELECT (id, name, price_cents, sku) ON shop.products TO liaison_readonly",
    )

    // Function-execution lockdown applied to the touched schema too.
    expect(sql).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA shop FROM PUBLIC")
    expect(sql).toContain("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA shop FROM liaison_readonly")

    // Never a blanket ALL TABLES grant, and never a bare full-row grant —
    // the allow-list model.
    expect(sql).not.toContain("ALL TABLES")
    expect(sql).not.toMatch(/GRANT SELECT ON \S+ TO liaison_readonly;/)
  })
})
