// SPDX-License-Identifier: FSL-1.1-ALv2
// fix2-F3: isRealBrowser's `Capacitor` global check, proven alone. The
// Capacitor webview is normally caught first by the native bridge
// (`isNativeShell`), which made the `g.Capacitor` line untested: deleting it
// broke nothing. Here the native-bridge check is stubbed to "no bridge" (a
// bridge published late), so only the Capacitor global marks the shell.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/lib/native-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/native-bridge")>()),
  isNativeShell: () => false,
}))

import { isRealBrowser } from "./browser-push"

beforeEach(() => {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register: vi.fn(), ready: Promise.resolve(null) },
  })
  vi.stubGlobal("PushManager", function PushManager() {})
  vi.stubGlobal("Notification", function Notification() {})
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (navigator as unknown as Record<string, unknown>).serviceWorker
  delete (globalThis as Record<string, unknown>).Capacitor
})

describe("isRealBrowser, Capacitor global (A12)", () => {
  it("a real browser qualifies with the native-bridge check stubbed out", () => {
    expect(isRealBrowser()).toBe(true)
  })

  it("the Capacitor global alone keeps the phone webview out", () => {
    ;(globalThis as Record<string, unknown>).Capacitor = { isNativePlatform: () => true }
    expect(isRealBrowser()).toBe(false)
  })
})
