// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Loads and transpiles TypeScript app handler bundles for QuickJS execution.
 * Bundles are cached after first transpilation since source doesn't change at runtime.
 *
 * Bundled-app SIDE CHANNEL (dev/test): for first-party apps that live in-repo
 * under `bundled-apps/<name>/`, the handler bundle is built from SOURCE on
 * demand instead of read from the installed `.liaisonapp` tarball — so editing
 * a handler takes effect on the next run with NO freeze + reinstall. Off in
 * production; gated by `LIAISON_BUNDLED_APPS_FROM_SOURCE` (1/0). Only the
 * handler *logic* is hot-swapped — manifest changes (new tools/events/handler
 * names) still require a reinstall, since registration reads the manifest.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" })
const cache = new Map<string, string>()

// bundle-loader.ts → liaison repo root (apps/api/src/modules/apps/sandbox → up 6).
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")

function sourceChannelEnabled(): boolean {
  const v = process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE
  if (v === "0" || v === "false") return false
  if (v === "1" || v === "true") return true
  return process.env.NODE_ENV !== "production" // default ON outside production
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git"])
function newestMtimeMs(dir: string): number {
  let newest = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    newest = e.isDirectory()
      ? Math.max(newest, newestMtimeMs(p))
      : Math.max(newest, statSync(p).mtimeMs)
  }
  return newest
}

/**
 * If `bundlePath` (`<root>/<name>/<version>/bundle.js`) belongs to an in-repo
 * bundled app whose `handlers.ts` source exists, return its source-build inputs;
 * else null (→ load the installed bundle as usual). Kernel apps and 3rd-party
 * installs have no `bundled-apps/<name>/handlers.ts`, so they fall through.
 */
function bundledAppSource(
  bundlePath: string,
): { appName: string; appDir: string; entry: string } | null {
  if (basename(bundlePath) !== "bundle.js") return null
  const appName = basename(dirname(dirname(bundlePath)))
  if (!appName) return null
  const appDir = join(REPO_ROOT, "bundled-apps", appName)
  const entry = join(appDir, "handlers.ts")
  return existsSync(entry) ? { appName, appDir, entry } : null
}

/**
 * Message prefixes the sandbox executor and worker put on a failure to LOAD an
 * app's handler bundle (shim, evaluation, missing export). The worker pool
 * rebuilds errors from plain strings across IPC, so the prefix, not a class, is
 * what survives both execution paths.
 */
const BUNDLE_LOAD_ERROR_PREFIXES = [
  "Bundle evaluation error",
  "Context shim error",
  "Bundle load error",
  "Export ",
]

/** Thrown when a bundle file cannot be read or transpiled. */
export class BundleLoadError extends Error {
  constructor(bundlePath: string, cause: unknown) {
    super(`Bundle load error: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    })
    this.name = "BundleLoadError"
    this.bundlePath = bundlePath
  }
  readonly bundlePath: string
}

/**
 * True when `err` is the app bundle failing to load or evaluate (as opposed to
 * a verifier or handler rejecting a request), so callers can answer with a
 * server error and log the real cause instead of treating it as a bad request.
 */
export function isBundleLoadError(err: unknown): boolean {
  if (err instanceof BundleLoadError) return true
  if (!(err instanceof Error)) return false
  if (err.message.startsWith("Export ")) return /not found/.test(err.message)
  return BUNDLE_LOAD_ERROR_PREFIXES.some((p) => err.message.startsWith(p))
}

export async function loadBundle(bundlePath: string): Promise<string> {
  try {
    return await loadBundleUnwrapped(bundlePath)
  } catch (err) {
    throw err instanceof BundleLoadError ? err : new BundleLoadError(bundlePath, err)
  }
}

async function loadBundleUnwrapped(bundlePath: string): Promise<string> {
  // SIDE CHANNEL: build the handler bundle from in-repo source (dev/test).
  if (sourceChannelEnabled()) {
    const src = bundledAppSource(bundlePath)
    if (src) {
      const key = `src:${src.appName}:${newestMtimeMs(src.appDir)}`
      const hit = cache.get(key)
      if (hit) return hit
      const built = await Bun.build({
        entrypoints: [src.entry],
        target: "bun",
        external: ["node:*"],
      })
      if (built.success && built.outputs[0]) {
        const transformed = esmExportsToGlobalThis(await built.outputs[0].text())
        cache.set(key, transformed)
        return transformed
      }
      // Build failed → fall through to the installed bundle rather than break
      // the runtime; the build error surfaces via the normal freeze/install path.
    }
  }

  const cached = cache.get(bundlePath)
  if (cached) return cached

  const source = await Bun.file(bundlePath).text()

  // Plain JS bundles don't need transpilation, but we DO need to convert
  // the Bun.build ESM `export {...}` block into globalThis assignments so
  // the QuickJS sandbox's script-mode `evalCode` can resolve the named
  // exports as globals (the executor reads them via `ctx.getProp(ctx.global, exportName)`).
  if (bundlePath.endsWith(".js")) {
    const transformed = esmExportsToGlobalThis(source)
    cache.set(bundlePath, transformed)
    return transformed
  }

  const js = transpiler.transformSync(source)
  cache.set(bundlePath, esmExportsToGlobalThis(js))
  return cache.get(bundlePath) as string
}

/**
 * Rewrite the trailing `export { a, b as c, d };` block emitted by Bun.build
 * (target:"bun", format:"esm") into `globalThis.a = a; globalThis.c = c;
 * globalThis.d = d;` assignments. QuickJS evalCode is script-mode and
 * rejects the bare `export` statement; the sandbox executor then can't
 * resolve the named export as a global.
 *
 * Conservative: only matches the canonical Bun output shape (single
 * top-level `export { ... };` block at end of file) — leaves any other
 * `export` forms untouched (those would be a build-pipeline bug).
 */
export function esmExportsToGlobalThis(source: string): string {
  const match = source.match(/\nexport\s*\{([\s\S]*?)\}\s*;?\s*$/)
  if (!match) return source
  const body = source.slice(0, match.index)
  const assignments = match[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      // Handles both `foo` and `foo as bar` — alias is the exported name.
      const parts = entry.split(/\s+as\s+/)
      const local = parts[0]!.trim()
      const exported = (parts[1] ?? parts[0]!).trim()
      return `globalThis.${exported} = ${local};`
    })
    .join("\n")
  // The bundle body runs inside a function scope, NOT at script top level. In script mode
  // every top-level declaration is itself a global, so `globalThis.foo = foo2;` (a
  // bundler-renamed export, e.g. a wrapper re-exported under the name of the function it
  // wraps) would overwrite the original `foo` that other bundle code still calls: the wrapper
  // then called itself until the sandbox stack overflowed. With the body scoped, the export
  // globals are the only globals the bundle defines and its internal references stay lexical.
  return `(function () {\n${body}\n${assignments}\n})();\n`
}

/** Clear the bundle cache (for tests). */
export function clearBundleCache(): void {
  cache.clear()
}
