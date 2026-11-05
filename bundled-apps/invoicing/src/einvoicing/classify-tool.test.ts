// SPDX-License-Identifier: FSL-1.1-ALv2
//
// einvoicing_classify's input forms. A Shopify order id is a number to most callers: a weak model
// passes it as one, and the tool must answer rather than fail on the type.
import { describe, expect, test } from "bun:test"
import { createMockDb } from "../test-db"
import { einvoicingClassify } from "./classify-tool"

const ORDER = "7403003"

function ctx() {
  const db = createMockDb({
    seed: {
      documents: [
        {
          id: "doc-1",
          type: "invoice",
          status: "issued",
          shopify_order_id: ORDER,
          regime: "e_reporting",
          regime_reasons: [{ code: "buyer_not_in_france" }],
        },
      ],
    },
  })
  return { db } as never
}

describe("einvoicing_classify input", () => {
  test("a numeric Shopify order id is the same order as its string form", async () => {
    // red: a number was read as no id at all -> invalid_input, and the agent had to guess why.
    const asNumber = (await einvoicingClassify(ctx(), { shopify_order_id: Number(ORDER) as never })) as Record<string, unknown>
    expect(asNumber).toMatchObject({ status: "ok", subject: "order", shopify_order_id: ORDER, regime: "e_reporting" })
    const asGid = (await einvoicingClassify(ctx(), { shopify_order_id: `gid://shopify/Order/${ORDER}` })) as Record<string, unknown>
    expect(asGid).toMatchObject({ status: "ok", regime: "e_reporting" })
  })

  test("no subject, or two, is refused with the one rule", async () => {
    const none = (await einvoicingClassify(ctx(), {})) as { status: string; error: { code: string } }
    expect(none.error.code).toBe("invalid_input")
    const two = (await einvoicingClassify(ctx(), { shopify_order_id: ORDER, contact_id: "c-1" })) as { status: string; error: { code: string } }
    expect(two.error.code).toBe("invalid_input")
  })
})
