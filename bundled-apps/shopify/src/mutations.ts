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
  customers_email_marketing_consent_update,
  customers_sms_marketing_consent_update,
  customers_tag,
  customers_tag_preflight,
  customers_update,
  customers_update_preflight,
} from "./mutations/customers"
export {
  canonicaliseBasicCodeDiscount,
  canonicaliseBasicCodeDiscountPartial,
  discounts_bulk_create,
  discounts_bulk_create_poll,
  discounts_bulk_create_preflight,
  discounts_create,
  discounts_create_preflight,
  discounts_delete,
  discounts_delete_preflight,
  discounts_update,
  discounts_update_preflight,
} from "./mutations/discounts"
export {
  normalizeDraftOrderInput,
  normalizeEmailInput,
} from "./mutations/draft-order-input"
export {
  draft_orders_complete,
  draft_orders_complete_preflight,
  draft_orders_create,
  draft_orders_create_preflight,
  draft_orders_delete,
  draft_orders_delete_preflight,
  draft_orders_send,
  draft_orders_update,
  draft_orders_update_preflight,
} from "./mutations/draft-orders"
export {
  fulfillments_cancel,
  fulfillments_cancel_preflight,
  fulfillments_create,
  fulfillments_create_preflight,
  fulfillments_update_tracking,
  normalizeTrackingInfo,
} from "./mutations/fulfillments"
export {
  inventory_adjust,
  inventory_adjust_preflight,
  inventory_set_on_hand,
  inventory_set_on_hand_preflight,
  normalizeInventoryAdjustInput,
  normalizeInventorySetOnHandInput,
} from "./mutations/inventory"
export {
  metafields_delete,
  metafields_set,
} from "./mutations/metafields"
export {
  type OrderNoteSetConflict,
  type OrderNoteSetOk,
  order_cancel,
  order_cancel_preflight,
  order_note_set,
  order_update,
  order_update_preflight,
} from "./mutations/orders"
export {
  products_merge,
  products_merge_preflight,
} from "./mutations/product-merge"
export {
  canonicalizeProductInput,
  products_create,
  products_delete,
  products_delete_preflight,
  products_publication_targets,
  products_publish,
  products_publish_preflight,
  products_unpublish,
  products_unpublish_preflight,
  products_update,
  products_update_preflight,
} from "./mutations/products"
export {
  refunds_create,
  refunds_create_preflight,
} from "./mutations/refunds"
export {
  returns_approve,
  returns_approve_preflight,
  returns_close,
  returns_close_preflight,
  returns_decline,
  returns_decline_preflight,
  returns_refund,
  returns_refund_preflight,
  returns_request,
} from "./mutations/returns"
export {
  type PreflightResult,
  resolveMutationInput,
  withApprovalProtocol,
} from "./mutations/shared"
export {
  variants_create,
  variants_delete,
  variants_delete_preflight,
  variants_update,
  variants_update_preflight,
} from "./mutations/variants"
