// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { KNOWN_CONTRACTS } from "./einvoicing-pa"
import {
  contractEventSource,
  parseContractSubscription,
  REVENUE_STREAM,
  revenueStreamV1,
  type Sale,
  saleProblems,
} from "./revenue-stream"

const SALE: Sale = {
  external_id: "pi_1",
  sold_at: "2026-11-20T10:00:00.000Z",
  paid: { status: "paid", payment_ref: "ch_1" },
  currency: "EUR",
  buyer: { email: "a@example.com", name: "A B", billing: { country: "DE" } },
  lines: [
    {
      description: "Pack",
      quantity: "1",
      unit_price_minor: "1000",
      kind: "service",
      tax: { rate_bp: 1900, amount_minor: "190", reported_by_source: true },
    },
  ],
  totals: { total_minor: "1190", subtotal_minor: "1000", tax_minor: "190" },
}

describe("revenue-stream@1", () => {
  it("is a known, multi-provider contract with read ops only", () => {
    expect(KNOWN_CONTRACTS[REVENUE_STREAM]).toBe(revenueStreamV1)
    expect(revenueStreamV1.multiProvider).toBe(true)
    for (const op of Object.values(revenueStreamV1.ops)) expect(op.outbound).toBeUndefined()
    expect(revenueStreamV1.events?.["sale:paid"]?.required).toBe(true)
  })

  it("accepts a well formed sale", () => {
    expect(saleProblems(SALE)).toEqual([])
  })

  it("names every problem of a malformed sale", () => {
    const bad = {
      ...SALE,
      external_id: "",
      sold_at: "yesterday",
      currency: "eur",
      totals: { total_minor: "11.90" },
      lines: [{ ...SALE.lines[0], kind: "gift", unit_price_minor: 10.5 }],
      refunds: [{ refund_id: "", amount_minor: "x", at: "" }],
    }
    const problems = saleProblems(bad)
    expect(problems).toContain("external_id: required")
    expect(problems).toContain("sold_at: an ISO instant is required")
    expect(problems).toContain("currency: an ISO 4217 code is required")
    expect(problems).toContain("totals.total_minor: an integer string is required")
    expect(problems).toContain("lines[0].kind: one of goods, software, service, shipping")
    expect(problems).toContain("lines[0].unit_price_minor: an integer string")
    expect(problems).toContain("refunds[0].refund_id: required")
    expect(saleProblems(null)).toEqual(["sale: not an object"])
  })

  it("parses the contract subscription form", () => {
    expect(parseContractSubscription("contract:revenue-stream@1/sale:paid")).toEqual({
      contract: "revenue-stream@1",
      event: "sale:paid",
    })
    expect(parseContractSubscription("shopify/order:created")).toBeNull()
    expect(parseContractSubscription("contract:revenue-stream/sale:paid")).toBeNull()
    expect(contractEventSource("revenue-stream@1")).toBe("contract:revenue-stream@1")
  })
})
