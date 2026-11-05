// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A cross compile that quietly fails for a triple this Mac cannot run is
// invisible until the platform's own CI job runs, which is far too late. So
// all four targets are compiled here and each output is checked to exist and
// to be non-empty.
import { describe, expect, it } from "bun:test"
import { readFileSync, statSync, utimesSync } from "node:fs"
import path from "node:path"
import { vendoredAtelier } from "./atelier-bundle"
import { buildAll, hostTarget, outfileFor, TARGETS, writeAtelierEmbed, writeEntry } from "./build"

describe("sidecar cross compile", () => {
  it("names one distinct output per target triple", () => {
    const names = new Set(TARGETS.map((target) => outfileFor(target)))
    expect(names.size).toBe(4)
    expect(outfileFor("bun-windows-x64").endsWith(".exe")).toBe(true)
  })

  it("S38: the entry registers the bundled Atelier, embedding every manifest file with its hash", () => {
    const entry = readFileSync(writeEntry(hostTarget()), "utf8")
    expect(entry).toContain("registerEmbeddedAtelier(ATELIER)")
    const gen = readFileSync(writeAtelierEmbed(), "utf8")
    const embed = vendoredAtelier()
    expect(embed.files.length).toBeGreaterThan(10)
    for (const f of embed.files) {
      const rel = `./atelier/${f.path}`
      expect(gen).toContain(`from ${JSON.stringify(rel)} with { type: "file" }`)
      expect(gen).toContain(`path: ${JSON.stringify(f.path)}`)
      expect(gen).toContain(JSON.stringify(f.sha256))
    }
    expect(gen).toContain(`version: "v0.4.0"`)
    expect(path.basename(writeAtelierEmbed())).toBe("atelier.embed.gen.ts")
  })

  it("W1-D1: regenerating an unchanged embed or entry keeps its mtime, so a slice stamped before the next slice's compile stays fresh", () => {
    const old = new Date("2020-01-01T00:00:00Z")
    for (const file of [writeAtelierEmbed(), writeEntry(hostTarget())]) {
      const before = readFileSync(file, "utf8")
      utimesSync(file, old, old)
      // The universal build's second slice compile regenerates both.
      writeAtelierEmbed()
      writeEntry(hostTarget())
      expect(readFileSync(file, "utf8")).toBe(before)
      expect(statSync(file).mtimeMs).toBe(old.getTime())
    }
  })

  it("produces one non-empty binary per target triple when run with no filter", () => {
    const built = buildAll()
    expect(built).toHaveLength(TARGETS.length)
    for (const file of built) {
      expect(statSync(file).size).toBeGreaterThan(0)
    }
  }, 900_000)
})
