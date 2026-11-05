#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The WHOLE bundle's absolute path check, the last thing that runs before
// anything is signed. The sidecar's own check (sidecar/check-no-absolute-paths
// .ts) covers one compiled binary at build time; this one covers what is
// actually about to ship: the shell, the sidecar embedded beside it, the
// overlay compiled into the shell, and every resource the bundler copied in.
//
// It separates two things a single grep would confuse:
//
// The prefixes come from the environment and from the checkout resolved at
// runtime, never from a literal, and they are matched in both path shapes
// (POSIX and Windows, either slash kind, case insensitively for a Windows
// one): a default written into the source is right on the machine it was
// written on and silently refuses nothing anywhere else.
//
//   FATAL: a path that identifies the machine that built THIS artifact, that
//   is, the checkout, the home directory, the runner workspace or the cargo
//   home. Those are ours and we can fix them (Rust's trim-paths, a relative
//   asset reference). A customer's machine has no such directory, so anything
//   resolving through one is broken on arrival, and the username inside it is
//   a detail nobody meant to publish.
//
//   VENDORED, SUBTRACTED: the compiled sidecar embedded in the bundle is a
//   Bun runtime with the Claude Code CLI appended to it, and both of those
//   were compiled by somebody else on a CI runner, so both carry that
//   runner's home directory. On a GitHub runner that directory IS one of the
//   prefixes above, so the references those payloads brought in are measured
//   (the same payloads the compile step measures) and subtracted, and only
//   the excess is this build's. Everything else in the bundle, the Rust shell
//   first of all, keeps the strict rule: cargo builds it with
//   --remap-path-prefix, so a runner path there is ours by construction.
//
//   REPORTED: an absolute path baked into a third party binary we only vendor
//   (Apple's WebKit, the Claude Code CLI). This pipeline cannot rebuild those,
//   so failing on them would only teach whoever hits it to delete the check.
//   They are printed, with counts, so they stay visible.
//
// WHAT IT DOES NOT PROMISE. The FATAL half is exact on every platform: it is
// the set of prefixes this build actually has. The REPORTED half is POSIX
// shaped only, because "somebody else's home directory" has a recognisable
// shape on Unix and none on Windows that can be told from an ordinary string,
// so a Windows bundle's vendored paths are not enumerated here. Reporting is
// not the gate; a path from THIS machine is, and that half holds everywhere.
//
// Usage: bun check-bundle-no-absolute-paths.ts <bundle or file>
// Exit 0 clean, 1 a path from this build, 2 nothing to inspect.

import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import path from "node:path"
import { hostTarget, TARGETS, type Target, vendoredPayloads } from "../sidecar/build"
import {
  type BuildPrefix,
  buildRootPrefixes,
  canonicalPrefix,
  countPrefixes,
  firstMatchContext,
  forEachHaystack,
  type PrefixHit,
  scanFiles,
  subtractHits,
} from "../sidecar/check-no-absolute-paths"
import { reportDebugHooks, scanForDebugHooks } from "./check-bundle-no-debug-hooks"

export type { BuildPrefix }

/** Directories that belong to THIS build, from the environment and the
 *  checkout rather than a guess. The derivation is the sidecar checker's, so
 *  the two checks refuse exactly the same set. */
export function buildPrefixes(env: Record<string, string | undefined>): BuildPrefix[] {
  return buildRootPrefixes(env)
}

/** Absolute host paths that are not this build's: a vendored binary's own.
 *  POSIX shaped only, deliberately: a Windows path has no equivalent "somebody
 *  else's home directory" shape that can be told apart from an ordinary
 *  string, and a guess here would be reported noise rather than a finding. */
const FOREIGN = /(?:\/Users|\/home|\/Volumes)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]*/g

/** The compile targets of a sidecar binary, by the names one ships under:
 *  `liaison-sidecar` inside the bundle, `liaison-sidecar.exe` on Windows,
 *  `liaison-sidecar-<rust triple>` where Tauri resolves externalBin, and
 *  `liaison-sidecar-<bun triple>` in the sidecar's own dist. Null for every
 *  other file, which is what keeps the subtraction off the shell binary.
 *
 *  A universal macOS sidecar is two compiled sidecars in one file, so it
 *  carries both slices' vendored payloads: its targets are read from its fat
 *  header, whatever it is named, and both baselines are subtracted. */
export function sidecarTargets(file: string): Target[] | null {
  const base = path.basename(file).replace(/\.exe$/i, "")
  if (base !== SIDECAR_BASE && !base.startsWith(`${SIDECAR_BASE}-`)) return null
  const fat = fatSliceTargets(file)
  if (fat) return fat
  const suffix = base.slice(SIDECAR_BASE.length).replace(/^-/, "")
  if ((TARGETS as readonly string[]).includes(suffix)) return [suffix as Target]
  const rust = RUST_TRIPLE_TARGET[suffix]
  if (rust) return [rust]
  // No triple in the name: the bundler copied it in, so it was compiled for
  // the machine running this check, which is the machine that built it.
  return [hostTarget()]
}

const FAT_MAGIC = 0xcafebabe
const CPU_TYPE_TARGET: Record<number, Target> = {
  16777223: "bun-darwin-x64",
  16777228: "bun-darwin-arm64",
}

/** The darwin targets a fat Mach-O holds, or null for a thin file. */
export function fatSliceTargets(file: string): Target[] | null {
  const handle = openSync(file, "r")
  try {
    const header = Buffer.alloc(8 + 20 * 4)
    const read = readSync(handle, header, 0, header.length, 0)
    if (read < 8 || header.readUInt32BE(0) !== FAT_MAGIC) return null
    const count = header.readUInt32BE(4)
    if (count < 1 || count > 4 || read < 8 + 20 * count) return null
    const targets: Target[] = []
    for (let index = 0; index < count; index++) {
      const target = CPU_TYPE_TARGET[header.readUInt32BE(8 + 20 * index)]
      if (!target) throw new Error(`${file} holds a slice this check has no baseline for`)
      targets.push(target)
    }
    return targets
  } finally {
    closeSync(handle)
  }
}

const SIDECAR_BASE = "liaison-sidecar"

const RUST_TRIPLE_TARGET: Record<string, Target> = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
}

/** Payload measurements are per target and each one reads a 90 MB runtime, so
 *  a bundle carrying several sidecars measures each target set once. The
 *  baseline of a fat file is the sum of its slices' payloads. */
const BASELINE = new Map<string, { payloads: string[]; hits: PrefixHit[] }>()

function vendoredBaseline(
  targets: Target[],
  prefixes: BuildPrefix[],
): { payloads: string[]; hits: PrefixHit[] } {
  const key = targets.join(",")
  const cached = BASELINE.get(key)
  if (cached) return cached
  const payloads = targets.flatMap((target) => vendoredPayloads(target))
  const measured = { payloads, hits: scanFiles(payloads, prefixes) }
  BASELINE.set(key, measured)
  return measured
}

export type FileFinding = {
  file: string
  fatal: PrefixHit[]
  /** What the file carries before anything is subtracted. Equal to `fatal`
   *  for everything this build compiles itself. */
  raw: PrefixHit[]
  /** What the vendored payloads of an embedded sidecar brought with them. */
  vendored: PrefixHit[]
  /** The payload files those counts were measured from, named so a build that
   *  measured none is visible rather than looking clean. */
  payloads: string[]
  foreign: Map<string, number>
  bytes: number
}

export function scanBundleFile(file: string, prefixes: BuildPrefix[]): FileFinding {
  const buffer = readFileSync(file)
  const fatal = new Map<string, PrefixHit>()
  const foreign = new Map<string, number>()
  const canonical = prefixes.map((entry) => canonicalPrefix(entry.prefix))
  forEachHaystack(buffer, (encoding, haystack) => {
    countPrefixes(haystack, prefixes, encoding, fatal)
    for (const [match] of haystack.matchAll(FOREIGN)) {
      if (canonical.some((prefix) => match.startsWith(prefix))) continue
      // The owning directory is enough: one line per source, not per string.
      const owner = match.split("/").slice(0, 4).join("/")
      foreign.set(owner, (foreign.get(owner) ?? 0) + 1)
    }
  })
  const raw = [...fatal.values()]
  // Measuring the payloads costs a read of the Bun runtime, so it happens only
  // when there is something to explain.
  const targets = raw.length === 0 ? null : sidecarTargets(file)
  const measured =
    targets === null ? { payloads: [], hits: [] } : vendoredBaseline(targets, prefixes)
  return {
    file,
    fatal: targets === null ? raw : subtractHits(raw, measured.hits),
    raw,
    vendored: measured.hits,
    payloads: measured.payloads,
    foreign,
    bytes: buffer.length,
  }
}

export function bundleFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target]
  const found: string[] = []
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const absolute = path.join(target, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) found.push(...bundleFiles(absolute))
    else if (entry.isFile()) found.push(absolute)
  }
  return found.sort()
}

if (import.meta.main) {
  const target = process.argv[2]
  if (!target) {
    process.stderr.write("usage: bun check-bundle-no-absolute-paths.ts <bundle or file>\n")
    process.exit(2)
  }
  let files: string[]
  try {
    files = bundleFiles(target)
  } catch {
    process.stderr.write(`bundle not found: ${target}\n`)
    process.exit(2)
  }
  if (files.length === 0) {
    // A clean verdict over no files is the reassuring lie this whole check
    // exists to avoid.
    process.stderr.write(`bundle has no files to inspect: ${target}\n`)
    process.exit(2)
  }

  const prefixes = buildPrefixes(process.env)
  if (prefixes.length === 0) {
    // A clean verdict reached by refusing nothing is exactly the reassuring
    // lie this check exists to avoid.
    process.stderr.write("no build root prefix could be derived, nothing would be checked\n")
    process.exit(2)
  }
  console.log(`Scanning ${target}`)
  console.log(`Build paths refused: ${prefixes.map((entry) => entry.prefix).join(", ")}`)

  const foreignTotals = new Map<string, number>()
  let bytes = 0
  let failed = false
  for (const file of files) {
    const finding = scanBundleFile(file, prefixes)
    bytes += finding.bytes
    for (const [owner, count] of finding.foreign) {
      foreignTotals.set(owner, (foreignTotals.get(owner) ?? 0) + count)
    }
    const name = path.relative(target, file) || path.basename(file)
    const embedded = finding.raw.length > 0 && sidecarTargets(file) !== null
    if (embedded) {
      // The arithmetic in full, per prefix: what the file carries, what its
      // vendored payloads brought, what is left over for this build to answer
      // for. A subtraction nobody can see is a subtraction nobody can audit.
      for (const hit of finding.raw) {
        const vendored = finding.vendored.find((entry) => entry.name === hit.name)?.count ?? 0
        const excess = finding.fatal.find((entry) => entry.name === hit.name)?.count ?? 0
        console.log(
          `sidecar ${name}: ${hit.prefix} (${hit.name}) ` +
            `raw ${hit.count}, vendored ${vendored}, excess ${excess}`,
        )
      }
      console.log(
        `  vendored payloads measured: ` +
          `${finding.payloads.length === 0 ? "none found" : finding.payloads.join(", ")}`,
      )
    }
    for (const hit of finding.fatal) {
      failed = true
      console.log(
        `FAIL ${name}: ${hit.count} reference(s) to ${hit.prefix} ` +
          `(${hit.name}, ${hit.encodings.join(" and ")}` +
          `${embedded ? ", beyond the vendored payloads" : ""})`,
      )
      const context = firstMatchContext(file, hit.prefix)
      if (context !== null) {
        // In an embedded sidecar the first occurrence is very likely one the
        // payloads brought: the count above is what is ours, the context is
        // only the shape of the string to go looking for.
        const label = embedded ? "first occurrence of the prefix" : "first occurrence"
        console.log(`  ${label}: ${context}`)
      }
    }
  }

  if (foreignTotals.size > 0) {
    console.log("Absolute paths from a vendored third party binary (not this build):")
    for (const [owner, count] of [...foreignTotals].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
      console.log(`  ${owner} x${count}`)
    }
  }

  // THE DEBUG HOOKS, IN THE SAME PASS (P6d-FX7, SK-9). Every release job in
  // the workflow already calls this checker on what it is about to sign, so
  // the artifact half of the debug build guard rides along rather than waiting
  // for fourteen more call sites to be added and kept in step.
  if (reportDebugHooks(scanForDebugHooks(files), target)) failed = true

  console.log(`inspected ${files.length} files, ${bytes} bytes`)
  if (failed) {
    console.log(
      "A shipped bundle must carry no path from the machine that built it. " +
        "Check for a baked in asset path, a panic path (cargo trim-paths) or " +
        "an absolute import.",
    )
    process.exit(1)
  }
  console.log("OK: no path from this build machine is in the bundle")
}
