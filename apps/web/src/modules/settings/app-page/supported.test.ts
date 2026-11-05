// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import { hasUnsupportedSettings, isSupportedFieldType, isSupportedSettingsBlock } from "./supported"

describe("what this build can draw of a settings page", () => {
  it("knows its blocks and field types, and nothing else", () => {
    for (const block of ["connections", "list", "tree", "custom"]) {
      expect(isSupportedSettingsBlock({ block })).toBe(true)
    }
    expect(isSupportedSettingsBlock({ block: "field", type: "toggle" })).toBe(true)
    expect(isSupportedSettingsBlock({ block: "field", type: "color" })).toBe(false)
    expect(isSupportedSettingsBlock({ block: "gallery" })).toBe(false)
    expect(isSupportedSettingsBlock(null)).toBe(false)
    expect(isSupportedFieldType("schedule")).toBe(true)
    expect(isSupportedFieldType("color")).toBe(false)
  })

  it("flags a manifest whose settings use anything it cannot draw", () => {
    const page = (blocks: unknown[]) => ({ settings: { sections: [{ id: "s", blocks }] } })
    expect(hasUnsupportedSettings(page([{ block: "field", type: "text" }]))).toBe(false)
    expect(hasUnsupportedSettings(page([{ block: "gallery" }]))).toBe(true)
    expect(hasUnsupportedSettings({ name: "no-settings" })).toBe(false)
  })
})
