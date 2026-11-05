// SPDX-License-Identifier: FSL-1.1-ALv2
// The App store's rows (S21, D17, A4, A11, A24-2): one row per app the
// workspace has, the server has installed, or the catalog offers, with the
// state that decides what the row says and does:
//
//   added        in this workspace and On            → "Added"
//   off          in this workspace and turned Off    → "Off"
//   update       added, and the catalog has a newer version → "Update available"
//   add          installed on the server, not added here → "Add to workspace"
//   install      not on the server, this org may install → "Install"
//   ask-operator not on the server, only the operator may install
//   retired      in this workspace, but its package is gone from the server
//                → "Retired, no longer available", with Remove
//
// A package installed from a URL without a store listing is Unlisted (A11).
// An app the workspace has On also carries how it runs (S8): Running, Failed
// to load (its manifest failed validation, or its registration threw, STO-09)
// or Upgrade failed (the server switched back from a newer version and still
// runs this one), each failure with its reason.
// The store never shows a price: listings carry none (D11), and no row field
// holds one.
import { APP_LISTING_CATEGORIES, type AppListing, type AppListingCategory } from "@liaison/app-sdk"
import type { OrgApp } from "../app-management/org-apps-store"
import type { AppEntry, CatalogEntry } from "../apps-store"

export type StoreState = "added" | "off" | "update" | "add" | "install" | "ask-operator" | "retired"
export type StoreKind = "app" | "connector"
export type StoreSegment = "installed" | "available"

/** Why the server could not load a workspace app (`GET /api/org/apps` `problem`). */
export interface AppProblem {
  code: "manifest_invalid" | "registration_failed"
  message?: string
}

/** The last version the server tried to activate and switched back from (`GET /api/org/apps`). */
export interface UpgradeFailure {
  version: string
  reasonCode: string | null
  reasonMessage: string | null
}

/** A workspace app as the admin list gives it, with its load problem and failed upgrade. */
export type StoreOrgApp = OrgApp & {
  problem?: AppProblem | null
  upgradeFailed?: UpgradeFailure | null
}

/** How an app the workspace has On runs (S8). */
export type RunState =
  | { state: "running" }
  | { state: "failed"; code: AppProblem["code"]; message?: string }
  | { state: "upgrade-failed"; version: string; message?: string }

export interface StoreItem {
  name: string
  /** The manifest's display name; absent when it has none (the page then uses the app's label). */
  displayName?: string
  kind: StoreKind
  state: StoreState
  listing: AppListing | null
  /** No listing and installed from a URL. */
  unlisted: boolean
  /** The catalog's long description, when it has one. */
  description?: string
  publisher?: string
  /**
   * The publisher is only what an outside app's manifest claims (`listing.publisher`
   * or `author`): shown as self-declared. A first-party app's (built in, the
   * image's catalog, or installed from it) is Liaison's own word.
   */
  publisherSelfDeclared: boolean
  license?: string
  /** The version this server runs (or the catalog offers when not installed). */
  version: string
  /** A newer catalog version, when there is one. */
  latestVersion?: string
  /** Installed on this server (any workspace). */
  serverInstalled: boolean
  /** Where it comes from: built into the server, a package, or the catalog only. */
  source: "in-tree" | "installed" | "catalog"
  /** A registry catalog app installs from this package (consent screen). */
  packageUrl?: string
  catalogSource?: "baked" | "registry"
  /** Scope names the app declares (catalog), for "What it can do". */
  scopes: string[]
  /** The server's registry entry (update channel, interface trust). */
  registry?: AppEntry
  /** The workspace's state of the app, for admins. */
  orgApp?: OrgApp
  /** How it runs, for an app the workspace has On (admins only: from the workspace's app list). */
  run?: RunState
  /** The version a rollback returns to, when one is allowed (S9, A10). */
  rollbackTo?: string
}

export interface StoreInputs {
  orgApps: readonly StoreOrgApp[]
  registry: readonly AppEntry[]
  catalog: readonly CatalogEntry[]
  /** This org may install on the server (the instance operator's org). */
  canManageInstalls: boolean
}

/** Is `a` a later version than `b` (dotted numbers; anything else compares as text)? */
export function isNewerVersion(a: string, b: string): boolean {
  const pa = a.split(/[.+-]/).map((p) => Number.parseInt(p, 10))
  const pb = b.split(/[.+-]/).map((p) => Number.parseInt(p, 10))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return a > b
    if (x !== y) return x > y
  }
  return false
}

export function buildStoreItems(input: StoreInputs): StoreItem[] {
  const names = new Set<string>()
  for (const a of input.orgApps) names.add(a.name)
  for (const a of input.registry) names.add(a.name)
  for (const a of input.catalog) names.add(a.name)
  names.delete("kernel")

  const items: StoreItem[] = []
  for (const name of names) {
    const org = input.orgApps.find((a) => a.name === name)
    const reg = input.registry.find((a) => a.name === name)
    const cat = input.catalog.find((a) => a.name === name)
    // A retired app (its package gone) is only a row to remove; once removed, nothing.
    if (org?.retired && !reg && !cat) {
      if (org.status !== "removed") items.push(retiredItem(org))
      continue
    }
    const inWorkspace = !!org && org.status !== "removed"
    const serverInstalled = !!org || !!reg || cat?.installed === true
    const installedVersion = cat?.installedVersion ?? reg?.version ?? org?.version ?? undefined
    const latestVersion =
      cat && installedVersion && cat.installed && isNewerVersion(cat.version, installedVersion)
        ? cat.version
        : undefined

    let state: StoreState
    if (inWorkspace) {
      state = org.status === "disabled" ? "off" : latestVersion ? "update" : "added"
    } else if (serverInstalled) {
      state = "add"
    } else {
      state = input.canManageInstalls ? "install" : "ask-operator"
    }

    const run = inWorkspace && org.status !== "disabled" ? runState(org) : undefined
    const rollbackTo =
      reg?.source === "installed" && reg.previousVersion && !reg.noRollback
        ? reg.previousVersion
        : undefined

    const listing = org?.listing ?? cat?.listing ?? null
    const source: StoreItem["source"] =
      org?.installSource ?? reg?.source ?? (cat?.installed ? "installed" : "catalog")
    const publisher = listing?.publisher ?? cat?.author ?? reg?.author
    // The server refuses an outside package under a baked catalog app's name, so an app
    // the image's catalog lists is that app.
    const firstParty =
      source === "in-tree" || reg?.uiTrust === "first-party" || cat?.source === "baked"
    items.push({
      name,
      displayName: org?.displayName ?? cat?.displayName ?? reg?.displayName ?? undefined,
      kind: (org?.kind ?? cat?.kind) === "connector" ? "connector" : "app",
      state,
      listing,
      unlisted: !listing && !cat && source === "installed",
      description: cat?.description,
      publisher,
      publisherSelfDeclared: !!publisher && !firstParty,
      license: cat?.license ?? org?.license ?? undefined,
      version: installedVersion ?? cat?.version ?? "",
      latestVersion,
      serverInstalled,
      source,
      packageUrl: cat?.packageUrl,
      catalogSource: cat?.source,
      scopes: cat?.scopes ?? [],
      registry: reg,
      orgApp: org,
      run,
      rollbackTo,
    })
  }
  return items.sort((a, b) => (a.displayName ?? a.name).localeCompare(b.displayName ?? b.name))
}

/** A load failure first (the app does not run here), then a failed upgrade, else Running. */
function runState(org: StoreOrgApp): RunState {
  if (org.problem || org.status === "error") {
    return {
      state: "failed",
      code: org.problem?.code ?? "registration_failed",
      ...(org.problem?.message ? { message: org.problem.message } : {}),
    }
  }
  if (org.upgradeFailed) {
    return {
      state: "upgrade-failed",
      version: org.upgradeFailed.version,
      ...(org.upgradeFailed.reasonMessage ? { message: org.upgradeFailed.reasonMessage } : {}),
    }
  }
  return { state: "running" }
}

/** "meta-ads" reads "Meta Ads": a retired app's stored name, when no manifest names it. */
export function titleCaseAppName(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

function retiredItem(org: StoreOrgApp): StoreItem {
  return {
    name: org.name,
    displayName: org.displayName ?? titleCaseAppName(org.name),
    kind: org.kind === "connector" ? "connector" : "app",
    state: "retired",
    listing: null,
    unlisted: false,
    publisherSelfDeclared: false,
    license: org.license ?? undefined,
    version: org.version ?? "",
    serverInstalled: false,
    source: org.installSource,
    scopes: [],
    orgApp: org,
  }
}

/** Added here, On or Off (a retired app stays listed with them until removed). */
export function isInWorkspace(item: Pick<StoreItem, "state">): boolean {
  return (
    item.state === "added" ||
    item.state === "off" ||
    item.state === "update" ||
    item.state === "retired"
  )
}

export interface StoreFilter {
  segment: StoreSegment
  category?: string
  kind?: StoreKind
  query?: string
  /** The name the reader sees (a translated label), searched with the rest. */
  labelOf?: (item: StoreItem) => string
}

export function filterStoreItems(items: readonly StoreItem[], f: StoreFilter): StoreItem[] {
  const words = (f.query ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  return items.filter((item) => {
    if (f.segment === "installed" ? !isInWorkspace(item) : isInWorkspace(item) || item.unlisted)
      return false
    if (f.category && item.listing?.category !== f.category) return false
    if (f.kind && item.kind !== f.kind) return false
    if (words.length === 0) return true
    const text = [
      f.labelOf?.(item),
      item.displayName,
      item.name,
      item.listing?.summary,
      item.description,
      item.publisher,
      item.kind,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

/** The listing categories the items use, in the catalog's order. */
export function storeCategories(items: readonly StoreItem[]): AppListingCategory[] {
  const used = new Set(items.map((i) => i.listing?.category).filter(Boolean))
  return APP_LISTING_CATEGORIES.filter((c) => used.has(c))
}
