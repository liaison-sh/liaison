// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Installed app version directories (`<installRoot>/<name>/<version>/`).
 *
 * Every process of a deployment shares one install root (the compose file
 * bind-mounts it), and during a rolling deploy two generations of processes
 * run side by side, each loading app files from it. So a version directory is
 * written once and never rewritten:
 *
 * - it is unpacked into `<installRoot>/<name>/.tmp-<uuid>/` and renamed into
 *   place, so no process ever reads a half-written version;
 * - an existing directory with the same files is left alone (a re-install, or
 *   two processes unpacking the same version at once);
 * - an existing directory that holds only some of the package's files (a copy
 *   cut short before unpacks were atomic) is completed by the same rename;
 * - an existing directory with different files is refused loudly: a process
 *   may be running those files, and a change ships under a new version.
 */
import { createHash, randomUUID } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs"
import { join } from "node:path"

/** Entries an unpack or a replacement leaves while it runs; never a version. */
export const TRANSIENT_DIR_PREFIXES = [".tmp-", ".trash-"] as const

export function isTransientDir(entry: string): boolean {
  return TRANSIENT_DIR_PREFIXES.some((p) => entry.startsWith(p))
}

/** A transient dir older than this was left by a process that died mid-unpack. */
export const TRANSIENT_DIR_MAX_AGE_MS = 60 * 60 * 1000

/**
 * sha256 of every regular file under `root`, keyed by its path relative to `root`. Null when
 * the tree holds a symlink or anything else that is neither a file nor a directory, or when
 * any entry cannot be read: the caller then treats the tree as unverifiable.
 */
export function hashTree(root: string): Map<string, string> | null {
  const out = new Map<string, string>()
  const walk = (dir: string, rel: string): boolean => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name)
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (!walk(path, relPath)) return false
      } else if (e.isFile()) {
        out.set(relPath, createHash("sha256").update(readFileSync(path)).digest("hex"))
      } else {
        return false
      }
    }
    return true
  }
  try {
    return walk(root, "") ? out : null
  } catch {
    return null
  }
}

type Comparison = "same" | "subset" | "different"

/** How the files under `existing` compare to the package's files. */
function compareTrees(pkg: Map<string, string>, existingDir: string): Comparison {
  const existing = hashTree(existingDir)
  if (!existing) return "different"
  for (const [relPath, sha] of existing) {
    if (pkg.get(relPath) !== sha) return "different"
  }
  return existing.size === pkg.size ? "same" : "subset"
}

/**
 * Put the unpacked package at `stagingDir` in place as `<installRoot>/<name>/<version>/`, by the
 * rules in this file's header. Returns `"placed"` when it wrote the directory, `"kept"` when
 * the same files were already there. Throws when the directory holds other files.
 */
export function placeVersionDir(
  installRoot: string,
  name: string,
  version: string,
  stagingDir: string,
): "placed" | "kept" {
  const appRoot = join(installRoot, name)
  const versionDir = join(appRoot, version)
  const pkg = hashTree(stagingDir)
  if (!pkg)
    throw new Error(`Cannot install '${name}' ${version}: the package's files cannot be read`)
  const refuse = (): never => {
    throw new Error(
      `Cannot install '${name}' ${version}: ${versionDir} already holds different files for this version. A version directory is never rewritten in place, because a running process may be loading it: publish the change under a new version.`,
    )
  }

  let replacing = false
  if (existsSync(versionDir)) {
    const cmp = compareTrees(pkg, versionDir)
    if (cmp === "same") return "kept"
    if (cmp === "different") refuse()
    replacing = true
  }

  mkdirSync(appRoot, { recursive: true })
  const tmp = join(appRoot, `.tmp-${randomUUID()}`)
  try {
    cpSync(stagingDir, tmp, { recursive: true })
    if (replacing) {
      // Move the incomplete copy aside first: a rename never lands on a
      // non-empty directory.
      const trash = join(appRoot, `.trash-${randomUUID()}`)
      try {
        renameSync(versionDir, trash)
        rmSync(trash, { recursive: true, force: true })
      } catch {
        // Another process moved it first; the rename below settles who wins.
      }
    }
    try {
      renameSync(tmp, versionDir)
    } catch (err) {
      // A concurrent unpack of the same version renamed first: fine when it
      // placed the same files.
      if (existsSync(versionDir) && compareTrees(pkg, versionDir) === "same") return "kept"
      if (existsSync(versionDir)) refuse()
      throw err
    }
    return "placed"
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

/** Remove the transient dirs under `appRoot` that a dead process left (older than an hour). */
export function sweepTransientDirs(appRoot: string, now: number = Date.now()): void {
  if (!existsSync(appRoot)) return
  for (const entry of readdirSync(appRoot)) {
    if (!isTransientDir(entry)) continue
    const path = join(appRoot, entry)
    try {
      if (now - statSync(path).mtimeMs > TRANSIENT_DIR_MAX_AGE_MS) {
        rmSync(path, { recursive: true, force: true })
      }
    } catch {
      // Gone already.
    }
  }
}
