// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The demo org's Boxtal catalog, as data: one shipping profile per product the
 * demo store sells, and the ship-from address. Pure, so a test can hold it to
 * the store itself.
 *
 * A profile is keyed by the store's own variant id (`demoShopifyVariantGid`),
 * which is what an order line, the invoice its order event issues and a
 * shipment draft all carry. Keyed by the catalog's placeholder ids instead,
 * the live order of the commerce scenario matched no profile: its draft had no
 * parcel and its customs line no weight.
 */
import { DEMO_COMPANY, type DemoSku, demoShopifyVariantGid } from "~/seed/world/fiction"

export interface DemoShippingProfile {
  sku: string
  product_source: string
  product_id: string
  unit_weight: number
  solo_length: number | null
  solo_width: number | null
  solo_height: number | null
  content_category: string
  accessory: boolean
}

/**
 * The content category every seeded profile and pack carries, in the form the
 * Boxtal app accepts and Boxtal's API answers to (`content:v1:<numeric code>`,
 * as `list_content_categories` returns). A free-text label is refused by a
 * cotation with a 400.
 */
export const DEMO_CONTENT_CATEGORY = "content:v1:10120"

/** The shipping profile of each catalog entry, keyed as the store's orders name it. */
export function demoShippingProfiles(catalog: readonly DemoSku[]): DemoShippingProfile[] {
  return catalog.map((s) => ({
    sku: s.sku,
    product_source: s.productSource,
    product_id: demoShopifyVariantGid(s.sku) ?? s.variantId,
    unit_weight: s.weightKg,
    solo_length: s.dimsCm?.length ?? null,
    solo_width: s.dimsCm?.width ?? null,
    solo_height: s.dimsCm?.height ?? null,
    content_category: DEMO_CONTENT_CATEGORY,
    accessory: s.tier === "accessory",
  }))
}

/** The id a seeded document line or pack names a catalog entry by: the store's own. */
export function demoProductId(s: DemoSku): string {
  return demoShopifyVariantGid(s.sku) ?? s.variantId
}

/**
 * Where the demo company ships from (Boxtal's `sender_address`): complete, so
 * a quote and a label need nothing more. The phone is all zeros, never a real
 * line.
 */
export function demoBoxtalSender(): {
  name: string
  company: string
  email: string
  phone: string
  street: string
  city: string
  postalCode: string
  countryIsoCode: string
  type: "BUSINESS"
} {
  return {
    name: "Shipping desk",
    company: DEMO_COMPANY.legalName,
    email: DEMO_COMPANY.supportEmail,
    phone: "+33 1 00 00 00 00",
    street: DEMO_COMPANY.addressLine1,
    city: DEMO_COMPANY.city,
    postalCode: DEMO_COMPANY.postalCode,
    countryIsoCode: DEMO_COMPANY.country,
    type: "BUSINESS",
  }
}
