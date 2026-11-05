// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
// The exports an installed app's bundle must carry (P2-20): the view tree's
// components keep the app out when missing; a settings page's custom blocks
// are collected on their own, so a missing one costs that block only.
import { describe, expect, it } from "vitest"
import {
  collectDeclaredComponentNames,
  collectSettingsBlockComponentNames,
} from "~/framework/manifest-exports"

const manifest = {
  name: "fixture",
  views: {
    tabTypes: { home: { component: "Home", icon: "HomeIcon" } },
    detail: { order: { component: "OrderDetail" } },
  },
  entities: { order: { cardComponent: "OrderCard" } },
  settings: {
    sections: [
      {
        id: "general",
        title: "General",
        scope: "org",
        blocks: [
          { block: "field", key: "a", type: "text", label: "A" },
          { block: "custom", component: "AdapterEditor", reason: "JSON editor" },
        ],
      },
      {
        id: "you",
        title: "You",
        scope: "user",
        blocks: [
          { block: "custom", component: "QuotaMeter", reason: "computed view" },
          { block: "custom", component: "AdapterEditor", reason: "same export twice" },
        ],
      },
    ],
  },
}

describe("manifest exports", () => {
  it("collects the view tree and entity components, nested detail views included", () => {
    expect(collectDeclaredComponentNames(manifest).sort()).toEqual([
      "Home",
      "OrderCard",
      "OrderDetail",
    ])
  })

  it("collects every settings custom block component once, apart from the required list", () => {
    expect(collectSettingsBlockComponentNames(manifest)).toEqual(["AdapterEditor", "QuotaMeter"])
    expect(collectDeclaredComponentNames(manifest)).not.toContain("AdapterEditor")
  })

  it("is empty for a manifest without settings", () => {
    expect(collectSettingsBlockComponentNames({ name: "x", views: {} })).toEqual([])
  })
})
