// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every former settings URL lands on its new home (settings overhaul S11, A9,
// A22). The table is the alias file itself, so an entry added there is tested
// without a line here. App pages register from a declarative `settings` page;
// the former per-app pages are gone in the fixture, as they will be once every
// app has migrated.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { type Component, createEffect } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  registerSettingsSection,
  resetRegistry,
  setManifestAppsSettled,
} from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppFromManifest } from "~/framework/define-app"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import SettingsLayout, { useSettingsPageActive } from "~/modules/settings/SettingsLayout"
import {
  aliasTargetPath,
  resolveSettingsAlias,
  SETTINGS_ALIAS_PREFIXES,
  SETTINGS_ALIASES,
} from "~/modules/settings/settings-aliases"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { toasts } from "~/modules/shell/toast-store"

// The server's own page reads the MCP API; routing is what is tested here.
vi.mock("~/modules/mcp-manager/ConnectionDetail", () => ({
  ConnectionDetail: (props: { connectionId: string }) => (
    <div data-testid="mcp-connection-detail-stub">{props.connectionId}</div>
  ),
}))

type Manifest = Parameters<typeof registerAppFromManifest>[0]

const stubExports = new Proxy({}, { get: () => () => null, has: () => true }) as Record<
  string,
  unknown
>

const CONNECTORS = new Set(["gitlab", "database", "google-drive", "pennylane", "api-connector"])

/** An app with a declarative settings page: one user and one org section. */
function settingsManifest(name: string): Manifest {
  return {
    name,
    kind: CONNECTORS.has(name) ? "connector" : "app",
    settings: {
      sections: [
        { id: "mine", title: "Yours", scope: "user", blocks: [] },
        { id: "org", title: "Organization", scope: "org", blocks: [] },
      ],
    },
    views: {},
  } as unknown as Manifest
}

function jwt(scopes: string[]): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Admin",
      roles: [],
      scopes,
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function jsonResp(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

function renderAt(path: string) {
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

const here = () => `${window.location.pathname}${window.location.search}`

const APP_TARGETS = [
  ...new Set(
    SETTINGS_ALIASES.map((a) => aliasTargetPath(a.to))
      .filter((p) => p.startsWith("/settings/apps/"))
      .map((p) => p.slice("/settings/apps/".length)),
  ),
]

beforeEach(() => {
  clearAuth()
  resetRegistry()
  resetBootstrap()
  bootstrapKernelApps()
  for (const app of [...APP_TARGETS, ...CONNECTORS]) {
    registerAppFromManifest(settingsManifest(app), stubExports)
  }
  // The manifest sync has settled: a path nothing claims now falls back.
  setManifestAppsSettled(true)
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResp({ data: [] })),
  )
  setTokens(jwt(["*"]), "refresh")
})

afterEach(() => {
  cleanup()
  clearAuth()
  vi.unstubAllGlobals()
})

describe("every former settings URL lands on its new home", () => {
  it.each(SETTINGS_ALIASES.map((a) => [a.from, a.to]))("%s -> %s", async (from, to) => {
    renderAt(from)
    await waitFor(() => expect(here()).toBe(to))
  })

  it.each(SETTINGS_ALIAS_PREFIXES.map((a) => [`${a.from}abc-123`, `${a.to}abc-123`]))(
    "%s -> %s (prefix alias)",
    async (from, to) => {
      renderAt(from)
      await waitFor(() => expect(here()).toBe(to))
    },
  )

  it("an MCP server's former page opens the server on Connectors", async () => {
    renderAt("/settings/admin/mcp-servers/srv-1")
    expect(await screen.findByTestId("mcp-server-detail-page")).toBeInTheDocument()
    await waitFor(() => expect(window.location.pathname).toBe("/settings/connectors/mcp/srv-1"))
  })

  it("keeps the query of the former URL", async () => {
    renderAt("/settings/admin/dimension-grants?dimension=region&value=eu")
    await waitFor(() => expect(window.location.pathname).toBe("/settings/admin/roles"))
    expect(new URLSearchParams(window.location.search).get("dimension")).toBe("region")
    expect(new URLSearchParams(window.location.search).get("value")).toBe("eu")
  })

  it("resolves nothing for a path that never moved", () => {
    expect(resolveSettingsAlias("/settings/security")).toBeNull()
    expect(resolveSettingsAlias("/settings/apps/tickets")).toBeNull()
  })

  it("a page an app still registers at its former path keeps answering it", async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    registerSettingsSection({
      id: "tickets:tickets-categories",
      label: "Categories",
      href: "/settings/tickets/categories",
      component: () => <div data-testid="legacy-categories" />,
      group: "app",
      appId: "tickets",
      order: 0,
    })
    renderAt("/settings/tickets/categories")
    expect(await screen.findByTestId("legacy-categories")).toBeInTheDocument()
    expect(window.location.pathname).toBe("/settings/tickets/categories")
  })
})

describe("the new pages", () => {
  it.each([
    ["/settings/apps/tickets", "app-settings-page-tickets"],
    ["/settings/connectors", "connectors-page"],
    ["/settings/connectors/mcp/m-9", "mcp-server-detail-page"],
  ])("%s renders its page", async (path, testId) => {
    renderAt(path)
    expect(await screen.findByTestId(testId)).toBeInTheDocument()
    expect(window.location.pathname).toBe(path)
  })

  it.each([...CONNECTORS])(
    "a connector has no app page: /settings/apps/%s opens its card on Connectors",
    async (app) => {
      renderAt(`/settings/apps/${app}`)
      await waitFor(() => expect(here()).toBe(`/settings/connectors?open=${app}`))
      expect(await screen.findByTestId("connectors-page")).toBeInTheDocument()
    },
  )
})

describe("an OAuth error carried back to a settings URL", () => {
  it("is shown as a toast with its description, then dropped from the URL", async () => {
    renderAt(
      "/settings/apps/tickets?oauth_error=access_denied&oauth_error_description=The+user+declined&keep=1",
    )
    await waitFor(() =>
      expect(
        toasts().some((t) => t.type === "error" && t.message.includes("The user declined")),
      ).toBe(true),
    )
    await waitFor(() => expect(window.location.search).toBe("?keep=1"))
    expect(window.location.pathname).toBe("/settings/apps/tickets")
  })

  it("survives the hop from a former URL", async () => {
    renderAt("/settings/mail/accounts?oauth_error=invalid_grant")
    await waitFor(() =>
      expect(toasts().some((t) => t.type === "error" && t.message.includes("invalid_grant"))).toBe(
        true,
      ),
    )
    await waitFor(() => expect(here()).toBe("/settings/apps/mail"))
  })
})

describe("useSettingsPageActive", () => {
  it("is true while the page is shown and false once another page is", async () => {
    const seen: boolean[] = []
    const Probe: Component = () => {
      const active = useSettingsPageActive()
      createEffect(() => seen.push(active()))
      return <div data-testid="probe" />
    }
    registerSettingsSection({
      id: "kernel:probe",
      label: "Probe",
      href: "/settings/probe",
      component: Probe,
      group: "user",
      appId: "kernel",
      order: 99,
    })
    renderAt("/settings/probe")
    expect(await screen.findByTestId("probe")).toBeInTheDocument()
    await waitFor(() => expect(seen.at(-1)).toBe(true))
    window.history.pushState({}, "", "/settings/security")
    window.dispatchEvent(new PopStateEvent("popstate"))
    await waitFor(() => expect(seen.at(-1)).toBe(false))
    window.history.pushState({}, "", "/settings/probe")
    window.dispatchEvent(new PopStateEvent("popstate"))
    await waitFor(() => expect(seen.at(-1)).toBe(true))
  })
})
