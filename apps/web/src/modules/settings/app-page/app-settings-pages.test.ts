// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
// An app's UI export bag is an ES module namespace for an in-tree app (sealed,
// null prototype) or the isolated frame's proxy: the registry must hand it back
// untouched, never wrap it in a store proxy (a sealed object cannot take one,
// and the whole settings page crashed on it).
import { afterEach, describe, expect, it } from "vitest"
import {
  appSettingsPage,
  appSettingsPages,
  registerAppSettingsPage,
  resetAppSettingsPages,
} from "./app-settings-pages"

afterEach(() => resetAppSettingsPages())

describe("app settings pages registry", () => {
  it("keeps a sealed, null-prototype export bag as it is", () => {
    const Block = () => null
    const exports = Object.freeze(Object.assign(Object.create(null), { Block })) as Record<
      string,
      unknown
    >
    registerAppSettingsPage({
      appId: "sealed",
      manifest: { name: "sealed", settings: { sections: [] } },
      exports,
    })
    const entry = appSettingsPage("sealed")
    expect(entry?.exports).toBe(exports)
    expect(entry?.exports?.Block).toBe(Block)
    expect(appSettingsPages().map((p) => p.appId)).toEqual(["sealed"])
  })
})
