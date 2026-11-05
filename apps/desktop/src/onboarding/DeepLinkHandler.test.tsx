// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"

let emitDeepLink: ((url: string) => void) | null = null
const listen = vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
  if (event === "liaison-deep-link") emitDeepLink = (url) => handler({ payload: url })
  return () => undefined
})
let launchLinks: unknown = null
const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
  if (command === "plugin:deep-link|get_current") return launchLinks
  return undefined
})

vi.mock("../tauri", () => ({ invoke, listen }))

/** The module subscribes on import, so every test needs its own instance. */
async function freshModule() {
  vi.resetModules()
  listen.mockClear()
  invoke.mockClear()
  emitDeepLink = null
  const module = await import("./DeepLinkHandler")
  // The subscription is a promise the module started; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0))
  return module
}

describe("DeepLinkHandler", () => {
  it("extracts the server query parameter", async () => {
    const { parseConnectLink } = await freshModule()
    expect(parseConnectLink("liaison://connect?server=https://acme.example.com")).toBe(
      "https://acme.example.com",
    )
    expect(parseConnectLink("liaison://connect")).toBeNull()
    expect(parseConnectLink("not a link")).toBeNull()
  })

  it("subscribes to the documented deep link event on import", async () => {
    await freshModule()
    expect(listen.mock.calls.map((call) => call[0])).toContain("liaison-deep-link")
  })

  // On Windows and Linux the plugin emits the launch URL while it is being set
  // up, before the shell's listener exists, so the page has to ask for it.
  it("pulls the link the app was launched with, on import, through the plugin", async () => {
    launchLinks = ["liaison://connect?server=https://box.example.com"]
    try {
      const { connectDeepLinkAddress, pendingDeepLink } = await freshModule()
      expect(invoke.mock.calls.map((call) => call[0])).toContain("plugin:deep-link|get_current")
      expect(pendingDeepLink()).toBe("liaison://connect?server=https://box.example.com")
      expect(connectDeepLinkAddress()).toBe("https://box.example.com")
    } finally {
      launchLinks = null
    }
  })

  it("applies the same rule to a launch link as to a forwarded one", async () => {
    launchLinks = ["liaison://connect?server=javascript:alert(1)", "not a link", 42]
    try {
      const { connectDeepLinkAddress } = await freshModule()
      expect(connectDeepLinkAddress()).toBeNull()
    } finally {
      launchLinks = null
    }
  })

  it("proposes a link once when both delivery paths carry it, and again when it is opened again", async () => {
    launchLinks = ["liaison://connect?server=https://box.example.com"]
    try {
      const { DeepLinkHandler } = await freshModule()
      const onServerAddress = vi.fn()
      render(() => <DeepLinkHandler onServerAddress={onServerAddress} />)
      // The shell's own delivery of the SAME launch link: folded, not repeated.
      emitDeepLink?.("liaison://connect?server=https://box.example.com")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(onServerAddress).toHaveBeenCalledTimes(1)
      // The user opens the same link a second time: that is a new proposal.
      emitDeepLink?.("liaison://connect?server=https://box.example.com")
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(onServerAddress).toHaveBeenCalledTimes(2)
    } finally {
      launchLinks = null
    }
  })

  it("does not propose the launch link again after the window reloads", async () => {
    launchLinks = ["liaison://connect?server=https://box.example.com"]
    try {
      sessionStorage.clear()
      const first = await freshModule()
      expect(first.connectDeepLinkAddress()).toBe("https://box.example.com")
      // A reload re-evaluates the module; the plugin still answers the same link.
      const second = await freshModule()
      expect(second.pendingDeepLink()).toBeNull()
      expect(second.connectDeepLinkAddress()).toBeNull()
    } finally {
      launchLinks = null
      sessionStorage.clear()
    }
  })

  it("queues a link that arrives before mount", async () => {
    const { DeepLinkHandler } = await freshModule()
    emitDeepLink?.("liaison://connect?server=https://early.example.com")
    const onServerAddress = vi.fn()
    render(() => <DeepLinkHandler onServerAddress={onServerAddress} />)
    expect(onServerAddress).toHaveBeenCalledTimes(1)
    expect(onServerAddress).toHaveBeenCalledWith("https://early.example.com")
  })

  it("delivers a link that arrives after mount", async () => {
    const { DeepLinkHandler } = await freshModule()
    const onServerAddress = vi.fn()
    render(() => <DeepLinkHandler onServerAddress={onServerAddress} />)
    expect(onServerAddress).not.toHaveBeenCalled()
    emitDeepLink?.("liaison://connect?server=https://late.example.com")
    expect(onServerAddress).toHaveBeenCalledWith("https://late.example.com")
  })

  it("clears the queue once the link has been delivered", async () => {
    const { DeepLinkHandler, pendingDeepLink } = await freshModule()
    emitDeepLink?.("liaison://connect?server=https://once.example.com")
    expect(pendingDeepLink()).not.toBeNull()
    const onServerAddress = vi.fn()
    render(() => <DeepLinkHandler onServerAddress={onServerAddress} />)
    expect(onServerAddress).toHaveBeenCalledTimes(1)
    expect(pendingDeepLink()).toBeNull()
  })

  it("ignores a deep link that carries no server", async () => {
    const { DeepLinkHandler } = await freshModule()
    const onServerAddress = vi.fn()
    render(() => <DeepLinkHandler onServerAddress={onServerAddress} />)
    emitDeepLink?.("liaison://connect")
    expect(onServerAddress).not.toHaveBeenCalled()
  })

  // The shell validates the same link before it emits it. This is the second
  // half of that rule, on the side that would act on the value: a build where
  // the two disagree must fail closed, not apply whatever arrived.
  it("rejects a link whose server is not an http address", async () => {
    const { parseConnectLink } = await freshModule()
    for (const bad of [
      "liaison://connect?server=javascript:alert(1)",
      "liaison://connect?server=file:///etc/passwd",
      "liaison://connect?server=https://",
      "liaison://connect?server=not-a-url",
      "liaison://connect?server=https://a&server=https://b",
      "liaison://other?server=https://box.example",
      "https://connect?server=https://box.example",
    ]) {
      expect(parseConnectLink(bad)).toBeNull()
    }
  })

  it("delivers nothing to the window for a rejected link", async () => {
    const { DeepLinkHandler } = await freshModule()
    const onServerAddress = vi.fn()
    render(() => <DeepLinkHandler onServerAddress={onServerAddress} />)
    emitDeepLink?.("liaison://connect?server=javascript:alert(1)")
    expect(onServerAddress).not.toHaveBeenCalled()
    emitDeepLink?.("liaison://other?server=https://box.example")
    expect(onServerAddress).not.toHaveBeenCalled()
  })

  describe("oauth-complete links (system-browser sign-in)", () => {
    const STATE = "Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg"
    const CODE = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

    it("accepts the two shapes the server's handoff page sends", async () => {
      const { isOAuthCompleteLink } = await freshModule()
      expect(isOAuthCompleteLink(`liaison://oauth-complete?code=${CODE}&state=${STATE}`)).toBe(true)
      expect(
        isOAuthCompleteLink(`liaison://oauth-complete?error=Account+deactivated&state=${STATE}`),
      ).toBe(true)
    })

    it("refuses every other shape", async () => {
      const { isOAuthCompleteLink } = await freshModule()
      for (const bad of [
        `liaison://oauth-complete?code=${CODE}`,
        `liaison://oauth-complete?code=${CODE}&error=x&state=${STATE}`,
        `liaison://oauth-complete?code=nothex&state=${STATE}`,
        `liaison://oauth-complete?code=${CODE}&state=short`,
        `liaison://oauth-complete?code=${CODE}&state=${STATE}&extra=1`,
        `liaison://oauth-complete?code=${CODE}&code=${CODE}&state=${STATE}`,
        `liaison://connect?code=${CODE}&state=${STATE}`,
        "not a link",
      ]) {
        expect(isOAuthCompleteLink(bad), bad).toBe(false)
      }
    })

    it("routes a forwarded completion to the sign-in and leaves the connect queue alone", async () => {
      const { onOAuthCompleteLink, pendingDeepLink, connectDeepLinkAddress } = await freshModule()
      const seen: string[] = []
      onOAuthCompleteLink((link) => seen.push(link))
      const link = `liaison://oauth-complete?code=${CODE}&state=${STATE}`
      emitDeepLink?.(link)
      expect(seen).toEqual([link])
      expect(pendingDeepLink()).toBeNull()
      expect(connectDeepLinkAddress()).toBeNull()
    })

    it("holds a completion that arrives before anyone listens", async () => {
      const { onOAuthCompleteLink } = await freshModule()
      const link = `liaison://oauth-complete?code=${CODE}&state=${STATE}`
      emitDeepLink?.(link)
      const seen: string[] = []
      onOAuthCompleteLink((l) => seen.push(l))
      expect(seen).toEqual([link])
    })

    it("routes an app connection's completion to every waiting listener, never to the connect queue", async () => {
      // Connecting Gmail or Shopify from the app ends on the same handoff link
      // (shell-connect on the server). The window that started the connection
      // matches its own state; a sign-in card that happens to listen ignores it.
      const { onOAuthCompleteLink, pendingDeepLink, connectDeepLinkAddress, isOAuthCompleteLink } =
        await freshModule()
      const connect: string[] = []
      const signIn: string[] = []
      onOAuthCompleteLink((link) => connect.push(link))
      onOAuthCompleteLink((link) => signIn.push(link))
      const done = `liaison://oauth-complete?code=${CODE}&state=${STATE}`
      const refused = `liaison://oauth-complete?error=access_denied&state=${STATE}`
      expect(isOAuthCompleteLink(refused)).toBe(true)
      emitDeepLink?.(done)
      emitDeepLink?.(refused)
      expect(connect).toEqual([done, refused])
      expect(signIn).toEqual([done, refused])
      expect(pendingDeepLink()).toBeNull()
      expect(connectDeepLinkAddress()).toBeNull()
    })

    it("keeps connect links working exactly as before", async () => {
      const { onOAuthCompleteLink, pendingDeepLink, connectDeepLinkAddress } = await freshModule()
      const seen: string[] = []
      onOAuthCompleteLink((link) => seen.push(link))
      emitDeepLink?.("liaison://connect?server=https://box.example.com")
      expect(seen).toEqual([])
      expect(pendingDeepLink()).toBe("liaison://connect?server=https://box.example.com")
      expect(connectDeepLinkAddress()).toBe("https://box.example.com")
    })
  })
})
