// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest"
import { clearCompatMode, compatModeApps, compatModeKey, noteCompatMode } from "./compat-mode"

afterEach(() => clearCompatMode())

describe("apps in compatibility mode", () => {
  it("keeps one entry per app and reason, in a stable order, keyed by apps and versions", () => {
    noteCompatMode({ app: "shopify", reason: "settings", serverVersion: "2.0.0" })
    noteCompatMode({ app: "boxtal", reason: "settings", serverVersion: "0.15.0" })
    noteCompatMode({ app: "boxtal", reason: "settings", serverVersion: "0.15.1" })
    expect(compatModeKey(compatModeApps())).toBe("boxtal@0.15.1:settings,shopify@2.0.0:settings")
    clearCompatMode("boxtal")
    expect(compatModeApps().map((e) => e.app)).toEqual(["shopify"])
  })
})
