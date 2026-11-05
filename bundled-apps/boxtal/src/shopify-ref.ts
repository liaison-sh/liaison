// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify reference normalization.
//
// Invoicing persists a Shopify order reference as the BARE NUMERIC id
// ("13018158072139" — see `documents.shopify_order_id` / `external_refs`),
// because that is the shape Shopify's REST webhooks deliver. The Shopify app's
// `orders_get` tool, however, runs a GraphQL `order(id: ID!)` lookup, which
// resolves ONLY the gid form ("gid://shopify/Order/13018158072139"). Handing it
// the numeric id returns no order, so the tool throws NOT_FOUND.
//
// That mismatch is silent and expensive: `resolveFxToDeclared` (shipment.ts)
// swallows the throw and degrades to "no rate available", which blocks every
// customs article on a non-EUR invoice with `fx_unavailable` and parks the row
// in the prep grid as "Customs value needs a manual EUR amount" — even though
// the linked order carries the exact rate we need. Four live US/JP orders sat
// blocked on precisely this (field report 2026-08-03).
//
// prep.ts had already learned this the hard way and normalized inline; keeping
// the knowledge in ONE place means the next caller of `shopify:orders_get`
// cannot rediscover the trap.

/** The gid prefix Shopify's GraphQL `Order` node is addressed by. */
const ORDER_GID_PREFIX = "gid://shopify/Order/"

/**
 * Normalize any stored Shopify order reference into the gid form
 * `shopify:orders_get` resolves. A bare numeric id is wrapped; anything already
 * in gid form (or any other shape we do not recognize) is returned untouched so
 * a future reference style passes through rather than being mangled.
 */
export function toShopifyOrderGid(ref: string): string {
  return /^\d+$/.test(ref) ? `${ORDER_GID_PREFIX}${ref}` : ref
}
