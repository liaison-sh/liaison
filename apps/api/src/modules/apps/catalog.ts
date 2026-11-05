// SPDX-License-Identifier: FSL-1.1-ALv2
//
// First-party APP CATALOG. The image bakes a directory of frozen `.liaisonapp`
// tarballs for every `bundled-apps/<name>/` plus a `catalog.json` index (built
// by `scripts/build-app-catalog.ts`, copied to `/app/app-catalog` in the
// Dockerfile). This module reads that index so the Apps UI and
// `liaison config apply` can install a first-party app with ONE click -- no
// URL, no external fetch, no signature ceremony.
//
// Trust model: catalog apps are FIRST-PARTY and shipped inside the operator's
// own image, the same trust boundary as the server binary. So `installCatalogApp`
// installs with `requireSignature: false` and auto-grants the app's own declared
// scopes/connections -- the operator installing their own bundled app does not
// re-consent to scopes they authored. Sideloading an UNTRUSTED third-party
// `.liaisonapp` still goes through `POST /api/apps/install` (URL + signature +
// explicit scope grant); the catalog never installs anything not baked in.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AppKind, AppListing } from "@liaison/app-sdk"
import { HTTPException } from "hono/http-exception"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { organizations } from "~/db/schema/kernel/organizations"
import { appsLogger as log } from "~/lib/logger"
import { type ActivationActor, compareVersions, isNewerVersion } from "~/modules/apps/activation"
import { bumpCatalogGeneration } from "~/modules/apps/catalog-generation"
import { getInstallRoot } from "~/modules/apps/discover-apps"
import { reloadInstalledApps } from "~/modules/apps/init"
import { type InstallResult, installAppFromTarball } from "~/modules/apps/install-service"
import { hashTree } from "~/modules/apps/version-dir"

/** One catalog entry, mirrored by the `catalog.json` written by
 * `scripts/build-app-catalog.ts`. */
export interface CatalogEntry {
  name: string
  displayName?: string
  description?: string
  version: string
  kind?: AppKind
  /** SPDX license expression (build-app-catalog requires it with the listing). */
  license?: string
  author?: string
  /** The App store listing (build-app-catalog refuses to bake an app without one). */
  listing?: AppListing
  /** Tarball filename, relative to the catalog dir. */
  file: string
  /** Scopes the manifest requests -- granted in full on a first-party install. */
  scopes: string[]
  /** Connection ids the app declares -- granted in full on install. */
  connections: string[]
  /** Present when `file` is the signed release artifact (build-app-catalog verified it):
   *  its statement and signature files, relative to the catalog dir. */
  signed?: { statement: string; signature: string }
}

export type CatalogEntryWithState = Omit<
  CatalogEntry,
  "file" | "scopes" | "connections" | "signed"
> & {
  /** Whether this app is currently installed (has an active version) on the instance. */
  installed: boolean
  /** The active on-instance version, when installed -- lets a caller detect that
   *  the baked catalog `version` is newer (an available upgrade). */
  installedVersion?: string
}

/** Resolve the catalog directory. Baked into the image at `/app/app-catalog`;
 *  overridable for dev/tests via `LIAISON_APP_CATALOG_DIR`; falls back to the
 *  repo-root `app-catalog/` a dev built with `scripts/build-app-catalog.ts`. */
export function getCatalogDir(): string {
  if (process.env.LIAISON_APP_CATALOG_DIR) return process.env.LIAISON_APP_CATALOG_DIR
  if (existsSync("/app/app-catalog")) return "/app/app-catalog"
  return join(dirname(fileURLToPath(import.meta.url)), "../../../../../app-catalog")
}

// Memoize the parsed index per directory -- the catalog is static (baked at
// build time), but tests swap `LIAISON_APP_CATALOG_DIR` between cases, so key
// the cache on the resolved dir rather than caching unconditionally.
let cache: { dir: string; entries: CatalogEntry[] } | null = null

/** Read the catalog index. Returns [] when no catalog is baked in (the install
 *  path then 404s, never throws on a catalog-less image). */
export function listCatalog(): CatalogEntry[] {
  const dir = getCatalogDir()
  if (cache && cache.dir === dir) return cache.entries
  const indexPath = join(dir, "catalog.json")
  if (!existsSync(indexPath)) {
    cache = { dir, entries: [] }
    return []
  }
  const entries = JSON.parse(readFileSync(indexPath, "utf8")) as CatalogEntry[]
  cache = { dir, entries }
  return entries
}

// sha256 of each baked tarball, keyed by its path (the catalog is static per image).
const artifactSha256 = new Map<string, string>()

/**
 * True when an installed artifact is exactly the tarball this image's catalog bakes for
 * (name, version): the same sha256 match reconcileCatalogApps checks. This is the
 * platform's first-party voucher for a sandboxed app, never anything its manifest says.
 */
export function isCatalogArtifact(name: string, version: string, sha256: string): boolean {
  const entry = listCatalog().find((e) => e.name === name && e.version === version)
  if (!entry) return false
  const tarballPath = join(getCatalogDir(), entry.file)
  let baked = artifactSha256.get(tarballPath)
  if (baked === undefined) {
    if (!existsSync(tarballPath)) return false
    baked = createHash("sha256").update(readFileSync(tarballPath)).digest("hex")
    artifactSha256.set(tarballPath, baked)
  }
  return baked === sha256
}

const tarballFileSha256 = new Map<string, Map<string, string>>()

function bakedFileHashes(tarballPath: string): Map<string, string> | null {
  const hit = tarballFileSha256.get(tarballPath)
  if (hit) return hit
  if (!existsSync(tarballPath)) return null
  const stage = mkdtempSync(join(tmpdir(), "liaison-catalog-verify-"))
  try {
    const untar = spawnSync("tar", [
      "-xzf",
      tarballPath,
      "-C",
      stage,
      "--no-same-owner",
      "--no-same-permissions",
    ])
    if (untar.status !== 0) return null
    const hashes = hashTree(stage)
    if (!hashes || hashes.size === 0) return null
    tarballFileSha256.set(tarballPath, hashes)
    return hashes
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/**
 * True when `versionDir`, the install dir the runtime loads an app from, holds exactly the
 * files of this image's catalog tarball for (name, version), each byte-identical: the
 * manifest, bundle.js (handlers and sandboxed summarizers), ui.js, PDF template bundles and
 * anything else packaged. The recorded artifact sha256 only says what was installed last: an
 * install that fails after copying its files leaves other bytes on disk under that row. A
 * differing, missing or extra file, or a check that cannot be made, returns false.
 */
export function isCatalogInstall(name: string, version: string, versionDir: string): boolean {
  const entry = listCatalog().find((e) => e.name === name && e.version === version)
  if (!entry) return false
  const baked = bakedFileHashes(join(getCatalogDir(), entry.file))
  if (!baked) return false
  const onDisk = hashTree(versionDir)
  if (!onDisk || onDisk.size !== baked.size) return false
  for (const [relPath, sha256] of onDisk) {
    if (baked.get(relPath) !== sha256) return false
  }
  return true
}

/** The signed statement files of a catalog artifact, as published. */
export interface CatalogStatement {
  statement: Uint8Array
  signature: string
}

// Keyed by catalog dir + name@version: the baked catalog does not change under a process.
const statementMemo = new Map<string, CatalogStatement | null>()

/**
 * The signed statement and signature this image's catalog keeps for (name, version),
 * or null when that artifact was built locally (unsigned). The statement must name
 * this app and version and the package hash of the baked tarball, so it can only be
 * served for the bytes it vouches for. The signature itself is checked by the
 * clients against their pinned keys, not here.
 */
export function catalogStatement(name: string, version: string): CatalogStatement | null {
  const dir = getCatalogDir()
  const key = `${dir}\0${name}@${version}`
  if (statementMemo.has(key)) return statementMemo.get(key) ?? null
  let found: CatalogStatement | null = null
  const entry = listCatalog().find((e) => e.name === name && e.version === version)
  if (entry?.signed) {
    try {
      const statement = new Uint8Array(readFileSync(join(dir, entry.signed.statement)))
      const signature = readFileSync(join(dir, entry.signed.signature), "utf8")
      const parsed = JSON.parse(new TextDecoder().decode(statement)) as {
        name?: unknown
        version?: unknown
        sha256?: { package?: unknown }
      }
      const pkg = parsed.sha256?.package
      if (
        parsed.name === name &&
        parsed.version === version &&
        typeof pkg === "string" &&
        isCatalogArtifact(name, version, pkg)
      ) {
        found = { statement, signature }
      } else {
        log.warn({ name, version }, "catalog statement does not describe the baked artifact")
      }
    } catch (err) {
      log.warn({ name, version, err }, "catalog statement unreadable")
    }
  }
  statementMemo.set(key, found)
  return found
}

/** Drop the in-memory index cache (tests rebuild the catalog between cases). */
export function resetCatalogCache(): void {
  cache = null
  artifactSha256.clear()
  tarballFileSha256.clear()
  statementMemo.clear()
  versionAheadLogged.clear()
  // The apps an org registers are cached per catalog generation (init.ts
  // `getDefaultApps`) and resolved against this index (`versionForThisRelease`).
  // A new index is a new release's process: without a bump the next org would
  // register what the old index picked.
  bumpCatalogGeneration()
}

/** The active on-instance version of every installed app, by name. */
export async function installedAppVersions(): Promise<Map<string, string>> {
  const activeRows = await withSystemDb("catalog-active", (db) =>
    db
      .select({ name: appsActiveVersion.name, version: appsActiveVersion.version })
      .from(appsActiveVersion),
  )
  return new Map(activeRows.map((r) => [r.name, r.version]))
}

/** The catalog with each app's installed-state, for the Apps UI / CLI report.
 *  Joins `apps_active_version` so a freshly-installed app reads `installed: true`. */
export async function listCatalogWithState(): Promise<CatalogEntryWithState[]> {
  const entries = listCatalog()
  if (entries.length === 0) return []
  const installedVersionByName = await installedAppVersions()
  return entries.map((e) => ({
    name: e.name,
    ...(e.displayName ? { displayName: e.displayName } : {}),
    ...(e.description ? { description: e.description } : {}),
    version: e.version,
    ...(e.kind ? { kind: e.kind } : {}),
    ...(e.license ? { license: e.license } : {}),
    ...(e.author ? { author: e.author } : {}),
    ...(e.listing ? { listing: e.listing } : {}),
    installed: installedVersionByName.has(e.name),
    ...(installedVersionByName.has(e.name)
      ? { installedVersion: installedVersionByName.get(e.name) }
      : {}),
  }))
}

/**
 * What setting a catalog app up for an org does with the install (a demo seed,
 * `config apply`): `install` it (not on the instance yet), `upgrade` it (this
 * image's catalog is newer by semver precedence), nothing when it is `current`
 * (same precedence: equal, or only build metadata differs), and nothing either
 * when it is `ahead`: the active version is newer than this image's catalog
 * (a newer release set it, and this process is an old one in a rolling deploy
 * or after a rollback). Installing the older package then is refused (a
 * process never lowers the active version), so it is not tried: the org
 * registers the version this process runs (`versionForThisRelease`), which
 * `noteVersionAhead` logs.
 */
export type CatalogInstallAction = "install" | "upgrade" | "current" | "ahead"

export function catalogInstallAction(
  state: Pick<CatalogEntryWithState, "installed" | "installedVersion" | "version">,
): CatalogInstallAction {
  if (!state.installed || !state.installedVersion) return "install"
  const order = compareVersions(state.version, state.installedVersion)
  if (order > 0) return "upgrade"
  // Same precedence (equal, or only build metadata differs): nothing to do;
  // installing it would be refused as "not newer".
  if (order === 0) return "current"
  return "ahead"
}

/** The baked package of a catalog app: its tarball and the grants a first-party install
 *  gives it (the app's own declared scopes and connections, in full). `version`, when
 *  given, must match the baked one. Throws HTTP 404 when the catalog does not bake it. */
export function bakedCatalogPackage(
  name: string,
  version?: string,
): {
  entry: CatalogEntry
  tarballPath: string
  grantedScopes: string[]
  grantedConnections: string[]
} {
  const entry = listCatalog().find(
    (e) => e.name === name && (version === undefined || e.version === version),
  )
  if (!entry) {
    throw new HTTPException(404, {
      message: `No catalog app named '${name}'${version ? ` at version ${version}` : ""}. Available: ${listCatalog()
        .map((e) => e.name)
        .join(", ")}`,
    })
  }
  return {
    entry,
    tarballPath: join(getCatalogDir(), entry.file),
    grantedScopes: entry.scopes,
    grantedConnections: entry.connections,
  }
}

/** Install a first-party catalog app from its baked-in tarball, then hot-register
 *  it for the org so it surfaces WITHOUT a process restart. Idempotent at the
 *  install-service layer (a re-install of the same version overwrites in place).
 *  Throws HTTP 404 when `name` is not in the catalog. */
/**
 * The `roles` a baked catalog app's manifest declares, read from its tarball
 * without installing it (as the install itself reads `app.manifest.json`), so a
 * caller can know the role names the install will seed. `undefined` when the
 * catalog does not bake the app; throws when its package cannot be read.
 */
export function catalogManifestRoles(name: string): unknown {
  const entry = listCatalog().find((e) => e.name === name)
  if (!entry) return undefined
  const tarballPath = join(getCatalogDir(), entry.file)
  const stage = mkdtempSync(join(tmpdir(), "liaison-catalog-roles-"))
  try {
    const untar = spawnSync("tar", [
      "-xzf",
      tarballPath,
      "-C",
      stage,
      "--no-same-owner",
      "--no-same-permissions",
    ])
    if (untar.status !== 0) {
      throw new Error(
        `catalog app '${name}': cannot read ${entry.file} (${untar.stderr?.toString().trim() || "untar failed"})`,
      )
    }
    const manifest: unknown = JSON.parse(readFileSync(join(stage, "app.manifest.json"), "utf8"))
    return manifest && typeof manifest === "object"
      ? (manifest as { roles?: unknown }).roles
      : undefined
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export async function installCatalogApp(opts: {
  orgId: string
  name: string
  installedBy: string
  /** False when the caller installs several apps in one go and registers once
   *  after the last (see reconcileCatalogApps): a registration validates every
   *  installed app, so one run mid-batch would judge the versions the batch is
   *  about to replace. */
  register?: boolean
  /** Who the activation is recorded for; default: an operator, `installedBy`. */
  actor?: ActivationActor
  /** The boot's catalog repair: storing the package is best effort (install-service). */
  repair?: boolean
}): Promise<InstallResult> {
  const { entry, tarballPath, grantedScopes, grantedConnections } = bakedCatalogPackage(opts.name)
  const result = await installAppFromTarball({
    tarballPath,
    installedBy: opts.installedBy,
    // First-party: grant the app's own declared scopes/connections in full.
    grantedScopes,
    grantedConnections,
    // First-party, in-image: trust boundary is the image itself (see file header).
    requireSignature: false,
    sourceUrl: catalogSourceUrl(entry.name, entry.version),
    ...(opts.actor ? { actor: opts.actor } : {}),
    ...(opts.repair ? { storeBestEffort: true } : {}),
  })
  // The install switched every org already initialized in this process; the
  // operator's org may not be one yet, so register it there too.
  if (opts.register !== false) await reloadInstalledApps(opts.orgId)
  log.info({ app: entry.name, version: entry.version, orgId: opts.orgId }, "Installed catalog app")
  return result
}

export interface ReconcileCatalogAppsResult {
  /** Catalog apps whose on-disk bundle / DB row were repaired this run. */
  repaired: string[]
  /** Catalog apps already consistent (active version present, sha256 matches). */
  ok: string[]
  /** Catalog apps whose repair threw. Each is logged; the others still ran. */
  failed: Array<{ name: string; version: string; error: string }>
  /** Catalog apps whose active version is NEWER than this image's catalog (an old
   *  process during a rolling deploy): left alone, never moved back down. */
  ahead: Array<{ name: string; active: string; catalog: string }>
}

const versionAheadLogged = new Set<string>()

/**
 * Log once per process and app that the active version is ahead of this image's
 * catalog: a newer release set it, and this process keeps the version its own
 * catalog carries (activeInstalledApps) without writing the row.
 */
export function noteVersionAhead(name: string, active: string, catalog: string): void {
  const key = `${name}\0${active}\0${catalog}`
  if (versionAheadLogged.has(key)) return
  versionAheadLogged.add(key)
  log.warn({ app: name, active, catalog }, "app_version_ahead")
}

/** The `apps_installed.source_url` of a version a catalog install put there. */
export function catalogSourceUrl(name: string, version: string): string {
  return `catalog:${name}@${version}`
}

/**
 * The version this process registers for an app whose active version is
 * `active`, installed from `activeSourceUrl`: the active one, unless a
 * release's catalog installed it (a `catalog:` source) and this image's
 * catalog carries the app at an OLDER version whose files are in the install
 * root. That is an old process during a rolling deploy (the new release moved
 * the row up); it keeps running the code its own release shipped with, on a
 * schema the newer version only extended (the additive data rule). A version
 * an operator uploaded is the one every process runs, whatever its catalog.
 */
export function versionForThisRelease(
  name: string,
  active: string,
  activeSourceUrl: string | null,
): string {
  if (!activeSourceUrl?.startsWith("catalog:")) return active
  const entry = listCatalog().find((e) => e.name === name)
  if (!entry || !isNewerVersion(active, entry.version)) return active
  if (!existsSync(join(getInstallRoot(), name, entry.version, "app.manifest.json"))) return active
  noteVersionAhead(name, active, entry.version)
  return entry.version
}

/**
 * Idempotent, instance-wide reconcile: for every first-party catalog app that
 * is ENABLED for at least one org, ensure its `apps_installed` row + on-disk
 * `<installRoot>/<name>/<version>/` bundle both exist AND match the sha256 of
 * the image's freshly-baked `.liaisonapp` artifact.
 *
 * This exists because `apps_installed` / `apps_active_version` are DB rows —
 * durable across a container rebuild — while the unpacked bundle under the
 * install root is written to the container filesystem, which a rebuilt image
 * (or an ephemeral/non-persisted install-root volume) does NOT carry forward.
 * A rebuild can therefore leave the DB believing an app is installed at
 * version X while nothing is actually unpacked on disk (or the on-disk copy
 * is a stale artifact whose sha256 no longer matches the catalog) — the
 * runtime then silently fails to register it. Re-running `installCatalogApp`
 * for the CURRENT catalog version repairs both the disk and the DB row
 * (`installAppFromTarball` is a plain overwrite for the same (name, version)).
 *
 * Safe to run on every boot: an already-consistent app costs one sha256 read
 * and is a no-op. Call from the boot CMD (after migrate, before the server
 * starts serving) or from an operator-triggered reconcile endpoint/CLI command.
 *
 * Attribution (`installed_by`): reuses the DROPPED row's `installedBy` when a
 * stale `apps_installed` row exists for this app (the common case — repairing
 * a rebuild-induced drift preserves who originally installed it). Only when
 * there is NO prior row at all (an enabled-but-never-installed app, e.g. a
 * freshly-restored DB with a dangling `enabledApps` flag) does it fall back to
 * `opts.fallbackInstalledBy` — a system/operator identity supplied by the
 * caller (boot script or CLI), since there is nothing to inherit from.
 */
export async function reconcileCatalogApps(opts: {
  fallbackInstalledBy: string
}): Promise<ReconcileCatalogAppsResult> {
  // Each repaired app's install rebuilds the kernel.files SELECT policy (an
  // ACCESS EXCLUSIVE lock on kernel.files). Collapse them: one rebuild, after
  // the last install, and none when the policy comes out unchanged.
  const { batchFilesSelectPolicyRebuild } = await import("~/infra/boot-phase10")
  return batchFilesSelectPolicyRebuild(() => reconcileCatalogAppsUnbatched(opts))
}

async function reconcileCatalogAppsUnbatched(opts: {
  fallbackInstalledBy: string
}): Promise<ReconcileCatalogAppsResult> {
  const entries = listCatalog()
  if (entries.length === 0) return { repaired: [], ok: [], failed: [], ahead: [] }
  const catalogDir = getCatalogDir()

  const orgs = await withSystemDb("reconcile-catalog-orgs", (db) =>
    db.select({ id: organizations.id, settings: organizations.settings }).from(organizations),
  )
  // The reconcile set is every catalog app this INSTANCE has committed to: the
  // union of org surface curation (`settings.enabledApps`) and the actual
  // install record (`apps_active_version`). Keying on `enabledApps` alone was a
  // silent app-eviction bug: `enabledApps` is surface curation only (see
  // enabled-apps.ts), so an app can be installed, registered and serving an org
  // without appearing there. Such an app was then never repaired after a
  // container rebuild (its bundle lives on the container fs, its rows in the DB)
  // and never upgraded when a deploy baked a newer catalog version -- it simply
  // vanished from the product, or froze at the version it happened to be on.
  const reconcileTargets = new Set<string>()
  for (const org of orgs) {
    const raw = (org.settings as Record<string, unknown> | null)?.enabledApps
    if (!Array.isArray(raw)) continue
    for (const name of raw) {
      if (entries.some((e) => e.name === name)) reconcileTargets.add(name as string)
    }
  }
  // The org that installed the app is who we attribute the repair to; any org
  // with the app enabled works equally (installCatalogApp hot-registers for
  // that org, but the DB row + on-disk bundle it repairs are instance-wide, so
  // every org's registration self-heals via the normal per-org boot init).
  const orgForApp = new Map<string, string>()
  for (const org of orgs) {
    const raw = (org.settings as Record<string, unknown> | null)?.enabledApps
    if (!Array.isArray(raw)) continue
    for (const name of raw as string[]) {
      if (!orgForApp.has(name)) orgForApp.set(name, org.id)
    }
  }

  const activeRows = await withSystemDb("reconcile-catalog-active", (db) =>
    db.select().from(appsActiveVersion),
  )
  const activeByName = new Map(activeRows.map((r) => [r.name, r.version]))
  // An install record is a commitment on its own, with or without an enabledApps entry.
  for (const row of activeRows) {
    if (entries.some((e) => e.name === row.name)) reconcileTargets.add(row.name)
  }
  const installedRows = await withSystemDb("reconcile-catalog-installed", (db) =>
    db.select().from(appsInstalled),
  )

  const repaired: string[] = []
  const ok: string[] = []
  const failed: ReconcileCatalogAppsResult["failed"] = []
  const ahead: ReconcileCatalogAppsResult["ahead"] = []
  // Every install lands first, the registration runs once after the last. A
  // registration validates EVERY installed app against this image's contract,
  // so registering after each install judged the apps not yet upgraded by their
  // stored, pre-deploy versions: a contract change (a declaration that became
  // required) then logged each of them as an invalid descriptor, once per
  // earlier upgrade, although the version that would run met it. Registering
  // after the batch validates only what will run; an app whose upgrade failed
  // keeps its old version and is still refused, loudly, by that registration.
  const orgsToRegister = new Map<string, string[]>()

  for (const entry of entries) {
    if (!reconcileTargets.has(entry.name)) continue

    const activeVersion = activeByName.get(entry.name)
    // A process never lowers apps_active_version: a newer active version was
    // set by a newer release, and this one (an old process restarting during a
    // rolling deploy) leaves it and its files alone.
    if (activeVersion && isNewerVersion(activeVersion, entry.version)) {
      ahead.push({ name: entry.name, active: activeVersion, catalog: entry.version })
      noteVersionAhead(entry.name, activeVersion, entry.version)
      continue
    }
    const tarballPath = join(catalogDir, entry.file)
    if (!existsSync(tarballPath)) {
      log.warn({ app: entry.name }, "Catalog reconcile: baked tarball missing — skipping")
      continue
    }
    const catalogSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex")

    const dbRow = activeVersion
      ? installedRows.find((r) => r.name === entry.name && r.version === activeVersion)
      : undefined
    const versionDir = activeVersion ? join(getInstallRoot(), entry.name, activeVersion) : ""
    const onDiskPresent = !!activeVersion && existsSync(join(versionDir, "app.manifest.json"))
    const shaMatches = !!dbRow && dbRow.sha256 === catalogSha256 && activeVersion === entry.version

    if (activeVersion === entry.version && onDiskPresent && shaMatches) {
      ok.push(entry.name)
      continue
    }

    // `installCatalogApp` hot-registers for ONE org; the DB row + on-disk bundle
    // it repairs are instance-wide and every other org self-heals via its normal
    // per-org boot init. An app that no org lists in `enabledApps` therefore
    // falls back to any org rather than being skipped.
    const orgId = orgForApp.get(entry.name) ?? orgs[0]?.id
    if (!orgId) continue // no org at all on this instance — nothing to reconcile for
    // Inherit attribution from any prior row for this app (most recent install,
    // whatever version) when one exists; only a never-installed app falls back
    // to the caller-supplied identity.
    const priorRow = installedRows
      .filter((r) => r.name === entry.name)
      .sort((a, b) => b.installedAt.getTime() - a.installedAt.getTime())[0]
    const installedBy = priorRow?.installedBy ?? opts.fallbackInstalledBy
    log.warn(
      {
        app: entry.name,
        activeVersion,
        catalogVersion: entry.version,
        onDiskPresent,
        shaMatches,
      },
      "Catalog reconcile: repairing drifted/missing app install",
    )
    // Each app upgrades on its own: one app that throws must not leave every
    // app after it on its old stored manifest, which the contract may refuse.
    try {
      await installCatalogApp({
        orgId,
        name: entry.name,
        installedBy,
        register: false,
        actor: { id: null, kind: "system" },
        repair: true,
      })
      repaired.push(entry.name)
    } catch (err) {
      log.error(
        { err, app: entry.name, version: entry.version, activeVersion },
        "Catalog reconcile: repairing app failed, continuing with the next app",
      )
      failed.push({
        name: entry.name,
        version: entry.version,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    orgsToRegister.set(orgId, [...(orgsToRegister.get(orgId) ?? []), entry.name])
  }

  // The registration also rebuilds the kernel.files SELECT policy from what
  // registered, so it covers a failed install that wrote its bundle before
  // throwing too: the policy carries the file parents of every app that ends
  // this run installed.
  for (const [orgId, apps] of orgsToRegister) {
    try {
      await reloadInstalledApps(orgId)
    } catch (err) {
      log.error({ err, orgId, apps }, "Catalog reconcile: registering the reconciled apps failed")
    }
  }

  return { repaired, ok, failed, ahead }
}
