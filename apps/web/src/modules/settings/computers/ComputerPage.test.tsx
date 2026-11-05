// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Computers > <computer>: back to the list, the name, "This
// computer", the status line, the switch that lets agents use it, and three
// tabs on their own paths (Folders, Agents, Settings). The Settings tab
// renames it and edits its workload (walk D23), shows "Ready to work" on this
// computer (its checks with Fix or Turn off, and the places the OS refuses
// with System Settings), and removes it after a confirmation (A25, walk N13).
// The former paths redirect: /settings/nodes[?node=&folder=] and
// /settings/this-computer. The node routes are mocked at fetch.
import { Route, Router, useNavigate } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import type { Component } from "solid-js"
import { Dynamic } from "solid-js/web"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopKeepAwake, DesktopNodeRecord } from "~/lib/desktop-shell-contract"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { nodeFoldersRoute } from "~/modules/nodes/node-folders-api"
import { NodeSessionTestAccess } from "~/modules/nodes/node-session"
import { resetNodesStore } from "~/modules/nodes/nodes-store"
import { resetSessionList } from "~/modules/sessions/session-list"
import { resetSessionStore } from "~/modules/sessions/session-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import ComputerPage from "./ComputerPage"
import { NodesRedirect, nodesRedirectTarget, ThisComputerRedirect } from "./ComputerRedirects"
import { parseComputerPath } from "./computer-model"

const SERVER = "https://a.example.com"
const SERVER_ADDRESS_GLOBAL = "__LIAISON_SERVER_ADDRESS__"

interface Fake {
  nodes: any[]
  denied: string[]
  /** Each computer's folders, by node id. */
  shared: Record<string, string[]>
  patchStatus: number
  calls: Array<{ url: string; method: string; body: unknown }>
}
let fake: Fake

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const mac = {
  id: "n-mac",
  name: "Studio Mac",
  maxLiveSessions: 4,
  maxLiveBackground: 2,
  enabled: true,
  online: true,
  lastSeenAt: null,
  os: "macos",
  appVersion: "0.1.18",
  deviceId: "d.mac",
  queue: { queued: 0, running: 0 },
}

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const method = (init?.method ?? "GET").toUpperCase()
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      fake.calls.push({ url, method, body })
      const path = new URL(url, "http://x").pathname
      if (path.endsWith("/nodes/me") && method === "GET") {
        return json({ data: { nodes: fake.nodes } })
      }
      if (path.endsWith("/nodes/me/attachments") || path.endsWith("/nodes/me/profiles")) {
        return json({ data: [] })
      }
      if (path.endsWith("/agents")) return json({ data: [] })
      if (/\/nodes\/[^/]+\/folders(\/unshare)?$/.test(path)) {
        const id = path.split("/nodes/")[1].split("/")[0]
        if (path.endsWith("/unshare")) {
          fake.shared[id] = (fake.shared[id] ?? []).filter((r) => r !== body.path)
        }
        return json({
          data: {
            shared: { roots: fake.shared[id] ?? [], isDefault: false, missing: [] },
            search: { roots: ["/Users/me"], display: ["~"], missing: [], denied: fake.denied },
          },
        })
      }
      if (/\/nodes\/[^/]+\/folders\/lookup$/.test(path)) {
        return json({
          data: {
            searchRoots: 1,
            candidates: [
              {
                id: "c-1",
                name: body.query,
                display: `~/code/${body.query}`,
                isRepo: true,
                shared: false,
                shareable: true,
              },
            ],
          },
        })
      }
      if (/\/nodes\/[^/]+$/.test(path) && method === "DELETE") {
        fake.nodes = fake.nodes.filter((n) => !path.endsWith(n.id))
        return new Response(null, { status: 204 })
      }
      if (/\/nodes\/[^/]+$/.test(path) && method === "PATCH" && fake.patchStatus !== 200) {
        return json({ error: { message: "boom" } }, fake.patchStatus)
      }
      if (/\/nodes\/[^/]+$/.test(path) && method === "PATCH") {
        fake.nodes = fake.nodes.map((n) => (path.endsWith(n.id) ? { ...n, ...body } : n))
        return json({ data: { node: fake.nodes.find((n) => path.endsWith(n.id)) } })
      }
      if (path.includes("/sessions")) return json({ data: [] })
      return json({ data: null }, 404)
    }),
  )
}

/** Navigates inside the rendered router, as a link in the app does. */
let go: (path: string) => void = () => {}
const Navigator: Component = () => {
  const navigate = useNavigate()
  go = (path) => navigate(path)
  return null
}

function renderAt(path: string, component: Component = ComputerPage) {
  window.history.pushState({}, "", path)
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <Navigator />
            <Dynamic component={component} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

beforeEach(() => {
  NodeSessionTestAccess.reset()
  fake = { nodes: [mac], denied: [], shared: {}, patchStatus: 200, calls: [] }
  installFetch()
})

afterEach(() => {
  cleanup()
  uninstallFakeBridge()
  delete (globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL]
  resetNodesStore()
  resetSessionStore()
  resetSessionList()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  window.history.pushState({}, "", "/")
})

describe("a computer's page", () => {
  it("back, name, status, switch, and three tabs on their own paths", async () => {
    renderAt("/settings/computers/n-mac")
    expect((await screen.findByRole("heading", { level: 1 })).textContent).toBe("Studio Mac")
    expect(screen.getByTestId("computer-page-status").textContent).toBe(
      "Online · 0 sessions running",
    )
    expect(screen.queryByTestId("computer-page-this")).toBeNull()
    expect(screen.getByTestId("computer-tab-folders").getAttribute("aria-current")).toBe("page")
    expect(await screen.findByTestId("computer-folders-n-mac")).toBeTruthy()
    fireEvent.click(screen.getByTestId("computer-tab-agents"))
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers/n-mac/agents"))
    expect(await screen.findByTestId("computer-agents")).toBeTruthy()
    expect(screen.getByTestId("computer-tab-agents").getAttribute("aria-current")).toBe("page")
    fireEvent.click(screen.getByTestId("computer-tab-settings"))
    expect(await screen.findByTestId("computer-settings")).toBeTruthy()
    // 44 px tab targets; the tab row scrolls rather than wraps at phone width.
    expect(screen.getByTestId("computer-tab-settings").className).toContain("min-h-11")
    fireEvent.click(screen.getByTestId("computer-back"))
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers"))
  })

  it("the switch turns another computer off with a PATCH", async () => {
    renderAt("/settings/computers/n-mac")
    fireEvent.click(await screen.findByTestId("computer-page-enabled"))
    await waitFor(() =>
      expect(fake.calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }),
    )
  })

  it("an unknown computer says it is gone", async () => {
    renderAt("/settings/computers/n-gone")
    expect(await screen.findByTestId("computer-gone")).toBeTruthy()
  })

  it("?folder= opens Add a folder searching for that name (a blocked card's Fix it)", async () => {
    renderAt(nodeFoldersRoute("n-mac", "liaison-monorepo"))
    const candidate = await screen.findByTestId("add-folder-candidate")
    expect(candidate.textContent).toContain("~/code/liaison-monorepo")
    expect((screen.getByTestId("add-folder-query") as HTMLInputElement).value).toBe(
      "liaison-monorepo",
    )
  })
})

describe("another computer's page, straight from this one", () => {
  const laptop = { ...mac, id: "n-b", name: "Laptop", os: "windows" }

  it("mounts its own tabs: its folders, its Add a folder search, its Remove", async () => {
    fake.nodes = [mac, laptop]
    fake.shared = { "n-mac": ["/Users/me/mac-only"], "n-b": ["/Users/me/laptop-only"] }
    renderAt("/settings/computers/n-mac")
    expect(await screen.findByTestId("computer-folder-remove-mac-only")).toBeTruthy()
    // A "Fix it" for the Laptop while the Mac's Folders tab is open.
    go(nodeFoldersRoute("n-b", "liaison-monorepo"))
    expect(await screen.findByTestId("computer-folders-n-b")).toBeTruthy()
    expect(screen.queryByTestId("computer-folders-n-mac")).toBeNull()
    expect(await screen.findByTestId("computer-folder-remove-laptop-only")).toBeTruthy()
    expect(screen.queryByTestId("computer-folder-remove-mac-only")).toBeNull()
    // Its Add a folder opened and searched on the Laptop.
    expect((await screen.findByTestId("add-folder-candidate")).textContent).toContain(
      "liaison-monorepo",
    )
    expect(fake.calls.some((c) => c.url.endsWith("/nodes/n-b/folders/lookup"))).toBe(true)
    expect(fake.calls.some((c) => c.url.endsWith("/nodes/n-mac/folders/lookup"))).toBe(false)
    fireEvent.click(screen.getByTestId("add-folder-close"))
    await waitFor(() => expect(screen.queryByTestId("add-folder-dialog")).toBeNull())
    fireEvent.click(screen.getByTestId("computer-folder-remove-laptop-only"))
    await waitFor(() =>
      expect(fake.calls.find((c) => c.url.endsWith("/unshare"))).toMatchObject({
        body: { path: "/Users/me/laptop-only" },
      }),
    )
    expect(fake.calls.find((c) => c.url.endsWith("/unshare"))?.url).toContain("/nodes/n-b/")
  })

  it("a second Fix it on the same computer searches the new name", async () => {
    fake.nodes = [mac]
    renderAt(nodeFoldersRoute("n-mac", "first"))
    expect((await screen.findByTestId("add-folder-candidate")).textContent).toContain("first")
    go(nodeFoldersRoute("n-mac", "second"))
    await waitFor(() =>
      expect(screen.getByTestId("add-folder-candidate").textContent).toContain("second"),
    )
  })
})

describe("the Settings tab", () => {
  it("renames the computer and edits its workload (walk D23)", async () => {
    renderAt("/settings/computers/n-mac/settings")
    const name = (await screen.findByTestId("node-name-input-n-mac")) as HTMLInputElement
    const live = screen.getByTestId("node-max-live-n-mac") as HTMLInputElement
    const background = screen.getByTestId("node-max-background-n-mac") as HTMLInputElement
    expect(name.value).toBe("Studio Mac")
    expect(live.value).toBe("4")
    expect(background.value).toBe("2")
    expect(screen.getByLabelText("Sessions at once")).toBe(live)
    // More for others than at once cannot be saved.
    fireEvent.input(background, { target: { value: "5" } })
    expect((screen.getByTestId("node-save-n-mac") as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId("node-settings-invalid-n-mac")).toBeTruthy()
    fireEvent.input(name, { target: { value: "Atelier Mac" } })
    fireEvent.input(live, { target: { value: "3" } })
    fireEvent.input(background, { target: { value: "1" } })
    fireEvent.click(screen.getByTestId("node-save-n-mac"))
    await waitFor(() =>
      expect(fake.calls.find((c) => c.method === "PATCH")?.body).toEqual({
        name: "Atelier Mac",
        maxLiveSessions: 3,
        maxLiveBackground: 1,
      }),
    )
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Atelier Mac"),
    )
  })

  it("Remove asks first, then deletes the computer so its credential stops working (A25)", async () => {
    renderAt("/settings/computers/n-mac/settings")
    fireEvent.click(await screen.findByTestId("computer-remove-n-mac"))
    expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false)
    expect(screen.getByTestId("computer-remove-confirm-text-n-mac").textContent).toContain(
      "credential stops working",
    )
    fireEvent.click(screen.getByTestId("computer-remove-confirm-n-mac"))
    await waitFor(() =>
      expect(fake.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/nodes/n-mac"))).toBe(
        true,
      ),
    )
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers"))
  })

  it("another computer shows no Ready to work", async () => {
    renderAt("/settings/computers/n-mac/settings")
    await screen.findByTestId("computer-settings")
    expect(screen.queryByTestId("computer-ready")).toBeNull()
  })
})

describe("this computer's page, in the desktop app", () => {
  let stored: DesktopNodeRecord | null
  let launch: boolean
  let awake: DesktopKeepAwake
  let opened: number

  beforeEach(() => {
    ;(globalThis as Record<string, unknown>)[SERVER_ADDRESS_GLOBAL] = SERVER
    fake.nodes = [{ ...mac, id: "n-1", name: "Mac" }]
    stored = { nodeId: "n-1", credential: "lnn_1", enabled: true }
    launch = true
    awake = { enabled: true, supported: true, nodeOn: true, power: "ac", held: true }
    opened = 0
    const handle = installFakeBridge({ claudeAccount: { loggedIn: true, email: null } })
    Object.assign(handle.bridge, {
      notificationDeviceId: () => "d.install",
      checkClaudeAccount: async () => ({ loggedIn: true, email: null }),
      notificationPermission: async () => "granted",
      launchAtLogin: async () => launch,
      setLaunchAtLogin: async (on: boolean) => {
        launch = on
        return on
      },
      keepAwake: async () => awake,
      setKeepAwake: async (enabled: boolean) => {
        awake = { ...awake, enabled }
        return awake
      },
      loadNodeCredential: async () => stored,
      storeNodeCredential: async (_s: string, n: DesktopNodeRecord | null) => {
        stored = n
      },
      openPrivacySettings: async () => {
        opened++
        return true
      },
    })
  })

  it("says This computer and that it is kept awake", async () => {
    renderAt("/settings/computers/n-1")
    expect(await screen.findByTestId("computer-page-this")).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByTestId("computer-page-status").textContent).toContain(
        "kept awake while plugged in",
      ),
    )
  })

  it("not fully set up: the setup checklist shows under the header, and turning it on from there registers it", async () => {
    stored = { nodeId: "n-1", credential: "lnn_1", enabled: false }
    fake.nodes = [{ ...mac, id: "n-1", name: "Mac", enabled: false }]
    launch = false
    renderAt("/settings/computers/n-1")
    const card = await screen.findByTestId("computer-setup")
    await waitFor(() =>
      expect(screen.getByTestId("computer-check-startup").getAttribute("data-state")).toBe("todo"),
    )
    // The header switch with a check to do: the checklist says why it waits.
    fireEvent.click(screen.getByTestId("computer-page-enabled"))
    await waitFor(() => expect(card.getAttribute("data-phase")).toBe("setup"))
    expect(fake.calls.some((c) => c.method === "PATCH")).toBe(false)
    fireEvent.click(screen.getByTestId("computer-fix-startup"))
    await waitFor(() => expect(screen.queryByTestId("computer-setup")).toBeNull())
    expect(fake.calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: true })
    expect(stored).toEqual({ nodeId: "n-1", credential: "lnn_1", enabled: true })
  })

  it("a refused registration is said under the header", async () => {
    stored = { nodeId: "n-1", credential: "lnn_1", enabled: false }
    fake.nodes = [{ ...mac, id: "n-1", name: "Mac", enabled: false }]
    fake.patchStatus = 500
    renderAt("/settings/computers/n-1")
    await screen.findByTestId("computer-page-this")
    await waitFor(() =>
      expect(screen.getByTestId("computer-page-enabled").getAttribute("aria-checked")).toBe(
        "false",
      ),
    )
    fireEvent.click(screen.getByTestId("computer-page-enabled"))
    expect(await screen.findByTestId("computer-setup-error")).toBeTruthy()
    expect(screen.getByTestId("computer-page-enabled").getAttribute("aria-checked")).toBe("false")
  })

  it("set up and on: no checklist", async () => {
    renderAt("/settings/computers/n-1")
    await screen.findByTestId("computer-page-this")
    await waitFor(() =>
      expect(screen.getByTestId("computer-page-enabled").getAttribute("aria-checked")).toBe("true"),
    )
    expect(screen.queryByTestId("computer-setup")).toBeNull()
  })

  it("Ready to work: each check, Turn off on one, and the place macOS refuses with System Settings", async () => {
    fake.denied = ["~/Documents"]
    renderAt("/settings/computers/n-1/settings")
    await waitFor(() =>
      expect(screen.getByTestId("computer-ready-launchAtLogin").getAttribute("data-state")).toBe(
        "done",
      ),
    )
    await waitFor(() =>
      expect(screen.getByTestId("computer-ready-keepAwake").textContent).toContain("awake now"),
    )
    fireEvent.click(screen.getByTestId("computer-ready-off-launchAtLogin"))
    await waitFor(() =>
      expect(screen.getByTestId("computer-ready-launchAtLogin").getAttribute("data-state")).toBe(
        "todo",
      ),
    )
    expect(launch).toBe(false)
    fireEvent.click(screen.getByTestId("computer-ready-fix-launchAtLogin"))
    await waitFor(() => expect(launch).toBe(true))
    const read = await screen.findByTestId("computer-ready-read")
    expect(read.textContent).toContain("Can read Documents")
    expect(read.textContent).toContain("macOS has not allowed it yet")
    fireEvent.click(screen.getByTestId("computer-ready-open-settings"))
    expect(opened).toBe(1)
  })

  it("its switch turns it off through the shell, keeping the credential", async () => {
    renderAt("/settings/computers/n-1")
    await screen.findByTestId("computer-page-this")
    await waitFor(() =>
      expect(screen.getByTestId("computer-page-enabled").getAttribute("aria-checked")).toBe("true"),
    )
    fireEvent.click(screen.getByTestId("computer-page-enabled"))
    await waitFor(() =>
      expect(stored).toEqual({ nodeId: "n-1", credential: "lnn_1", enabled: false }),
    )
  })

  it("removing it drops this computer's credential too", async () => {
    renderAt("/settings/computers/n-1/settings")
    fireEvent.click(await screen.findByTestId("computer-remove-n-1"))
    fireEvent.click(screen.getByTestId("computer-remove-confirm-n-1"))
    await waitFor(() => expect(stored).toBeNull())
  })

  it("/settings/this-computer lands on this computer's page", async () => {
    renderAt("/settings/this-computer", ThisComputerRedirect)
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers/n-1"))
  })
})

describe("former paths", () => {
  it("/settings/nodes?node=&folder= lands on that computer's Folders with the name", async () => {
    expect(nodesRedirectTarget({})).toBe("/settings/computers")
    expect(nodesRedirectTarget({ node: "n-1" })).toBe("/settings/computers/n-1")
    expect(nodesRedirectTarget({ node: "n-1", folder: "my app" })).toBe(
      "/settings/computers/n-1?folder=my+app",
    )
    renderAt("/settings/nodes?node=n-mac&folder=liaison-monorepo", NodesRedirect)
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers/n-mac"))
    expect(window.location.search).toBe("?folder=liaison-monorepo")
  })

  it("/settings/this-computer in a browser lands on the list", async () => {
    renderAt("/settings/this-computer", ThisComputerRedirect)
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers"))
  })

  it("a computer's path is read back with its tab", () => {
    expect(parseComputerPath("/settings/computers")).toBeNull()
    expect(parseComputerPath("/settings/computers/n-1")).toEqual({ nodeId: "n-1", tab: "folders" })
    expect(parseComputerPath("/settings/computers/n-1/agents")).toEqual({
      nodeId: "n-1",
      tab: "agents",
    })
    expect(parseComputerPath("/settings/computers/n-1/nope")).toBeNull()
  })
})
