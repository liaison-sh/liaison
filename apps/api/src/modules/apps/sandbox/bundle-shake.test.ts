// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { esmExportsToGlobalThis } from "~/modules/apps/sandbox/bundle-loader"
import {
  buildExportOnlyBundle,
  clearExportOnlyBundleCache,
  exportOnlyBundle,
  exportOnlyBundleCacheSize,
  useFullBundle,
} from "~/modules/apps/sandbox/bundle-shake"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { createSandboxPool, type SandboxPool } from "~/modules/apps/sandbox/pool"

/** Settle the background build `exportOnlyBundle` started. */
async function settled(source: string, exportName: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const s = exportOnlyBundle(source, exportName)
    if (s !== source) return s
    await Bun.sleep(10)
  }
  return source
}

const SCRIPT = `
var calls = 0;
function helper(x) { calls++; return "helped:" + x; }
function unused() { return "never" + Math.random(); }
async function handler(params, ctx) { return { out: helper(params.x), calls: calls, side: globalThis.sideEffect }; }
async function other(params, ctx) { return unused(); }
globalThis.sideEffect = "kept";
`

describe("export-only bundles", () => {
  let pool: SandboxPool

  beforeAll(async () => {
    pool = await createSandboxPool({ initialSize: 1, maxSize: 1 })
  }, 60_000)

  afterAll(async () => {
    if (pool) await pool.shutdown()
  }, 60_000)

  beforeEach(() => clearExportOnlyBundleCache())

  const run = (bundleSource: string, exportName: string, params: unknown, bridge = {}) =>
    executeInSandbox({ pool, bundleSource, exportName, params, bridge })

  it("keeps the export, what it reaches and the side effects, and drops the rest", async () => {
    const shaken = await buildExportOnlyBundle(SCRIPT, "handler")
    expect(shaken).not.toBeNull()
    expect(shaken).toContain("function helper")
    expect(shaken).toContain('globalThis.sideEffect = "kept"')
    expect(shaken).not.toContain("function unused")
    expect(shaken).not.toContain("function other")
    expect(await run(shaken!, "handler", { x: 1 })).toEqual(await run(SCRIPT, "handler", { x: 1 }))
    expect(await run(shaken!, "handler", { x: 1 })).toEqual({
      out: "helped:1",
      calls: 1,
      side: "kept",
    })
  })

  it("serves the full bundle until the build is done, then the export-only one", async () => {
    expect(exportOnlyBundle(SCRIPT, "handler")).toBe(SCRIPT)
    const shaken = await settled(SCRIPT, "handler")
    expect(shaken).not.toBe(SCRIPT)
    expect(shaken.length).toBeLessThan(SCRIPT.length)
  })

  it("an upgraded bundle never runs the previous version's export-only bundle", async () => {
    const v1 = "async function handler(p, ctx) { return 1 }\nfunction pad() { return 0 }"
    const v2 = "async function handler(p, ctx) { return 2 }\nfunction pad() { return 0 }"
    const s1 = await settled(v1, "handler")
    expect(await run(s1, "handler", {})).toBe(1)
    // The first answer for v2 is v2 itself (its build has not run yet), never s1.
    expect(exportOnlyBundle(v2, "handler")).toBe(v2)
    const s2 = await settled(v2, "handler")
    expect(await run(s2, "handler", {})).toBe(2)
    expect(await run(exportOnlyBundle(v1, "handler"), "handler", {})).toBe(1)
  })

  it("keeps the full bundle when it cannot be shaken or the export is not a top-level name", async () => {
    const wrapped =
      "(function () {\nfunction handler() { return 1 }\nglobalThis.handler = handler;\n})();\n"
    expect(await buildExportOnlyBundle(wrapped, "handler")).toBeNull()
    expect(await buildExportOnlyBundle("function handler( {", "handler")).toBeNull()
    expect(await buildExportOnlyBundle(SCRIPT, "handler; globalThis.x = 1")).toBeNull()
    exportOnlyBundle(wrapped, "handler")
    await Bun.sleep(300)
    expect(exportOnlyBundle(wrapped, "handler")).toBe(wrapped)
  })

  it("falls back to the full bundle for good once asked to", async () => {
    await settled(SCRIPT, "handler")
    useFullBundle(SCRIPT, "handler")
    expect(exportOnlyBundle(SCRIPT, "handler")).toBe(SCRIPT)
  })

  it("is bounded whatever the number of bundles", () => {
    for (let i = 0; i < 200; i++) exportOnlyBundle(`function handler() { return ${i} }`, "handler")
    expect(exportOnlyBundleCacheSize()).toBeLessThanOrEqual(64)
  })
})

describe("a bundle with an import attribute", () => {
  let dir = ""
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "liaison-shake-macro-"))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const macroBundle = (marker: string, attribute: string) => {
    const macro = join(dir, `macro-${crypto.randomUUID()}.ts`)
    writeFileSync(
      macro,
      `import { writeFileSync } from "node:fs"\nexport function mark() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1 }\n`,
    )
    return esmExportsToGlobalThis(
      `import { mark } from ${JSON.stringify(macro)} ${attribute};\nvar seen = mark();\nasync function handler(p, ctx) { return seen }\nexport { handler };`,
    )
  }

  for (const attribute of [
    'with { type: "macro" }',
    'assert { type: "macro" }',
    'with /* note */ { type: "macro" }',
    'with // note\n { type: "macro" }',
  ]) {
    it(`is refused before any build, and its macro never runs on the host (${attribute.replace("\n", " ")})`, async () => {
      const marker = join(dir, `ran-${crypto.randomUUID()}`)
      const bundle = macroBundle(marker, attribute)
      expect(await buildExportOnlyBundle(bundle, "handler")).toBeNull()
      expect(existsSync(marker)).toBe(false)
    })
  }
})
