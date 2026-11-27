// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every UI component a bundled app's manifest names is exported by its UI entry.
//
// A manifest naming an export its bundle lacks fails only at run time, one
// section or view at a time: the frame logs `its UI bundle does not export "X"`
// and draws an error card where the block should be. Nothing at build time
// compared the two. This reads each app's `ui.tsx` and follows its re-exports
// (`export * from`, `export { X } from`) through the source, so it needs no build.
import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  collectDeclaredComponentNames,
  collectSettingsBlockComponentNames,
} from "../apps/web/src/framework/manifest-exports"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const APPS_DIR = join(REPO_ROOT, "bundled-apps")
const transpiler = new Bun.Transpiler({ loader: "tsx" })

function resolveModule(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null
  const base = resolve(dirname(from), spec)
  for (const candidate of [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, "index.tsx"),
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        readFileSync(candidate)
        return candidate
      } catch {
        // A directory: try the next candidate.
      }
    }
  }
  return null
}

/** The names a module exports, `export * from` followed through local files. */
export function moduleExports(file: string, seen = new Set<string>()): Set<string> {
  const names = new Set<string>()
  if (seen.has(file)) return names
  seen.add(file)
  const code = readFileSync(file, "utf8")
  for (const name of transpiler.scan(code).exports) names.add(name)
  for (const m of code.matchAll(/export\s*\*\s*from\s*["']([^"']+)["']/g)) {
    const target = resolveModule(file, m[1] as string)
    if (!target) continue
    for (const name of moduleExports(target, seen)) if (name !== "default") names.add(name)
  }
  return names
}

const apps = readdirSync(APPS_DIR).filter(
  (a) =>
    existsSync(join(APPS_DIR, a, "app.manifest.json")) && existsSync(join(APPS_DIR, a, "ui.tsx")),
)

describe("bundled app UI exports", () => {
  test("there are bundled apps with a UI to check", () => {
    expect(apps.length).toBeGreaterThan(5)
  })

  for (const app of apps) {
    test(`${app}: every component its manifest names is exported by ui.tsx`, () => {
      const manifest = JSON.parse(readFileSync(join(APPS_DIR, app, "app.manifest.json"), "utf8"))
      const exported = moduleExports(join(APPS_DIR, app, "ui.tsx"))
      const named = [
        ...collectDeclaredComponentNames(manifest),
        ...collectSettingsBlockComponentNames(manifest),
      ]
      const missing = named.filter((n) => !exported.has(n))
      expect(missing).toEqual([])
    })
  }

  test("the reader follows `export * from` and named re-exports", () => {
    // stripe's ui.tsx is a single `export * from "./src/ui/index"`.
    const stripe = join(APPS_DIR, "stripe", "ui.tsx")
    if (!existsSync(stripe)) return
    expect(moduleExports(stripe).has("StripeWebhookSettings")).toBe(true)
  })
})
