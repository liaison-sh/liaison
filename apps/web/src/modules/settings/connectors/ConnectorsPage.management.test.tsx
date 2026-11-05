// SPDX-License-Identifier: FSL-1.1-ALv2
// Connector cards carry the management controls for apps admins (S24, A7):
// Enabled and Remove from this workspace. A connector turned Off is absent
// from the manifests feed; for admins its card stays, says Off, and opens
// onto the read-only notice and the switch to turn it back on.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeApi, type FakeApi } from "../app-page/__fixtures__/fake-api"

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
  McpConnectionsList: () => <div />,
}))
vi.mock("~/modules/mcp-manager/McpAddFlow", () => ({ McpAddFlow: () => <div /> }))

import type { OrgApp } from "../app-management/org-apps-store"
import { orgAppsStore } from "../app-management/org-apps-store"
import { registerAppSettingsPage, resetAppSettingsPages } from "../app-page/app-settings-pages"
import { appsStore } from "../apps-store"
import { ConnectorsPage } from "./ConnectorsPage"

const SETTINGS = {
  sections: [
    {
      id: "connection",
      title: "Connection",
      scope: "org" as const,
      adminScope: "gitlab:accounts:admin",
      blocks: [{ block: "connections" as const }],
    },
  ],
}

function org(name: string, over: Partial<OrgApp> = {}): OrgApp {
  return {
    name,
    displayName: name === "gitlab" ? "GitLab" : "Pennylane",
    version: "1.0.0",
    kind: "connector",
    status: "active",
    accessMode: "everyone",
    principals: { roleIds: [], userIds: [] },
    hasOwnScopes: true,
    dependents: [],
    installSource: "in-tree",
    listing: null,
    settings: SETTINGS,
    ...over,
  }
}

let api: FakeApi

function renderPage(search = "") {
  window.history.pushState({}, "", `/settings/connectors${search}`)
  return render(() => (
    <Router>
      <Route path="*" component={() => <ConnectorsPage />} />
    </Router>
  ))
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["*"]
  appsStore.reset()
  orgAppsStore.reset()
  resetAppSettingsPages()
  registerAppSettingsPage({
    appId: "gitlab",
    manifest: { name: "gitlab", displayName: "GitLab", kind: "connector", settings: SETTINGS },
  })
  api.on("get", "/org/apps", () => [org("gitlab"), org("pennylane", { status: "disabled" })])
  api.on("get", "/apps/gitlab/connections", () => [])
  api.on("get", "/connections/gitlab/connection/accounts", () => [])
})

afterEach(() => {
  orgAppsStore.reset()
  resetAppSettingsPages()
})

describe("connector cards for apps admins", () => {
  it("an Off connector keeps its card, says Off, and opens onto the notice and the switch", async () => {
    renderPage("?open=pennylane")
    const card = await screen.findByTestId("connector-card-pennylane")
    expect(within(card).getByTestId("connector-status-pennylane").textContent).toBe("Off")
    expect(await within(card).findByTestId("app-off-notice")).toBeTruthy()
    const sw = within(card).getByTestId("app-enabled-switch")
    expect(sw.getAttribute("aria-checked")).toBe("false")
  })

  it("an On connector's open card has Enabled and the overflow with Remove", async () => {
    renderPage("?open=gitlab")
    const card = await screen.findByTestId("connector-card-gitlab")
    expect(await within(card).findByTestId("app-enabled-switch")).toBeTruthy()
    expect(within(card).getByTestId("app-management-more")).toBeTruthy()
    expect(within(card).queryByTestId("app-off-notice")).toBeNull()
  })

  it("someone who administers the connector but not the workspace's apps gets no controls and no Off card", async () => {
    state.scopes = ["gitlab:accounts:admin"]
    renderPage("?open=gitlab")
    const card = await screen.findByTestId("connector-card-gitlab")
    fireEvent.click(within(card).getByTestId("connector-toggle-gitlab"))
    fireEvent.click(within(card).getByTestId("connector-toggle-gitlab"))
    expect(within(card).queryByTestId("app-enabled-switch")).toBeNull()
    expect(screen.queryByTestId("connector-card-pennylane")).toBeNull()
    expect(api.get).not.toHaveBeenCalledWith("/org/apps", expect.anything())
  })
})
