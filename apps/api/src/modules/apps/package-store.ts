// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The installed app packages, stored once for the whole instance (S1.3).
 *
 * The unpacked bundle under the install root (`<installRoot>/<name>/<version>/`)
 * lives on one container's filesystem, while `apps_installed` and
 * `apps_active_version` are shared by every process. So every install and
 * upgrade also puts the verified `.liaisonapp` tarball in object storage, at
 * `instance/apps/<name>/<version>.liaisonapp` (the key derives from the name and
 * version, A9). Its sha256 is the one already recorded on the `apps_installed`
 * row, with the signature bundle the install verified.
 *
 * A process that lacks the files of an active version (a peer told about an
 * install, a fresh container at boot) materialises them: fetch the tarball,
 * check its sha256 against the row, run the same verification and unpack the
 * install uses (`verifyAppPackage`, `placeVersionDir`), and only then register.
 * A package whose bytes do not match the row is refused; the process keeps what
 * it ran before and retries on the next announcement or upkeep.
 *
 * Pruning a version deletes its stored package; uninstalling an app deletes the
 * app's whole folder.
 */
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { and, eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsInstalled } from "~/db/schema/kernel/apps-installed"
import {
  copyObject,
  deleteInstancePrefix,
  deleteObject,
  getObjectBuffer,
  headObject,
  putObject,
} from "~/infra/storage/object-storage"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { bumpCatalogGeneration } from "~/modules/apps/catalog-generation"
import { getInstallRoot } from "~/modules/apps/discover-apps"
import { MAX_PACKAGE_BYTES, verifyAppPackage } from "~/modules/apps/verify-package"
import { placeVersionDir } from "~/modules/apps/version-dir"

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

function assertSafe(name: string, version: string): void {
  for (const part of [name, version]) {
    if (!SAFE_SEGMENT.test(part) || part.includes("..")) {
      throw new Error(`Not a valid app name or version for the package store: '${part}'`)
    }
  }
}

/** Where an app version's package lives in object storage. */
export function packageKey(name: string, version: string): string {
  assertSafe(name, version)
  return `instance/apps/${name}/${version}.liaisonapp`
}

function appPrefix(name: string): string {
  assertSafe(name, "0")
  return `instance/apps/${name}/`
}

/** Test seam: makes every package upload fail (object storage down). */
export const packageStoreFaults = { failing: false }

async function upload(key: string, body: Buffer | Uint8Array): Promise<void> {
  if (packageStoreFaults.failing) throw new Error("object storage unavailable (test fault)")
  await putObject({ key, body, contentType: "application/gzip" })
}

/**
 * Upload a verified package to a staging key of its own, before anything is
 * placed or recorded: an install whose upload fails stops with no half state,
 * and the version's stored package is untouched until `commitPackage` (a
 * reinstall that fails later never leaves other bytes under the version's key).
 */
export async function stagePackage(
  name: string,
  version: string,
  tarballPath: string,
): Promise<string> {
  const key = `${appPrefix(name)}.staging-${version}-${randomUUID()}.liaisonapp`
  assertSafe(name, version)
  await upload(key, readFileSync(tarballPath))
  return key
}

/** Move a staged package to the version's key, once its install row is recorded. */
export async function commitPackage(
  name: string,
  version: string,
  stagedKey: string,
): Promise<void> {
  await copyObject({ sourceKey: stagedKey, destKey: packageKey(name, version) })
  await deleteObject(stagedKey).catch((err) =>
    log.warn({ err, app: name, version }, "Deleting a staged app package failed"),
  )
}

/** Drop a staged package whose install did not go through. Best effort. */
export async function discardStagedPackage(stagedKey: string): Promise<void> {
  await deleteObject(stagedKey).catch((err) =>
    log.warn({ err, key: stagedKey }, "Deleting a staged app package failed"),
  )
}

/**
 * Store a package around an install's place-and-record step: staged first (a
 * failure stops the install before `record` runs), moved to the version's key
 * once `record` succeeded, dropped when it threw. `bestEffort` (the boot's
 * catalog repair, which installs from the image's own tarball) logs a storage
 * failure and goes on: the upkeep back-fills it later.
 */
export async function withStoredPackage(
  pkg: { name: string; version: string; tarballPath: string; bestEffort?: boolean },
  record: () => Promise<void>,
): Promise<void> {
  const { name, version } = pkg
  let staged: string | null = null
  try {
    staged = await stagePackage(name, version, pkg.tarballPath)
  } catch (err) {
    if (!pkg.bestEffort) throw err
    log.warn(
      { err, app: name, version },
      "Storing the app package failed; the upkeep stores it later",
    )
  }
  try {
    await record()
  } catch (err) {
    if (staged) await discardStagedPackage(staged)
    throw err
  }
  if (!staged) return
  try {
    await commitPackage(name, version, staged)
  } catch (err) {
    if (!pkg.bestEffort) throw err
    log.warn(
      { err, app: name, version },
      "Storing the app package failed; the upkeep stores it later",
    )
  }
}

/** Delete the stored package of one version. Best effort: logged, never thrown. */
export async function deleteStoredPackage(name: string, version: string): Promise<void> {
  try {
    await deleteObject(packageKey(name, version))
  } catch (err) {
    log.warn({ err, app: name, version }, "Deleting a pruned app version's stored package failed")
  }
}

/** Delete every stored package of an app (an uninstall). Best effort: logged, never thrown. */
export async function deleteStoredPackages(name: string): Promise<void> {
  try {
    await deleteInstancePrefix(appPrefix(name))
  } catch (err) {
    log.warn({ err, app: name }, "Deleting an uninstalled app's stored packages failed")
  }
}

function onDisk(name: string, version: string): boolean {
  const dir = join(getInstallRoot(), name, version)
  return existsSync(join(dir, "app.manifest.json")) && existsSync(join(dir, "bundle.js"))
}

const inFlight = new Map<string, Promise<"present" | "materialised">>()

/**
 * Make sure `<installRoot>/<name>/<version>/` holds the version's files: when
 * missing, fetch the stored package, check it against the install row, verify
 * and unpack it. Resolves `present` (nothing to do) or `materialised`; throws
 * when the version cannot be put in place (no row, no stored package, other
 * bytes than the row's sha256, a package that fails verification).
 */
export async function ensureBundleMaterialised(
  name: string,
  version: string,
): Promise<"present" | "materialised"> {
  assertSafe(name, version)
  if (onDisk(name, version)) return "present"
  const key = `${getInstallRoot()}\0${name}\0${version}`
  const running = inFlight.get(key)
  if (running) return running
  const run = materialise(name, version).finally(() => inFlight.delete(key))
  inFlight.set(key, run)
  return run
}

async function materialise(name: string, version: string): Promise<"present" | "materialised"> {
  const [row] = await withSystemDb("app-package-materialise", (db) =>
    db
      .select({ sha256: appsInstalled.sha256, signatureBundle: appsInstalled.signatureBundle })
      .from(appsInstalled)
      .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, version)))
      .limit(1),
  )
  if (!row) throw new Error(`${name} ${version} is not installed on this instance`)
  let bytes: Buffer
  try {
    bytes = await getObjectBuffer(packageKey(name, version), undefined, {
      maxBytes: MAX_PACKAGE_BYTES,
    })
  } catch (err) {
    // Not stored (installed before the store existed): this image may bake it.
    const baked = isNotFound(err) ? await bakedPackage(name, version, row.sha256) : null
    if (!baked) throw err
    bytes = baked
    await backfill(name, version, baked)
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (sha256 !== row.sha256) {
    throw new Error(
      `${name} ${version}: the stored package's sha256 ${sha256} is not the installed ${row.sha256}; refused`,
    )
  }
  const work = mkdtempSync(join(tmpdir(), "liaison-app-store-"))
  try {
    const tarballPath = join(work, "package.liaisonapp")
    writeFileSync(tarballPath, bytes)
    // The bytes are the ones the install verified (same sha256). Their signature
    // is checked again when the instance names a trusted publisher; without one
    // the install could not have verified it either.
    let signatureBundlePath: string | undefined
    const identity = env.LIAISON_TRUSTED_APP_PUBLISHERS || undefined
    if (row.signatureBundle && identity) {
      signatureBundlePath = join(work, "package.liaisonapp.cosign.bundle")
      writeFileSync(signatureBundlePath, row.signatureBundle)
    }
    const verified = await verifyAppPackage(tarballPath, {
      signatureBundlePath,
      cosignIdentityRegex: identity,
    })
    try {
      if (verified.manifest.name !== name || verified.manifest.version !== version) {
        throw new Error(
          `${name} ${version}: the stored package is ${verified.manifest.name} ${verified.manifest.version}; refused`,
        )
      }
      const placed = placeVersionDir(getInstallRoot(), name, version, verified.stagingDir)
      // Discovery reads the install root again.
      bumpCatalogGeneration()
      log.info({ app: name, version, placed }, "App version materialised from the package store")
      return "materialised"
    } finally {
      rmSync(verified.stagingDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | null
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404
}

/** The image's baked catalog tarball of (name, version), when its sha256 is the installed one. */
async function bakedPackage(name: string, version: string, sha256: string): Promise<Buffer | null> {
  const { isCatalogArtifact, getCatalogDir, listCatalog } = await import("~/modules/apps/catalog")
  if (!isCatalogArtifact(name, version, sha256)) return null
  const entry = listCatalog().find((e) => e.name === name && e.version === version)
  return entry ? readFileSync(join(getCatalogDir(), entry.file)) : null
}

/** Upload a package that was not stored. Best effort: logged, never thrown. */
async function backfill(name: string, version: string, bytes: Buffer): Promise<boolean> {
  try {
    await upload(packageKey(name, version), bytes)
    log.info({ app: name, version }, "App package back-filled into the package store")
    return true
  } catch (err) {
    log.warn({ err, app: name, version }, "Back-filling an app package into the store failed")
    return false
  }
}

async function isStored(name: string, version: string): Promise<boolean> {
  try {
    await headObject(packageKey(name, version))
    return true
  } catch (err) {
    if (isNotFound(err)) return false
    throw err
  }
}

const unstoredWarned = new Set<string>()

/**
 * Materialise every active version this process runs (`versionForThisRelease`)
 * whose files are missing from the install root: the boot step of a fresh
 * container, and the upkeep. Never throws for one app; each failure is listed
 * and logged.
 */
export async function materialiseActiveVersions(): Promise<{
  materialised: string[]
  failed: Array<{ app: string; error: string }>
  /** Uploaded versions with no stored package: other processes cannot fetch them. */
  unstored: string[]
}> {
  const { activeVersionRows } = await import("~/modules/apps/activation")
  const { versionForThisRelease } = await import("~/modules/apps/catalog")
  const rows = await withSystemDb("app-package-materialise-all", (db) => activeVersionRows(db))
  const materialised: string[] = []
  const failed: Array<{ app: string; error: string }> = []
  const unstored: string[] = []
  for (const r of rows) {
    const version = versionForThisRelease(r.name, r.version, r.sourceUrl)
    try {
      if ((await ensureBundleMaterialised(r.name, version)) === "materialised") {
        materialised.push(`${r.name}@${version}`)
      }
      if (!(await isStored(r.name, version))) {
        // Installed before the store existed: this image's catalog may bake it.
        const [row] = await withSystemDb("app-package-backfill", (db) =>
          db
            .select({ sha256: appsInstalled.sha256 })
            .from(appsInstalled)
            .where(and(eq(appsInstalled.name, r.name), eq(appsInstalled.version, version)))
            .limit(1),
        )
        const baked = row ? await bakedPackage(r.name, version, row.sha256) : null
        if (!baked || !(await backfill(r.name, version, baked))) {
          const id = `${r.name}@${version}`
          unstored.push(id)
          if (!unstoredWarned.has(id)) {
            unstoredWarned.add(id)
            log.warn(
              { app: r.name, version },
              "App version has no stored package: reinstall it to make it available to every process",
            )
          }
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.error({ err, app: r.name, version }, "Materialising an active app version failed")
      failed.push({ app: `${r.name}@${version}`, error })
    }
  }
  return { materialised, failed, unstored }
}
