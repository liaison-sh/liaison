// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Deferred tab: open parks only, tax reviews (which wait for a person) first, and a gated
// override click reports that it went for approval.
import { describe, expect, it } from "bun:test"
import { taxOverrideNote, visibleDeferredItems } from "./DeferredList"

describe("Deferred tab", () => {
  it("lists open parks only, tax reviews first", () => {
    const items = visibleDeferredItems([
      {
        id: "a",
        status: "awaiting_data",
        reason: "customer_email_missing",
        order_id: "1",
        order_number: "#1",
      },
      { id: "b", status: "resolved", reason: "order_cancelled", order_id: "2", order_number: "#2" },
      {
        id: "c",
        status: "awaiting_data",
        reason: "shopify_tax_mismatch",
        order_id: "3",
        order_number: "#3",
        resolution_options: ["shopify_reported", "as_computed"],
      },
    ])
    expect(items.map((i) => i.id)).toEqual(["c", "a"])
  })

  it("a gated override says it went for approval, an error shows its message", () => {
    expect(taxOverrideNote({ blocked: { approvalRequestId: "x" } })).toEqual({
      text: "Sent for approval.",
      isError: false,
    })
    expect(
      taxOverrideNote({
        status: "error",
        error: { code: "still_blocked", message: "Still blocked." },
      }),
    ).toEqual({
      text: "Still blocked.",
      isError: true,
    })
  })
})
