// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  hasUnusableSettings,
  isSupportedFieldType,
  isSupportedSettingsBlock,
  settingsBlockFallback,
} from "./supported"

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

  it("flags a manifest whose settings use anything it cannot draw and gives no fallback for", () => {
    const page = (blocks: unknown[]) => ({ settings: { sections: [{ id: "s", blocks }] } })
    const fallback = { text: "Set it on the web.", href: "#s" }
    expect(hasUnusableSettings(page([{ block: "field", type: "text" }]))).toBe(false)
    expect(hasUnusableSettings(page([{ block: "gallery" }]))).toBe(true)
    expect(hasUnusableSettings({ name: "no-settings" })).toBe(false)
    // An unknown part with a fallback is usable: the fallback is drawn.
    expect(hasUnusableSettings(page([{ block: "gallery", fallback }]))).toBe(false)
    expect(
      hasUnusableSettings(page([{ block: "field", type: "color", label: "C", fallback }])),
    ).toBe(false)
    // A malformed fallback counts as none.
    expect(
      hasUnusableSettings(page([{ block: "gallery", fallback: { text: "x", href: "https://x" } }])),
    ).toBe(true)
    // One unusable part is enough.
    expect(hasUnusableSettings(page([{ block: "gallery", fallback }, { block: "carousel" }]))).toBe(
      true,
    )
  })

  it("reads a block's fallback defensively", () => {
    expect(settingsBlockFallback({ block: "x", fallback: { text: "Hi" } })).toEqual({ text: "Hi" })
    expect(settingsBlockFallback({ block: "x", fallback: { text: "Hi", href: "/p" } })).toEqual({
      text: "Hi",
      href: "/p",
    })
    for (const fallback of [
      undefined,
      null,
      "Hi",
      { text: "" },
      { text: "x".repeat(281) },
      { text: 3 },
      { text: "Hi", href: "https://x" },
      { text: "Hi", href: "//x" },
      { text: "Hi", href: "p" },
      { text: "Hi", href: 4 },
    ]) {
      expect(settingsBlockFallback({ block: "x", fallback })).toBeNull()
    }
    expect(settingsBlockFallback(null)).toBeNull()
  })
})
