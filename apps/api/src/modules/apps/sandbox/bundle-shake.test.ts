// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  esmExportsToGlobalThis,
  loadBundle,
  unwrapGlobalThisExports,
} from "~/modules/apps/sandbox/bundle-loader"
import {
  buildExportOnlyBundle,
  clearExportOnlyBundleCache,
  exportOnlyBundleCacheBytes,
  exportOnlyBundleCacheSize,
  exportOnlyBundle as exportOnlyBundleOf,
  holdingExportOnlyBuilds,
  useFullBundle,
  watchBridgeCalls,
} from "~/modules/apps/sandbox/bundle-shake"
import { executeInSandbox } from "~/modules/apps/sandbox/executor"
import { createSandboxPool, type SandboxPool } from "~/modules/apps/sandbox/pool"

const APPS_DIR = join(import.meta.dir, "..", "..", "..", "apps")
const BUNDLED_APPS_DIR = join(import.meta.dir, "..", "..", "..", "..", "..", "..", "bundled-apps")

/** A first-party bundle's trim (the platform vouches for the code). */
const exportOnlyBundle = (source: string, exportName: string) =>
  exportOnlyBundleOf(source, exportName, { firstParty: true })

/** Settle the background build `exportOnlyBundle` started. */
async function settled(source: string, exportName: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const s = exportOnlyBundle(source, exportName)
    if (s !== source) return s
    await Bun.sleep(10)
  }
  return source
}

/** A bridge that records every call and answers each method with a canned JSON string. */
function recordingBridge(source: string, calls: Array<[string, unknown[]]>) {
  const names = new Set<string>()
  for (const m of source.matchAll(/ctx\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)) {
    names.add(m[1]!)
    if (m[2]) names.add(`${m[1]}_${m[2]}`)
  }
  const bridge: Record<string, (...args: any[]) => any> = {}
  for (const name of names) {
    bridge[name] = async (...args: unknown[]) => {
      calls.push([name, args])
      return JSON.stringify([{ id: `${name}-1`, args }])
    }
  }
  return bridge
}

const SCRIPT = `
var calls = 0;
function helper(x) { calls++; return "helped:" + x; }
function unused() { return "never called by the handler, so the trim drops it" + Math.random(); }
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

  it("starts no build while a run is in flight, and builds once the runs end", async () => {
    let release = () => {}
    const held = holdingExportOnlyBuilds(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    expect(exportOnlyBundle(SCRIPT, "handler")).toBe(SCRIPT)
    // Long enough for an unheld build of this bundle to have finished several times over.
    await Bun.sleep(500)
    expect(exportOnlyBundle(SCRIPT, "handler")).toBe(SCRIPT)
    release()
    await held
    expect(await settled(SCRIPT, "handler")).not.toBe(SCRIPT)
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
    // Scoped, but the handler is no export of the bundle: not a top-level name.
    const wrapped = "(function () {\nfunction handler() { return 1 }\n})();\n"
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

  it("shakes an installed bundle, whose body is scoped and whose exports are globals, renamed export included", async () => {
    const installed = esmExportsToGlobalThis(
      `${SCRIPT}\nfunction handler2(params, ctx) { return { renamed: helper(params.x) }; }\nexport { handler, other, handler2 as renamed };`,
    )
    const shaken = await buildExportOnlyBundle(installed, "renamed")
    expect(shaken).not.toBeNull()
    expect(shaken).not.toContain("never")
    expect(await run(shaken!, "renamed", { x: 2 })).toEqual(
      await run(installed, "renamed", { x: 2 }),
    )
    const handlerOnly = await buildExportOnlyBundle(installed, "handler")
    expect(await run(handlerOnly!, "handler", { x: 1 })).toEqual(
      await run(installed, "handler", { x: 1 }),
    )
    expect(await buildExportOnlyBundle(installed, "missing")).toBeNull()
  })

  it("is bounded whatever the number of bundles", () => {
    for (let i = 0; i < 5000; i++) useFullBundle(`function handler() { return ${i} }`, "handler")
    expect(exportOnlyBundleCacheSize()).toBeLessThanOrEqual(2048)
  })

  it("never trims, nor builds over, code the platform does not vouch for: a third-party or custom app's bundle", async () => {
    for (const provenance of [{}, { trusted: false, firstParty: false }, { trusted: false }]) {
      for (let i = 0; i < 5; i++) {
        expect(exportOnlyBundleOf(SCRIPT, "handler", provenance)).toBe(SCRIPT)
        await Bun.sleep(20)
      }
    }
    expect(exportOnlyBundleCacheSize()).toBe(0)
    expect(await settled(SCRIPT, "handler")).not.toBe(SCRIPT)
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
        for (let i = 0; i < 10; i++) {
          expect(exportOnlyBundle(bundle, "handler")).toBe(bundle)
          await Bun.sleep(20)
        }
        expect(existsSync(marker)).toBe(false)
      })
    }
  })

  it("keeps a body's own trailing global assignment, which is no export", async () => {
    const installed = esmExportsToGlobalThis(
      `var cfg = { mode: "x" };\nasync function handler(p, ctx) { return { flag: globalThis.flag } }\nfunction unused() { return "never" }\nglobalThis.flag = cfg;\nexport { handler };`,
    )
    expect(unwrapGlobalThisExports(installed)?.exports).toEqual(new Map([["handler", "handler"]]))
    const shaken = await buildExportOnlyBundle(installed, "handler")
    expect(shaken).not.toBeNull()
    expect(shaken).not.toContain("never")
    expect(await run(shaken!, "handler", {})).toEqual({ flag: { mode: "x" } })
    expect(await run(shaken!, "handler", {})).toEqual(await run(installed, "handler", {}))
  })

  it("does not trim a scoped bundle whose exports it cannot tell from its body", async () => {
    const unmarked =
      "(function () {\nvar cfg = 1;\nasync function handler() { return 1 }\nglobalThis.flag = cfg;\nglobalThis.handler = handler;\n})();\n"
    expect(unwrapGlobalThisExports(unmarked)).toBeNull()
    expect(await buildExportOnlyBundle(unmarked, "handler")).toBeNull()
  })

  it("notes a bridge call, keeping each method's kind and the bridge's hidden marks", async () => {
    const mark = Symbol("mark")
    const bridge: Record<string | symbol, any> = {
      read: async (x: number) => x + 1,
      digest: (x: string) => `d:${x}`,
      value: 3,
    }
    Object.defineProperty(bridge, mark, { value: "kept", enumerable: false })
    const watched = watchBridgeCalls(bridge as Record<string, any>)
    expect(watched.called()).toBe(false)
    expect(watched.bridge.value).toBe(3)
    expect((watched.bridge as Record<symbol, unknown>)[mark]).toBe("kept")
    expect(watched.bridge.digest.constructor.name).not.toBe("AsyncFunction")
    expect(watched.bridge.read.constructor.name).toBe("AsyncFunction")
    expect(watched.bridge.digest("a")).toBe("d:a")
    expect(watched.called()).toBe(true)
    expect(await watchBridgeCalls(bridge as Record<string, any>).bridge.read(1)).toBe(2)
  })

  it("holds every first-party read-only tool's trimmed bundle at once, within its byte bound", async () => {
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    type Manifest = {
      version: string
      tools?: Record<string, { readOnly?: boolean; handler?: string }>
    }
    const tools: Array<{ app: string; bundle: string; handler: string }> = []
    for (const [dir, inTree] of [
      [APPS_DIR, true],
      [BUNDLED_APPS_DIR, false],
    ] as const) {
      for (const app of readdirSync(dir)) {
        if (!existsSync(join(dir, app, "app.manifest.json"))) continue
        const manifest = JSON.parse(
          readFileSync(join(dir, app, "app.manifest.json"), "utf8"),
        ) as Manifest
        const reads = Object.values(manifest.tools ?? {}).filter(
          (t) => t.readOnly === true && typeof t.handler === "string",
        )
        if (reads.length === 0) continue
        const bundle = await loadBundle(
          inTree ? join(dir, app, "handlers.ts") : join(dir, app, manifest.version, "bundle.js"),
        )
        for (const handler of new Set(reads.map((t) => t.handler as string))) {
          tools.push({ app, bundle, handler })
        }
      }
    }
    expect(tools.length).toBeGreaterThan(50)
    let bytes = 0
    let trimmed = 0
    for (const t of tools) {
      const s = await buildExportOnlyBundle(t.bundle, t.handler)
      if (s) {
        bytes += s.length
        trimmed++
      }
    }
    for (const t of tools) {
      for (let i = 0; i < 400 && exportOnlyBundle(t.bundle, t.handler) === t.bundle; i++) {
        await Bun.sleep(10)
      }
    }
    console.log(
      `first-party read-only handlers: ${tools.length}, trimmed ${trimmed}, cache ${exportOnlyBundleCacheBytes()} bytes in ${exportOnlyBundleCacheSize()} entries (sum ${bytes})`,
    )
    expect(trimmed).toBeGreaterThan(tools.length / 2)
    expect(exportOnlyBundleCacheBytes()).toBe(bytes)
  }, 600_000)

  // Tickets is a core app module (core/registry.ts), never a bundle to shake.
  for (const app of ["knowledge", "projects"]) {
    it(`${app}: the export-only attention provider behaves like the full bundle`, async () => {
      const full = await loadBundle(join(APPS_DIR, app, "handlers.ts"))
      const shaken = await buildExportOnlyBundle(full, "computeAttentionItems")
      expect(shaken).not.toBeNull()
      expect(shaken!.length).toBeLessThan(full.length / 2)
      const fullCalls: Array<[string, unknown[]]> = []
      const shakenCalls: Array<[string, unknown[]]> = []
      const params = { actor: { actorType: "user", userId: "u1", orgId: "o1", scopes: ["*"] } }
      const a = await run(full, "computeAttentionItems", params, recordingBridge(full, fullCalls))
      const b = await run(
        shaken!,
        "computeAttentionItems",
        params,
        recordingBridge(full, shakenCalls),
      )
      expect(b).toEqual(a)
      expect(shakenCalls).toEqual(fullCalls)
      expect(fullCalls.length).toBeGreaterThan(0)
    })
  }
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
