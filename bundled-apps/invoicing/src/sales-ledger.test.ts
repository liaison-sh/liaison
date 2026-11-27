// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import {
  attachDocumentsToSale,
  normaliseBuyerEmail,
  normaliseShopifyCustomerId,
  recordSale,
} from "./sales-ledger"
import { createMockDb } from "./test-db"

const base = {
  issuer_profile_id: "11111111-1111-4111-8111-111111111111",
  stream: "hub",
  external_id: "pi_1",
  sold_on: "2026-11-21",
  buyer: { email: "  Ana@Example.COM ", hub_user_id: "6f1c2a9e-0000-4000-8000-000000000001" },
  total_minor: 1999n,
  currency: "usd",
}

describe("the sales ledger", () => {
  test("a sale keeps the identity of the moment it was sold, normalised", async () => {
    const db = createMockDb()
    const { sale_id, created } = await recordSale(db, base)
    expect(created).toBe(true)
    const row = db.__all("sales")[0] as Record<string, unknown>
    expect(row).toMatchObject({
      id: sale_id,
      buyer_email: "ana@example.com",
      hub_user_id: "6f1c2a9e-0000-4000-8000-000000000001",
      shopify_customer_id: null,
      source_ref: "pi_1",
      total_minor: "1999",
      currency: "USD",
      state: "pending",
    })
  })

  test("the same sale again is the same row; its identity never changes", async () => {
    const db = createMockDb()
    const first = await recordSale(db, base)
    const again = await recordSale(db, { ...base, buyer: { email: "someone@else.com" } })
    expect(again).toEqual({ sale_id: first.sale_id, created: false })
    expect(db.__all("sales")).toHaveLength(1)
    expect((db.__all("sales")[0] as Record<string, unknown>).buyer_email).toBe("ana@example.com")
  })

  test("attaching its invoices marks the sale issued, and it never goes back to pending", async () => {
    const db = createMockDb()
    const doc = (await db.insert("documents", { type: "invoice" })) as { id: string }
    const { sale_id } = await recordSale(db, base)
    await attachDocumentsToSale(db, sale_id, [doc.id])
    expect((db.__all("documents")[0] as Record<string, unknown>).sale_id).toBe(sale_id)
    await recordSale(db, { ...base, state: "pending" })
    expect((db.__all("sales")[0] as Record<string, unknown>).state).toBe("issued")
  })

  test("ids and emails are normalised the way the API compares them", () => {
    expect(normaliseBuyerEmail("  A@B.com ")).toBe("a@b.com")
    expect(normaliseBuyerEmail(" ")).toBeNull()
    expect(normaliseShopifyCustomerId("gid://shopify/Customer/8123")).toBe("8123")
    expect(normaliseShopifyCustomerId(8123)).toBe("8123")
    expect(normaliseShopifyCustomerId("abc")).toBeNull()
  })

  test("a malformed sale date is refused before anything is written", async () => {
    const db = createMockDb()
    await expect(recordSale(db, { ...base, sold_on: "21/11/2026" })).rejects.toThrow(/sold_on/)
    expect(db.__all("sales")).toHaveLength(0)
  })
})
