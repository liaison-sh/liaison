// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  firstMatchContext,
  type PrefixHit,
  scanFiles,
  subtractHits,
} from "./check-no-absolute-paths"

const SCRIPT = path.join(import.meta.dir, "check-no-absolute-paths.ts")
const dir = mkdtempSync(path.join(tmpdir(), "sidecar-abs-paths-"))

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function fixture(name: string, contents: string): string {
  const file = path.join(dir, name)
  writeFileSync(file, contents)
  return file
}

function run(file: string, buildRoot?: string) {
  return Bun.spawnSync(["bun", SCRIPT, file], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...(buildRoot ? { BUILD_ROOT_PREFIX: buildRoot } : {}) },
  })
}

describe("check-no-absolute-paths", () => {
  it("exits 1 when the binary contains the build root prefix", () => {
    const file = fixture("dirty.bin", "harmless /Volumes/ci-build/checkout/app tail")
    const result = run(file, "/Volumes/ci-build")
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("/Volumes/ci-build")
  })

  it("exits 0 when the binary contains no build root prefix", () => {
    expect(run(fixture("clean.bin", "no host paths here")).exitCode).toBe(0)
  })

  it("honours a build root prefix given by the environment", () => {
    const file = fixture("runner.bin", "built at /builds/fabrikam/liaison")
    expect(run(file).exitCode).toBe(0)
    expect(run(file, "/builds/fabrikam").exitCode).toBe(1)
  })

  it("refuses the checkout it is running from with no prefix configured", () => {
    // The default is derived at runtime, not a volume name committed in the
    // source: that one is correct on exactly one machine.
    const repoRoot = path.resolve(import.meta.dir, "..", "..", "..")
    const file = fixture("checkout.bin", `built at ${repoRoot}/apps/desktop/sidecar`)
    expect(run(file).exitCode).toBe(1)
  })

  it("refuses a path written as UTF-16, which a Windows toolchain does", () => {
    const file = path.join(dir, "utf16.bin")
    writeFileSync(file, Buffer.from("loaded from D:\\a\\liaison\\liaison\\x", "utf16le"))
    expect(run(file, "D:\\a\\liaison\\liaison").exitCode).toBe(1)
  })

  it("refuses a Windows runner path, either slash kind, either case", () => {
    const file = fixture("windows.bin", "panic at d:/A/Liaison/liaison/src\\main.rs")
    expect(run(file, "D:\\a\\liaison\\liaison").exitCode).toBe(1)
  })
})

describe("attribution", () => {
  it("keeps only the references this build added on top of a vendored payload", () => {
    const hits: PrefixHit[] = [
      { name: "HOME", prefix: "/home/runner", count: 5, encodings: ["latin1"] },
      {
        name: "GITHUB_WORKSPACE",
        prefix: "/home/runner/work/liaison",
        count: 2,
        encodings: ["latin1"],
      },
    ]
    const baseline: PrefixHit[] = [
      { name: "HOME", prefix: "/home/runner", count: 5, encodings: ["latin1"] },
    ]
    const residue = subtractHits(hits, baseline)
    expect(residue.map((hit) => hit.name)).toEqual(["GITHUB_WORKSPACE"])
    expect(residue[0]?.count).toBe(2)
  })

  it("keeps the excess when a vendored payload explains only part of the count", () => {
    const hits: PrefixHit[] = [
      { name: "HOME", prefix: "/home/runner", count: 7, encodings: ["latin1"] },
    ]
    const baseline: PrefixHit[] = [
      { name: "HOME", prefix: "/home/runner", count: 6, encodings: ["latin1"] },
    ]
    expect(subtractHits(hits, baseline)[0]?.count).toBe(1)
  })

  it("sums the counts of every vendored payload scanned", () => {
    const one = fixture("vendor-one.bin", "built at /home/runner/work/x and /home/runner/y")
    const two = fixture("vendor-two.bin", "built at /home/runner/z")
    const prefixes = [{ name: "HOME", prefix: "/home/runner" }]
    expect(scanFiles([one, two], prefixes)[0]?.count).toBe(3)
  })
})

describe("failure message", () => {
  it("quotes the bytes around the offending string, not just the prefix", () => {
    const file = fixture(
      "context.bin",
      `padding ${"x".repeat(40)}/home/runner/work/liaison/liaison/apps/desktop/sidecar/entry.ts trailing`,
    )
    const context = firstMatchContext(file, "/home/runner")
    expect(context).toContain("/home/runner/work/liaison/liaison/apps/desktop/sidecar/entry.ts")
    expect(context?.length).toBeLessThanOrEqual(220)
  })

  it("returns nothing when the prefix is absent", () => {
    expect(firstMatchContext(fixture("nocontext.bin", "clean"), "/home/runner")).toBe(null)
  })

  it("names the offending string in the command line output", () => {
    const file = fixture("cli-context.bin", "harmless /Volumes/ci-build/checkout/app tail")
    const result = run(file, "/Volumes/ci-build")
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("/Volumes/ci-build/checkout/app")
  })
})
