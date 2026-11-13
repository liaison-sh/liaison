// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two app kinds, and nothing in between. The core apps (core/registry.ts) are
// server code; every other app, bundled, catalog, sideloaded or custom, runs
// sandboxed through runApp. No manifest field, descriptor flag or site option
// makes a non-core app run in this process or on a privileged handle:
//
//  - the source tree holds the core apps and nothing else;
//  - nothing imports a moved app's code from the server or the web client;
//  - a manifest carrying `trusted` is refused (package and runtime schema), and
//    no manifest of the repository carries it;
//  - runApp takes no trust option, and only a site's own QuickJS placement
//    (a pure function on an empty bridge) uses the in-process pool;
//  - the retired trust seams are gone from the server source.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { packageManifestSchema } from "@liaison/app-sdk"
import { TRUSTED_FIELD_REFUSAL, validateAppManifest } from "~/modules/apps/contract"
import { CORE_APP_NAMES, isCoreApp } from "~/modules/apps/core/registry"
import { MOVED_APPS } from "~/modules/apps/moved-apps"
import { type RunAppOptions, selectExecutor } from "~/modules/apps/sandbox/run-app"

const REPO = join(import.meta.dir, "../../../../../..")
const API_SRC = join(REPO, "apps/api/src")
const WEB_SRC = join(REPO, "apps/web/src")
const IN_TREE_APPS = join(API_SRC, "apps")
const BUNDLED_APPS = join(REPO, "bundled-apps")

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

const isTest = (path: string) => /\.(test|spec)\.tsx?$|\.test-helpers\.ts$|__fixtures__/.test(path)

/** Every module specifier a file imports (static, dynamic and type imports). */
function specifiersOf(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(
    /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    out.push((m[1] ?? m[2]) as string)
  }
  return out
}

describe("two app kinds: core (server code) and app (sandboxed)", () => {
  it("the source tree's apps directory holds the core apps and nothing else", () => {
    const dirs = readdirSync(IN_TREE_APPS).filter((n) =>
      statSync(join(IN_TREE_APPS, n)).isDirectory(),
    )
    expect(dirs.sort()).toEqual([...CORE_APP_NAMES].sort())
  })

  it("no server or web source imports a moved app's code", () => {
    const moved = MOVED_APPS.map((m) => m.name)
    expect(moved.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const root of [API_SRC, WEB_SRC]) {
      for (const file of sourceFiles(root)) {
        for (const spec of specifiersOf(readFileSync(file, "utf8"))) {
          for (const name of moved) {
            // The old in-tree module, from anywhere.
            const inTree =
              spec === `~/apps/${name}` ||
              spec.startsWith(`~/apps/${name}/`) ||
              new RegExp(`(^|/)apps/api/src/apps/${name}(/|$)`).test(spec)
            // The bundled app's code from server or web code (a test may read
            // its manifest or call its pure functions; nothing ships it).
            const bundledCode =
              new RegExp(`(^|/)bundled-apps/${name}/`).test(spec) &&
              !spec.endsWith("/app.manifest.json") &&
              !isTest(file)
            if (inTree || bundledCode) offenders.push(`${relative(REPO, file)}: ${spec}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("a manifest carrying trusted is refused, true or false, by the package and the runtime schema", () => {
    const pkg = {
      name: "third-party",
      version: "1.0.0",
      packageFormat: 1,
      license: "MIT",
      scopes: [],
    }
    for (const trusted of [true, false]) {
      expect(packageManifestSchema.safeParse({ ...pkg, trusted }).success).toBe(false)
      expect(validateAppManifest({ name: "third-party", version: "1.0.0", trusted })).toEqual({
        success: false,
        error: TRUSTED_FIELD_REFUSAL,
      })
    }
    expect(packageManifestSchema.safeParse(pkg).success).toBe(true)
  })

  it("no manifest of the repository carries trusted: the registry decides", () => {
    const carrying: string[] = []
    for (const root of [IN_TREE_APPS, BUNDLED_APPS, join(REPO, "apps/api/test-support/apps")]) {
      if (!existsSync(root)) continue
      for (const name of readdirSync(root)) {
        const path = join(root, name, "app.manifest.json")
        if (!existsSync(path)) continue
        if ("trusted" in (JSON.parse(readFileSync(path, "utf8")) as object)) {
          carrying.push(relative(REPO, path))
        }
      }
    }
    expect(carrying).toEqual([])
  })

  it("a core app is one of the seven shipped in the image: no claim or voucher makes another one", () => {
    for (const name of CORE_APP_NAMES) {
      expect(isCoreApp({ name })).toBe(true)
      expect(isCoreApp({ name, _installed: true })).toBe(false)
    }
    for (const name of MOVED_APPS.map((m) => m.name)) {
      for (const claim of [
        {},
        { trusted: true },
        { _firstParty: true },
        { _publisherSigned: true },
      ]) {
        expect(isCoreApp({ name, ...claim })).toBe(false)
        expect(isCoreApp({ name, _installed: true, ...claim })).toBe(false)
      }
    }
  })

  it("runApp has no trust option; only a site's own QuickJS placement runs in process", () => {
    // @ts-expect-error no site can ask runApp to treat an app's code as trusted.
    const _noTrust: Partial<RunAppOptions> = { trusted: true }
    void _noTrust
    expect(selectExecutor({})).toBe("pool")
    expect(selectExecutor({ sandboxService: true })).toBe("workerd")
    expect(selectExecutor({ workersBundleSha: "a".repeat(64) })).toBe("workers")
    expect(selectExecutor({ inProcess: true })).toBe("inprocess")
    expect(selectExecutor({ inProcess: true, sandboxService: true })).toBe("workerd")
  })

  it("the retired trust seams are gone from the server source", () => {
    const retired = [
      /\bhasPrivilegedBridge\b/,
      /\b_bridgeExtension\b/,
      /\b_registerHostTools\b/,
      /\bbridge-extensions\b/,
      /\bLIAISON_TRUSTED_SUMMARIZER_APPS\b/,
      /\bisSummarizerTrustCarveOutAllowed\b/,
      /\bdesc\.trusted\b/,
      /\bexportOnlyBundle\b/,
    ]
    const hits: string[] = []
    for (const file of sourceFiles(API_SRC)) {
      if (isTest(file) || file === import.meta.path) continue
      const text = readFileSync(file, "utf8")
      for (const re of retired) if (re.test(text)) hits.push(`${relative(REPO, file)}: ${re}`)
    }
    expect(hits).toEqual([])
  })
})
