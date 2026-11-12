// SPDX-License-Identifier: FSL-1.1-ALv2
// Settings > Sidebar (the person's own) and the Sidebar section of an admin's
// member page share one editor: a row per rail app, in rail order, with a
// "show in the sidebar" switch that saves at once.
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerActivityBarEntry, resetRegistry } from "~/framework/app-registry"
import AdminUserDetail from "~/modules/settings/AdminUserDetail"
import SidebarSettings from "~/modules/settings/SidebarSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { hiddenSidebarApps, resetSidebarVisibility } from "~/modules/shell/sidebar-visibility"

const USER = "11111111-1111-4111-8111-111111111111"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function registerRail() {
  const entry = (id: string, label: string, order: number, position?: "bottom") =>
    registerActivityBarEntry({
      id,
      icon: () => null,
      label,
      order,
      appId: id,
      ...(position ? { position } : {}),
      tabAction: { type: `${id}:home`, entityId: id, label },
    })
  entry("sessions", "Sessions", 3)
  entry("monitoring", "Monitoring", 20)
  entry("tickets", "Tickets", 10)
  entry("settings", "Settings", 99, "bottom")
}

type Call = { url: string; method: string; body: unknown }

function mockFetch(routes: {
  prefs?: unknown
  memberHidden?: string[]
  putStatus?: number
}): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET"
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      if (url.endsWith("/user/preferences") && method === "GET") {
        return jsonResp({ data: routes.prefs ?? { hiddenSidebarApps: [] } })
      }
      if (url.endsWith("/user/preferences/hidden-apps") && method === "PUT") {
        return jsonResp({ data: body }, routes.putStatus ?? 200)
      }
      if (url.endsWith(`/admin/users/${USER}/hidden-apps`) && method === "GET") {
        return jsonResp({ data: { userId: USER, hiddenSidebarApps: routes.memberHidden ?? [] } })
      }
      if (url.endsWith(`/admin/users/${USER}/hidden-apps`) && method === "PUT") {
        return jsonResp({ data: { userId: USER, ...body } }, routes.putStatus ?? 200)
      }
      if (url.endsWith(`/admin/users/${USER}`) && method === "GET") {
        return jsonResp({
          data: {
            id: USER,
            email: "alice@test.com",
            name: "Alice Martin",
            status: "active",
            roles: [],
            effectiveScopes: [],
            dimensions: {},
          },
        })
      }
      return jsonResp({ data: [] })
    }),
  )
  return calls
}

beforeEach(() => {
  resetRegistry()
  registerRail()
})
afterEach(() => {
  cleanup()
  resetSidebarVisibility()
  vi.unstubAllGlobals()
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  })
})

describe("Settings > Sidebar", () => {
  function renderPage() {
    return render(() => (
      <Router>
        <Route
          path="*"
          component={() => (
            <ApiProvider>
              <SidebarSettings />
            </ApiProvider>
          )}
        />
      </Router>
    ))
  }

  it("lists the rail's apps in rail order, Settings excluded, hidden ones switched off", async () => {
    mockFetch({ prefs: { hiddenSidebarApps: ["monitoring"] } })
    renderPage()
    const list = await screen.findByTestId("sidebar-settings-list")
    const rows = [...list.querySelectorAll("li")].map((li) => li.getAttribute("data-testid"))
    expect(rows).toEqual([
      "sidebar-settings-row-sessions",
      "sidebar-settings-row-tickets",
      "sidebar-settings-row-monitoring",
    ])
    expect(screen.getByTestId("sidebar-settings-switch-monitoring")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    expect(screen.getByTestId("sidebar-settings-switch-tickets")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    expect(screen.getByTestId("sidebar-settings-switch-tickets")).toHaveAccessibleName(
      "Show Tickets in the sidebar",
    )
    expect(screen.getByTestId("sidebar-settings-note")).toHaveTextContent(
      "Hidden apps stay available from search",
    )
  })

  it("saves each switch at once through the partial endpoint", async () => {
    const calls = mockFetch({ prefs: { hiddenSidebarApps: ["monitoring"] } })
    renderPage()
    fireEvent.click(await screen.findByTestId("sidebar-settings-switch-sessions"))
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        hiddenSidebarApps: ["monitoring", "sessions"],
      }),
    )
    expect(hiddenSidebarApps()).toEqual(["monitoring", "sessions"])
    expect(calls.find((c) => c.method === "PUT")?.url).toContain("/user/preferences/hidden-apps")
  })
})

describe("admin member page: Sidebar section", () => {
  function renderDetail() {
    window.history.pushState({}, "", `/settings/admin/users/${USER}`)
    return render(() => (
      <Router>
        <Route
          path="/settings/admin/users/:id"
          component={() => (
            <ApiProvider>
              <AdminUserDetail />
            </ApiProvider>
          )}
        />
      </Router>
    ))
  }

  it("shows the member's list and saves a switch to the admin route", async () => {
    const calls = mockFetch({ memberHidden: ["sessions"] })
    renderDetail()
    const section = await screen.findByTestId("admin-user-section-sidebar")
    expect(section).toHaveTextContent("Alice")
    const sessions = await screen.findByTestId("admin-user-sidebar-switch-sessions")
    expect(sessions).toHaveAttribute("aria-checked", "false")
    fireEvent.click(screen.getByTestId("admin-user-sidebar-switch-tickets"))
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT")
      expect(put?.url).toContain(`/admin/users/${USER}/hidden-apps`)
      expect(put?.body).toEqual({ hiddenSidebarApps: ["sessions", "tickets"] })
    })
    expect(screen.getByTestId("admin-user-sidebar-switch-tickets")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    // The admin's own sidebar is not what moved.
    expect(hiddenSidebarApps()).toEqual([])
  })

  it("puts the switch back when the save fails", async () => {
    mockFetch({ memberHidden: [], putStatus: 500 })
    renderDetail()
    fireEvent.click(await screen.findByTestId("admin-user-sidebar-switch-tickets"))
    await waitFor(() =>
      expect(screen.getByTestId("admin-user-sidebar-switch-tickets")).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    )
  })
})
