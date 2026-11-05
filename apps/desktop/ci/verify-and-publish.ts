#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The two signature gate, and the only thing in this pipeline that writes a
// latest.json.
//
// A published manifest is acted on by every installed copy with no human in
// the loop, so both signatures have to hold against the bytes THIS run
// produced, and both are checked here, together, immediately before the
// upload. Not in the build job, not cached from an earlier run: a verification
// that happened somewhere else at some other time is exactly the desync that
// ships a notarized artifact whose updater signature belongs to a different
// build.
//
// The two signatures say different things and neither substitutes for the
// other. The OS one (Apple notarization, Azure Artifact Signing) says a
// developer account vouched for the binary; the updater one says the Liaison
// project built it. A fork's operator can obtain the first and can never
// obtain the second, which is what makes "updates come from the project, not
// from a deployment" enforceable rather than a promise.
//
// The macOS half unpacks the updater archive and verifies the app INSIDE it
// (codesign, Gatekeeper, a stapled ticket on both the app and the disk image),
// because that copy is what an installed machine replaces itself with.
//
// The Windows half acts on the marker file the Windows build job wrote beside
// its artifacts, windows-signing.json, and on nothing else. It has three
// states and no fourth:
//   signed: true    the installer must carry an Authenticode signature, and
//                   signtool verifies the chain wherever signtool exists. No
//                   signature in the bytes is a refusal, whatever the marker
//                   says.
//   signed: false   the documented unsigned skip, taken only because the
//                   build job itself recorded that it signed nothing and why.
//                   It passes, loudly, and the reason is in the warning.
//   absent          a REFUSAL. The publish job holds no Azure secret and can
//                   never work the answer out for itself: it once tried, by
//                   reading AZURE_CLIENT_ID from its own environment, and so
//                   waived the Authenticode half of this gate on every real
//                   release while the log said it ran.
//
// Linux is unsigned by design and its half is the checksum file.
//
// Refusal is the default: every path that is not an explicit pass returns
// `{published: false}` with a reason, and the caller exits non zero.
//
// Usage:
//   bun apps/desktop/ci/verify-and-publish.ts --request <request.json> [--dry-run]

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isTestVersion } from "./downloads"
import { verifyMinisign } from "./minisign"
import { assertNoDashPunctuation } from "./no-dash"

export type OperatingSystem = "macos" | "windows" | "linux"

export interface PlatformEntry {
  /** The updater's own platform key, e.g. `darwin-aarch64`. */
  key: string
  os: OperatingSystem
  /** The file the updater signature covers, which is the file latest.json
   *  links to and the file an installed app downloads. */
  archive: string
  /** Its detached updater signature, as written beside it by the build. */
  signature: string
  /** The file the OPERATING SYSTEM signature covers: the disk image on macOS,
   *  the installer on Windows, the same archive on Linux. */
  installer: string
  /** Where the archive will be downloadable from once uploaded. */
  url: string
}

/** What the Windows build job recorded about its own signing, written beside
 *  its artifacts as windows-signing.json and uploaded with them.
 *
 *  It exists because the publish job cannot answer the question for itself: it
 *  holds no Azure secret, so anything it reads out of its own environment says
 *  "unsigned" on every release, signed ones included. The job that did the
 *  signing is the only one that knows, so it writes down what it did. */
export interface WindowsSigningMarker {
  /** True when Azure Artifact Signing actually signed the artifacts. */
  signed: boolean
  /** Why, in the job's own words. Published in the warning when signed is
   *  false, so a release page nobody checked still says it in the log. */
  reason: string
  /** The certificate subject the job signed with, empty when it signed
   *  nothing. */
  publisher: string
}

export interface PublishRequest {
  version: string
  /** The release notes a customer reads in the update prompt. */
  notes: string
  /** The GitHub release the manifest is uploaded to. */
  tag: string
  platforms: PlatformEntry[]
  /** The Windows job's own record of what it signed. Absent is a REFUSAL, not
   *  a skip: "we do not know" and "it is fine" are the two answers this gate
   *  exists to keep apart. */
  windowsSigning?: WindowsSigningMarker
}

export interface Manifest {
  version: string
  notes: string
  pub_date: string
  platforms: Record<string, { signature: string; url: string }>
}

export type PublishResult =
  | { published: false; reason: string; detail?: string }
  | { published: true; manifest: Manifest; checksums: string; uploaded: string[] }

/** Everything that touches the world, in one injectable object, so the gate's
 *  own decisions can be driven from a test with recorded fixtures. */
export interface GateIo {
  exists(file: string): boolean
  readText(file: string): string
  readBytes(file: string): Buffer
  run(command: string[]): { code: number; stdout: string; stderr: string }
  which(tool: string): boolean
  /** The OS the gate runs on. A tool name alone says nothing: the publish Mac
   *  has a `signtool` on its PATH that is Mozilla's, not Microsoft's. */
  platform(): NodeJS.Platform
  writeText(file: string, contents: string): void
  /** A scratch directory. The macOS check unpacks the updater archive into
   *  one, because what has to be verified is the app the updater will
   *  install, not the disk image beside it. */
  tempDir(): string
  /** Deletes a scratch directory `tempDir` handed out. Every run unpacks a
   *  whole app (about 0.5 GB) into one, so a gate that kept them filled the
   *  release machine's system disk: 270 were left behind in four days. */
  removeDir(dir: string): void
  now(): Date
  warn(message: string): void
}

export const realIo: GateIo = {
  exists: (file) => existsSync(file),
  readText: (file) => readFileSync(file, "utf8"),
  readBytes: (file) => readFileSync(file),
  run(command) {
    const [program, ...args] = command
    const result = spawnSync(program as string, args, { encoding: "utf8" })
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    }
  },
  which: (tool) => spawnSync("which", [tool], { encoding: "utf8" }).status === 0,
  platform: () => process.platform,
  writeText: (file, contents) => writeFileSync(file, contents),
  tempDir: () => mkdtempSync(path.join(tmpdir(), "liaison-gate-")),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
  now: () => new Date(),
  warn: (message) => console.warn(message),
}

export type CheckOutcome = { ok: true; detail: string } | { ok: false; detail: string }

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** The certificate table in a PE optional header: an Authenticode PRESENCE
 *  check, readable on any host. It says a signature is embedded, not that it
 *  chains to a trusted root; `signtool verify /pa` is the Windows runner's
 *  job and runs too when the tool is there. Presence alone still catches the
 *  failure that matters here, an installer that was never signed at all. */
export function hasAuthenticodeSignature(pe: Buffer): boolean {
  if (pe.length < 0x40 || pe.readUInt16LE(0) !== 0x5a4d) return false
  const peOffset = pe.readUInt32LE(0x3c)
  if (peOffset + 0x18 > pe.length || pe.readUInt32LE(peOffset) !== 0x00004550) return false
  const optional = peOffset + 0x18
  const magic = pe.readUInt16LE(optional)
  // PE32 keeps the data directories 96 bytes in, PE32+ 112.
  const directories = optional + (magic === 0x20b ? 112 : 96)
  const certificateTable = directories + 4 * 8
  if (certificateTable + 8 > pe.length) return false
  return pe.readUInt32LE(certificateTable + 4) > 0
}

/** The bytes the updater signature was made over, as recorded beside the
 *  artifact by apps/desktop/ci/sign-updater-artifact.ts at signing time.
 *
 *  This is the FIRST thing the gate checks, and it runs before either
 *  signature is looked at. An artifact that was rebuilt, repacked or renamed
 *  after it was signed fails every later check too, but it fails them as
 *  "tampered", which sends whoever is on call hunting an attacker instead of
 *  reading the pipeline. */
export function assertArtifactChecksumMatchesSignedInput(
  archive: string,
  io: GateIo,
): CheckOutcome {
  const record = `${archive}.sha256`
  if (!io.exists(record)) {
    return {
      ok: false,
      detail: `no recorded checksum beside ${archive}: nothing says which bytes were signed`,
    }
  }
  if (!io.exists(archive)) return { ok: false, detail: `no artifact at ${archive}` }
  const recorded = (io.readText(record).trim().split(/\s+/)[0] ?? "").toLowerCase()
  const actual = sha256(io.readBytes(archive))
  if (recorded !== actual) {
    return {
      ok: false,
      detail: `${path.basename(archive)} changed after it was signed: signed ${recorded}, on disk ${actual}`,
    }
  }
  return { ok: true, detail: `matches the signed input at ${actual}` }
}

export function verifyOsSignature(
  entry: PlatformEntry,
  io: GateIo,
  request: PublishRequest,
  appleTeamId?: string,
): CheckOutcome {
  if (!io.exists(entry.installer)) {
    return { ok: false, detail: `no artifact at ${entry.installer}` }
  }
  if (entry.os === "macos") {
    // The disk image is notarized and stapled and is NOT itself codesigned:
    // `codesign --verify` on it says "no usable signature" for a perfectly
    // good release. What carries the Developer ID signature is the app, and
    // the app that matters is the one inside the UPDATER archive, since that
    // is the copy an installed machine replaces itself with. Verifying the
    // image and shipping the archive is the desync in its purest form.
    if (!appleTeamId || !/^[A-Z0-9]{10}$/.test(appleTeamId)) {
      return {
        ok: false,
        detail:
          "APPLE_TEAM_ID is not set to an Apple Team ID: the app must be signed by one named team, since several teams' Developer ID certificates can share a keychain",
      }
    }
    const scratch = io.tempDir()
    try {
      const unpacked = io.run(["tar", "-xzf", entry.archive, "-C", scratch])
      if (unpacked.code !== 0) {
        return { ok: false, detail: `could not unpack ${entry.archive}: ${unpacked.stderr.trim()}` }
      }
      const app = path.join(scratch, path.basename(entry.archive).replace(/\.tar\.gz$/, ""))
      const codesign = io.run(["codesign", "--verify", "--deep", "--strict", app])
      if (codesign.code !== 0) {
        return { ok: false, detail: `codesign refused ${app}: ${codesign.stderr.trim()}` }
      }
      // Valid is not ours: Gatekeeper accepts any Developer ID, including one
      // of another team that shares the signing Mac's keychain.
      const described = io.run(["codesign", "-dvv", app])
      const details = `${described.stdout}\n${described.stderr}`.split("\n")
      const developerId = details.some((line) =>
        line.startsWith("Authority=Developer ID Application: "),
      )
      if (
        described.code !== 0 ||
        !developerId ||
        !details.includes(`TeamIdentifier=${appleTeamId}`)
      ) {
        const seen = details.filter((line) => /^(Authority|TeamIdentifier)=/.test(line)).join(", ")
        return {
          ok: false,
          detail: `${app} is not signed by a Developer ID Application of team ${appleTeamId}: ${seen || described.stderr.trim()}`,
        }
      }
      const assessed = io.run(["spctl", "--assess", "--type", "execute", app])
      if (assessed.code !== 0) {
        return { ok: false, detail: `Gatekeeper refused ${app}: ${assessed.stderr.trim()}` }
      }
      for (const notarized of [app, entry.installer]) {
        const stapled = io.run(["xcrun", "stapler", "validate", notarized])
        if (stapled.code !== 0) {
          return {
            ok: false,
            detail: `no notarization ticket on ${notarized}: ${stapled.stdout.trim()}`,
          }
        }
      }
      return {
        ok: true,
        detail: `the app codesigned by team ${appleTeamId} and assessed, both it and the image stapled`,
      }
    } finally {
      io.removeDir(scratch)
    }
  }
  if (entry.os === "windows") {
    const marker = request.windowsSigning
    if (!marker) {
      // A Windows artifact with no signing marker beside it is a job that did
      // something nobody recorded. Refused, never waved through: the marker is
      // the only thing in this pipeline that knows.
      return {
        ok: false,
        detail:
          "no signing marker for the Windows build: windows-signing.json was not uploaded beside the installer, so nothing says whether it was signed",
      }
    }
    if (!marker.signed) {
      // The one documented skip, and it is LOUD. It exists because the Azure
      // service principal may not be configured yet, and a pipeline that
      // cannot be green before it is gets deleted rather than fixed. It is
      // reached only when the Windows job itself wrote down that it signed
      // nothing, and it carries that job's reason.
      io.warn(
        `WARNING: ${entry.installer} is UNSIGNED, the Windows build signed nothing: ${marker.reason}. ` +
          "This manifest ships an installer Windows will warn about.",
      )
      return { ok: true, detail: `unsigned, skip path recorded by the build job: ${marker.reason}` }
    }
    if (!hasAuthenticodeSignature(io.readBytes(entry.installer))) {
      return { ok: false, detail: `${entry.installer} carries no Authenticode signature` }
    }
    if (io.platform() === "win32" && io.which("signtool")) {
      const verified = io.run(["signtool", "verify", "/pa", entry.installer])
      if (verified.code !== 0) {
        return {
          ok: false,
          detail: `signtool refused ${entry.installer}: ${verified.stdout.trim()}`,
        }
      }
      return {
        ok: true,
        detail: `Authenticode present, signtool verified the chain (${marker.publisher})`,
      }
    }
    return {
      ok: true,
      detail: `Authenticode present (${marker.publisher}); chain validation is the Windows runner's job`,
    }
  }
  // Linux is unsigned by design in this epic: no signing credential exists for
  // it anywhere. What a downloader gets is the checksum file published beside
  // the packages, so what the gate can require is that the file is there and
  // that it describes THIS artifact.
  // The checksum file is written once per build, beside the package
  // directories rather than inside one, and the artifact download keeps that
  // shape. Both places are looked at so the gate does not depend on how a
  // downloaded artifact happened to be laid out.
  const directory = path.dirname(entry.installer)
  const checksums = [
    path.join(directory, "SHA256SUMS"),
    path.join(directory, "..", "SHA256SUMS"),
  ].find((candidate) => io.exists(candidate))
  if (!checksums) {
    return { ok: false, detail: `no SHA256SUMS beside ${entry.installer}` }
  }
  const digest = sha256(io.readBytes(entry.installer))
  const name = path.basename(entry.installer)
  const listed = io
    .readText(checksums)
    .split("\n")
    .some((line) => line.includes(name) && line.includes(digest))
  if (!listed) {
    return { ok: false, detail: `SHA256SUMS does not list ${name} at ${digest}` }
  }
  return { ok: true, detail: `listed in SHA256SUMS at ${digest}` }
}

export function verifyUpdaterSignature(
  entry: PlatformEntry,
  publicKey: string,
  io: GateIo,
): CheckOutcome {
  if (!io.exists(entry.signature)) {
    return { ok: false, detail: `no updater signature at ${entry.signature}` }
  }
  if (!io.exists(entry.archive)) {
    return { ok: false, detail: `no artifact at ${entry.archive}` }
  }
  const outcome = verifyMinisign(
    io.readBytes(entry.archive),
    io.readText(entry.signature),
    publicKey,
  )
  if (!outcome.ok) return { ok: false, detail: `${entry.archive}: ${outcome.reason}` }
  return { ok: true, detail: outcome.trustedComment }
}

/** The public key the shipped build verifies against, read from the same conf
 *  file that is compiled into it. Reading it from anywhere else would let the
 *  gate approve a signature the app itself would reject. */
export function configuredPublicKey(desktopRoot = path.resolve(import.meta.dir, "..")): string {
  const config = JSON.parse(
    readFileSync(path.join(desktopRoot, "src-tauri/tauri.conf.json"), "utf8"),
  ) as { plugins?: { updater?: { pubkey?: string } } }
  const pubkey = config.plugins?.updater?.pubkey
  if (!pubkey) throw new Error("tauri.conf.json declares no updater pubkey")
  return pubkey
}

export interface PublishOptions {
  io?: GateIo
  publicKey?: string
  dryRun?: boolean
  /** The Apple Team ID the macOS app must be signed by (APPLE_TEAM_ID in the
   *  publish job). Absent refuses a macOS artifact: a keychain can hold
   *  several teams' Developer ID certificates, and "signed by some Developer
   *  ID" is not "signed by us". */
  appleTeamId?: string
}

export function publishManifest(
  request: PublishRequest,
  options: PublishOptions = {},
): PublishResult {
  const io = options.io ?? realIo
  const publicKey = options.publicKey ?? configuredPublicKey()
  const dryRun = options.dryRun ?? false

  if (request.platforms.length === 0) {
    return { published: false, reason: "no platform artifact to publish" }
  }

  // A TEST build (channel.ts) is signed with the real keys, so nothing but its
  // version tells it from a release. Only the test channel's publish, which
  // runs this gate in dry run mode and makes no release, may carry one.
  if (!dryRun && isTestVersion(request.version)) {
    return {
      published: false,
      reason: "a test build is never published as a release",
      detail: `version ${request.version}`,
    }
  }

  // Customer copy, and the one piece of the manifest a human wrote in a hurry
  // at release time. It is linted before anything is verified: a refusal here
  // costs nothing, and the alternative is the dash landing in an update prompt
  // on every machine.
  try {
    assertNoDashPunctuation(request.notes, "the release notes")
  } catch (error) {
    return {
      published: false,
      reason: "release notes failed the no dash punctuation lint",
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  const platforms: Manifest["platforms"] = {}
  const checksumLines: string[] = []

  for (const entry of request.platforms) {
    const unchanged = assertArtifactChecksumMatchesSignedInput(entry.archive, io)
    if (!unchanged.ok) {
      return {
        published: false,
        reason: "the artifact does not match the bytes that were signed",
        detail: `${entry.key}: ${unchanged.detail}`,
      }
    }
    const os = verifyOsSignature(entry, io, request, options.appleTeamId)
    if (!os.ok) {
      return {
        published: false,
        reason: "os signature verification failed",
        detail: `${entry.key}: ${os.detail}`,
      }
    }
    const updater = verifyUpdaterSignature(entry, publicKey, io)
    if (!updater.ok) {
      return {
        published: false,
        reason: "updater key signature verification failed",
        detail: `${entry.key}: ${updater.detail}`,
      }
    }
    platforms[entry.key] = {
      signature: io.readText(entry.signature).trim(),
      url: entry.url,
    }
    // The universal macOS archive answers two keys: one checksum line for it.
    const line = `${sha256(io.readBytes(entry.archive))}  ${path.basename(entry.archive)}`
    if (!checksumLines.includes(line)) checksumLines.push(line)
  }

  const manifest: Manifest = {
    version: request.version,
    notes: request.notes,
    pub_date: io.now().toISOString(),
    platforms,
  }
  const checksums = `${checksumLines.join("\n")}\n`

  if (dryRun) return { published: true, manifest, checksums, uploaded: [] }

  const release = ensureRelease(request, io)
  if (!release.ok) {
    return { published: false, reason: release.reason, detail: release.detail }
  }

  const manifestPath = "latest.json"
  const checksumPath = "SHA256SUMS.txt"
  io.writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  io.writeText(checksumPath, checksums)
  const uploaded = [...releaseRecordFiles(request), manifestPath, checksumPath]
  const upload = io.run(["gh", "release", "upload", request.tag, ...uploaded, "--clobber"])
  if (upload.code !== 0) {
    return {
      published: false,
      reason: "the manifest upload failed",
      detail: upload.stderr.trim() || upload.stdout.trim(),
    }
  }
  // The release stays a draft until everything is on it: a draft is never
  // "latest", so a failed upload leaves nothing for the rollback script or a
  // person to find and mistake for a release.
  const published = io.run(["gh", "release", "edit", request.tag, "--draft=false"])
  if (published.code !== 0) {
    return {
      published: false,
      reason: "the release could not be taken out of draft",
      detail: published.stderr.trim() || published.stdout.trim(),
    }
  }
  return { published: true, manifest, checksums, uploaded }
}

/** The GitHub release is the project's private record of what was built: the
 *  verified archives, their updater signatures and the OS-signed installers go
 *  onto it beside the manifest. Each file once, in request order: on Linux the
 *  archive and the installer are the same file. */
export function releaseRecordFiles(request: PublishRequest): string[] {
  const files: string[] = []
  for (const entry of request.platforms) {
    for (const file of [entry.archive, entry.signature, entry.installer]) {
      if (!files.includes(file)) files.push(file)
    }
  }
  return files
}

/** A tag push creates no release on its own, and `gh release upload` refuses
 *  a tag without one ("release not found"). So the gate looks first and
 *  creates the release itself when the tag has none, from the notes the
 *  manifest carries. `--verify-tag` keeps it from inventing a tag: the release
 *  lands on the commit that was built, or not at all. A release that already
 *  exists is reused as is, so a rerun of the publish job never makes a second
 *  one. It is created as a draft; the publish takes it out of draft once the
 *  assets are on it. */
export function ensureRelease(
  request: PublishRequest,
  io: GateIo,
): { ok: true; detail: string } | { ok: false; reason: string; detail: string } {
  const viewed = io.run(["gh", "release", "view", request.tag, "--json", "tagName"])
  if (viewed.code === 0) return { ok: true, detail: `release ${request.tag} exists` }
  // Only "not found" means create. Anything else (auth, network, rate limit)
  // is an unknown state, and creating into an unknown state is how a second
  // release appears; the gate refuses instead and says what gh said.
  if (!/release not found/i.test(viewed.stderr)) {
    return {
      ok: false,
      reason: "the release lookup failed",
      detail: viewed.stderr.trim() || viewed.stdout.trim(),
    }
  }
  const created = io.run([
    "gh",
    "release",
    "create",
    request.tag,
    "--verify-tag",
    "--draft",
    "--title",
    `Liaison desktop ${request.version}`,
    "--notes",
    request.notes,
  ])
  if (created.code !== 0) {
    return {
      ok: false,
      reason: "the release could not be created",
      detail: created.stderr.trim() || created.stdout.trim(),
    }
  }
  return { ok: true, detail: `release ${request.tag} created` }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const requestIndex = argv.indexOf("--request")
  if (requestIndex === -1 || !argv[requestIndex + 1]) {
    console.error("usage: verify-and-publish.ts --request <request.json> [--dry-run]")
    process.exit(2)
  }
  const request = JSON.parse(
    readFileSync(argv[requestIndex + 1] as string, "utf8"),
  ) as PublishRequest
  const dryRun = argv.includes("--dry-run")
  const manifestOutIndex = argv.indexOf("--manifest-out")
  const manifestOut = manifestOutIndex === -1 ? undefined : argv[manifestOutIndex + 1]
  // --manifest-out: the TEST channel's publish (channel.ts). It runs the whole
  // gate in dry run mode, so no GitHub release is made for a build that has no
  // tag, and writes the manifest the gate produced for the mirror to publish
  // under desktop/test/. Only a test version may take it: a release's manifest
  // comes from the full publish above and nowhere else.
  if (manifestOut !== undefined && (!dryRun || !isTestVersion(request.version))) {
    console.error("--manifest-out is for a test channel version, with --dry-run")
    process.exit(2)
  }
  const result = publishManifest(request, { dryRun, appleTeamId: process.env.APPLE_TEAM_ID })
  if (!result.published) {
    console.error(`refusing to publish: ${result.reason}`)
    if (result.detail) console.error(result.detail)
    process.exit(1)
  }
  if (manifestOut) writeFileSync(manifestOut, `${JSON.stringify(result.manifest, null, 2)}\n`)
  console.log(JSON.stringify(result.manifest, null, 2))
  console.log(
    result.uploaded.length > 0
      ? `uploaded: ${result.uploaded.join(", ")}`
      : "dry run, nothing uploaded",
  )
}
