// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The AppImage that dry run 34777230634 built launched perfectly and carried a
// sidecar that died with SIGSEGV (exit 139) the moment it was run out of it.
// linuxdeploy had rewritten its rpath with patchelf, twice, and what the
// AppImage ships is therefore not the binary the build produced: the .deb, the
// DMG and the .exe all carry different bytes for the same file.
//
// So the payload is unpacked, the sidecar is put back byte for byte, and it is
// packed onto the ORIGINAL runtime prefix again. These tests build a real
// AppImage shaped file, run the repack AS A PROGRAM over it and read the
// result back out of squashfs: a packing script asserted by reading its source
// is a packing script nobody ran.
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { appImageRuntimeSize, DEFAULT_SIDECAR_PATH } from "./ci/repack-appimage"
import { loadDesktopReleaseWorkflow, step, stepIndex } from "./ci/workflow"

const SCRIPT = path.join(import.meta.dir, "ci", "repack-appimage.ts")

function have(tool: string): boolean {
  return Bun.spawnSync(["sh", "-c", `command -v ${tool}`]).exitCode === 0
}
const SQUASHFS = have("mksquashfs") && have("unsquashfs")

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

/**
 * The first bytes of an AppImage: an ELF64 header whose section header table
 * ends exactly at the end of the prefix, with the AI\x02 marker in the ELF
 * padding. That arithmetic is what every AppImage tool uses to find the
 * payload, so the fixture has to carry it rather than mimic it.
 */
function fakeRuntime(bytes = 4096): Buffer {
  const runtime = Buffer.alloc(bytes, 0x55)
  runtime.write("\x7fELF", 0, "latin1")
  runtime[4] = 2 // ELFCLASS64
  runtime[5] = 1 // little endian
  runtime.write("AI", 8, "latin1")
  runtime[10] = 2 // type 2, squashfs
  const sectionHeaderSize = 64
  const sectionHeaderCount = 4
  runtime.writeBigUInt64LE(BigInt(bytes - sectionHeaderSize * sectionHeaderCount), 0x28)
  runtime.writeUInt16LE(sectionHeaderSize, 0x3a)
  runtime.writeUInt16LE(sectionHeaderCount, 0x3c)
  return runtime
}

interface Fixture {
  dir: string
  image: string
  pristine: string
  runtime: Buffer
}

/** A whole AppImage: runtime prefix, then a squashfs holding a sidecar with
 *  the WRONG bytes (what patchelf left behind) and a second file that has
 *  nothing to do with any of this and must survive the repack. */
function buildFixture(sidecarContent: string): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "appimage-repack-"))
  const root = path.join(dir, "AppDir")
  mkdirSync(path.join(root, "usr", "bin"), { recursive: true })
  mkdirSync(path.join(root, "usr", "lib"), { recursive: true })
  writeFileSync(path.join(root, DEFAULT_SIDECAR_PATH), sidecarContent)
  chmodSync(path.join(root, DEFAULT_SIDECAR_PATH), 0o755)
  writeFileSync(path.join(root, "usr", "lib", "libgtk-3.so.0"), "the deployed gtk stack")
  writeFileSync(path.join(root, "AppRun"), "#!/bin/sh\nexec usr/bin/liaison-desktop\n")
  chmodSync(path.join(root, "AppRun"), 0o755)

  const filesystem = path.join(dir, "payload.squashfs")
  const packed = Bun.spawnSync([
    "mksquashfs",
    root,
    filesystem,
    "-noappend",
    "-no-progress",
    "-all-root",
    "-no-xattrs",
    "-comp",
    "gzip",
    "-b",
    "128K",
  ])
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString())

  const runtime = fakeRuntime()
  const image = path.join(dir, "Liaison_0.1.0_x86_64.AppImage")
  writeFileSync(image, Buffer.concat([runtime, readFileSync(filesystem)]))
  chmodSync(image, 0o755)

  const pristine = path.join(dir, "liaison-sidecar-x86_64-unknown-linux-gnu")
  writeFileSync(pristine, "the bytes bun --compile produced")
  chmodSync(pristine, 0o755)
  return { dir, image, pristine, runtime }
}

function repack(fixture: Fixture, extra: string[] = []) {
  return Bun.spawnSync(["bun", SCRIPT, fixture.image, "--sidecar", fixture.pristine, ...extra])
}

/** The one file, read back out of the image the way the workflow's verify step
 *  reads it: through squashfs, not out of the directory it was packed from. */
function memberFromImage(image: string, member: string): string {
  const into = mkdtempSync(path.join(tmpdir(), "appimage-read-"))
  rmSync(into, { recursive: true, force: true })
  const offset = appImageRuntimeSize(readFileSync(image).subarray(0, 64))
  const result = Bun.spawnSync([
    "unsquashfs",
    "-no-progress",
    "-o",
    String(offset),
    "-d",
    into,
    image,
    member,
  ])
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return readFileSync(path.join(into, member), "utf8")
}

describe("where the squashfs payload starts", () => {
  it("is the end of the ELF section header table", () => {
    // The same arithmetic libappimage does. Computed rather than read back
    // with --appimage-offset, which would need the AppImage's own machine.
    expect(appImageRuntimeSize(fakeRuntime(4096))).toBe(4096)
    expect(appImageRuntimeSize(fakeRuntime(8192))).toBe(8192)
  })

  it("refuses a file that is not an AppImage rather than guessing", () => {
    // Packing a new filesystem onto the wrong prefix produces a plausible
    // looking image that mounts nothing.
    const notElf = Buffer.alloc(64)
    expect(() => appImageRuntimeSize(notElf)).toThrow(/ELF magic/)
    const noMarker = fakeRuntime()
    noMarker.write("XX", 8, "latin1")
    expect(() => appImageRuntimeSize(noMarker)).toThrow(/AI magic/)
    const type1 = fakeRuntime()
    type1[10] = 1
    expect(() => appImageRuntimeSize(type1)).toThrow(/type 2/)
  })
})

describe.skipIf(!SQUASHFS)("the AppImage repack, run as a program", () => {
  it("puts the pristine sidecar back, byte for byte", () => {
    const fixture = buildFixture("what patchelf left behind, which segfaults")
    try {
      expect(memberFromImage(fixture.image, DEFAULT_SIDECAR_PATH)).not.toBe(
        readFileSync(fixture.pristine, "utf8"),
      )
      const result = repack(fixture)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain("repacked")
      // Read out of the image, not out of the directory it was packed from.
      expect(memberFromImage(fixture.image, DEFAULT_SIDECAR_PATH)).toBe(
        readFileSync(fixture.pristine, "utf8"),
      )
      expect(result.stdout.toString()).toContain(sha256(fixture.pristine))
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it("keeps the runtime prefix the bundler produced, byte for byte", () => {
    // The runtime carries everything appimagetool embedded: the desktop
    // integration behaviour and any update information. Rebuilding it would
    // download a different one and change what the AppImage does.
    const fixture = buildFixture("patched")
    try {
      expect(repack(fixture).exitCode).toBe(0)
      const rebuilt = readFileSync(fixture.image).subarray(0, fixture.runtime.length)
      expect(Buffer.compare(rebuilt, fixture.runtime)).toBe(0)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it("leaves everything else in the payload alone", () => {
    const fixture = buildFixture("patched")
    try {
      expect(repack(fixture).exitCode).toBe(0)
      expect(memberFromImage(fixture.image, "usr/lib/libgtk-3.so.0")).toBe("the deployed gtk stack")
      expect(memberFromImage(fixture.image, "AppRun")).toContain("liaison-desktop")
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it("keeps the image executable, which is the whole point of an AppImage", () => {
    const fixture = buildFixture("patched")
    try {
      expect(repack(fixture).exitCode).toBe(0)
      // eslint-disable-next-line no-bitwise
      expect(statSync(fixture.image).mode & 0o111).toBeGreaterThan(0)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it("does nothing when the image already carries the pristine sidecar", () => {
    // The day linuxdeploy stops rewriting it, this is a no-op rather than a
    // rebuild of a file that did not need rebuilding.
    const fixture = buildFixture("the bytes bun --compile produced")
    try {
      const before = sha256(fixture.image)
      const result = repack(fixture)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain("nothing repacked")
      expect(sha256(fixture.image)).toBe(before)
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it("refuses when there is no build output to compare with", () => {
    // Without the pristine file nothing can be asserted about what ships, and
    // an unverified AppImage must not be the one that gets signed.
    const fixture = buildFixture("patched")
    try {
      const result = Bun.spawnSync([
        "bun",
        SCRIPT,
        fixture.image,
        "--sidecar",
        path.join(fixture.dir, "not-there"),
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain("no pristine sidecar")
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it("refuses an image that carries no sidecar at all", () => {
    const fixture = buildFixture("patched")
    try {
      const result = repack(fixture, ["--sidecar-path", "usr/bin/not-a-sidecar"])
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain("carries no usr/bin/not-a-sidecar")
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it("refuses a file that is not an AppImage instead of writing one", () => {
    const fixture = buildFixture("patched")
    try {
      writeFileSync(fixture.image, "not an ELF at all, just some bytes")
      const result = repack(fixture)
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain("not an AppImage")
      expect(readFileSync(fixture.image, "utf8")).toBe("not an ELF at all, just some bytes")
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true })
    }
  })
})

describe("the repack's place in the Linux job", () => {
  const steps = loadDesktopReleaseWorkflow().jobs["build-linux"].steps
  const REPACK = "Repack the AppImage around the pristine sidecar"
  const VERIFY = "Verify the sidecar inside the AppImage still runs"
  const SIGN = "Sign the updater archive"
  const COVERS = "Verify the updater signature covers the shipped AppImage"

  it("repacks after the bundler built the AppImage and before anything reads it", () => {
    expect(step(steps, REPACK).run).toContain("repack-appimage.ts")
    expect(stepIndex(steps, REPACK)).toBeGreaterThan(stepIndex(steps, "Build the app bundle"))
    expect(stepIndex(steps, REPACK)).toBeLessThan(
      stepIndex(steps, "Verify no absolute paths in the bundle"),
    )
    expect(stepIndex(steps, REPACK)).toBeLessThan(stepIndex(steps, "Checksum the Linux packages"))
  })

  it("compares against the sidecar the build produced, not against a copy", () => {
    expect(step(steps, REPACK).run).toContain("apps/desktop/src-tauri/binaries/liaison-sidecar-")
  })

  it("throws away the bundler's own signature, which covers the pre-repack bytes", () => {
    // Its name matches the upload glob, so leaving it there uploads a second
    // signature over a file nobody has.
    expect(step(steps, REPACK).run).toContain(".sig")
    expect(step(steps, REPACK).run).toContain("rm -f")
  })

  it("asserts the shipped sidecar is the build output, by sha256", () => {
    const run = step(steps, VERIFY).run ?? ""
    expect(run).toContain("sha256sum")
    expect(run).toContain("does not carry the sidecar this build produced")
    expect(stepIndex(steps, VERIFY)).toBeGreaterThan(stepIndex(steps, REPACK))
  })

  it("signs AFTER the repack, and verifies the signature over the shipped bytes", () => {
    // The AppImage is the one artifact here whose bytes change after the
    // bundler signed them. A signature made before the repack is well formed
    // and covers a file nobody has, and the only place that surfaces is an
    // installed copy refusing its own update.
    expect(stepIndex(steps, SIGN)).toBeGreaterThan(stepIndex(steps, REPACK))
    expect(stepIndex(steps, COVERS)).toBeGreaterThan(stepIndex(steps, SIGN))
    expect(step(steps, COVERS).run).toContain("verify-updater-signature.ts")
  })

  it("signs on a dry run too, which is the only run that ever executes this", () => {
    // A signing step that only runs on a tagged release is a step first
    // executed by the release it could break.
    expect(step(steps, SIGN).if).toBeUndefined()
    expect(step(steps, COVERS).if).toBeUndefined()
    // And a dry run signs with the throwaway key from the environment file: a
    // step level TAURI_SIGNING_* value would win over it. The release key
    // arrives under other names and is exported only on a release.
    for (const key of Object.keys(step(steps, SIGN).env ?? {})) {
      expect(key.startsWith("TAURI_SIGNING"), key).toBe(false)
    }
  })

  it("installs the tools the repack needs on the runner", () => {
    expect(step(steps, "Install the Linux build prerequisites").run).toContain("squashfs-tools")
  })
})

describe("the updater signature check the repack makes necessary", () => {
  // Run as a program against the recorded fixtures, which are four states of
  // one release: the whole point is that a signature over the PRE repack bytes
  // is well formed and must still be refused.
  const FIXTURES = path.join(import.meta.dir, "ci", "fixtures", "updater")
  const CHECK = path.join(import.meta.dir, "ci", "verify-updater-signature.ts")
  const ARTIFACT = "Liaison_9.9.9_x86_64.AppImage"

  function check(state: string, key: string) {
    return Bun.spawnSync([
      "bun",
      CHECK,
      path.join(FIXTURES, state, ARTIFACT),
      "--pubkey-file",
      path.join(FIXTURES, key),
    ])
  }

  it("accepts a signature that covers these exact bytes", () => {
    const result = check("good", "throwaway.pub")
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("verifies over")
  })

  it("refuses a signature made over different bytes, which is the repack case", () => {
    const result = check("tampered-artifact", "throwaway.pub")
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("does not match these bytes")
  })

  it("refuses a signature from a key this build does not trust", () => {
    const result = check("wrong-key", "throwaway.pub")
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("this build trusts")
  })

  it("refuses an artifact with no signature beside it rather than passing it", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "unsigned-"))
    try {
      const artifact = path.join(dir, ARTIFACT)
      writeFileSync(artifact, "no signature was ever made for this")
      const result = Bun.spawnSync([
        "bun",
        CHECK,
        artifact,
        "--pubkey-file",
        path.join(FIXTURES, "throwaway.pub"),
      ])
      expect(result.exitCode).toBe(1)
      expect(result.stderr.toString()).toContain("no updater signature beside")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("trusts the key compiled into the build when no key is named", () => {
    // A release verifies against plugins.updater.pubkey, which is the key an
    // installed copy checks with. The fixtures were signed by throwaway keys,
    // so this asserts WHICH key is used rather than a passing verification.
    const result = Bun.spawnSync(["bun", CHECK, path.join(FIXTURES, "good", ARTIFACT)])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("this build trusts")
  })
})

describe("the repack tools", () => {
  it("is skipped here only when squashfs-tools is absent, and says so", () => {
    // A skip nobody can see is a test that stopped existing. The Linux job
    // installs squashfs-tools as a prerequisite, so it never skips there.
    if (!SQUASHFS) {
      console.warn(
        "appimage-repack: mksquashfs or unsquashfs is not installed here, the packing tests did not run (brew install squashfs)",
      )
    }
    expect(existsSync(SCRIPT)).toBe(true)
  })
})
