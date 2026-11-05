// SPDX-License-Identifier: FSL-1.1-ALv2
// The management header on an app's page (S24, A7, A9, prototype S-APPPAGE /
// S-ACCESS), for `kernel:apps:admin`: Enabled switch with an in-page confirm
// (events received while Off are not replayed), Who can use it (Everyone /
// selected roles and people, disabled when the app has no own permissions),
// the summary "Support + 2 people", version, Remove from this workspace. An
// Off app's page is read-only with a notice. Members get no controls.
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { apiError, createFakeApi, type FakeApi } from "../app-page/__fixtures__/fake-api"
import { FIXTURE_APP, fixtureManifest } from "../app-page/__fixtures__/settings-fixture"

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
vi.mock("~/ui/PopupMenu", () => {
  const Root = (props: { children: unknown }) => <>{props.children}</>
  const Trigger = (props: { children: unknown; "data-testid"?: string }) => (
    <button type="button" data-testid={props["data-testid"]}>
      {props.children as never}
    </button>
  )
  const Content = (props: { children: unknown }) => <div role="menu">{props.children as never}</div>
  const Item = (props: { children: unknown; onSelect: () => void; "data-testid"?: string }) => (
    <button
      type="button"
      role="menuitem"
      data-testid={props["data-testid"]}
      onClick={() => props.onSelect()}
    >
      {props.children as never}
    </button>
  )
  const Separator = () => <hr />
  return { PopupMenu: Object.assign(Root, { Trigger, Content, Item, Separator }) }
})

import { AppSettingsPage } from "../app-page/AppSettingsPage"
import { registerAppSettingsPage, resetAppSettingsPages } from "../app-page/app-settings-pages"
import { type OrgApp, orgAppsStore } from "./org-apps-store"
import { resetWorkspaceRoles } from "./workspace-roles"

const SUPPORT = "11111111-1111-4111-8111-111111111111"
const SALES = "22222222-2222-4222-8222-222222222222"
const ADMIN_ROLE = "33333333-3333-4333-8333-333333333333"
const TOMAS = "44444444-4444-4444-8444-444444444444"
const NADIA = "55555555-5555-4555-8555-555555555555"

let api: FakeApi
let orgApp: OrgApp

function view(over: Partial<OrgApp>) {
  orgApp = { ...orgApp, ...over }
  return {
    name: orgApp.name,
    status: orgApp.status,
    accessMode: orgApp.accessMode,
    principals: orgApp.principals,
  }
}

function renderPage() {
  window.history.pushState({}, "", `/settings/apps/${FIXTURE_APP}`)
  return render(() => (
    <Router>
      <Route path="*" component={() => <AppSettingsPage appId={FIXTURE_APP} />} />
    </Router>
  ))
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["*"]
  orgAppsStore.reset()
  resetWorkspaceRoles()
  resetAppSettingsPages()
  registerAppSettingsPage({ appId: FIXTURE_APP, manifest: fixtureManifest })
  orgApp = {
    name: FIXTURE_APP,
    displayName: "Fixture",
    version: "1.2.3",
    kind: "app",
    status: "active",
    accessMode: "everyone",
    principals: { roleIds: [], userIds: [] },
    hasOwnScopes: true,
    dependents: [],
    installSource: "in-tree",
    listing: null,
    settings: fixtureManifest.settings ?? null,
  }
  api.on("get", "/org/apps", () => [orgApp])
  api.on("get", "/admin/roles", () => [
    { id: ADMIN_ROLE, name: "admin" },
    { id: SUPPORT, name: "Support" },
    { id: SALES, name: "Sales" },
  ])
  api.on("get", "/admin/users?limit=100&page=1", () => [
    { id: TOMAS, name: "Tomas Berg", email: "tomas@example.org" },
    { id: NADIA, name: "Nadia Haddad", email: "nadia@example.org" },
  ])
  api.on("get", `/apps/${FIXTURE_APP}/settings/org`, () => ({ values: {} }))
  api.on("get", `/apps/${FIXTURE_APP}/settings/user`, () => ({ values: {} }))
  api.on("get", `/apps/${FIXTURE_APP}/connections`, () => [])
  api.tool(`${FIXTURE_APP}:options.list`, () => [])
  api.tool(`${FIXTURE_APP}:keys.list`, () => [])
  api.tool(`${FIXTURE_APP}:categories.list`, () => ({ version: "v1", nodes: [] }))
})

afterEach(() => {
  orgAppsStore.reset()
  resetAppSettingsPages()
})

describe("Enabled switch", () => {
  it("turning it off asks in the page first, saying events while Off are not replayed", async () => {
    api.on("post", `/org/apps/${FIXTURE_APP}/disable`, () => view({ status: "disabled" }))
    renderPage()
    const sw = await screen.findByTestId("app-enabled-switch")
    expect(sw.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(sw)
    const confirm = await screen.findByTestId("app-disable-confirm")
    expect(confirm.textContent).toContain("does not replay them")
    expect(confirm.textContent).toContain("Your data and settings are kept.")
    expect(api.post).not.toHaveBeenCalledWith(`/org/apps/${FIXTURE_APP}/disable`)

    fireEvent.click(within(confirm).getByTestId("app-disable-confirm-yes"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/org/apps/${FIXTURE_APP}/disable`))
    // Off: read-only with the notice, the sections gone, the switch off.
    expect(await screen.findByTestId("app-off-notice")).toBeTruthy()
    expect(screen.queryByTestId(`app-settings-body-${FIXTURE_APP}`)).toBeNull()
    expect(screen.getByTestId("app-enabled-switch").getAttribute("aria-checked")).toBe("false")
  })

  it("Cancel keeps it on", async () => {
    renderPage()
    fireEvent.click(await screen.findByTestId("app-enabled-switch"))
    fireEvent.click(await screen.findByTestId("app-disable-confirm-cancel"))
    expect(screen.queryByTestId("app-disable-confirm")).toBeNull()
    expect(api.post).not.toHaveBeenCalledWith(`/org/apps/${FIXTURE_APP}/disable`)
  })

  it("a refusal (another app requires it) is said in the page", async () => {
    api.on("post", `/org/apps/${FIXTURE_APP}/disable`, () => {
      throw apiError(409, "app_has_dependents", "Shopify requires Fixture: turn Shopify off first.")
    })
    renderPage()
    fireEvent.click(await screen.findByTestId("app-enabled-switch"))
    fireEvent.click(await screen.findByTestId("app-disable-confirm-yes"))
    expect((await screen.findByTestId("app-management-error")).textContent).toContain(
      "turn Shopify off first",
    )
  })

  it("an Off app the manifests feed no longer carries keeps a read-only page; turning it on needs no confirm", async () => {
    resetAppSettingsPages()
    orgApp = { ...orgApp, status: "disabled" }
    api.on("post", `/org/apps/${FIXTURE_APP}/enable`, () => view({ status: "active" }))
    renderPage()
    expect(await screen.findByTestId("app-off-notice")).toBeTruthy()
    expect(screen.getByTestId("app-settings-name").textContent).toBe("Fixture")
    expect(screen.queryByTestId(`app-settings-body-${FIXTURE_APP}`)).toBeNull()
    // Who can use it waits until the app is on.
    expect(screen.getByTestId("app-access-button")).toBeDisabled()
    fireEvent.click(screen.getByTestId("app-enabled-switch"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/org/apps/${FIXTURE_APP}/enable`))
    expect(screen.queryByTestId("app-disable-confirm")).toBeNull()
  })

  it("an app the workspace depends on offers no live switch and no Remove, and says why (MGT-07)", async () => {
    orgApp = { ...orgApp, canDisable: false }
    renderPage()
    const sw = await screen.findByTestId("app-enabled-switch")
    expect(sw.getAttribute("aria-checked")).toBe("true")
    expect(sw).toBeDisabled()
    expect(screen.getByTestId("app-enabled-required").textContent).toBe(
      "The workspace depends on this app: it stays on.",
    )
    fireEvent.click(sw)
    expect(screen.queryByTestId("app-disable-confirm")).toBeNull()
    expect(screen.queryByTestId("app-management-remove")).toBeNull()
    // The rest of the menu stays.
    expect(screen.getByTestId("app-management-store")).toBeTruthy()
  })

  it("a change over the WebSocket turns the open page read-only", async () => {
    renderPage()
    await screen.findByTestId("app-enabled-switch")
    orgAppsStore.applyUpdate({ app: FIXTURE_APP, status: "disabled", accessMode: "everyone" })
    expect(await screen.findByTestId("app-off-notice")).toBeTruthy()
  })
})

describe("Who can use it", () => {
  it("summarises roles and people: Support + 2 people", async () => {
    orgApp = {
      ...orgApp,
      accessMode: "restricted",
      principals: { roleIds: [SUPPORT], userIds: [TOMAS, NADIA] },
    }
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId("app-access-button").textContent).toContain("Support + 2 people"),
    )
  })

  it("restricting sends the roles and people chosen", async () => {
    api.on("put", `/org/apps/${FIXTURE_APP}/access`, (body) => {
      const b = body as { mode: OrgApp["accessMode"]; roleIds: string[]; userIds: string[] }
      return view({ accessMode: b.mode, principals: { roleIds: b.roleIds, userIds: b.userIds } })
    })
    renderPage()
    fireEvent.click(await screen.findByTestId("app-access-button"))
    const dialog = await screen.findByTestId("app-access-dialog")
    fireEvent.click(within(dialog).getByTestId("app-access-some"))
    // Admins always have access: the admin role is not offered.
    expect(within(dialog).queryByTestId(`app-access-role-${ADMIN_ROLE}`)).toBeNull()
    fireEvent.click(await within(dialog).findByTestId(`app-access-role-${SUPPORT}`))
    fireEvent.input(within(dialog).getByTestId("app-access-person-search"), {
      target: { value: "tom" },
    })
    fireEvent.click(await within(dialog).findByTestId(`app-access-person-add-${TOMAS}`))
    expect(within(dialog).getByTestId("app-access-summary").textContent).toContain(
      "Support + 1 person",
    )
    fireEvent.click(within(dialog).getByTestId("app-access-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(`/org/apps/${FIXTURE_APP}/access`, {
        mode: "restricted",
        roleIds: [SUPPORT],
        userIds: [TOMAS],
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("app-access-button").textContent).toContain("Support + 1 person"),
    )
  })

  it("an app with no permissions of its own cannot be restricted, and says why", async () => {
    orgApp = { ...orgApp, hasOwnScopes: false }
    renderPage()
    fireEvent.click(await screen.findByTestId("app-access-button"))
    const some = await screen.findByTestId("app-access-some")
    expect(some).toBeDisabled()
    expect(screen.getByTestId("app-access-no-scopes").textContent).toBe(
      "This app has no permissions to restrict.",
    )
  })
})

describe("overflow menu", () => {
  it("Remove from this workspace asks, then removes", async () => {
    api.on("post", `/org/apps/${FIXTURE_APP}/remove`, () => view({ status: "removed" }))
    renderPage()
    fireEvent.click(await screen.findByTestId("app-management-remove"))
    expect((await screen.findByTestId("app-remove-dialog")).textContent).toContain(
      "Other workspaces on this server are not affected",
    )
    fireEvent.click(screen.getByTestId("app-remove-confirm"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/org/apps/${FIXTURE_APP}/remove`))
  })
})

describe("members", () => {
  it("get no management controls and never load the workspace's app list", async () => {
    state.scopes = ["fixture:lead:admin"]
    renderPage()
    await screen.findByTestId("app-settings-header")
    expect(screen.queryByTestId("app-enabled-switch")).toBeNull()
    expect(screen.queryByTestId("app-access-button")).toBeNull()
    expect(api.get).not.toHaveBeenCalledWith("/org/apps", expect.anything())
  })

  it("never read the workspace's roles, an admin-only endpoint (NAV-04)", async () => {
    state.scopes = ["fixture:lead:admin"]
    renderPage()
    await screen.findByTestId("app-settings-header")
    expect(api.get).not.toHaveBeenCalledWith("/admin/roles", expect.anything())
  })
})
