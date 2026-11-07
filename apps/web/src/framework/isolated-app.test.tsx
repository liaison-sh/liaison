// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D11: an installed app's UI that did not ship with the client build runs in
// the desktop shell's sandboxed frame and reaches Liaison only through the
// page's answers, never the shell's bridge.
import { render } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerTabType, unregisterTabTypes } from "~/framework/app-registry"
import { registerAppFromManifest, unregisterApp } from "~/framework/define-app"
import { setPagePath } from "~/framework/spa-navigate"
import { parseFrameMessage } from "../app-frame/protocol"
import {
  answerFrameCall,
  browserAppFrameUrl,
  frameCallState,
  ISOLATED_APP_SANDBOX,
  type IsolatedHost,
  isolatedAppExports,
  ORIGIN_BOUND_APP_SANDBOX,
} from "./isolated-app"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, canAccessScope: () => true }
})

const FRAME_URL = "liaison-frame://localhost/"

const manifest = {
  name: "acme",
  views: {
    tabTypes: {
      home: {
        component: "AcmeHome",
        icon: "AcmeTabIcon",
        resolveLabel: "acmeLabel",
        // A pattern outside the app's own prefix gives navigate nothing.
        urlPattern: "/settings/computers",
      },
    },
    activityBar: { icon: "AcmeIcon", label: "Acme" },
  },
}

function fakeHost(): IsolatedHost & { [k: string]: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async () => ({ data: "ok" })),
    invokeTool: vi.fn(async () => ({ data: "tool" })),
    openConnect: vi.fn(async () => {}),
    openConnectDialog: vi.fn(async () => ({ connected: true })),
    fetchBlob: vi.fn(async () => new Blob(["x"])),
    navigate: vi.fn(),
    onEntityChange: vi.fn(() => () => {}),
  }
}

function mountView(host: IsolatedHost, exportName = "AcmeHome") {
  const exports = isolatedAppExports(manifest, {
    app: "acme",
    bundleUrl: "https://box.example.com/api/apps/acme/1.0.0/ui.js",
    frameUrl: FRAME_URL,
    host: () => host,
    loadSource: async () => "export const AcmeHome = () => null",
  })
  const View = exports[exportName] as (props: Record<string, unknown>) => unknown
  const result = render(() => View({ entityId: "e-1", onClose: () => {} }) as never)
  const frame = result.getByTestId("isolated-app-frame") as HTMLIFrameElement
  return { frame, result }
}

/** A message as the frame's own window sends it. */
function fromFrame(frame: HTMLIFrameElement, data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }))
}

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__
})

describe("an installed app's UI in the desktop shell", () => {
  it("renders in a sandboxed frame of the shell's own scheme, never same-origin", () => {
    const { frame } = mountView(fakeHost())
    expect(frame.getAttribute("sandbox")).toBe(ISOLATED_APP_SANDBOX)
    const flags = (frame.getAttribute("sandbox") ?? "").split(/\s+/)
    expect(flags).toEqual(["allow-scripts", "allow-forms"])
    expect(flags).not.toContain("allow-same-origin")
    expect(flags).not.toContain("allow-top-navigation")
    expect(flags).not.toContain("allow-popups")
    expect(frame.getAttribute("src")).toBe(FRAME_URL)
  })

  it("draws no code of the app in the page: icons and label resolvers are the host's", () => {
    const exports = isolatedAppExports(manifest, {
      app: "acme",
      bundleUrl: "https://box.example.com/api/apps/acme/1.0.0/ui.js",
      frameUrl: FRAME_URL,
    })
    expect("AcmeHome" in exports && "AnythingDeclared" in exports).toBe(true)
    expect((exports.acmeLabel as () => unknown)()).toBeUndefined()
    expect(exports.AcmeIcon).toBe(exports.AcmeTabIcon)
    expect(exports.registerEntityPreviews).toBeUndefined()
    expect(exports.registerAppHooks).toBeUndefined()
  })

  it("still shows the app's icon: a tile with its initial, named, at the size asked, never a blank square", () => {
    const exports = isolatedAppExports(manifest, {
      app: "acme",
      bundleUrl: "https://box.example.com/api/apps/acme/1.0.0/ui.js",
      frameUrl: FRAME_URL,
    })
    const Icon = exports.AcmeIcon as (props: { size?: number }) => unknown
    const { getByTestId } = render(() => Icon({ size: 20 }) as never)
    const svg = getByTestId("isolated-app-icon")
    expect(svg.getAttribute("aria-label")).toBe("Acme")
    expect(svg.getAttribute("width")).toBe("20")
    expect(svg.querySelector("text")?.textContent).toBe("A")
    // An app with no rail label is known by its display name, else its name.
    const bare = isolatedAppExports(
      { name: "zeta", views: { tabTypes: { t: { component: "Z", icon: "ZIcon" } } } },
      {
        app: "zeta",
        bundleUrl: "https://box.example.com/api/apps/zeta/1/ui.js",
        frameUrl: FRAME_URL,
      },
    )
    const Bare = bare.ZIcon as (props: { size?: number }) => unknown
    const second = render(() => Bare({}) as never)
    const glyph = second.getAllByTestId("isolated-app-icon").at(-1)
    expect(glyph?.querySelector("text")?.textContent).toBe("Z")
    expect(glyph?.getAttribute("aria-label")).toBe("zeta")
  })

  const ICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 3v18h18" fill="none" stroke="#4f46e5"/></svg>'

  function renderIcon(extra: Record<string, unknown>) {
    const exports = isolatedAppExports(
      { ...manifest, ...extra },
      {
        app: "acme",
        bundleUrl: "https://box.example.com/api/apps/acme/1.0.0/ui.js",
        frameUrl: FRAME_URL,
      },
    )
    const Icon = exports.AcmeIcon as (props: { size?: number }) => unknown
    return render(() => Icon({ size: 20 }) as never)
  }

  it("shows the manifest's iconSvg as an image whose source is that SVG, never as markup in the page (S1)", () => {
    const { getByTestId, container } = renderIcon({ iconSvg: ICON_SVG })
    const img = getByTestId("isolated-app-icon")
    expect(img.tagName).toBe("IMG")
    const src = img.getAttribute("src") ?? ""
    const prefix = "data:image/svg+xml;charset=utf-8,"
    expect(src.startsWith(prefix)).toBe(true)
    expect(decodeURIComponent(src.slice(prefix.length))).toBe(ICON_SVG)
    expect(img.getAttribute("alt")).toBe("Acme")
    expect(img.getAttribute("width")).toBe("20")
    expect(container.querySelector("svg")).toBeNull()
    expect(container.querySelector("path")).toBeNull()
  })

  it("an iconSvg drawn in currentColor is the mask of a box in the text colour, never markup", () => {
    const drawn =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 20V10"/></svg>'
    const { getByTestId, container } = renderIcon({ iconSvg: drawn })
    const icon = getByTestId("isolated-app-icon")
    expect(icon.tagName).toBe("SPAN")
    expect(icon.getAttribute("aria-label")).toBe("Acme")
    expect(icon.style.backgroundColor).toBe("currentcolor")
    expect(icon.style.width).toBe("20px")
    const mask =
      icon.style.getPropertyValue("mask-image") || icon.style.getPropertyValue("-webkit-mask-image")
    expect(decodeURIComponent(mask)).toContain('d="M4 20V10"')
    expect(container.querySelector("svg")).toBeNull()
  })

  it("an iconSvg that fails the client's check falls back to the initial tile", () => {
    const { getByTestId, container } = renderIcon({
      iconSvg: ICON_SVG.replace("<path", "<script>x()</script><path"),
    })
    const tile = getByTestId("isolated-app-icon")
    expect(tile.tagName.toLowerCase()).toBe("svg")
    expect(tile.querySelector("text")?.textContent).toBe("A")
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelector("script")).toBeNull()
  })

  it("shows the named icon of Liaison's set for iconName (S1)", () => {
    const { getByTestId } = renderIcon({ iconName: "gauge" })
    const icon = getByTestId("isolated-app-icon")
    expect(icon.getAttribute("data-icon-name")).toBe("gauge")
    expect(icon.getAttribute("aria-label")).toBe("Acme")
    expect(icon.classList.contains("lucide-gauge")).toBe(true)
    expect(icon.querySelector("text")).toBeNull()
  })

  it("an unknown iconName falls back to the initial tile", () => {
    const { getByTestId } = renderIcon({ iconName: "skull" })
    expect(getByTestId("isolated-app-icon").querySelector("text")?.textContent).toBe("A")
  })

  /**
   * THE BRIDGE IS NOT REACHABLE FROM THE FRAME. Whatever the frame posts, the
   * page answers with the kernel's host services or not at all: no message
   * names a shell command, and none reaches `__TAURI_INTERNALS__`.
   */
  it("an app bundle cannot reach the desktop bridge through the page", async () => {
    const invoke = vi.fn()
    ;(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = { invoke }
    const host = fakeHost()
    const { frame } = mountView(host)
    for (const attempt of [
      { kind: "call", id: 1, method: "invoke", args: ["start_session", {}] },
      { kind: "call", id: 2, method: "respond_permission", args: ["perm-1", "allow"] },
      { kind: "call", id: 3, method: "__TAURI_INTERNALS__", args: [] },
      { kind: "invoke", cmd: "start_session" },
      JSON.stringify({ type: "invoke", payload: { cmd: "start_session" } }),
      { kind: "call", id: 4, method: "fetch", args: ["https://evil.example.com/steal"] },
    ]) {
      fromFrame(frame, attempt)
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(invoke).not.toHaveBeenCalled()
    // The absolute URL is not one of the app's own routes: the page never calls its fetch.
    expect(host.fetch).not.toHaveBeenCalled()
    expect(host.invokeTool).not.toHaveBeenCalled()
  })

  it("hears only its own frame's window", async () => {
    const host = fakeHost()
    mountView(host)
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { kind: "call", id: 1, method: "fetch", args: ["/api/me"] },
        source: window,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.fetch).not.toHaveBeenCalled()
  })

  it("control: the frame's own fetch reaches the kernel host and its answer goes back", async () => {
    const host = fakeHost()
    const { frame } = mountView(host)
    const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
    fromFrame(frame, {
      kind: "call",
      id: 7,
      method: "fetch",
      args: ["/api/apps/acme/orders?limit=5", { method: "GET" }],
    })
    await vi.waitFor(() =>
      expect(posted).toHaveBeenCalledWith(
        { kind: "result", id: 7, ok: true, value: { data: "ok" } },
        "*",
      ),
    )
    expect(host.fetch).toHaveBeenCalledWith("/api/apps/acme/orders?limit=5", { method: "GET" })
  })

  it("control: ready is answered with the bundle, the export and the plain props only", async () => {
    const host = fakeHost()
    const { frame } = mountView(host)
    const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
    fromFrame(frame, { kind: "ready" })
    await vi.waitFor(() => expect(posted).toHaveBeenCalled())
    const init = posted.mock.calls
      .map((c) => c[0])
      .find((m) => (m as { kind: string }).kind === "init")
    expect(init).toMatchObject({
      kind: "init",
      app: "acme",
      exportName: "AcmeHome",
      source: "export const AcmeHome = () => null",
      props: { entityId: "e-1" },
    })
    expect((init as { props: Record<string, unknown> }).props).not.toHaveProperty("onClose")
  })
})

describe("the page's path in the frame", () => {
  it("init carries the page's path, and each route change is a path message", async () => {
    setPagePath("/acme/orders")
    const host = fakeHost()
    const { frame } = mountView(host)
    const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
    fromFrame(frame, { kind: "ready" })
    await vi.waitFor(() =>
      expect(posted.mock.calls.map((c) => c[0])).toContainEqual(
        expect.objectContaining({ kind: "init", path: "/acme/orders" }),
      ),
    )
    setPagePath("/acme/orders?status=open")
    await vi.waitFor(() =>
      expect(posted.mock.calls.map((c) => c[0])).toContainEqual({
        kind: "path",
        path: "/acme/orders?status=open",
      }),
    )
  })
})

describe("the page's path outside the app's own routes", () => {
  it("is empty on another app's page, and whole on the app's own detail and settings pages", async () => {
    const seen = async (pagePathNow: string): Promise<unknown> => {
      setPagePath(pagePathNow)
      const { frame, result } = mountView(fakeHost())
      const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
      fromFrame(frame, { kind: "ready" })
      let path: unknown
      await vi.waitFor(() => {
        const init = posted.mock.calls.map((c) => c[0]).find((m) => m?.kind === "init")
        expect(init).toBeDefined()
        path = init.path
      })
      result.unmount()
      return path
    }
    expect(await seen("/mail/x?q=secret")).toBe("")
    expect(await seen("/acme-other/1")).toBe("")
    expect(await seen("/settings/apps/other")).toBe("")
    expect(await seen("/detail/acme/order/1?x=1")).toBe("/detail/acme/order/1?x=1")
    expect(await seen("/settings/apps/acme")).toBe("/settings/apps/acme")
    expect(await seen("/acme")).toBe("/acme")
  })

  it("follows the page: a route change to another app's page posts an empty path", async () => {
    setPagePath("/acme/orders")
    const { frame } = mountView(fakeHost())
    const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
    fromFrame(frame, { kind: "ready" })
    setPagePath("/mail/x")
    await vi.waitFor(() =>
      expect(posted.mock.calls.map((c) => c[0])).toContainEqual({ kind: "path", path: "" }),
    )
    expect(posted.mock.calls.map((c) => c[0])).not.toContainEqual(
      expect.objectContaining({ path: "/mail/x" }),
    )
  })
})

describe("the page's styles in the frame", () => {
  it("are handed over without @font-face rules, whose page-relative fonts the frame's policy refuses", async () => {
    const style = document.createElement("style")
    style.textContent =
      '@font-face { font-family: "Probe"; src: url("/assets/probe.woff2") format("woff2"); } .probe-rule { color: red; }'
    document.head.appendChild(style)
    try {
      const host = fakeHost()
      const { frame } = mountView(host)
      const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
      fromFrame(frame, { kind: "ready" })
      await vi.waitFor(() =>
        expect(posted.mock.calls.some((c) => (c[0] as { kind: string }).kind === "init")).toBe(
          true,
        ),
      )
      const init = posted.mock.calls
        .map((c) => c[0] as { kind: string; css?: string })
        .find((m) => m.kind === "init")
      expect(init?.css).toContain(".probe-rule")
      expect(init?.css).not.toContain("@font-face")
      expect(init?.css).not.toContain("probe.woff2")
    } finally {
      style.remove()
    }
  })
})

describe("the calls a frame may make", () => {
  it("a tool call is bound to the frame's own app, whatever it asks", async () => {
    const host = fakeHost()
    await answerFrameCall("acme", "invokeTool", ["list_orders", { limit: 5 }], host)
    expect(host.invokeTool).toHaveBeenCalledWith("acme", "list_orders", { limit: 5 })
  })

  it("fetches only the app's own API routes, whatever path it asks", async () => {
    const host = fakeHost()
    for (const path of [
      "/api/me",
      "/api/apps/other/orders",
      "/api/apps/acme-other/orders",
      "/api/apps/acme/../other/orders",
      "/api/apps/acme/%2e%2e/other",
      "/api/apps/acme%2F..%2Fother",
      "/api/apps/acme/..\\other",
      "//evil.example.com/api/apps/acme",
      "https://evil.example.com/api/apps/acme/x",
      "api/apps/acme/x",
    ]) {
      await expect(answerFrameCall("acme", "fetch", [path], host)).rejects.toThrow(/own routes/)
      await expect(answerFrameCall("acme", "fetchBlob", [path], host)).rejects.toThrow(/own routes/)
    }
    expect(host.fetch).not.toHaveBeenCalled()
    expect(host.fetchBlob).not.toHaveBeenCalled()
    await answerFrameCall("acme", "fetch", ["/api/apps/acme/orders/1"], host)
    expect(host.fetch).toHaveBeenCalledWith("/api/apps/acme/orders/1", {})
    await answerFrameCall("acme", "fetchBlob", ["/api/apps/acme/files/1/blob"], host)
    expect(host.fetchBlob).toHaveBeenCalledWith("/api/apps/acme/files/1/blob")
  })

  it("opens the connect dialog for the frame's own app, with a string connection name only", async () => {
    const host = fakeHost()
    await expect(
      answerFrameCall("acme", "openConnectDialog", [{ connectionName: "orders" }], host),
    ).resolves.toEqual({ connected: true })
    expect(host.openConnectDialog).toHaveBeenCalledWith("acme", { connectionName: "orders" })
    await answerFrameCall("acme", "openConnectDialog", [], host)
    expect(host.openConnectDialog).toHaveBeenLastCalledWith("acme", {})
    // A frame cannot name another app: the page-bound app is the one asked.
    await answerFrameCall(
      "acme",
      "openConnectDialog",
      [{ appName: "other", connectionName: "orders" }],
      host,
    )
    expect(host.openConnectDialog).toHaveBeenLastCalledWith("acme", { connectionName: "orders" })
    await expect(
      answerFrameCall("acme", "openConnectDialog", [{ connectionName: 7 }], host),
    ).rejects.toThrow(/connectionName/)
    const { openConnectDialog: _omitted, ...older } = host
    await expect(answerFrameCall("acme", "openConnectDialog", [{}], older)).rejects.toThrow(
      /unavailable/,
    )
  })

  it("navigates in the app only", async () => {
    const host = fakeHost()
    await expect(
      answerFrameCall("acme", "navigate", ["https://evil.example.com"], host),
    ).rejects.toThrow()
    await expect(
      answerFrameCall("acme", "navigate", ["//evil.example.com"], host),
    ).rejects.toThrow()
    await answerFrameCall("acme", "navigate", ["/acme/home"], host)
    expect(host.navigate).toHaveBeenCalledWith("/acme/home")
  })

  // A11: navigate reaches the app's own routes, the tabs its manifest declares,
  // its own settings page and the connectors page, and nothing else.
  it("navigate is refused outside the allowlist", async () => {
    const host = fakeHost()
    for (const path of [
      "/settings/computers",
      "/settings/apps/other",
      "/settings",
      "/approvals",
      "/other/explorer",
      "/kpi-other/explorer",
      "/kpi/../settings/computers",
      "/kpi/%2e%2e/settings",
      "/kpi%2F..%2Fsettings",
      "/kpi/..\\settings",
      "/detail/other/x/1",
      "kpi/explorer",
      "/kpi-board",
    ]) {
      await expect(answerFrameCall("kpi", "navigate", [path], host)).rejects.toThrow(
        /navigate: not allowed/,
      )
    }
    expect(host.navigate).not.toHaveBeenCalled()
  })

  // An app named after a Liaison page route would reach that page's action-on-load
  // routes through "its own" prefix: /login/magic verifies a link on mount.
  it("navigate refuses an app named after a Liaison page route", async () => {
    const host = fakeHost()
    for (const [app, path] of [
      ["login", "/login/magic?token=attacker"],
      ["auth", "/auth/device?code=ABCD-EFGH"],
      ["register", "/register"],
      ["reset-password", "/reset-password/confirm?token=x"],
      ["demo", "/demo/verify?code=1"],
      ["settings", "/settings/security"],
    ]) {
      await expect(answerFrameCall(app, "navigate", [path], host)).rejects.toThrow(
        /navigate: not allowed/,
      )
    }
    expect(host.navigate).not.toHaveBeenCalled()
  })

  it("navigate allows the app's own routes and its settings", async () => {
    const host = fakeHost()
    for (const path of [
      "/kpi/explorer",
      "/kpi",
      "/kpi/metrics/42?range=7d",
      "/settings/apps/kpi",
      "/settings/connectors",
    ]) {
      await answerFrameCall("kpi", "navigate", [path], host)
      expect(host.navigate).toHaveBeenLastCalledWith(path)
    }
  })

  // A tab type the app's manifest declares outside `/<app>` (kpi's `/kpi-catalogue/...`): the
  // sidebar of a framed app selects through navigate, so refusing it leaves the click dead.
  // A pattern longer than the mail app's own (`/mail/:entityIdXXXXXXXX`) used to win `/mail/<id>`
  // and so let the frame open mail's conversation URL: the registry skips it now.
  it("navigate refuses another app's page an installed app declared a longer tab pattern for", async () => {
    const host = fakeHost()
    vi.spyOn(console, "warn").mockImplementation(() => {})
    registerTabType("mail:conversation", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/mail/:entityId",
      defaultLabel: "Mail",
      appId: "mail",
    })
    registerAppFromManifest(
      {
        name: "evil",
        views: {
          tabTypes: { steal: { component: "C", urlPattern: "/mail/:entityIdXXXXXXXXXXXX" } },
        },
      },
      { C: () => null },
      { external: true },
    )
    try {
      await expect(answerFrameCall("evil", "navigate", ["/mail/abc123"], host)).rejects.toThrow(
        /not allowed/,
      )
      expect(host.navigate).not.toHaveBeenCalled()
    } finally {
      unregisterApp("evil")
      unregisterTabTypes(["mail:conversation"])
    }
  })

  it("navigate allows the app's own tab types declared outside its prefix, and only its own", async () => {
    const host = fakeHost()
    const tab = (appId: string, urlPattern: string) => ({
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern,
      defaultLabel: appId,
      appId,
    })
    registerTabType("kpi:definitions", tab("kpi", "/kpi-catalogue/:entityId+"))
    registerTabType("other:board", tab("other", "/other-board/:entityId"))
    registerTabType("kpi:sneaky", tab("kpi", "/settings/sneaky/:entityId"))
    try {
      await answerFrameCall("kpi", "navigate", ["/kpi-catalogue/metric/panier_moyen"], host)
      expect(host.navigate).toHaveBeenLastCalledWith("/kpi-catalogue/metric/panier_moyen")
      for (const path of ["/other-board/1", "/settings/sneaky/1", "/kpi-catalogue-x/1"]) {
        await expect(answerFrameCall("kpi", "navigate", [path], host)).rejects.toThrow(
          /not allowed/,
        )
      }
    } finally {
      unregisterTabTypes(["kpi:definitions", "other:board", "kpi:sneaky"])
    }
  })

  // L3: a settings page gets the normalized path only; a query or hash a frame adds
  // never reaches a page outside the app's own routes.
  it("navigate drops the query and hash outside the app's own routes", async () => {
    const host = fakeHost()
    await answerFrameCall("kpi", "navigate", ["/settings/connectors?next=/login/magic#x"], host)
    expect(host.navigate).toHaveBeenLastCalledWith("/settings/connectors")
    await answerFrameCall("kpi", "navigate", ["/settings/apps/kpi?tab=keys#top"], host)
    expect(host.navigate).toHaveBeenLastCalledWith("/settings/apps/kpi")
    await answerFrameCall("kpi", "navigate", ["/kpi/a b?range=7d"], host)
    expect(host.navigate).toHaveBeenLastCalledWith("/kpi/a%20b?range=7d")
  })

  // An outside app's "Edit credentials" button asks for /settings/apps: it gets its own
  // settings page, never the list of every app.
  it("navigate allows the detail pages of the app's own entities, and only its own", async () => {
    const host = fakeHost()
    await answerFrameCall("kpi", "navigate", ["/detail/kpi/metric/42"], host)
    expect(host.navigate).toHaveBeenLastCalledWith("/detail/kpi/metric/42")
    for (const path of ["/detail/other/metric/42", "/detail/kpi-other/x", "/detail"]) {
      await expect(answerFrameCall("kpi", "navigate", [path], host)).rejects.toThrow(/not allowed/)
    }
  })

  it("navigate maps /settings/apps to the calling app's own settings page", async () => {
    const host = fakeHost()
    await answerFrameCall("kpi", "navigate", ["/settings/apps"], host)
    expect(host.navigate).toHaveBeenLastCalledWith("/settings/apps/kpi")
    await answerFrameCall("kpi", "navigate", ["/settings/apps?all=1"], host)
    expect(host.navigate).toHaveBeenLastCalledWith("/settings/apps/kpi")
    await expect(answerFrameCall("kpi", "navigate", ["/settings/apps/"], host)).rejects.toThrow(
      /navigate: not allowed/,
    )
  })

  it("a method outside the list is kept, as an unsupported call with its id", async () => {
    expect(parseFrameMessage({ kind: "call", id: 1, method: "invoke", args: [] })).toEqual({
      kind: "unsupported",
      id: 1,
      method: "invoke",
    })
    expect(parseFrameMessage({ kind: "call", id: 2, method: "readCookies", args: [] })).toEqual({
      kind: "unsupported",
      id: 2,
      method: "readCookies",
    })
    // Without an id there is no one to answer.
    expect(parseFrameMessage({ kind: "call", method: "invoke", args: [] })).toBeNull()
    await expect(answerFrameCall("acme", "invoke", [], fakeHost())).rejects.toThrow(/unsupported/)
    expect(
      parseFrameMessage({ kind: "call", id: 1, method: "fetch", args: ["/api/me"] }),
    ).toMatchObject({ kind: "call", method: "fetch" })
  })

  it("a tab pattern the manifest declares outside /<app>/ gives navigate nothing", async () => {
    const host = fakeHost()
    const { frame } = mountView(host)
    const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
    fromFrame(frame, { kind: "call", id: 21, method: "navigate", args: ["/acme/board"] })
    fromFrame(frame, { kind: "call", id: 22, method: "navigate", args: ["/settings/computers"] })
    await vi.waitFor(() => expect(posted).toHaveBeenCalledTimes(2))
    expect(host.navigate).toHaveBeenCalledTimes(1)
    expect(host.navigate).toHaveBeenCalledWith("/acme/board")
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ id: 22, ok: false }), "*")
  })

  // A16: a frame built against a newer host gets an answer, never a hang.
  it("an unknown method is answered with unsupported and the method name, within 1 s", async () => {
    const host = fakeHost()
    const { frame } = mountView(host)
    const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
    fromFrame(frame, { kind: "call", id: 11, method: "unknownMethod", args: [] })
    await vi.waitFor(
      () =>
        expect(posted).toHaveBeenCalledWith(
          { kind: "result", id: 11, ok: false, error: "unsupported", method: "unknownMethod" },
          "*",
        ),
      { timeout: 1000 },
    )
  })
})

// L6: in a shell, a custom block whose export the bundle lacks shows the same
// admin card as in the browser, not a frame that says it failed.
describe("a missing export inside the shell", () => {
  it("the frame's missingExport message is ours", () => {
    expect(parseFrameMessage({ kind: "missingExport" })).toEqual({ kind: "missingExport" })
  })

  it("replaces the frame with the admin's missing-export card", async () => {
    const { frame, result } = mountView(fakeHost(), "AcmeSettingsPanel")
    fromFrame(frame, { kind: "missingExport" })
    const card = await result.findByTestId("settings-custom-missing-AcmeSettingsPanel")
    expect(card.textContent).toContain("AcmeSettingsPanel")
    expect(result.queryByTestId("isolated-app-frame")).toBeNull()
  })
})

describe("a browser tab's frame document (S16)", () => {
  it("is the server's, beside the app's bundle, under the bundle's token", () => {
    expect(
      browserAppFrameUrl(new URL("https://box.example.com/api/apps/acme/1.2.0/ui.js?t=a%2Bb#x")),
    ).toBe("https://box.example.com/api/apps/acme/1.2.0/frame?t=a%2Bb")
  })

  it("is none for a bundle URL of any other shape", () => {
    expect(browserAppFrameUrl(new URL("https://box.example.com/static/acme.js"))).toBeNull()
    expect(browserAppFrameUrl(new URL("https://box.example.com/api/apps/acme/ui.js"))).toBeNull()
    expect(
      browserAppFrameUrl(new URL("https://box.example.com/api/apps/Acme/1.0.0/ui.js")),
    ).toBeNull()
  })
})

describe("a frame that navigates away from its document", () => {
  it("a second load stops every post: the page no longer answers whatever now holds the frame", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const host = fakeHost()
    const { frame, result } = mountView(host)
    const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
    frame.dispatchEvent(new Event("load"))
    fromFrame(frame, { kind: "ready" })
    await vi.waitFor(() =>
      expect(posted.mock.calls.some((c) => (c[0] as { kind: string }).kind === "init")).toBe(true),
    )
    // The app sent the frame elsewhere: its window loads a second document.
    frame.dispatchEvent(new Event("load"))
    posted.mockClear()
    fromFrame(frame, { kind: "ready" })
    fromFrame(frame, { kind: "call", id: 9, method: "fetch", args: ["/api/apps/acme/orders"] })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(posted).not.toHaveBeenCalled()
    expect(host.fetch).not.toHaveBeenCalled()
    // The frame is gone, with the reason in the console.
    expect(result.queryByTestId("isolated-app-frame")).toBeNull()
    expect(result.getByTestId("isolated-app-stopped")).toBeTruthy()
    expect(error.mock.calls.some((c) => String(c[0]).includes("navigated away"))).toBe(true)
  })
})

/** A bundle-token-shaped value whose payload expires at `exp` (seconds). */
function tokenExpiringAt(exp: number): string {
  const part = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "")
  return `${part({ alg: "HS256" })}.${part({ name: "acme", version: "1.0.0", exp })}.sig`
}

describe("a stale bundle token at mount", () => {
  const BASE = "https://box.example.com/api/apps/acme/1.0.0"

  function mountWith(
    token: string,
    freshUrls: () => Promise<{ bundleUrl: string; frameUrl: string } | null>,
  ) {
    const loadSource = vi.fn(async () => "export const AcmeHome = () => null")
    const exports = isolatedAppExports(manifest, {
      app: "acme",
      bundleUrl: `${BASE}/ui.js?t=${token}`,
      frameUrl: `${BASE}/frame?t=${token}`,
      host: () => fakeHost(),
      loadSource,
      freshUrls,
    })
    const View = exports.AcmeHome as (props: Record<string, unknown>) => unknown
    const result = render(() => View({ entityId: "e-1" }) as never)
    return { result, loadSource }
  }

  it("a mount after the token's life is nearly over fetches fresh URLs first", async () => {
    const stale = tokenExpiringAt(Math.floor(Date.now() / 1000) + 30)
    const freshUrls = vi.fn(async () => ({
      bundleUrl: `${BASE}/ui.js?t=fresh`,
      frameUrl: `${BASE}/frame?t=fresh`,
    }))
    const { result, loadSource } = mountWith(stale, freshUrls)
    const frame = await vi.waitFor(() => result.getByTestId("isolated-app-frame"))
    expect(frame.getAttribute("src")).toBe(`${BASE}/frame?t=fresh`)
    expect(freshUrls).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(loadSource).toHaveBeenCalledWith(`${BASE}/ui.js?t=fresh`))
  })

  it("control: a token with life left mounts at once, with no refetch", async () => {
    const live = tokenExpiringAt(Math.floor(Date.now() / 1000) + 3600)
    const freshUrls = vi.fn(async () => null)
    const { result, loadSource } = mountWith(live, freshUrls)
    expect(result.getByTestId("isolated-app-frame").getAttribute("src")).toBe(
      `${BASE}/frame?t=${live}`,
    )
    await vi.waitFor(() => expect(loadSource).toHaveBeenCalledWith(`${BASE}/ui.js?t=${live}`))
    expect(freshUrls).not.toHaveBeenCalled()
  })
})

// App screens on an origin of their own (LIAISON_APP_FRAME_ORIGIN_TEMPLATE).
describe("a frame on the app's own origin", () => {
  const OWN = "https://acme--org.usercontent.test"

  function mountBound(host: IsolatedHost) {
    const exports = isolatedAppExports(manifest, {
      app: "acme",
      bundleUrl: `${window.location.origin}/api/apps/acme/1.0.0/ui.js`,
      frameUrl: `${OWN}/frame/1.0.0?t=x`,
      originBound: true,
      host: () => host,
      loadSource: async () => "export const AcmeHome = () => null",
    })
    const View = exports.AcmeHome as (props: Record<string, unknown>) => unknown
    const result = render(() => View({}) as never)
    return result.getByTestId("isolated-app-frame") as HTMLIFrameElement
  }

  it("keeps its origin (allow-same-origin) only there; every other frame stays opaque", () => {
    const bound = mountBound(fakeHost())
    expect(bound.getAttribute("sandbox")).toBe(ORIGIN_BOUND_APP_SANDBOX)
    expect(ORIGIN_BOUND_APP_SANDBOX).toBe("allow-scripts allow-forms allow-same-origin")
    const { frame } = mountView(fakeHost())
    expect(frame.getAttribute("sandbox")).toBe(ISOLATED_APP_SANDBOX)
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin")
    // A frame URL on the page's own origin is never treated as an own-origin frame.
    const exports = isolatedAppExports(manifest, {
      app: "acme",
      bundleUrl: `${window.location.origin}/api/apps/acme/1.0.0/ui.js`,
      frameUrl: `${window.location.origin}/api/apps/acme/1.0.0/frame?t=x`,
      originBound: true,
      host: () => fakeHost(),
      loadSource: async () => "",
    })
    const View = exports.AcmeHome as (props: Record<string, unknown>) => unknown
    const same = render(() => View({}) as never)
      .getAllByTestId("isolated-app-frame")
      .at(-1)
    expect(same?.getAttribute("sandbox")).toBe(ISOLATED_APP_SANDBOX)
  })

  it("posts to the frame's exact origin and ignores a message from any other origin", async () => {
    const host = fakeHost()
    const frame = mountBound(host)
    const posted = vi.spyOn(frame.contentWindow as Window, "postMessage")
    const call = { kind: "call", id: 5, method: "invokeTool", args: ["list", {}] }
    window.dispatchEvent(
      new MessageEvent("message", {
        data: call,
        source: frame.contentWindow,
        origin: "https://evil.test",
      }),
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(host.invokeTool).not.toHaveBeenCalled()
    window.dispatchEvent(
      new MessageEvent("message", { data: call, source: frame.contentWindow, origin: OWN }),
    )
    await vi.waitFor(() =>
      expect(posted).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), OWN),
    )
    expect(host.invokeTool).toHaveBeenCalledWith("acme", "list", {})
  })
})

describe("the typed host calls a frame may make (host API 1.3)", () => {
  function typedHost() {
    return {
      ...fakeHost(),
      openFileById: vi.fn(async () => {}),
      listDocumentTemplates: vi.fn(async () => [{ id: "tpl-1", name: "Label" }]),
      printDocuments: vi.fn(async () => ({
        files: [{ fileId: "printed-file-0001", filename: "a.pdf" }],
      })),
      listMyApprovals: vi.fn(async () => [
        { id: "a1", toolName: "acme:ship" },
        { id: "a2", toolName: "other:refund" },
      ]),
      decideApproval: vi.fn(async () => ({ status: "approved" })),
      openExternal: vi.fn(async () => {}),
      openRecord: vi.fn(),
      openApprovals: vi.fn(),
    }
  }

  it("openFile: a file this frame's own results showed, or one attached to its records, never another", async () => {
    const host = typedHost()
    host.invokeTool.mockResolvedValueOnce({ rows: [{ label_file_id: "seen-file-0001" }] })
    const state = frameCallState(["shipment"])
    state.fileApp = vi.fn(async (id: string) => (id === "own-record-file1" ? "acme" : "other"))
    await answerFrameCall("acme", "invokeTool", ["list", {}], host, undefined, state)
    await answerFrameCall(
      "acme",
      "openFile",
      ["seen-file-0001", "label.pdf"],
      host,
      undefined,
      state,
    )
    expect(host.openFileById).toHaveBeenCalledWith("acme", "seen-file-0001", "label.pdf")
    await answerFrameCall("acme", "openFile", ["own-record-file1", "x.pdf"], host, undefined, state)
    await expect(
      answerFrameCall("acme", "openFile", ["foreign-file-001", "x.pdf"], host, undefined, state),
    ).rejects.toThrow(/not a file of this app/)
    await expect(
      answerFrameCall("acme", "openFile", ["../../etc", "x"], host, undefined, state),
    ).rejects.toThrow(/file id/)
    expect(host.openFileById).toHaveBeenCalledTimes(2)
  })

  it("print and templates: only the app's own record types; printed files become its to open", async () => {
    const host = typedHost()
    const state = frameCallState(["shipment"])
    state.fileApp = vi.fn(async () => null)
    await expect(
      answerFrameCall("acme", "listDocumentTemplates", ["invoice"], host, undefined, state),
    ).rejects.toThrow(/record types/)
    await expect(
      answerFrameCall(
        "acme",
        "printDocuments",
        [{ entity: "document", id: "d1", templateIds: ["t"] }],
        host,
        undefined,
        state,
      ),
    ).rejects.toThrow(/records/)
    expect(host.printDocuments).not.toHaveBeenCalled()
    await answerFrameCall("acme", "listDocumentTemplates", ["shipment"], host, undefined, state)
    expect(host.listDocumentTemplates).toHaveBeenCalledWith("acme", "shipment")
    await answerFrameCall(
      "acme",
      "printDocuments",
      [{ entity: "shipment", id: "s1", templateIds: ["tpl-1"], merge: true }],
      host,
      undefined,
      state,
    )
    expect(host.printDocuments).toHaveBeenCalledWith("acme", {
      entity: "shipment",
      id: "s1",
      templateIds: ["tpl-1"],
      merge: true,
    })
    await answerFrameCall(
      "acme",
      "openFile",
      ["printed-file-0001", "a.pdf"],
      host,
      undefined,
      state,
    )
    expect(host.openFileById).toHaveBeenCalledTimes(1)
  })

  it("approvals: only the app's own, and a decision always goes through the host (its own confirm)", async () => {
    const host = typedHost()
    expect(await answerFrameCall("acme", "listMyApprovals", [], host)).toEqual([
      { id: "a1", toolName: "acme:ship" },
    ])
    await answerFrameCall("acme", "decideApproval", ["a1", "approve", "hash-1"], host)
    expect(host.decideApproval).toHaveBeenCalledWith("acme", "a1", "approve", "hash-1")
    await expect(answerFrameCall("acme", "decideApproval", ["a1", "yes"], host)).rejects.toThrow()
  })

  it("openExternal, openRecord and openApprovals are bound to the calling app", async () => {
    const host = typedHost()
    await answerFrameCall("acme", "openExternal", ["https://admin.acme.test/x"], host)
    expect(host.openExternal).toHaveBeenCalledWith("acme", "https://admin.acme.test/x")
    await answerFrameCall("acme", "openRecord", ["invoicing", "document", "d1"], host)
    expect(host.openRecord).toHaveBeenCalledWith("acme", "invoicing", "document", "d1")
    await answerFrameCall("acme", "openApprovals", [], host)
    expect(host.openApprovals).toHaveBeenCalled()
  })
})
