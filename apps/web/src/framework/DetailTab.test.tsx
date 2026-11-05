// SPDX-License-Identifier: FSL-1.1-ALv2

import type { HostServices } from "@liaison/host"
import { render } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getPanel, registerPanel, resetRegistry } from "~/framework/app-registry"
import { DetailTab } from "~/framework/DetailTab"
// Import the REAL Shopify detail panels (the public bundle consumes only
// `@liaison/host`, which apps/web also depends on). Rendering the genuine
// panel — not a stub — is what makes these CLUSTER 7 regression guards: the
// href, the decoded id, and the bridge-resolved shop all flow through the
// production component, so the same bugs the deep review found re-fail the test.
import { ProductPanel, RefundPanel } from "../../../../bundled-apps/shopify/src/ui/panels"

// ─────────────────────────────────────────────────────────────────────────
// Mock host bridge. Panels resolve the real store via `home_load` and their
// content via the entity read tool — both go through `globalThis.__liaisonHost`.
// ─────────────────────────────────────────────────────────────────────────
function installMockHost(
  toolResponses: Record<string, (args: Record<string, unknown>) => unknown>,
): { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn(
    async (_app: string, tool: string, args: Record<string, unknown>) =>
      toolResponses[tool]?.(args) ?? {},
  )
  const host = {
    fetch: vi.fn(async () => ({})),
    invokeTool: invoke,
    openConnect: vi.fn(async () => {}),
    accessToken: () => "tok",
    // The real panels now go through `app.createResource` (A4 migration —
    // resync-aware resource factory). This mock host needs to provide SOME
    // implementation or the plugin crashes with "host.createResource is not
    // available". A plain SolidJS createResource is enough for these render
    // guards — they don't exercise resync/stale-tab revalidation.
    createResource: ((fetcher: () => unknown) => {
      const [res, actions] = createResource(fetcher)
      return [res, actions]
    }) as unknown as HostServices["createResource"],
  } as unknown as HostServices
  ;(globalThis as unknown as { __liaisonHost: HostServices }).__liaisonHost = host
  ;(globalThis as unknown as { __LIAISON_TEST_APP_NAME: string }).__LIAISON_TEST_APP_NAME =
    "shopify"
  return { invoke }
}

afterEach(() => {
  delete (globalThis as unknown as { __liaisonHost?: HostServices }).__liaisonHost
  delete (globalThis as unknown as { __LIAISON_TEST_APP_NAME?: string }).__LIAISON_TEST_APP_NAME
})

describe("DetailTab", () => {
  beforeEach(() => resetRegistry())

  it("parses entityId '<appName>/<entity>/<id>' and mounts the registered panel", () => {
    registerPanel("shopify:detail:order", {
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      component: ((props: any) => <div data-testid="mounted">id={props.id}</div>) as never,
      icon: undefined,
      label: "Order",
      appId: "shopify",
      localType: "detail:order",
    })
    const { container } = render(() => <DetailTab entityId="shopify/order/1001" />)
    expect(container.textContent).toMatch(/id=1001/)
  })

  it("renders not-found fallback when panel registry lookup misses", () => {
    const { container } = render(() => <DetailTab entityId="shopify/missing/x" />)
    expect(container.textContent).toMatch(/not found/i)
  })

  it("renders invalid fallback when entityId is malformed", () => {
    const { container } = render(() => <DetailTab entityId="garbage" />)
    expect(container.textContent).toMatch(/invalid entityId/i)
  })

  // CLUSTER 7.2 — the link builders percent-encode the GID (it contains `:` and
  // `/`). DetailTab must decodeURIComponent it before the panel's read tool
  // sees it, or the GraphQL `ID!` scalar rejects the still-encoded value.
  it("decodes the percent-encoded GID before handing it to the panel", () => {
    let received: string | undefined
    registerPanel("shopify:detail:order", {
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      component: ((props: any) => {
        received = props.id
        return <div data-testid="mounted">{props.id}</div>
      }) as never,
      icon: undefined,
      label: "Order",
      appId: "shopify",
      localType: "detail:order",
    })
    const gid = "gid://shopify/Order/1001"
    render(() => <DetailTab entityId={`shopify/order/${encodeURIComponent(gid)}`} />)
    expect(received).toBe(gid)
  })

  // CLUSTER 7.3 — a refund detail entity carries both its parent orderId and
  // its own id, encoded as "<orderId>:<refundId>". DetailTab splits + decodes.
  it("splits a composite refund entityId into decoded { id, orderId }", () => {
    let received: { id?: string; orderId?: string } = {}
    registerPanel("shopify:detail:refund", {
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      component: ((props: any) => {
        received = { id: props.id, orderId: props.orderId }
        return <div data-testid="mounted">{props.id}</div>
      }) as never,
      icon: undefined,
      label: "Refund",
      appId: "shopify",
      localType: "detail:refund",
    })
    const orderGid = "gid://shopify/Order/9001"
    const refundGid = "gid://shopify/Refund/rf3"
    const composite = `${encodeURIComponent(orderGid)}:${encodeURIComponent(refundGid)}`
    render(() => <DetailTab entityId={`shopify/refund/${composite}`} />)
    expect(received.orderId).toBe(orderGid)
    expect(received.id).toBe(refundGid)
  })

  // CLUSTER 7.1 — DetailTab must NOT pass the literal app name as `shop`.
  it("does not pass the literal app name 'shopify' as the panel shop prop", () => {
    let received: { shop?: string } = {}
    registerPanel("shopify:detail:order", {
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      component: ((props: any) => {
        received = { shop: props.shop }
        return <div data-testid="mounted" />
      }) as never,
      icon: undefined,
      label: "Order",
      appId: "shopify",
      localType: "detail:order",
    })
    render(() => <DetailTab entityId="shopify/order/1001" />)
    expect(received.shop).not.toBe("shopify")
  })
})

// ─────────────────────────────────────────────────────────────────────────
// High-fidelity render: a REAL Shopify panel mounted through DetailTab, with a
// stubbed read tool. Asserts (a) content renders (not the loading/error
// fallback), and (b) the external href points at the REAL store domain.
// (Orders no longer have an in-app detail panel — order clicks open the
// Shopify admin page directly — so the product panel carries these guards.)
// ─────────────────────────────────────────────────────────────────────────
describe("DetailTab + real Shopify panels (CLUSTER 7 render guards)", () => {
  beforeEach(() => resetRegistry())

  it("renders ProductPanel content + an Open-in-Shopify href on the REAL store domain", async () => {
    installMockHost({
      // Resolves connection.shopDomain → drives the {{shop}} subdomain.
      home_load: () => ({ connection: { shopDomain: "acme.myshopify.com" } }),
      // Pre-baked product so the panel renders content, not the loading state.
      products_get: () => ({
        title: "Fabrikam controller",
        variants: [{ id: "v1", title: "Default", price: "120.00", inventoryQuantity: 3 }],
      }),
    })
    registerPanel("shopify:detail:product", {
      component: ProductPanel as never,
      icon: undefined,
      label: "Product",
      appId: "shopify",
      localType: "detail:product",
    })

    const gid = "gid://shopify/Product/1001"
    const { findByTestId } = render(() => (
      <DetailTab entityId={`shopify/product/${encodeURIComponent(gid)}`} />
    ))

    // Content rendered — variants, not the loading/error fallback.
    const variants = await findByTestId("product-variants")
    expect(variants.textContent).toContain("Default")

    // External link points at the real store, with the DECODED gid.
    const link = await findByTestId("open-in-shopify")
    const href = link.getAttribute("href") ?? ""
    expect(href).toContain("acme.myshopify.com/admin/products/")
    expect(href).not.toContain("shopify.myshopify.com/admin")
    expect(href).toContain(gid)
    expect(href).not.toContain("%3A%2F%2F") // not the still-encoded form
  })

  it("registry wires the real ProductPanel under the namespaced detail key", () => {
    registerPanel("shopify:detail:product", {
      component: ProductPanel as never,
      icon: undefined,
      label: "Product",
      appId: "shopify",
      localType: "detail:product",
    })
    expect(getPanel("shopify:detail:product")?.component).toBe(ProductPanel)
  })

  it("renders RefundPanel without crashing when orderId is absent (graceful deep link)", async () => {
    installMockHost({
      home_load: () => ({ connection: { shopDomain: "acme.myshopify.com" } }),
      refunds_get: () => ({
        totalPrice: { amount: "10.00", currencyCode: "EUR" },
        transactions: [{ kind: "refund", amount: "10.00", currency: "EUR" }],
      }),
    })
    registerPanel("shopify:detail:refund", {
      component: RefundPanel as never,
      icon: undefined,
      label: "Refund",
      appId: "shopify",
      localType: "detail:refund",
    })

    // Deep link with NO composite orderId — DetailTab passes orderId=undefined.
    const refundGid = "gid://shopify/Refund/rf3"
    const { findByTestId } = render(() => (
      <DetailTab entityId={`shopify/refund/${encodeURIComponent(refundGid)}`} />
    ))

    // Renders content (the link degrades to the order-agnostic refund path
    // instead of throwing and tripping the mount-error boundary).
    const link = await findByTestId("open-in-shopify")
    const href = link.getAttribute("href") ?? ""
    expect(href).toContain("acme.myshopify.com/admin/refunds/")
    expect(href).not.toContain("{{")
  })
})
