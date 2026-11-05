// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"

const originalMatchMedia = window.matchMedia

type Listener = () => void

function mockMatchMedia(
  matchesFor: (query: string) => boolean,
  subscriptions?: Array<{ query: string; listener: Listener }>,
) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matchesFor(query),
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) =>
        subscriptions?.push({ query, listener }),
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  })
  vi.resetModules()
})

describe("shell-tier", () => {
  it("resolves each tier from its own media query", async () => {
    mockMatchMedia((q) => q.includes("max-width: 639px"))
    vi.resetModules()
    const phone = await import("./shell-tier")
    expect(phone.resolveShellTier()).toBe("phone")
    expect(phone.shellTier()).toBe("phone")

    mockMatchMedia((q) => q.includes("min-width: 640px") && q.includes("max-width: 1023px"))
    vi.resetModules()
    const tablet = await import("./shell-tier")
    expect(tablet.shellTier()).toBe("tablet")

    mockMatchMedia((q) => q.includes("min-width: 1024px"))
    vi.resetModules()
    const desktop = await import("./shell-tier")
    expect(desktop.shellTier()).toBe("desktop")
  })

  it("a media query change republishes the tier", async () => {
    const subscriptions: Array<{ query: string; listener: Listener }> = []
    let tier: "desktop" | "tablet" | "phone" = "desktop"
    mockMatchMedia((q) => {
      if (q.includes("max-width: 639px")) return tier === "phone"
      if (q.includes("min-width: 1024px")) return tier === "desktop"
      return tier === "tablet"
    }, subscriptions)
    vi.resetModules()
    const mod = await import("./shell-tier")
    expect(mod.shellTier()).toBe("desktop")
    // One subscription per tier query, attached at import: the tier follows
    // the viewport without any component being mounted.
    expect(subscriptions).toHaveLength(3)

    tier = "phone"
    for (const { listener } of subscriptions) listener()

    expect(mod.shellTier()).toBe("phone")
  })
})
