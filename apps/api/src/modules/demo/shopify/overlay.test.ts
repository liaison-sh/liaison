// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The write overlay is a public box's memory, so its bounds are the point.
import { afterEach, describe, expect, it } from "bun:test"
import {
  DemoOverlayFullError,
  DemoShopifyOverlayTestAccess,
  hasOverlay,
  orderPatch,
  resetDemoShopifyOverlay,
} from "./overlay"

afterEach(() => resetDemoShopifyOverlay())

describe("the demo store's write overlay", () => {
  it("holds nothing until something is written", () => {
    expect(hasOverlay("org-a")).toBe(false)
    orderPatch("org-a", "gid://shopify/Order/1").tags = ["x"]
    expect(hasOverlay("org-a")).toBe(true)
  })

  it("refuses a further record once an org hits its cap, rather than growing", () => {
    for (let i = 0; i < DemoShopifyOverlayTestAccess.maxRecordsPerOrg; i++) {
      orderPatch("org-b", `gid://shopify/Order/${i}`).note = "n"
    }
    expect(() => orderPatch("org-b", "gid://shopify/Order/overflow")).toThrow(DemoOverlayFullError)
    // An org already at the cap can still amend what it has written.
    expect(() => orderPatch("org-b", "gid://shopify/Order/1")).not.toThrow()
  })

  it("drops the least recently written org rather than remembering every visitor", () => {
    for (let i = 0; i < DemoShopifyOverlayTestAccess.maxOrgs + 10; i++) {
      orderPatch(`org-${i}`, "gid://shopify/Order/1").note = "n"
    }
    expect(DemoShopifyOverlayTestAccess.stats().orgs).toBe(DemoShopifyOverlayTestAccess.maxOrgs)
    expect(hasOverlay("org-0")).toBe(false)
    expect(hasOverlay(`org-${DemoShopifyOverlayTestAccess.maxOrgs + 9}`)).toBe(true)
  })

  it("a re-seed of one org puts that store back without touching another's", () => {
    orderPatch("org-x", "gid://shopify/Order/1").note = "n"
    orderPatch("org-y", "gid://shopify/Order/1").note = "n"
    resetDemoShopifyOverlay("org-x")
    expect(hasOverlay("org-x")).toBe(false)
    expect(hasOverlay("org-y")).toBe(true)
  })
})
