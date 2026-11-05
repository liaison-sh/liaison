// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"

describe("views.detail.<entity> consumer (Phase 16.6 — M3)", () => {
  beforeEach(async () => {
    const { resetRegistry } = await import("~/framework/app-registry")
    resetRegistry()
  })

  it("registers each detail entity as a panel under namespaceRegistryKey(appName, 'detail:' + entity)", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { getEntityExternalLink, getPanel, namespaceRegistryKey } = await import(
      "~/framework/app-registry"
    )
    const OrderPanel = () => null
    registerAppFromManifest(
      {
        name: "shopify",
        views: {
          detail: {
            order: {
              component: "OrderPanel",
              externalLink: { urlTemplate: "x", label: "Open" },
            },
          },
        },
      },
      { OrderPanel },
    )
    const panel = getPanel(namespaceRegistryKey("shopify", "detail:order"))
    expect(panel).toBeDefined()
    expect(panel?.appId).toBe("shopify")
    // A component-backed entity that also declares an externalLink registers in
    // the external-link registry too (the label is used for the Open action).
    expect(getEntityExternalLink("shopify", "order")?.label).toBe("Open")
  })

  it("registers an external-only entity in the external-link registry (no panel)", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { getEntityExternalLink, getPanel, namespaceRegistryKey } = await import(
      "~/framework/app-registry"
    )
    registerAppFromManifest(
      {
        name: "shopify",
        views: {
          detail: {
            metafield: { externalLink: { urlTemplate: "x", label: "y" } },
          },
        },
      },
      {},
    )
    // Component-less: NOT an in-app panel, but IS an external-link so openEntity
    // opens the deep link instead of a broken "unknown tab type" tab.
    expect(getPanel(namespaceRegistryKey("shopify", "detail:metafield"))).toBeUndefined()
    expect(getEntityExternalLink("shopify", "metafield")?.label).toBe("y")
  })

  it("does not register an external link for a component-only detail entity", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { getEntityExternalLink } = await import("~/framework/app-registry")
    const Panel = () => null
    registerAppFromManifest(
      {
        name: "shopify",
        views: { detail: { widget: { component: "Panel" } } },
      },
      { Panel },
    )
    expect(getEntityExternalLink("shopify", "widget")).toBeUndefined()
  })

  it("missing component export throws at register time", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    expect(() =>
      registerAppFromManifest(
        {
          name: "shopify",
          views: {
            detail: {
              x: { component: "Missing", externalLink: { urlTemplate: "x", label: "y" } },
            },
          },
        },
        {},
      ),
    ).toThrow(/Missing/)
  })
})
