// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { createDirectBridge } from "../../../../packages/app-ui/src/ctx-direct"

describe("ctx-direct bridge", () => {
  it("openTab calls the provided tab store function", () => {
    const openTab = vi.fn()
    const bridge = createDirectBridge({ openTab, closeTab: vi.fn(), showToast: vi.fn() })
    bridge.openTab("contact-detail", "c123", "Alice")
    expect(openTab).toHaveBeenCalledWith("contact-detail", "c123", "Alice")
  })

  it("showToast calls the provided toast function", () => {
    const showToast = vi.fn()
    const bridge = createDirectBridge({ openTab: vi.fn(), closeTab: vi.fn(), showToast })
    bridge.showToast("Saved!", "success")
    expect(showToast).toHaveBeenCalledWith("Saved!", "success")
  })

  it("closeTab calls the provided closeTab function", () => {
    const closeTab = vi.fn()
    const bridge = createDirectBridge({ openTab: vi.fn(), closeTab, showToast: vi.fn() })
    bridge.closeTab()
    expect(closeTab).toHaveBeenCalledOnce()
  })
})
