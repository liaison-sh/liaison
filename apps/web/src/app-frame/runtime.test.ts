// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The frame runtime: the host services an isolated app gets are messages to
// the page, and none of them is the user's token.
import { afterEach, describe, expect, it, vi } from "vitest"
import { startFrameRuntime } from "./runtime"

afterEach(() => {
  for (const key of [
    "__liaisonHost",
    "__liaisonSolid",
    "__liaisonSolidWeb",
    "__liaisonSolidStore",
  ]) {
    delete (window as unknown as Record<string, unknown>)[key]
  }
  vi.restoreAllMocks()
})

function frameWindow() {
  const posted: unknown[] = []
  const parent = { postMessage: (message: unknown) => posted.push(message) }
  const listeners = new Map<string, Array<(event: Event) => void>>()
  const dispatched: Event[] = []
  const pushed: unknown[][] = []
  const history = {
    pushState: (...args: unknown[]) => pushed.push(["push", ...args]),
    replaceState: (...args: unknown[]) => pushed.push(["replace", ...args]),
  }
  const win = {
    parent,
    document,
    history,
    PopStateEvent,
    ResizeObserver: class {
      observe() {}
    },
    addEventListener: (type: string, listener: (event: Event) => void) =>
      listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    dispatchEvent: (event: Event) => {
      dispatched.push(event)
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return true
    },
  } as unknown as Window & typeof globalThis
  const deliver = (data: unknown, source: unknown = parent) => {
    for (const listener of listeners.get("message") ?? []) {
      listener({ data, source } as unknown as MessageEvent)
    }
  }
  /** A click on an element of the frame's document, as it bubbles to the frame's window. */
  const click = (el: Element, init: MouseEventInit = {}) => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init })
    // The window hears it last, while it is still being dispatched.
    const toWindow = (e: Event) => {
      for (const listener of listeners.get("click") ?? []) listener(e)
    }
    document.addEventListener("click", toWindow)
    el.dispatchEvent(event)
    document.removeEventListener("click", toWindow)
    return event
  }
  return { win, posted, deliver, click, dispatched, pushed }
}

describe("the isolated app's frame runtime", () => {
  it("says ready, and maps the bare Solid specifiers before any module loads", () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const { win, posted } = frameWindow()
    startFrameRuntime(win)
    expect(posted).toEqual([{ kind: "ready" }])
    const map = document.head.querySelector('script[type="importmap"]')
    expect(Object.keys(JSON.parse(map?.textContent ?? "{}").imports)).toEqual([
      "solid-js",
      "solid-js/web",
      "solid-js/store",
    ])
  })

  it("holds no token, and a fetch is a call the page answers", async () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const { win, posted, deliver } = frameWindow()
    startFrameRuntime(win)
    const host = (win as unknown as { __liaisonHost: Record<string, (...a: unknown[]) => unknown> })
      .__liaisonHost
    expect(host.accessToken()).toBeNull()
    expect(await host.openFile()).toBe(false)
    const answer = host.fetch("/api/me", { method: "GET" }) as Promise<unknown>
    const call = posted.at(-1) as { kind: string; id: number; method: string; args: unknown[] }
    expect(call).toMatchObject({
      kind: "call",
      method: "fetch",
      args: ["/api/me", { method: "GET" }],
    })
    // A window other than the page is not heard.
    deliver({ kind: "result", id: call.id, ok: true, value: "forged" }, {})
    deliver({ kind: "result", id: call.id, ok: true, value: { data: 1 } })
    await expect(answer).resolves.toEqual({ data: 1 })
  })

  it("opens the connect dialog through the page and hands back its answer", async () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const { win, posted, deliver } = frameWindow()
    startFrameRuntime(win)
    const host = (win as unknown as { __liaisonHost: Record<string, (...a: unknown[]) => unknown> })
      .__liaisonHost
    const answer = host.openConnectDialog("ignored", { connectionName: "meta" }) as Promise<unknown>
    const call = posted.at(-1) as { kind: string; id: number; method: string; args: unknown[] }
    expect(call).toMatchObject({
      kind: "call",
      method: "openConnectDialog",
      args: [{ connectionName: "meta" }],
    })
    deliver({ kind: "result", id: call.id, ok: true, value: { connected: true } })
    await expect(answer).resolves.toEqual({ connected: true })
  })

  it("an unsupported answer rejects the call with the method it named", async () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const { win, posted, deliver } = frameWindow()
    startFrameRuntime(win)
    const host = (win as unknown as { __liaisonHost: Record<string, (...a: unknown[]) => unknown> })
      .__liaisonHost
    const answer = host.fetchBlob("/api/apps/acme/x") as Promise<unknown>
    const call = posted.at(-1) as { id: number }
    deliver({ kind: "result", id: call.id, ok: false, error: "unsupported", method: "fetchBlob" })
    await expect(answer).rejects.toMatchObject({ message: "unsupported", method: "fetchBlob" })
  })

  it("a plain link to a page path is a navigate call to the page, and the frame stays on its document", () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const { win, posted, click } = frameWindow()
    startFrameRuntime(win)
    const link = document.createElement("a")
    link.setAttribute("href", "/acme/orders?status=open")
    const label = document.createElement("span")
    label.textContent = "Orders"
    link.appendChild(label)
    document.body.appendChild(link)
    try {
      const event = click(label)
      expect(event.defaultPrevented).toBe(true)
      expect(posted.at(-1)).toMatchObject({
        kind: "call",
        method: "navigate",
        args: ["/acme/orders?status=open"],
      })
    } finally {
      link.remove()
    }
  })

  it("leaves alone a link it must not take: modifier, other button, target, download, external, handled", () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const { win, posted, click } = frameWindow()
    startFrameRuntime(win)
    const make = (href: string, attrs: Record<string, string> = {}) => {
      const a = document.createElement("a")
      a.setAttribute("href", href)
      for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v)
      document.body.appendChild(a)
      return a
    }
    const before = posted.length
    const links = [
      make("https://example.com/x"),
      make("//example.com/x"),
      make("/acme/x", { target: "_blank" }),
      make("/acme/x", { download: "" }),
      make("#section"),
    ]
    const handled = make("/acme/handled")
    handled.addEventListener("click", (e) => e.preventDefault())
    const plain = make("/acme/plain")
    try {
      for (const a of links) expect(click(a).defaultPrevented).toBe(false)
      expect(click(plain, { metaKey: true }).defaultPrevented).toBe(false)
      expect(click(plain, { ctrlKey: true }).defaultPrevented).toBe(false)
      expect(click(plain, { shiftKey: true }).defaultPrevented).toBe(false)
      expect(click(plain, { button: 1 }).defaultPrevented).toBe(false)
      click(handled)
      expect(posted.length).toBe(before)
    } finally {
      for (const a of [...links, handled, plain]) a.remove()
    }
  })

  it("an app's own pushState to a page path is a navigate call; its document URL never moves", () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const { win, posted, pushed } = frameWindow()
    startFrameRuntime(win)
    win.history.pushState({}, "", "/acme/shipments?status=delivered")
    expect(posted.at(-1)).toMatchObject({
      kind: "call",
      method: "navigate",
      args: ["/acme/shipments?status=delivered"],
    })
    win.history.replaceState({}, "", "/acme/shipments")
    expect(posted.at(-1)).toMatchObject({ method: "navigate", args: ["/acme/shipments"] })
    expect(pushed).toEqual([])
    // Anything else (a hash, a state-only replace) is the frame's own business.
    win.history.replaceState({ scroll: 1 }, "")
    expect(pushed).toEqual([["replace", { scroll: 1 }, ""]])
  })

  it("knows the page's path: from init, then from each path message, and tells the app (popstate)", () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const { win, deliver, dispatched } = frameWindow()
    startFrameRuntime(win)
    const host = (win as unknown as { __liaisonHost: { currentPath: () => string } }).__liaisonHost
    deliver({ kind: "path", path: "/acme/orders" })
    expect(host.currentPath()).toBe("/acme/orders")
    expect(dispatched.at(-1)?.type).toBe("popstate")
    // Another window cannot move it.
    deliver({ kind: "path", path: "/elsewhere" }, {})
    expect(host.currentPath()).toBe("/acme/orders")
    deliver({ kind: "path", path: "/acme/orders?status=open" })
    expect(host.currentPath()).toBe("/acme/orders?status=open")
  })
})

// A frame served on the app's own origin (LIAISON_APP_FRAME_ORIGIN_TEMPLATE).
describe("the frame runtime on the app's own origin", () => {
  const PAGE = "https://acme.liaison.test"

  function withParentOrigin(origin: string) {
    const meta = document.createElement("meta")
    meta.name = "liaison-parent-origin"
    meta.content = origin
    document.head.appendChild(meta)
    return () => meta.remove()
  }

  it("posts to the baked parent origin only, and drops messages from any other origin", async () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const cleanup = withParentOrigin(PAGE)
    try {
      const targets: unknown[] = []
      const { win, posted } = frameWindow()
      const parent = win.parent as unknown as { postMessage: (m: unknown, t: unknown) => void }
      parent.postMessage = (message: unknown, target: unknown) => {
        posted.push(message)
        targets.push(target)
      }
      const listeners: Array<(e: MessageEvent) => void> = []
      const add = win.addEventListener
      ;(win as unknown as { addEventListener: unknown }).addEventListener = (
        type: string,
        listener: (event: Event) => void,
      ) => {
        if (type === "message") listeners.push(listener as (e: MessageEvent) => void)
        add(type, listener)
      }
      startFrameRuntime(win)
      expect(targets).toEqual([PAGE])
      const host = (
        win as unknown as { __liaisonHost: Record<string, (...a: unknown[]) => unknown> }
      ).__liaisonHost
      const answer = host.invokeTool("acme", "list", {}) as Promise<unknown>
      const call = posted.at(-1) as { id: number }
      const result = { kind: "result", id: call.id, ok: true, value: "forged" }
      for (const l of listeners)
        l({ data: result, source: win.parent, origin: "https://evil.test" } as MessageEvent)
      for (const l of listeners) {
        l({ data: { ...result, value: "real" }, source: win.parent, origin: PAGE } as MessageEvent)
      }
      expect(await answer).toBe("real")
      expect(targets.every((t) => t === PAGE)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("exposes the init context (no token) and forwards the typed calls", async () => {
    if (!URL.createObjectURL) URL.createObjectURL = () => "blob:shim"
    const { win, posted } = frameWindow()
    startFrameRuntime(win)
    const host = (win as unknown as { __liaisonHost: Record<string, (...a: unknown[]) => unknown> })
      .__liaisonHost
    expect(host.context()).toBeNull()
    void host.openFileById("acme", "file-1", "a.pdf")
    expect(posted.at(-1)).toMatchObject({ method: "openFile", args: ["file-1", "a.pdf"] })
    void host.decideApproval("acme", "ap-1", "approve", "h")
    expect(posted.at(-1)).toMatchObject({
      method: "decideApproval",
      args: ["ap-1", "approve", "h"],
    })
    void host.openExternal("acme", "https://x.test")
    expect(posted.at(-1)).toMatchObject({ method: "openExternal", args: ["https://x.test"] })
    host.openRecord("acme", "invoicing", "document", "d1")
    expect(posted.at(-1)).toMatchObject({
      method: "openRecord",
      args: ["invoicing", "document", "d1"],
    })
    expect(host.accessToken()).toBeNull()
  })
})
