// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression guard for the "scope-vocabulary ≠ table-name RLS" bug class.
//
// Each governed app table generates an RLS scope check keyed on
// `<app>:<scopeEntity>:<op>`, where `scopeEntity` is the table's `rlsScope`
// alias (else its physical table name). If NO declared grantable scope can
// satisfy that check, the table is unreachable for every grantable role — so a
// least-privilege user who legitimately calls a tool touching that table fails
// under RLS (the invoicing `document_lines`/`issuer_profiles` 500s; the same
// latent defect existed for boxtal's singular `shipment` table and the
// shopify/boxtal system tables). This test fails the moment any bundled app
// reintroduces an unreachable governed table.
//
// It reads the grantable scopes and the migration-governed tables exactly as
// the registration does (`declaredGrantableScopes` through the app's scope
// aliases, `rlsManagedBy`, `rlsGovernedByMigration`), and covers the built-in apps under
// apps/api/src/apps as well: their check must stay silent at every boot.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { TEST_ONLY_APPS } from "~/modules/apps/discover-apps"
import { grantableScopesWithAppAliases } from "~/modules/apps/runtime-helpers"
import {
  declaredGrantableScopes,
  tablesUnreachableByGrantableScopes,
} from "~/modules/permissions/rls-generator"

// apps/api/src/modules/apps → ../../../../.. → liaison root
const BUNDLED_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "bundled-apps")
// apps/api/src/modules/apps → ../.. → apps/api/src
const BUILTIN_DIR = join(import.meta.dir, "..", "..", "apps")

interface Manifest {
  name?: string
  rlsManagedBy?: string
  schema?: Record<string, { rlsScope?: unknown; rlsGovernedByMigration?: unknown }>
  scopes?: string[]
  roles?: unknown
  tools?: unknown
}

function loadManifest(dir: string, appDir: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(dir, appDir, "app.manifest.json"), "utf8"))
  } catch {
    return null
  }
}

function unreachable(manifest: Manifest): string[] {
  return tablesUnreachableByGrantableScopes(
    manifest.name as string,
    manifest.schema,
    grantableScopesWithAppAliases(manifest.name as string, declaredGrantableScopes(manifest)),
    { rlsManagedBy: manifest.rlsManagedBy },
  )
}

function appDirsOf(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
}

describe("bundled app RLS-scope reachability", () => {
  const appDirs = appDirsOf(BUNDLED_DIR)

  it("discovers at least the known governed apps", () => {
    // Guards against the glob silently matching nothing (a green-by-vacuity bug).
    expect(appDirs).toEqual(expect.arrayContaining(["invoicing", "shopify", "boxtal"]))
  })

  for (const appDir of appDirs) {
    const manifest = loadManifest(BUNDLED_DIR, appDir)
    if (!manifest?.schema || !manifest.name) continue // connectors/UI-only apps own no tables
    it(`${appDir}: every governed table is reachable by a declared grantable scope`, () => {
      expect(unreachable(manifest)).toEqual([])
    })
  }
})

describe("built-in app RLS-scope reachability", () => {
  // Test scaffolding (`test`, `example`, ...) never registers in production.
  const appDirs = appDirsOf(BUILTIN_DIR).filter((d) => !TEST_ONLY_APPS.has(d))

  it("discovers the built-in apps whose tables migrations govern", () => {
    expect(appDirs).toEqual(expect.arrayContaining(["mail", "projects", "knowledge", "tickets"]))
  })

  for (const appDir of appDirs) {
    const manifest = loadManifest(BUILTIN_DIR, appDir)
    if (!manifest?.schema || !manifest.name) continue
    it(`${appDir}: every governed table is reachable or migration-governed`, () => {
      expect(unreachable(manifest)).toEqual([])
    })
  }
})
