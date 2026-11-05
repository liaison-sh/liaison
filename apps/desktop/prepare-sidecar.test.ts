// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The universal macOS sidecar: both slices in one file, each with its own
// Claude Code CLI. A slice without its CLI is an app that installs on that Mac
// and cannot run a single turn.
import { afterAll, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  externalBinPathFor,
  prepareSidecar,
  sidecarInputs,
  sidecarSourceHash,
  stampPathFor,
  UNIVERSAL_MACOS,
  universalUnshippableReason,
} from "./prepare-sidecar"
import { platformCliPackage } from "./sidecar/build"

describe("the universal sidecar", () => {
  it("refuses to build when a slice has no CLI to embed, and says how to get it", () => {
    const reason = universalUnshippableReason((target) =>
      target === "bun-darwin-x64" ? null : "installed",
    )
    expect(reason).toContain("bun-darwin-x64")
    expect(reason).not.toContain("bun-darwin-arm64")
    expect(reason).toContain("--cpu='*'")
    expect(universalUnshippableReason(() => "installed")).toBeNull()
  })

  const canBuild =
    process.platform === "darwin" &&
    platformCliPackage("bun-darwin-arm64") !== null &&
    platformCliPackage("bun-darwin-x64") !== null

  it.skipIf(!canBuild)(
    "installs the thin slices and lipos them into the universal one",
    () => {
      const universal = prepareSidecar({ target: UNIVERSAL_MACOS })
      expect(universal).toBe(externalBinPathFor(UNIVERSAL_MACOS))
      // Tauri's build script checks the thin names once per cargo build.
      expect(existsSync(externalBinPathFor("aarch64-apple-darwin"))).toBe(true)
      expect(existsSync(externalBinPathFor("x86_64-apple-darwin"))).toBe(true)
      const archs = Bun.spawnSync(["lipo", "-archs", universal])
        .stdout.toString()
        .trim()
        .split(/\s+/)
      expect(archs.sort()).toEqual(["arm64", "x86_64"])
    },
    600_000,
  )
})

// A STALE SIDECAR IS NEVER REUSED (2026-09-23). The script used to answer with
// whatever binary was already on disk: a long lived checkout compiled the
// sidecar once and every later build shipped that one, so a build of main
// carrying the new `auto` permission mode bundled a sidecar that refused
// `--permission-mode auto` and died before its first line.
describe("a stale sidecar is never reused", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "prepare-sidecar-"))
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  /** A prepare against scratch directories, with a compile that records itself. */
  function harness(name: string) {
    const binaries = path.join(scratch, name, "binaries")
    const dist = path.join(scratch, name, "dist")
    let version = "v1"
    const compiled: string[] = []
    const compile = (target: string) => {
      mkdirSync(dist, { recursive: true })
      const outfile = path.join(dist, `liaison-sidecar-${target}`)
      writeFileSync(outfile, `sidecar ${version}`)
      compiled.push(version)
      return outfile
    }
    const prepare = (force = false) =>
      prepareSidecar({
        target: "aarch64-apple-darwin",
        force,
        binaries,
        dist,
        compile,
        hashFor: () => `hash-of-${version}`,
      })
    return {
      prepare,
      compiled,
      setSources: (next: string) => {
        version = next
      },
      destination: path.join(binaries, "liaison-sidecar-aarch64-apple-darwin"),
    }
  }

  it("recompiles and reinstalls when the sources changed since the binary was built", () => {
    const sidecar = harness("changed")
    expect(sidecar.prepare()).toBe(sidecar.destination)
    expect(readFileSync(sidecar.destination, "utf8")).toBe("sidecar v1")
    sidecar.setSources("v2")
    sidecar.prepare()
    expect(sidecar.compiled).toEqual(["v1", "v2"])
    expect(readFileSync(sidecar.destination, "utf8")).toBe("sidecar v2")
  })

  it("keeps a binary whose sources did not change, byte for byte (a signed one stays signed)", () => {
    const sidecar = harness("unchanged")
    sidecar.prepare()
    writeFileSync(sidecar.destination, "sidecar v1, signed")
    sidecar.prepare()
    expect(sidecar.compiled).toEqual(["v1"])
    expect(readFileSync(sidecar.destination, "utf8")).toBe("sidecar v1, signed")
  })

  it("rebuilds a binary that carries no stamp, which is every binary an older script left", () => {
    const sidecar = harness("unstamped")
    mkdirSync(path.dirname(sidecar.destination), { recursive: true })
    writeFileSync(sidecar.destination, "sidecar from 16:48")
    sidecar.prepare()
    expect(sidecar.compiled).toEqual(["v1"])
    expect(readFileSync(sidecar.destination, "utf8")).toBe("sidecar v1")
  })

  it("--force still recompiles a fresh binary", () => {
    const sidecar = harness("forced")
    sidecar.prepare()
    sidecar.prepare(true)
    expect(sidecar.compiled).toEqual(["v1", "v1"])
  })

  it("the stamp lives outside the liaison-sidecar-* names the release globs sign", () => {
    const sidecar = harness("stamp")
    sidecar.prepare()
    const stamp = stampPathFor(sidecar.destination)
    expect(existsSync(stamp)).toBe(true)
    expect(path.basename(path.dirname(stamp))).toBe(".stamps")
    expect(readdirSync(path.dirname(sidecar.destination)).sort()).toEqual([
      ".stamps",
      "liaison-sidecar-aarch64-apple-darwin",
    ])
  })
})

describe("what the sidecar's freshness is measured on", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sidecar-sources-"))
  const sidecar = path.join(root, "sidecar")
  const lockfile = path.join(root, "bun.lock")
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(sidecar, "dist"), { recursive: true })
  writeFileSync(path.join(sidecar, "index.ts"), "export const a = 1\n")
  writeFileSync(path.join(sidecar, "package.json"), '{"name":"x"}\n')
  writeFileSync(path.join(sidecar, "index.test.ts"), "test\n")
  writeFileSync(path.join(sidecar, "dist", "liaison-sidecar-bun-darwin-arm64"), "binary\n")
  writeFileSync(lockfile, "lock 1\n")
  const hash = () => sidecarSourceHash("bun-darwin-arm64", { root: sidecar, lockfile })

  it("changes with a source file, the package manifest and the lockfile", () => {
    const first = hash()
    writeFileSync(path.join(sidecar, "index.ts"), "export const a = 2\n")
    const second = hash()
    expect(second).not.toBe(first)
    writeFileSync(path.join(sidecar, "package.json"), '{"name":"x","v":2}\n')
    const third = hash()
    expect(third).not.toBe(second)
    writeFileSync(lockfile, "lock 2\n")
    expect(hash()).not.toBe(third)
  })

  it("ignores tests and the build's own output", () => {
    const before = hash()
    writeFileSync(path.join(sidecar, "index.test.ts"), "another test\n")
    writeFileSync(path.join(sidecar, "dist", "liaison-sidecar-bun-darwin-arm64"), "rebuilt\n")
    expect(hash()).toBe(before)
    expect(sidecarInputs(sidecar, lockfile).map((file) => path.relative(root, file))).toEqual([
      "bun.lock",
      "sidecar/index.ts",
      "sidecar/package.json",
    ])
  })

  it("differs per target, because each target embeds its own CLI", () => {
    expect(sidecarSourceHash("bun-darwin-x64", { root: sidecar, lockfile })).not.toBe(hash())
  })
})
