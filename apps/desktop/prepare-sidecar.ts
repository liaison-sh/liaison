#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Tauri resolves an `externalBin` entry to `<entry>-<rust target triple>` and
// REFUSES TO BUILD (even `cargo check`) when that file is absent, so the
// compiled sidecar has to be in place before any Rust build of the shell.
// This script is that step: compile for the host triple, then drop the binary
// where the bundler looks for it. The destination is generated, never
// committed.
//
// UNIVERSAL MACOS. `tauri build --target universal-apple-darwin` runs cargo
// once per architecture (each build script checks the thin
// `-aarch64-apple-darwin` and `-x86_64-apple-darwin` names) and then bundles
// `-universal-apple-darwin`. So `--target universal-apple-darwin` compiles
// both darwin sidecars, installs each under its thin name, and `lipo`s them
// into the fat one. Both slices must embed their own Claude Code CLI: an Intel
// Mac running a slice without one cannot run a single turn, and the per host
// check in sidecar/build.ts only guards the host's own slice.
//
// Usage: bun prepare-sidecar.ts [--force] [--target universal-apple-darwin]
//
// --force recompiles whatever the stamps say (the release does, every time).

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import {
  buildOne,
  DIST,
  outfileFor,
  platformCliPackage,
  platformCliSpecifier,
  type Target,
} from "./sidecar/build"

const BINARIES = path.join(import.meta.dir, "src-tauri", "binaries")
const EXTERNAL_BIN_BASE = "liaison-sidecar"

export const UNIVERSAL_MACOS = "universal-apple-darwin"

/** Rust host triple to the Bun compile target that produces its binary. */
const BUN_TARGET_BY_RUST_TRIPLE: Record<string, Target> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
}

/** The thin triples a universal macOS build is made of. */
export const UNIVERSAL_SLICES = ["aarch64-apple-darwin", "x86_64-apple-darwin"] as const

export function hostRustTriple(): string {
  const result = Bun.spawnSync(["rustc", "-vV"], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) throw new Error("rustc is not available")
  const line = result.stdout
    .toString()
    .split("\n")
    .find((entry) => entry.startsWith("host: "))
  if (!line) throw new Error("rustc -vV reported no host triple")
  return line.slice("host: ".length).trim()
}

export function externalBinPathFor(rustTriple: string): string {
  const suffix = rustTriple.includes("windows") ? ".exe" : ""
  return path.join(BINARIES, `${EXTERNAL_BIN_BASE}-${rustTriple}${suffix}`)
}

/** Why a universal sidecar cannot ship, or null. Every slice needs its CLI,
 *  not only the host's: `bun install --cpu='*'` is what installs the other
 *  architecture's package on a build machine. */
export function universalUnshippableReason(
  resolve: (target: Target) => string | null = platformCliPackage,
): string | null {
  const missing = UNIVERSAL_SLICES.map(
    (triple) => BUN_TARGET_BY_RUST_TRIPLE[triple] as Target,
  ).filter((target) => resolve(target) === null)
  if (missing.length === 0) return null
  return (
    `no Claude Code CLI to embed for ${missing.join(", ")}: ` +
    `${missing.map(platformCliSpecifier).join(", ")} did not resolve. ` +
    "A universal build ships every slice, so run bun install --cpu='*' before building it"
  )
}

// FRESHNESS (2026-09-23). A binary already on disk used to be answered as is,
// with no question about what it was built from: a long lived checkout
// compiled the sidecar once and every later build shipped that one, so a build
// of main carrying the new `auto` permission mode bundled a sidecar that
// refused `--permission-mode auto` and died before its first line. Every
// binary this script produces or installs now carries a STAMP, the sha256 of
// what it was built from, and a binary whose stamp is not the current sources'
// hash is rebuilt. The stamp is of the SOURCES, never of the binary: a sidecar
// signed in place (the release signs it before the bundle) keeps its stamp and
// is not copied over.
//
// `src-tauri/build.rs` refuses to build the shell when a sidecar input is newer
// than the installed stamp, so a `tauri build` or `cargo` run that skipped this
// script fails and says to run it, rather than bundling whatever is there.

/** Bumped when what the hash covers changes, so every old stamp is stale. */
const STAMP_SCHEMA = 1

export const SIDECAR_DIR = path.join(import.meta.dir, "sidecar")
export const REPO_LOCKFILE = path.resolve(import.meta.dir, "..", "..", "bun.lock")

/** Build output and dependencies, which are not sources. build.rs skips the same. */
const SKIPPED_DIRS = new Set(["dist", ".entries", "node_modules"])

/**
 * The files a sidecar binary is built from: everything under the sidecar
 * directory except tests, build output and dependencies, and the lockfile that
 * pins the SDK and its CLI. Sorted, so the hash does not depend on the order a
 * directory listing happens to come back in. `src-tauri/sidecar_freshness.rs`
 * walks the same set for the build guard.
 */
export function sidecarInputs(root: string = SIDECAR_DIR, lockfile: string = REPO_LOCKFILE) {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(full)
      } else if (entry.isFile() && !entry.name.endsWith(".test.ts")) {
        files.push(full)
      }
    }
  }
  walk(root)
  if (existsSync(lockfile)) files.push(lockfile)
  return files.sort()
}

/** The version of an installed package as node resolution finds it from `from`. */
function installedVersion(name: string, from: string): string {
  let dir = from
  for (;;) {
    const manifest = path.join(dir, "node_modules", name, "package.json")
    if (existsSync(manifest)) {
      try {
        return String(JSON.parse(readFileSync(manifest, "utf8")).version ?? "unknown")
      } catch {
        return "unreadable"
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return "absent"
    dir = parent
  }
}

/**
 * What one target's binary is built from, as one hash: the sources, the SDK
 * and the platform CLI that are actually INSTALLED (a lockfile can say one
 * version while node_modules holds another), the Bun that compiles it and the
 * target itself.
 */
export function sidecarSourceHash(
  target: Target,
  options: { root?: string; lockfile?: string } = {},
): string {
  const root = options.root ?? SIDECAR_DIR
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(`schema ${STAMP_SCHEMA}\ntarget ${target}\nbun ${Bun.version}\n`)
  hash.update(`sdk ${installedVersion("@anthropic-ai/claude-agent-sdk", root)}\n`)
  const cli = platformCliSpecifier(target).split("/").slice(0, 2).join("/")
  hash.update(`cli ${cli} ${installedVersion(cli, root)}\n`)
  const base = path.dirname(root)
  for (const file of sidecarInputs(root, options.lockfile ?? REPO_LOCKFILE)) {
    hash.update(`file ${path.relative(base, file).split(path.sep).join("/")}\n`)
    hash.update(readFileSync(file))
    hash.update("\n")
  }
  return hash.digest("hex")
}

/**
 * Where a binary's stamp is kept: a `.stamps` directory beside it. Never
 * `<binary>.stamp`: the release signs `binaries/liaison-sidecar-*`, and a text
 * file matching that glob would be handed to codesign and signtool.
 */
export function stampPathFor(binary: string): string {
  return path.join(path.dirname(binary), ".stamps", `${path.basename(binary)}.sha256`)
}

function stampOf(binary: string): string | null {
  try {
    return readFileSync(stampPathFor(binary), "utf8").trim()
  } catch {
    return null
  }
}

/** A binary that is there AND was built from exactly these sources. */
export function isFresh(binary: string, hash: string): boolean {
  return existsSync(binary) && stampOf(binary) === hash
}

/** Rewritten even when unchanged: build.rs compares its age with the sources'. */
function writeStamp(binary: string, hash: string): void {
  mkdirSync(path.dirname(stampPathFor(binary)), { recursive: true })
  writeFileSync(stampPathFor(binary), `${hash}\n`)
}

export interface PrepareOptions {
  force?: boolean
  target?: string
  /** Where Tauri looks for the externalBin. Tests point it at a scratch dir. */
  binaries?: string
  /** Where the compile writes its output (`sidecar/dist`). */
  dist?: string
  /** The compile itself; `buildOne` unless a test stands in for it. */
  compile?: (target: Target) => string
  /** The sources' hash for a target; `sidecarSourceHash` unless a test stands in. */
  hashFor?: (target: Target) => string
}

interface Resolved {
  force: boolean
  binaries: string
  dist: string
  compile: (target: Target) => string
  hashFor: (target: Target) => string
}

function compiledFor(target: Target, hash: string, options: Resolved): string {
  const outfile = path.join(options.dist, path.basename(outfileFor(target)))
  if (!options.force && isFresh(outfile, hash)) return outfile
  const built = options.compile(target)
  writeStamp(built, hash)
  return built
}

function prepareThin(rustTriple: string, options: Resolved): string {
  const bunTarget = BUN_TARGET_BY_RUST_TRIPLE[rustTriple]
  if (!bunTarget) throw new Error(`no sidecar compile target for triple ${rustTriple}`)
  const destination = path.join(options.binaries, path.basename(externalBinPathFor(rustTriple)))
  const hash = options.hashFor(bunTarget)
  if (options.force || !isFresh(destination, hash)) {
    const compiled = compiledFor(bunTarget, hash, options)
    mkdirSync(options.binaries, { recursive: true })
    copyFileSync(compiled, destination)
  }
  writeStamp(destination, hash)
  return destination
}

function prepareUniversal(options: Resolved): string {
  const refusal = universalUnshippableReason()
  if (refusal) throw new Error(refusal)
  const destination = path.join(
    options.binaries,
    path.basename(externalBinPathFor(UNIVERSAL_MACOS)),
  )
  const slices = UNIVERSAL_SLICES.map((triple) => prepareThin(triple, options))
  // The fat file is as fresh as both of its slices together.
  const hash = new Bun.CryptoHasher("sha256")
    .update(slices.map((slice) => stampOf(slice) ?? "").join("\n"))
    .digest("hex")
  if (options.force || !isFresh(destination, hash)) {
    const lipo = Bun.spawnSync(["lipo", "-create", ...slices, "-output", destination], {
      stdout: "inherit",
      stderr: "inherit",
    })
    if (lipo.exitCode !== 0) throw new Error("lipo could not merge the sidecar slices")
  }
  writeStamp(destination, hash)
  return destination
}

/** Compile (unless the binary there was built from these exact sources) and
 *  install for the host triple, or for every slice of a universal macOS build. */
export function prepareSidecar(options: PrepareOptions = {}): string {
  const resolved: Resolved = {
    force: options.force ?? false,
    binaries: options.binaries ?? BINARIES,
    dist: options.dist ?? DIST,
    compile: options.compile ?? buildOne,
    hashFor: options.hashFor ?? ((target) => sidecarSourceHash(target)),
  }
  if (options.target === UNIVERSAL_MACOS) return prepareUniversal(resolved)
  return prepareThin(options.target ?? hostRustTriple(), resolved)
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const index = argv.indexOf("--target")
  console.log(
    prepareSidecar({
      force: argv.includes("--force"),
      target: index === -1 ? undefined : argv[index + 1],
    }),
  )
}
