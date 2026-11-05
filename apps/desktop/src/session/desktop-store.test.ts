// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { permissionMode, resetDesktopStore, setPermissionMode } from "./desktop-store"

describe("the desktop store's permission mode", () => {
  it("starts in Auto and returns to Auto on a reset", () => {
    expect(permissionMode()).toBe("auto")
    setPermissionMode("manual")
    expect(permissionMode()).toBe("manual")
    resetDesktopStore()
    expect(permissionMode()).toBe("auto")
  })
})
