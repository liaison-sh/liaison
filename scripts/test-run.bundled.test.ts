// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Bundled-app suite-coverage lint (drift guard).
//
// Bundled-app test files are not auto-discovered: `scripts/test-run.ts` lists
// them by hand, one entry per file, in a `bundled-*` suite per app (plus
// `bundled-freeze` for the three shell-spawning `build-roundtrip.test.ts`
// files). Nothing in the workspace's normal test globs reaches
// `bundled-apps/` at all. That is exactly the shape that let 79+34 test files
// sit on disk, listed by no suite, running in no CI — the same class of bug
// `test-run.suites.test.ts` guards against for `src/tests/integration` and
// `packages/*`. This file is that guard for `bundled-apps/`.
//
// The exemption array below records the debt that exists when this lint is
// introduced. It may only ever SHRINK. Its exact length is asserted, so
// appending to it is a test failure rather than a quiet habit.

import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const SOURCE = readFileSync(path.join(ROOT, "scripts/test-run.ts"), "utf8")

/**
 * Bundled-app test files that no suite listed when this lint was written,
 * grouped by app with the reason class. Reasons are carried over from the
 * comments already on each app's `bundled-*` suite in `scripts/test-run.ts`,
 * which explains what it deliberately excludes and why.
 */
const KNOWN_UNROUTED_BUNDLED = [
  // ads: live-Meta-credential suite (line 29: `describe.skip` gated on
  // `META_TEST_TOKEN`). Genuinely exempt: it needs a real Meta ad account
  // and is meant to be run manually, not in CI. lab/* and metrics/* were
  // previously exempted alongside it on the same "DB-substrate" pretext, but
  // that was false — verified they are mock-driven (createMockDb / stubbed
  // fetch, no Postgres, no Redis) and pass with the database env unset, so
  // they were routed into the bundled-ads suite in scripts/test-run.ts
  // instead of exempted here.
  "ads/src/ads-meta-live.test.ts",
]

/** Split the SUITES object into `{ suiteName: blockText }`. */
function suiteBlocks(source: string = SOURCE): Record<string, string> {
  const start = source.indexOf("const SUITES")
  expect(start).toBeGreaterThan(-1)
  const body = source.slice(start)
  const blocks: Record<string, string> = {}
  const header = /^ {2}"?([a-z0-9-]+)"?: \{$/gm
  const matches = Array.from(body.matchAll(header))
  for (let i = 0; i < matches.length; i++) {
    const from = (matches[i].index ?? 0) + matches[i][0].length
    const to = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length
    blocks[matches[i][1]] = body.slice(from, to)
  }
  return blocks
}

/**
 * The test files a suite block LISTS: the quoted paths of its array literals,
 * with the prose around them removed first.
 *
 * Matching a quoted filename anywhere in the block counted the ones that appear
 * in the COMMENTS beside it, and every suite carries comments explaining which
 * same-named file it deliberately excludes and why: each of those names read as
 * a routing that does not exist. Entries themselves are written both one per
 * line and several to a line, so the entry cannot be recognised by its line
 * either; what separates a listing from prose is the comment, so the comments
 * come out and everything left is code.
 */
function listedEntries(block: string): string[] {
  const code = block
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
  return Array.from(code.matchAll(/"([^"]+\.tsx?)"/g)).map((m) => m[1])
}

/** The directory a suite runs in, repo-relative (`""` for a root-cwd suite). */
function blockCwd(block: string): string {
  const match = block.match(/cwd:\s*(?:ROOT|path\.join\(ROOT,\s*"([^"]+)"\))/)
  return match?.[1] ?? ""
}

/** Every test path a suite routes, as a repo-relative path. */
function routedPaths(block: string): string[] {
  const cwd = blockCwd(block)
  return listedEntries(block).map((entry) => (cwd ? `${cwd}/${entry}` : entry))
}

/**
 * Which suites route each repo-relative path.
 *
 * A LIST, not a flag. Stopping at the first suite that named a file made a file
 * listed TWICE read exactly like a file listed once: the second listing runs the
 * whole file again in another suite, against another cwd, and nothing said so.
 */
function routingsByPath(source: string = SOURCE): Map<string, string[]> {
  const routings = new Map<string, string[]>()
  for (const [name, block] of Object.entries(suiteBlocks(source))) {
    for (const routed of routedPaths(block)) {
      const suites = routings.get(routed)
      if (suites) suites.push(name)
      else routings.set(routed, [name])
    }
  }
  return routings
}

function fullOrder(): string[] {
  const match = SOURCE.match(/const FULL_ORDER = \[([\s\S]*?)\]/)
  expect(match).not.toBeNull()
  return Array.from((match as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)).map((m) => m[1])
}

/** Every bundled-app test file on disk, excluding node_modules, as `<app>/<rel>`. */
function onDiskBundledTests(): string[] {
  const bundledRoot = path.join(ROOT, "bundled-apps")
  const out: string[] = []
  for (const app of readdirSync(bundledRoot, { withFileTypes: true })) {
    if (!app.isDirectory()) continue
    const appDir = path.join(bundledRoot, app.name)
    const stack = [appDir]
    while (stack.length > 0) {
      const current = stack.pop() as string
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
          out.push(`${app.name}/${path.relative(appDir, full)}`)
        }
      }
    }
  }
  return out.sort()
}

describe("test-run.ts suite coverage: bundled-app files", () => {
  const onDisk = onDiskBundledTests()

  it("finds bundled-apps and at least one bundled-* suite block", () => {
    expect(onDisk.length).toBeGreaterThanOrEqual(150)
    expect(suiteBlocks()["bundled-boxtal"]).toBeDefined()
  })

  it("lists every on-disk bundled-app test file in exactly one suite, exemptions aside", () => {
    const routings = routingsByPath()
    const unrouted: string[] = []
    const doubled: string[] = []
    for (const file of onDisk) {
      if (KNOWN_UNROUTED_BUNDLED.includes(file)) continue
      const suites = routings.get(`bundled-apps/${file}`) ?? []
      if (suites.length === 0) unrouted.push(`bundled-apps/${file}`)
      // Twice routed is not twice as safe: the file runs again under another
      // suite's cwd and env, and the second run is the one nobody reads.
      if (suites.length > 1) doubled.push(`bundled-apps/${file}: ${suites.join(", ")}`)
    }
    expect(unrouted).toEqual([])
    expect(doubled).toEqual([])
  })

  // The counting and the entry matching, exercised on a source of this file's
  // own making: the real `scripts/test-run.ts` is (and must stay) free of both
  // faults, so a guard that only ever reads it cannot show it detects either.
  it("counts every listing, and reads a quoted name in a comment as no listing", () => {
    const scratch = [
      "const SUITES = {",
      '  "bundled-alpha": {',
      "    cmd: [",
      '      "bun",',
      "      // Deliberately NOT routed here, see the beta suite:",
      '      // "src/commented.test.ts" needs a shell and spawns its own child.',
      '      "src/one.test.ts",',
      '      "src/both.test.ts",',
      "    ],",
      '    cwd: path.join(ROOT, "bundled-apps/alpha"),',
      "  },",
      '  "bundled-beta": {',
      "    cmd: [",
      '      "bun",',
      '      "src/both.test.ts",',
      "    ],",
      '    cwd: path.join(ROOT, "bundled-apps/alpha"),',
      "  },",
      "}",
    ].join("\n")
    const routings = routingsByPath(scratch)
    expect(routings.get("bundled-apps/alpha/src/one.test.ts")).toEqual(["bundled-alpha"])
    // The double listing is SEEN, rather than stopping at the first suite.
    expect(routings.get("bundled-apps/alpha/src/both.test.ts")).toEqual([
      "bundled-alpha",
      "bundled-beta",
    ])
    // The commented file is routed by nobody: prose is not a listing.
    expect(routings.get("bundled-apps/alpha/src/commented.test.ts")).toBeUndefined()
  })

  it("names no phantom file in any bundled-* / bundled-freeze suite", () => {
    // Bun treats a missing path in a multi-path `bun test` invocation as a
    // filter that matches nothing, NOT an error — so a renamed or deleted
    // file silently drops out of CI instead of failing loudly. This asserts
    // every path a bundled suite names still exists on disk.
    const blocks = suiteBlocks()
    const phantoms: string[] = []
    for (const [name, block] of Object.entries(blocks)) {
      if (name !== "bundled-freeze" && !name.startsWith("bundled-")) continue
      // Root-cwd suites (bundled-freeze) list full bundled-apps/... paths;
      // app-cwd suites list paths relative to their own cwd. Either way it is
      // the array literal's entries that are passed to `bun test`, never a
      // filename a comment happens to quote.
      for (const routed of routedPaths(block)) {
        if (!existsSync(path.join(ROOT, routed))) phantoms.push(`${name}: ${routed}`)
      }
    }
    expect(phantoms).toEqual([])
  })

  it("puts every bundled-apps suite (plus bundled-freeze) in FULL_ORDER", () => {
    const blocks = suiteBlocks()
    const order = fullOrder()
    expect(order.length).toBeGreaterThan(0)
    const missing: string[] = []
    for (const [name, block] of Object.entries(blocks)) {
      const isBundledCwd = /cwd:\s*path\.join\(ROOT,\s*"bundled-apps\//.test(block)
      if (!isBundledCwd && name !== "bundled-freeze") continue
      if (!order.includes(name)) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  it("keeps every exemption entry present on disk", () => {
    for (const exempt of KNOWN_UNROUTED_BUNDLED) {
      expect(onDisk, `stale exemption ${exempt}`).toContain(exempt)
    }
  })

  it("holds the bundled exemption list at its introduction size, so it can only shrink", () => {
    expect(KNOWN_UNROUTED_BUNDLED.length).toBe(1)
  })
})
