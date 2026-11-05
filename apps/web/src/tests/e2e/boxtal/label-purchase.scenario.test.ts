// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A label purchase from the To prepare grid, on the real rendered screen, as close to production
// as a test gets: a real install of shopify + invoicing + boxtal, open orders in the offline
// Shopify Admin API mock, the real order sync behind "Pull orders", the kernel address book over
// REST, and the offline Boxtal API mock. Only the two external APIs are mocked.
//
//   * Address differs: the customer has a VERIFIED delivery address that is not the order's
//     ship-to. The synced row is held with an "Address differs" chip, the fold shows both
//     addresses and which one is verified (date and who), Ship is disabled until a person picks,
//     and the label is bought for the PICKED address. A customer with no verified address sees
//     none of it: no chip, Ship enabled.
//   * One approval per label: a person's own Ship click buys on their own scopes (no approval).
//     An agent asking for a label parks exactly ONE approval; a person decides it inline on
//     the row ("Approve and buy"), the label is bought once, and nothing the purchase sets off
//     (the label document arriving over the Boxtal webhook included) raises a second one.
//
// Fixtures are synthetic: names, addresses, emails and order numbers are invented.

import { existsSync } from "node:fs"
import type { WorkerEnv } from "@liaison/test-helpers"
import { api } from "@liaison/test-helpers"
import { forceDarkMode } from "../agent-bootstrap"
import { loginAs } from "../fixtures/test"
import { callToolAsAgent } from "../helpers/approvals"
import { ks } from "../helpers/db-reads"
import { installInvoicingApp } from "../invoicing/helpers/install-invoicing-app"
import { installShopifyApp } from "../shopify/helpers/install-shopify-app"
import {
  assertBoxtalBundle,
  BOXTAL_BUNDLE,
  expect,
  INVOICING_BUNDLE,
  test,
} from "./_boxtal-fixtures"
import { dispatchBoxtalWebhook } from "./helpers/dispatch-boxtal-webhook"
import { installBoxtalApp } from "./helpers/install-boxtal-app"
import { getRequests, resetMock, v3CreatePosts } from "./helpers/mock-boxtal"
import {
  numericOrderId,
  SENDER,
  seedIssuedInvoiceForOrder,
  seedOpenOrders,
  toolPost,
  unwrap,
} from "./helpers/seed-shipment"

test.setTimeout(240_000)

const PROFILE = {
  product_source: "shopify",
  product_id: "VARIANT-LP",
  unit_weight: 0.9,
  solo_length: 32,
  solo_width: 22,
  solo_height: 10,
  content_category: "content:v1:10120",
}

const INVOICE_ITEMS = [
  {
    position: 1,
    description: "Lumen 4 controller",
    quantity: "1",
    unit_price_minor: "49900",
    product_source: "shopify",
    external_id: "VARIANT-LP",
  },
]

const LINE_ITEMS = [
  { title: "Lumen 4 controller", sku: "VARIANT-LP", quantity: 1, unitAmount: "499.00" },
]

/** The order's own ship-to for the customer who has a verified address elsewhere. */
const ORDER_SHIP_TO = {
  name: "Noa Example",
  address1: "5 rue du Test",
  city: "Lyon",
  zip: "69001",
  country: "France",
  countryCode: "FR",
  phone: "+33600000001",
}

/** The same customer's verified delivery address: another place. */
const VERIFIED = {
  role: "delivery",
  name: "Noa Example",
  street1: "18 avenue de l'Exemple",
  city: "Villeurbanne",
  postalCode: "69100",
  countryIso2: "FR",
  phone: "+33600000001",
  email: "noa-lp@e2e.test",
}

/** A normal customer: no address book entry at all. */
const PLAIN_SHIP_TO = {
  name: "Ari Example",
  address1: "9 place du Sample",
  city: "Grenoble",
  zip: "38000",
  country: "France",
  countryCode: "FR",
  phone: "+33600000002",
}

/** The fields of a prep_list row the Ship button sends. */
interface ListedPrepRow {
  order_key: string
  document_ref: string
  recipient?: { phone?: string | null } | null
  quote: {
    selected?: { offer_code: string; price_ttc_minor: number; currency: string } | null
    cheapest?: { offer_code: string; price_ttc_minor: number; currency: string } | null
  }
}

/** Approval rows of the org created since `since`, oldest first. */
async function approvalsSince(
  env: WorkerEnv,
  orgId: string,
  since: Date,
): Promise<Array<{ id: string; toolName: string; status: string }>> {
  return (await env.db.sql.unsafe(
    `SELECT id, tool_name AS "toolName", status
       FROM ${ks(env)}.approval_requests
      WHERE org_id = $1 AND created_at >= $2
      ORDER BY created_at`,
    [orgId, since],
  )) as Array<{ id: string; toolName: string; status: string }>
}

function boxtalSchema(env: WorkerEnv): string {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_boxtal"` : "app_boxtal"
}

test.describe("Boxtal: a label purchase from the To prepare grid", () => {
  // Same reason as prep-grid.scenario.test.ts: the worklist IS the open Shopify orders, so the
  // spawned API reads the OFFLINE mock for this file, and the live setting comes back afterwards.
  const LIVE_BEFORE = process.env.SHOPIFY_E2E_LIVE ?? "1"
  let offlineArmed = false
  async function useOfflineShopify(env: {
    restart: (o: Record<string, unknown>) => Promise<void>
  }) {
    if (offlineArmed) return
    await env.restart({ env: { SHOPIFY_E2E_LIVE: "0" }, timeoutMs: 180_000 })
    offlineArmed = true
  }
  test.afterAll(async ({ env }) => {
    if (!offlineArmed) return
    await env.restart({ env: { SHOPIFY_E2E_LIVE: LIVE_BEFORE }, timeoutMs: 180_000 })
  })

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 950 })
    await forceDarkMode(page)
  })

  test("address differs holds the row until a person picks; one approval, decided inline, buys the picked address", async ({
    page,
    env,
    world,
    qa,
  }) => {
    assertBoxtalBundle()
    expect(existsSync(INVOICING_BUNDLE)).toBe(true)
    const s = env.serverUrl
    const token = qa.admin.token
    const orgId = world.org.id
    await useOfflineShopify(env as never)

    // ── The world: three apps, two customers, two open orders, both invoiced ──
    await resetMock(s, token)
    const invoicing = await installInvoicingApp({
      serverUrl: s,
      token,
      orgId,
      bundlePath: INVOICING_BUNDLE,
      issuerCountry: "FR",
      additionalContacts: [
        {
          country: "FR",
          name: "Noa Example",
          email: "noa-lp@e2e.test",
          customerKind: "individual",
        },
        {
          country: "FR",
          name: "Ari Example",
          email: "ari-lp@e2e.test",
          customerKind: "individual",
        },
      ],
    })
    await installShopifyApp({ serverUrl: s, token, orgId })
    const boxtal = await installBoxtalApp({
      serverUrl: s,
      token,
      orgId,
      bundlePath: BOXTAL_BUNDLE,
      seedSenderAddress: SENDER,
      seedShippingProfiles: [PROFILE],
    })
    await toolPost(s, token, "invoicing", "hs_codes_assign", {
      product_source: "shopify",
      external_id: "VARIANT-LP",
      hs_code: "92071000",
      country_of_origin: "FR",
      customs_description: "Electronic musical instrument controller",
    })
    const [noaContact, ariContact] = invoicing.additionalContactIds as [string, string]
    const issuer = invoicing.primaryIssuerProfileId as string
    const [gidNoa, gidAri] = await seedOpenOrders(s, token, [
      {
        name: "#9101",
        email: "noa-lp@e2e.test",
        shippingAddress: ORDER_SHIP_TO,
        lineItems: LINE_ITEMS,
      },
      {
        name: "#9102",
        email: "ari-lp@e2e.test",
        shippingAddress: PLAIN_SHIP_TO,
        lineItems: LINE_ITEMS,
      },
    ])
    await seedIssuedInvoiceForOrder(s, token, {
      issuerProfileId: issuer,
      contactId: noaContact,
      shopifyOrderId: numericOrderId(gidNoa!),
      counterpartyName: "Noa Example",
      counterpartyCountry: "FR",
      counterpartyEmail: "noa-lp@e2e.test",
      counterpartyAddress: "5 rue du Test, 69001 Lyon, France",
      items: INVOICE_ITEMS,
    })
    await seedIssuedInvoiceForOrder(s, token, {
      issuerProfileId: issuer,
      contactId: ariContact,
      shopifyOrderId: numericOrderId(gidAri!),
      counterpartyName: "Ari Example",
      counterpartyCountry: "FR",
      counterpartyEmail: "ari-lp@e2e.test",
      counterpartyAddress: "9 place du Sample, 38000 Grenoble, France",
      items: INVOICE_ITEMS,
    })

    // A person records and verifies the customer's delivery address in the address book.
    const added = await api(s, `/api/contacts/${noaContact}/addresses`, {
      method: "POST",
      token,
      body: VERIFIED,
    })
    expect([200, 201], JSON.stringify(added.body)).toContain(added.status)
    const addressId = (unwrap(added.body) as { id?: string }).id
    expect(addressId, JSON.stringify(added.body)).toBeTruthy()
    const verified = await api(s, `/api/contacts/${noaContact}/addresses/${addressId}/verify`, {
      method: "POST",
      token,
      body: { source: "purchase_order", note: "Confirmed on the customer's purchase order" },
    })
    expect(verified.status, JSON.stringify(verified.body)).toBe(200)

    const noaKey = `so:${numericOrderId(gidNoa!)}`
    const ariKey = `so:${numericOrderId(gidAri!)}`

    // ── The screen, after the real order sync ──
    await loginAs(page, env, qa.admin.email, "12345678")
    await page.goto(`http://localhost:${env.ports[1]}/boxtal/queue/to_prepare`)
    await expect(page.getByTestId("boxtal-prep-grid-table")).toBeVisible({ timeout: 30_000 })
    await page.getByTestId("boxtal-prep-pull-orders").click()
    const rowNoa = page.getByTestId(`boxtal-prep-row-${noaKey}`)
    const rowAri = page.getByTestId(`boxtal-prep-row-${ariKey}`)
    await expect(rowAri).toHaveAttribute("data-state", "ready", { timeout: 60_000 })
    await expect(rowNoa).toBeVisible()

    // A normal customer: no chip, nothing held.
    await expect(page.getByTestId(`boxtal-prep-address-differs-${ariKey}`)).toHaveCount(0)
    await expect(page.getByTestId(`boxtal-prep-ship-${ariKey}`)).toBeEnabled()

    // The customer with a verified address elsewhere: held "Address differs".
    const chip = page.getByTestId(`boxtal-prep-address-differs-${noaKey}`)
    await expect(chip).toBeVisible({ timeout: 30_000 })
    await expect(chip).toContainText("Address differs")
    const shipNoa = page.getByTestId(`boxtal-prep-ship-${noaKey}`)
    await expect(shipNoa).toBeDisabled()
    expect(await shipNoa.getAttribute("title")).toContain("Pick which one to use")

    // The fold: both addresses side by side, the verified one says when and by whom.
    await chip.click()
    await expect(page.getByTestId(`boxtal-prep-address-fold-${noaKey}`)).toBeVisible()
    const orderSide = page.getByTestId(`boxtal-prep-address-order-${noaKey}`)
    const verifiedSide = page.getByTestId(`boxtal-prep-address-verified-${noaKey}`)
    await expect(orderSide).toContainText("Order address")
    await expect(orderSide).toContainText("5 rue du Test")
    await expect(orderSide).toContainText("69001 Lyon")
    await expect(verifiedSide).toContainText("Verified address")
    await expect(verifiedSide).toContainText("18 avenue de l'Exemple")
    await expect(verifiedSide).toContainText("69100 Villeurbanne")
    await expect(verifiedSide).toContainText(/Verified \d{4}-\d{2}-\d{2}/)

    // A person picks the verified address: the hold lifts.
    await page.getByTestId(`boxtal-prep-address-use-verified-${noaKey}`).click()
    await expect(chip).toContainText("Address differs: verified", { timeout: 30_000 })
    await expect(shipNoa).toBeEnabled({ timeout: 30_000 })

    // A person who may approve label purchases buys directly: the click is the decision.
    await resetMock(s, token)
    const noaClickedAt = new Date(Date.now() - 1_000)
    await shipNoa.click()
    await expect(rowNoa).toHaveCount(0, { timeout: 60_000 })
    const noaBuys = v3CreatePosts(await getRequests(s, token))
    expect(noaBuys).toHaveLength(1)
    // The label is for the PICKED (verified) address, not the order's.
    expect(noaBuys[0]!.body).toContain("18 avenue de l'Exemple")
    expect(noaBuys[0]!.body).toContain("69100")
    expect(noaBuys[0]!.body).not.toContain("5 rue du Test")
    expect(await approvalsSince(env, orgId, noaClickedAt)).toEqual([])

    // ── One label purchase asked by an agent: ONE approval, decided inline on the row ──
    // Approvals are for agents: a person's own click runs on their own scopes (above). The agent
    // asks with exactly what the row's Ship button would send.
    const listed = await toolPost(s, token, "boxtal", "prep_list", {})
    const ariRow = ((listed.body.rows ?? []) as ListedPrepRow[]).find((r) => r.order_key === ariKey)
    expect(ariRow, JSON.stringify(listed.body).slice(0, 2000)).toBeTruthy()
    const offer = ariRow!.quote.selected ?? ariRow!.quote.cheapest
    expect(offer, JSON.stringify(ariRow)).toBeTruthy()
    // The row's Ship parameters (prep-row-logic.ts shipParams): the price in MAJOR units (EUR).
    const params = {
      draft_id: ariRow!.document_ref,
      offer_code: offer!.offer_code,
      quoted_price_ttc: offer!.price_ttc_minor / 100,
      quoted_currency: offer!.currency,
      ...(ariRow!.recipient?.phone ? { recipient_phone: ariRow!.recipient.phone } : {}),
    }
    {
      await resetMock(s, token)
      const clickedAt = new Date(Date.now() - 1_000)
      const asked = await callToolAsAgent(s, token, "boxtal:create_shipment", params)
      expect(asked.status, JSON.stringify(asked.body)).toBe(200)
      const parked = await approvalsSince(env, orgId, clickedAt)
      expect(parked.map((x) => [x.toolName, x.status])).toEqual([
        ["boxtal:create_shipment", "pending"],
      ])
      // Nothing is bought before the decision.
      expect(v3CreatePosts(await getRequests(s, token))).toHaveLength(0)

      // The approver decides it on the row, with what is bought on the card.
      await page.reload()
      const approvalBlock = page.getByTestId(`boxtal-prep-ship-approval-${ariKey}`)
      await expect(approvalBlock).toBeVisible({ timeout: 30_000 })
      await page.getByTestId(`boxtal-prep-ship-approval-toggle-${ariKey}`).click()
      const card = page.getByTestId(`boxtal-prep-ship-approval-card-${ariKey}`)
      await expect(card).toBeVisible()
      await expect(card).toContainText("Grenoble")
      await page.getByTestId(`boxtal-prep-ship-approve-${ariKey}`).click()
      await expect
        .poll(async () => v3CreatePosts(await getRequests(s, token)).length, { timeout: 60_000 })
        .toBe(1)

      const shipments = (await env.db.sql.unsafe(
        `SELECT boxtal_order_id AS "orderId"
           FROM ${boxtalSchema(env)}.shipment
          WHERE org_id = $1 AND kind = 'outbound' AND created_at >= $2`,
        [orgId, clickedAt],
      )) as Array<{ orderId: string | null }>
      expect(shipments).toHaveLength(1)
      const boxtalOrderId = shipments[0]!.orderId
      expect(boxtalOrderId).toBeTruthy()

      // The label document arrives over the Boxtal webhook: what it sets off asks for nothing.
      expect(boxtal.webhookSecret).toBeTruthy()
      const hook = await dispatchBoxtalWebhook({
        serverUrl: s,
        orgId,
        endpoint: "document-created",
        body: { eventType: "DOCUMENT_CREATED", orderId: boxtalOrderId },
        secret: boxtal.webhookSecret as string,
      })
      expect(hook.status, JSON.stringify(hook.body)).toBeLessThan(300)

      // Exactly one approval for the whole purchase, approved: no proforma or fulfilment card.
      await expect
        .poll(
          async () =>
            (await approvalsSince(env, orgId, clickedAt)).map((x) => [x.toolName, x.status]),
          { timeout: 20_000 },
        )
        .toEqual([["boxtal:create_shipment", "approved"]])
      await page.waitForTimeout(3_000)
      expect(await approvalsSince(env, orgId, clickedAt)).toHaveLength(1)
      await expect(approvalBlock).toHaveCount(0)
    }
  })
})
