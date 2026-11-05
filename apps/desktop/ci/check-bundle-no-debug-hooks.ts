#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DEBUG HOOKS, CHECKED IN THE PRODUCED BINARY (P6d-FX7, SK-9).
//
// The shell carries three things that exist for a driven walk and must not
// exist in anything a customer installs: the DOM driver's directory
// (`LIAISON_DEBUG_DRIVER`), the background window (`LIAISON_DEBUG_BACKGROUND`)
// and the seeded recent folder (`LIAISON_DEBUG_SEED_RECENT_FOLDER`). All three
// are behind `#[cfg(debug_assertions)]`, and every guard that says so is a
// grep over the Rust SOURCE (`main.rs`, `sidecar.rs`: they read the module
// text as a string). None of them has ever looked at a compiled artifact, so
// what is pinned is "the source says it is debug only", and what ships is
// whatever the build profile decided. `tauri build --debug` produces a bundle
// where all three are live, and nothing refused it.
//
// So this reads the BYTES. A literal that is not compiled in cannot appear in
// them; one that is, does, in whichever of the two encodings a binary stores
// its strings in. It is the one check here that is about the artifact rather
// than about the source that produced it.
//
// The two debug-only COMMAND names are deliberately not in this list: the page
// side of them (`driver-bridge.ts`, `diagnostics.ts`) is compiled into
// `overlay.js` on every build and is inert without the Rust half, so refusing
// those strings would refuse every bundle we ship.
//
// Usage: bun check-bundle-no-debug-hooks.ts <bundle or file>
// Exit 0 clean, 1 a debug hook is in the bundle, 2 nothing to inspect.

import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

/** The environment variables that only a debug build reads. */
export const DEBUG_HOOK_MARKERS = [
  "LIAISON_DEBUG_DRIVER",
  "LIAISON_DEBUG_BACKGROUND",
  "LIAISON_DEBUG_SEED_RECENT_FOLDER",
] as const

/** UTF-16LE, which is how a Windows binary stores a good half of its strings.
 *  Matching one encoding is how a check passes on the platform it was written
 *  on and refuses nothing on the other two. */
function utf16le(marker: string): string {
  return marker
    .split("")
    .map((character) => `${character}\u0000`)
    .join("")
}

/** Which debug hooks one file's bytes carry, with a count each. */
export function debugHooksIn(bytes: Uint8Array): Array<{ marker: string; count: number }> {
  const haystack = Buffer.from(bytes).toString("latin1")
  const found: Array<{ marker: string; count: number }> = []
  for (const marker of DEBUG_HOOK_MARKERS) {
    const count = occurrences(haystack, marker) + occurrences(haystack, utf16le(marker))
    if (count > 0) found.push({ marker, count })
  }
  return found
}

function occurrences(haystack: string, needle: string): number {
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

export interface DebugHookFinding {
  file: string
  marker: string
  count: number
}

/** Every debug hook in every one of these files. */
export function scanForDebugHooks(files: string[]): DebugHookFinding[] {
  const findings: DebugHookFinding[] = []
  for (const file of files) {
    let bytes: Uint8Array
    try {
      bytes = readFileSync(file)
    } catch {
      continue
    }
    for (const hit of debugHooksIn(bytes)) {
      findings.push({ file, marker: hit.marker, count: hit.count })
    }
  }
  return findings
}

/** Prints the findings and answers whether the bundle is refused. */
export function reportDebugHooks(findings: DebugHookFinding[], base: string): boolean {
  for (const finding of findings) {
    const name = path.relative(base, finding.file) || path.basename(finding.file)
    console.log(
      `FAIL ${name}: ${finding.count} reference(s) to ${finding.marker}, ` +
        "which only a debug build reads",
    )
  }
  if (findings.length > 0) {
    console.log(
      "A shipped bundle must carry none of the debug only hooks. " +
        "This is a debug build: rebuild without --debug and without " +
        "CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS in the environment.",
    )
    return true
  }
  console.log("OK: no debug only hook is in the bundle")
  return false
}

function bundleFiles(target: string): string[] {
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
    process.stderr.write("usage: bun check-bundle-no-debug-hooks.ts <bundle or file>\n")
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
    process.stderr.write(`bundle has no files to inspect: ${target}\n`)
    process.exit(2)
  }
  if (reportDebugHooks(scanForDebugHooks(files), target)) process.exit(1)
}
