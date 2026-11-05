// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIF-6: a link clicked in the desktop app opens in the system browser. In
// the webview a `target=_blank` link and `window.open` did nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installExternalLinkHandler, openExternal } from "./external-links"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"
import { LOCAL_PATH_ATTRIBUTE, LOCAL_PATH_CLASS } from "./local-path-links"

let remove: (() => void) | null = null
let host: HTMLDivElement

function mount(html: string): HTMLDivElement {
  host = document.createElement("div")
  host.innerHTML = html
  document.body.append(host)
  return host
}

function click(element: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent(init.button === 1 ? "auxclick" : "click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  })
  element.dispatchEvent(event)
  return event
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  remove = installExternalLinkHandler(document)
})

afterEach(() => {
  remove?.()
  remove = null
  host?.remove()
  uninstallFakeBridge()
  vi.restoreAllMocks()
})

describe("external link clicks on desktop", () => {
  it("hands an external https link to the shell and stops the webview", async () => {
    const fake = installFakeBridge()
    const root = mount(
      '<a href="https://example.com/docs?a=1" target="_blank" rel="noopener">docs</a>',
    )
    const event = click(root.querySelector("a")!)
    await flush()
    expect(event.defaultPrevented).toBe(true)
    expect(fake.calls.openedExternalUrls).toEqual(["https://example.com/docs?a=1"])
  })

  it("hands a mailto link and a middle click to the shell", async () => {
    const fake = installFakeBridge()
    const root = mount(
      '<a id="m" href="mailto:someone@example.com">mail</a><a id="w" href="http://example.org/">web</a>',
    )
    click(root.querySelector("#m")!)
    click(root.querySelector("#w")!, { button: 1 })
    click(root.querySelector("#w")!, { metaKey: true })
    await flush()
    expect(fake.calls.openedExternalUrls).toEqual([
      "mailto:someone@example.com",
      "http://example.org/",
      "http://example.org/",
    ])
  })

  it("leaves same-origin app links, mentions, local paths and alt clicks alone", async () => {
    const fake = installFakeBridge()
    const root = mount(
      [
        `<a id="same" href="${window.location.origin}/threads/abc">thread</a>`,
        '<a id="rel" href="/projects/p1">project</a>',
        '<span data-mention-ref="tickets:ticket:1"><a id="mention" href="https://example.com/t/1">#1</a></span>',
        `<a id="local" href="#" class="${LOCAL_PATH_CLASS}" ${LOCAL_PATH_ATTRIBUTE}="/tmp/x.pdf">x.pdf</a>`,
        '<a id="js" href="javascript:alert(1)">js</a>',
        '<a id="file" href="file:///etc/passwd">file</a>',
        '<a id="dl" href="https://example.com/file.zip" download>zip</a>',
        '<a id="alt" href="https://example.com/">alt</a>',
      ].join(""),
    )
    for (const id of ["same", "rel", "mention", "local", "js", "file", "dl"]) {
      const event = click(root.querySelector(`#${id}`)!)
      expect(event.defaultPrevented, id).toBe(false)
    }
    expect(click(root.querySelector("#alt")!, { altKey: true }).defaultPrevented).toBe(false)
    await flush()
    expect(fake.calls.openedExternalUrls).toEqual([])
  })

  it("routes clicks inside a same-origin iframe document (mail bodies)", async () => {
    const fake = installFakeBridge()
    const iframe = document.createElement("iframe")
    document.body.append(iframe)
    const doc = iframe.contentDocument!
    doc.body.innerHTML = '<a href="https://example.com/newsletter">read</a>'
    const removeFrame = installExternalLinkHandler(doc)
    try {
      const anchor = doc.querySelector("a")!
      const event = new (iframe.contentWindow as unknown as typeof globalThis).MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })
      anchor.dispatchEvent(event)
      await flush()
      expect(event.defaultPrevented).toBe(true)
      expect(fake.calls.openedExternalUrls).toEqual(["https://example.com/newsletter"])
    } finally {
      removeFrame()
      iframe.remove()
    }
  })

  it("does nothing on a shell that predates the command", async () => {
    installFakeBridge({}, { withoutExternalOpener: true })
    const root = mount('<a href="https://example.com/">x</a>')
    expect(click(root.querySelector("a")!).defaultPrevented).toBe(false)
  })
})

describe("external link clicks in a browser", () => {
  it("does nothing: the browser opens its own tab", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    const root = mount('<a href="https://example.com/" target="_blank">x</a>')
    expect(click(root.querySelector("a")!).defaultPrevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})

describe("openExternal", () => {
  it("opens through the shell on desktop, never window.open", async () => {
    const fake = installFakeBridge()
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    expect(await openExternal("https://example.com/a")).toBe(true)
    expect(fake.calls.openedExternalUrls).toEqual(["https://example.com/a"])
    expect(open).not.toHaveBeenCalled()
  })

  it("hands a phone number to the shell on desktop", async () => {
    const fake = installFakeBridge()
    expect(await openExternal("tel:+33100000000")).toBe(true)
    expect(fake.calls.openedExternalUrls).toEqual(["tel:+33100000000"])
  })

  it("refuses on desktop what the shell would refuse", async () => {
    const fake = installFakeBridge()
    expect(await openExternal("file:///etc/passwd")).toBe(false)
    expect(await openExternal("javascript:alert(1)")).toBe(false)
    expect(await openExternal("not a url")).toBe(false)
    expect(fake.calls.openedExternalUrls).toEqual([])
  })

  it("opens a noopener tab in a browser", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    expect(await openExternal("https://example.com/a")).toBe(true)
    expect(await openExternal("tel:+33100000000")).toBe(true)
    expect(await openExternal("javascript:alert(1)")).toBe(false)
    expect(open.mock.calls).toEqual([
      ["https://example.com/a", "_blank", "noopener,noreferrer"],
      ["tel:+33100000000", "_blank", "noopener,noreferrer"],
    ])
  })
})
