// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { OfflineBanner } from "~/modules/shell/OfflineBanner"
import { PHONE_QUERY, syncShellTier, TABLET_QUERY } from "~/modules/shell/shell-tier"

/** Pins the tier by answering matchMedia for one query only. */
function setTier(query: string | null): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({
      matches: query !== null && q === query,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  })
  syncShellTier()
}

function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, "onLine", { value, configurable: true })
}

beforeEach(() => {
  setOnLine(true)
})

afterEach(() => {
  cleanup()
  delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  setTier(null)
  setOnLine(true)
})

describe("the offline banner", () => {
  it("says nothing while the device is online", () => {
    setTier(PHONE_QUERY)
    render(() => <OfflineBanner />)
    expect(screen.queryByTestId("offline-banner")).toBeNull()
  })

  it("names the state and warns the content is old, at phone tier", () => {
    setTier(PHONE_QUERY)
    setOnLine(false)
    render(() => <OfflineBanner />)
    const banner = screen.getByTestId("offline-banner")
    expect(banner.textContent).toBe("You are offline. Showing what was last loaded.")
    expect(banner.getAttribute("role")).toBe("status")
  })

  it("shows at tablet tier too", () => {
    setTier(TABLET_QUERY)
    setOnLine(false)
    render(() => <OfflineBanner />)
    expect(screen.queryByTestId("offline-banner")).not.toBeNull()
  })

  it("never shows on desktop, where the browser chrome already says it", () => {
    setTier(null)
    setOnLine(false)
    render(() => <OfflineBanner />)
    expect(screen.queryByTestId("offline-banner")).toBeNull()
  })

  it("appears and disappears with the connection", () => {
    setTier(PHONE_QUERY)
    render(() => <OfflineBanner />)
    expect(screen.queryByTestId("offline-banner")).toBeNull()
    window.dispatchEvent(new Event("offline"))
    expect(screen.queryByTestId("offline-banner")).not.toBeNull()
    window.dispatchEvent(new Event("online"))
    expect(screen.queryByTestId("offline-banner")).toBeNull()
  })

  it("follows the shell's connectivity rather than the browser's, under a shell", () => {
    setTier(PHONE_QUERY)
    const box: { push: ((online: boolean) => void) | null } = { push: null }
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      onConnectivity: (handler: (online: boolean) => void) => {
        box.push = handler
        return () => {}
      },
    }
    render(() => <OfflineBanner />)
    // navigator.onLine still says online: the platform knows better.
    expect(navigator.onLine).toBe(true)
    box.push?.(false)
    expect(screen.queryByTestId("offline-banner")).not.toBeNull()
    box.push?.(true)
    expect(screen.queryByTestId("offline-banner")).toBeNull()
  })
})
