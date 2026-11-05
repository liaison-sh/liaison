// SPDX-License-Identifier: FSL-1.1-ALv2
// Roles & access › a role › "Apps this role can use" (S20, prototype S-ROLES):
// each app of the workspace with whether the role can use it and why: Off for
// everyone, Everyone can use it, Listed in Who can use it, or Not in Who can
// use it (with the app's summary); Who can use it opens from the row.
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

import { type OrgApp, orgAppsStore } from "./org-apps-store"
import { RoleAppsSection } from "./RoleAppsSection"

const SUPPORT = "11111111-1111-4111-8111-111111111111"
const SALES = "22222222-2222-4222-8222-222222222222"
const TOMAS = "44444444-4444-4444-8444-444444444444"

function org(name: string, over: Partial<OrgApp> = {}): OrgApp {
  return {
    name,
    displayName: name[0].toUpperCase() + name.slice(1),
    version: "1.0.0",
    kind: "app",
    status: "active",
    accessMode: "everyone",
    principals: { roleIds: [], userIds: [] },
    hasOwnScopes: true,
    dependents: [],
    installSource: "in-tree",
    listing: null,
    settings: null,
    ...over,
  }
}

let api: FakeApi

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["*"]
  orgAppsStore.reset()
  api.on("get", "/org/apps", () => [
    org("tickets", {
      accessMode: "restricted",
      principals: { roleIds: [SUPPORT], userIds: [TOMAS] },
    }),
    org("mail", { status: "disabled" }),
    org("social"),
    org("calls", { status: "removed" }),
    org("gitlab", { kind: "connector" }),
  ])
  api.on("get", "/admin/roles", () => [
    { id: SUPPORT, name: "Support" },
    { id: SALES, name: "Sales" },
  ])
  api.on("get", "/admin/users?limit=100&page=1", () => [])
})

afterEach(() => orgAppsStore.reset())

function row(app: string) {
  return screen.findByTestId(`role-app-${app}`)
}

describe("Apps this role can use", () => {
  it("says for each app whether the role can use it and why", async () => {
    render(() => <RoleAppsSection roleId={SALES} roleName="Sales" />)
    const tickets = await row("tickets")
    expect(tickets.textContent).toContain("Not in Who can use it (Support + 1 person)")
    expect(within(tickets).getByTestId("role-app-state-tickets").textContent).toBe("Can't use")
    expect((await row("mail")).textContent).toContain("Off for everyone")
    expect((await row("social")).textContent).toContain("Everyone can use it")
    expect(screen.queryByTestId("role-app-calls")).toBeNull()
  })

  it("a listed role can use it", async () => {
    render(() => <RoleAppsSection roleId={SUPPORT} roleName="Support" />)
    const tickets = await row("tickets")
    expect(tickets.textContent).toContain("Listed in Who can use it")
    expect(within(tickets).getByTestId("role-app-state-tickets").textContent).toBe("Can use")
  })

  it("Who can use it opens from the row", async () => {
    render(() => <RoleAppsSection roleId={SALES} roleName="Sales" />)
    fireEvent.click(within(await row("tickets")).getByTestId("role-app-access-tickets"))
    expect(await screen.findByTestId("app-access-dialog")).toBeTruthy()
    // An Off app has no access to set.
    expect(screen.queryByTestId("role-app-access-mail")).toBeNull()
  })

  it("is absent for someone who does not manage the workspace's apps", async () => {
    state.scopes = ["kernel:users:admin"]
    render(() => <RoleAppsSection roleId={SALES} roleName="Sales" />)
    expect(screen.queryByTestId("role-apps-section")).toBeNull()
    expect(api.get).not.toHaveBeenCalledWith("/org/apps", expect.anything())
  })
})
