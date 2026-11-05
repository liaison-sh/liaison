// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 17 e2e S2 — Shopify auto-flow (order → auto-issued invoice).
//
// The killer feature: a paid Shopify order materializes an invoice with zero
// human action. The chain exercised end-to-end:
//
//   orders/create webhook (HMAC-signed) → shopify app `ordersCreateHandler`
//   → emits kernel event `shopify/order:created` → outbox fan-out → invoicing
//   `onShopifyOrderCreated` (the cross-app ADAPTER: maps shopify's normalized
//   event shape → invoicing's OrderPaidPayload, resolves the kernel contact,
//   defaults domestic country) → issueDocument → numbered invoice + PDF +
//   thread post.
//
// CLEAN SEPARATION: invoicing declares `shopify` as an OPTIONAL dependency and
// only subscribes to its events. This whole flow is inert unless shopify is
// installed and emitting — invoicing installs and runs fully standalone (manual
// issuance, dashboards, all tools) without it. This scenario is the ONLY place
// the optional shopify-sync feature is exercised.
//
// Real-creds gate (honest Phase-16 mirror): the webhook delivery is SYNTHETIC
// (locally HMAC-signed), but the handler's best-effort `shopify:orders_get`
// enrichment is a real cross-app call, so we gate on `shopifyConfig.available`
// and run only where `SHOPIFY_DEV_STORE_*` creds are present (.env.test). The
// flow is robust to the enrichment returning nothing (synthetic order id is not
// in the store) — everything needed is derived from the event payload.
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

const LIAISON_ROOT = resolve(__dirname, "..", "..", "..", "..", "..", "..")
const INVOICING_BUNDLE = resolvedInvoicingBundle
const SHOPIFY_BUNDLE = bundledAppTarball(LIAISON_ROOT, "shopify")

interface OrderWebhookOpts {
  orderId: string
  customerNumericId: string
  email: string
  firstName: string
  lastName: string
  totalPrice: string
  currency: string
  lineTitle: string
  variantId: string
  /** Tax charged on the line, as Shopify reports it alongside `rate`. */
  taxPrice?: string
  /** The line's NET unit price, when it differs from the order total. */
  unitPrice?: string
  /** Omit the postal address, to exercise the counterparty-completeness guard. */
  withoutAddress?: boolean
}

// Minimal `orders/create` body shape the shopify `normalizeOrder` reads. A paid
// checkout's orders/create webhook carries financial_status "paid"; invoicing
// issues on order-created (the event the shopify bundle emits).
function orderWebhookBody(o: OrderWebhookOpts): Record<string, unknown> {
  return {
    id: Number(o.orderId),
    name: `#${o.orderId}`,
    financial_status: "paid",
    currency: o.currency,
    total_price: o.totalPrice,
    customer: {
      id: Number(o.customerNumericId),
      email: o.email,
      first_name: o.firstName,
      last_name: o.lastName,
    },
    // THE RECIPIENT HAS TO BE COMPLETE. An issued invoice is a legal record, so
    // `counterpartyCompletenessError` requires a postal address as well as a
    // name, an email and a country; `adaptShopifyOrderCreatedEvent` reads that
    // address off the order's `billing_address` (ship-to is only the fallback).
    // Without one the handler files a deferred `counterparty_incomplete` row and
    // issues NOTHING, silently as far as the webhook response is concerned.
    ...(o.withoutAddress
      ? {}
      : {
          billing_address: {
            name: `${o.firstName} ${o.lastName}`,
            address1: "12 Rue de Rivoli",
            city: "Paris",
            zip: "75004",
            country_code: "FR",
          },
        }),
    line_items: [
      {
        id: Number(o.variantId),
        title: o.lineTitle,
        quantity: 1,
        price: o.unitPrice ?? o.totalPrice,
        variant_id: Number(o.variantId),
        variant_title: "Default",
        sku: "SKU-1",
        // The tax Shopify charged on this line. An ABSENT `tax_lines` is not
        // "unknown" once the shopify bundle has normalised the webhook: the
        // normaliser emits an empty array, which means "taxed at 0", and the
        // invoice is then rightly issued net of VAT. A domestic FR order at 20%
        // has to say so here for the mapping to be under test at all.
        ...(o.withoutAddress ? {} : { tax_lines: [{ rate: 0.2, price: o.taxPrice ?? "0.00" }] }),
      },
    ],
  }
}

/** The org's parked auto-flow events (`deferred_list`: id, status, reason). */
async function listDeferred(
  serverUrl: string,
  token: string,
): Promise<Array<Record<string, unknown>>> {
  const resp = await api(serverUrl, "/api/apps/invoicing/tools/deferred_list", {
    method: "POST",
    token,
    body: { params: { limit: 50 } },
  })
  const body = (resp.body ?? {}) as Record<string, unknown>
  const payload = (body.data ?? body) as Record<string, unknown>
  return (payload.items as Array<Record<string, unknown>>) ?? []
}

async function searchInvoicingDocuments(
  serverUrl: string,
  token: string,
): Promise<Array<Record<string, unknown>>> {
  const resp = await api(serverUrl, "/api/apps/invoicing/tools/documents_search", {
    method: "POST",
    token,
    body: { params: {} },
  })
  if (resp.status !== 200) {
    // eslint-disable-next-line no-console
    console.error("[S2 documents_search] non-200:", resp.status, JSON.stringify(resp.body))
    return []
  }
  const body = (resp.body ?? {}) as Record<string, unknown>
  const u =
    "data" in body && body.data && typeof body.data === "object"
      ? (body.data as Record<string, unknown>)
      : body
  if (Array.isArray(u)) return u as Array<Record<string, unknown>>
  return (
    ((u as { items?: Array<Record<string, unknown>> }).items as Array<Record<string, unknown>>) ??
    []
  )
}

test.describe("Invoicing: Shopify auto-flow", () => {
  test("paid order webhook auto-issues exactly one numbered invoice (idempotent)", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)

    // 1. Install shopify (returns the install handle + webhook secret) and
    //    invoicing wired to that shop (issuer.shopify_shop_id ← shopDomain).
    const shopify = await installShopifyApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: SHOPIFY_BUNDLE,
    })
    await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      // No approval threshold → €120 issues directly (under-threshold path).
      shopifyInstallHandle: { shopDomain: shopify.shopDomain, connectionId: shopify.connectionId },
    })

    // 2. Materialize the kernel contact via a customers/create webhook (the
    //    auto-flow links the order's customer to this contact).
    const unique = randomBytes(4).toString("hex")
    const customerNumericId = String(8_880_000 + Math.floor(Math.random() * 9999))
    const orderId = String(7_770_000 + Math.floor(Math.random() * 9999))
    const email = `auto-flow+${unique}@example.com`
    const fixture = customerFixture({
      numericId: customerNumericId,
      email,
      firstName: "Auto",
      lastName: "Flow",
    })
    const custResult = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "customers-create",
      body: customerWebhookBody(fixture),
      secret: shopify.webhookSecret,
      shopDomain: shopify.shopDomain,
    })
    expect(custResult.status).toBeGreaterThanOrEqual(200)
    expect(custResult.status).toBeLessThan(300)

    // 3. Dispatch a paid orders/create webhook (€120 EUR, FR domestic).
    const orderBody = orderWebhookBody({
      orderId,
      customerNumericId,
      email,
      firstName: "Auto",
      lastName: "Flow",
      totalPrice: "144.00",
      unitPrice: "120.00",
      taxPrice: "24.00",
      currency: "EUR",
      lineTitle: "Auto-flow widget",
      variantId: "5550001",
    })
    const orderResult = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "orders-create",
      body: orderBody,
      secret: shopify.webhookSecret,
      shopDomain: shopify.shopDomain,
    })
    expect(orderResult.status).toBeGreaterThanOrEqual(200)
    expect(orderResult.status).toBeLessThan(300)

    // 4. Poll invoicing documents (eventually consistent — the order:created
    //    event fans out through the outbox worker on a ~1s interval).
    const start = Date.now()
    let docs: Array<Record<string, unknown>> = []
    while (Date.now() - start < 40_000) {
      docs = await searchInvoicingDocuments(env.serverUrl, qa.admin.token)
      if (docs.length >= 1) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(docs.length, "expected exactly one auto-issued invoice within 40s").toBe(1)

    const doc = docs[0]
    expect(doc.type).toBe("invoice")
    expect(doc.status).toBe("issued") // under threshold → no approval gate
    expect(String(doc.number)).toMatch(/^INV-\d{4}-\d{4}$/)
    // The €120.00 line is the NET unit price; FR-domestic auto-flow adds 20% VAT
    // → grand total €144.00 (the order's total_price is informational — the
    // invoice is recomputed from snapshotted lines + the classified tax regime).
    expect(String(doc.grand_total_minor)).toBe("14400")
    expect(doc.currency).toBe("EUR")

    // 5. Idempotency probe — re-dispatch the SAME order; webhook dedup +
    //    document-level dedup must keep the count at exactly one.
    const dupResult = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "orders-create",
      body: orderBody,
      secret: shopify.webhookSecret,
      shopDomain: shopify.shopDomain,
    })
    expect(dupResult.status).toBeGreaterThanOrEqual(200)
    expect(dupResult.status).toBeLessThan(300)
    await new Promise((r) => setTimeout(r, 5000))
    const after = await searchInvoicingDocuments(env.serverUrl, qa.admin.token)
    expect(after.length, "re-dispatch must not create a second invoice").toBe(1)
  })

  // THE GUARD'S OWN CONTRACT, which no other suite covers. An order whose
  // customer carries no postal address cannot be invoiced legally, so the
  // handler must PARK it as `awaiting_data` / `counterparty_incomplete` and
  // issue nothing: the webhook still answers 2xx, which is exactly why the
  // absence of an invoice has to be asserted against the deferred row rather
  // than against the response.
  test("an order with no postal address is parked as counterparty_incomplete, not invoiced", async ({
    env,
    world,
    qa,
    shopifyConfig,
  }) => {
    requireShopifyCreds(shopifyConfig)

    const shopify = await installShopifyApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: SHOPIFY_BUNDLE,
    })
    await installInvoicingApp({
      serverUrl: env.serverUrl,
      token: qa.admin.token,
      orgId: world.org.id,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      shopifyInstallHandle: { shopDomain: shopify.shopDomain, connectionId: shopify.connectionId },
    })

    const unique = randomBytes(4).toString("hex")
    const customerNumericId = String(8_890_000 + Math.floor(Math.random() * 9999))
    const orderId = String(7_780_000 + Math.floor(Math.random() * 9999))
    const email = `no-address+${unique}@example.com`
    const custResult = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "customers-create",
      body: customerWebhookBody(
        customerFixture({
          numericId: customerNumericId,
          email,
          firstName: "No",
          lastName: "Address",
        }),
      ),
      secret: shopify.webhookSecret,
      shopDomain: shopify.shopDomain,
    })
    expect(custResult.status).toBeLessThan(300)

    const before = await searchInvoicingDocuments(env.serverUrl, qa.admin.token)
    const deferredBefore = await listDeferred(env.serverUrl, qa.admin.token)
    const orderResult = await dispatchTestWebhook({
      serverUrl: env.serverUrl,
      orgId: world.org.id,
      appName: "shopify",
      endpointName: "orders-create",
      body: orderWebhookBody({
        orderId,
        customerNumericId,
        email,
        firstName: "No",
        lastName: "Address",
        totalPrice: "120.00",
        currency: "EUR",
        lineTitle: "Unaddressed widget",
        variantId: "5550002",
        withoutAddress: true,
      }),
      secret: shopify.webhookSecret,
      shopDomain: shopify.shopDomain,
    })
    expect(orderResult.status).toBeGreaterThanOrEqual(200)
    expect(orderResult.status).toBeLessThan(300)

    // The parked row, polled the same way the happy path polls for its invoice.
    // `deferred_list` projects id + status + reason (no event id), so the row
    // this dispatch parked is the one that was NOT there before it.
    const start = Date.now()
    let parked: Record<string, unknown> | undefined
    while (Date.now() - start < 40_000) {
      const rows = await listDeferred(env.serverUrl, qa.admin.token)
      parked = rows.find((r) => !deferredBefore.some((b) => b.id === r.id))
      if (parked) break
      await new Promise((r) => setTimeout(r, 1000))
    }
    expect(parked, `no new deferred row within 40s for order ${orderId}`).toBeTruthy()
    expect(parked?.reason).toBe("counterparty_incomplete")
    expect(parked?.status).toBe("awaiting_data")

    // And NOTHING was issued for it.
    const afterUnaddressed = await searchInvoicingDocuments(env.serverUrl, qa.admin.token)
    expect(afterUnaddressed.length, "an incomplete recipient must not produce a document").toBe(
      before.length,
    )
  })
})
