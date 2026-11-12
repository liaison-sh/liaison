// SPDX-License-Identifier: FSL-1.1-ALv2
//
// mutations.ts is an index over ./mutations/ (one file per domain). handlers.ts wraps these
// exports by name and the manifest resolves tool, preflight and helper names through it, so the
// runtime export set is pinned: a tool dropped or renamed while moving code between the domain
// files shows up here. The list was taken from the single-file module before the split.
//
// Adding or removing a mutation export means editing this list on purpose.
import { describe, expect, it } from "bun:test"
import * as mutations from "./mutations"

const EXPECTED_EXPORTS: ReadonlyArray<string> = [
  "canonicaliseBasicCodeDiscount",
  "canonicaliseBasicCodeDiscountPartial",
  "canonicalizeProductInput",
  "customers_email_marketing_consent_update",
  "customers_sms_marketing_consent_update",
  "customers_tag",
  "customers_tag_preflight",
  "customers_update",
  "customers_update_preflight",
  "discounts_bulk_create",
  "discounts_bulk_create_poll",
  "discounts_bulk_create_preflight",
  "discounts_create",
  "discounts_create_preflight",
  "discounts_delete",
  "discounts_delete_preflight",
  "discounts_update",
  "discounts_update_preflight",
  "draft_orders_complete",
  "draft_orders_complete_preflight",
  "draft_orders_create",
  "draft_orders_create_preflight",
  "draft_orders_delete",
  "draft_orders_delete_preflight",
  "draft_orders_send",
  "draft_orders_update",
  "draft_orders_update_preflight",
  "fulfillments_cancel",
  "fulfillments_cancel_preflight",
  "fulfillments_create",
  "fulfillments_create_preflight",
  "fulfillments_update_tracking",
  "inventory_adjust",
  "inventory_adjust_preflight",
  "inventory_set_on_hand",
  "inventory_set_on_hand_preflight",
  "metafields_delete",
  "metafields_set",
  "normalizeDraftOrderInput",
  "normalizeEmailInput",
  "normalizeInventoryAdjustInput",
  "normalizeInventorySetOnHandInput",
  "normalizeTrackingInfo",
  "order_cancel",
  "order_cancel_preflight",
  "order_note_set",
  "order_update",
  "order_update_preflight",
  "products_create",
  "products_delete",
  "products_delete_preflight",
  "products_merge",
  "products_merge_preflight",
  "products_publication_targets",
  "products_publish",
  "products_publish_preflight",
  "products_unpublish",
  "products_unpublish_preflight",
  "products_update",
  "products_update_preflight",
  "refunds_create",
  "refunds_create_preflight",
  "resolveMutationInput",
  "returns_approve",
  "returns_approve_preflight",
  "returns_close",
  "returns_close_preflight",
  "returns_decline",
  "returns_decline_preflight",
  "returns_refund",
  "returns_refund_preflight",
  "returns_request",
  "variants_create",
  "variants_delete",
  "variants_delete_preflight",
  "variants_update",
  "variants_update_preflight",
  "withApprovalProtocol",
]

describe("shopify mutations export set", () => {
  it("exports exactly the pinned names", () => {
    expect(Object.keys(mutations).sort()).toEqual([...EXPECTED_EXPORTS].sort())
  })

  it("every pinned export is a function", () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(typeof (mutations as Record<string, unknown>)[name], name).toBe("function")
    }
  })
})
