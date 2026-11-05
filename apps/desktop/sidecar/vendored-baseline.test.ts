// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The first GitHub hosted run of the release workflow failed here, on both the
// Linux and the macOS runner: the compiled sidecar carries absolute paths that
// start with the runner's HOME, and the path check called them this build's.
// They are not. Two vendored payloads are copied into the output verbatim, and
// both were themselves built on a GitHub runner: the Bun runtime the compile
// appends our bundle to, and the Claude Code CLI embedded as a file asset. On
// a developer machine HOME is nobody's build root and the collision never
// happens, which is why this only ever fires on CI.
//
// So the check is measured against those payloads rather than guessing: a
// reference counts as ours only when the output has MORE of it than the
// payloads brought. These tests pin both halves, that a vendored path is not
// blamed and that a path we bake in ourselves still is.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildOne, hostTarget, vendoredPayloads } from "./build"
import {
  type BuildPrefix,
  buildRootPrefixes,
  scanFile,
  scanFiles,
  subtractHits,
} from "./check-no-absolute-paths"

/** A home directory belonging to whoever built a vendored payload, read out of
 *  the payload itself: hard coding "/home/runner" would pin today's upstream
 *  build layout instead of the behaviour under test. */
function foreignHomeIn(files: string[]): string | null {
  const shape = /(?:\/Users|\/home)\/[A-Za-z0-9._-]+/g
  let first: string | null = null
  for (const file of files) {
    for (const [match] of readFileSync(file).toString("latin1").matchAll(shape)) {
      // A GitHub runner's own home is the one that actually broke the build,
      // so it is preferred when a payload carries it; any other builder's home
      // exercises the same collision and keeps the test honest elsewhere.
      if (match.endsWith("/runner")) return match
      first ??= match
    }
  }
  return first
}

describe("vendored payload attribution", () => {
  it("does not blame this build for a path baked into the Bun runtime or the CLI", () => {
    const target = hostTarget()
    const outfile = buildOne(target)
    const payloads = vendoredPayloads(target)
    expect(payloads.length).toBeGreaterThan(0)

    const home = foreignHomeIn(payloads)
    expect(home).not.toBe(null)
    // Derived exactly as a runner derives it, HOME and nothing else set.
    const prefixes: BuildPrefix[] = buildRootPrefixes({ HOME: home as string }, home as string)
    expect(prefixes).toHaveLength(1)

    // The simulation has to bite, or the assertion below proves nothing.
    const raw = scanFile(outfile, prefixes)
    expect(raw[0]?.count ?? 0).toBeGreaterThan(0)

    expect(subtractHits(raw, scanFiles(payloads, prefixes))).toEqual([])
  }, 900_000)

  it("still refuses a path this build itself baked in", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sidecar-baked-"))
    try {
      const entry = path.join(dir, "entry.ts")
      writeFileSync(
        entry,
        `export const where = ${JSON.stringify(`${dir}/marker`)}\nconsole.log(where)\n`,
      )
      const outfile = path.join(dir, "baked")
      const result = Bun.spawnSync(["bun", "build", "--compile", entry, "--outfile", outfile], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      const prefixes: BuildPrefix[] = [{ name: "temporary build root", prefix: dir }]
      const residue = subtractHits(
        scanFile(outfile, prefixes),
        scanFiles(vendoredPayloads(hostTarget()), prefixes),
      )
      expect(residue[0]?.count ?? 0).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
