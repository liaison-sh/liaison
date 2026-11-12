// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B13 — Per-entity URL-template tests (spec validation §10.9).
//
// Each `it("[§10.9] ...")` description is grep-able by the validation stage
// to confirm spec §10.9 is satisfied. The seven entities here are the
// canonical detail-entity types per spec §3.8.
import { describe, expect, it } from "bun:test"
import {
  adminOrderUrl,
  adminResourceId,
  DETAIL_ENTITY_URL_TEMPLATES,
  renderDetailUrl,
  renderUrlTemplate,
  shopSubdomain,
} from "./url-template"

const SHOP = "acme-demo"

describe("renderUrlTemplate", () => {
  it("substitutes {{var}} placeholders", () => {
    expect(
      renderUrlTemplate("https://{{shop}}.myshopify.com/x/{{id}}", { shop: SHOP, id: "42" }),
    ).toBe("https://acme-demo.myshopify.com/x/42")
  })

  it("throws when a required variable is missing or empty", () => {
    expect(() => renderUrlTemplate("https://{{shop}}/x/{{id}}", { shop: SHOP, id: "" })).toThrow(
      /id/,
    )
    expect(() =>
      renderUrlTemplate("https://{{shop}}/x/{{id}}", { shop: SHOP } as unknown as {
        shop: string
        id: string
      }),
    ).toThrow(/id/)
  })
})

describe("detail-entity URL templates", () => {
  it("[§10.9] order panel: Open in Shopify href matches urlTemplate", () => {
    const url = renderDetailUrl("order", { shop: SHOP, id: "9001" })
    expect(url).toBe("https://acme-demo.myshopify.com/admin/orders/9001")
  })

  it("[§10.9] customer panel: Open in Shopify href matches urlTemplate", () => {
    const url = renderDetailUrl("customer", { shop: SHOP, id: "c42" })
    expect(url).toBe("https://acme-demo.myshopify.com/admin/customers/c42")
  })

  it("[§10.9] product panel: Open in Shopify href matches urlTemplate", () => {
    const url = renderDetailUrl("product", { shop: SHOP, id: "p7" })
    expect(url).toBe("https://acme-demo.myshopify.com/admin/products/p7")
  })

  it("[§10.9] draft-order panel: Open in Shopify href matches urlTemplate", () => {
    const url = renderDetailUrl("draftOrder", { shop: SHOP, id: "d11" })
    expect(url).toBe("https://acme-demo.myshopify.com/admin/draft_orders/d11")
  })

  it("[§10.9] return panel: Open in Shopify href matches urlTemplate", () => {
    const url = renderDetailUrl("return", { shop: SHOP, id: "r5" })
    expect(url).toBe("https://acme-demo.myshopify.com/admin/returns/r5")
  })

  it("[§10.9] refund panel: Open in Shopify href matches urlTemplate (composite orderId+id)", () => {
    const url = renderDetailUrl("refund", { shop: SHOP, id: "rf3", orderId: "9001" })
    expect(url).toBe("https://acme-demo.myshopify.com/admin/orders/9001#refund-rf3")
  })

  it("[§10.9] refund panel: degrades to the order-agnostic refund path when orderId is missing", () => {
    // CLUSTER 7.3 fix: a deep-linked refund without its parent order must NOT
    // crash the whole panel render (the old behaviour threw on missing orderId,
    // which propagated out of ExternalLink and tripped the mount-error boundary).
    // It now falls back to a real (if less specific) admin URL.
    const url = renderDetailUrl("refund", { shop: SHOP, id: "rf3" })
    expect(() => renderDetailUrl("refund", { shop: SHOP, id: "rf3" })).not.toThrow()
    expect(url).toBe("https://acme-demo.myshopify.com/admin/refunds/rf3")
    // Crucially it never leaves an unsubstituted placeholder behind.
    expect(url).not.toContain("{{")
  })

  it("[§10.9] market panel: Open in Shopify href matches urlTemplate", () => {
    const url = renderDetailUrl("market", { shop: SHOP, id: "m1" })
    expect(url).toBe("https://acme-demo.myshopify.com/admin/settings/markets/m1")
  })

  it("template table is the single source of truth (no entity is missing)", () => {
    const entities = [
      "order",
      "customer",
      "product",
      "draftOrder",
      "return",
      "refund",
      "market",
    ] as const
    for (const e of entities) {
      expect(DETAIL_ENTITY_URL_TEMPLATES[e]).toBeDefined()
    }
  })
})

describe("shopSubdomain (CLUSTER 7.1 — real store domain, not the app name)", () => {
  it("strips the .myshopify.com suffix so the template doesn't double it", () => {
    // The kernel persists the full domain; the template re-adds .myshopify.com.
    expect(shopSubdomain("acme.myshopify.com")).toBe("acme")
    // Rendered through the real order template → the real store, never "shopify".
    const url = renderDetailUrl("order", {
      shop: shopSubdomain("acme.myshopify.com") ?? "",
      id: "9001",
    })
    expect(url).toBe("https://acme.myshopify.com/admin/orders/9001")
    expect(url).not.toContain("shopify.myshopify.com/admin")
  })

  it("tolerates a scheme / trailing path on the stored domain", () => {
    expect(shopSubdomain("https://acme.myshopify.com/admin")).toBe("acme")
  })

  it("passes through a bare subdomain unchanged", () => {
    expect(shopSubdomain("acme")).toBe("acme")
  })

  it("returns null for an empty / missing domain so callers can fall back", () => {
    expect(shopSubdomain(null)).toBeNull()
    expect(shopSubdomain(undefined)).toBeNull()
    expect(shopSubdomain("")).toBeNull()
  })
})

describe("admin order URL (order rows deep-link OUT — no in-app order detail)", () => {
  it("extracts the numeric id from a GID and passes numeric ids through", () => {
    expect(adminResourceId("gid://shopify/Order/12768069779622")).toBe("12768069779622")
    expect(adminResourceId("12768069779622")).toBe("12768069779622")
    expect(adminResourceId("gid://shopify/Product/42")).toBe("42")
  })

  it("builds the admin order URL from the stored full shop domain + GID", () => {
    expect(adminOrderUrl("acme.myshopify.com", "gid://shopify/Order/9001")).toBe(
      "https://acme.myshopify.com/admin/orders/9001",
    )
  })

  it("returns null while the shop domain is unknown", () => {
    expect(adminOrderUrl(null, "gid://shopify/Order/9001")).toBeNull()
    expect(adminOrderUrl("", "gid://shopify/Order/9001")).toBeNull()
  })
})
