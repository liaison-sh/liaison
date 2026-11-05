// SPDX-License-Identifier: FSL-1.1-ALv2
// Package size limits and the anchored cosign identity.
import { afterEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import {
  anchorIdentityRegex,
  assertTarballWithinLimits,
  isMatchAllIdentityRegex,
  MAX_PACKAGE_ENTRIES,
  MAX_PACKAGE_EXPANDED_BYTES,
  verifyAppPackage,
} from "~/modules/apps/verify-package"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function work(): string {
  const d = mkdtempSync(join(tmpdir(), "vp-limits-"))
  dirs.push(d)
  return d
}

/** A single 512-byte ustar header followed by `size` bytes padded to a block. */
function tarEntry(name: string, size: number, type = "0"): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, "utf8")
  h.write("0000644\0", 100)
  h.write(`${size.toString(8).padStart(11, "0")}\0`, 124)
  h.write(type, 156)
  h.write("ustar\0", 257)
  return Buffer.concat([h, Buffer.alloc(Math.ceil(size / 512) * 512)])
}
function writeTgz(entries: Buffer[]): string {
  const p = join(work(), "x.liaisonapp")
  writeFileSync(p, gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)])))
  return p
}

describe("assertTarballWithinLimits", () => {
  it("accepts a normal package", () => {
    const d = work()
    mkdirSync(join(d, "s"))
    writeFileSync(join(d, "s", "a.txt"), "hi")
    const tar = join(d, "p.liaisonapp")
    spawnSync("tar", ["-czf", tar, "-C", join(d, "s"), "a.txt"])
    expect(() => assertTarballWithinLimits(tar)).not.toThrow()
  })

  it("refuses a decompression bomb before anything is extracted", () => {
    // Zeros compress ~1000:1, so a small file expands past the cap.
    const bomb = writeTgz([tarEntry("big.bin", MAX_PACKAGE_EXPANDED_BYTES + 1024)])
    expect(() => assertTarballWithinLimits(bomb)).toThrow(/expands beyond|too large/)
  })

  it("refuses too many entries", () => {
    const entries = Array.from({ length: MAX_PACKAGE_ENTRIES + 1 }, (_, i) => tarEntry(`f${i}`, 0))
    expect(() => assertTarballWithinLimits(writeTgz(entries))).toThrow(/too many entries/)
  })

  it("refuses path escapes and non-regular entries", () => {
    expect(() => assertTarballWithinLimits(writeTgz([tarEntry("../evil", 0)]))).toThrow(/escapes/)
    expect(() => assertTarballWithinLimits(writeTgz([tarEntry("/abs", 0)]))).toThrow(/escapes/)
    // A link entry is named for what it is (symlink "2", hard link "1"); any other
    // non-regular entry (a character device, "3") is refused generically.
    expect(() => assertTarballWithinLimits(writeTgz([tarEntry("link", 0, "2")]))).toThrow(
      /'link' is a symlink/,
    )
    expect(() => assertTarballWithinLimits(writeTgz([tarEntry("hard", 0, "1")]))).toThrow(
      /'hard' is a hard link/,
    )
    expect(() => assertTarballWithinLimits(writeTgz([tarEntry("dev", 0, "3")]))).toThrow(
      /not a regular file/,
    )
  })

  it("is enforced by verifyAppPackage", async () => {
    const entries = Array.from({ length: MAX_PACKAGE_ENTRIES + 1 }, (_, i) => tarEntry(`f${i}`, 0))
    await expect(verifyAppPackage(writeTgz(entries), { requireSignature: false })).rejects.toThrow(
      /too many entries/,
    )
  })
})

describe("cosign identity regex", () => {
  it("anchors the operator value so it must match the whole identity", () => {
    const anchored = new RegExp(anchorIdentityRegex("https://github\\.com/acme/.*"))
    expect(anchored.test("https://github.com/acme/app/.github/workflows/r.yml@refs/tags/v1")).toBe(
      true,
    )
    expect(anchored.test("https://evil.example/?u=https://github.com/acme/x")).toBe(false)
    expect(anchorIdentityRegex("a|b")).toBe("^(?:a|b)$")
    expect(new RegExp(anchorIdentityRegex("a|b")).test("xa")).toBe(false)
  })

  it("recognises match-everything spellings", () => {
    for (const r of [".*", "^.*$", "(.*)", "^(?:.*)$", ".+", ""]) {
      expect(isMatchAllIdentityRegex(r)).toBe(true)
    }
    expect(isMatchAllIdentityRegex("https://github\\.com/acme/.*")).toBe(false)
  })

  it("passes cosign the anchored regex", async () => {
    const d = work()
    const bin = join(d, "bin")
    mkdirSync(bin)
    const argsFile = join(d, "args.txt")
    writeFileSync(join(bin, "cosign"), `#!/bin/sh\necho "$@" > ${argsFile}\nexit 0\n`, {
      mode: 0o755,
    })
    mkdirSync(join(d, "s"))
    writeFileSync(
      join(d, "s", "app.manifest.json"),
      JSON.stringify({
        name: "vp-app",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: [],
      }),
    )
    writeFileSync(join(d, "s", "bundle.js"), "//")
    const tar = join(d, "p.liaisonapp")
    spawnSync("tar", ["-czf", tar, "-C", join(d, "s"), "app.manifest.json", "bundle.js"])
    writeFileSync(`${tar}.cosign.bundle`, "{}")
    const origPath = process.env.PATH
    process.env.PATH = `${bin}:${origPath}`
    try {
      const v = await verifyAppPackage(tar, {
        requireSignature: true,
        signatureBundlePath: `${tar}.cosign.bundle`,
        cosignIdentityRegex: "https://github\\.com/acme/.*",
      })
      rmSync(v.stagingDir, { recursive: true, force: true })
    } finally {
      process.env.PATH = origPath
    }
    const args = require("node:fs").readFileSync(argsFile, "utf8") as string
    expect(args).toContain("^(?:https://github\\.com/acme/.*)$")
  })
})
