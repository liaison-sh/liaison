// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The former paths of Settings > Computers through the real settings layout
// and its registered sections (bootstrap.ts): /settings/nodes with its
// `?node=&folder=` (links kept in notifications and old messages) and
// /settings/this-computer land on Computers, never on Profile.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import { resetNodesStore } from "~/modules/nodes/nodes-store"
import SettingsLayout from "~/modules/settings/SettingsLayout"
import { ApiProvider } from "~/modules/shell/ApiContext"
// Pre-imported so the sections' lazy() never races the assertions.
import "./ComputerPage"
import "./ComputerRedirects"
import "./ComputersSettings"

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  return `${header}.${btoa(JSON.stringify(payload))}.fake`
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const mac = {
  id: "n-mac",
  name: "Studio Mac",
  enabled: true,
  online: true,
  lastSeenAt: null,
  os: "macos",
  appVersion: null,
  deviceId: "d.mac",
  queue: { queued: 0, running: 0 },
}

function renderSettingsAt(path: string) {
  window.history.pushState({}, "", path)
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <SettingsLayout entityId="settings" />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

beforeEach(() => {
  clearAuth()
  resetRegistry()
  resetBootstrap()
  bootstrapKernelApps()
  setTokens(
    makeJwt({
      userId: "u1",
      orgId: "o1",
      name: "Owner",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "refresh",
  )
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url
      const path = new URL(url, "http://x").pathname
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (path.endsWith("/nodes/me")) return json({ data: { nodes: [mac] } })
      if (/\/nodes\/[^/]+\/folders$/.test(path)) {
        return json({
          data: {
            shared: { roots: [], isDefault: false, missing: [] },
            search: { roots: ["/Users/me"], display: ["~"], missing: [], denied: [] },
          },
        })
      }
      if (path.endsWith("/folders/lookup")) {
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
      return json({ data: [] })
    }),
  )
})

afterEach(() => {
  cleanup()
  uninstallFakeBridge()
  delete (globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__
  clearAuth()
  resetNodesStore()
  vi.unstubAllGlobals()
  window.history.pushState({}, "", "/")
})

describe("former Settings paths, through the settings layout", () => {
  it("/settings/nodes?node=&folder= opens that computer's Folders, searching for the name", async () => {
    renderSettingsAt("/settings/nodes?node=n-mac&folder=liaison-monorepo")
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers/n-mac"))
    expect(window.location.search).toBe("?folder=liaison-monorepo")
    expect(await screen.findByTestId("computer-page")).toBeTruthy()
    expect((await screen.findByTestId("add-folder-candidate")).textContent).toContain(
      "~/code/liaison-monorepo",
    )
  })

  it("/settings/nodes alone opens the list", async () => {
    renderSettingsAt("/settings/nodes")
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers"))
    expect(await screen.findByTestId("computers-settings")).toBeTruthy()
  })

  it("/settings/this-computer in a browser opens the list", async () => {
    renderSettingsAt("/settings/this-computer")
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers"))
    expect(await screen.findByTestId("computers-settings")).toBeTruthy()
  })

  it("/settings/this-computer in the desktop app opens this computer's page", async () => {
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = "https://a.example.com"
    const handle = installFakeBridge()
    Object.assign(handle.bridge, {
      loadNodeCredential: async () => ({ nodeId: "n-mac", credential: "lnn_1", enabled: true }),
      storeNodeCredential: async () => {},
    })
    renderSettingsAt("/settings/this-computer")
    await waitFor(() => expect(window.location.pathname).toBe("/settings/computers/n-mac"))
    expect(await screen.findByTestId("computer-page")).toBeTruthy()
  })
})
