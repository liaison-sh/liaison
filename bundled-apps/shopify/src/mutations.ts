// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task B8 — Shopify mutation tools (gated by default).
//
// Every mutation handler in this module:
//   1. Resolves the Shopify GraphQL client from `ctx.connections.shop`.
//   2. Calls a single Shopify GraphQL mutation.
//   3. Surfaces `userErrors` as a typed app error (so the kernel runtime
//      can fail the call and present the message in the approval-card
//      result panel).
//   4. Emits a canonical `{ entity, action }` event via the shared
//      `emitEvent` helper with the full Shopify payload — kernel.attention
//      translates these into attention items when subscribers are configured.
//
// Liaison-side scope gating is enforced by the kernel before this code
// runs (a denied caller never reaches the handler). The `gated: true` +
// `trustBoundary: "user"` flags in the manifest route the user-trust call
// through the approval-card flow; agent calls trigger the approval card
// per spec §3.2.
//
// The tools live in ./mutations/, one file per domain (shared protocol, draft-order
// input, refunds, draft orders, fulfillments, products, product merge, variants, inventory,
// discounts, returns, customers, orders, metafields). This index re-exports the public
// surface that handlers.ts wraps and the tests import.

export {
  type PreflightResult,
  withApprovalProtocol,
  resolveMutationInput,
} from "./mutations/shared"
export {
  normalizeEmailInput,
  normalizeDraftOrderInput,
} from "./mutations/draft-order-input"
export {
  refunds_create,
  refunds_create_preflight,
} from "./mutations/refunds"
export {
  draft_orders_create_preflight,
  draft_orders_create,
  draft_orders_complete_preflight,
  draft_orders_complete,
  draft_orders_update,
  draft_orders_delete_preflight,
  draft_orders_delete,
  draft_orders_send,
} from "./mutations/draft-orders"
export {
  normalizeTrackingInfo,
  fulfillments_create_preflight,
  fulfillments_create,
  fulfillments_update_tracking,
  fulfillments_cancel_preflight,
  fulfillments_cancel,
} from "./mutations/fulfillments"
export {
  canonicalizeProductInput,
  products_create,
  products_update_preflight,
  products_update,
  products_delete_preflight,
  products_delete,
  products_publish_preflight,
  products_publish,
  products_unpublish_preflight,
  products_unpublish,
  products_publication_targets,
} from "./mutations/products"
export {
  products_merge_preflight,
  products_merge,
} from "./mutations/product-merge"
export {
  variants_create,
  variants_update_preflight,
  variants_update,
  variants_delete_preflight,
  variants_delete,
} from "./mutations/variants"
export {
  normalizeInventorySetOnHandInput,
  normalizeInventoryAdjustInput,
  inventory_adjust_preflight,
  inventory_adjust,
  inventory_set_on_hand_preflight,
  inventory_set_on_hand,
} from "./mutations/inventory"
export {
  canonicaliseBasicCodeDiscount,
  discounts_create,
  canonicaliseBasicCodeDiscountPartial,
  discounts_update_preflight,
  discounts_create_preflight,
  discounts_bulk_create_preflight,
  discounts_update,
  discounts_delete_preflight,
  discounts_delete,
  discounts_bulk_create,
} from "./mutations/discounts"
export {
  returns_request,
  returns_approve_preflight,
  returns_approve,
  returns_decline_preflight,
  returns_decline,
  returns_refund_preflight,
  returns_refund,
  returns_close_preflight,
  returns_close,
} from "./mutations/returns"
export {
  customers_update_preflight,
  customers_update,
  customers_email_marketing_consent_update,
  customers_sms_marketing_consent_update,
  customers_tag_preflight,
  customers_tag,
} from "./mutations/customers"
export {
  order_update_preflight,
  order_update,
  type OrderNoteSetOk,
  type OrderNoteSetConflict,
  order_note_set,
  order_cancel_preflight,
  order_cancel,
} from "./mutations/orders"
export {
  metafields_set,
  metafields_delete,
} from "./mutations/metafields"
