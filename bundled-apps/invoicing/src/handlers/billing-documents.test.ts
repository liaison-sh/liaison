// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Guard for the shared findBillingDocumentsForOrder helper: a credit note
// inherits its original invoice's shopify_order_id (creditNoteCreateAndIssue,
// mutations.ts), so a plain where:{shopify_order_id} fetch also returns the
// order's credit notes. Every "billing documents for this order" consumer
// must exclude them centrally, here.

import { describe, expect, test } from "bun:test"
import { createMockDb } from "../test-db"
import { findBillingDocumentsForOrder } from "./billing-documents"

describe("findBillingDocumentsForOrder", () => {
  test("the shared order document lookup never returns credit notes", async () => {
    const db = createMockDb()
    db.__seed("documents", [
      {
        id: "doc-inv",
        type: "invoice",
        shopify_order_id: "ord-1",
        status: "issued",
      },
      {
        id: "doc-cn",
        type: "credit_note",
        shopify_order_id: "ord-1",
        status: "issued",
      },
    ])

    const rows = await findBillingDocumentsForOrder(db, "ord-1")

    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe("doc-inv")
    expect(rows.some((r) => r.type === "credit_note")).toBe(false)
  })

  test("the shared order document lookup never returns quotes", async () => {
    const db = createMockDb()
    db.__seed("documents", [
      {
        id: "doc-quote",
        type: "quote",
        shopify_order_id: "ord-X",
        status: "issued",
      },
      {
        id: "doc-inv",
        type: "invoice",
        shopify_order_id: "ord-X",
        status: "issued",
      },
    ])

    const rows = await findBillingDocumentsForOrder(db, "ord-X")

    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe("doc-inv")
    expect(rows.some((r) => r.type === "quote")).toBe(false)
  })

  test("an order with only a credit note returns no billing documents", async () => {
    const db = createMockDb()
    db.__seed("documents", [
      {
        id: "doc-cn",
        type: "credit_note",
        shopify_order_id: "ord-2",
        status: "issued",
      },
    ])

    const rows = await findBillingDocumentsForOrder(db, "ord-2")

    expect(rows).toHaveLength(0)
  })
})
