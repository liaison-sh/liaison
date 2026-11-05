// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The registry decides whether a ceiling entry names anything real, and a
// deployed Liaison installs its first-party apps from the frozen `.liaisonapp`
// bundles baked into the image catalog, never from `bundled-apps/` sources.
// These tests hold it to that: what ships is what counts, with the source
// manifests as the dev-tree fallback and the live install list as the way out
// for an app this tree has never seen.

import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { appSettingsSchema } from "@liaison/app-sdk"
import { manifestRegistry } from "~/modules/apps/app-registries"
import {
  connectionAdminScopeOf,
  materialiseSections,
} from "~/modules/apps/settings-schema-from-manifest"
import { getScopeCatalog, invalidateScopeCatalog } from "~/modules/permissions/scope-catalog"
import {
  invalidateScopeUniverse,
  shippedAppScopes,
  sourceAppScopes,
  unknownScopes,
} from "~/modules/permissions/scope-registry"
import { buildTempAppCatalog } from "~/tests/helpers/bundled-app-build"

const originalCatalogDir = process.env.LIAISON_APP_CATALOG_DIR
const temps: string[] = []

afterEach(() => {
  if (originalCatalogDir === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
  else process.env.LIAISON_APP_CATALOG_DIR = originalCatalogDir
  invalidateScopeUniverse()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A catalog directory holding one fabricated bundle, built the way the real ones are. */
function catalogWith(appName: string, manifest: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "scope-registry-catalog-"))
  temps.push(dir)
  const stage = path.join(dir, "stage")
  mkdirSync(stage)
  writeFileSync(path.join(stage, "app.manifest.json"), JSON.stringify(manifest))
  const packed = spawnSync("tar", [
    "-czf",
    path.join(dir, `${appName}-0.0.1.liaisonapp`),
    "-C",
    stage,
    "app.manifest.json",
  ])
  expect(packed.status).toBe(0)
  return dir
}

/**
 * The two tree-derived tests below read the image catalog. A checkout that
 * never built one (it is a gitignored build output) has no bundle at all, so
 * build it once into a temp dir and point the registry at it; a checkout that
 * has one keeps using it, drift and all.
 */
let builtCatalog: string | undefined
function useShippedCatalog(): void {
  if (shippedAppScopes().size > 0) return
  builtCatalog ??= buildTempAppCatalog()
  process.env.LIAISON_APP_CATALOG_DIR = builtCatalog
  invalidateScopeUniverse()
}
afterAll(() => {
  if (builtCatalog) rmSync(builtCatalog, { recursive: true, force: true })
})

describe("scope registry: the shipped bundle decides", () => {
  it("refuses a scope a bundled app declares in its source but not in the bundle it ships", () => {
    // Derived from the tree, never pinned to one app: whatever the current
    // drift is, every scope that exists only in a source manifest is a scope a
    // deployed server never registers, so a ceiling naming it grants nothing.
    // Rebuilding the catalog makes this list empty and the assertion still
    // holds.
    useShippedCatalog()
    const shipped = shippedAppScopes()
    expect(shipped.size).toBeGreaterThan(0)
    for (const [name, bundleScopes] of shipped) {
      for (const scope of sourceAppScopes(name)) {
        if (bundleScopes.has(scope)) continue
        expect(unknownScopes([scope])).toEqual([scope])
      }
    }
  })

  it("accepts every scope the bundles actually ship", () => {
    useShippedCatalog()
    for (const [, bundleScopes] of shippedAppScopes()) {
      for (const scope of bundleScopes) expect(unknownScopes([scope])).toEqual([])
    }
  })

  it("reads a scope that exists only inside a packaged bundle", () => {
    process.env.LIAISON_APP_CATALOG_DIR = catalogWith("probeapp", {
      name: "probeapp",
      tools: { probe: { requiredScopes: ["probeapp:thing:read"] } },
    })
    invalidateScopeUniverse()
    expect(unknownScopes(["probeapp:thing:read"])).toEqual([])
  })

  it("falls back to a bundled app's source when no bundle is baked for it", () => {
    // A dev tree that has never run `scripts/build-app-catalog.ts`, or an app
    // added since the last build: refusing there would make every checkout a
    // hard stop. The catalog below bakes ONE unrelated app, so every real
    // bundled app is unbaked there and has to be read from its source again.
    //
    // The scope under test is DERIVED from the tree rather than pinned to one
    // app: pinning it made this test pass or fail on whether the local
    // `app-catalog/` happened to have been rebuilt, which is an artifact of
    // the checkout and not of the registry.
    process.env.LIAISON_APP_CATALOG_DIR = catalogWith("probeapp", {
      name: "probeapp",
      tools: { probe: { requiredScopes: ["probeapp:thing:read"] } },
    })
    invalidateScopeUniverse()
    const sourceOnly = [...sourceAppScopes("boxtal")]
    expect(sourceOnly.length).toBeGreaterThan(0)
    expect(unknownScopes(sourceOnly)).toEqual([])
    // ... and the fallback is the ONLY reason it resolves: a name no manifest
    // anywhere declares is still refused under the same catalog.
    expect(unknownScopes(["boxtal:nothing:atall"])).toEqual(["boxtal:nothing:atall"])
  })

  it("still refuses a string no manifest anywhere declares", () => {
    expect(unknownScopes(["mail:reply", "shopify:draft_orders:read"])).toEqual([
      "mail:reply",
      "shopify:draft_orders:read",
    ])
  })
})

describe("scope registry: declarative settings sections", () => {
  // settings-overhaul P2 T2 (A22): a section's adminScope is a real scope even
  // when no tool or role names it, so removing `views.settings` cannot drop one.
  it("reads the adminScope of a settings section", () => {
    process.env.LIAISON_APP_CATALOG_DIR = catalogWith("sectionapp", {
      name: "sectionapp",
      settings: {
        sections: [
          {
            id: "general",
            title: "General",
            scope: "org",
            adminScope: "sectionapp:settings:admin",
            blocks: [{ block: "field", key: "x", type: "text", label: "X" }],
          },
        ],
      },
    })
    invalidateScopeUniverse()
    expect(unknownScopes(["sectionapp:settings:admin"])).toEqual([])
  })
})

describe("scope registry: a manifest cannot pick its own deciding scope", () => {
  // `approveScope` is HOST-ONLY (modules/apps/contract.ts says so in a comment
  // whose whole point is this): an app that could name the scope which decides
  // its own approvals could name a weak one and dodge `<app>:approve`. The
  // manifest schema refuses the field, so a manifest carrying it has smuggled
  // it past the schema, and the registry must not turn it into a real scope.
  it("does not widen the registry with a manifest-declared approveScope", () => {
    process.env.LIAISON_APP_CATALOG_DIR = catalogWith("smuggler", {
      name: "smuggler",
      tools: {
        risky: { requiredScopes: ["smuggler:thing:write"], approveScope: "smuggler:thing:read" },
      },
    })
    invalidateScopeUniverse()
    // The tool's own scope is real, and so is the app's default approver.
    expect(unknownScopes(["smuggler:thing:write"])).toEqual([])
    expect(unknownScopes(["smuggler:approve"])).toEqual([])
    // The smuggled one grants nothing: it is not a scope this app declares,
    // it is a claim about who decides, and the manifest does not get to make
    // it. `smuggler:thing:read` is declared nowhere else, so if the registry
    // had read the field this list would be empty.
    expect(unknownScopes(["smuggler:thing:read"])).toEqual(["smuggler:thing:read"])
  })
})

describe("scope registry: an app installed at runtime", () => {
  it("refuses its scope on the disk answer alone", () => {
    expect(unknownScopes(["acme:widgets:read"])).toEqual(["acme:widgets:read"])
  })

  it("accepts it when the caller can say what the instance has installed", () => {
    // What a caller holding a database connection passes: the granted scopes of
    // the active version of every installed app.
    expect(unknownScopes(["acme:widgets:read"], ["acme:widgets:read"])).toEqual([])
    expect(unknownScopes(["acme:widgets:write"], ["acme:widgets:*"])).toEqual([])
  })

  it("does not let the live list smuggle in a string nothing declares", () => {
    expect(unknownScopes(["acme:gadgets:read"], ["acme:widgets:read"])).toEqual([
      "acme:gadgets:read",
    ])
  })
})

describe("scope registry: connection-derived scopes agree with the live catalog", () => {
  const MANIFEST_DIRS = [
    path.join(import.meta.dir, "../../apps"),
    path.join(import.meta.dir, "../../../../../bundled-apps"),
  ]

  /** Every in-tree and bundled app source manifest that declares connections. */
  function connectionApps(): Array<{ name: string; manifest: Record<string, any> }> {
    const out: Array<{ name: string; manifest: Record<string, any> }> = []
    for (const dir of MANIFEST_DIRS) {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name, "app.manifest.json")
        if (!existsSync(file)) continue
        const manifest = JSON.parse(readFileSync(file, "utf8"))
        if (manifest.connections && Object.keys(manifest.connections).length > 0) {
          out.push({ name: manifest.name ?? name, manifest })
        }
      }
    }
    return out
  }

  /** The live catalog of one org that registered `manifest` the way runtime.ts does. */
  function liveCatalogFor(name: string, manifest: Record<string, any>): string[] {
    const orgId = `scope-registry-live-${name}`
    manifestRegistry.set([orgId, name], {
      name,
      roles: manifest.roles,
      entities: manifest.entities,
      bulk: manifest.bulk,
      views: manifest.views,
      settings: manifest.settings
        ? {
            sections: materialiseSections(appSettingsSchema.parse(manifest.settings), {
              app: name,
              connections: manifest.connections,
            }),
          }
        : undefined,
    } as never)
    invalidateScopeCatalog(orgId)
    try {
      return getScopeCatalog(orgId).map((entry) => entry.scope)
    } finally {
      manifestRegistry.delete([orgId, name])
      invalidateScopeCatalog(orgId)
    }
  }

  it("knows every connection admin scope the live catalog derives, for every app", () => {
    // Source manifests only: point the registry at an empty catalog.
    const empty = mkdtempSync(path.join(tmpdir(), "scope-registry-empty-"))
    temps.push(empty)
    process.env.LIAISON_APP_CATALOG_DIR = empty
    invalidateScopeUniverse()

    const apps = connectionApps()
    expect(apps.map((a) => a.name)).toContain("database")
    const missing: string[] = []
    let derived = 0
    for (const { name, manifest } of apps) {
      const connectionScopes = new Set(
        Object.values(manifest.connections as Record<string, { adminScope?: string }>).map((c) =>
          connectionAdminScopeOf(name, c),
        ),
      )
      for (const scope of liveCatalogFor(name, manifest)) {
        if (!connectionScopes.has(scope)) continue
        derived++
        if (unknownScopes([scope]).length > 0) missing.push(`${name}: ${scope}`)
      }
      // And the offline registry knows each connection's admin scope even when
      // no settings section shows it: the connections routes enforce it.
      for (const scope of connectionScopes) {
        if (unknownScopes([scope]).length > 0) missing.push(`${name}: ${scope} (routes)`)
      }
    }
    expect(derived).toBeGreaterThan(0)
    expect(missing).toEqual([])
    expect(unknownScopes(["database:accounts:admin"])).toEqual([])
  })
})
