// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { viewRegistry } from "~/modules/apps/app-registries"
import { getDetailExternalLink, renderUrlTemplate } from "~/modules/apps/detail-external-link"

afterEach(() => {
  viewRegistry.clear()
})

describe("renderUrlTemplate", () => {
  it("substitutes {{id}} and named vars", () => {
    expect(
      renderUrlTemplate("https://x.com/{{shop}}/orders/{{id}}", {
        id: "123",
        shop: "fabrikam",
      }),
    ).toBe("https://x.com/fabrikam/orders/123")
  })

  it("collapses unknown vars to empty string", () => {
    expect(renderUrlTemplate("https://x.com/{{missing}}/{{id}}", { id: "9" })).toBe(
      "https://x.com//9",
    )
  })
})

describe("getDetailExternalLink", () => {
  it("returns rendered URL + default label when declared", () => {
    viewRegistry.set(["org-1", "shopify"], {
      detail: {
        order: {
          component: "OrderPanel",
          externalLink: {
            urlTemplate: "https://{{shop}}.myshopify.com/admin/orders/{{id}}",
          },
        },
      },
    })
    const link = getDetailExternalLink("org-1", "shopify", "order", "gid://shopify/Order/1", {
      shop: "fabrikam",
    })
    expect(link).toEqual({
      url: "https://fabrikam.myshopify.com/admin/orders/gid://shopify/Order/1",
      label: "Open in app ↗",
    })
  })

  it("honours a custom label when declared", () => {
    viewRegistry.set(["org-1", "shopify"], {
      detail: {
        product: {
          externalLink: {
            urlTemplate: "https://x.com/p/{{id}}",
            label: "View in Shopify",
          },
        },
      },
    })
    const link = getDetailExternalLink("org-1", "shopify", "product", "p_42")
    expect(link?.label).toBe("View in Shopify")
    expect(link?.url).toBe("https://x.com/p/p_42")
  })

  it("returns null when no view block is registered", () => {
    expect(getDetailExternalLink("org-1", "unknown-app", "x", "1")).toBeNull()
  })

  it("returns null when the entity has no externalLink", () => {
    viewRegistry.set(["org-1", "shopify"], { detail: { order: { component: "OrderPanel" } } })
    expect(getDetailExternalLink("org-1", "shopify", "order", "1")).toBeNull()
  })

  it("falls back to org '*' for kernel-scoped manifests", () => {
    viewRegistry.set(["*", "shopify"], {
      detail: {
        order: { externalLink: { urlTemplate: "https://x.com/{{id}}" } },
      },
    })
    const link = getDetailExternalLink("org-1", "shopify", "order", "1")
    expect(link?.url).toBe("https://x.com/1")
  })

  it("rejects rendered URLs that are not http(s)", () => {
    // Schema validation rejects non-http templates at install, but a malicious
    // extraVar could inject a different scheme — defence-in-depth.
    viewRegistry.set(["org-1", "evil"], {
      detail: {
        x: { externalLink: { urlTemplate: "https://x.com{{tail}}" } },
      },
    })
    const link = getDetailExternalLink("org-1", "evil", "x", "1", {
      tail: "; javascript:alert(1)",
    })
    // The rendered URL still starts with https — should NOT be rejected just because
    // it contains shady text. The check protects against the rare case where the
    // template head is variable.
    expect(link?.url).toBe("https://x.com; javascript:alert(1)")
  })

  it("rejects a template whose head is fully overridden to a non-http scheme", () => {
    viewRegistry.set(["org-1", "evil"], {
      detail: {
        x: { externalLink: { urlTemplate: "{{scheme}}://x.com/{{id}}" } },
      },
    })
    const link = getDetailExternalLink("org-1", "evil", "x", "1", { scheme: "javascript" })
    expect(link).toBeNull()
  })
})
