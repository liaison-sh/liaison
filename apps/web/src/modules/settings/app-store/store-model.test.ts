// SPDX-License-Identifier: FSL-1.1-ALv2
// The App store's rows (S21, D17, A4, A11, A24-2): one row per app the server
// or its catalog knows, with the workspace state that decides its action.
import { describe, expect, it } from "vitest"
import type { OrgApp } from "../app-management/org-apps-store"
import type { AppEntry, CatalogEntry } from "../apps-store"
import { buildStoreItems, filterStoreItems, storeCategories, titleCaseAppName } from "./store-model"

const LISTING = {
  category: "Support" as const,
  icon: "ticket",
  summary: "Shared inboxes become tickets.",
  sourceRepository: "https://example.org/liaison/tree/main/apps/tickets",
}

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
    listing: LISTING,
    settings: null,
    ...over,
  }
}

function cat(name: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    name,
    version: "0.2.0",
    installed: false,
    source: "baked",
    listing: { ...LISTING, category: "Finance", summary: `${name} summary` },
    license: "FSL-1.1-ALv2",
    ...over,
  }
}

const reg = (name: string, over: Partial<AppEntry> = {}): AppEntry => ({
  name,
  version: "0.3.1",
  source: "installed",
  status: "active",
  ...over,
})

describe("buildStoreItems", () => {
  it("derives Added, Off, Update available, Add to workspace, Install and Ask your server operator", () => {
    const items = buildStoreItems({
      orgApps: [
        org("tickets"),
        org("mail", { status: "disabled" }),
        org("invoicing", { installSource: "installed", kind: "app" }),
        org("calls", { status: "removed", installSource: "installed" }),
      ],
      registry: [reg("invoicing"), reg("calls")],
      catalog: [
        cat("invoicing", { installed: true, installedVersion: "0.1.0", version: "0.2.0" }),
        cat("calls", { installed: true, installedVersion: "0.2.0", version: "0.2.0" }),
        cat("pennylane", { kind: "connector" }),
      ],
      canManageInstalls: true,
    })
    const state = (n: string) => items.find((i) => i.name === n)?.state
    expect(state("tickets")).toBe("added")
    expect(state("mail")).toBe("off")
    expect(state("invoicing")).toBe("update")
    expect(state("calls")).toBe("add")
    expect(state("pennylane")).toBe("install")
    expect(items.find((i) => i.name === "pennylane")?.kind).toBe("connector")

    const asMember = buildStoreItems({
      orgApps: [],
      registry: [],
      catalog: [cat("pennylane")],
      canManageInstalls: false,
    })
    expect(asMember[0].state).toBe("ask-operator")
  })

  it("an app in no catalog shows the licence its manifest declares", () => {
    const items = buildStoreItems({
      orgApps: [org("tickets", { license: "FSL-1.1-ALv2" })],
      registry: [],
      catalog: [cat("invoicing", { license: "MIT" })],
      canManageInstalls: true,
    })
    expect(items.find((i) => i.name === "tickets")?.license).toBe("FSL-1.1-ALv2")
    expect(items.find((i) => i.name === "invoicing")?.license).toBe("MIT")
  })

  it("never lists the kernel", () => {
    const items = buildStoreItems({
      orgApps: [org("kernel"), org("tickets")],
      registry: [],
      catalog: [],
      canManageInstalls: true,
    })
    expect(items.map((i) => i.name)).toEqual(["tickets"])
  })

  it("an app installed from a URL without a listing is Unlisted", () => {
    const items = buildStoreItems({
      orgApps: [org("parts", { listing: null, installSource: "installed" })],
      registry: [reg("parts")],
      catalog: [],
      canManageInstalls: true,
    })
    expect(items[0].unlisted).toBe(true)
    expect(items[0].state).toBe("added")
  })

  it("a registry app not on the server installs from its package URL", () => {
    const items = buildStoreItems({
      orgApps: [],
      registry: [],
      catalog: [
        cat("acme-pay", {
          source: "registry",
          packageUrl: "https://registry.example/acme-pay.tgz",
        }),
      ],
      canManageInstalls: true,
    })
    expect(items[0].state).toBe("install")
    expect(items[0].packageUrl).toBe("https://registry.example/acme-pay.tgz")
  })
})

describe("filterStoreItems", () => {
  const items = buildStoreItems({
    orgApps: [org("tickets"), org("mail", { status: "disabled" })],
    registry: [],
    catalog: [cat("pennylane", { kind: "connector" }), cat("boxtal")],
    canManageInstalls: true,
  })

  it("Installed holds Added and Off apps; Available the rest", () => {
    expect(filterStoreItems(items, { segment: "installed" }).map((i) => i.name)).toEqual([
      "mail",
      "tickets",
    ])
    expect(filterStoreItems(items, { segment: "available" }).map((i) => i.name)).toEqual([
      "boxtal",
      "pennylane",
    ])
  })

  it("filters by category, kind and search text", () => {
    expect(
      filterStoreItems(items, { segment: "available", category: "Finance" }).map((i) => i.name),
    ).toEqual(["boxtal", "pennylane"])
    expect(
      filterStoreItems(items, { segment: "available", kind: "connector" }).map((i) => i.name),
    ).toEqual(["pennylane"])
    expect(
      filterStoreItems(items, { segment: "available", query: "BOXTAL sum" }).map((i) => i.name),
    ).toEqual(["boxtal"])
  })

  it("lists the categories present, in the catalog's order", () => {
    expect(storeCategories(items)).toEqual(["Support", "Finance"])
  })
})

describe("a retired app (its package gone from the server)", () => {
  const items = buildStoreItems({
    orgApps: [
      org("tickets"),
      org("meta-ads", { status: "disabled", displayName: null, listing: null, retired: true }),
      org("old-thing", { status: "removed", displayName: null, listing: null, retired: true }),
    ],
    registry: [],
    catalog: [],
    canManageInstalls: true,
  })

  it("is listed as retired under Installed, by its name in words; once removed, not at all", () => {
    const retired = items.find((i) => i.name === "meta-ads")
    expect(retired).toMatchObject({ state: "retired", displayName: "Meta Ads", listing: null })
    expect(filterStoreItems(items, { segment: "installed" }).map((i) => i.name)).toEqual([
      "meta-ads",
      "tickets",
    ])
    expect(filterStoreItems(items, { segment: "available" })).toEqual([])
    expect(items.find((i) => i.name === "old-thing")).toBeUndefined()
  })

  it("names a stored app id in words", () => {
    expect(titleCaseAppName("meta-ads")).toBe("Meta Ads")
    expect(titleCaseAppName("google_drive")).toBe("Google Drive")
  })
})
