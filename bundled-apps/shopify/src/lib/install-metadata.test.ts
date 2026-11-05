// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression coverage for the sandbox-findMany casing bug: the db bridge runs
// `SELECT *` and returns raw snake_case columns, so every reader that accessed
// `row.shopDomain` off a findMany result silently read `undefined` — which made
// `getShopifyClient` throw "install_metadata row not found" even when the row
// existed. `camelizeRow`/`loadInstallMetadata` normalize this.
import { describe, expect, it } from "bun:test"
import type { AppContext } from "@liaison/app-sdk"
import { camelizeRow, camelizeRows, loadInstallMetadata } from "./install-metadata"

describe("camelizeRow", () => {
  it("converts snake_case keys to camelCase", () => {
    const r = camelizeRow({ shop_domain: "x.myshopify.com", api_base_url: null })
    expect(r?.shopDomain).toBe("x.myshopify.com")
    expect(r?.apiBaseUrl).toBeNull()
  })

  it("handles the multi-underscore granted_o_auth_scopes column", () => {
    const r = camelizeRow<{ grantedOAuthScopes?: string[] }>({ granted_o_auth_scopes: ["a"] })
    expect(JSON.stringify(r?.grantedOAuthScopes)).toBe('["a"]')
  })

  it("is idempotent on already-camelCase rows (mock-db unit path stays safe)", () => {
    const r = camelizeRow({ shopDomain: "x", apiBaseUrl: "y" })
    expect(r?.shopDomain).toBe("x")
    expect(r?.apiBaseUrl).toBe("y")
  })

  it("maps null/undefined to null", () => {
    expect(camelizeRow(null)).toBeNull()
    expect(camelizeRow(undefined)).toBeNull()
  })

  it("camelizeRows maps each row and tolerates empty/nullish", () => {
    const rows = camelizeRows<{ shopDomain?: string }>([{ shop_domain: "a" }, { shop_domain: "b" }])
    expect(rows.length).toBe(2)
    expect(rows[0]?.shopDomain).toBe("a")
    expect(rows[1]?.shopDomain).toBe("b")
    expect(camelizeRows(null).length).toBe(0)
  })
})

describe("loadInstallMetadata", () => {
  function ctxWith(rows: Array<Record<string, unknown>>): AppContext {
    return { db: { findMany: async () => rows } } as unknown as AppContext
  }

  it("normalizes a raw snake_case install_metadata row to camelCase", async () => {
    const meta = await loadInstallMetadata(
      ctxWith([
        {
          id: "1",
          org_id: "o1",
          shop_domain: "example-store.myshopify.com",
          api_base_url: null,
          connection_status: "connected",
          inventory_location_allowlist: [],
          unfulfilled_threshold_hours: 24,
        },
      ]),
    )
    expect(meta?.shopDomain).toBe("example-store.myshopify.com")
    expect(meta?.connectionStatus).toBe("connected")
    expect(meta?.unfulfilledThresholdHours).toBe(24)
  })

  it("returns null when no row exists", async () => {
    expect(await loadInstallMetadata(ctxWith([]))).toBeNull()
  })
})
