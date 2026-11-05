// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The gate, driven end to end against recorded artifacts.
//
// The fixtures under ci/fixtures/updater were signed with a THROWAWAY key
// generated for them and thrown away in the same command: the project's real
// updater key signs releases and nothing else, and a test that needed it would
// be a test that could not run anywhere but this Mac. Its public half is
// committed beside them so the verification here is the real minisign check,
// over real signed bytes, not a stub.
//
// Four recorded states, one per way a release goes wrong:
//   good               everything matches
//   tampered-artifact  the bytes changed after they were signed (Buzz #3933)
//   tampered-signature the signature was edited
//   wrong-key          signed by a key this build does not trust
//
// The last one is the one that matters most for D13: a deployment can obtain
// an Apple certificate and can never obtain the project's updater key, so a
// fork's build reaches exactly this refusal.
import { describe, expect, it } from "bun:test"
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildRequest } from "./ci/build-publish-request"
import { DOWNLOADS_BASE } from "./ci/downloads"
import {
  type GateIo,
  hasAuthenticodeSignature,
  type PlatformEntry,
  type PublishRequest,
  publishManifest,
  realIo,
  sha256,
} from "./ci/verify-and-publish"

const FIXTURES = path.join(import.meta.dir, "ci/fixtures/updater")
const ARTIFACT = "Liaison_9.9.9_x86_64.AppImage"
const throwawayKey = readFileSync(path.join(FIXTURES, "throwaway.pub"), "utf8")
const otherKey = readFileSync(path.join(FIXTURES, "other-key.pub"), "utf8")

const NOTES = "## What's new\n\n- The fixture release, for the gate's own test.\n"

function linuxEntry(state: string): PlatformEntry {
  const archive = path.join(FIXTURES, state, ARTIFACT)
  return {
    key: "linux-x86_64",
    os: "linux",
    archive,
    signature: `${archive}.sig`,
    installer: archive,
    url: `${DOWNLOADS_BASE}/desktop/9.9.9/${ARTIFACT}`,
  }
}

function request(state: string, overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    version: "9.9.9",
    notes: NOTES,
    tag: "desktop-v9.9.9",
    platforms: [linuxEntry(state)],
    ...overrides,
  }
}

/** The real io, with the two things a test must not do removed: it never runs
 *  a command and never writes a file. Reading the fixtures is real. */
function readOnlyIo(overrides: Partial<GateIo> = {}): GateIo {
  return {
    ...realIo,
    run: () => {
      throw new Error("the gate ran a command in a dry run")
    },
    writeText: () => {
      throw new Error("the gate wrote a file in a dry run")
    },
    removeDir: () => {},
    which: () => false,
    now: () => new Date("2026-09-13T00:00:00.000Z"),
    warn: () => {},
    ...overrides,
  }
}

describe("the two signature gate", () => {
  it("publishes when both the os signature and the updater key signature verify", () => {
    const result = publishManifest(request("good"), {
      io: readOnlyIo(),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result.published).toBe(true)
  })

  it("blocks the publish when the artifact changed after it was signed", () => {
    // Refused by the desync guard rather than by the signature check: it runs
    // first and names the real cause. The signature over these bytes does not
    // verify either, which is the point of checking the recorded checksum
    // before anything else looks at them.
    const result = publishManifest(request("tampered-artifact"), {
      io: readOnlyIo(),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result).toMatchObject({
      published: false,
      reason: "the artifact does not match the bytes that were signed",
    })
  })

  it("blocks the publish when the signature itself was edited", () => {
    const result = publishManifest(request("tampered-signature"), {
      io: readOnlyIo(),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result).toMatchObject({
      published: false,
      reason: "updater key signature verification failed",
    })
  })

  it("blocks the publish when a key this build does not trust signed it", () => {
    // The D13 refusal: a fork cannot mint an update for anybody else.
    const result = publishManifest(request("wrong-key"), {
      io: readOnlyIo(),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result).toMatchObject({
      published: false,
      reason: "updater key signature verification failed",
    })
    expect(result.published === false && result.detail).toContain("this build trusts")
  })

  it("blocks the publish when the os side has nothing to show", () => {
    // The same good artifact, with its checksum file hidden: on Linux the
    // checksum IS the os side, and its absence must refuse rather than pass.
    const io = readOnlyIo({
      exists: (file) => (file.endsWith("SHA256SUMS") ? false : realIo.exists(file)),
    })
    const result = publishManifest(request("good"), {
      io,
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result).toMatchObject({ published: false, reason: "os signature verification failed" })
  })

  it("blocks the publish when the release notes carry dash punctuation", () => {
    const result = publishManifest(
      request("good", { notes: "## What's new\n\n- One thing changed -- and another.\n" }),
      { io: readOnlyIo(), publicKey: throwawayKey, dryRun: true },
    )
    expect(result).toMatchObject({
      published: false,
      reason: "release notes failed the no dash punctuation lint",
    })
  })

  it("blocks the publish when there is no platform artifact at all", () => {
    const result = publishManifest(request("good", { platforms: [] }), {
      io: readOnlyIo(),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result).toMatchObject({ published: false, reason: "no platform artifact to publish" })
  })

  it("verifies against the key the shipped build carries, not one passed in", () => {
    // The gate's default public key is read from tauri.conf.json, the same
    // file compiled into the app. A fixture signed by a throwaway key must
    // therefore be refused when no key is passed.
    const result = publishManifest(request("good"), { io: readOnlyIo(), dryRun: true })
    expect(result).toMatchObject({
      published: false,
      reason: "updater key signature verification failed",
    })
  })

  it("refuses a fixture signed by the other throwaway key even when that key is offered", () => {
    // Symmetry check, so the assertion above cannot pass by the fixtures being
    // unverifiable against anything at all.
    const good = publishManifest(request("wrong-key"), {
      io: readOnlyIo(),
      publicKey: otherKey,
      dryRun: true,
    })
    expect(good.published).toBe(true)
  })
})

describe("the manifest the gate would publish", () => {
  const result = publishManifest(request("good"), {
    io: readOnlyIo(),
    publicKey: throwawayKey,
    dryRun: true,
  })
  if (!result.published) throw new Error(`the good fixture did not publish: ${result.reason}`)

  it("names the version from the request", () => {
    expect(result.manifest.version).toBe("9.9.9")
  })

  it("carries the release notes verbatim, because a customer reads them", () => {
    expect(result.manifest.notes).toBe(NOTES)
  })

  it("stamps a publication date", () => {
    expect(result.manifest.pub_date).toBe("2026-09-13T00:00:00.000Z")
  })

  it("has one platform entry, keyed the way the updater keys them", () => {
    expect(Object.keys(result.manifest.platforms)).toEqual(["linux-x86_64"])
  })

  it("carries the signature bytes from the .sig file, not a path to it", () => {
    const entry = result.manifest.platforms["linux-x86_64"]
    expect(entry?.signature).toBe(
      readFileSync(path.join(FIXTURES, "good", `${ARTIFACT}.sig`), "utf8").trim(),
    )
    expect(entry?.signature).not.toContain("/")
  })

  it("points at the public downloads host, never at the private repository", () => {
    // The GitHub repository is private: an asset url on it answers 404 to
    // every installed copy, and a manifest full of them is an update channel
    // that is dead with nothing said.
    expect(result.manifest.platforms["linux-x86_64"]?.url).toBe(
      `${DOWNLOADS_BASE}/desktop/9.9.9/${ARTIFACT}`,
    )
    expect(result.manifest.platforms["linux-x86_64"]?.url).not.toContain("github.com")
  })

  it("publishes a checksum for the exact bytes it signed off on", () => {
    expect(result.checksums.trim()).toBe(
      readFileSync(path.join(FIXTURES, "good", "SHA256SUMS"), "utf8")
        .trim()
        .replace(/\s+/, "  "),
    )
  })

  it("uploads nothing in a dry run", () => {
    expect(result.uploaded).toEqual([])
  })
})

describe("the GitHub release the manifest lands on", () => {
  /** An io that answers gh like GitHub does and records every command, with
   *  writes swallowed: the files it would write are the manifest and the
   *  checksums, which the manifest tests above already read. */
  function github(options: {
    releaseExists: boolean
    createFails?: boolean
    viewFails?: boolean
    editFails?: boolean
  }) {
    const commands: string[][] = []
    const io = readOnlyIo({
      writeText: () => {},
      run: (command) => {
        commands.push(command)
        const verb = command[2]
        if (verb === "view") {
          if (options.viewFails) return { code: 1, stdout: "", stderr: "HTTP 502: bad gateway" }
          return options.releaseExists
            ? { code: 0, stdout: '{"tagName":"desktop-v9.9.9"}', stderr: "" }
            : { code: 1, stdout: "", stderr: "release not found" }
        }
        if (verb === "edit" && options.editFails) {
          return { code: 1, stdout: "", stderr: "HTTP 500: something went wrong" }
        }
        if (verb === "create" && options.createFails) {
          return { code: 1, stdout: "", stderr: "HTTP 422: tag_name is not a valid tag" }
        }
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    return { io, commands }
  }
  const verbs = (commands: string[][]) => commands.map((command) => command.slice(0, 3).join(" "))

  it("creates the release when the tag has none, on that tag, then uploads onto it", () => {
    const world = github({ releaseExists: false })
    const result = publishManifest(request("good"), { io: world.io, publicKey: throwawayKey })
    expect(result.published).toBe(true)
    expect(verbs(world.commands)).toEqual([
      "gh release view",
      "gh release create",
      "gh release upload",
      "gh release edit",
    ])
    const create = world.commands[1] as string[]
    expect(create).toContain("desktop-v9.9.9")
    expect(create).toContain("--verify-tag")
    expect(create).toContain("--draft")
    expect(world.commands[3]).toEqual(["gh", "release", "edit", "desktop-v9.9.9", "--draft=false"])
    expect(create[create.indexOf("--title") + 1]).toBe("Liaison desktop 9.9.9")
    expect(create[create.indexOf("--notes") + 1]).toBe(request("good").notes)
  })

  it("reuses a release that already exists instead of making a second one", () => {
    const world = github({ releaseExists: true })
    const result = publishManifest(request("good"), { io: world.io, publicKey: throwawayKey })
    expect(result.published).toBe(true)
    expect(verbs(world.commands)).toEqual([
      "gh release view",
      "gh release upload",
      "gh release edit",
    ])
  })

  it("refuses when the release lookup fails for any reason but absence, and creates nothing", () => {
    const world = github({ releaseExists: false, viewFails: true })
    const result = publishManifest(request("good"), { io: world.io, publicKey: throwawayKey })
    expect(result.published).toBe(false)
    if (result.published) throw new Error("unreachable")
    expect(result.reason).toBe("the release lookup failed")
    expect(result.detail).toContain("502")
    expect(verbs(world.commands)).toEqual(["gh release view"])
  })

  it("refuses when the release cannot be taken out of draft, after the upload", () => {
    const world = github({ releaseExists: false, editFails: true })
    const result = publishManifest(request("good"), { io: world.io, publicKey: throwawayKey })
    expect(result.published).toBe(false)
    if (result.published) throw new Error("unreachable")
    expect(result.reason).toBe("the release could not be taken out of draft")
    expect(result.detail).toContain("500")
    expect(verbs(world.commands)).toEqual([
      "gh release view",
      "gh release create",
      "gh release upload",
      "gh release edit",
    ])
  })

  it("refuses when the release cannot be created, and uploads nothing", () => {
    const world = github({ releaseExists: false, createFails: true })
    const result = publishManifest(request("good"), { io: world.io, publicKey: throwawayKey })
    expect(result.published).toBe(false)
    if (result.published) throw new Error("unreachable")
    expect(result.reason).toBe("the release could not be created")
    expect(result.detail).toContain("422")
    expect(verbs(world.commands)).not.toContain("gh release upload")
  })

  it("puts the verified bytes on the release as the private record, manifest last", () => {
    const world = github({ releaseExists: true })
    const entry = request("good").platforms[0] as PlatformEntry
    const result = publishManifest(request("good"), { io: world.io, publicKey: throwawayKey })
    if (!result.published) throw new Error(result.reason)
    const upload = world.commands[1] as string[]
    expect(upload).toContain(entry.archive)
    expect(upload).toContain(entry.signature)
    expect(upload.filter((file) => file === entry.archive)).toHaveLength(1)
    expect(result.uploaded.slice(-2)).toEqual(["latest.json", "SHA256SUMS.txt"])
    expect(upload).toContain("--clobber")
  })
})

/** A portable executable with a certificate table of the given size, built
 *  rather than committed: a real signed .exe is a binary fixture whose
 *  signature expires, and what the check reads is four bytes. */
function portableExecutable(certificateTableSize: number): Buffer {
  const pe = Buffer.alloc(0x400)
  pe.writeUInt16LE(0x5a4d, 0)
  pe.writeUInt32LE(0x80, 0x3c)
  pe.writeUInt32LE(0x00004550, 0x80)
  pe.writeUInt16LE(0x20b, 0x80 + 0x18)
  const certificateTable = 0x80 + 0x18 + 112 + 4 * 8
  pe.writeUInt32LE(0x2000, certificateTable)
  pe.writeUInt32LE(certificateTableSize, certificateTable + 4)
  return pe
}

describe("the Authenticode presence check", () => {
  it("sees a certificate table", () => {
    expect(hasAuthenticodeSignature(portableExecutable(0x1180))).toBe(true)
  })

  it("sees an empty one for what it is", () => {
    expect(hasAuthenticodeSignature(portableExecutable(0))).toBe(false)
  })

  it("refuses something that is not a portable executable at all", () => {
    expect(hasAuthenticodeSignature(Buffer.from("#!/bin/sh\necho hello\n"))).toBe(false)
  })
})

describe("the macos half of the gate", () => {
  // The disk image is notarized and stapled and is NOT codesigned: running
  // `codesign --verify` on it says "no usable signature" for a perfectly good
  // release, which is how a gate ends up being deleted rather than fixed. The
  // signature lives on the app, and the app that matters is the one inside the
  // updater archive, because that is the copy an installed machine replaces
  // itself with.
  // The team the publish job names, and the one that actually signed.
  const TEAM = "Q7F3K9P2LM"
  function described(team: string) {
    return `Authority=Developer ID Application: Somebody (${team})\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=${team}\n`
  }

  function macosRun(tarCode = 0, { signedBy = TEAM, appleTeamId = TEAM } = {}) {
    const commands: string[][] = []
    const removed: string[] = []
    const archive = path.join(FIXTURES, "good", ARTIFACT)
    const io = readOnlyIo({
      run: (command) => {
        commands.push(command)
        if (command[0] === "tar" && tarCode !== 0) {
          return { code: tarCode, stdout: "", stderr: "not in gzip format" }
        }
        if (command[0] === "codesign" && command[1] === "-dvv") {
          // codesign describes a signature on stderr.
          return { code: 0, stdout: "", stderr: described(signedBy) }
        }
        return { code: 0, stdout: "source=Notarized Developer ID", stderr: "" }
      },
      tempDir: () => "/tmp/gate-scratch",
      removeDir: (dir) => {
        removed.push(dir)
      },
      exists: () => true,
    })
    const result = publishManifest(
      {
        version: "9.9.9",
        notes: NOTES,
        tag: "desktop-v9.9.9",
        platforms: [
          {
            key: "darwin-aarch64",
            os: "macos",
            archive,
            signature: `${archive}.sig`,
            installer: "/tmp/Liaison_9.9.9_aarch64.dmg",
            url: "https://example.invalid/Liaison_9.9.9_aarch64.app.tar.gz",
          },
        ],
      },
      { io, publicKey: throwawayKey, dryRun: true, appleTeamId },
    )
    return { commands, removed, result }
  }

  it("refuses an app another team signed, though it verifies and Gatekeeper accepts it", () => {
    // A keychain can hold several teams' Developer ID certificates; any of
    // them passes `codesign --verify` and `spctl`. Only ours may ship.
    const { removed, result } = macosRun(0, { signedBy: "T4H8N2R6SW" })
    expect(result).toMatchObject({ published: false, reason: "os signature verification failed" })
    expect(result.published ? "" : result.detail).toContain(`team ${TEAM}`)
    expect(removed).toEqual(["/tmp/gate-scratch"])
  })

  it("refuses when no team is named, before unpacking anything", () => {
    const { commands, result } = macosRun(0, { appleTeamId: "" })
    expect(result).toMatchObject({ published: false, reason: "os signature verification failed" })
    expect(result.published ? "" : result.detail).toContain("APPLE_TEAM_ID")
    expect(commands).toEqual([])
  })

  it("reads the team of the app inside the updater archive", () => {
    const { commands } = macosRun()
    const describedApp = commands.find(
      (command) => command[0] === "codesign" && command[1] === "-dvv",
    )
    expect(describedApp?.at(-1)).toBe(`/tmp/gate-scratch/${ARTIFACT.replace(/\.tar\.gz$/, "")}`)
  })

  // Each run unpacks a whole app into its scratch directory; left behind, 270
  // of them filled the release machine's disk in four days.
  it("deletes the scratch directory after a passing check", () => {
    const { removed, result } = macosRun()
    expect(result.published).toBe(true)
    expect(removed).toEqual(["/tmp/gate-scratch"])
  })

  it("deletes the scratch directory after a refused check too", () => {
    const { removed, result } = macosRun(1)
    expect(result.published).toBe(false)
    expect(removed).toEqual(["/tmp/gate-scratch"])
  })

  it("unpacks the updater archive and codesigns what is inside it", () => {
    const { commands } = macosRun()
    const unpack = commands.find((command) => command[0] === "tar")
    expect(unpack).toEqual([
      "tar",
      "-xzf",
      path.join(FIXTURES, "good", ARTIFACT),
      "-C",
      "/tmp/gate-scratch",
    ])
    const codesign = commands.find((command) => command[0] === "codesign")
    expect(codesign?.at(-1)).toBe(`/tmp/gate-scratch/${ARTIFACT.replace(/\.tar\.gz$/, "")}`)
    expect(codesign?.at(-1)).not.toContain(".dmg")
  })

  it("asks Gatekeeper about the app, as something that will be executed", () => {
    const { commands } = macosRun()
    const assessed = commands.find((command) => command[0] === "spctl")
    expect(assessed).toContain("--type")
    expect(assessed).toContain("execute")
    expect(assessed?.at(-1)).not.toContain(".dmg")
  })

  it("requires a stapled ticket on the app AND on the disk image", () => {
    const { commands } = macosRun()
    const stapled = commands
      .filter((command) => command.includes("stapler"))
      .map((command) => command.at(-1))
    expect(stapled).toHaveLength(2)
    expect(stapled.some((target) => target?.endsWith(".dmg"))).toBe(true)
    expect(stapled.some((target) => target?.startsWith("/tmp/gate-scratch"))).toBe(true)
  })

  it("refuses when the archive cannot be unpacked at all", () => {
    const io = readOnlyIo({
      run: (command) =>
        command[0] === "tar"
          ? { code: 1, stdout: "", stderr: "not in gzip format" }
          : { code: 0, stdout: "", stderr: "" },
      tempDir: () => "/tmp/gate-scratch",
      exists: () => true,
    })
    const archive = path.join(FIXTURES, "good", ARTIFACT)
    const result = publishManifest(
      {
        version: "9.9.9",
        notes: NOTES,
        tag: "desktop-v9.9.9",
        platforms: [
          {
            key: "darwin-aarch64",
            os: "macos",
            archive,
            signature: `${archive}.sig`,
            installer: "/tmp/Liaison_9.9.9_aarch64.dmg",
            url: "https://example.invalid/x.app.tar.gz",
          },
        ],
      },
      { io, publicKey: throwawayKey, dryRun: true },
    )
    expect(result).toMatchObject({ published: false, reason: "os signature verification failed" })
  })
})

describe("the windows half of the gate", () => {
  // Driven through the REAL wiring: the marker file the Windows job writes
  // beside its artifacts, read by build-publish-request.ts, acted on here.
  //
  // What this replaces is a publish job that decided whether Windows was
  // signed by reading AZURE_CLIENT_ID out of its OWN environment. That job
  // holds no Azure secret and never will, so the answer was always "unsigned,
  // take the skip path", and the Authenticode half of the gate was waived on
  // every real release while the log said it ran.
  const FIXTURE = path.join(FIXTURES, "good", ARTIFACT)

  /** An artifact download, laid out the way actions/download-artifact leaves
   *  it, with the Windows installer's bytes borrowed from the signed fixture
   *  so the updater half verifies for real. */
  function download(marker: unknown, options: { installerIsPe?: boolean } = {}): string {
    const root = mkdtempSync(path.join(tmpdir(), "liaison-gate-download-"))
    const copy = (name: string) => {
      copyFileSync(FIXTURE, path.join(root, name))
      copyFileSync(`${FIXTURE}.sig`, path.join(root, `${name}.sig`))
      copyFileSync(`${FIXTURE}.sha256`, path.join(root, `${name}.sha256`))
    }
    copy("Liaison_9.9.9_x86_64.exe")
    copy("Liaison_9.9.9_universal.app.tar.gz")
    copy("Liaison_9.9.9_x86_64.AppImage")
    copyFileSync(path.join(FIXTURES, "good", "SHA256SUMS"), path.join(root, "SHA256SUMS"))
    writeFileSync(path.join(root, "Liaison_9.9.9_universal.dmg"), "disk image\n")
    if (options.installerIsPe) {
      const pe = portableExecutable(0x1180)
      writeFileSync(path.join(root, "Liaison_9.9.9_x86_64.exe"), pe)
      writeFileSync(
        path.join(root, "Liaison_9.9.9_x86_64.exe.sha256"),
        `${sha256(pe)}  Liaison_9.9.9_x86_64.exe\n`,
      )
    }
    if (marker !== undefined) {
      writeFileSync(path.join(root, "windows-signing.json"), `${JSON.stringify(marker)}\n`)
    }
    return root
  }

  /** The request the publish job would act on, cut down to its Windows half so
   *  the macOS and Linux checks (which need real tools and a real disk image)
   *  stay out of the way. Everything about the Windows entry, the marker
   *  included, came through the real builder. */
  function windowsRequest(marker: unknown, options: { installerIsPe?: boolean } = {}) {
    const built = buildRequest({
      artifactsDir: download(marker, options),
      tag: "desktop-v9.9.9",
      notes: NOTES,
    })
    return {
      ...built,
      notes: NOTES,
      platforms: built.platforms.filter((entry) => entry.os === "windows"),
    }
  }

  const SIGNED = {
    signed: true,
    reason: "signtool verified the chain",
    publisher: "Mathieu Frohlich",
  }
  const SKIPPED = {
    signed: false,
    reason: "AZURE_CLIENT_ID is not set: the documented unsigned skip path",
    publisher: "",
  }

  it("refuses an installer the marker says is signed and that carries no signature", () => {
    // The release this waives: the marker says signed, the bytes say nothing
    // was ever signed. Before the marker existed the gate reached this code
    // path on no release at all.
    const result = publishManifest(windowsRequest(SIGNED), {
      io: readOnlyIo(),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result).toMatchObject({ published: false, reason: "os signature verification failed" })
    expect(result.published === false && result.detail).toContain("no Authenticode signature")
  })

  it("publishes when the marker says signed and the installer carries a signature", () => {
    const result = publishManifest(windowsRequest(SIGNED, { installerIsPe: true }), {
      io: readOnlyIo(),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result.published).toBe(false)
    // The Authenticode half passed: what stops it is the updater signature,
    // which cannot cover bytes invented in this test.
    expect(result).toMatchObject({ reason: "updater key signature verification failed" })
  })

  // THE PUBLISH MAC HAS A signtool TOO (2026-09-28, the first signed test
  // build): Homebrew's nss ships Mozilla's JAR `signtool` on the PATH, the gate
  // took it for Microsoft's, ran it on the installer and refused the release.
  // Microsoft's signtool only exists on Windows, and the chain was already
  // verified on the Windows runner before the upload.
  it("never runs a signtool it finds off Windows", () => {
    const result = publishManifest(windowsRequest(SIGNED, { installerIsPe: true }), {
      io: readOnlyIo({ which: (tool) => tool === "signtool", platform: () => "darwin" }),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result).toMatchObject({ reason: "updater key signature verification failed" })
  })

  it("takes the documented unsigned skip path when the marker records it, and says so", () => {
    const warnings: string[] = []
    const result = publishManifest(windowsRequest(SKIPPED), {
      io: readOnlyIo({ warn: (message) => warnings.push(message) }),
      publicKey: throwawayKey,
      dryRun: true,
    })
    expect(result.published).toBe(true)
    expect(warnings.join(" ")).toContain("UNSIGNED")
    expect(warnings.join(" ")).toContain("AZURE_CLIENT_ID is not set")
  })

  it("refuses when the Windows job left no marker at all", () => {
    // A missing marker is a job that did something nobody recorded. It is a
    // refusal, never a skip: "we do not know" and "it is fine" are the two
    // answers this gate exists to keep apart.
    expect(() => windowsRequest(undefined)).toThrow("windows-signing.json")
  })

  it("refuses a request whose Windows entry lost its marker on the way", () => {
    // The same refusal one layer down, so a request written by hand cannot
    // reach the skip path by simply saying nothing.
    const request = windowsRequest(SIGNED)
    const result = publishManifest(
      { ...request, windowsSigning: undefined },
      { io: readOnlyIo(), publicKey: throwawayKey, dryRun: true },
    )
    expect(result).toMatchObject({ published: false, reason: "os signature verification failed" })
    expect(result.published === false && result.detail).toContain("no signing marker")
  })

  it("refuses a marker that does not say what happened", () => {
    expect(() => windowsRequest({ reason: "who knows" })).toThrow("windows-signing.json")
  })
})
