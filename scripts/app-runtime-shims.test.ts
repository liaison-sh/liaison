// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ship-artifact oracle for the host <-> plugin Solid runtime contract.
//
// Five bundled app UIs (shopify, boxtal, invoicing, monitoring, ads) failed to
// load on a deployed box with "The requested module 'solid-js/web' does not
// provide an export named 'setStyleProperty'": the host's shim carried a
// hand-maintained export list that had fallen behind the runtime it re-exports.
// Nothing failed at build time because nothing compared the two.
import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  findUnsupportedBundleImports,
  parseBundleSolidImports,
  parseShimExports,
  readAllShimExports,
  readHostModuleExports,
  readShimExports,
  renderShim,
  SHIM_SPECIFIERS,
  shimPath,
} from "./lib/app-runtime-shims"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** `ui.js` out of a `.liaisonapp` tarball, or null when the app ships no UI. */
function extractUiJs(tarball: string): string | null {
  try {
    return execFileSync("tar", ["-xzOf", tarball, "ui.js"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return null
  }
}

describe("solid runtime shims", () => {
  for (const specifier of SHIM_SPECIFIERS) {
    test(`shim for ${specifier} re-exports every symbol the host runtime exports`, async () => {
      const hostExports = await readHostModuleExports(REPO_ROOT, specifier)
      const shimExports = new Set(readShimExports(REPO_ROOT, specifier))
      const missing = hostExports.filter((name) => !shimExports.has(name))
      expect(missing).toEqual([])
    })

    test(`shim for ${specifier} exports nothing the host runtime does not have`, async () => {
      const hostExports = new Set(await readHostModuleExports(REPO_ROOT, specifier))
      const stale = readShimExports(REPO_ROOT, specifier).filter((n) => !hostExports.has(n))
      expect(stale).toEqual([])
    })

    test(`shim for ${specifier} is byte-identical to the generator output`, async () => {
      const wanted = renderShim(specifier, await readHostModuleExports(REPO_ROOT, specifier))
      expect(readFileSync(shimPath(REPO_ROOT, specifier), "utf8")).toEqual(wanted)
    })
  }

  test("setStyleProperty is reachable through the solid-js/web shim", () => {
    expect(readShimExports(REPO_ROOT, "solid-js/web")).toContain("setStyleProperty")
  })
})

describe("built bundle import guard", () => {
  test("parses esbuild's one-symbol-per-line solid imports", () => {
    const code = [
      'import { template as _$template } from "solid-js/web";',
      'import { setStyleProperty as _$setStyleProperty } from "solid-js/web";',
      'import { Show, For as F } from "solid-js";',
      'import { createStore } from "solid-js/store";',
      'import { something } from "./local";',
    ].join("\n")
    expect(parseBundleSolidImports(code)).toEqual([
      { specifier: "solid-js/web", imported: "template" },
      { specifier: "solid-js/web", imported: "setStyleProperty" },
      { specifier: "solid-js", imported: "Show" },
      { specifier: "solid-js", imported: "For" },
      { specifier: "solid-js/store", imported: "createStore" },
    ])
  })

  test("flags a symbol the host shim does not export", () => {
    const shimExports = { "solid-js/web": ["template", "insert"], "solid-js": ["Show"] }
    const code = 'import { setStyleProperty as _$s } from "solid-js/web";'
    expect(findUnsupportedBundleImports(code, shimExports)).toEqual([
      { specifier: "solid-js/web", imported: "setStyleProperty" },
    ])
  })

  test("passes a bundle whose symbols are all shimmed", () => {
    const shimExports = { "solid-js/web": ["template", "setStyleProperty"] }
    const code = [
      'import { template as _$t } from "solid-js/web";',
      'import { setStyleProperty as _$s } from "solid-js/web";',
    ].join("\n")
    expect(findUnsupportedBundleImports(code, shimExports)).toEqual([])
  })

  test("ignores namespace imports, which cannot fail at module evaluation", () => {
    const shimExports = { "solid-js/web": ["template"] }
    const code = 'import * as web from "solid-js/web";'
    expect(findUnsupportedBundleImports(code, shimExports)).toEqual([])
  })

  test("parseShimExports reads only the named const re-exports", () => {
    const source = renderShim("solid-js/store", ["createStore", "produce"])
    expect(parseShimExports(source)).toEqual(["createStore", "produce"])
  })

  // Real ship artifacts when they are present. dist/ is gitignored, so a fresh
  // clone has none and this degrades to the generator tests above; on a machine
  // that has built the catalog it is the end-to-end proof.
  test("every built .liaisonapp ui.js imports only shimmed symbols", () => {
    const shimExports = readAllShimExports(REPO_ROOT)
    const bundledRoot = join(REPO_ROOT, "bundled-apps")
    const offenders: string[] = []
    for (const app of readdirSync(bundledRoot)) {
      const dist = join(bundledRoot, app, "dist")
      if (!existsSync(dist)) continue
      const newest = readdirSync(dist)
        .filter((f) => f.endsWith(".liaisonapp"))
        .map((f) => ({ f, mtime: statSync(join(dist, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0]
      if (!newest) continue
      const ui = extractUiJs(join(dist, newest.f))
      if (ui === null) continue
      for (const bad of findUnsupportedBundleImports(ui, shimExports)) {
        offenders.push(`${newest.f}: ${bad.specifier} -> ${bad.imported}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
