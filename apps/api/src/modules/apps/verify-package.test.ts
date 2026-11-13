// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MissingTrustedPublisherError, verifyAppPackage } from "./verify-package"

function validManifest() {
  return JSON.stringify({
    name: "x",
    version: "1.0.0",
    packageFormat: 1,
    license: "MIT",
    scopes: [],
  })
}

/** Build a `.liaisonapp` tarball from a set of staged files. Returns its path. */
function makeTarball(work: string, files: Record<string, string>): string {
  const stage = join(work, `stage-${Math.random().toString(36).slice(2)}`)
  mkdirSync(stage, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const p = join(stage, name)
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, content)
  }
  const tarball = join(work, `pkg-${Math.random().toString(36).slice(2)}.liaisonapp`)
  spawnSync("tar", ["-czf", tarball, "-C", stage, ...Object.keys(files)])
  return tarball
}

function stagingCount(): number {
  return readdirSync(tmpdir()).filter((n) => n.startsWith("liaison-app-")).length
}

describe("verifyAppPackage", () => {
  // A private temp root: staging dirs are counted by name, so another test file or shard
  // creating `liaison-app-*` dirs in the machine-wide tmpdir would change the count.
  let originalTmpdir: string | undefined
  let privateRoot = ""
  beforeEach(() => {
    originalTmpdir = process.env.TMPDIR
    privateRoot = mkdtempSync(join(tmpdir(), "verify-pkg-"))
    process.env.TMPDIR = privateRoot
  })
  afterEach(() => {
    if (originalTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = originalTmpdir
    rmSync(privateRoot, { recursive: true, force: true })
  })

  it("returns sha256 + manifest for a valid tarball when signature check is disabled", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    try {
      const tarball = makeTarball(work, {
        "app.manifest.json": validManifest(),
        "bundle.js": "// noop",
      })
      const result = await verifyAppPackage(tarball, { requireSignature: false })
      try {
        expect(result.manifest.name).toBe("x")
        const expectedSha = createHash("sha256").update(readFileSync(tarball)).digest("hex")
        expect(result.sha256).toBe(expectedSha)
        expect(result.signatureBundle).toBeUndefined()
      } finally {
        rmSync(result.stagingDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("rejects tarball missing required files, cleaning up the staging dir", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    try {
      const before = stagingCount()
      const tarball = makeTarball(work, { "app.manifest.json": "{}" })
      await expect(verifyAppPackage(tarball, { requireSignature: false })).rejects.toThrow(
        /bundle\.js/,
      )
      expect(stagingCount()).toBe(before)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("rejects when requireSignature=true but no detached bundle is provided", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    try {
      const before = stagingCount()
      const tarball = makeTarball(work, {
        "app.manifest.json": validManifest(),
        "bundle.js": "// noop",
      })
      await expect(
        verifyAppPackage(tarball, {
          requireSignature: true,
          cosignIdentityRegex: ".+@example.com",
          // no signatureBundlePath
        }),
      ).rejects.toThrow(/signature/i)
      expect(stagingCount()).toBe(before)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("cleans up the staging dir when the manifest fails to parse", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    try {
      const before = stagingCount()
      const tarball = makeTarball(work, {
        "app.manifest.json": JSON.stringify({ name: "x" }),
        "bundle.js": "// noop",
      })
      await expect(verifyAppPackage(tarball, { requireSignature: false })).rejects.toThrow()
      expect(stagingCount()).toBe(before)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("rejects a package containing a symlink entry (link attack)", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    try {
      const before = stagingCount()
      const stage = join(work, "stage")
      mkdirSync(stage)
      writeFileSync(join(stage, "app.manifest.json"), validManifest())
      writeFileSync(join(stage, "bundle.js"), "// noop")
      // A malicious extra entry symlinked at a host path.
      symlinkSync("/etc/passwd", join(stage, "evil.js"))
      const tarball = join(work, "x.liaisonapp")
      spawnSync("tar", ["-czf", tarball, "-C", stage, "app.manifest.json", "bundle.js", "evil.js"])
      await expect(verifyAppPackage(tarball, { requireSignature: false })).rejects.toThrow(
        /symlink/i,
      )
      expect(stagingCount()).toBe(before)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("rejects a package whose bundle.js is itself a symlink", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    try {
      const stage = join(work, "stage")
      mkdirSync(stage)
      writeFileSync(join(stage, "app.manifest.json"), validManifest())
      // bundle.js shipped as a symlink — existsSync would follow it, lstat won't.
      symlinkSync("/etc/hosts", join(stage, "bundle.js"))
      const tarball = join(work, "x.liaisonapp")
      spawnSync("tar", ["-czf", tarball, "-C", stage, "app.manifest.json", "bundle.js"])
      await expect(verifyAppPackage(tarball, { requireSignature: false })).rejects.toThrow(
        /symlink/i,
      )
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("does not let a traversal entry escape the staging dir", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    const sentinel = join(work, "escaped.txt")
    try {
      const stage = join(work, "stage")
      mkdirSync(stage)
      writeFileSync(join(stage, "app.manifest.json"), validManifest())
      writeFileSync(join(stage, "bundle.js"), "// noop")
      const tarball = join(work, "x.liaisonapp")
      // Craft an entry named `../escaped.txt`; modern tar strips the leading
      // `../` on extraction. Assert nothing landed outside the staging dir.
      const evil = join(work, "escaped-src.txt")
      writeFileSync(evil, "pwned")
      spawnSync("tar", [
        "-czf",
        tarball,
        "-C",
        stage,
        "app.manifest.json",
        "bundle.js",
        "--transform",
        "s,^app.manifest.json,../escaped.txt,",
      ])
      // Either tar refused the entry (verify throws on missing manifest) or it
      // stripped the `../`. In neither case may `escaped.txt` exist beside work.
      await verifyAppPackage(tarball, { requireSignature: false }).catch(() => {})
      expect(existsSync(sentinel)).toBe(false)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("returns the signature bundle when cosign verification succeeds", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    const origPath = process.env.PATH
    try {
      // Stub `cosign` on PATH with a script that always exits 0 — exercises the
      // success branch (verify.status === 0) without a real keyless signature.
      const binDir = join(work, "bin")
      mkdirSync(binDir)
      const fakeCosign = join(binDir, "cosign")
      writeFileSync(fakeCosign, "#!/bin/sh\nexit 0\n")
      chmodSync(fakeCosign, 0o755)
      process.env.PATH = `${binDir}:${origPath ?? ""}`

      const tarball = makeTarball(work, {
        "app.manifest.json": validManifest(),
        "bundle.js": "// noop",
      })
      const sigPath = `${tarball}.cosign.bundle`
      writeFileSync(sigPath, '{"fake":"bundle"}')
      const result = await verifyAppPackage(tarball, {
        requireSignature: true,
        cosignIdentityRegex: ".+@example\\.com",
        signatureBundlePath: sigPath,
      })
      try {
        expect(result.signatureBundle).toBe('{"fake":"bundle"}')
      } finally {
        rmSync(result.stagingDir, { recursive: true, force: true })
      }
    } finally {
      process.env.PATH = origPath
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("throws an actionable, 400-tagged error (not an opaque one) when signing is required but no trusted publisher is configured", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    try {
      const before = stagingCount()
      const tarball = makeTarball(work, {
        "app.manifest.json": validManifest(),
        "bundle.js": "// noop",
      })
      // A detached bundle exists, so verification runs — but the operator left
      // cosignIdentityRegex unset (LIAISON_TRUSTED_APP_PUBLISHERS empty). This is
      // the operator-trap: it must surface a typed, actionable error that names
      // the env var, with a 4xx status so the API layer never emits a 500.
      const sigPath = `${tarball}.cosign.bundle`
      writeFileSync(sigPath, "{}")
      let caught: unknown
      try {
        await verifyAppPackage(tarball, {
          requireSignature: true,
          cosignIdentityRegex: undefined,
          signatureBundlePath: sigPath,
        })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(MissingTrustedPublisherError)
      const err = caught as MissingTrustedPublisherError
      expect(err.status).toBe(400)
      expect(err.code).toBe("APP_SIGNATURE_PUBLISHER_UNCONFIGURED")
      expect(err.message).toMatch(/LIAISON_TRUSTED_APP_PUBLISHERS/)
      expect(err.message).toMatch(/LIAISON_REQUIRE_APP_SIGNATURE=false/)
      // Staging dir still cleaned up on this failure path.
      expect(stagingCount()).toBe(before)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it("rejects a wildcard cosignIdentityRegex when a signature is present", async () => {
    const work = mkdtempSync(join(tmpdir(), "verify-"))
    try {
      const before = stagingCount()
      const tarball = makeTarball(work, {
        "app.manifest.json": validManifest(),
        "bundle.js": "// noop",
      })
      // A detached bundle exists, so verification runs — and must refuse `.*`.
      const sigPath = `${tarball}.cosign.bundle`
      writeFileSync(sigPath, "{}")
      await expect(
        verifyAppPackage(tarball, {
          requireSignature: true,
          cosignIdentityRegex: ".*",
          signatureBundlePath: sigPath,
        }),
      ).rejects.toThrow(/wildcard|explicit/i)
      expect(stagingCount()).toBe(before)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
