// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify Orders list: a new paid order showed up, its invoice was issued a few
// seconds later by the invoicing app, and the row's Invoice column stayed "-"
// until a page reload. The links were fetched only when the set of order ids
// changed, and issuing an invoice does not change it. The list now refetches
// `orders_invoice_links` on `shopify:order`, which the app's invoicing
// subscriber emits (`order:invoice_changed`) for every invoicing document
// change. Renders the REAL list against the REAL host entity-change bus.
//
// The rows themselves had the same gap: the list is a tab that stays mounted,
// so an order placed while it was open (the demo's live order #1097) never
// showed until a reload. Every order change but the invoice relay now refetches
// the rows, keeping the current ones on screen meanwhile.

import type { HostServices } from "@liaison/host"
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { notifyEntityChange, onEntityChange } from "~/framework/entity-changes"
import { createStaleResource } from "~/primitives/createStaleResource"
import { ShopifyOrdersList } from "../../../../bundled-apps/shopify/src/ui/lists"

const ORDER = "gid://shopify/Order/1097"

/** What `orders_invoice_links` answers: nothing until the invoice is issued. */
let issued = false
let linkLoads = 0
/** Whether order #1097 was placed yet; orders_search answers without it until then. */
let placed = true
let searchLoads = 0

function installHost(): void {
  const host: Partial<HostServices> = {
    accessToken: () => "t",
    invokeTool: (async (_app: string, tool: string) => {
      if (tool === "orders_search") {
        searchLoads++
        return {
          results: [
            {
              id: "gid://shopify/Order/1096",
              entity: "order",
              title: "#1096",
              attributes: { financialStatus: "PAID", createdAt: new Date(0).toISOString() },
            },
            ...(placed
              ? [
                  {
                    id: ORDER,
                    entity: "order",
                    title: "#1097",
                    attributes: { financialStatus: "PAID", createdAt: new Date().toISOString() },
                  },
                ]
              : []),
          ],
          nextCursor: null,
        }
      }
      if (tool === "draft_orders_list") return { results: [], nextCursor: null }
      if (tool === "orders_invoice_links") {
        linkLoads++
        return {
          links: issued
            ? [
                {
                  order_id: ORDER,
                  invoice_id: "doc-23",
                  number: "INV-2026-0023",
                  type: "invoice",
                  scope: null,
                  status: "issued",
                  payment_status: "paid",
                },
              ]
            : [],
        }
      }
      return {}
    }) as HostServices["invokeTool"],
    createResource: (<T,>(fetcher: () => T | Promise<T>, opts?: { staleAfterMs?: number }) => {
      const res = createStaleResource<T>(fetcher, opts)
      return [res, { refetch: res.refetch, mutate: res.mutate }]
    }) as HostServices["createResource"],
    onEntityChange: (_callerApp, keys, cb, opts) => onEntityChange(keys, cb as never, opts),
  }
  ;(globalThis as unknown as { __liaisonHost: unknown }).__liaisonHost = host
  ;(globalThis as unknown as { __LIAISON_TEST_APP_NAME: string }).__LIAISON_TEST_APP_NAME =
    "shopify"
}

describe("Shopify Orders list: the Invoice column follows an invoice issued after the order", () => {
  beforeEach(() => {
    issued = false
    linkLoads = 0
    placed = true
    searchLoads = 0
    installHost()
  })
  afterEach(() => {
    ;(globalThis as unknown as { __liaisonHost?: unknown }).__liaisonHost = undefined
  })

  it("refetches orders_invoice_links on shopify:order and shows the new invoice", async () => {
    const { container } = render(() => <ShopifyOrdersList />)
    const pill = () => container.querySelector('[data-testid="shopify-order-invoice-link-doc-23"]')
    // Settle the first load: the row is shown and its links were fetched (empty).
    await waitFor(
      () => {
        expect(container.textContent).toContain("#1097")
        expect(linkLoads).toBeGreaterThan(0)
      },
      { timeout: 5000 },
    )
    await new Promise((r) => setTimeout(r, 50))
    const before = linkLoads
    expect(pill()).toBeNull()

    // The invoicing app issued the invoice; the shopify subscriber relayed it.
    issued = true
    notifyEntityChange({
      key: "shopify:order",
      app: "shopify",
      entity: "order",
      action: "invoice_changed",
      data: { document_id: "doc-23", number: "INV-2026-0023", document_action: "issued" },
    })

    await waitFor(() => expect(pill()?.textContent).toBe("INV-2026-0023"), { timeout: 5000 })
    expect(linkLoads).toBe(before + 1)
  })

  it("shows an order placed while the list is open, without reloading the page", async () => {
    placed = false
    const { container } = render(() => <ShopifyOrdersList />)
    const row = () => container.querySelector(`[data-testid="shopify-orders-row-${ORDER}"]`)
    await waitFor(() => expect(container.textContent).toContain("#1096"), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, 50))
    expect(row()).toBeNull()

    // The invoice relay alone moves the Invoice column, not the rows.
    const settled = searchLoads
    notifyEntityChange({
      key: "shopify:order",
      app: "shopify",
      entity: "order",
      action: "invoice_changed",
      data: { document_id: "doc-1", number: "INV-1", document_action: "issued" },
    })
    await new Promise((r) => setTimeout(r, 300))
    expect(searchLoads).toBe(settled)

    // The store's orders/create webhook landed: shopify:order created.
    placed = true
    notifyEntityChange({
      key: "shopify:order",
      app: "shopify",
      entity: "order",
      action: "created",
      data: { id: ORDER },
    })
    // The rows stay on screen while the list refetches: no "Loading…" flash.
    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector('[data-testid="shopify-orders-list-loading"]')).toBeNull()
    await waitFor(() => expect(row()).not.toBeNull(), { timeout: 5000 })
    expect(container.textContent).toContain("#1096")
  })
})
