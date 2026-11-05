// SPDX-License-Identifier: FSL-1.1-ALv2
// Every summarizer a manifest names is one the runtime can actually reach
// (runtime.ts, "Summarizer trust carve-out"):
//  - a trusted in-tree app resolves it host-side from its handlers module or
//    the sibling `summarizers.ts` (loadTrustedBundleFunction);
//  - a sandboxed app (an in-tree `trusted: false` app, every bundled app) runs
//    it in QuickJS from its handler bundle ALONE: a summarizer kept in another
//    module is never found ("Export ... not found in bundle"), and the approval
//    card silently falls back to the raw params.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { esmExportsToGlobalThis, loadBundle } from "~/modules/apps/sandbox/bundle-loader"

const REPO = resolve(import.meta.dir, "../../../../..")

interface Declared {
  app: string
  dir: string
  trusted: boolean
  bundled: boolean
  summarizers: string[]
}

function declared(): Declared[] {
  const out: Declared[] = []
  for (const [root, bundled] of [
    [join(REPO, "apps/api/src/apps"), false],
    [join(REPO, "bundled-apps"), true],
  ] as const) {
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      const file = join(dir, "app.manifest.json")
      if (!existsSync(file)) continue
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        name?: string
        trusted?: boolean
        tools?: Record<string, { summarizer?: unknown }> | Array<{ summarizer?: unknown }>
      }
      const tools = Array.isArray(manifest.tools)
        ? manifest.tools
        : Object.values(manifest.tools ?? {})
      const summarizers = [
        ...new Set(
          tools
            .map((t) => t.summarizer)
            .filter((s): s is string => typeof s === "string" && s.length > 0),
        ),
      ]
      if (summarizers.length === 0) continue
      out.push({
        app: manifest.name ?? name,
        dir,
        // Installed (bundled) apps are always sandboxed (init.ts).
        trusted: !bundled && manifest.trusted !== false,
        bundled,
        summarizers,
      })
    }
  }
  return out
}

/** Names the sandbox can resolve as globals of the evaluated bundle. */
function sandboxGlobals(source: string, names: string[]): Set<string> {
  const found = new Set<string>()
  for (const name of names) {
    const declaredTopLevel = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m")
    const assigned = new RegExp(`globalThis\\.${name}\\s*=`)
    if (declaredTopLevel.test(source) || assigned.test(source)) found.add(name)
  }
  return found
}

async function bundleSource(app: Declared): Promise<string> {
  const entry = join(app.dir, "handlers.ts")
  if (!app.bundled) return loadBundle(entry)
  // As the installed tarball's bundle.js is built (bundle-loader.ts side channel).
  const built = await Bun.build({ entrypoints: [entry], target: "bun", external: ["node:*"] })
  if (!built.success || !built.outputs[0]) throw new Error(`${app.app}: bundle build failed`)
  return esmExportsToGlobalThis(await built.outputs[0].text())
}

async function trustedExports(app: Declared): Promise<Set<string>> {
  const found = new Set<string>()
  for (const file of ["handlers.ts", "summarizers.ts"]) {
    const path = join(app.dir, file)
    if (!existsSync(path)) continue
    const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>
    for (const name of app.summarizers) if (typeof mod[name] === "function") found.add(name)
  }
  return found
}

describe("every summarizer a manifest names is reachable by the runtime", () => {
  const apps = declared()

  it("finds the declaring apps (sandboxed and trusted)", () => {
    expect(apps.some((a) => !a.trusted)).toBe(true)
    expect(apps.some((a) => a.trusted)).toBe(true)
  })

  for (const app of apps) {
    it(`${app.app}: ${app.trusted ? "trusted, host-side" : "sandboxed, in its bundle"}`, async () => {
      const found = app.trusted
        ? await trustedExports(app)
        : sandboxGlobals(await bundleSource(app), app.summarizers)
      expect(app.summarizers.filter((s) => !found.has(s))).toEqual([])
    }, 60_000)
  }
})
