// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo pool keeps a ready workspace across a deploy when its world
// fingerprint (`demoPoolWorld`) matches the running build's. That is only
// safe while the fingerprint covers everything the demo tier writes from: a
// demo module the seed imports but the fingerprint leaves out could change
// the seeded world while the pool keeps handing out the old one.
//
// So: walk the import graph from the demo tier's seed engine files (the ones
// the fingerprint hashes), following imports into the demo
// content roots (the seed engine, the demo modules, the shared demo needs and
// tours), and require every module reached to be one of the fingerprint's
// files or a declared demo-mode logic module. Seed engine files only other
// tiers import are not hashed, so a new tier does not retire the pool. Product services the seed calls through are outside
// those roots on purpose: the fingerprint covers what the seed writes, not how
// the product stores it (see WORLD in demo-pool.ts).
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import {
  DEMO_TIER_ENTRY,
  DEMO_WORLD_INPUTS,
  demoPoolWorld,
  demoTierSeedFiles,
  demoWorldFiles,
  worldFingerprint,
} from "~/modules/demo/demo-pool"

const REPO = path.resolve(import.meta.dir, "../../../../..")
const API_SRC = "apps/api/src"

/** Where world content lives: an import into one of these is followed and must be hashed. */
const CONTENT_ROOTS = [
  "apps/api/src/seed/",
  "apps/api/src/modules/demo/",
  "packages/shared/src/demo/",
  "packages/shared/src/tours/demo/",
]

const isTest = (rel: string) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) || rel.includes(".test-")

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    const abs = path.join(REPO, candidate)
    if (existsSync(abs) && statSync(abs).isFile()) return candidate
  }
  return null
}

/** The repository-relative file an import specifier in `from` names, or null for a package. */
function resolveImport(from: string, spec: string): string | null {
  if (spec.startsWith("~/")) return resolveFile(path.posix.join(API_SRC, spec.slice(2)))
  if (spec.startsWith(".")) return resolveFile(path.posix.join(path.posix.dirname(from), spec))
  return null
}

const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g

/**
 * Demo modules the seed imports that hold demo-mode LOGIC, not world content:
 * how a demo org is marked, gated and reset. A change there changes no seeded
 * row, so it is not a new world (the build id still tells builds apart). Each
 * entry is a deliberate decision; anything else the seed reaches is hashed.
 */
const LOGIC_NOT_CONTENT: Record<string, string> = {
  "apps/api/src/modules/demo/demo-mode.ts": "whether this process runs in demo mode",
  "apps/api/src/modules/demo/demo-org.ts": "the demo marker on an org and its guards",
  "apps/api/src/modules/demo/demo-reset.ts": "the nightly reset and the reaper's deletes",
  "apps/api/src/modules/demo/demo-provisioning.ts":
    "a workspace's readiness state and seed deadline",
  "apps/api/src/modules/demo/demo-verification.ts":
    "who a visitor proved to be, for the spend gate",
  // The sentinels it compares with are hashed (boxtal/, shopify/); the token prefix goes on tokens
  // issued at request time, never on a seeded row.
  "apps/api/src/modules/demo/fixture-credential.ts":
    "whether a request belongs to a fixture connection, answered or refused at request time",
}

/**
 * Walk the imports from every hashed seed engine file (the demo tier's). An
 * import into a content root must be a hashed file (then its own imports are
 * walked too) or a declared logic module; anything else is returned as
 * missing from the fingerprint.
 */
function unhashedContentImports(hashed: ReadonlySet<string>): string[] {
  const missing = new Set<string>()
  const seen = new Set<string>()
  const queue = [...hashed].filter((f) => f.startsWith("apps/api/src/seed/") && /\.tsx?$/.test(f))
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    const src = readFileSync(path.join(REPO, file), "utf8")
    for (const match of src.matchAll(SPEC)) {
      const target = resolveImport(file, match[1] as string)
      if (!target || isTest(target)) continue
      if (!CONTENT_ROOTS.some((root) => target.startsWith(root))) continue
      if (hashed.has(target)) queue.push(target)
      else if (!(target in LOGIC_NOT_CONTENT)) missing.add(target)
    }
  }
  return [...missing].sort()
}

describe("the demo pool's world fingerprint", () => {
  it("covers every demo module the seed engine imports", () => {
    expect(unhashedContentImports(new Set(demoWorldFiles()))).toEqual([])
  })

  it("fails when a file the demo tier imports is left out of the hashed set", () => {
    const hashed = demoWorldFiles()
    const dropped = "apps/api/src/seed/context.ts"
    expect(hashed).toContain(dropped)
    expect(unhashedContentImports(new Set(hashed.filter((f) => f !== dropped)))).toContain(dropped)
  })

  it("hashes the demo tier's seed engine files and the schema journal, not other tiers'", () => {
    expect(DEMO_WORLD_INPUTS).toContain("apps/api/src/db/migrations/meta/_journal.json")
    expect(DEMO_WORLD_INPUTS).not.toContain("apps/api/src/seed")
    const hashed = demoWorldFiles()
    expect(hashed).toContain(DEMO_TIER_ENTRY)
    expect(hashed).toContain("apps/api/src/seed/context.ts")
    expect(hashed).toContain("apps/api/src/seed/tiers/demo/seed-org.ts")
    expect(hashed.filter((f) => f.startsWith("apps/api/src/seed/tiers/lively/"))).toEqual([])
    expect(hashed.filter(isTest)).toEqual([])
  })

  it("follows static, dynamic and relative imports through the engine, and nothing else", () => {
    const tree: Record<string, string> = {
      [DEMO_TIER_ENTRY]: `import { a } from "./a"\nconst b = await import("~/seed/b")\nimport { x } from "~/modules/x"`,
      "apps/api/src/seed/tiers/demo/a.ts": `export { c } from "../../c"\nimport "./a.test"`,
      "apps/api/src/seed/tiers/demo/a.test.ts": `import "~/seed/t"`,
      "apps/api/src/seed/b.ts": `import { z } from "zod"`,
      "apps/api/src/seed/c.ts": "",
      "apps/api/src/modules/x.ts": `import "~/seed/via-module"`,
      "apps/api/src/seed/via-module.ts": "",
      "apps/api/src/seed/tiers/other/tier.ts": `import "~/seed/only-other"`,
      "apps/api/src/seed/only-other.ts": "",
    }
    const read = (rel: string) => tree[rel] ?? null
    expect(demoTierSeedFiles([], read)).toEqual([
      "apps/api/src/seed/b.ts",
      "apps/api/src/seed/c.ts",
      "apps/api/src/seed/tiers/demo/a.ts",
      DEMO_TIER_ENTRY,
    ])
    // A hashed demo module that imports the engine brings that file in too.
    expect(demoTierSeedFiles(["apps/api/src/modules/x.ts"], read)).toContain(
      "apps/api/src/seed/via-module.ts",
    )
  })

  it("hashes contents, not paths or order: a moved file keeps the world", () => {
    const a = Buffer.from("export const A = 1\n")
    const b = Buffer.from("export const B = 2\n")
    expect(worldFingerprint([a, b])).toBe(worldFingerprint([b, a]))
    expect(worldFingerprint([a, b])).not.toBe(worldFingerprint([a, Buffer.from("changed")]))
    expect(demoPoolWorld()).toMatch(/^[0-9a-f]{32}$/)
  })
})
