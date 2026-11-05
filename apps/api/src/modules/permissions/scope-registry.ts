// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SCOPE REGISTRY, READABLE WITHOUT A RUNNING ORG.
//
// `getScopeCatalog(orgId)` is the runtime answer to "which scopes exist", and
// it is built from the LIVE registries: it needs an org whose apps have been
// registered in this process. The agent-roster migration has no such org (it
// is a CLI holding a database connection, not an app runtime), yet it writes
// scope ceilings, and a ceiling entry that names no real scope is not a
// degraded agent but a tool that does not exist for it: `mail:reply`,
// `mail:compose` and `shopify:draft_orders:read` all rode into a shipped
// ceiling as inert strings nobody could see (T26 F1).
//
// So this module answers the same question from what is on DISK: the kernel
// scope catalog plus every scope declared by an app manifest in the tree. It
// is deliberately WIDER than any one org's catalog (it does not know which
// apps an org installed), because its job is to catch a string that can never
// match anything anywhere, not to decide what a given org can do.

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { appSettingsSchema } from "@liaison/app-sdk"
import { decidingScopeForToolDef } from "@liaison/shared"
import {
  connectionAdminScopeOf,
  materialiseSections,
} from "~/modules/apps/settings-schema-from-manifest"
import { hasScope } from "~/modules/permissions/permissions"
import { KERNEL_SCOPES } from "~/modules/permissions/scope-catalog"

/** Repo root, from this file at apps/api/src/modules/permissions/. */
const ROOT = path.resolve(import.meta.dir, "../../../../..")

/** In-tree kernel-side apps: these are never packaged, so the source IS what runs. */
const IN_TREE_APPS_DIR = path.join(ROOT, "apps/api/src/apps")

/** The sources a bundled app is BUILT from. Not what a deployed server installs. */
const BUNDLED_APPS_DIR = path.join(ROOT, "bundled-apps")

/**
 * Test scaffolding apps (`test`, `test-bridge-a`, ...). They left
 * `apps/api/src/apps` for this directory, which the image never carries
 * (.dockerignore), and `discover-apps.ts` still registers them in a test or
 * development process. Read under the same NODE_ENV condition, so the registry
 * knows what such a process really registers and a production process never
 * does.
 */
const TEST_SUPPORT_APPS_DIR = path.join(ROOT, "apps/api/test-support/apps")

function testSupportAppsLoad(): boolean {
  const env = (process.env.NODE_ENV ?? "production").toLowerCase()
  return env === "test" || env === "development"
}

/**
 * WHAT A DEPLOYED LIAISON ACTUALLY INSTALLS (P8-FX2, SK-3).
 *
 * `bundled-apps/<name>/app.manifest.json` is the SOURCE of a first-party app.
 * The image installs the frozen `.liaisonapp` tarballs baked into the app
 * catalog (`reconcile-catalog-boot.ts` -> `reconcileCatalogApps`), and those
 * bundles are rebuilt by hand, so they lag their sources: measured on this
 * tree, all nine are version-drifted and `kpi:metrics:write` exists in the kpi
 * SOURCE and in no bundle. Reading the source made the registry call that
 * scope REAL while a deployed server registers nothing of the kind, which is
 * the inert-ceiling-entry class (T26 F1) this module exists to refuse.
 *
 * So the SHIPPED bundle wins wherever one exists, per app name. A bundled app
 * with no bundle baked yet (a dev tree that has not run
 * `scripts/build-app-catalog.ts`, or an app added since the last catalog
 * build) falls back to its source manifest: refusing there would turn every
 * dev checkout into a hard stop, and a scope that is only in the source is
 * only ever a scope the next catalog build will ship.
 *
 * Resolved exactly as `modules/apps/catalog.ts` resolves it, but WITHOUT
 * importing that module: this one is read by a CLI (the agent roster
 * migration) that holds a database connection and no app runtime, and
 * `catalog.ts` pulls the install service and the drizzle graph in behind it.
 */
function catalogDir(): string {
  if (process.env.LIAISON_APP_CATALOG_DIR) return process.env.LIAISON_APP_CATALOG_DIR
  if (existsSync("/app/app-catalog")) return "/app/app-catalog"
  return path.join(ROOT, "app-catalog")
}

/**
 * Every baked bundle's manifest, keyed by app name. A bundle that cannot be
 * read is skipped rather than fatal: the catalog is an operator artifact, and
 * failing the whole registry over one unreadable tarball would refuse every
 * ceiling in the org instead of the one app's scopes.
 */
function shippedManifests(): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>()
  const dir = catalogDir()
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".liaisonapp"))
  } catch {
    return out
  }
  for (const file of files) {
    // `<name>-<version>.liaisonapp`, the shape `scripts/build-app-catalog.ts`
    // writes and `catalog.json` indexes.
    const name = file.replace(/-\d[^-]*\.liaisonapp$/, "")
    const read = spawnSync("tar", ["-xzOf", path.join(dir, file), "app.manifest.json"], {
      maxBuffer: 64 * 1024 * 1024,
    })
    if (read.status !== 0) continue
    try {
      const manifest = JSON.parse(read.stdout.toString())
      // Highest version wins when a catalog holds two of one app.
      if (!out.has(name)) out.set(name, manifest)
    } catch {
      // Not a manifest we can read: see above, skipped rather than fatal.
    }
  }
  return out
}

function manifestScopes(manifest: Record<string, any>, appName: string, out: Set<string>): void {
  const add = (scope: unknown) => {
    if (typeof scope === "string" && scope.length > 0) out.add(scope)
  }

  for (const tool of Object.values(manifest.tools ?? {})) {
    const def = tool as { requiredScopes?: unknown }
    if (Array.isArray(def.requiredScopes)) for (const scope of def.requiredScopes) add(scope)
    // `approveScope` IS NOT READ HERE. The manifest schema (apps/contract.ts)
    // refuses the field on purpose: an app that could name the scope which
    // decides its own approvals could name a weak one and dodge
    // `<app>:approve`. A manifest that smuggles the key past the schema must
    // therefore widen nothing, so the deciding scope of a manifest tool is
    // always the app default added below.
  }
  for (const role of Object.values(manifest.roles ?? {})) {
    const scopes = (role as { scopes?: unknown }).scopes
    if (Array.isArray(scopes)) for (const scope of scopes) add(scope)
  }
  for (const entity of Object.values(manifest.entities ?? {})) {
    add((entity as { readScope?: unknown }).readScope)
  }
  for (const bulk of Object.values(manifest.bulk ?? {})) {
    add((bulk as { scope?: unknown }).scope)
  }
  // The declarative settings page, MATERIALISED the way the runtime registers
  // it (runtime.ts -> materialiseSections): an org section that names no
  // `adminScope` gets the admin scope of the connections it shows, which is
  // where the live catalog's `<app>:accounts:admin` comes from. Reading only
  // the raw `adminScope` here missed every such scope (`database:accounts:admin`
  // was live and unknown offline). A settings block the runtime would refuse
  // falls back to the raw values, so the registry never narrows over it.
  const connections = manifest.connections as Record<string, { adminScope?: string }> | undefined
  const parsed = appSettingsSchema.safeParse(manifest.settings)
  if (parsed.success) {
    for (const section of materialiseSections(parsed.data, { app: appName, connections })) {
      add(section.adminScope)
    }
  } else {
    const sections = (manifest.settings as { sections?: unknown } | undefined)?.sections
    if (Array.isArray(sections)) {
      for (const section of sections) add((section as { adminScope?: unknown }).adminScope)
    }
  }
  // Every connection's admin scope, shown on a settings page or not: the
  // connections routes enforce it on connect, share and disconnect
  // (connections/admin-scope.ts), so it is a real, grantable scope.
  if (connections && typeof connections === "object") {
    for (const connection of Object.values(connections)) {
      add(connectionAdminScopeOf(appName, connection))
    }
  }
  // The approver scope every app gets when no tool declares one of its own.
  // ASKED, not recomputed: "what scope decides this approval?" has exactly one
  // answerer, and a second derivation here is the divergence that made four
  // prod reports in one week (see approvals/authority-closure.test.ts).
  add(decidingScopeForToolDef({}, appName))
}

let cached: Set<string> | null = null

/**
 * Every scope string this build knows about: the kernel catalog, the kernel
 * tool scopes above, and every scope any first-party app manifest declares.
 * Computed once per process.
 */
export function knownScopeUniverse(): Set<string> {
  if (cached) return cached
  const out = new Set<string>()
  for (const entry of KERNEL_SCOPES) out.add(entry.scope)

  const shipped = shippedManifests()
  for (const [name, manifest] of shipped) {
    manifestScopes(manifest, typeof manifest.name === "string" ? manifest.name : name, out)
  }

  const sourceDirs = [IN_TREE_APPS_DIR, BUNDLED_APPS_DIR]
  if (testSupportAppsLoad()) sourceDirs.push(TEST_SUPPORT_APPS_DIR)
  for (const dir of sourceDirs) {
    let entries: string[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const name of entries) {
      // The shipped bundle has already spoken for this app.
      if (dir === BUNDLED_APPS_DIR && shipped.has(name)) continue
      const file = path.join(dir, name, "app.manifest.json")
      let manifest: Record<string, any>
      try {
        manifest = JSON.parse(readFileSync(file, "utf8"))
      } catch {
        continue
      }
      manifestScopes(manifest, typeof manifest.name === "string" ? manifest.name : name, out)
    }
  }

  cached = out
  return out
}

/** The scope set one packaged bundle declares, for a drift report or a test. */
export function shippedAppScopes(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [name, manifest] of shippedManifests()) {
    const scopes = new Set<string>()
    manifestScopes(manifest, typeof manifest.name === "string" ? manifest.name : name, scopes)
    out.set(name, scopes)
  }
  return out
}

/** The same, read off a bundled app's SOURCE manifest. */
export function sourceAppScopes(name: string): Set<string> {
  const out = new Set<string>()
  const manifest = JSON.parse(
    readFileSync(path.join(BUNDLED_APPS_DIR, name, "app.manifest.json"), "utf8"),
  )
  manifestScopes(manifest, typeof manifest.name === "string" ? manifest.name : name, out)
  return out
}

/** Test seam: drop the memoized universe (a test that writes a manifest). */
export function invalidateScopeUniverse(): void {
  cached = null
}

/**
 * The entries of `scopes` that grant nothing at all: no scope in the universe
 * matches them, directly or through their wildcard. `*` and a wildcard that
 * covers at least one real scope are known; `mail:reply` is not.
 */
/**
 * True when `entry` is a scope some app or the kernel DECLARES, exactly, rather
 * than a prefix of one. `tickets:tickets:read` is declared; `tickets` is not,
 * however many scopes it would reach through `hasScope`'s prefix matching.
 */
export function isDeclaredScope(entry: string, alsoKnown: Iterable<string> = []): boolean {
  if (knownScopeUniverse().has(entry)) return true
  for (const scope of alsoKnown) if (scope === entry) return true
  return false
}

/**
 * `alsoKnown` is the LIVE half (P8-FX2, SK-4): scopes an app installed at
 * RUNTIME declares, which no manifest in this deploy tree can name. The
 * registry on its own is a disk-only answer, and its refusal is a hard stop
 * (`CeilingUnknownScopeError` -> the roster migration writes no row for ANY
 * role), so an org that sideloaded a third-party `.liaisonapp` and wants one
 * of its scopes in a role ceiling could not migrate at all. A caller holding a
 * database connection passes what the instance has actually installed
 * (`kernel.apps_installed.granted_scopes` for the active version of each app);
 * a caller without one passes nothing and gets the disk answer, unchanged.
 */
export function unknownScopes(
  scopes: readonly string[],
  alsoKnown: Iterable<string> = [],
): string[] {
  const universe = knownScopeUniverse()
  const extra = [...alsoKnown]
  return scopes.filter((entry) => {
    for (const scope of universe) {
      if (hasScope(scope, [entry])) return false
    }
    for (const scope of extra) {
      // BOTH directions here, unlike the universe above. The universe holds
      // leaves, so "does this entry cover a real scope" is the only question.
      // An install row's `granted_scopes` may itself be a family grant
      // (`acme:widgets:*`), and a ceiling naming one of its leaves is then
      // naming something the instance really grants.
      if (hasScope(scope, [entry]) || hasScope(entry, [scope])) return false
    }
    return true
  })
}
