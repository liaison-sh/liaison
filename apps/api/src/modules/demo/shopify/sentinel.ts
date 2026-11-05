// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The constants that make the demo Shopify connection inert.
//
// A demo org needs a Shopify CONNECTION row, because `home_load` and every read
// resolve the shop domain off it (`get-client.ts`). It must never carry a real
// credential, so the seeder installs a connection whose "access token" is the
// literal sentinel below and whose shop is a fixed domain the seeder does not
// get to choose. Both halves matter:
//
//   * the token is a constant with no secret in it, so a leak of the demo
//     database leaks nothing,
//   * the domain is FIXED in shipped code, so no caller (a visitor, a routine,
//     a future route that forgets) can point a demo org at a real store.
//
// The provider does not TRUST the token: it answers on the org's demo marker.
// The sentinel is what makes the row honest to an auditor reading the table,
// and what `installDemoShopifyConnection` refuses to deviate from.
import type { ShippedLocale } from "@liaison/shared"
import { serverT } from "~/modules/i18n/server-i18n"

/**
 * The demo store's shop domain. Fixed, and shaped to satisfy the bundled app's
 * `SHOPIFY_DOMAIN_RE` so `getShopifyClient` accepts it. Nothing ever resolves
 * or connects to it: a demo org's `*.myshopify.com` egress is answered by the
 * fixture provider or refused, never put on the wire.
 */
export const DEMO_SHOP_DOMAIN = "resonant-audio-labs-demo.myshopify.com"

/** The store's own name, as `home_load` and the settings panel render it. */
export const DEMO_SHOP_NAME = "Resonant Audio Labs"

/**
 * The stand-in for an offline Admin API token. Not a credential, not derived
 * from one, and recognisably not one to anybody who reads the row.
 */
export const DEMO_SHOPIFY_SENTINEL_TOKEN = "liaison-demo-fixture-not-a-shopify-token"

/** The Shopify Admin API host family. One string compare on the hot path. */
export function isShopifyAdminHost(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(".myshopify.com")
}

/** The message a demo org gets when it asks Shopify for something unmodelled. */
export function demoShopifyUnsupportedMessage(locale: ShippedLocale = "en"): string {
  return serverT(locale, "kernel.demo.shopifyUnsupported")
}

/** The message a demo org gets when it tries to write to the store. */
export function demoShopifyWriteBlockedMessage(locale: ShippedLocale = "en"): string {
  return serverT(locale, "kernel.demo.shopifyWriteBlocked")
}
