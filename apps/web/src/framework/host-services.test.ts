// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerContribution, unregisterContributions } from "~/framework/app-registry"
import { EntityChangesTestAccess, notifyEntityChange } from "~/framework/entity-changes"
import { buildHostServices } from "~/framework/host-services"
import { requestResync } from "~/framework/resync"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { appsStore } from "~/modules/settings/apps-store"
import { connectDialogRequest, settleConnectDialog } from "~/modules/settings/connect-dialog-host"

interface RecordedCall {
  method: string
  path: string
  body?: string | null
  hasAuth: boolean
}

const originalFetch = globalThis.fetch
let calls: RecordedCall[]
let nextResponse: () => Response

beforeEach(() => {
  calls = []
  nextResponse = () =>
    new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ;(globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      method: (init?.method ?? "GET").toUpperCase(),
      path: typeof url === "string" ? url : String(url),
      body: typeof init?.body === "string" ? init.body : null,
      hasAuth: Boolean((init?.headers as Record<string, string> | undefined)?.Authorization),
    })
    return nextResponse()
  })
})

afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: test stub
  ;(globalThis as any).fetch = originalFetch
})

describe("buildHostServices", () => {
  it("accessToken accessor reads live (token rotation is visible)", () => {
    let current: string | null = "first"
    const host = buildHostServices({
      getAccessToken: () => current,
      onUnauthorized: () => {},
      onError: () => {},
    })
    expect(host.accessToken()).toBe("first")
    current = "second"
    expect(host.accessToken()).toBe("second")
  })

  it("fetch GET injects Authorization header and unwraps envelope", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok-123",
      onUnauthorized: () => {},
      onError: () => {},
    })
    const r = await host.fetch("/api/me")
    expect(r).toEqual({ ok: true })
    expect(calls[0].path).toContain("/api/me")
    expect(calls[0].method).toBe("GET")
    expect(calls[0].hasAuth).toBe(true)
  })

  it("invokeTool POSTs to /api/apps/<appName>/tools/<toolName>", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
    })
    await host.invokeTool("shopify", "staff_overrides_upsert", { liaisonUserId: "u1" })
    expect(calls[0].path).toContain("/api/apps/shopify/tools/staff_overrides_upsert")
    expect(calls[0].method).toBe("POST")
    expect(JSON.parse(calls[0].body ?? "{}").params.liaisonUserId).toBe("u1")
  })

  it("invokeTool keeps a tool parameter named params beside the others", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
    })
    await host.invokeTool("api-connector", "settings_adapter_test", {
      identifier: "crm",
      operation: "find_customers",
      params: { email: "a@b.example" },
      threadId: "t-1",
    })
    const body = JSON.parse(calls[0].body ?? "{}")
    expect(body.params).toEqual({
      identifier: "crm",
      operation: "find_customers",
      params: { email: "a@b.example" },
      threadId: "t-1",
    })
    expect(body.threadId).toBe("t-1")
  })

  it("invokeTool failure rejects WITHOUT firing the global error toast", async () => {
    // A tool call is PROGRAMMATIC — the calling app UI handles its own failures
    // (e.g. boxtal Shipments `fetchShipments` catches → []). A transient 504 from
    // worker-pool load must NOT surface the global "Something went wrong." toast.
    // The promise still rejects so the caller can degrade gracefully.
    nextResponse = () =>
      new Response(JSON.stringify({ error: { message: "worker timeout" } }), {
        status: 504,
        headers: { "Content-Type": "application/json" },
      })
    const onError = vi.fn()
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError,
    })
    await expect(host.invokeTool("boxtal", "search", { q: "Bordeaux" })).rejects.toThrow()
    expect(onError).not.toHaveBeenCalled()
  })

  it("fetch failure STILL fires the global error toast (toasting path intact)", async () => {
    // Contrast with invokeTool: `host.fetch` is the generic kernel-route client and
    // keeps the global toast — only programmatic tool calls are silenced.
    nextResponse = () =>
      new Response(JSON.stringify({ error: { message: "boom" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
    const onError = vi.fn()
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError,
    })
    await expect(host.fetch("/api/me")).rejects.toThrow()
    expect(onError).toHaveBeenCalledWith(500, "Something went wrong. Try again.")
  })

  it("openConnect posts to resolved authorize route and navigates", async () => {
    nextResponse = () =>
      new Response(
        JSON.stringify({ data: { redirectUrl: "https://shop.myshopify.com/oauth?..." } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    const navigateSpy = vi.fn((_url: string) => {})
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
      navigate: navigateSpy,
      resolveAuthorizeRoute: (appName) => `/api/apps/${appName}/shop/authorize`,
    })
    await host.openConnect("shopify")
    expect(calls[0].path).toContain("/api/apps/shopify/shop/authorize")
    expect(navigateSpy).toHaveBeenCalledWith("https://shop.myshopify.com/oauth?...")
  })

  it("navigate delegates to the in-app SPA navigator (no full reload)", () => {
    const navSpy = vi.fn((_path: string) => {})
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
      inAppNavigate: navSpy,
    })
    host.navigate?.("/invoicing/document/123")
    expect(navSpy).toHaveBeenCalledWith("/invoicing/document/123")
  })

  it("openConnect default route resolves the app's declared connection and posts params", async () => {
    // First call: GET /api/apps/<app>/connections -> declared connections.
    // Second call: POST /api/connections/<app>/<conn>/authorize -> redirectUrl.
    const responses = [
      () =>
        new Response(JSON.stringify({ data: [{ name: "shop", type: "oauth2" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      () =>
        new Response(JSON.stringify({ data: { redirectUrl: "https://x.myshopify.com/oauth" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]
    nextResponse = () => (responses.shift() ?? (() => new Response("{}")))()
    const navigateSpy = vi.fn((_url: string) => {})
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
      navigate: navigateSpy,
    })
    await host.openConnect("shopify", { params: { shop: "x.myshopify.com", mode: "org" } })
    expect(calls[0].method).toBe("GET")
    expect(calls[0].path).toContain("/api/apps/shopify/connections")
    expect(calls[1].method).toBe("POST")
    expect(calls[1].path).toContain("/api/connections/shopify/shop/authorize")
    expect(JSON.parse(calls[1].body ?? "{}")).toEqual({ shop: "x.myshopify.com", mode: "org" })
    expect(navigateSpy).toHaveBeenCalledWith("https://x.myshopify.com/oauth")
  })

  it("openConnect skips connection discovery when the caller names the connection", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ data: { redirectUrl: "https://x.myshopify.com/oauth" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    const navigateSpy = vi.fn((_url: string) => {})
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
      navigate: navigateSpy,
    })
    await host.openConnect("shopify", { connectionName: "shop" })
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toContain("/api/connections/shopify/shop/authorize")
  })

  it("openConnect throws when the app declares no connection", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
    })
    await expect(host.openConnect("appless")).rejects.toThrow(/declares no connection/i)
  })

  it("openConnect throws when server returns no redirectUrl", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
    })
    await expect(host.openConnect("appless", { connectionName: "conn" })).rejects.toThrow(
      /no redirectUrl/i,
    )
  })

  it.each([
    ["absolute https URL", "https://attacker.example/steal"],
    ["absolute http URL", "http://attacker.example/steal"],
    ["protocol-relative URL", "//attacker.example/steal"],
    ["non-http scheme", "javascript:alert(1)"],
    ["data URI", "data:text/html,evil"],
    ["backslash-bypass", "/\\attacker.example/steal"],
    ["leading-space bypass", " //attacker.example/steal"],
    ["relative (no leading slash)", "api/me"],
  ])(
    "fetch REJECTS a non-kernel-relative path (%s) before reading the token or calling fetch",
    async (_label, badPath) => {
      // The guard must fire BEFORE the bearer token is read and BEFORE the
      // underlying client dispatches — otherwise an absolute path would carry
      // the user's token to an attacker origin (account takeover).
      const getAccessToken = vi.fn(() => "tok-secret")
      const host = buildHostServices({
        getAccessToken,
        onUnauthorized: () => {},
        onError: () => {},
      })
      await expect(host.fetch(badPath)).rejects.toThrow(/non-kernel-relative/i)
      // No network call was made…
      expect(calls.length).toBe(0)
      // …and the token was never read.
      expect(getAccessToken).not.toHaveBeenCalled()
    },
  )

  it("fetch STILL dispatches a legit kernel-relative /api/... path", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok-123",
      onUnauthorized: () => {},
      onError: () => {},
    })
    const r = await host.fetch("/api/me")
    expect(r).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toContain("/api/me")
    expect(calls[0].hasAuth).toBe(true)
  })

  it("fetch with non-JSON body throws loudly", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
    })
    // biome-ignore lint/suspicious/noExplicitAny: intentionally bad body type
    await expect(
      host.fetch("/api/x", { method: "POST", body: new FormData() as any }),
    ).rejects.toThrow(/unsupported body type/i)
  })
})

// Person-only actions (framework/person-only-actions.ts): an app UI calls the
// kernel with the person's token, so the host refuses the acts only a person
// may take (verifying a contact's address) before any request leaves.
describe("buildHostServices: person-only actions are refused to app UIs", () => {
  const C = "11111111-1111-4111-8111-111111111111"
  const A = "22222222-2222-4222-8222-222222222222"
  const body = JSON.stringify({ source: "email" })
  function host() {
    return buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
    })
  }

  it.each([
    `/api/contacts/${C}/addresses/${A}/verify`,
    `/api/contacts/${C}/addresses/${A}/verify/`,
    `/api/contacts/${C}/addresses/${A}/verify?x=1`,
    `/api//contacts/${C}/addresses/${A}/Verify`,
    `/api/contacts/${C}/addresses/${A}/%76erify`,
    `/api/contacts/${C}/addresses/${A}/stale/../verify`,
  ])("fetch POST %s is refused, no request sent", async (path) => {
    await expect(host().fetch(path, { method: "POST", body })).rejects.toThrow(
      /an app cannot verify a contact's address/,
    )
    expect(calls).toHaveLength(0)
  })

  it.each([
    ["/api/apps/tools/kernel:contacts_address_verify", "{}"],
    ["/api/apps/kernel/tools/contacts_address_verify", "{}"],
    ["/api/apps/tools/kernel__contacts_address_verify", "{}"],
    ["/api/apps/run-tool", JSON.stringify({ toolName: "kernel:contacts_address_verify" })],
  ])("fetch POST to the tool route %s is refused", async (path, payload) => {
    await expect(host().fetch(path, { method: "POST", body: payload })).rejects.toThrow(
      /an app cannot verify/,
    )
    expect(calls).toHaveLength(0)
  })

  it("invokeTool of the verify tool is refused, under any spelling", async () => {
    await expect(host().invokeTool("kernel", "contacts_address_verify", {})).rejects.toThrow(
      /an app cannot verify/,
    )
    await expect(host().invokeTool("boxtal", "kernel:contacts_address_verify", {})).rejects.toThrow(
      /an app cannot verify/,
    )
    expect(calls).toHaveLength(0)
  })

  it("the rest of the address book stays open to app UIs", async () => {
    await host().fetch(`/api/contacts/${C}/addresses`)
    await host().fetch(`/api/contacts/${C}/addresses`, { method: "POST", body: "{}" })
    await host().fetch(`/api/contacts/${C}/addresses/${A}/stale`, {
      method: "POST",
      body: JSON.stringify({ stale: true }),
    })
    await host().invokeTool("kernel", "contacts_addresses_list", { contactId: C })
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST", "POST", "POST"])
  })
})

describe("buildHostServices: fetchBlob under a native shell", () => {
  const SERVER = "https://liaison.example.test"
  // A real PDF prefix plus enough body to be a plausible document.
  const PDF_BYTES = new TextEncoder().encode(`%PDF-1.7\n${"0".repeat(4096)}\n%%EOF\n`)
  const SHELL_INDEX_HTML =
    "<!doctype html><html><head></head><body><div id=root></div></body></html>"

  beforeEach(() => {
    // What the desktop and mobile shells publish before the app loads.
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = SERVER
    // The shell's asset protocol: anything that is not the bound server gets
    // the bundle's index.html with a 200 (SPA fallback), exactly like
    // tauri://localhost and capacitor://localhost do.
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    ;(globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
      const u = typeof url === "string" ? url : String(url)
      calls.push({
        method: (init?.method ?? "GET").toUpperCase(),
        path: u,
        hasAuth: Boolean((init?.headers as Record<string, string> | undefined)?.Authorization),
      })
      if (u === `${SERVER}/api/files/f-1/inline`) {
        return new Response(PDF_BYTES, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        })
      }
      return new Response(SHELL_INDEX_HTML, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    })
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
  })

  it("reads the file from the bound server with the bearer: saved bytes are the PDF", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok-shell",
      onUnauthorized: () => {},
      onError: () => {},
    })
    const blob = await host.fetchBlob!("/api/files/f-1/inline")
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-")
    expect(bytes.byteLength).toBeGreaterThan(4000)
    expect(calls).toEqual([
      { method: "GET", path: `${SERVER}/api/files/f-1/inline`, hasAuth: true },
    ])
  })

  it("refuses a web page instead of handing it back as the file", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok-shell",
      onUnauthorized: () => {},
      onError: () => {},
    })
    await expect(host.fetchBlob!("/api/files/missing/inline")).rejects.toThrow(/web page/)
  })

  it("refuses a non kernel-relative path before the bearer leaves", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok-shell",
      onUnauthorized: () => {},
      onError: () => {},
    })
    await expect(host.fetchBlob!("https://evil.example/x")).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe("buildHostServices — mountSlot (cross-app slot body)", () => {
  const STUB = {
    getAccessToken: () => "tok",
    onUnauthorized: () => {},
    onError: () => {},
  }

  afterEach(() => {
    unregisterContributions("boxtal")
  })

  it("resolves a contributed component and renders it into the anchor with entityId", () => {
    // A fake Boxtal contribution registered under the 2-part registry key,
    // exactly as define-app registers nested `slots.<host>.<slot>.tabs[]`.
    // No JSX (this is a `.ts` file): return a real DOM node — valid Solid leaf.
    const FakeBody = (p: { entityId?: string }) => {
      const el = document.createElement("div")
      el.setAttribute("data-testid", "fake-shipment-body")
      el.textContent = `ref:${p.entityId ?? ""}`
      return el
    }
    registerContribution("invoicing.document_detail", {
      appId: "boxtal",
      id: "shipment",
      label: "Shipment",
      component: FakeBody,
    })
    const host = buildHostServices(STUB)
    const anchor = document.createElement("div")

    // Caller passes the 3-part server slot; the host normalizes to the
    // registry key. entityId is the invoicing document id.
    const handle = host.mountSlot!("invoicing", anchor, {
      slot: "invoicing.document_detail.tabs",
      app: "boxtal",
      id: "shipment",
      entityId: "inv_123",
    })

    expect(handle.resolved).toBe(true)
    expect(anchor.querySelector('[data-testid="fake-shipment-body"]')?.textContent).toBe(
      "ref:inv_123",
    )

    handle.dispose()
    expect(anchor.querySelector('[data-testid="fake-shipment-body"]')).toBeNull()
  })

  it("returns resolved:false (no throw, no render) on a registry miss", () => {
    const host = buildHostServices(STUB)
    const anchor = document.createElement("div")
    const handle = host.mountSlot!("invoicing", anchor, {
      slot: "invoicing.document_detail.tabs",
      app: "boxtal",
      id: "does-not-exist",
      entityId: "inv_123",
    })
    expect(handle.resolved).toBe(false)
    expect(anchor.childNodes.length).toBe(0)
    expect(() => handle.dispose()).not.toThrow()
  })

  it("createResource returns a resource that refetches on a resync bump", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
    })
    let call = 0
    const fetcher = vi.fn(async () => `v${++call}`)

    await createRoot(async (dispose) => {
      // Called synchronously inside an owner (as a plugin component body would).
      const [res] = host.createResource!<string>(fetcher)
      await flushMicrotasks()
      expect((res as () => string | undefined)()).toBe("v1")
      expect(fetcher).toHaveBeenCalledTimes(1)

      requestResync("host-test")
      await flushMicrotasks()
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect((res as () => string | undefined)()).toBe("v2")
      dispose()
    })
  })

  it("createResource disposes its subscriptions with the owner (no refetch after unmount)", async () => {
    const host = buildHostServices({
      getAccessToken: () => "tok",
      onUnauthorized: () => {},
      onError: () => {},
    })
    const fetcher = vi.fn(async () => "v")

    let disposeOuter!: () => void
    await createRoot(async (dispose) => {
      disposeOuter = dispose
      host.createResource!(fetcher)
      await flushMicrotasks()
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    disposeOuter()

    // After disposal, a bump must NOT refetch (owner-scoped effect gone).
    requestResync("after-dispose")
    await flushMicrotasks()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

describe("buildHostServices — onEntityChange (app UI live hook)", () => {
  const host = () =>
    buildHostServices({ getAccessToken: () => null, onUnauthorized: () => {}, onError: () => {} })
  const event = (key: string) => {
    const [app = "", entity = ""] = key.split(":")
    return { key, app, entity, action: "updated", data: { key } }
  }
  afterEach(() => EntityChangesTestAccess.reset())

  it("delivers the caller's own keys and kernel keys", () => {
    const seen: string[] = []
    const off = host().onEntityChange?.(
      "monitoring",
      ["monitoring:incident", "kernel:node"],
      (events) => seen.push(...events.map((e) => e.key)),
      { debounceMs: 0 },
    )
    notifyEntityChange(event("monitoring:incident"))
    notifyEntityChange(event("kernel:node"))
    expect(seen).toEqual(["monitoring:incident", "kernel:node"])
    off?.()
    notifyEntityChange(event("monitoring:incident"))
    expect(seen).toHaveLength(2)
  })

  it("drops another app's keys (and a bare wildcard) with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const seen: string[] = []
    host().onEntityChange?.(
      "monitoring",
      ["tickets:ticket", "*", "monitoring:*"],
      (events) => seen.push(...events.map((e) => e.key)),
      { debounceMs: 0 },
    )
    notifyEntityChange(event("tickets:ticket"))
    notifyEntityChange(event("monitoring:incident"))
    expect(seen).toEqual(["monitoring:incident"])
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it("all keys refused: no subscription and a no-op disposer", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const cb = vi.fn()
    const off = host().onEntityChange?.("monitoring", "tickets:ticket", cb, { debounceMs: 0 })
    notifyEntityChange(event("tickets:ticket"))
    requestResync("host-guard")
    expect(cb).not.toHaveBeenCalled()
    expect(() => off?.()).not.toThrow()
    warn.mockRestore()
  })
})

// The desktop webview opens no tab and its shell refuses `blob:` links, so an
// app's "open the PDF in a new tab" did nothing there. openFile hands the
// bytes to the shell instead; in a browser it declines so the app keeps its
// blob tab.
describe("buildHostServices: openFile", () => {
  const host = () =>
    buildHostServices({ getAccessToken: () => "tok", onUnauthorized: () => {}, onError: () => {} })
  const pdf = () => new Blob(["%PDF-1.7 label"], { type: "application/pdf" })

  afterEach(() => uninstallFakeBridge())

  it("in a browser declines, so the app opens its own blob tab", async () => {
    expect(await host().openFile!(pdf(), "label-01234567.pdf")).toBe(false)
  })

  it("under the desktop shell hands the bytes and the name to the shell to open", async () => {
    const shell = installFakeBridge({}, { platform: "windows" })
    expect(await host().openFile!(pdf(), "label-01234567.pdf")).toBe(true)
    expect(shell.calls.openedDownloadedFiles).toHaveLength(1)
    const [opened] = shell.calls.openedDownloadedFiles
    expect(opened!.name).toBe("label-01234567.pdf")
    expect(new TextDecoder().decode(opened!.bytes)).toBe("%PDF-1.7 label")
  })

  it("a shell that refused the file is an error the app can show, never a silent no-op", async () => {
    installFakeBridge({}, { platform: "windows", refuseDownloadedFile: true })
    await expect(host().openFile!(pdf(), "label-01234567.pdf")).rejects.toThrow(/could not open/)
  })

  it("a shell that predates the opener declines like a browser", async () => {
    installFakeBridge({}, { platform: "windows", withoutDownloadedFileOpener: true })
    expect(await host().openFile!(pdf(), "label-01234567.pdf")).toBe(false)
  })
})

describe("buildHostServices: openConnectDialog", () => {
  const host = () =>
    buildHostServices({ getAccessToken: () => "tok", onUnauthorized: () => {}, onError: () => {} })
  const gitlabConnections = () =>
    new Response(
      JSON.stringify({
        data: [
          {
            name: "gitlab",
            type: "credentials",
            credentialFields: [{ name: "token", label: "Token", type: "password" }],
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )

  beforeEach(() => appsStore.reset())
  afterEach(() => settleConnectDialog({ connected: false }))

  it("loads the app's connections, opens the kernel dialog and resolves when it reports success", async () => {
    nextResponse = gitlabConnections
    const opened = host().openConnectDialog!("gitlab", { connectionName: "gitlab" })
    await vi.waitFor(() => expect(connectDialogRequest()).not.toBeNull())
    // Started from an empty store: the host fetched the app's own connections.
    expect(calls[0]?.path).toContain("/api/apps/gitlab/connections")
    expect(connectDialogRequest()).toMatchObject({ appName: "gitlab", connectionName: "gitlab" })
    expect(connectDialogRequest()?.connConfig.credentialFields?.[0]?.name).toBe("token")
    settleConnectDialog({ connected: true })
    await expect(opened).resolves.toEqual({ connected: true })
    expect(connectDialogRequest()).toBeNull()
  })

  it("rejects a connection name the calling app does not declare", async () => {
    nextResponse = gitlabConnections
    await expect(host().openConnectDialog!("gitlab", { connectionName: "shop" })).rejects.toThrow(
      /not one of gitlab's connections/,
    )
    expect(connectDialogRequest()).toBeNull()
  })

  it("rejects an app that declares no connection", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    await expect(host().openConnectDialog!("appless")).rejects.toThrow(/declares no connection/)
  })
})
