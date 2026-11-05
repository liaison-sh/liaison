// SPDX-License-Identifier: FSL-1.1-ALv2
// Workspace › App store (S21, D17, A4, A11, A24-2): a LIST with Installed /
// Available, category chips and search; each row's action follows the app's
// state (Add to workspace, Install for the operator, Ask your server operator);
// a listing page with publisher, source repository, licence, permissions in
// plain words and the Remove / Uninstall-from-server actions; how each app runs
// (Running, Failed to load, Upgrade failed) and the operator's Roll back
// (S8, S9); Install from URL;
// no price text anywhere; the former connect deep link lands on the app's page.
import { Route, Router, useLocation } from "@solidjs/router"
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type OrgApp, orgAppsStore } from "../app-management/org-apps-store"
import { apiError, createFakeApi, type FakeApi } from "../app-page/__fixtures__/fake-api"
import { appsStore, type CatalogEntry } from "../apps-store"

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

// Flatten PopupMenu: trigger and items inline (no portal, no Kobalte pointer
// handling) so a click selects an item.
vi.mock("~/ui/PopupMenu", () => {
  const Root = (props: { children: unknown }) => <>{props.children}</>
  const Trigger = (props: { children: unknown; "data-testid"?: string }) => (
    <button type="button" data-testid={props["data-testid"]}>
      {props.children as never}
    </button>
  )
  const Content = (props: { children: unknown }) => <div role="menu">{props.children as never}</div>
  const Item = (props: {
    children: unknown
    onSelect: () => void
    disabled?: boolean
    "data-testid"?: string
  }) => (
    <button
      type="button"
      role="menuitem"
      disabled={props.disabled}
      data-testid={props["data-testid"]}
      onClick={() => props.onSelect()}
    >
      {props.children as never}
    </button>
  )
  const Separator = () => <hr />
  return { PopupMenu: Object.assign(Root, { Trigger, Content, Item, Separator }) }
})

import { AppStoreDetail, AppStorePage } from "./index"
import type { StoreOrgApp } from "./store-model"

const REPO = "https://example.org/liaison/tree/main/apps/api/src/apps/tickets"

function org(name: string, over: Partial<OrgApp> = {}): OrgApp {
  return {
    name,
    displayName: name[0].toUpperCase() + name.slice(1),
    version: "1.2.0",
    kind: "app",
    status: "active",
    accessMode: "everyone",
    principals: { roleIds: [], userIds: [] },
    hasOwnScopes: true,
    dependents: [],
    installSource: "in-tree",
    listing: {
      category: "Support",
      icon: "ticket",
      summary: `${name} summary`,
      sourceRepository: REPO,
      publisher: "Liaison",
    },
    settings: null,
    ...over,
  }
}

const CATALOG: CatalogEntry[] = [
  {
    name: "pennylane",
    displayName: "Pennylane",
    version: "0.1.30",
    kind: "connector",
    installed: false,
    source: "baked",
    license: "FSL-1.1-ALv2",
    scopes: ["pennylane:invoices:read"],
    listing: {
      category: "Finance",
      icon: "landmark",
      summary: "Read invoices from Pennylane.",
      sourceRepository: "https://example.org/liaison/tree/main/bundled-apps/pennylane",
    },
  },
  {
    name: "boxtal",
    displayName: "Boxtal",
    version: "0.14.30",
    installed: true,
    installedVersion: "0.14.30",
    source: "baked",
    license: "FSL-1.1-ALv2",
    listing: {
      category: "Commerce",
      icon: "truck",
      summary: "Shipping labels.",
      sourceRepository: "https://example.org/liaison/tree/main/bundled-apps/boxtal",
    },
  },
]

let api: FakeApi
let orgList: StoreOrgApp[]

function handlers(canManage = true): void {
  api.on("get", "/org/apps", () => orgList)
  api.on("get", "/apps", () => [
    { name: "tickets", version: "1.2.0", source: "in-tree", status: "active" },
    { name: "mail", version: "1.0.0", source: "in-tree", status: "active" },
    { name: "boxtal", version: "0.14.30", source: "installed", status: "active" },
  ])
  api.on("get", "/apps/catalog", () => ({ apps: CATALOG }))
  api.on("get", "/apps/install-permission", () => ({ canManageInstalls: canManage }))
  api.on("get", "/admin/scope-catalog", () => [
    { scope: "tickets:tickets:read", app: "tickets", description: "See tickets" },
    { scope: "tickets:tickets:write", app: "tickets", description: "Answer tickets" },
  ])
}

function renderAt(path: string) {
  window.history.pushState({}, "", path)
  return render(() => (
    <Router>
      <Route path="/settings/store" component={AppStorePage} />
      <Route path="/settings/store/:id" component={AppStoreDetail} />
      <Route
        path="/settings/apps/:app"
        component={() => {
          const location = useLocation()
          return <div data-testid="landed-app-page">{location.search}</div>
        }}
      />
      <Route
        path="/settings/connectors"
        component={() => <div data-testid="landed-connectors" />}
      />
    </Router>
  ))
}

beforeEach(() => {
  api = createFakeApi()
  state.api = api
  state.scopes = ["*"]
  appsStore.reset()
  orgAppsStore.reset()
  orgList = [
    org("tickets"),
    org("mail", { status: "disabled" }),
    org("boxtal", {
      status: "removed",
      installSource: "installed",
      listing: CATALOG[1].listing ?? null,
    }),
  ]
  handlers()
})

afterEach(() => {
  appsStore.reset()
  orgAppsStore.reset()
})

describe("App store list", () => {
  it("a failed read of the workspace's apps says so and retries, never shows Installed · 0", async () => {
    let fail = true
    api.on("get", "/org/apps", () => {
      if (fail) throw apiError(503, "unavailable", "busy")
      return orgList
    })
    renderAt("/settings/store")
    const notice = await screen.findByTestId("app-store-load-error")
    expect(notice.textContent).toContain("could not be loaded")
    expect(screen.queryByTestId("app-store-seg-installed")).toBeNull()
    expect(screen.queryByTestId("app-store-empty")).toBeNull()

    fail = false
    fireEvent.click(screen.getByTestId("app-store-retry"))
    expect(await screen.findByTestId("app-store-row-tickets")).toBeTruthy()
    expect(screen.queryByTestId("app-store-load-error")).toBeNull()
  })

  // NAV-11: on a cold load the segments read "Installed · 0 / Available · 0" until the
  // first reads land. Until /org/apps and the catalog have answered, the page says it is
  // loading: no counts, no segments, no empty list.
  it("a cold load shows a loading state, never zero counts, until the first reads resolve", async () => {
    let releaseOrg: () => void = () => {}
    let releaseCatalog: () => void = () => {}
    const orgRead = new Promise<void>((r) => {
      releaseOrg = r
    })
    const catalogRead = new Promise<void>((r) => {
      releaseCatalog = r
    })
    api.on("get", "/org/apps", () => orgRead.then(() => orgList))
    api.on("get", "/apps/catalog", () => catalogRead.then(() => ({ apps: CATALOG })))
    renderAt("/settings/store")
    expect(await screen.findByTestId("app-store-loading")).toBeTruthy()
    expect(screen.queryByTestId("app-store-seg-installed")).toBeNull()
    expect(screen.queryByTestId("app-store-seg-available")).toBeNull()
    expect(screen.queryByTestId("app-store-empty")).toBeNull()
    expect(screen.queryByText(/· 0/)).toBeNull()

    // The workspace's list alone is not enough: Available still needs the catalog.
    releaseOrg()
    await waitFor(() => expect(orgAppsStore.loaded()).toBe(true))
    expect(screen.getByTestId("app-store-loading")).toBeTruthy()
    expect(screen.queryByTestId("app-store-seg-available")).toBeNull()

    releaseCatalog()
    expect(await screen.findByTestId("app-store-row-tickets")).toBeTruthy()
    expect(screen.queryByTestId("app-store-loading")).toBeNull()
    expect(screen.getByTestId("app-store-seg-installed").textContent).not.toContain("0")
  })

  it("discriminator: once loaded (in-app navigation back), the list shows at once, no loading state", async () => {
    await orgAppsStore.load(api as never)
    await appsStore.loadCatalog(api as never)
    api.on("get", "/org/apps", () => new Promise(() => {}))
    renderAt("/settings/store")
    expect(screen.getByTestId("app-store-seg-installed")).toBeTruthy()
    expect(screen.queryByTestId("app-store-loading")).toBeNull()
  })

  it("lists Installed apps first with their state, and Available ones with their action", async () => {
    renderAt("/settings/store")
    const tickets = await screen.findByTestId("app-store-row-tickets")
    expect(within(tickets).getByTestId("app-store-state-tickets").textContent).toBe("Running")
    expect(screen.getByTestId("app-store-state-mail").textContent).toBe("Off")
    expect(screen.queryByTestId("app-store-row-pennylane")).toBeNull()

    fireEvent.click(screen.getByTestId("app-store-seg-available"))
    expect(await screen.findByTestId("app-store-add-boxtal")).toBeTruthy()
    expect(screen.getByTestId("app-store-install-pennylane")).toBeTruthy()
    expect(
      within(screen.getByTestId("app-store-row-pennylane")).getByText("Connector"),
    ).toBeTruthy()
  })

  it("filters by category chip and by search", async () => {
    renderAt("/settings/store")
    fireEvent.click(await screen.findByTestId("app-store-seg-available"))
    await screen.findByTestId("app-store-row-pennylane")
    fireEvent.click(screen.getByTestId("app-store-cat-Commerce"))
    expect(screen.queryByTestId("app-store-row-pennylane")).toBeNull()
    expect(screen.getByTestId("app-store-row-boxtal")).toBeTruthy()
    fireEvent.click(screen.getByTestId("app-store-cat-All"))
    fireEvent.input(screen.getByTestId("app-store-search"), { target: { value: "invoices" } })
    await waitFor(() => expect(screen.queryByTestId("app-store-row-boxtal")).toBeNull())
    expect(screen.getByTestId("app-store-row-pennylane")).toBeTruthy()
  })

  it("an app whose manifest has no display name reads its label, and is found by it", async () => {
    orgList = [org("tickets"), org("boxtal", { displayName: null, installSource: "installed" })]
    api.on("get", "/apps/catalog", () => ({
      apps: CATALOG.map((c) => (c.name === "boxtal" ? { ...c, displayName: undefined } : c)),
    }))
    renderAt("/settings/store")
    const row = await screen.findByTestId("app-store-row-boxtal")
    expect(within(row).getByText("Boxtal")).toBeTruthy()
    expect(within(row).queryByText("boxtal")).toBeNull()
    fireEvent.input(screen.getByTestId("app-store-search"), { target: { value: "Boxtal" } })
    await waitFor(() => expect(screen.queryByTestId("app-store-row-tickets")).toBeNull())
    expect(screen.getByTestId("app-store-row-boxtal")).toBeTruthy()
  })

  it("each app the workspace has On reads how it runs: Running, Failed to load, Upgrade failed (S8)", async () => {
    orgList = [
      ...orgList,
      {
        ...org("calls", { status: "error", installSource: "installed" }),
        problem: { code: "manifest_invalid", message: "/: must NOT have additional properties" },
      },
      org("projects", { status: "error" }),
      {
        ...org("parts", { installSource: "installed" }),
        upgradeFailed: {
          version: "2.0.0",
          reasonCode: "registration_failed",
          reasonMessage: "handler threw at registration",
        },
      },
    ]
    renderAt("/settings/store")
    await screen.findByTestId("app-store-row-calls")
    const chip = (name: string) => screen.getByTestId(`app-store-state-${name}`)
    expect(chip("tickets").textContent).toBe("Running")
    expect(chip("tickets").dataset.state).toBe("added")
    expect(chip("calls").textContent).toBe("Failed to load")
    expect(chip("calls").dataset.state).toBe("failed")
    expect(chip("parts").textContent).toBe("Upgrade failed")
    expect(chip("parts").dataset.state).toBe("upgrade-failed")
    // The reason is on the row's line, and on the chip's tooltip.
    expect(screen.getByTestId("app-store-reason-calls").textContent).toContain(
      "must NOT have additional properties",
    )
    expect(screen.getByTestId("app-store-reason-parts").textContent).toBe(
      "handler threw at registration",
    )
    expect(chip("parts").getAttribute("title")).toBe("handler threw at registration")
    // An errored app the server gives no reason for says it could not be loaded.
    expect(chip("projects").textContent).toBe("Failed to load")
    expect(screen.getByTestId("app-store-reason-projects").textContent).toBe(
      "The server could not load it.",
    )
    // Calm: failures read in neutral colours, never an alarm.
    for (const name of ["calls", "projects", "parts"]) {
      expect(chip(name).className).not.toMatch(/error|danger|warning/)
    }
    // An app turned Off reads Off, whatever happened to it.
    expect(chip("mail").textContent).toBe("Off")
    expect(screen.queryByTestId("app-store-reason-tickets")).toBeNull()
  })

  it("a retired app (package gone) reads Retired, by its name in words, and Remove removes it", async () => {
    orgList = [
      ...orgList,
      org("meta-ads", { status: "disabled", displayName: null, listing: null, retired: true }),
    ]
    api.on("post", "/org/apps/meta-ads/remove", () => {
      orgList = orgList.map((a) => (a.name === "meta-ads" ? { ...a, status: "removed" } : a))
      return {
        name: "meta-ads",
        status: "removed",
        accessMode: "everyone",
        principals: { roleIds: [], userIds: [] },
      }
    })
    renderAt("/settings/store")
    const row = await screen.findByTestId("app-store-row-meta-ads")
    expect(row.textContent).toContain("Meta Ads")
    expect(screen.getByTestId("app-store-state-meta-ads").textContent).toBe(
      "Retired, no longer available",
    )
    fireEvent.click(screen.getByTestId("app-store-remove-meta-ads"))
    expect(await screen.findByTestId("app-remove-dialog")).toBeTruthy()
    fireEvent.click(screen.getByTestId("app-remove-confirm"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/org/apps/meta-ads/remove"))
    await waitFor(() => expect(screen.queryByTestId("app-store-row-meta-ads")).toBeNull())
  })

  it("Add to workspace adds a server-installed app (POST /org/apps/:app/add)", async () => {
    api.on("post", "/org/apps/boxtal/add", () => {
      orgList = orgList.map((a) => (a.name === "boxtal" ? { ...a, status: "active" } : a))
      return {
        name: "boxtal",
        status: "active",
        accessMode: "everyone",
        principals: { roleIds: [], userIds: [] },
      }
    })
    renderAt("/settings/store")
    fireEvent.click(await screen.findByTestId("app-store-seg-available"))
    fireEvent.click(await screen.findByTestId("app-store-add-boxtal"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/org/apps/boxtal/add"))
    fireEvent.click(screen.getByTestId("app-store-seg-installed"))
    expect((await screen.findByTestId("app-store-state-boxtal")).textContent).toBe("Running")
  })

  it("Install installs a catalog app for the operator's org", async () => {
    api.on("post", "/apps/catalog/pennylane/install", () => ({ installed: "pennylane" }))
    renderAt("/settings/store")
    fireEvent.click(await screen.findByTestId("app-store-seg-available"))
    fireEvent.click(await screen.findByTestId("app-store-install-pennylane"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/apps/catalog/pennylane/install"))
  })

  it("an org that is not the server operator is told to ask the operator, and gets no Install from URL", async () => {
    handlers(false)
    renderAt("/settings/store")
    fireEvent.click(await screen.findByTestId("app-store-seg-available"))
    expect(await screen.findByTestId("app-store-ask-pennylane")).toBeTruthy()
    expect(screen.queryByTestId("app-store-install-pennylane")).toBeNull()
    expect(screen.queryByTestId("app-store-install-url")).toBeNull()
    expect(screen.getByTestId("app-store-operator-only")).toBeTruthy()
    // Adding an app the server already has stays possible.
    expect(screen.getByTestId("app-store-add-boxtal")).toBeTruthy()
  })

  it("Install from URL opens the install dialog", async () => {
    renderAt("/settings/store")
    fireEvent.click(await screen.findByTestId("app-store-install-url"))
    expect(await screen.findByPlaceholderText(/liaisonapp/i)).toBeTruthy()
  })

  it("says so calmly when the registry could not be reached", async () => {
    api.on("get", "/apps/catalog", () => ({ apps: CATALOG, notice: "registry_unreachable" }))
    renderAt("/settings/store")
    expect(await screen.findByTestId("app-store-registry-notice")).toBeTruthy()
  })

  it("shows no price anywhere, on the list or a listing", async () => {
    const PRICE = /price|pricing|\bplan\b|free|€|\$|\/\s?month|per month/i
    const { unmount } = renderAt("/settings/store")
    await screen.findByTestId("app-store-row-tickets")
    fireEvent.click(screen.getByTestId("app-store-seg-available"))
    await screen.findByTestId("app-store-row-pennylane")
    expect(document.body.textContent ?? "").not.toMatch(PRICE)
    unmount()
    renderAt("/settings/store/pennylane")
    await screen.findByTestId("app-store-detail-pennylane")
    expect(document.body.textContent ?? "").not.toMatch(PRICE)
  })

  it("the former connect deep link lands on the app's page or its connector card", async () => {
    renderAt("/settings/store?connect=mail&connection=imap")
    const page = await screen.findByTestId("landed-app-page")
    expect(window.location.pathname).toBe("/settings/apps/mail")
    expect(page.textContent).toBe("?open=imap")
  })

  it("a connector's deep link opens its card on Connectors", async () => {
    orgList = [...orgList, org("gitlab", { kind: "connector" })]
    renderAt("/settings/store?connect=gitlab")
    await screen.findByTestId("landed-connectors")
    expect(window.location.search).toBe("?open=gitlab")
  })
})

describe("App store listing page", () => {
  it("shows publisher, source repository, licence, category and permissions in plain words", async () => {
    renderAt("/settings/store/tickets")
    const detail = await screen.findByTestId("app-store-detail-tickets")
    expect(within(detail).getByTestId("app-store-detail-publisher").textContent).toContain(
      "Liaison",
    )
    const repo = within(detail).getByTestId("app-store-detail-repo")
    expect(repo.textContent).toBe(REPO)
    expect(within(detail).getByTestId("app-store-detail-category").textContent).toBe("Support")
    const perms = await within(detail).findByTestId("app-store-detail-perms")
    expect(perms.textContent).toContain("See tickets")
    expect(perms.textContent).toContain("Answer tickets")
    expect(within(detail).getByTestId("app-store-detail-open")).toBeTruthy()
  })

  it("a catalog app shows its licence and Install", async () => {
    renderAt("/settings/store/pennylane")
    await screen.findByTestId("app-store-detail-pennylane")
    expect(screen.getByTestId("app-store-detail-licence").textContent).toBe("FSL-1.1-ALv2")
    expect(screen.getByTestId("app-store-detail-install")).toBeTruthy()
    // Its declared scope reads in words even when no description exists for it (STO-03).
    const perms = await screen.findByTestId("app-store-detail-perms")
    expect(perms.textContent).toContain("read invoices")
    expect(perms.textContent).not.toContain("pennylane:invoices:read")
  })

  it("an installed app's permissions without a description read in words, never as ids", async () => {
    api.on("get", "/admin/scope-catalog", () => [
      { scope: "tickets:tickets:read", app: "tickets", description: "See tickets" },
      { scope: "tickets:replies:write", app: "tickets" },
    ])
    renderAt("/settings/store/tickets")
    const perms = await screen.findByTestId("app-store-detail-perms")
    await waitFor(() => expect(perms.textContent).toContain("See tickets"))
    expect(perms.textContent).toContain("edit replies")
    expect(perms.textContent).not.toMatch(/\w+:\w+:\w+/)
  })

  it("the listing header names an app with no display name by the same label as its row", async () => {
    orgList = [...orgList, org("mcp-manager", { displayName: null, listing: null })]
    renderAt("/settings/store/mcp-manager")
    const detail = await screen.findByTestId("app-store-detail-mcp-manager")
    expect(detail.textContent).toContain("Connected services")
    expect(document.body.textContent ?? "").not.toContain("mcp-manager")
  })

  it("an app whose manifest failed validation says so on its listing, with the server's reason", async () => {
    orgList = [
      ...orgList,
      {
        ...org("calls", { status: "error", installSource: "installed" }),
        problem: { code: "manifest_invalid", message: "/listing: must have property 'license'" },
      },
    ]
    renderAt("/settings/store/calls")
    const run = await screen.findByTestId("app-store-detail-run")
    expect(run.textContent).toContain("Failed to load")
    expect(screen.getByTestId("app-store-detail-reason").textContent).toContain(
      "must have property 'license'",
    )
  })

  it("a failed upgrade names the version it tried and the one still running, with the reason", async () => {
    orgList = [
      ...orgList,
      {
        ...org("calls", { installSource: "installed", version: "1.4.0" }),
        upgradeFailed: { version: "2.0.0", reasonCode: "timeout", reasonMessage: "gate timed out" },
      },
    ]
    api.on("get", "/apps", () => [
      { name: "calls", version: "1.4.0", source: "installed", status: "active" },
    ])
    renderAt("/settings/store/calls")
    const run = await screen.findByTestId("app-store-detail-run")
    expect(run.textContent).toContain("Upgrade to 2.0.0 failed. Still running 1.4.0.")
    expect(screen.getByTestId("app-store-detail-reason").textContent).toBe("gate timed out")
  })

  it("an app installed from a URL without a listing reads Unlisted", async () => {
    orgList = [...orgList, org("parts", { listing: null, installSource: "installed" })]
    renderAt("/settings/store/parts")
    await screen.findByTestId("app-store-detail-parts")
    expect(screen.getByTestId("app-store-detail-unlisted")).toBeTruthy()
    expect(screen.queryByTestId("app-store-detail-repo")).toBeNull()
  })

  it("an unlisted app still names its publisher, from its manifest (A12)", async () => {
    orgList = [...orgList, org("parts", { listing: null, installSource: "installed" })]
    api.on("get", "/apps", () => [
      { name: "tickets", version: "1.2.0", source: "in-tree", status: "active" },
      {
        name: "parts",
        version: "1.0.0",
        source: "installed",
        status: "active",
        author: "Parts Co",
      },
    ])
    renderAt("/settings/store/parts")
    const detail = await screen.findByTestId("app-store-detail-parts")
    expect(within(detail).getByTestId("app-store-detail-unlisted")).toBeTruthy()
    // L2: an outside app's publisher is only what its manifest claims.
    expect(within(detail).getByTestId("app-store-detail-publisher").textContent).toBe(
      "Parts Co (self-declared)",
    )
  })

  it("a first-party app's publisher reads plainly, never as self-declared", async () => {
    renderAt("/settings/store/tickets")
    const detail = await screen.findByTestId("app-store-detail-tickets")
    const publisher = within(detail).getByTestId("app-store-detail-publisher").textContent ?? ""
    expect(publisher).toContain("Liaison")
    expect(publisher).not.toContain("self-declared")
  })

  it("an outside app's listed publisher reads as self-declared in the store list too", async () => {
    orgList = [
      ...orgList,
      org("parts", {
        installSource: "installed",
        listing: {
          category: "Support",
          icon: "ticket",
          summary: "Parts.",
          sourceRepository: "https://example.org/parts",
          publisher: "Parts Co",
        },
      }),
    ]
    renderAt("/settings/store")
    const row = await screen.findByTestId("app-store-open-parts")
    expect(row.textContent).toContain("Parts Co (self-declared)")
    const tickets = await screen.findByTestId("app-store-open-tickets")
    expect(tickets.textContent).not.toContain("self-declared")
  })

  it("Remove from this workspace asks first, then removes (data kept)", async () => {
    api.on("post", "/org/apps/tickets/remove", () => ({
      name: "tickets",
      status: "removed",
      accessMode: "everyone",
      principals: { roleIds: [], userIds: [] },
    }))
    renderAt("/settings/store/tickets")
    fireEvent.click(await screen.findByTestId("app-store-detail-remove"))
    const dialog = await screen.findByTestId("app-remove-dialog")
    expect(dialog.textContent).toContain("Its data and settings are kept")
    fireEvent.click(screen.getByTestId("app-remove-confirm"))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/org/apps/tickets/remove"))
  })

  it("Uninstall from this server shows the server's guard when another workspace still has it", async () => {
    orgList = [...orgList, org("calls", { installSource: "installed" })]
    api.on("get", "/apps", () => [
      { name: "calls", version: "0.2.11", source: "installed", status: "active" },
    ])
    api.on("delete", "/apps/calls", () => {
      throw apiError(
        409,
        "conflict",
        "calls is still added in 2 other workspaces. It can be uninstalled once they remove it.",
      )
    })
    renderAt("/settings/store/calls")
    fireEvent.click(await screen.findByTestId("app-store-detail-more"))
    fireEvent.click(await screen.findByTestId("app-store-detail-uninstall"))
    fireEvent.click(await screen.findByTestId("app-store-uninstall-confirm"))
    const err = await screen.findByTestId("app-store-uninstall-error")
    expect(err.textContent).toContain("still added in 2 other workspaces")
  })

  it("Check for updates shows only for a package with an update channel, and previews the upgrade", async () => {
    orgList = [...orgList, org("calls", { installSource: "installed" })]
    api.on("get", "/apps", () => [
      {
        name: "calls",
        version: "0.2.11",
        source: "installed",
        status: "active",
        updateUrl: "https://example.org/calls.liaisonapp",
      },
    ])
    api.on("post", "/apps/calls/upgrade/preview", () => ({
      upToDate: false,
      version: "0.3.0",
      manifest: { name: "calls", version: "0.3.0", scopes: ["calls:calls:read"] },
      newScopes: ["calls:calls:read"],
      removedScopes: [],
      previouslyGranted: [],
    }))
    renderAt("/settings/store/calls")
    fireEvent.click(await screen.findByTestId("app-store-detail-check-updates"))
    expect(await screen.findByTestId("install-app-dialog")).toBeTruthy()
  })

  it("no Check for updates without an update channel", async () => {
    renderAt("/settings/store/tickets")
    await screen.findByTestId("app-store-detail-tickets")
    expect(screen.queryByTestId("app-store-detail-check-updates")).toBeNull()
  })

  it("names a conflicting install's status and the server's reason", async () => {
    orgList = [...orgList, org("calls", { installSource: "installed" })]
    api.on("get", "/apps", () => [
      {
        name: "calls",
        version: "9.0.0",
        source: "installed",
        status: "shadowed-by-bundled",
        statusMessage: "A bundled app of the same name takes precedence",
      },
    ])
    renderAt("/settings/store/calls")
    const status = await screen.findByTestId("app-store-detail-status")
    expect(status.textContent).toContain("takes precedence")
  })

  describe("Roll back to the previous version (S9, A10)", () => {
    function installedCalls(entry: Record<string, unknown> = {}) {
      orgList = [...orgList, org("calls", { installSource: "installed", version: "2.0.0" })]
      api.on("get", "/apps", () => [
        {
          name: "calls",
          version: "2.0.0",
          source: "installed",
          status: "active",
          previousVersion: "1.4.0",
          ...entry,
        },
      ])
    }

    it("the operator sees Roll back to <previous> beside the kept version", async () => {
      installedCalls()
      renderAt("/settings/store/calls")
      const button = await screen.findByTestId("app-store-detail-rollback")
      expect(button.textContent).toBe("Roll back to 1.4.0")
      expect(screen.getByTestId("app-store-detail-rollback-row").textContent).toContain(
        "Previous version",
      )
    })

    it("is hidden from an org that is not the instance operator", async () => {
      installedCalls()
      handlers(false)
      api.on("get", "/apps", () => [
        {
          name: "calls",
          version: "2.0.0",
          source: "installed",
          status: "active",
          previousVersion: "1.4.0",
        },
      ])
      renderAt("/settings/store/calls")
      await screen.findByTestId("app-store-detail-calls")
      await waitFor(() => expect(appsStore.canManageInstalls()).toBe(false))
      expect(screen.queryByTestId("app-store-detail-rollback")).toBeNull()
      expect(screen.queryByTestId("app-store-detail-rollback-row")).toBeNull()
    })

    it("is hidden without a previous version, and below a security release (noRollback)", async () => {
      installedCalls({ previousVersion: undefined })
      const first = renderAt("/settings/store/calls")
      await screen.findByTestId("app-store-detail-calls")
      expect(screen.queryByTestId("app-store-detail-rollback")).toBeNull()
      first.unmount()

      appsStore.reset()
      installedCalls({ noRollback: true })
      renderAt("/settings/store/calls")
      await screen.findByTestId("app-store-detail-calls")
      await waitFor(() => expect(appsStore.apps().some((a) => a.noRollback)).toBe(true))
      expect(screen.queryByTestId("app-store-detail-rollback")).toBeNull()
    })

    it("asks inline first (no browser dialog), then rolls back and refreshes", async () => {
      installedCalls()
      const confirmSpy = vi.spyOn(window, "confirm")
      api.on("post", "/apps/calls/rollback", () => ({
        name: "calls",
        version: "1.4.0",
        previousVersion: "2.0.0",
      }))
      renderAt("/settings/store/calls")
      fireEvent.click(await screen.findByTestId("app-store-detail-rollback"))
      const confirm = await screen.findByTestId("app-store-detail-rollback-confirm")
      expect(confirm.textContent).toContain("Roll Calls back to 1.4.0 for every workspace")
      expect(api.post).not.toHaveBeenCalledWith("/apps/calls/rollback")

      // Cancel closes the question and sends nothing.
      fireEvent.click(screen.getByTestId("app-store-detail-rollback-cancel"))
      expect(screen.queryByTestId("app-store-detail-rollback-confirm")).toBeNull()

      fireEvent.click(screen.getByTestId("app-store-detail-rollback"))
      fireEvent.click(await screen.findByTestId("app-store-detail-rollback-go"))
      await waitFor(() => expect(api.post).toHaveBeenCalledWith("/apps/calls/rollback"))
      await waitFor(() =>
        expect(screen.queryByTestId("app-store-detail-rollback-confirm")).toBeNull(),
      )
      expect(confirmSpy).not.toHaveBeenCalled()
      confirmSpy.mockRestore()
    })

    it("shows the server's reason when the rollback is refused, and keeps the question open", async () => {
      installedCalls()
      api.on("post", "/apps/calls/rollback", () => {
        throw apiError(
          409,
          "conflict",
          "calls 1.4.0 failed its health gate and was switched back; still running 2.0.0.",
        )
      })
      renderAt("/settings/store/calls")
      fireEvent.click(await screen.findByTestId("app-store-detail-rollback"))
      fireEvent.click(await screen.findByTestId("app-store-detail-rollback-go"))
      const err = await screen.findByTestId("app-store-detail-rollback-error")
      expect(err.textContent).toContain("still running 2.0.0")
      expect(err.className).not.toMatch(/error|danger/)
      expect(screen.getByTestId("app-store-detail-rollback-confirm")).toBeTruthy()
    })
  })

  it("an in-tree app is never offered an uninstall", async () => {
    renderAt("/settings/store/tickets")
    await screen.findByTestId("app-store-detail-tickets")
    expect(screen.queryByTestId("app-store-detail-more")).toBeNull()
  })
})
