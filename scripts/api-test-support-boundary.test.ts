// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test scaffolding stays out of the production API tree.
//
// The Docker image copies apps/api wholesale and runs its source, so anything
// under apps/api/src ships. Test harness code (the QA seed routes, the e2e and
// chaos entrypoints, the external-API mocks, the test-only apps) lives in
// apps/api/test-support, which .dockerignore keeps out of the image, and the
// production tree reaches it only through a run-time optional import that
// fails closed when the flag is on and the folder is absent.
//
// Seams a test needs on a production module's private state are grouped in one
// `<Module>TestAccess` object per module, never scattered as exported
// `somethingForTest` functions or an anonymous `__testing` bag, so the
// production surface carries one clearly named door instead of a name per hook.
// That rule holds across every shipped tree: the api and web sources, the
// workspace packages, the bundled apps and the scripts the runtime imports.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const API = path.join(ROOT, "apps/api")
const SRC = path.join(API, "src")
const TEST_SUPPORT_DIR = "test-support"

/**
 * Every tree whose sources ship. The api tree is checked by the rules below on
 * top of this one; the rest are here only for the no-test-seam-export rule.
 */
const SHIPPED_TREES = ["apps/api/src", "apps/web/src", "packages", "bundled-apps", "scripts"]

/** Trees that ARE the test harness, so a seam there is the point, not a leak. */
const HARNESS_PREFIXES = ["packages/test-helpers/", "apps/api/test-support/"]

function walk(dir: string, out: string[]): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full)
  }
  return out
}

/** Test files and test helpers that live beside production code. */
function isTestFile(rel: string): boolean {
  return (
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx") ||
    rel.startsWith("tests/") ||
    rel.includes("/tests/") ||
    rel.includes("/__fixtures__/") ||
    rel.endsWith("/test-helpers.ts") ||
    rel.endsWith(".test-fixtures.ts") ||
    HARNESS_PREFIXES.some((prefix) => rel.startsWith(prefix))
  )
}

function productionFiles(): string[] {
  return walk(SRC, [])
    .map((f) => path.relative(SRC, f))
    .filter((rel) => !isTestFile(rel))
}

/** Every shipped source file across SHIPPED_TREES, repo-relative. */
function shippedFiles(): string[] {
  const out: string[] = []
  for (const tree of SHIPPED_TREES) {
    for (const abs of walk(path.join(ROOT, tree), [])) {
      const rel = path.relative(ROOT, abs)
      if (!isTestFile(rel)) out.push(rel)
    }
  }
  return out
}

/** Source with line and block comments removed (names in prose are not exports). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

const FOR_TEST = /(?:ForTests?|ForTesting)$/

/** The anonymous bag the same leak used to hide behind. */
const TESTING_BAG = "__testing"
const STATIC_TESTING_BAG = /\breadonly\s+__testing\b/

/** Names this file exports (or exposes as a class-static bag) purely for tests. */
function testSeamExports(src: string): string[] {
  const hits = exportedNames(src).filter((name) => FOR_TEST.test(name) || name === TESTING_BAG)
  if (STATIC_TESTING_BAG.test(src)) hits.push(`static ${TESTING_BAG}`)
  return hits
}

/** Every exported binding name a source declares or re-exports. */
function exportedNames(src: string): string[] {
  const names: string[] = []
  const decl =
    /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g
  for (const m of src.matchAll(decl)) names.push(m[1])
  for (const m of src.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const alias = part.trim().split(/\s+as\s+/)
      const name = (alias[1] ?? alias[0]).replace(/^type\s+/, "").trim()
      if (name) names.push(name)
    }
  }
  return names
}

/** Import specifiers that name the test-support tree or the old in-src harness folder. */
const TEST_SUPPORT_SPECIFIER = /["'`][^"'`]*(?:\/test-support\/|~\/modules\/_test\/)[^"'`]*["'`]/
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*(["'][^"']+["'])/g
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'`][^"'`]+["'`])\s*\)/g

function testSupportImports(src: string): string[] {
  const hits: string[] = []
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const m of src.matchAll(re)) if (TEST_SUPPORT_SPECIFIER.test(m[1])) hits.push(m[1])
  }
  return hits
}

describe("api test-support boundary", () => {
  it("the detectors see what they are for", () => {
    expect(exportedNames("export function resetCacheForTest() {}")).toEqual(["resetCacheForTest"])
    expect(exportedNames("export async function deliverForTest() {}")).toEqual(["deliverForTest"])
    expect(exportedNames("export let fetchForTest = null")).toEqual(["fetchForTest"])
    expect(testSeamExports("export function resetForTesting() {}")).toEqual(["resetForTesting"])
    expect(exportedNames("export { a as resetForTests, b }")).toEqual(["resetForTests", "b"])
    expect(exportedNames("function hiddenForTest() {}")).toEqual([])
    expect(testSeamExports("export const __testing = { a }")).toEqual(["__testing"])
    expect(testSeamExports("  static readonly __testing = { a }")).toEqual(["static __testing"])
    expect(testSeamExports("export const FooTestAccess = { a() {} }")).toEqual([])
    expect(testSupportImports(`import { x } from "~/modules/_test/x"`)).toHaveLength(1)
    expect(testSupportImports(`const m = await import("../test-support/harness/x")`)).toHaveLength(
      1,
    )
    expect(testSupportImports(`import { x } from "~/lib/optional-module"`)).toHaveLength(0)
  })

  // No exemption list: every hook the api, web, packages, bundled-apps and
  // scripts trees carried has been converted, so a new one is a regression and
  // this fails on it the day it lands.
  it("no shipped file exports a ForTest hook or a __testing bag", () => {
    const offenders: string[] = []
    for (const rel of shippedFiles()) {
      const src = code(readFileSync(path.join(ROOT, rel), "utf8"))
      for (const name of testSeamExports(src)) offenders.push(`${rel}: ${name}`)
    }
    expect(offenders).toEqual([])
  })

  it("the shipped-tree sweep actually reaches every tree", () => {
    const files = shippedFiles()
    for (const tree of SHIPPED_TREES) {
      expect(files.filter((rel) => rel.startsWith(`${tree}/`)).length).toBeGreaterThan(0)
    }
    // The harness trees are excluded on purpose, and they do carry seams.
    expect(files.some((rel) => rel.startsWith("apps/api/test-support/"))).toBe(false)
  })

  it("no production file imports the test-support tree by a literal specifier", () => {
    const offenders: string[] = []
    for (const rel of productionFiles()) {
      const hits = testSupportImports(code(readFileSync(path.join(SRC, rel), "utf8")))
      for (const hit of hits) offenders.push(`${rel}: ${hit}`)
    }
    expect(offenders).toEqual([])
  })

  it("app.ts does not import test support, statically or by a literal dynamic import", () => {
    const src = code(readFileSync(path.join(SRC, "app.ts"), "utf8"))
    expect(testSupportImports(src)).toEqual([])
    expect(src).not.toMatch(/modules\/_test/)
  })

  it("the harness folder is gone from src and the image build context excludes test-support", () => {
    expect(existsSync(path.join(SRC, "modules/_test"))).toBe(false)
    for (const entry of ["index.e2e.ts", "index.worker.ts"]) {
      expect(existsSync(path.join(SRC, entry))).toBe(false)
    }
    const ignore = readFileSync(path.join(ROOT, ".dockerignore"), "utf8")
      .split("\n")
      .map((l) => l.trim())
    expect(ignore).toContain(`apps/api/${TEST_SUPPORT_DIR}`)
  })
})
