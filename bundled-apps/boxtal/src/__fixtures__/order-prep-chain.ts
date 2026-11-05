// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared fixture shape for the plan section 4 e2e chain (orders/paid webhook,
// goods invoice, boxtal prep_list/prep_sync/create_shipment). There is no
// cross-package import precedent between bundled apps (each app's tests only
// exercise its own app; executeTool is always the mock boundary between apps
// in the existing test suites), so this module is duplicated in shape, not
// imported, by bundled-apps/invoicing/src/handlers/shopify-order-paid.test.ts.
// Keep the two hand-in-sync if either shape changes: same order id, customer,
// single physical line item, matching money.

// A NUMERIC Shopify order id, the shape the order-driven worklist scan reads off the order gid
// (gid://shopify/Order/<id>) and stores on prep_meta. A symbolic id would never match a real hit.
export const CHAIN_SHOPIFY_ORDER_ID = "5544332211"
export const CHAIN_PRODUCT_EXTERNAL_ID = "RAL-44"
export const CHAIN_LINE_DESCRIPTION = "Kestrel 6"
export const CHAIN_UNIT_PRICE_MINOR = 69900
export const CHAIN_CURRENCY = "EUR"
export const CHAIN_CUSTOMER_COUNTRY = "FR"

/** The invoice shape prep.ts/prep-e2e.test.ts consumes via invoicing:documents_get /
 *  invoicing:documents_search, mirroring the document onShopifyOrderPaid would issue for the
 *  same order (bundled-apps/invoicing/src/handlers/shopify-order-paid.ts): one goods-scope line,
 *  shopify_order_id carried on the document, counterparty country FR. */
export function chainGoodsInvoiceFixture(documentRef: string) {
  return {
    id: documentRef,
    currency: CHAIN_CURRENCY,
    incoterm: "DAP",
    counterparty_country: CHAIN_CUSTOMER_COUNTRY,
    counterparty_name: "Acme France SAS",
    counterparty_contact_id: "contact-chain-1",
    shopify_order_id: CHAIN_SHOPIFY_ORDER_ID,
    issued_at: "2026-07-01",
    lines: [
      {
        id: `line-${documentRef}`,
        description: CHAIN_LINE_DESCRIPTION,
        quantity: 1,
        unit_price_minor: String(CHAIN_UNIT_PRICE_MINOR),
        hs_code: "9207.90",
        country_of_origin: "FR",
        customs_description: CHAIN_PRODUCT_EXTERNAL_ID,
        product_source: "shopify",
        external_id: CHAIN_PRODUCT_EXTERNAL_ID,
      },
    ],
  }
}

/** The shopify:orders_get response prep_sync fetches to populate prep_meta's order name/tags. */
export function chainShopifyOrderMeta() {
  return { name: "#5001", tags: ["chain-e2e"], createdAt: "2026-07-01T00:00:00Z" }
}
