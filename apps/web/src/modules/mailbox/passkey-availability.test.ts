// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { DESKTOP_BRIDGE_KEY } from "~/lib/desktop-shell-contract"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { passkeysUsableHere } from "~/modules/mailbox/passkey-availability"

function browserWithWebAuthn(capabilities?: Record<string, boolean>) {
  vi.stubGlobal("navigator", { credentials: { get: vi.fn(), create: vi.fn() } })
  vi.stubGlobal(
    "PublicKeyCredential",
    capabilities ? { getClientCapabilities: async () => capabilities } : {},
  )
}

describe("passkeysUsableHere", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("is yes in a browser that reports PRF support", async () => {
    browserWithWebAuthn({ passkeyPlatformAuthenticator: true, "extension:prf": true })
    expect(await passkeysUsableHere()).toBe(true)
  })

  it("is no when the browser says it has no PRF", async () => {
    browserWithWebAuthn({ passkeyPlatformAuthenticator: true, "extension:prf": false })
    expect(await passkeysUsableHere()).toBe(false)
  })

  it("is yes in a browser with WebAuthn that cannot say what it supports", async () => {
    browserWithWebAuthn()
    expect(await passkeysUsableHere()).toBe(true)
  })

  it("is no without WebAuthn at all", async () => {
    vi.stubGlobal("PublicKeyCredential", undefined)
    expect(await passkeysUsableHere()).toBe(false)
  })

  it("is no in the desktop shell, whatever the webview claims", async () => {
    browserWithWebAuthn({ "extension:prf": true })
    vi.stubGlobal(DESKTOP_BRIDGE_KEY, { version: 1 })
    expect(await passkeysUsableHere()).toBe(false)
  })

  it("is no in the native mobile shell, whatever the webview claims", async () => {
    browserWithWebAuthn({ "extension:prf": true })
    vi.stubGlobal(NATIVE_BRIDGE_GLOBAL, {})
    expect(await passkeysUsableHere()).toBe(false)
  })
})
