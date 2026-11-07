// SPDX-License-Identifier: FSL-1.1-ALv2
// The connector cards on Settings > Connectors, rendered from the REAL
// manifests (settings overhaul P2 T10): each connector declares
// `kind: "connector"` and a declarative `settings` page whose connections
// block names a status read. The card keeps what each old settings pane did
// (P1 S5): it says whether the connection works from a real read ("not
// connected" may be a 200 `{ error }` envelope), shows the read's own message
// when it fails, and fixes it in place: the credential form opens inside the
// card, OAuth reconnects from it, and a save checks again.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import callsManifest from "../../../../../../bundled-apps/calls/app.manifest.json"
import pennylaneManifest from "../../../../../../bundled-apps/pennylane/app.manifest.json"
import apiConnectorManifest from "../../../../../api/src/apps/api-connector/app.manifest.json"
import databaseManifest from "../../../../../api/src/apps/database/app.manifest.json"
import gitlabManifest from "../../../../../api/src/apps/gitlab/app.manifest.json"
import driveManifest from "../../../../../api/src/apps/google-drive/app.manifest.json"
import { apiError, createFakeApi, type FakeApi } from "../app-page/__fixtures__/fake-api"
import type { AppSettingsManifest } from "../app-page/types"

const state = vi.hoisted(() => ({ api: null as unknown, scopes: ["*"] as string[] }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => state.api,
  useOptionalApi: () => state.api,
}))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  const has = (s: string) => state.scopes.includes("*") || state.scopes.includes(s)
  return { ...actual, hasScope: has, canAccessScope: (s?: string | null) => !s || has(s) }
})
vi.mock("~/modules/mcp-manager/McpConnectionsList", () => ({
  McpConnectionsList: () => <div data-testid="mcp-list-stub" />,
}))
vi.mock("~/modules/mcp-manager/AddMcpConnectionWizard", () => ({
  AddMcpConnectionWizard: () => <div data-testid="mcp-wizard-stub" />,
}))

import { registerAppSettingsPage, resetAppSettingsPages } from "../app-page/app-settings-pages"
import { appsStore } from "../apps-store"
import { ConnectorsPage } from "./ConnectorsPage"

let api: FakeApi

/** The slice of a manifest JSON the settings pages read. */
function slice(m: unknown): AppSettingsManifest {
  const r = m as AppSettingsManifest & { views?: { settings?: unknown } }
  expect(r.kind).toBe("connector")
  expect(r.settings?.sections.length ?? 0).toBeGreaterThan(0)
  expect(r.views?.settings).toBeUndefined()
  return { name: r.name, version: r.version, kind: r.kind, settings: r.settings }
}

function register(m: unknown, exports: Record<string, unknown> = {}): string {
  const manifest = slice(m)
  registerAppSettingsPage({ appId: manifest.name, manifest, exports })
  return manifest.name
}

function credentialConnection(name: string, fields: string[], active = 0) {
  return {
    name,
    type: "credentials" as const,
    credentialFields: fields.map((f) => ({ name: f, label: f, type: "password" })),
    accounts: { active, error: 0 },
  }
}

function renderPage(open: string) {
  window.history.pushState({}, "", `/settings/connectors?open=${open}`)
  return render(() => (
    <Router>
      <Route path="*" component={() => <ConnectorsPage />} />
    </Router>
  ))
}

async function cardStatus(app: string): Promise<HTMLElement> {
  const body = await screen.findByTestId(`connector-body-${app}`)
  return within(body).findByTestId("connections-status")
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["*"]
  appsStore.reset()
  resetAppSettingsPages()
})

afterEach(() => resetAppSettingsPages())

describe("GitLab connector card", () => {
  beforeEach(() => {
    register(gitlabManifest)
    api.on("get", "/apps/gitlab/connections", () => [
      credentialConnection("gitlab", ["token", "group"], 1),
    ])
    api.on("get", "/connections/gitlab/gitlab/accounts", () => [])
  })

  it("probes with gitlab_list_projects and says Connected", async () => {
    api.tool("gitlab:gitlab_list_projects", () => ({ projects: [{ id: 1, name: "a" }] }))
    renderPage("gitlab")
    const line = await cardStatus("gitlab")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("connected"))
    expect(api.toolCalls()[0]).toEqual({ toolName: "gitlab:gitlab_list_projects", params: {} })
  })

  it("reads the 200 not_connected envelope as Not connected", async () => {
    api.tool("gitlab:gitlab_list_projects", () => ({
      error: { code: "not_connected", message: "No GitLab connection for this organization." },
    }))
    renderPage("gitlab")
    const line = await cardStatus("gitlab")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("not_connected"))
  })

  // Nothing connected: one empty state with one Connect (the card's), not a
  // status box with its own Connect and Check again above it.
  it("nothing connected: exactly one Connect, which opens the token form in the card", async () => {
    api.on("get", "/apps/gitlab/connections", () => [
      credentialConnection("gitlab", ["token", "group"]),
    ])
    api.tool("gitlab:gitlab_list_projects", () => ({
      error: { code: "not_connected", message: "No GitLab connection for this organization." },
    }))
    renderPage("gitlab")
    const body = await screen.findByTestId("connector-body-gitlab")
    const connect = await within(body).findByTestId("connections-connect-gitlab")
    await waitFor(() => expect(api.toolCalls().length).toBe(1))
    await waitFor(() => expect(within(body).queryByTestId("connections-status")).toBeNull())
    const named = (name: string) =>
      within(body)
        .queryAllByRole("button")
        .filter((b) => b.textContent?.trim() === name)
    expect(named("Connect")).toEqual([connect])
    expect(named("Check again")).toHaveLength(0)
    expect(body.textContent?.match(/connected yet/g)?.length).toBe(1)
    fireEvent.click(connect)
    expect(await within(body).findByTestId("gitlab-inline-connect")).toBeTruthy()
  })

  it("a dead token: the probe's message, the form in the card, a save re-probes", async () => {
    let probes = 0
    api.tool("gitlab:gitlab_list_projects", () => {
      probes += 1
      throw apiError(502, "tool_error", "GitLab rejected the token (401 Unauthorized)")
    })
    api.on("post", "/connections/gitlab/gitlab/credentials", () => ({ success: true }))
    renderPage("gitlab")
    const body = await screen.findByTestId("connector-body-gitlab")
    expect((await within(body).findByTestId("connections-status-message")).textContent).toContain(
      "GitLab rejected the token (401 Unauthorized)",
    )
    fireEvent.click(within(body).getByTestId("connections-status-fix"))
    const form = await within(body).findByTestId("gitlab-inline-connect")
    fireEvent.input(await within(form).findByTestId("connect-field-token"), {
      target: { value: "glpat-new" },
    })
    fireEvent.input(within(form).getByTestId("connect-field-group"), {
      target: { value: "acme-tools" },
    })
    fireEvent.click(within(form).getByTestId("connect-submit"))
    await waitFor(() =>
      expect(
        api.post.mock.calls.find((c) => c[0] === "/connections/gitlab/gitlab/credentials")?.[1],
      ).toMatchObject({ credentials: { token: "glpat-new", group: "acme-tools" } }),
    )
    await waitFor(() => expect(probes).toBe(2))
    expect(window.location.pathname).toBe("/settings/connectors")
  })

  it("is a card for gitlab:accounts:admin, absent for a member", async () => {
    state.scopes = ["gitlab:repo:read"]
    api.tool("gitlab:gitlab_list_projects", () => ({ projects: [] }))
    renderPage("gitlab")
    await screen.findByTestId("connectors-page")
    expect(screen.queryByTestId("connector-card-gitlab")).toBeNull()
  })
})

describe("Database connector card", () => {
  beforeEach(() => {
    register(databaseManifest)
    api.on("get", "/apps/database/connections", () => [
      credentialConnection("database", ["connectionString"], 1),
      { ...credentialConnection("warehouse", ["connectionString"]), optional: true },
    ])
    api.on("get", "/connections/database/database/accounts", () => [])
    api.on("get", "/connections/database/warehouse/accounts", () => [])
  })

  it("probes with db_probe and lists the probe's warnings", async () => {
    api.tool("database:db_probe", () => ({
      ok: true,
      mode: "direct",
      warnings: ["role holds INSERT on public.orders"],
    }))
    renderPage("database")
    const line = await cardStatus("database")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("connected"))
    expect(within(line).getByTestId("connections-status-warnings").textContent).toContain(
      "role holds INSERT on public.orders",
    )
    expect(api.toolCalls()[0]).toEqual({ toolName: "database:db_probe", params: {} })
  })

  it("shows both connections, the warehouse as optional", async () => {
    api.tool("database:db_probe", () => ({ ok: true, mode: "gate", warnings: [] }))
    renderPage("database")
    const body = await screen.findByTestId("connector-body-database")
    expect(await within(body).findByTestId("connections-conn-database")).toBeTruthy()
    expect(within(body).getByTestId("connections-conn-warehouse").textContent).toContain("Optional")
  })

  it("not connected: each connection keeps its own Connect; the database's opens its form only", async () => {
    api.on("get", "/apps/database/connections", () => [
      credentialConnection("database", ["connectionString"]),
      { ...credentialConnection("warehouse", ["connectionString"]), optional: true },
    ])
    api.tool("database:db_probe", () => ({
      error: { code: "not_connected", message: "No database connection" },
    }))
    renderPage("database")
    const body = await screen.findByTestId("connector-body-database")
    expect(await within(body).findByTestId("connections-connect-warehouse")).toBeTruthy()
    fireEvent.click(await within(body).findByTestId("connections-connect-database"))
    await waitFor(() => expect(within(body).queryByTestId("connections-status")).toBeNull())
    const card = within(body).getByTestId("connections-conn-database")
    expect(await within(card).findByTestId("database-inline-connect")).toBeTruthy()
    expect(
      within(within(body).getByTestId("connections-conn-warehouse")).queryByTestId(
        "database-inline-connect",
      ),
    ).toBeNull()
  })
})

describe("Google Drive connector card", () => {
  const drive = { name: "drive", type: "oauth2" as const, accounts: { active: 1, error: 0 } }
  const mine = {
    id: "acc-drive",
    identifier: "lena@example.com",
    displayName: null,
    label: "lena@example.com",
    ownerType: "user",
    isMine: true,
    status: "active",
    statusMessage: null,
    tokenExpiresAt: null,
    hasRefreshToken: true,
    connectedByName: "Lena",
  }

  beforeEach(() => {
    register(driveManifest)
    api.on("get", "/apps/google-drive/connections", () => [drive])
    api.on("get", "/connections/google-drive/drive/accounts", () => [mine])
    api.on("post", "/connections/google-drive/drive/authorize", () => ({ redirectUrl: null }))
    api.on("delete", "/connections/acc-drive", () => ({ success: true }))
  })

  it("probes with an empty search and says Connected", async () => {
    api.tool("google-drive:search", () => ({ results: [] }))
    renderPage("google-drive")
    const line = await cardStatus("google-drive")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("connected"))
    expect(api.toolCalls()[0]).toEqual({ toolName: "google-drive:search", params: { query: "" } })
  })

  it("a revoked grant reads as revoked, and Reconnect starts the OAuth flow in place", async () => {
    api.tool("google-drive:search", () => {
      throw apiError(401, "OAUTH_REVOKED", "Google revoked access")
    })
    renderPage("google-drive")
    const line = await cardStatus("google-drive")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("revoked"))
    fireEvent.click(within(line).getByTestId("connections-status-fix"))
    await waitFor(() =>
      expect(
        api.post.mock.calls.find((c) => c[0] === "/connections/google-drive/drive/authorize")?.[1],
      ).toMatchObject({ mode: "org" }),
    )
  })

  it("disconnects the caller's Drive only after confirming what is deleted", async () => {
    api.tool("google-drive:search", () => ({ results: [] }))
    renderPage("google-drive")
    const body = await screen.findByTestId("connector-body-google-drive")
    fireEvent.click(await within(body).findByTestId("connections-disconnect-acc-drive"))
    const dialog = await screen.findByTestId("connections-disconnect-dialog")
    expect(dialog.textContent).toContain("synced into Knowledge")
    expect(api.delete).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByTestId("connections-disconnect-dialog-confirm"))
    await waitFor(() =>
      expect(api.delete.mock.calls.some((c) => c[0] === "/connections/acc-drive")).toBe(true),
    )
  })

  it("is a card for every member: each connects their own Drive (a user section)", async () => {
    state.scopes = ["google-drive:accounts:read"]
    api.tool("google-drive:search", () => ({ results: [] }))
    renderPage("google-drive")
    await screen.findByTestId("connectors-page")
    expect(await screen.findByTestId("connector-card-google-drive")).toBeTruthy()
    expect(
      driveManifest.settings.sections.map((section: { scope: string }) => section.scope),
    ).toEqual(["user"])
  })
})

describe("API connector card", () => {
  const crmAccount = {
    id: "acc-crm",
    identifier: "crm",
    displayName: null,
    label: "crm",
    ownerType: "org",
    isMine: false,
    status: "active",
    statusMessage: null,
    tokenExpiresAt: null,
    hasRefreshToken: false,
    connectedByName: "Lena",
  }

  beforeEach(async () => {
    // The real in-tree export bag: the custom block resolves from it by name.
    const exports = await import("~/modules/api-connector/exports")
    register(apiConnectorManifest, exports)
    api.on("get", "/apps/api-connector/connections", () => [
      {
        ...credentialConnection("api", ["apiKey", "token"], 1),
        multiInstance: true,
      },
    ])
    api.on("get", "/connections/api-connector/api/accounts", () => [crmAccount])
    api.on("get", "/api-connector/adapters", () => ({
      connections: [
        {
          identifier: "crm",
          name: "Acme CRM",
          adapterId: "crm",
          adapterVersion: "1.0.0",
          baseUrl: "https://crm.example.com",
          roles: [],
          status: "ok",
          auth: { type: "apiKey", in: "header", name: "X-Key" },
          operations: [],
        },
      ],
      readOnly: false,
    }))
  })

  it("lists the connection accounts, with no generic Connect or Replace (each needs its adapter)", async () => {
    renderPage("api-connector")
    const body = await screen.findByTestId("connector-body-api-connector")
    expect(await within(body).findByTestId("connections-account-acc-crm")).toBeTruthy()
    expect(within(body).getByTestId("connections-disconnect-acc-crm")).toBeTruthy()
    expect(within(body).queryByTestId("connections-reconnect-acc-crm")).toBeNull()
    expect(within(body).queryByTestId("connections-connect-api")).toBeNull()
  })

  it("renders the adapter editor and test panel block from the app's own exports", async () => {
    renderPage("api-connector")
    const body = await screen.findByTestId("connector-body-api-connector")
    const block = await within(body).findByTestId("settings-custom-ApiConnectorAdapters")
    expect(await within(block).findByTestId("api-connector-connection-crm")).toBeTruthy()
    expect(within(block).getByTestId("api-connector-add")).toBeTruthy()
    expect(within(block).getByTestId("api-connector-test-crm")).toBeTruthy()
    expect(within(body).queryByTestId("settings-custom-missing-ApiConnectorAdapters")).toBeNull()
  })

  it("is a card for api-connector:admin only", async () => {
    state.scopes = ["api-connector:connections:read"]
    renderPage("api-connector")
    await screen.findByTestId("connectors-page")
    expect(screen.queryByTestId("connector-card-api-connector")).toBeNull()
  })
})

// A bundled connector with no UI bundle: the kernel card works from the
// manifest alone (uiExports = {}).
describe("Pennylane connector card", () => {
  beforeEach(() => {
    register(pennylaneManifest, {})
    api.on("get", "/apps/pennylane/connections", () => [
      credentialConnection("pennylane", ["apiToken", "scope"]),
    ])
    api.on("get", "/connections/pennylane/pennylane/accounts", () => [])
    api.on("post", "/connections/pennylane/pennylane/credentials", () => ({ success: true }))
  })

  it("reads supplier invoices (limit 1) as its status and says Connected", async () => {
    api.tool("pennylane:supplier_invoices_list", () => ({ items: [] }))
    renderPage("pennylane")
    const line = await cardStatus("pennylane")
    await waitFor(() => expect(line.getAttribute("data-state")).toBe("connected"))
    expect(api.toolCalls()[0]).toEqual({
      toolName: "pennylane:supplier_invoices_list",
      params: { limit: 1 },
    })
  })

  it("the pennylane_not_connected envelope: one Connect, which opens the form in the card", async () => {
    api.tool("pennylane:supplier_invoices_list", () => ({
      error: { code: "pennylane_not_connected", message: "Add the API token" },
    }))
    renderPage("pennylane")
    const body = await screen.findByTestId("connector-body-pennylane")
    const connect = await within(body).findByTestId("connections-connect-pennylane")
    await waitFor(() => expect(api.toolCalls().length).toBe(1))
    expect(within(body).queryByTestId("connections-status-fix")).toBeNull()
    fireEvent.click(connect)
    const form = await within(body).findByTestId("pennylane-inline-connect")
    expect(await within(form).findByTestId("connect-field-apiToken")).toBeTruthy()
    expect(within(body).queryByTestId(/^settings-custom-missing-/)).toBeNull()
  })
})

// Calls ships no UI at all: its card is the optional transcript-source
// connection, rendered by the kernel from the manifest (uiExports = {}).
describe("Calls connector card", () => {
  beforeEach(() => {
    register(callsManifest, {})
    api.on("get", "/apps/calls/connections", () => [
      { ...credentialConnection("transcript-source", ["label"]), optional: true },
    ])
    api.on("get", "/connections/calls/transcript-source/accounts", () => [])
  })

  it("renders its connection with the inline form, no status read, no custom block", async () => {
    renderPage("calls")
    const body = await screen.findByTestId("connector-body-calls")
    expect(await within(body).findByTestId("connections-conn-transcript-source")).toBeTruthy()
    expect(within(body).queryByTestId("connections-status")).toBeNull()
    fireEvent.click(within(body).getByTestId("connections-connect-transcript-source"))
    const form = await within(body).findByTestId("calls-inline-connect")
    expect(await within(form).findByTestId("connect-field-label")).toBeTruthy()
    expect(api.toolCalls()).toEqual([])
  })

  it("is a card for calls:admin only", async () => {
    state.scopes = ["calls:transcripts:read"]
    renderPage("calls")
    await screen.findByTestId("connectors-page")
    expect(screen.queryByTestId("connector-card-calls")).toBeNull()
  })
})
