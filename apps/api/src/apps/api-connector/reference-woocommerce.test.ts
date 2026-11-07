// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The WooCommerce example in the authoring reference (section `woocommerce`)
// is a document an agent copies as is: it must stay a valid adapter, and its
// operations must project a WooCommerce response the way the section says.
import { describe, expect, it } from "bun:test"
import { firstPageQuery, nextPageQuery, project } from "@liaison/api-connector-core"
import { validateAdapterDocument } from "./adapter-policy"
import { readReference, referenceSections } from "./authoring"

function exampleDocument(): unknown {
  const section = referenceSections().find((s) => s.id === "woocommerce")
  if (!section) throw new Error("the reference has no woocommerce section")
  const blocks = [...section.text.matchAll(/```json\n([\s\S]*?)\n```/g)]
  expect(blocks.length).toBe(1)
  return JSON.parse(blocks[0]?.[1] ?? "")
}

function validExample() {
  const r = validateAdapterDocument(exampleDocument())
  if (!r.ok) throw new Error(`invalid example: ${JSON.stringify(r.issues)}`)
  return r.adapter
}

function op(name: string) {
  const found = validExample().operations.find((o) => o.name === name)
  if (!found) throw new Error(`no operation ${name}`)
  return found
}

const ORDER = {
  id: 727,
  parent_id: 0,
  number: "727",
  order_key: "wc_order_secret",
  status: "processing",
  currency: "EUR",
  date_created: "2026-10-12T14:03:11",
  date_created_gmt: "2026-10-12T12:03:11",
  total: "129.90",
  customer_id: 12,
  billing: { first_name: "Ana", last_name: "Silva", email: "ana@example.com", phone: "+33 1" },
  shipping: { address_1: "1 rue Example" },
  payment_method: "stripe",
  line_items: [
    { id: 315, product_id: 93, name: "Desk lamp", quantity: 2, total: "79.90", sku: "LAMP" },
    { id: 316, product_id: 22, name: "Bulb", quantity: 1, total: "50.00", sku: "BULB" },
  ],
}

describe("the WooCommerce example of the authoring reference", () => {
  it("is returned as its own section, within the reading budget", () => {
    const r = readReference("woocommerce")
    if ("error" in r) throw new Error(r.error.message)
    expect(r.text.length).toBeLessThanOrEqual(30_000)
    expect(r.text).toContain("/wp-json/wc/v3")
  })

  it("is a valid adapter document", () => {
    const adapter = validExample()
    expect(adapter.auth).toEqual({ type: "basic" })
    expect(adapter.operations.map((o) => o.name)).toEqual([
      "orders_list",
      "orders_get",
      "products_list",
      "reports_top_sellers",
    ])
    for (const o of adapter.operations) expect(o.kind).toBe("read")
  })

  it("leaves out reports/sales, whose per-day totals are keyed by date", () => {
    const adapter = validExample()
    expect(adapter.operations.some((o) => o.path.startsWith("/reports/sales"))).toBe(false)
  })

  it("projects an orders page to flat rows, without the order key or addresses", () => {
    const { items } = project([ORDER, { ...ORDER, id: 728, line_items: [] }], op("orders_list"))
    expect(items[0]).toEqual({
      id: 727,
      number: "727",
      status: "processing",
      date_created: "2026-10-12T14:03:11",
      date_created_gmt: "2026-10-12T12:03:11",
      total: "129.90",
      currency: "EUR",
      customer_email: "ana@example.com",
      line_item_ids: [315, 316],
    })
    expect(items).toHaveLength(2)
    expect(JSON.stringify(items)).not.toContain("wc_order_secret")
    expect(JSON.stringify(items)).not.toContain("rue Example")
  })

  it("walks orders 100 at a time from page 1, two pages at most", () => {
    const orders = op("orders_list")
    expect(firstPageQuery(orders)).toEqual([
      ["page", "1"],
      ["per_page", "100"],
    ])
    expect(nextPageQuery(orders, [], 1, 100)).toEqual([
      ["page", "2"],
      ["per_page", "100"],
    ])
    expect(nextPageQuery(orders, [], 1, 40)).toBeNull()
    expect(nextPageQuery(orders, [], 2, 100)).toBeNull()
  })

  it("projects one order with its lines", () => {
    const { items } = project(ORDER, op("orders_get"))
    expect(items[0]).toMatchObject({
      id: 727,
      customer_last_name: "Silva",
      line_product_ids: [93, 22],
      line_quantities: [2, 1],
      line_totals: ["79.90", "50.00"],
    })
  })

  it("projects the top sellers array", () => {
    const { items } = project(
      [
        { title: "Desk lamp", product_id: 93, quantity: 41 },
        { title: "Bulb", product_id: 22, quantity: 17 },
      ],
      op("reports_top_sellers"),
    )
    expect(items).toEqual([
      { product_id: 93, title: "Desk lamp", quantity: 41 },
      { product_id: 22, title: "Bulb", quantity: 17 },
    ])
  })
})
