// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify plugin app — handler bundle entrypoint.
//
// Every name referenced in `app.manifest.json` (tools[].handler,
// jobs[].handler, webhooks[].handler, webhooks[].verify, search.handler,
// attention.handler) MUST resolve to a named export of this module. The
// install service rejects the .liaisonapp at registration time otherwise.
//
// Every handler below is a real implementation. There are no NOT_IMPLEMENTED
// stubs: a declared-but-throwing job/tool is worse than an absent one (it can
// be enqueued/invoked and fails at runtime), so any deferred surface is removed
// from BOTH the manifest and this file until it is implemented.
//
// Agent-facing TOOL handlers (not jobs/webhooks/events — see below) are wrapped
// with withShopifyConnectionEnvelope so a missing Shopify connection returns a
// structured `{ error: { code: "shopify_not_connected", message } }` envelope
// instead of a throw the kernel redacts to "Tool execution failed" in
// production. See lib/get-client.ts for the rationale.

import { withShopifyConnectionEnvelope } from "./lib/get-client"
import { webhooksRepairHandler } from "./connection"
import * as homeHandlers from "./handlers/home"
import * as readHandlers from "./reads"
import * as mutationHandlers from "./mutations"
import * as analyticsHandlers from "./analytics"
import * as inventoryValueHandlers from "./inventory-value"
import * as repeatRateHandlers from "./repeat-rate"
import * as abandonedCheckoutsHandlers from "./abandoned-checkouts"

// — home tool (manifest.tools.home_load.handler) — backs the kernel-mounted
//   Shopify Home tab. Returns connection + attention bundle + recent orders.
export const home_load = withShopifyConnectionEnvelope(homeHandlers.home_load)

// — jobs (manifest.jobs[].handler) —
// Phase 16 ships customer backfill only; orders/products backfill are deferred
// to a later phase. They were previously declared as `notImplemented()` stubs
// in both the manifest and here — a declared-but-throwing job is worse than an
// absent one (it can be enqueued and will fail at runtime), so both the
// manifest entries and the stub exports were removed. Re-add them (manifest +
// real handler) when the backfill surface is implemented.
export { backfillCustomersJob } from "./handlers/backfill-customers" // Task B11
export { scopeSeedJob, applySeedSuggestion } from "./handlers/scope-seed" // Task B10
export {
  staff_overrides_upsert,
  staff_overrides_delete,
  staff_overrides_upsert_preflight,
} from "./handlers/staff-overrides" // Task B14
// — settings tools (manifest.tools.{settings_load,connection_disconnect}.handler) — Task B14
//   `settings_load` backs the Settings panel data fetch (read-only, ungated);
//   `connection_disconnect` tears down the Shopify connection (gated admin).
export { settingsLoad, connectionDisconnect } from "./handlers/settings"
export { reconcileCustomersJob } from "./handlers/reconcile-customers" // Task B12
export { scanUnfulfilledOrdersJob } from "./handlers/scan-unfulfilled" // Task B12
export { pruneWebhookDeliveriesJob } from "./handlers/prune-webhook-deliveries" // §3.4 ledger prune
export { probeWebhookUpstreamJob } from "./handlers/probe-webhook-upstream" // webhook silence evidence

// — search (manifest.search.handler) — Task B7
export { searchHandler } from "./search"

// — analytics_query (manifest.tools.analytics_query.handler) — typed aggregate read
export const analytics_query = withShopifyConnectionEnvelope(analyticsHandlers.analytics_query)

// — inventory_value (manifest.tools.inventory_value.handler) — BL-169 #2: total retail
//   value of on-hand stock across the catalog (server-side iteration in one call)
export const inventory_value = withShopifyConnectionEnvelope(inventoryValueHandlers.inventory_value)

// — repeat_rate (manifest.tools.repeat_rate.handler) — BL-169 #1: base-wide repeat-
//   purchase rate (share of customers with >1 order), server-side in one call
export const repeat_rate = withShopifyConnectionEnvelope(repeatRateHandlers.repeat_rate)

// — gated-tool approval summarizers (manifest.tools.<name>.summarizer) — host-side TRUSTED, bundled
//   here so loadTrustedBundleFunction resolves them from the built bundle. See src/summarizers.ts.
export * from "./summarizers"

// — abandoned_checkouts_list (manifest.tools.abandoned_checkouts_list.handler) — BL-169 #3:
//   abandoned customer checkouts for cart recovery (value, customer, line items, recovery URL)
export const abandoned_checkouts_list = withShopifyConnectionEnvelope(
  abandonedCheckoutsHandlers.abandoned_checkouts_list,
)

// — kernel-event subscribers (manifest.events.subscribes) — Task B5
// NOT wrapped: onConnectionEstablished IS the connection-validation step (it
// should hard-fail so the kernel's event-delivery retry/backoff applies), and
// onConnectionDisconnected already catches getShopifyClient itself (best-effort
// cleanup). onBeforeDisconnect is the shop connection's kernel `beforeDisconnect`
// hook (deletes this org's webhook subscriptions while the token still works).
export { onBeforeDisconnect, onConnectionDisconnected, onConnectionEstablished } from "./connection"
// Cross-app subscriber: invoicing's document events relayed as `order:invoice_changed`
// so the Orders list's Invoice column refreshes live (see handlers/invoice-relay.ts).
export { onInvoicingDocumentChanged } from "./handlers/invoice-relay"

// — webhooks_repair (manifest.tools.webhooks_repair.handler) — re-registers the
// declared webhook topics for an already-connected shop (no re-OAuth needed).
export const webhooks_repair = withShopifyConnectionEnvelope(webhooksRepairHandler)

// — read tools (manifest.tools.<name>.handler) — Task B6
// Full read surface: orders, customers, products, markets, variants,
// inventory levels, fulfillments, returns, refunds, discounts, metafields.
export const orders_search = withShopifyConnectionEnvelope(readHandlers.orders_search)
export const orders_get = withShopifyConnectionEnvelope(readHandlers.orders_get)
// orders_invoice_links does NOT call the Shopify client (only the cross-app invoicing lookup), so it
// is NOT wrapped with withShopifyConnectionEnvelope — a missing Shopify connection is irrelevant here,
// and the tool already degrades to `{ links: [] }` best-effort on its own (invoicing not installed,
// cross-app error, thrown rejection).
export const orders_invoice_links = readHandlers.orders_invoice_links
// products_short_codes only reads the kernel's product attributes (no Shopify client call), so it is
// not wrapped either; it degrades to `{ codes: {} }` on its own.
export const products_short_codes = readHandlers.products_short_codes
export const customers_search = withShopifyConnectionEnvelope(readHandlers.customers_search)
export const customers_segment_search = withShopifyConnectionEnvelope(readHandlers.customers_segment_search)
export const customers_get = withShopifyConnectionEnvelope(readHandlers.customers_get)
export const customers_get_by_external_id = withShopifyConnectionEnvelope(readHandlers.customers_get_by_external_id)
export const products_search = withShopifyConnectionEnvelope(readHandlers.products_search)
export const products_get = withShopifyConnectionEnvelope(readHandlers.products_get)
// The sales channels a product is on and the exact channels a publish / unpublish would act on
// (summarizerContext of products_publish and products_unpublish).
export const products_publication_targets = withShopifyConnectionEnvelope(
  mutationHandlers.products_publication_targets,
)
export const markets_list = withShopifyConnectionEnvelope(readHandlers.markets_list)
export const markets_get = withShopifyConnectionEnvelope(readHandlers.markets_get)
export const variants_search = withShopifyConnectionEnvelope(readHandlers.variants_search)
export const variants_get = withShopifyConnectionEnvelope(readHandlers.variants_get)
// Batched variant identity for approval-card hydration (draft_orders_create summarizerContext).
export const variants_brief = withShopifyConnectionEnvelope(readHandlers.variants_brief)
export const variants_market_price = withShopifyConnectionEnvelope(readHandlers.variants_market_price)
export const inventory_levels_list = withShopifyConnectionEnvelope(readHandlers.inventory_levels_list)
export const fulfillments_get = withShopifyConnectionEnvelope(readHandlers.fulfillments_get)
// Partial-fulfillment planning read: per-FO line item ids + remaining quantities.
export const fulfillment_orders_get = withShopifyConnectionEnvelope(readHandlers.fulfillment_orders_get)
export const returns_search = withShopifyConnectionEnvelope(readHandlers.returns_search)
export const refunds_get = withShopifyConnectionEnvelope(readHandlers.refunds_get)
export const discounts_search = withShopifyConnectionEnvelope(readHandlers.discounts_search)
export const metafields_list = withShopifyConnectionEnvelope(readHandlers.metafields_list)
// §3.2 read surface — draft-order list/get + locations list. These handlers
// are declared in app.manifest.json#tools and implemented in reads.ts but
// were never re-exported here, so manifest-handler resolution failed for them.
export const draft_orders_list = withShopifyConnectionEnvelope(readHandlers.draft_orders_list)
export const draft_orders_get = withShopifyConnectionEnvelope(readHandlers.draft_orders_get)
// B2B companies (read_companies): find a company, its locations, contacts with their roles, and catalogs.
export const companies_search = withShopifyConnectionEnvelope(readHandlers.companies_search)
export const companies_get = withShopifyConnectionEnvelope(readHandlers.companies_get)
export const locations_list = withShopifyConnectionEnvelope(readHandlers.locations_list)

// — webhook handlers + verifier (manifest.webhooks.<topic>.{handler,verify}) — Task B9
export {
  shopifyWebhookVerifier,
  ordersCreateHandler,
  ordersUpdatedHandler,
  ordersFulfilledHandler,
  ordersCancelledHandler,
  customersCreateHandler,
  customersUpdateHandler,
  customersDeleteHandler,
  refundsCreateHandler,
  returnsRequestedHandler,
  fulfillmentsCreateHandler,
  inventoryLevelsUpdateHandler,
  productsCreateHandler,
  productsUpdateHandler,
  draftOrdersCreateHandler,
  draftOrdersUpdateHandler,
  draftOrdersDeleteHandler,
  appUninstalledHandler,
} from "./webhooks"

// — mutation tools (manifest.tools.<name>.handler, gated: true) — Task B8
// Gated mutations compose TWO wrappers: withShopifyConnectionEnvelope (structured
// shopify_not_connected error) inside withApprovalProtocol (durable started/succeeded/
// failed_no_effect recording on the post-approval replay, so a validation error or a
// Shopify userErrors rejection cleanly reverts the approval to pending instead of wedging
// it at `approving`). The protocol wrapper is a pass-through outside an approval replay.
const gatedMutation = (
  fn: (params: Record<string, unknown>, ctx: import("@liaison/app-sdk").AppContext) => Promise<unknown>,
) => mutationHandlers.withApprovalProtocol(withShopifyConnectionEnvelope(fn))
export const refunds_create = gatedMutation(mutationHandlers.refunds_create)
export const refunds_create_preflight = withShopifyConnectionEnvelope(mutationHandlers.refunds_create_preflight)
export const draft_orders_create = gatedMutation(mutationHandlers.draft_orders_create)
// — STAGE-TIME preflights (manifest.tools.<name>.preflight) — run BEFORE the approval is created so a
//   gated call is never parked for a human when the data it needs is missing or invalid. Read-only, so
//   they take withShopifyConnectionEnvelope only: withApprovalProtocol would lie on a call that stages
//   nothing. See the preflight block in mutations.ts.
export const draft_orders_create_preflight = withShopifyConnectionEnvelope(
  mutationHandlers.draft_orders_create_preflight,
)
export const draft_orders_update_preflight = withShopifyConnectionEnvelope(
  mutationHandlers.draft_orders_update_preflight,
)
export const products_merge_preflight = withShopifyConnectionEnvelope(mutationHandlers.products_merge_preflight)
export const fulfillments_create_preflight = withShopifyConnectionEnvelope(
  mutationHandlers.fulfillments_create_preflight,
)
export const variants_update_preflight = withShopifyConnectionEnvelope(mutationHandlers.variants_update_preflight)
export const variants_delete_preflight = withShopifyConnectionEnvelope(mutationHandlers.variants_delete_preflight)
export const order_update_preflight = withShopifyConnectionEnvelope(mutationHandlers.order_update_preflight)
export const products_update_preflight = withShopifyConnectionEnvelope(mutationHandlers.products_update_preflight)
export const inventory_adjust_preflight = withShopifyConnectionEnvelope(mutationHandlers.inventory_adjust_preflight)
export const products_unpublish_preflight = withShopifyConnectionEnvelope(
  mutationHandlers.products_unpublish_preflight,
)
// — the destructive/state-machine tools a re-audit found wrongly classified as safe to stage
//   unchecked: a permanent delete, an order cancel, and the return/fulfillment transitions whose
//   refusal used to land in the APPROVER's hands rather than the agent's.
export const products_delete_preflight = withShopifyConnectionEnvelope(mutationHandlers.products_delete_preflight)
export const order_cancel_preflight = withShopifyConnectionEnvelope(mutationHandlers.order_cancel_preflight)
export const draft_orders_complete_preflight = withShopifyConnectionEnvelope(
  mutationHandlers.draft_orders_complete_preflight,
)
export const draft_orders_delete_preflight = withShopifyConnectionEnvelope(
  mutationHandlers.draft_orders_delete_preflight,
)
export const discounts_delete_preflight = withShopifyConnectionEnvelope(mutationHandlers.discounts_delete_preflight)
export const discounts_update_preflight = withShopifyConnectionEnvelope(mutationHandlers.discounts_update_preflight)
export const discounts_create_preflight = withShopifyConnectionEnvelope(mutationHandlers.discounts_create_preflight)
export const discounts_bulk_create_preflight = withShopifyConnectionEnvelope(mutationHandlers.discounts_bulk_create_preflight)
export const returns_approve_preflight = withShopifyConnectionEnvelope(mutationHandlers.returns_approve_preflight)
export const returns_decline_preflight = withShopifyConnectionEnvelope(mutationHandlers.returns_decline_preflight)
export const returns_close_preflight = withShopifyConnectionEnvelope(mutationHandlers.returns_close_preflight)
export const returns_refund_preflight = withShopifyConnectionEnvelope(mutationHandlers.returns_refund_preflight)
export const fulfillments_cancel_preflight = withShopifyConnectionEnvelope(
  mutationHandlers.fulfillments_cancel_preflight,
)
export const inventory_set_on_hand_preflight = withShopifyConnectionEnvelope(
  mutationHandlers.inventory_set_on_hand_preflight,
)
export const customers_update_preflight = withShopifyConnectionEnvelope(mutationHandlers.customers_update_preflight)
export const customers_tag_preflight = withShopifyConnectionEnvelope(mutationHandlers.customers_tag_preflight)
export const products_publish_preflight = withShopifyConnectionEnvelope(mutationHandlers.products_publish_preflight)
export const draft_orders_complete = gatedMutation(mutationHandlers.draft_orders_complete)
export const fulfillments_create = gatedMutation(mutationHandlers.fulfillments_create)
export const fulfillments_cancel = gatedMutation(mutationHandlers.fulfillments_cancel)
export const fulfillments_update_tracking = gatedMutation(mutationHandlers.fulfillments_update_tracking)
export const products_create = gatedMutation(mutationHandlers.products_create)
export const products_update = gatedMutation(mutationHandlers.products_update)
export const products_delete = gatedMutation(mutationHandlers.products_delete)
export const products_merge = gatedMutation(mutationHandlers.products_merge)
export const variants_create = gatedMutation(mutationHandlers.variants_create)
export const variants_update = gatedMutation(mutationHandlers.variants_update)
export const variants_delete = gatedMutation(mutationHandlers.variants_delete)
export const inventory_adjust = gatedMutation(mutationHandlers.inventory_adjust)
export const inventory_set_on_hand = gatedMutation(mutationHandlers.inventory_set_on_hand)
export const discounts_create = gatedMutation(mutationHandlers.discounts_create)
export const discounts_bulk_create = gatedMutation(mutationHandlers.discounts_bulk_create)
export const discounts_update = gatedMutation(mutationHandlers.discounts_update)
export const discounts_delete = gatedMutation(mutationHandlers.discounts_delete)
export const returns_request = gatedMutation(mutationHandlers.returns_request)
export const returns_approve = gatedMutation(mutationHandlers.returns_approve)
export const returns_decline = gatedMutation(mutationHandlers.returns_decline)
export const returns_refund = gatedMutation(mutationHandlers.returns_refund)
export const returns_close = gatedMutation(mutationHandlers.returns_close)
export const customers_update = gatedMutation(mutationHandlers.customers_update)
export const customers_email_marketing_consent_update = gatedMutation(
  mutationHandlers.customers_email_marketing_consent_update,
)
export const customers_sms_marketing_consent_update = gatedMutation(
  mutationHandlers.customers_sms_marketing_consent_update,
)
// C6 additions — spec §3.2 mandated mutations.
export const order_update = gatedMutation(mutationHandlers.order_update)
export const order_cancel = gatedMutation(mutationHandlers.order_cancel)
// UNGATED (Boxtal "To prepare" note sync): trustBoundary "internal" in the manifest is the
// only guard here, NOT gatedMutation -- that composition wraps withApprovalProtocol, whose
// name would lie on a tool that never gates. withShopifyConnectionEnvelope only.
export const order_note_set = withShopifyConnectionEnvelope(mutationHandlers.order_note_set)
export const draft_orders_update = gatedMutation(mutationHandlers.draft_orders_update)
export const draft_orders_delete = gatedMutation(mutationHandlers.draft_orders_delete)
export const draft_orders_send = gatedMutation(mutationHandlers.draft_orders_send)
export const products_publish = gatedMutation(mutationHandlers.products_publish)
export const products_unpublish = gatedMutation(mutationHandlers.products_unpublish)
export const customers_tag = gatedMutation(mutationHandlers.customers_tag)
export const metafields_set = gatedMutation(mutationHandlers.metafields_set)
export const metafields_delete = gatedMutation(mutationHandlers.metafields_delete)
