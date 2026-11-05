#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Turns what the three build jobs actually uploaded into the request the
// publish gate acts on.
//
// Written as a step of its own rather than a list in the workflow because the
// failure it has to produce is "a platform is missing", loudly. A hand written
// platform list would simply describe two platforms and publish a manifest
// that silently stops updating the third.
//
// It also carries the Windows job's signing marker through to the gate. The
// publish job holds no Azure secret, so anything it reads out of its own
// environment says "unsigned" on every release: the only place the answer
// exists is the file the Windows job wrote beside its artifacts.
//
// Usage:
//   bun apps/desktop/ci/build-publish-request.ts \
//     --artifacts <dir> --tag <release tag> --notes-file <file> --out <file>

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { configuredVersion } from "./artifact-names"
import { artifactUrl, isTestVersion } from "./downloads"
import type {
  OperatingSystem,
  PlatformEntry,
  PublishRequest,
  WindowsSigningMarker,
} from "./verify-and-publish"

/** The platform each build job in apps/desktop/ci/desktop-release.workflow.yml
 *  produces. ONE constant, read here and by the workflow's own test, so a job
 *  added to the workflow without a platform here (or a platform here with no
 *  job) fails a test rather than shipping a manifest that is quietly one
 *  platform short. */
export const JOB_PLATFORMS: Record<string, string[]> = {
  "build-macos": ["darwin-aarch64", "darwin-x86_64"],
  "build-windows": ["windows-x86_64"],
  "build-linux": ["linux-x86_64"],
}

/** Every platform that MUST be in the download. A manifest missing one does
 *  not fail anything by itself: the release page looks right, the pipeline is
 *  green, and installed copies on that platform are simply never offered an
 *  update again. */
export const REQUIRED_PLATFORM_KEYS: string[] = Object.values(JOB_PLATFORMS).flat()

/** The updater's platform keys, and what each one's files look like. macOS
 *  ships ONE universal build, and the updater asks by the running machine's
 *  arch, so the universal archive answers both darwin keys. A thin archive
 *  for the key's own arch is still accepted, and preferred when both exist. */
export const PLATFORM_KEYS: Record<string, { os: OperatingSystem; archive: RegExp }> = {
  "darwin-aarch64": { os: "macos", archive: /^Liaison_.*_(aarch64|universal)\.app\.tar\.gz$/ },
  "darwin-x86_64": { os: "macos", archive: /^Liaison_.*_(x86_64|universal)\.app\.tar\.gz$/ },
  "windows-x86_64": { os: "windows", archive: /^Liaison_.*_x86_64\.exe$/ },
  "linux-x86_64": { os: "linux", archive: /^Liaison_.*_x86_64\.AppImage$/ },
}

/** The file the Windows job writes beside its installer, as
 *  apps/desktop/ci/sign-windows.ps1 writes it. */
export const WINDOWS_SIGNING_MARKER = "windows-signing.json"

/** Reads that marker. Every failure here is a THROW rather than a default:
 *  a marker that is missing, unreadable or does not say what happened leaves
 *  the Authenticode half of the gate with no input, and the one thing it must
 *  never do then is assume the answer. */
function windowsSigningMarker(files: string[]): WindowsSigningMarker {
  const found = files.find((file) => path.basename(file) === WINDOWS_SIGNING_MARKER)
  if (!found) {
    throw new Error(
      `windows-x86_64: no ${WINDOWS_SIGNING_MARKER} beside the Windows artifacts. ` +
        "The Windows job records what it signed; without that record nothing here can tell a signed release from an unsigned one.",
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(found, "utf8"))
  } catch (error) {
    throw new Error(
      `${WINDOWS_SIGNING_MARKER} is not readable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const marker = parsed as Partial<WindowsSigningMarker>
  if (typeof marker?.signed !== "boolean") {
    throw new Error(`${WINDOWS_SIGNING_MARKER} does not say whether the artifacts were signed`)
  }
  return {
    signed: marker.signed,
    reason: typeof marker.reason === "string" ? marker.reason : "",
    publisher: typeof marker.publisher === "string" ? marker.publisher : "",
  }
}

function walk(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const entry = path.join(dir, name)
    if (statSync(entry).isDirectory()) found.push(...walk(entry))
    else found.push(entry)
  }
  return found
}

/** The file the OS signature covers. On macOS that is the disk image a human
 *  downloads, which is a different file from the updater's archive; elsewhere
 *  the two are the same file. */
function installerFor(entry: { os: OperatingSystem; archive: string }, files: string[]): string {
  if (entry.os !== "macos") return entry.archive
  const arch = /_(aarch64|x86_64|universal)\.app\.tar\.gz$/.exec(path.basename(entry.archive))?.[1]
  if (!arch) throw new Error(`no arch in the name of ${entry.archive}`)
  const dmg = files.find((file) => file.endsWith(`_${arch}.dmg`))
  if (!dmg) throw new Error(`no disk image beside ${entry.archive}`)
  return dmg
}

export function buildRequest(options: {
  artifactsDir: string
  tag: string
  notes: string
}): PublishRequest {
  const files = walk(options.artifactsDir)
  // The version the bundler stamped, read before the urls are built: every
  // url in the manifest is a path under that version on the public downloads
  // host, and there is no option here for naming another one. The GitHub
  // release is the private record of a build; the host an installed copy
  // downloads from is not a parameter of the release run.
  const version = configuredVersion()
  const platforms: PlatformEntry[] = []
  for (const [key, shape] of Object.entries(PLATFORM_KEYS)) {
    // A thin archive for the key's own arch wins over the universal one.
    const matching = files.filter((file) => shape.archive.test(path.basename(file)))
    const archive =
      matching.find((file) => !path.basename(file).includes("_universal.")) ?? matching[0]
    if (!archive) continue
    const signature = `${archive}.sig`
    if (!existsSync(signature)) {
      throw new Error(
        `${key}: ${path.basename(archive)} was uploaded without its updater signature`,
      )
    }
    platforms.push({
      key,
      os: shape.os,
      archive,
      signature,
      installer: installerFor({ os: shape.os, archive }, files),
      url: artifactUrl(version, path.basename(archive)),
    })
  }
  const missing = REQUIRED_PLATFORM_KEYS.filter(
    (key) => !platforms.some((entry) => entry.key === key),
  )
  // A test channel build may be narrowed to the platforms under test; a
  // release may not.
  if (missing.length > 0 && !isTestVersion(version)) {
    throw new Error(
      `missing from ${options.artifactsDir}: ${missing.join(", ")}. ` +
        "Every platform the release workflow builds has to be in the manifest: " +
        "a shorter manifest is an update channel that goes dead on that platform with nothing said.",
    )
  }
  const windowsSigning = platforms.some((entry) => entry.os === "windows")
    ? windowsSigningMarker(files)
    : undefined
  // A test build exists to be run on a machine with Smart App Control on,
  // which refuses an unsigned installer outright: an unsigned one tests
  // nothing and is refused here rather than published.
  if (isTestVersion(version) && windowsSigning && !windowsSigning.signed) {
    throw new Error(
      `windows-x86_64: the test build ${version} is not Authenticode signed (${windowsSigning.reason}). ` +
        "Smart App Control blocks an unsigned installer, so this build could not test the update it is for.",
    )
  }
  if (platforms.length === 0) {
    throw new Error(`nothing to publish in ${options.artifactsDir}`)
  }
  return {
    version,
    notes: options.notes,
    tag: options.tag,
    platforms,
    windowsSigning,
  }
}

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const artifactsDir = argument(argv, "--artifacts")
  const tag = argument(argv, "--tag")
  const notesFile = argument(argv, "--notes-file")
  const out = argument(argv, "--out")
  if (!artifactsDir || !tag || !notesFile || !out) {
    console.error(
      "usage: build-publish-request.ts --artifacts <dir> --tag <tag> --notes-file <file> --out <file>",
    )
    process.exit(2)
  }
  try {
    if (!existsSync(notesFile)) {
      // A release with no notes is a release whose update prompt says nothing.
      // Copy apps/desktop/ci/RELEASE_NOTES_TEMPLATE.md and fill it in.
      throw new Error(`no release notes at ${notesFile}`)
    }
    const request = buildRequest({
      artifactsDir,
      tag,
      notes: readFileSync(notesFile, "utf8"),
    })
    writeFileSync(out, `${JSON.stringify(request, null, 2)}\n`)
    console.log(`platforms: ${request.platforms.map((entry) => entry.key).join(", ")}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
