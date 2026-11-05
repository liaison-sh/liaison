// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it, vi } from "vitest"
import { NATIVE_BRIDGE_GLOBAL } from "~/lib/native-bridge"
import { appLink, canShare, share, shareFallbackText } from "~/lib/share"

const SERVER_ADDRESS_GLOBAL = "__LIAISON_SERVER_ADDRESS__"

function abortError(): Error {
  const error = new Error("Share canceled")
  error.name = "AbortError"
  return error
}

function setNavigatorShare(value: unknown): void {
  Object.defineProperty(navigator, "share", { value, configurable: true, writable: true })
}

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true })
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
  delete (globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
  setNavigatorShare(undefined)
  setClipboard(undefined)
})

describe("what can share", () => {
  it("is nothing on a page with no sheet and no clipboard", () => {
    expect(canShare()).toBe(false)
  })

  it("is the shell's sheet, the browser's, or the clipboard", () => {
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = { share: vi.fn() }
    expect(canShare()).toBe(true)
    delete (globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL]
    setNavigatorShare(vi.fn())
    expect(canShare()).toBe(true)
    setNavigatorShare(undefined)
    setClipboard({ writeText: vi.fn() })
    expect(canShare()).toBe(true)
  })
})

describe("the share chain", () => {
  it("prefers the shell's sheet over the browser's", async () => {
    const nativeShare = vi.fn(async () => {})
    const webShare = vi.fn(async () => {})
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = { share: nativeShare }
    setNavigatorShare(webShare)

    await expect(share({ url: "https://example.com/t/1" })).resolves.toBe("shared")
    expect(nativeShare).toHaveBeenCalledTimes(1)
    expect(webShare).not.toHaveBeenCalled()
  })

  it("falls back to navigator.share with no shell", async () => {
    const webShare = vi.fn(async () => {})
    setNavigatorShare(webShare)
    await expect(share({ title: "T", url: "https://example.com/t/1" })).resolves.toBe("shared")
    expect(webShare).toHaveBeenCalledWith({
      title: "T",
      text: undefined,
      url: "https://example.com/t/1",
    })
  })

  it("falls back to the clipboard with no sheet at all", async () => {
    const writeText = vi.fn(async () => {})
    setClipboard({ writeText })
    await expect(share({ url: "https://example.com/t/1" })).resolves.toBe("copied")
    expect(writeText).toHaveBeenCalledWith("https://example.com/t/1")
  })

  it("STOPS on a cancel rather than copying a link the user declined to send", async () => {
    const writeText = vi.fn(async () => {})
    setClipboard({ writeText })
    setNavigatorShare(
      vi.fn(async () => {
        throw abortError()
      }),
    )
    await expect(share({ url: "https://example.com/t/1" })).resolves.toBe("cancelled")
    expect(writeText).not.toHaveBeenCalled()
  })

  it("moves past a shell whose plugin simply is not there", async () => {
    const webShare = vi.fn(async () => {})
    ;(globalThis as Record<string, unknown>)[NATIVE_BRIDGE_GLOBAL] = {
      share: async () => {
        throw new Error("Share plugin not implemented")
      },
    }
    setNavigatorShare(webShare)
    await expect(share({ url: "https://example.com/t/1" })).resolves.toBe("shared")
    expect(webShare).toHaveBeenCalledTimes(1)
  })

  it("reports unavailable when every route is gone", async () => {
    await expect(share({ url: "https://example.com/t/1" })).resolves.toBe("unavailable")
  })

  it("copies the link, then the text, then the title", () => {
    expect(shareFallbackText({ title: "T", text: "X", url: "U" })).toBe("U")
    expect(shareFallbackText({ title: "T", text: "X" })).toBe("X")
    expect(shareFallbackText({ title: "T" })).toBe("T")
    expect(shareFallbackText({})).toBe("")
  })
})

describe("the link a share carries", () => {
  it("is built on the deployment's origin under a shell, never capacitor://", () => {
    ;(globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] =
      "https://liaison.fabrikam.example"
    expect(appLink("/tickets/abc")).toBe("https://liaison.fabrikam.example/tickets/abc")
  })

  it("is built on the page's own origin in a browser", () => {
    expect(appLink("/tickets/abc")).toBe(`${window.location.origin}/tickets/abc`)
  })

  it("tolerates a path given without its leading slash", () => {
    ;(globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] = "https://acme.example.com"
    expect(appLink("tickets/abc")).toBe("https://acme.example.com/tickets/abc")
  })
})
