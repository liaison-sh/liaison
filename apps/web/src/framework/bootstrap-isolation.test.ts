// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D11, S13, D7: THE RULE `loadManifestApps` IMPLEMENTS for an installed app's UI.
// Code the server chose never runs in a shell's main frame on the server's
// word:
// - desktop: a first-party app the server lists as signed runs in the page
//   only from the bytes the SHELL verified (a `liaison-app:` URL), registered
//   from the signed manifest; any refusal, disagreement or load failure runs it
//   in the sandboxed frame instead;
// - desktop and phone: every other UI is the sandboxed frame, and a shell with
//   no frame does not load it at all (no `import()` of a server bundle);
// - phone: no verifier, so first-party apps are framed too (D7);
// - a browser tab imports a first-party app's bundle from its own origin, and
//   frames every other app in the document the server serves beside its bundle
//   (`.../<version>/frame`, S16): an outside app's code never runs in the page.
import { render } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getConnectorApps, getTabType, resetRegistry, urlToTabInfo } from "~/framework/app-registry"
import { loadManifestApps, resetBootstrap } from "~/framework/bootstrap"
import { compatModeApps } from "~/framework/compat-mode"
import { appDisplayNames } from "~/lib/capability-copy"
import { DESKTOP_BRIDGE_KEY, DESKTOP_BRIDGE_VERSION } from "~/lib/desktop-shell-contract"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"

const loaded = vi.hoisted(() => ({
  urls: [] as string[],
  SignedHome: () => null,
  /** Answers per URL; anything absent fails like a real import would here. */
  modules: new Map<string, Record<string, unknown>>(),
}))

vi.mock("~/framework/verified-app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/framework/verified-app")>()
  return {
    ...actual,
    importAppModule: async (url: string) => {
      loaded.urls.push(url)
      const module = loaded.modules.get(url)
      if (!module) throw new Error(`cannot import ${url}`)
      return module
    },
  }
})

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const SERVER = "https://box.example.com"
const FRAME = "liaison-frame://localhost/"
const SHA = "a".repeat(64)
const VERIFIED_URL = `liaison-app://localhost/${SHA}.js`

function manifestOf(name: string, component: string, version = "1.0.0") {
  return {
    name,
    version,
    displayName: `${name} (server)`,
    views: {
      tabTypes: { home: { component, urlPattern: `/${name}` } },
      activityBar: { icon: `${component}Icon`, label: name, order: 90 },
    },
  }
}

function serveManifests(
  entries: Array<{
    name: string
    component: string
    version?: string
    signed?: boolean
    firstParty?: boolean
    /** The bundle URL's query (an outside app's token). */
    query?: string
    manifest?: Record<string, unknown>
  }>,
) {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: entries.map(
            ({ name, component, version, signed, firstParty, query, manifest }) => ({
              name,
              ...(firstParty || signed ? { firstParty: true } : {}),
              ...(signed ? { signed: true } : {}),
              manifest: manifest ?? manifestOf(name, component, version ?? "1.0.0"),
              uiBundleUrl: `/api/apps/${name}/${version ?? "1.0.0"}/ui.js${query ?? ""}`,
            }),
          ),
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  )
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

/** A desktop shell whose verifier answers `answer` (or throws). */
function desktopShell(
  answer: (name: string, version: string) => Promise<unknown>,
): ReturnType<typeof vi.fn> {
  const verify = vi.fn(answer)
  vi.stubGlobal("__LIAISON_SERVER_ADDRESS__", SERVER)
  vi.stubGlobal("__LIAISON_APP_FRAME_URL__", FRAME)
  vi.stubGlobal(DESKTOP_BRIDGE_KEY, {
    version: DESKTOP_BRIDGE_VERSION,
    platform: "macos",
    verifyFirstPartyApp: verify,
  })
  return verify
}

/** The signed manifest the shell answers: same presence as the server's, its own display name. */
function signedManifest(name = "boxtal", version = "1.0.0") {
  return {
    ...manifestOf(name, "SignedHome", version),
    displayName: `${name} (signed)`,
    host: "^1",
    routes: ["/signed-only"],
  }
}

async function load(): Promise<string[]> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  resetRegistry()
  resetBootstrap()
  setTokens("fake-token")
  await loadManifestApps()
  return warn.mock.calls.map((args) => String(args[0]))
}

function expectFramed(app: string, fetchMock: ReturnType<typeof vi.fn>, version = "1.0.0") {
  const view = getTabType(`${app}:home`)?.component as ((p: object) => never) | undefined
  if (!view) throw new Error(`${app}:home was not registered`)
  expect(view).not.toBe(loaded.SignedHome)
  fetchMock.mockImplementation(async () => new Response("export const X = () => null"))
  const { getByTestId } = render(() => view({ entityId: "x" }))
  const frame = getByTestId("isolated-app-frame")
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms")
  return vi.waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(`${SERVER}/api/apps/${app}/${version}/ui.js`),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
  clearAuth()
  vi.restoreAllMocks()
  loaded.urls.length = 0
  loaded.modules.clear()
  delete (globalThis as Record<string, unknown>).__LIAISON_APP_FRAME_URL__
  delete (globalThis as Record<string, unknown>).__LIAISON_NATIVE__
  delete (globalThis as Record<string, unknown>)[DESKTOP_BRIDGE_KEY]
})

describe("a signed first-party app in the desktop shell", () => {
  it("verified by the shell: imports the liaison-app URL in the page, registered from the signed manifest", async () => {
    const verify = desktopShell(async () => ({
      url: VERIFIED_URL,
      sha256: SHA,
      manifest: signedManifest(),
    }))
    loaded.modules.set(VERIFIED_URL, {
      SignedHome: loaded.SignedHome,
      SignedHomeIcon: () => null,
    })
    // The server's copy claims more than the signed one: a route and a connector kind.
    serveManifests([
      {
        name: "boxtal",
        component: "SignedHome",
        signed: true,
        manifest: {
          ...manifestOf("boxtal", "SignedHome"),
          kind: "connector",
          routes: ["/server-only"],
          settings: { sections: [{ id: "s", title: "S", blocks: [] }] },
        },
      },
    ])
    const warnings = await load()
    expect(verify).toHaveBeenCalledWith("boxtal", "1.0.0")
    // Only the verified bytes were imported; nothing from the server.
    expect(loaded.urls).toEqual([VERIFIED_URL])
    expect(warnings).toEqual([])
    expect(getTabType("boxtal:home")?.component).toBe(loaded.SignedHome)
    // A9: what the app registers is the signed manifest's, not the API's.
    expect(appDisplayNames().boxtal).toBe("boxtal (signed)")
    // ...every key of it: the server's routes and kind never reach an in-page app.
    expect(urlToTabInfo("/server-only")).toBeNull()
    expect(urlToTabInfo("/signed-only")?.type).toBe("boxtal:home")
    expect(getConnectorApps().some((c) => c.appId === "boxtal")).toBe(false)
    // A server version newer than anything this build knew is no compatibility case.
    expect(compatModeApps()).toEqual([])
  })

  it("a refusal (unsigned bytes, unpinned key, tampered, revoked) runs it in the frame", async () => {
    const verify = desktopShell(async () => null)
    const fetchMock = serveManifests([{ name: "boxtal", component: "SignedHome", signed: true }])
    const warnings = await load()
    expect(verify).toHaveBeenCalledTimes(1)
    expect(loaded.urls).toEqual([])
    expect(warnings.some((m) => m.includes("failed to load UI bundle"))).toBe(false)
    await expectFramed("boxtal", fetchMock)
  })

  it("a verifier that throws runs it in the frame, never a broken app", async () => {
    desktopShell(async () => {
      throw new Error("shell refused")
    })
    const fetchMock = serveManifests([{ name: "boxtal", component: "SignedHome", signed: true }])
    await load()
    expect(loaded.urls).toEqual([])
    await expectFramed("boxtal", fetchMock)
  })

  it("an API manifest that disagrees with the signed one runs it in the frame", async () => {
    desktopShell(async () => ({ url: VERIFIED_URL, sha256: SHA, manifest: signedManifest() }))
    loaded.modules.set(VERIFIED_URL, { SignedHome: loaded.SignedHome })
    const api = manifestOf("boxtal", "SignedHome")
    // A route of its own (a Liaison page route would be refused outright, app-tab-routes.ts),
    // just not the one the signed manifest declares.
    api.views.tabTypes = {
      home: { component: "SignedHome", urlPattern: "/boxtal/elsewhere" },
    }
    const fetchMock = serveManifests([
      { name: "boxtal", component: "SignedHome", signed: true, manifest: api },
    ])
    const warnings = await load()
    expect(loaded.urls).toEqual([])
    expect(warnings.some((m) => m.includes("differs from the signed one (views)"))).toBe(true)
    await expectFramed("boxtal", fetchMock)
  })

  it("a signed manifest for another version, or a URL off the shell's scheme, runs it in the frame", async () => {
    const verify = desktopShell(async () => ({
      url: VERIFIED_URL,
      sha256: SHA,
      manifest: signedManifest("boxtal", "0.9.0"),
    }))
    serveManifests([{ name: "boxtal", component: "SignedHome", signed: true }])
    await load()
    expect(loaded.urls).toEqual([])
    verify.mockImplementation(async () => ({
      url: `${SERVER}/api/apps/boxtal/1.0.0/ui.js`,
      sha256: SHA,
      manifest: signedManifest(),
    }))
    const fetchMock = serveManifests([{ name: "boxtal", component: "SignedHome", signed: true }])
    await load()
    expect(loaded.urls).toEqual([])
    await expectFramed("boxtal", fetchMock)
  })

  it("a verified bundle the webview cannot load still renders, in the frame", async () => {
    desktopShell(async () => ({ url: VERIFIED_URL, sha256: SHA, manifest: signedManifest() }))
    // No module registered for the URL: the import fails.
    const fetchMock = serveManifests([{ name: "boxtal", component: "SignedHome", signed: true }])
    const warnings = await load()
    expect(loaded.urls).toEqual([VERIFIED_URL])
    expect(warnings.some((m) => m.includes("verified UI did not load in the page"))).toBe(true)
    await expectFramed("boxtal", fetchMock)
  })

  it("an app the server does not list as signed is never sent to the verifier, and is framed", async () => {
    const verify = desktopShell(async () => ({
      url: VERIFIED_URL,
      sha256: SHA,
      manifest: signedManifest(),
    }))
    const fetchMock = serveManifests([{ name: "boxtal", component: "SignedHome" }])
    await load()
    expect(verify).not.toHaveBeenCalled()
    expect(loaded.urls).toEqual([])
    await expectFramed("boxtal", fetchMock)
  })
})

describe("an installed app's UI inside the desktop shell", () => {
  it("any other installed app renders in the sandboxed frame, and no bundle is imported", async () => {
    vi.stubGlobal("__LIAISON_SERVER_ADDRESS__", SERVER)
    vi.stubGlobal("__LIAISON_APP_FRAME_URL__", FRAME)
    const fetchMock = serveManifests([{ name: "acme", component: "AcmeHome" }])
    const warnings = await load()
    // Isolation is how a third-party app always runs: not compatibility mode.
    expect(compatModeApps()).toEqual([])
    expect(warnings.some((m) => m.includes("failed to load UI bundle"))).toBe(false)
    expect(loaded.urls).toEqual([])
    const view = getTabType("acme:home")?.component as ((p: object) => never) | undefined
    if (!view) throw new Error("acme:home was not registered")
    fetchMock.mockImplementation(async () => new Response("export const AcmeHome = () => null"))
    const { getByTestId } = render(() => view({ entityId: "x" }))
    const frame = getByTestId("isolated-app-frame")
    expect(frame.getAttribute("src")).toBe(FRAME)
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms")
    // The page fetched the bundle's TEXT for the frame from the bound server;
    // it never imported it.
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`${SERVER}/api/apps/acme/1.0.0/ui.js`),
    )
  })

  it("a frame URL that is not the shell's own scheme isolates nothing, so the app is not loaded", async () => {
    vi.stubGlobal("__LIAISON_SERVER_ADDRESS__", SERVER)
    vi.stubGlobal("__LIAISON_APP_FRAME_URL__", "https://evil.example.com/frame")
    serveManifests([{ name: "acme", component: "AcmeHome" }])
    const warnings = await load()
    expect(getTabType("acme:home")).toBeUndefined()
    expect(loaded.urls).toEqual([])
    expect(warnings.filter((m) => m.includes('Manifest app "acme": not loaded'))).toHaveLength(1)
  })
})

describe("an installed app's UI inside the mobile shell (D7)", () => {
  // The phone's shell publishes its bridge (`__LIAISON_NATIVE__`) and ships the
  // frame document beside the page (`app-frame.html`, scripts/build-app-frame.ts).
  const MOBILE_FRAME = `${window.location.origin}/app-frame.html`

  it("every app, a signed first-party one included, renders in the sandboxed frame", async () => {
    vi.stubGlobal("__LIAISON_SERVER_ADDRESS__", SERVER)
    vi.stubGlobal("__LIAISON_NATIVE__", {})
    const fetchMock = serveManifests([
      { name: "boxtal", component: "SignedHome", signed: true },
      { name: "acme", component: "AcmeHome" },
    ])
    const warnings = await load()
    // No verifier on the phone, no import of anything.
    expect(loaded.urls).toEqual([])
    expect(warnings.some((m) => m.includes("failed to load UI bundle"))).toBe(false)
    for (const app of ["boxtal", "acme"]) {
      const view = getTabType(`${app}:home`)?.component as ((p: object) => never) | undefined
      if (!view) throw new Error(`${app}:home was not registered`)
      fetchMock.mockImplementation(async () => new Response("export const X = () => null"))
      const { getAllByTestId } = render(() => view({ entityId: "x" }))
      const frame = getAllByTestId("isolated-app-frame").at(-1)
      expect(frame?.getAttribute("src")).toBe(MOBILE_FRAME)
      expect(frame?.getAttribute("sandbox")).toBe("allow-scripts allow-forms")
      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(`${SERVER}/api/apps/${app}/1.0.0/ui.js`),
      )
    }
  })
})

describe("controls: where no frame is published, and the browser", () => {
  it("a shell with no frame never imports a server bundle (A7): the app is not loaded", async () => {
    vi.stubGlobal("__LIAISON_SERVER_ADDRESS__", SERVER)
    serveManifests([
      { name: "boxtal", component: "SignedHome", signed: true },
      { name: "acme", component: "AcmeHome" },
    ])
    const warnings = await load()
    expect(loaded.urls).toEqual([])
    expect(getTabType("acme:home")).toBeUndefined()
    expect(getTabType("boxtal:home")).toBeUndefined()
    expect(
      warnings.filter((m) => m.includes("not loaded: this shell has no app frame")),
    ).toHaveLength(2)
  })

  it("a browser tab imports a first-party app's bundle from its own origin, in the page", async () => {
    const page = `${window.location.origin}/api/apps`
    loaded.modules.set(`${page}/boxtal/1.0.0/ui.js`, {
      SignedHome: loaded.SignedHome,
      SignedHomeIcon: () => null,
    })
    loaded.modules.set(`${page}/invoicing/1.0.0/ui.js`, {
      InvoicingHome: loaded.SignedHome,
      InvoicingHomeIcon: () => null,
    })
    serveManifests([
      { name: "boxtal", component: "SignedHome", signed: true },
      { name: "invoicing", component: "InvoicingHome", firstParty: true },
    ])
    const warnings = await load()
    expect(loaded.urls.sort()).toEqual([
      `${page}/boxtal/1.0.0/ui.js`,
      `${page}/invoicing/1.0.0/ui.js`,
    ])
    expect(getTabType("boxtal:home")?.component).toBe(loaded.SignedHome)
    expect(getTabType("invoicing:home")?.component).toBe(loaded.SignedHome)
    expect(warnings).toEqual([])
    expect(compatModeApps()).toEqual([])
  })

  it("a browser tab runs an outside app in the server's sandboxed frame, and never imports it (S16)", async () => {
    const origin = window.location.origin
    const fetchMock = serveManifests([{ name: "acme", component: "AcmeHome", query: "?t=tok%2Bx" }])
    const warnings = await load()
    // Nothing of the app's ran in the page.
    expect(loaded.urls).toEqual([])
    expect(warnings).toEqual([])
    expect(compatModeApps()).toEqual([])
    const view = getTabType("acme:home")?.component as ((p: object) => never) | undefined
    if (!view) throw new Error("acme:home was not registered")
    fetchMock.mockImplementation(async () => new Response("export const AcmeHome = () => null"))
    const { getByTestId } = render(() => view({ entityId: "x" }))
    const frame = getByTestId("isolated-app-frame")
    // The server's frame document for this app and version, under the bundle's token.
    expect(frame.getAttribute("src")).toBe(`${origin}/api/apps/acme/1.0.0/frame?t=tok%2Bx`)
    // An opaque origin: no session cookie, no storage, no API of its own.
    const flags = (frame.getAttribute("sandbox") ?? "").split(/\s+/)
    expect(flags).toContain("allow-scripts")
    expect(flags).not.toContain("allow-same-origin")
    // The page fetched the bundle's TEXT for the frame; it never imported it.
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/apps/acme/1.0.0/ui.js?t=tok%2Bx`),
    )
  })

  it("a frame mounted after its token nearly ran out asks the app list for fresh URLs", async () => {
    const origin = window.location.origin
    const part = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "")
    const stale = `${part({ alg: "HS256" })}.${part({ exp: Math.floor(Date.now() / 1000) + 10 })}.s`
    const fetchMock = serveManifests([
      { name: "acme", component: "AcmeHome", query: `?t=${stale}` },
    ])
    await load()
    const view = getTabType("acme:home")?.component as ((p: object) => never) | undefined
    if (!view) throw new Error("acme:home was not registered")
    fetchMock.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).endsWith("/apps/manifests")
        ? new Response(
            JSON.stringify({
              data: [
                {
                  name: "acme",
                  manifest: manifestOf("acme", "AcmeHome"),
                  uiBundleUrl: "/api/apps/acme/1.0.0/ui.js?t=fresh",
                },
              ],
            }),
            { headers: { "Content-Type": "application/json" } },
          )
        : new Response("export const AcmeHome = () => null"),
    )
    const { findByTestId } = render(() => view({ entityId: "x" }))
    const frame = await findByTestId("isolated-app-frame")
    expect(frame.getAttribute("src")).toBe(`${origin}/api/apps/acme/1.0.0/frame?t=fresh`)
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(`${origin}/api/apps/acme/1.0.0/ui.js?t=fresh`),
    )
  })

  it("a browser tab does not load an outside app whose bundle URL names no frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  name: "acme",
                  manifest: manifestOf("acme", "AcmeHome"),
                  uiBundleUrl: "/static/acme.js",
                },
              ],
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
      ),
    )
    const warnings = await load()
    expect(loaded.urls).toEqual([])
    expect(getTabType("acme:home")).toBeUndefined()
    expect(warnings.filter((m) => m.includes('Manifest app "acme": not loaded'))).toHaveLength(1)
  })
})
