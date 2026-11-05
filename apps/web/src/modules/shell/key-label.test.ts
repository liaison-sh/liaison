// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { formatKeyLabel, isMacPlatform } from "~/modules/shell/key-label"

function withNavigator(nav: unknown, run: () => void) {
  vi.stubGlobal("navigator", nav)
  try {
    run()
  } finally {
    vi.unstubAllGlobals()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("isMacPlatform", () => {
  // Chromium reports "macOS", not "Mac": the palette and the shortcuts overlay
  // printed "Ctrl + P" on a Mac in Chrome, Edge and Arc.
  it("reads the Chromium platform string", () => {
    withNavigator({ userAgentData: { platform: "macOS" }, userAgent: "" }, () => {
      expect(isMacPlatform()).toBe(true)
    })
  })

  it("reads the legacy platform string", () => {
    withNavigator({ userAgentData: { platform: "Mac" }, userAgent: "" }, () => {
      expect(isMacPlatform()).toBe(true)
    })
  })

  it("stays false on Windows and Linux", () => {
    withNavigator({ userAgentData: { platform: "Windows" }, userAgent: "" }, () => {
      expect(isMacPlatform()).toBe(false)
    })
    withNavigator({ userAgentData: { platform: "Linux" }, userAgent: "" }, () => {
      expect(isMacPlatform()).toBe(false)
    })
  })

  it("falls back to the user agent when no platform is exposed", () => {
    withNavigator({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" }, () => {
      expect(isMacPlatform()).toBe(true)
    })
    withNavigator({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }, () => {
      expect(isMacPlatform()).toBe(true)
    })
    withNavigator({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, () => {
      expect(isMacPlatform()).toBe(false)
    })
  })

  // An empty or unknown platform string is not a verdict: the user agent still
  // knows, and a Mac that answered "" used to print Ctrl.
  it("still asks the user agent when the platform string names nothing known", () => {
    withNavigator(
      { userAgentData: { platform: "" }, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" },
      () => {
        expect(isMacPlatform()).toBe(true)
      },
    )
  })
})

describe("formatKeyLabel", () => {
  it("prints the Mac keycaps when the Chromium platform is macOS", () => {
    withNavigator({ userAgentData: { platform: "macOS" }, userAgent: "" }, () => {
      expect(formatKeyLabel("mod+p")).toBe("⌘ + P")
      expect(formatKeyLabel("mod+shift+t")).toBe("⌘ + ⇧ + T")
    })
  })

  it("prints Ctrl elsewhere", () => {
    withNavigator({ userAgentData: { platform: "Windows" }, userAgent: "" }, () => {
      expect(formatKeyLabel("mod+p")).toBe("Ctrl + P")
    })
  })
})
