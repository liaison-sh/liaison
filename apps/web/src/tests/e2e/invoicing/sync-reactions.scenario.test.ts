// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e — Shopify → invoicing SYNC REACTIONS (real dev store).
//
// Proves the sync paths that were previously untested end-to-end (only the
// order:created→auto-invoice path had e2e coverage). Each scenario drives a
// real, HMAC-signed Shopify webhook through the kernel router → shopify bundle
// → emitted kernel event → outbox fan-out → invoicing handler, then asserts the
// OBSERVABLE outcome on the document via `documents_get`:
//
//   • refunds/create  → invoice payment_status flips to refunded / partial
//                        (Bug A: manual admin refunds used to leave the invoice
//                        marked paid — the webhook only raised an attention card)
//   • orders/updated  → lifecycle_log gains `downstream_change_observed`
//                        (Bug: the handler read the wrong envelope field and
//                        silently no-op'd on every real order edit)
//   • orders/cancelled→ lifecycle_log gains `shopify_order_cancelled`
//   • a customs-bearing product → the auto-issued invoice LINE carries the real
//     HS code / country of origin / goods description, fetched live at issue
//     time (Bug B: customs set in the Shopify admin never reached invoices).
//
// Real-creds gated (hard-fail, not skip) via `requireShopifyCreds`. The webhook
// DELIVERY is synthetic (locally HMAC-signed) but the handlers' cross-app reads
// (`shopify:variants_get` for customs) hit the live store, so we gate on creds.
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { api } from "@liaison/test-helpers"
import { bundledAppTarball } from "../bundled-app-tarball"
import { customerFixture, customerWebhookBody } from "../shopify/helpers/customer-fixture"
import { dispatchTestWebhook } from "../shopify/helpers/dispatch-shopify-webhook"
import { installShopifyApp } from "../shopify/helpers/install-shopify-app"
import { expect, requireShopifyCreds, test } from "./_invoicing-fixtures"
import { installInvoicingApp } from "./helpers/install-invoicing-app"
import { INVOICING_BUNDLE as resolvedInvoicingBundle } from "./helpers/invoicing-bundle"
import { EXPECTED_CUSTOMS, seedShopifyCustomsProduct } from "./helpers/seed-shopify-customs"

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

interface DocSummary extends Record<string, unknown> {
  id?: string
}

function unwrap(body: unknown): unknown {
  const b = (body ?? {}) as Record<string, unknown>
  return "data" in b && b.data ? b.data : b
}

async function searchDocs(serverUrl: string, token: string): Promise<DocSummary[]> {
  const resp = await api(serverUrl, "/api/apps/invoicing/tools/documents_search", {
    method: "POST",
    token,
    body: { params: {} },
  })
  if (resp.status !== 200) return []
  const u = unwrap(resp.body) as DocSummary[] | { items?: DocSummary[] }
  if (Array.isArray(u)) return u
  return u.items ?? []
}

async function getDoc(
  serverUrl: string,
  token: string,
  id: string,
): Promise<Record<string, unknown>> {
  const resp = await api(serverUrl, "/api/apps/invoicing/tools/documents_get", {
    method: "POST",
    token,
    body: { params: { id } },
  })
  expect(resp.status, JSON.stringify(resp.body)).toBe(200)
  return unwrap(resp.body) as Record<string, unknown>
}

interface AutoIssueOpts {
  variantId: string // NUMERIC shopify variant id (webhook shape)
  lineTitle: string
  totalPrice: string
  currency: string
  /**
   * ISO-2 ship-to country carried on the order webhook's `shipping_address`
   * (shopify 0.1.5+ normalizes it onto `event.customer.country`). Omit for the
   * domestic default (issuer-country fallback); pass e.g. "US" so the
   * auto-issued invoice classifies as an export and the issue-time live
   * customs fetch (`shopify:variants_get`) actually fires.
   */
  shipToCountry?: string
}

/**
 * Drive customers/create + a paid orders/create webhook, then poll until a NEW
 * invoice document appears (diffing the id set so this works whether the worker
 * org is shared or fresh). Returns the new document id + the synthetic order id.
 */
async function autoIssueInvoice(
  serverUrl: string,
  token: string,
  orgId: string,
  shopify: { shopDomain: string; webhookSecret: string },
  opts: AutoIssueOpts,
): Promise<{ docId: string; orderId: string }> {
  const before = new Set((await searchDocs(serverUrl, token)).map((d) => String(d.id)))

  const unique = randomBytes(4).toString("hex")
  const customerNumericId = String(8_880_000 + Math.floor(Math.random() * 9_999))
  const orderId = String(7_770_000 + Math.floor(Math.random() * 9_999))
  const email = `sync-react+${unique}@example.com`
  const fixture = customerFixture({
    numericId: customerNumericId,
    email,
    firstName: "Sync",
    lastName: "React",
  })
  const cust = await dispatchTestWebhook({
    serverUrl,
    orgId,
    appName: "shopify",
    endpointName: "customers-create",
    body: customerWebhookBody(fixture),
    secret: shopify.webhookSecret,
    shopDomain: shopify.shopDomain,
  })
  expect(cust.status).toBeGreaterThanOrEqual(200)
  expect(cust.status).toBeLessThan(300)

  const order = await dispatchTestWebhook({
    serverUrl,
    orgId,
    appName: "shopify",
    endpointName: "orders-create",
    body: {
      id: Number(orderId),
      name: `#${orderId}`,
      financial_status: "paid",
      currency: opts.currency,
      total_price: opts.totalPrice,
      customer: {
        id: Number(customerNumericId),
        email,
        first_name: "Sync",
        last_name: "React",
      },
      ...(opts.shipToCountry ? { shipping_address: { country_code: opts.shipToCountry } } : {}),
      line_items: [
        {
          id: Number(`91${orderId}`),
          title: opts.lineTitle,
          quantity: 1,
          price: opts.totalPrice,
          variant_id: Number(opts.variantId),
          variant_title: "Default",
          sku: "SKU-SYNC",
        },
      ],
    },
    secret: shopify.webhookSecret,
    shopDomain: shopify.shopDomain,
  })
  expect(order.status).toBeGreaterThanOrEqual(200)
  expect(order.status).toBeLessThan(300)

  const startedAt = Date.now()
  while (Date.now() - startedAt < 45_000) {
    const after = await searchDocs(serverUrl, token)
    const fresh = after.find((d) => !before.has(String(d.id)))
    if (fresh?.id) return { docId: String(fresh.id), orderId }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`autoIssueInvoice: no new invoice appeared within 45s for order ${orderId}`)
}

interface ShopifyRealCfg {
  shopDomain: string
  offlineToken: string
  webhookSecret: string
}

async function installApps(
  serverUrl: string,
  token: string,
  orgId: string,
  cfg: ShopifyRealCfg,
): Promise<{ shopDomain: string; webhookSecret: string; connectionId: string }> {
  // Install against the REAL dev store (real offline token) so the order-paid
  // issue-time `shopify:variants_get` customs fetch hits live data. The webhook
  // signing secret is pinned to the dev-store secret so dispatchTestWebhook's
  // HMAC matches the verifier.
  const shopify = await installShopifyApp({
    serverUrl,
    token,
    orgId,
    bundlePath: SHOPIFY_BUNDLE,
    shopDomain: cfg.shopDomain,
    realOfflineToken: cfg.offlineToken,
    realWebhookSecret: cfg.webhookSecret,
  })
  await installInvoicingApp({
    serverUrl,
    token,
    orgId,
    bundlePath: INVOICING_BUNDLE,
    issuerCountry: "FR",
    shopifyInstallHandle: { shopDomain: shopify.shopDomain, connectionId: shopify.connectionId },
  })
  return shopify
}

function lifecycleEvents(doc: Record<string, unknown>): string[] {
  const log = (doc.lifecycle_log as Array<Record<string, unknown>> | undefined) ?? []
  return log.map((e) => String(e.event))
}

test.describe("Invoicing: Shopify sync reactions (real store)", () => {
  test("manual refund webhook flips the invoice payment_status to 'refunded'", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    const shopify = await installApps(env.serverUrl, qa.admin.token, world.org.id, shopifyConfig)
    const { docId, orderId } = await autoIssueInvoice(
      env.serverUrl,
      qa.admin.token,
      world.org.id,
      shopify,
      {
        variantId: "5550001",
        lineTitle: "Refund-target widget",
        totalPrice: "120.00",
        currency: "EUR",
      },
    )

    // Refund the FULL grand total (read it back so the amount matches exactly).
    const issued = await getDoc(env.serverUrl, qa.admin.token, docId)
    const grandTotalMinor = BigInt(String(issued.grand_total_minor ?? "0"))
    const refundMajor = (Number(grandTotalMinor) / 100).toFixed(2)

    const refund = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "refunds-create",
      body: {
        id: Number(`66${orderId}`),
        order_id: Number(orderId),
        transactions: [{ amount: refundMajor, currency: "EUR" }],
      },
      secret: shopify.webhookSecret,
      shopDomain: shopify.shopDomain,
    })
    expect(refund.status).toBeGreaterThanOrEqual(200)
    expect(refund.status).toBeLessThan(300)

    // Poll until the async refund:created handler reconciles the invoice.
    const startedAt = Date.now()
    let doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    while (doc.payment_status !== "refunded" && Date.now() - startedAt < 30_000) {
      await new Promise((r) => setTimeout(r, 1000))
      doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    }
    expect(doc.payment_status, "manual refund must reconcile the invoice").toBe("refunded")
    expect(lifecycleEvents(doc)).toContain("refunded")
  })

  test("partial refund webhook flips payment_status to 'partial'", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    const shopify = await installApps(env.serverUrl, qa.admin.token, world.org.id, shopifyConfig)
    const { docId, orderId } = await autoIssueInvoice(
      env.serverUrl,
      qa.admin.token,
      world.org.id,
      shopify,
      {
        variantId: "5550002",
        lineTitle: "Partial-refund widget",
        totalPrice: "200.00",
        currency: "EUR",
      },
    )

    const refund = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "refunds-create",
      body: {
        id: Number(`67${orderId}`),
        order_id: Number(orderId),
        transactions: [{ amount: "50.00", currency: "EUR" }],
      },
      secret: shopify.webhookSecret,
      shopDomain: shopify.shopDomain,
    })
    expect(refund.status).toBeLessThan(300)

    const startedAt = Date.now()
    let doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    while (doc.payment_status === "unpaid" && Date.now() - startedAt < 30_000) {
      await new Promise((r) => setTimeout(r, 1000))
      doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    }
    expect(doc.payment_status).toBe("partial")
    expect(lifecycleEvents(doc)).toContain("partially_refunded")
  })

  test("a PAID order auto-issues an invoice already reconciled to payment_status='paid' (stays issued)", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    const shopify = await installApps(env.serverUrl, qa.admin.token, world.org.id, shopifyConfig)
    // autoIssueInvoice fires a `financial_status: "paid"` orders/create webhook.
    const { docId } = await autoIssueInvoice(env.serverUrl, qa.admin.token, world.org.id, shopify, {
      variantId: "5550010",
      lineTitle: "Paid-checkout widget",
      totalPrice: "150.00",
      currency: "EUR",
    })

    // The invoice is issued with a NUMBER (a real legal invoice) and its payment
    // side is settled from the order's financial_status. The paid reconciliation
    // runs in the same async order-created handler as issuance, so poll until it
    // lands (same pattern as the refund reaction above) rather than racing it.
    const startedAt = Date.now()
    let doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    while (doc.payment_status !== "paid" && Date.now() - startedAt < 30_000) {
      await new Promise((r) => setTimeout(r, 1000))
      doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    }
    expect(doc.payment_status, "a paid Shopify order must issue a PAID invoice").toBe("paid")
    // (paid_at is written in the same update as payment_status — asserted against
    // the DB in the unit test; documents_get does not project it, so it is not
    // observable here.)
    // It stays a live, shippable issued document (boxtal ships status='issued';
    // flipping to 'paid' would drop paid physical-goods orders from shipping).
    expect(doc.status).toBe("issued")
    expect(lifecycleEvents(doc)).toContain("marked_paid")
    // The invoice carries the shop domain for the "Open Shopify order" deep link.
    const refs = (doc.external_refs ?? {}) as Record<string, unknown>
    expect(refs.shopify_shop_domain).toBe(shopifyConfig.shopDomain)
  })

  test("orders/updated webhook records a downstream_change on the issued invoice", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    const shopify = await installApps(env.serverUrl, qa.admin.token, world.org.id, shopifyConfig)
    const { docId, orderId } = await autoIssueInvoice(
      env.serverUrl,
      qa.admin.token,
      world.org.id,
      shopify,
      {
        variantId: "5550003",
        lineTitle: "Edited-order widget",
        totalPrice: "120.00",
        currency: "EUR",
      },
    )

    const updated = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "orders-updated",
      body: { id: Number(orderId), name: `#${orderId}`, currency: "EUR", total_price: "150.00" },
      secret: shopify.webhookSecret,
      shopDomain: shopify.shopDomain,
    })
    expect(updated.status).toBeLessThan(300)

    const startedAt = Date.now()
    let doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    while (
      !lifecycleEvents(doc).includes("downstream_change_observed") &&
      Date.now() - startedAt < 30_000
    ) {
      await new Promise((r) => setTimeout(r, 1000))
      doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    }
    expect(lifecycleEvents(doc)).toContain("downstream_change_observed")
    // An order edit must NOT silently void/alter the issued invoice.
    expect(doc.status).toBe("issued")
  })

  test("orders/cancelled webhook records the cancellation on the issued invoice", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    const shopify = await installApps(env.serverUrl, qa.admin.token, world.org.id, shopifyConfig)
    const { docId, orderId } = await autoIssueInvoice(
      env.serverUrl,
      qa.admin.token,
      world.org.id,
      shopify,
      {
        variantId: "5550004",
        lineTitle: "Cancelled-order widget",
        totalPrice: "120.00",
        currency: "EUR",
      },
    )

    const cancelled = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "orders-cancelled",
      body: { id: Number(orderId), name: `#${orderId}`, cancel_reason: "customer" },
      secret: shopify.webhookSecret,
      shopDomain: shopify.shopDomain,
    })
    expect(cancelled.status).toBeLessThan(300)

    const startedAt = Date.now()
    let doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    while (
      !lifecycleEvents(doc).includes("shopify_order_cancelled") &&
      Date.now() - startedAt < 30_000
    ) {
      await new Promise((r) => setTimeout(r, 1000))
      doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    }
    expect(lifecycleEvents(doc)).toContain("shopify_order_cancelled")
    // The issued invoice is preserved (a credit note is the legal instrument).
    expect(doc.status).toBe("issued")
  })

  test("a customs-bearing product → auto-issued invoice LINE carries real HS/CoO/description", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)
    // Seed the dogfood store with a product carrying HS code + country of origin
    // + the customs-description metafield, and grab its NUMERIC variant id.
    const seeded = await seedShopifyCustomsProduct({
      shopDomain: shopifyConfig.shopDomain,
      token: shopifyConfig.offlineToken,
      apiVersion: shopifyConfig.apiVersion,
    })
    const numericVariantId = seeded.variantId.split("/").pop() ?? ""
    expect(numericVariantId, "seeded variant gid → numeric id").not.toBe("")

    const shopify = await installApps(env.serverUrl, qa.admin.token, world.org.id, shopifyConfig)
    const { docId } = await autoIssueInvoice(env.serverUrl, qa.admin.token, world.org.id, shopify, {
      variantId: numericVariantId,
      lineTitle: seeded.handle,
      totalPrice: "300.00",
      currency: "EUR",
      // Ship OUTSIDE the EU so the FR issuer classifies this as an export
      // (`requires_hs_code`) — that is what arms the issue-time live customs
      // fetch. A domestic order legally carries no HS codes, so without this
      // the assertion below would test an unreachable path.
      shipToCountry: "US",
    })

    const doc = await getDoc(env.serverUrl, qa.admin.token, docId)
    const lines = (doc.lines as Array<Record<string, unknown>> | undefined) ?? []
    expect(lines.length, "invoice should have at least one line").toBeGreaterThan(0)
    const line = lines[0]!
    // Customs were fetched live at issue time (overlay starts empty) via
    // shopify:variants_get against the real store, keyed by the variant gid.
    expect(line.hs_code, "HS code must carry onto the export invoice line").toBe(
      EXPECTED_CUSTOMS.hsCode,
    )
    expect(line.country_of_origin).toBe(EXPECTED_CUSTOMS.countryOfOrigin)
    expect(line.customs_description).toBe(EXPECTED_CUSTOMS.customsDescription)
  })
})
