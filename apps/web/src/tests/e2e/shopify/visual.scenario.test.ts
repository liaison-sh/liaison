// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 e2e — VISUAL baselines for the Shopify plugin's UI surfaces.
//
// Covers the surfaces a human admin / agent actually look at:
//   - ShopifySettings (connection card, diagnostics, mappings table,
//     inventory allowlist)
//   - CustomerPanel, ProductPanel, DraftOrderPanel, ReturnPanel,
//     RefundPanel, MarketPanel (orders have no in-app panel — order rows
//     deep-link out to the Shopify admin, asserted functionally below)
//
// **Data strategy.** The bundle's tool handlers depend on a long chain
// (install_metadata RLS → connected_accounts → live Shopify) that has
// latent gaps (see `_test/shopify-install-routes.ts` fallback insert; the
// `onConnectionEstablished` subscriber currently doesn't write
// install_metadata in real-mode tests). For visual baselines we want
// controlled, populated UIs, not flaky live data.
//
// So this scenario installs the bundle (proves the manifest + ui.js are
// wired) then intercepts `window.__liaisonHost.invokeTool` per-test with
// canned per-tool responses, so every panel renders with fixed,
// representative data. The setter-proxy is installed via
// `page.addInitScript` so it traps the kernel's assignment at boot time.
//
// Re-bake baselines with `--update-snapshots=all` after an intentional
// UI change.
import { resolve } from "node:path"
import { forceDarkMode } from "../agent-bootstrap"
import { bundledAppTarball } from "../bundled-app-tarball"
import { loginAs } from "../fixtures/test"
import { volatileShellMasks } from "../helpers/visual-masks"
import { expect, test } from "./_shopify-fixtures"
import { installShopifyApp } from "./helpers/install-shopify-app"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

const SHOT = { maxDiffPixelRatio: 0.02 } as const

// Pixel baselines are captured on darwin (`*-darwin.png`). Cross-platform
// pixel diffs (CI runs ubuntu/linux) are unreliable — font hinting + subpixel
// rendering differ — so the `toHaveScreenshot` calls only run on darwin. The
// FUNCTIONAL assertions (panel mounts, content testids visible, settings
// affordances) run on every platform, so the C5 panel-content rendering — the
// thing deep-review flagged as having zero CI coverage — is now exercised in
// credential-less CI; the pixel goldens stay a local/darwin concern.
const PIXEL_BASELINES = process.platform === "darwin"

// Mock responses keyed by `<appName>:<toolName>`. Returns are the
// drizzle-shape unknown objects the panel code reads (camelCase).
const MOCKS: Record<string, unknown> = {
  "shopify:home_load": {
    connection: {
      shopDomain: "example-store.myshopify.com",
    },
    attention: {
      lowInventory: [
        {
          variantId: "v3",
          productId: "gid://shopify/Product/15332593074342",
          productTitle: "Kestrel 2",
          variantTitle: "Studio Bundle",
          sku: "PUSH-V2-STBNDL",
          inventoryQuantity: 2,
          threshold: 10,
          location: "Paris warehouse",
        },
        {
          variantId: "v9",
          productId: "gid://shopify/Product/15332593074390",
          productTitle: "Tessera Hat",
          variantTitle: "Cream",
          sku: "HAT-CRM-OS",
          inventoryQuantity: 0,
          threshold: 20,
          location: "Berlin warehouse",
        },
      ],
      unfulfilledOrders: [
        {
          orderId: "gid://shopify/Order/12768069779700",
          name: "#0998",
          customer: { displayName: "Tomás García", email: "tomas@example.com" },
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 52).toISOString(),
          hoursSincePlaced: 52,
          totalPrice: { amount: "418.00", currencyCode: "EUR" },
        },
        {
          orderId: "gid://shopify/Order/12768069779701",
          name: "#0996",
          customer: { displayName: "Aki Tanaka", email: "aki@example.com" },
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 71).toISOString(),
          hoursSincePlaced: 71,
          totalPrice: { amount: "21800", currencyCode: "JPY" },
        },
      ],
      pendingReturns: [
        {
          returnId: "gid://shopify/Return/9001",
          orderName: "#1001",
          reason: "wrong_color",
          requestedAt: new Date(Date.now() - 1000 * 60 * 60 * 18).toISOString(),
        },
      ],
    },
    recentOrders: {
      orders: [
        {
          id: "gid://shopify/Order/12768069779622",
          name: "#1001",
          customer: { displayName: "Marie Dupont", email: "marie@example.com" },
          market: "France",
          totalPrice: { amount: "189.50", currencyCode: "EUR" },
          fulfillmentStatus: "fulfilled",
          placedAt: new Date(Date.now() - 1000 * 60 * 40).toISOString(),
        },
        {
          id: "gid://shopify/Order/12768069779623",
          name: "#1000",
          customer: { displayName: "Adrián López", email: "adrian@example.com" },
          market: "Spain",
          totalPrice: { amount: "139.00", currencyCode: "EUR" },
          fulfillmentStatus: "fulfilled",
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
        },
        {
          id: "gid://shopify/Order/12768069779624",
          name: "#0999",
          customer: { displayName: "Sophie Laurent", email: "sophie@example.com" },
          market: "France",
          totalPrice: { amount: "59.00", currencyCode: "EUR" },
          fulfillmentStatus: "fulfilled",
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
        },
        {
          id: "gid://shopify/Order/12768069779700",
          name: "#0998",
          customer: { displayName: "Tomás García", email: "tomas@example.com" },
          market: "Spain",
          totalPrice: { amount: "418.00", currencyCode: "EUR" },
          fulfillmentStatus: "pending",
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 52).toISOString(),
        },
        {
          id: "gid://shopify/Order/12768069779625",
          name: "#0997",
          customer: { displayName: "Lina Schäfer", email: "lina@example.com" },
          market: "Germany",
          totalPrice: { amount: "278.00", currencyCode: "EUR" },
          fulfillmentStatus: "fulfilled",
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 19).toISOString(),
        },
        {
          id: "gid://shopify/Order/12768069779701",
          name: "#0996",
          customer: { displayName: "Aki Tanaka", email: "aki@example.com" },
          market: "Japan",
          totalPrice: { amount: "21800", currencyCode: "JPY" },
          fulfillmentStatus: "pending",
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 71).toISOString(),
        },
        {
          id: "gid://shopify/Order/12768069779626",
          name: "#0995",
          customer: { displayName: "Marie Dupont", email: "marie@example.com" },
          market: "France",
          totalPrice: { amount: "32.00", currencyCode: "EUR" },
          fulfillmentStatus: "fulfilled",
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
        },
        {
          id: "gid://shopify/Order/12768069779627",
          name: "#0994",
          customer: null,
          market: "United States",
          totalPrice: { amount: "149.00", currencyCode: "USD" },
          fulfillmentStatus: "fulfilled",
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 4).toISOString(),
        },
        {
          id: "gid://shopify/Order/12768069779628",
          name: "#0993",
          customer: { displayName: "Lucas Pereira", email: "lucas@example.com" },
          market: "United States",
          totalPrice: { amount: "189.00", currencyCode: "USD" },
          fulfillmentStatus: "fulfilled",
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 6).toISOString(),
        },
        {
          id: "gid://shopify/Order/12768069779629",
          name: "#0992",
          customer: { displayName: "Margot Dufour", email: "margot@example.com" },
          market: "United States",
          totalPrice: { amount: "59.00", currencyCode: "USD" },
          fulfillmentStatus: "fulfilled",
          placedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 8).toISOString(),
        },
      ],
    },
  },
  "shopify:orders_search": {
    results: [
      {
        id: "gid://shopify/Order/12768069779622",
        entity: "order",
        title: "#1001",
        market: "France",
        currency: "EUR",
        attributes: {
          customer: { displayName: "Marie Dupont", email: "marie@example.com" },
          fulfillmentStatus: "fulfilled",
          financialStatus: "paid",
          totalAmount: "189.50",
          shopCurrency: "EUR",
          processedAt: new Date(Date.now() - 1000 * 60 * 40).toISOString(),
          createdAt: new Date(Date.now() - 1000 * 60 * 40).toISOString(),
          cancelledAt: null,
          cancelReason: null,
        },
      },
      {
        id: "gid://shopify/Order/12768069779623",
        entity: "order",
        title: "#1000",
        market: "Spain",
        currency: "EUR",
        attributes: {
          customer: { displayName: "Adrián López", email: "adrian@example.com" },
          fulfillmentStatus: "fulfilled",
          financialStatus: "paid",
          totalAmount: "139.00",
          shopCurrency: "EUR",
          processedAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 2).toISOString(),
          cancelledAt: null,
          cancelReason: null,
        },
      },
      {
        id: "gid://shopify/Order/12768069779624",
        entity: "order",
        title: "#0999",
        market: "France",
        currency: "EUR",
        attributes: {
          customer: { displayName: "Sophie Laurent", email: "sophie@example.com" },
          fulfillmentStatus: "fulfilled",
          financialStatus: "refunded",
          totalAmount: "59.00",
          shopCurrency: "EUR",
          processedAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
          cancelledAt: null,
          cancelReason: null,
        },
      },
      {
        id: "gid://shopify/Order/12768069779700",
        entity: "order",
        title: "#0998",
        market: "Spain",
        currency: "EUR",
        attributes: {
          customer: { displayName: "Tomás García", email: "tomas@example.com" },
          fulfillmentStatus: "pending",
          financialStatus: "partially_refunded",
          totalAmount: "418.00",
          shopCurrency: "EUR",
          processedAt: new Date(Date.now() - 1000 * 60 * 60 * 52).toISOString(),
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 52).toISOString(),
          cancelledAt: null,
          cancelReason: null,
        },
      },
      {
        id: "gid://shopify/Order/12768069779625",
        entity: "order",
        title: "#0997",
        market: "Germany",
        currency: "EUR",
        attributes: {
          customer: { displayName: "Lina Schäfer", email: "lina@example.com" },
          fulfillmentStatus: "fulfilled",
          financialStatus: "paid",
          totalAmount: "278.00",
          shopCurrency: "EUR",
          processedAt: new Date(Date.now() - 1000 * 60 * 60 * 19).toISOString(),
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 19).toISOString(),
          cancelledAt: null,
          cancelReason: null,
        },
      },
      {
        id: "gid://shopify/Order/12768069779701",
        entity: "order",
        title: "#0996",
        market: "Japan",
        currency: "JPY",
        attributes: {
          customer: { displayName: "Aki Tanaka", email: "aki@example.com" },
          fulfillmentStatus: "unfulfilled",
          financialStatus: "voided",
          totalAmount: "21800",
          shopCurrency: "JPY",
          processedAt: new Date(Date.now() - 1000 * 60 * 60 * 71).toISOString(),
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 71).toISOString(),
          cancelledAt: new Date(Date.now() - 1000 * 60 * 60 * 70).toISOString(),
          cancelReason: "customer",
        },
      },
    ],
    nextCursor: null,
  },
  "shopify:draft_orders_list": {
    results: [
      {
        id: "gid://shopify/DraftOrder/1637830820006",
        entity: "draft_order",
        title: "#D14",
        market: "United States",
        currency: "USD",
        attributes: {
          status: "open",
          totalAmount: "316.00",
          customer: { displayName: "Lucas Pereira", email: "lucas@example.com" },
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString(),
        },
      },
      {
        id: "gid://shopify/DraftOrder/1637830820007",
        entity: "draft_order",
        title: "#D13",
        market: "France",
        currency: "EUR",
        attributes: {
          status: "open",
          totalAmount: "88.00",
          customer: null,
          createdAt: new Date(Date.now() - 1000 * 60 * 60 * 30).toISOString(),
        },
      },
    ],
    nextCursor: null,
  },
  "shopify:orders_invoice_links": {
    links: [
      {
        order_id: "gid://shopify/Order/12768069779622",
        invoice_id: "inv-1001",
        number: "INV-2026-0142",
        type: "invoice",
        scope: null,
        status: "issued",
        payment_status: "paid",
      },
      {
        order_id: "gid://shopify/Order/12768069779623",
        invoice_id: "inv-1000",
        number: "INV-2026-0141",
        type: "invoice",
        scope: null,
        status: "issued",
        payment_status: "paid",
      },
    ],
  },
  "shopify:customers_search": {
    results: [
      {
        id: "gid://shopify/Customer/24929631043750",
        entity: "customer",
        title: "Marie Dupont",
        market: "France",
        currency: "EUR",
        attributes: {
          email: "marie@example.com",
          numberOfOrders: "12",
          amountSpent: { amount: "2148.50", currencyCode: "EUR" },
        },
      },
      {
        id: "gid://shopify/Customer/24929631043751",
        entity: "customer",
        title: "Adrián López",
        market: "Spain",
        currency: "EUR",
        attributes: {
          email: "adrian@example.com",
          numberOfOrders: "4",
          amountSpent: { amount: "612.00", currencyCode: "EUR" },
        },
      },
      {
        id: "gid://shopify/Customer/24929631043752",
        entity: "customer",
        title: "Aki Tanaka",
        market: "Japan",
        currency: "JPY",
        attributes: {
          email: "aki@example.com",
          numberOfOrders: "2",
          amountSpent: { amount: "43600", currencyCode: "JPY" },
        },
      },
      {
        id: "gid://shopify/Customer/24929631043753",
        entity: "customer",
        title: "Lina Schäfer",
        market: "Germany",
        currency: "EUR",
        attributes: {
          email: "lina@example.com",
          numberOfOrders: "7",
          amountSpent: { amount: "1894.00", currencyCode: "EUR" },
        },
      },
      {
        id: "gid://shopify/Customer/24929631043754",
        entity: "customer",
        title: "Sophie Laurent",
        market: "France",
        currency: "EUR",
        attributes: {
          email: "sophie@example.com",
          numberOfOrders: "1",
          amountSpent: { amount: "59.00", currencyCode: "EUR" },
        },
      },
    ],
    nextCursor: null,
  },
  "shopify:products_search": {
    results: [
      {
        id: "gid://shopify/Product/15332593074342",
        entity: "product",
        title: "Kestrel 2 — Expressive Pad Controller",
        market: null,
        currency: "EUR",
        attributes: {
          status: "active",
          variantCount: 3,
          totalInventory: 67,
        },
      },
      {
        id: "gid://shopify/Product/15332593074390",
        entity: "product",
        title: "Tessera Hat",
        market: null,
        currency: "EUR",
        attributes: {
          status: "active",
          variantCount: 2,
          totalInventory: 0,
        },
      },
      {
        id: "gid://shopify/Product/15332593074391",
        entity: "product",
        title: "Tessera T-Shirt",
        market: null,
        currency: "EUR",
        attributes: {
          status: "active",
          variantCount: 4,
          totalInventory: 142,
        },
      },
      {
        id: "gid://shopify/Product/15332593074392",
        entity: "product",
        title: "Tessera Sticker pack",
        market: null,
        currency: "EUR",
        attributes: {
          status: "draft",
          variantCount: 1,
          totalInventory: 540,
        },
      },
    ],
    nextCursor: null,
  },
  // The uniform { results } envelope every list read returns: a market's
  // enabled flag and regions live under `attributes`.
  "shopify:markets_list": {
    results: [
      {
        id: "gid://shopify/Market/57061441702",
        entity: "market",
        title: "European Union",
        market: null,
        currency: "EUR",
        attributes: {
          enabled: true,
          regions: [
            { id: "gid://shopify/MarketRegionCountry/FR", name: "FR", code: "FR" },
            { id: "gid://shopify/MarketRegionCountry/DE", name: "DE", code: "DE" },
            { id: "gid://shopify/MarketRegionCountry/IT", name: "IT", code: "IT" },
            { id: "gid://shopify/MarketRegionCountry/ES", name: "ES", code: "ES" },
            { id: "gid://shopify/MarketRegionCountry/NL", name: "NL", code: "NL" },
            { id: "gid://shopify/MarketRegionCountry/BE", name: "BE", code: "BE" },
            { id: "gid://shopify/MarketRegionCountry/IE", name: "IE", code: "IE" },
            { id: "gid://shopify/MarketRegionCountry/AT", name: "AT", code: "AT" },
            { id: "gid://shopify/MarketRegionCountry/PT", name: "PT", code: "PT" },
          ],
        },
      },
      {
        id: "gid://shopify/Market/57061441703",
        entity: "market",
        title: "United Kingdom",
        market: null,
        currency: "GBP",
        attributes: {
          enabled: true,
          regions: [{ id: "gid://shopify/MarketRegionCountry/GB", name: "GB", code: "GB" }],
        },
      },
      {
        id: "gid://shopify/Market/57061441704",
        entity: "market",
        title: "United States",
        market: null,
        currency: "USD",
        attributes: {
          enabled: true,
          regions: [{ id: "gid://shopify/MarketRegionCountry/US", name: "US", code: "US" }],
        },
      },
      {
        id: "gid://shopify/Market/57061441705",
        entity: "market",
        title: "Japan",
        market: null,
        currency: "JPY",
        attributes: {
          enabled: true,
          regions: [{ id: "gid://shopify/MarketRegionCountry/JP", name: "JP", code: "JP" }],
        },
      },
      {
        id: "gid://shopify/Market/57061441706",
        entity: "market",
        title: "Australia (paused)",
        market: null,
        currency: "AUD",
        attributes: {
          enabled: false,
          regions: [{ id: "gid://shopify/MarketRegionCountry/AU", name: "AU", code: "AU" }],
        },
      },
    ],
    nextCursor: null,
  },
  "shopify:settings_load": {
    connection: {
      status: "connected",
      shopDomain: "example-store.myshopify.com",
      connectedAt: "2026-05-26 14:32 UTC",
      scopesKnown: true,
      missingScopes: [],
    },
    mappings: [
      {
        liaisonUserId: "u1",
        liaisonEmail: "admin@fabrikam.example",
        shopifyStaffId: "gid://shopify/StaffMember/12345",
        source: "auto",
      },
      {
        liaisonUserId: "u2",
        liaisonEmail: "amina@resonantaudiolabs.example",
        shopifyStaffId: "gid://shopify/StaffMember/67890",
        source: "override",
      },
      {
        liaisonUserId: "u3",
        liaisonEmail: "lucas@resonantaudiolabs.example",
        shopifyStaffId: null,
        source: "unmapped",
      },
    ],
    diagnostics: {
      staffMirrorLastSyncedAt: "2026-05-28 11:14 UTC",
      backfillStatus: "completed",
      backfillCursor: null,
      webhookDeliveriesProcessed24h: 142,
      webhookDeliveriesFailed24h: 0,
    },
    inventoryAllowlist: ["paris-warehouse", "berlin-warehouse", "lyon-pop-up"],
    seedAvailable: true,
    seedSuggestions: [
      {
        liaisonUserId: "u4",
        shopifyStaffEmail: "margot@example.com",
        scopes: ["shopify:orders:read", "shopify:customers:read"],
      },
    ],
  },
  "shopify:orders_get": {
    id: "gid://shopify/Order/12768069779622",
    name: "#1001",
    market: "France",
    currency: "EUR",
    fulfillmentStatus: "fulfilled",
    customer: { first_name: "Marie", last_name: "Dupont", email: "marie@example.com" },
    totalPrice: { amount: "189.50", currencyCode: "EUR" },
    lineItems: [
      {
        id: "li1",
        title: "Kestrel 2",
        quantity: 1,
        variant: { sku: "PUSH-V2-FR" },
        priceSet: { amount: "139.00", currencyCode: "EUR" },
      },
      {
        id: "li2",
        title: "Tessera T-Shirt — Noir",
        quantity: 2,
        variant: { sku: "TEE-BLK-M" },
        priceSet: { amount: "25.00", currencyCode: "EUR" },
      },
    ],
    fulfillments: [
      {
        id: "f1",
        status: "fulfilled",
        trackingInfo: [
          {
            company: "Colissimo",
            number: "8L00112233",
            url: "https://laposte.fr/track/8L00112233",
          },
        ],
      },
    ],
    refunds: [],
    returns: [],
  },
  "shopify:customers_get": {
    id: "gid://shopify/Customer/24929631043750",
    displayName: "Marie Dupont",
    email: "marie@example.com",
    market: "France",
    currency: "EUR",
    tags: "vip, newsletter, music-producer",
    note: "Bought Kestrel 2 at NAMM 2026 — interested in future hardware drops.",
    orders: [
      {
        id: "o1",
        name: "#1001",
        totalPrice: { amount: "189.50", currencyCode: "EUR" },
        market: "France",
      },
      {
        id: "o2",
        name: "#0892",
        totalPrice: { amount: "59.00", currencyCode: "EUR" },
        market: "France",
      },
      {
        id: "o3",
        name: "#0712",
        totalPrice: { amount: "1490.00", currencyCode: "EUR" },
        market: "France",
      },
    ],
  },
  "shopify:products_get": {
    id: "gid://shopify/Product/15332593074342",
    title: "Kestrel 2 — Expressive Pad Controller",
    market: null,
    currency: "EUR",
    status: "active",
    media: [],
    marketPrices: [
      { market: "France", amount: "139.00", currencyCode: "EUR" },
      { market: "Germany", amount: "139.00", currencyCode: "EUR" },
      { market: "United States", amount: "149.00", currencyCode: "USD" },
      { market: "Japan", amount: "21800", currencyCode: "JPY" },
    ],
    variants: [
      { id: "v1", title: "Black", sku: "PUSH-V2-BLK", price: "139.00 EUR", inventoryQuantity: 42 },
      { id: "v2", title: "White", sku: "PUSH-V2-WHT", price: "139.00 EUR", inventoryQuantity: 18 },
      {
        id: "v3",
        title: "Studio Bundle",
        sku: "PUSH-V2-STBNDL",
        price: "189.00 EUR",
        inventoryQuantity: 7,
      },
    ],
  },
  "shopify:draft_orders_get": {
    id: "gid://shopify/DraftOrder/1637830820006",
    name: "#D14",
    market: "United States",
    status: "open",
    totalPrice: { amount: "316.00", currencyCode: "USD" },
    lineItems: [
      {
        id: "dl1",
        title: "Kestrel 2 — Black",
        quantity: 1,
        priceSet: { amount: "149.00", currencyCode: "USD" },
      },
      {
        id: "dl2",
        title: "Tessera Hat — Cream",
        quantity: 1,
        priceSet: { amount: "32.00", currencyCode: "USD" },
      },
      {
        id: "dl3",
        title: "Tessera Sticker pack",
        quantity: 5,
        priceSet: { amount: "27.00", currencyCode: "USD" },
      },
    ],
  },
  "shopify:returns_get": {
    id: "gid://shopify/Return/9001",
    name: "#R-014",
    orderName: "#1001",
    market: "France",
    status: "open",
    returnLineItems: [
      { id: "rl1", quantity: 1, title: "Kestrel 2 — Black", reason: "wrong_color" },
      { id: "rl2", quantity: 1, title: "Tessera T-Shirt — Noir (M)", reason: "size_too_small" },
    ],
  },
  "shopify:refunds_get": {
    id: "gid://shopify/Refund/3001",
    market: "France",
    note: "Customer reported broken pad sensitivity — full refund issued, return waived.",
    totalPrice: { amount: "139.00", currencyCode: "EUR" },
    transactions: [{ kind: "refund", amount: "139.00", currency: "EUR" }],
    refundLineItems: [{ id: "rfl1", quantity: 1, title: "Kestrel 2 — Black", restocked: false }],
  },
  "shopify:markets_get": {
    id: "gid://shopify/Market/57061441702",
    name: "European Union",
    currency: "EUR",
    enabled: true,
    regions: [
      { code: "FR", name: "France" },
      { code: "DE", name: "Germany" },
      { code: "ES", name: "Spain" },
      { code: "IT", name: "Italy" },
      { code: "NL", name: "Netherlands" },
      { code: "BE", name: "Belgium" },
      { code: "PT", name: "Portugal" },
      { code: "IE", name: "Ireland" },
      { code: "AT", name: "Austria" },
    ],
  },
}

async function installHostMockInterceptor(page: import("@playwright/test").Page) {
  // Install BEFORE the kernel boot: when the kernel assigns
  // `window.__liaisonHost = ...`, our setter captures the real shape and
  // hands the plugin a wrapper whose `invokeTool` returns canned data.
  await page.addInitScript((mocks: Record<string, unknown>) => {
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    let real: any
    // biome-ignore lint/suspicious/noExplicitAny: window-level shim
    Object.defineProperty(window as any, "__liaisonHost", {
      configurable: true,
      get() {
        return real
      },
      set(h: unknown) {
        const original = h as Record<string, unknown>
        real = {
          ...original,
          invokeTool: async (appName: string, toolName: string, args: Record<string, unknown>) => {
            const key = `${appName}:${toolName}`
            if (Object.hasOwn(mocks, key)) {
              return mocks[key]
            }
            // Fallthrough — unmocked tools hit the real route.
            const orig = original.invokeTool as
              | ((a: string, t: string, args: Record<string, unknown>) => Promise<unknown>)
              | undefined
            if (orig) return orig.call(original, appName, toolName, args)
            throw new Error(`unmocked tool: ${key}`)
          },
        }
      },
    })
  }, MOCKS)
}

test.describe("Shopify: visual baselines", () => {
  test.beforeAll(async ({ env, world, qa }) => {
    // No creds gate. This scenario intercepts `window.__liaisonHost.invokeTool`
    // and serves canned data for EVERY tool the panels read (see MOCKS above),
    // so it never makes a live Shopify Admin call. The install runs in MOCK
    // mode — the test-only route seeds `mock-shop.myshopify.com` + a synthetic
    // webhook secret without touching `SHOPIFY_DEV_STORE_OFFLINE_TOKEN`. This
    // keeps the panel-content + visual-baseline coverage running in
    // credential-less CI rather than silently skipping (deep-review cluster 8).
    await installShopifyApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: SHOPIFY_BUNDLE,
    })
  })

  test.beforeEach(async ({ page, env, qa }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await forceDarkMode(page)
    await installHostMockInterceptor(page)
    await loginAs(page, env, qa.admin.email, "12345678")
  })

  async function gotoAndScreenshot(
    page: import("@playwright/test").Page,
    env: { ports: number[] },
    relativeUrl: string,
    panelSelector: string,
    snapshotName: string,
    // Content section testids that MUST render once props.load resolves —
    // these assert the C5 fix (createResource → live content), so they fire
    // on every platform, not just where pixel baselines exist. The panel
    // mounting is necessary but not sufficient: a regression that left the
    // panel stuck on `*-panel-loading` would still satisfy `panel visible`
    // but fail these content checks.
    contentTestids: string[],
  ) {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}${relativeUrl}`)
    await page.waitForLoadState("networkidle")
    const panel = page.locator(panelSelector).first()
    await expect(panel).toBeVisible({ timeout: 15_000 })
    for (const testid of contentTestids) {
      await expect(panel.getByTestId(testid)).toBeVisible({ timeout: 15_000 })
    }
    // The loading fallback must be gone — the resource resolved to content.
    await expect(panel.locator('[data-testid$="-panel-loading"]')).toHaveCount(0)
    // Give the plugin's resource one tick to settle now that data resolved.
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot(snapshotName, {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  }

  test("home — populated", async ({ page, env }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/shopify`)
    await page.waitForLoadState("networkidle")
    const panel = page.locator('[data-testid="shopify-home"]').first()
    await expect(panel).toBeVisible({ timeout: 15_000 })
    // Wait for the data-driven sections to settle before snapshotting so
    // the recent-orders table is fully painted.
    await expect(
      page.locator('[data-testid="home-recent-order-row-gid://shopify/Order/12768069779622"]'),
    ).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot("home-populated.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  test("orders list — populated", async ({ page, env }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/shopify/orders`)
    await page.waitForLoadState("networkidle")
    const panel = page.locator('[data-testid="shopify-orders-list"]').first()
    await expect(panel).toBeVisible({ timeout: 15_000 })
    const firstOrderRow = page.locator(
      '[data-testid="shopify-orders-row-gid://shopify/Order/12768069779622"]',
    )
    await expect(firstOrderRow).toBeVisible({ timeout: 15_000 })

    // Merged orders+drafts table: the first order row shows its total.
    await expect(firstOrderRow).toContainText("189.50")
    await expect(firstOrderRow).toContainText("EUR")

    // Invoice links: at least one pill renders for a linked order.
    await expect(panel.locator('[data-testid^="shopify-order-invoice-link-"]').first()).toBeVisible(
      { timeout: 15_000 },
    )

    // Filter chips render inside the list section.
    for (const key of ["all", "open", "unfulfilled", "cancelled", "refunded", "drafts"]) {
      await expect(panel.getByTestId(`shopify-orders-filter-${key}`)).toBeVisible()
    }

    // Clicking the Drafts chip shows a draft row and hides regular orders.
    await panel.getByTestId("shopify-orders-filter-drafts").click()
    await expect(
      page.locator('[data-testid="shopify-orders-row-gid://shopify/DraftOrder/1637830820006"]'),
    ).toBeVisible({ timeout: 15_000 })
    await expect(firstOrderRow).toHaveCount(0)
    // Reset back to "All" so the pixel baseline captures the resting state.
    await panel.getByTestId("shopify-orders-filter-all").click()
    await expect(firstOrderRow).toBeVisible({ timeout: 15_000 })

    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot("orders-list-populated.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  test("customers list — populated", async ({ page, env }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/shopify/customers`)
    await page.waitForLoadState("networkidle")
    const panel = page.locator('[data-testid="shopify-customers-list"]').first()
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('[data-testid="shopify-customers-row-gid://shopify/Customer/24929631043750"]'),
    ).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot("customers-list-populated.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  test("products list — populated", async ({ page, env }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/shopify/products`)
    await page.waitForLoadState("networkidle")
    const panel = page.locator('[data-testid="shopify-products-list"]').first()
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('[data-testid="shopify-products-row-gid://shopify/Product/15332593074342"]'),
    ).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot("products-list-populated.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  test("markets list — populated", async ({ page, env }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/shopify/markets`)
    await page.waitForLoadState("networkidle")
    const panel = page.locator('[data-testid="shopify-markets-list"]').first()
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(
      page.locator('[data-testid="shopify-markets-row-gid://shopify/Market/57061441702"]'),
    ).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot("markets-list-populated.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  test("sidebar — home active", async ({ page, env }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/shopify`)
    await page.waitForLoadState("networkidle")
    const sidebar = page.locator('[data-testid="shopify-sidebar"]').first()
    await expect(sidebar).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(sidebar).toHaveScreenshot("sidebar-home-active.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  test("settings — connected", async ({ page, env }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.goto(`${viteUrl}/settings/apps/shopify`)
    await page.waitForLoadState("networkidle")
    const panel = page.locator('[data-testid="shopify-settings"]').first()
    await expect(panel).toBeVisible({ timeout: 15_000 })

    // C2 affordance assertions (functional, not pixel): the store connection
    // (connect, disconnect) is the page's connections block, and the single
    // unmapped row (u3) reveals a real staff-id input when "Map manually" is
    // clicked — the empty-string submit regression is gone.
    await expect(page.getByTestId("connections-conn-shop")).toBeVisible()
    await expect(panel.getByTestId("shopify-disconnect-button")).toHaveCount(0)
    await panel.getByTestId("map-u3").click()
    await expect(panel.getByTestId("map-input-u3")).toBeVisible()
    await expect(panel.getByTestId("map-save-u3")).toBeVisible()
    // Reset to the resting state so the pixel baseline is the static panel.
    await panel.getByTestId("map-cancel-u3").click()
    await expect(panel.getByTestId("map-u3")).toBeVisible()

    await page.waitForTimeout(250)
    if (PIXEL_BASELINES)
      await expect(panel).toHaveScreenshot("settings-connected.png", {
        ...SHOT,
        mask: volatileShellMasks(page),
      })
  })

  // Orders have NO in-app detail panel — clicking an order row opens the
  // Shopify admin order page in a new browser tab. Functional (not pixel):
  // record window.open and assert the admin URL carries the numeric order id
  // on the real store domain.
  test("order row click opens the Shopify admin order page in a new tab", async ({ page, env }) => {
    const viteUrl = `http://localhost:${env.ports[1]}`
    await page.addInitScript(() => {
      const w = window as unknown as { __openedUrls: string[]; open: (u?: string) => null }
      w.__openedUrls = []
      w.open = (u?: string) => {
        w.__openedUrls.push(u ?? "")
        return null
      }
    })
    await page.goto(`${viteUrl}/shopify/orders`)
    await page.waitForLoadState("networkidle")
    const row = page.locator(
      '[data-testid="shopify-orders-row-gid://shopify/Order/12768069779622"]',
    )
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    await expect
      .poll(async () =>
        page.evaluate(() => (window as unknown as { __openedUrls: string[] }).__openedUrls),
      )
      .toContain("https://example-store.myshopify.com/admin/orders/12768069779622")
    // No in-app navigation happened — still on the orders list, no detail tab.
    await expect(page.getByTestId("shopify-orders-list")).toBeVisible()
    expect(page.url()).toContain("/shopify/orders")
  })

  test("customer panel", async ({ page, env }) => {
    await gotoAndScreenshot(
      page,
      env,
      `/detail/shopify/customer/${encodeURIComponent("gid://shopify/Customer/24929631043750")}`,
      '[data-testid="customer-panel"]',
      "customer-panel.png",
      ["customer-tags", "customer-orders"],
    )
  })

  test("product panel", async ({ page, env }) => {
    await gotoAndScreenshot(
      page,
      env,
      `/detail/shopify/product/${encodeURIComponent("gid://shopify/Product/15332593074342")}`,
      '[data-testid="product-panel"]',
      "product-panel.png",
      ["product-variants", "product-market-prices"],
    )
  })

  test("draft order panel", async ({ page, env }) => {
    await gotoAndScreenshot(
      page,
      env,
      `/detail/shopify/draftOrder/${encodeURIComponent("gid://shopify/DraftOrder/1637830820006")}`,
      '[data-testid="draft-order-panel"]',
      "draft-order-panel.png",
      ["draft-line-items", "draft-total"],
    )
  })

  test("return panel", async ({ page, env }) => {
    await gotoAndScreenshot(
      page,
      env,
      `/detail/shopify/return/${encodeURIComponent("gid://shopify/Return/9001")}`,
      '[data-testid="return-panel"]',
      "return-panel.png",
      ["return-line-items", "return-order-ref"],
    )
  })

  // Refund panel is not snapshotted: DetailTab routes `/detail/<app>/<entity>/<id>`
  // and passes only `{ shop, id }` to the panel, but RefundPanel requires an
  // additional `orderId`. Surfacing refunds via a detail tab is a separate gap.

  test("market panel", async ({ page, env }) => {
    await gotoAndScreenshot(
      page,
      env,
      `/detail/shopify/market/${encodeURIComponent("gid://shopify/Market/57061441702")}`,
      '[data-testid="market-panel"]',
      "market-panel.png",
      ["market-regions"],
    )
  })
})
