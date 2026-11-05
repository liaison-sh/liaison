#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A build machine's checkout path baked into a shipped artifact is the failure
// this slice is guarding against: it works on the machine that built it and
// resolves to nothing on a customer's machine. The compiled sidecar is scanned
// for the build root prefixes before `build.ts` reports success.
//
// Scope: the sidecar's own output. The outer app bundle gets the wider version
// of this check, ci/check-bundle-no-absolute-paths.ts, which shares the prefix
// derivation and the scan below so the two cannot drift apart.
//
// WHERE THE PREFIXES COME FROM: the environment and the checkout, never a
// literal. A default written into the source is correct on the one machine it
// was written on and silently wrong on every runner, which is how a check like
// this reports OK on a Windows job while inspecting nothing.
//
// WHAT IS NOT THIS BUILD'S: a compiled sidecar is a Bun runtime with our
// bundle and the Claude Code CLI appended to it, both built by somebody else
// on a CI runner. They carry that runner's home directory, which on a GitHub
// runner is the same directory as ours, so the counts a build's own vendored
// payloads contribute are measured and subtracted (`scanFiles` +
// `subtractHits`) rather than guessed at. A reference is this build's only
// when the output carries more of it than its inputs did.
//
// Usage: bun check-no-absolute-paths.ts <file> [<file> ...]
// BUILD_ROOT_PREFIX adds a prefix explicitly; GITHUB_WORKSPACE, RUNNER_TEMP,
// CARGO_HOME, HOME, USERPROFILE and the resolved repository root are read as
// they are found.

import { readFileSync } from "node:fs"
import path from "node:path"

/** A path prefix that would identify the machine running this build. */
export type BuildPrefix = { name: string; prefix: string }

/** One prefix found inside one file, and how it was encoded there. */
export type PrefixHit = { name: string; prefix: string; count: number; encodings: string[] }

/** `C:\`, `c:/` or `\\server\share`: the two shapes an absolute Windows path
 *  takes. Neither starts with "/", which is why a POSIX only test drops every
 *  prefix a Windows runner has. */
const WINDOWS_PREFIX = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/])/

export function isWindowsPrefix(value: string): boolean {
  return WINDOWS_PREFIX.test(value)
}

/** A prefix worth refusing: an absolute path, POSIX or Windows, long enough to
 *  mean something. "/" alone would refuse every path in the binary. */
export function isUsablePrefix(value: string): boolean {
  return value.length > 1 && (value.startsWith("/") || isWindowsPrefix(value))
}

/** One spelling per prefix, for dedupe: forward slashes, no trailing
 *  separator, and case folded when the prefix is a Windows one (the file
 *  system it names is case insensitive). */
export function canonicalPrefix(value: string): string {
  const slashed = value.replace(/\\/g, "/").replace(/\/+$/, "")
  return isWindowsPrefix(value) ? slashed.toLowerCase() : slashed
}

/** The strings to actually look for: both slash kinds, because a Windows path
 *  is written `D:\a\liaison` by the shell and `D:/a/liaison` by rustc. */
export function prefixNeedles(value: string): string[] {
  const trimmed = value.replace(/[\\/]+$/, "")
  const forward = trimmed.replace(/\\/g, "/")
  const back = trimmed.replace(/\//g, "\\")
  return forward === back ? [forward] : [forward, back]
}

/** The repository root, resolved from this file at runtime. */
export function repoRoot(): string {
  return path.resolve(import.meta.dir, "..", "..", "..")
}

/** Directories that belong to THIS build, read from the environment and from
 *  the checkout rather than guessed: a CI runner's root is not a developer
 *  machine's, and a Windows runner's is neither. */
export function buildRootPrefixes(
  env: Record<string, string | undefined>,
  root: string = repoRoot(),
): BuildPrefix[] {
  const candidates: BuildPrefix[] = [
    { name: "BUILD_ROOT_PREFIX", prefix: env.BUILD_ROOT_PREFIX ?? "" },
    { name: "GITHUB_WORKSPACE", prefix: env.GITHUB_WORKSPACE ?? "" },
    { name: "RUNNER_TEMP", prefix: env.RUNNER_TEMP ?? "" },
    { name: "CARGO_HOME", prefix: env.CARGO_HOME ?? "" },
    { name: "HOME", prefix: env.HOME ?? "" },
    { name: "USERPROFILE", prefix: env.USERPROFILE ?? "" },
    { name: "repository root", prefix: root },
  ]
  const seen = new Set<string>()
  return candidates.filter((entry) => {
    if (!isUsablePrefix(entry.prefix)) return false
    const key = canonicalPrefix(entry.prefix)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The decoded views of one artifact, one at a time so two decodes of a 300 MB
 *  binary are never both alive.
 *
 *  latin1 reads the buffer as bytes, with no multi byte boundary to fall
 *  through, which covers everything a Unix toolchain writes. utf16le covers
 *  what a Windows toolchain writes: the panic paths in a PE image, the
 *  resource tables and the NSIS strings are all UTF-16, and a latin1 scan
 *  reads those as a path with a NUL between every character, which matches
 *  nothing at all. A check that reports OK having looked only at the encoding
 *  the artifact does not use is worse than no check. */
export function forEachHaystack(
  buffer: Buffer,
  visit: (encoding: string, text: string) => void,
): void {
  visit("latin1", buffer.toString("latin1"))
  visit("utf16le", buffer.toString("utf16le"))
}

/** Count each prefix in one decoded haystack, accumulating into `into`. */
export function countPrefixes(
  text: string,
  prefixes: BuildPrefix[],
  encoding: string,
  into: Map<string, PrefixHit>,
): Map<string, PrefixHit> {
  // Folding a 300 MB string is not free, so it happens once per haystack and
  // only when a prefix actually needs it.
  const folded = prefixes.some((entry) => isWindowsPrefix(entry.prefix)) ? text.toLowerCase() : text
  for (const { name, prefix } of prefixes) {
    const windows = isWindowsPrefix(prefix)
    const haystack = windows ? folded : text
    let count = 0
    for (const needle of prefixNeedles(windows ? prefix.toLowerCase() : prefix)) {
      count += haystack.split(needle).length - 1
    }
    if (count === 0) continue
    const hit = into.get(name)
    if (hit) {
      hit.count += count
      if (!hit.encodings.includes(encoding)) hit.encodings.push(encoding)
    } else {
      into.set(name, { name, prefix, count, encodings: [encoding] })
    }
  }
  return into
}

/** Every build prefix inside one file, in every encoding it may be written in. */
export function scanFile(file: string, prefixes: BuildPrefix[]): PrefixHit[] {
  const hits = new Map<string, PrefixHit>()
  forEachHaystack(readFileSync(file), (encoding, text) => {
    countPrefixes(text, prefixes, encoding, hits)
  })
  return [...hits.values()]
}

/** Every build prefix across a set of files, counts summed. Used for the
 *  vendored payloads a compiled binary is assembled from. */
export function scanFiles(files: string[], prefixes: BuildPrefix[]): PrefixHit[] {
  const hits = new Map<string, PrefixHit>()
  for (const file of files) {
    for (const hit of scanFile(file, prefixes)) {
      const existing = hits.get(hit.name)
      if (existing) {
        existing.count += hit.count
        for (const encoding of hit.encodings) {
          if (!existing.encodings.includes(encoding)) existing.encodings.push(encoding)
        }
      } else {
        hits.set(hit.name, { ...hit, encodings: [...hit.encodings] })
      }
    }
  }
  return [...hits.values()]
}

/** What is left of a file's hits once the references its vendored inputs
 *  brought with them are accounted for.
 *
 *  WHY THIS EXISTS: a compiled sidecar is a Bun runtime with our bundle and an
 *  embedded CLI appended, and both of those payloads were built by somebody
 *  else on a machine whose home directory is the CI runner's own. Counting
 *  them as this build's makes the check fire on every GitHub runner and on no
 *  developer machine, which teaches whoever hits it to delete the check. A
 *  reference is ours only when the output carries MORE of it than the inputs
 *  did, so a path we bake in ourselves is still caught even when the same
 *  prefix is already in the runtime a hundred times over. */
export function subtractHits(hits: PrefixHit[], baseline: PrefixHit[]): PrefixHit[] {
  const known = new Map(baseline.map((hit) => [hit.name, hit.count]))
  const residue: PrefixHit[] = []
  for (const hit of hits) {
    const count = hit.count - (known.get(hit.name) ?? 0)
    if (count > 0) residue.push({ ...hit, count })
  }
  return residue
}

/** The bytes around the first occurrence of a prefix, so a runner log says
 *  WHAT was baked in rather than only that something was. Unprintable bytes
 *  become dots: the surroundings in a binary are not text. */
export function firstMatchContext(file: string, prefix: string, span = 100): string | null {
  let found: string | null = null
  forEachHaystack(readFileSync(file), (_encoding, text) => {
    if (found !== null) return
    for (const needle of prefixNeedles(prefix)) {
      const at = text.indexOf(needle)
      if (at === -1) continue
      const slice = text.slice(Math.max(0, at - span), at + needle.length + span)
      found = slice.replace(/[^\x20-\x7e]/g, ".")
      return
    }
  })
  return found
}

if (import.meta.main) {
  const files = process.argv.slice(2)
  if (files.length === 0) {
    process.stderr.write("usage: bun check-no-absolute-paths.ts <file> [<file> ...]\n")
    process.exit(2)
  }
  const prefixes = buildRootPrefixes(process.env)
  if (prefixes.length === 0) {
    // A clean verdict reached by refusing nothing is the reassuring lie this
    // check exists to avoid.
    process.stderr.write("no build root prefix could be derived, nothing would be checked\n")
    process.exit(2)
  }
  console.log(`Build paths refused: ${prefixes.map((entry) => entry.prefix).join(", ")}`)
  let found = false
  for (const file of files) {
    for (const hit of scanFile(file, prefixes)) {
      found = true
      console.log(
        `build root path baked into ${path.basename(file)}: ${hit.prefix} ` +
          `(${hit.name}, ${hit.count} reference(s), ${hit.encodings.join(" and ")})`,
      )
      const context = firstMatchContext(file, hit.prefix)
      if (context !== null) console.log(`  first occurrence: ${context}`)
    }
  }
  if (found) {
    console.log(
      "A compiled sidecar must carry no path from the machine that built it. " +
        "Check for an absolute import, an embedded file path or a baked in default.",
    )
    process.exit(1)
  }
}
