// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Export-only handler bundles: the part of a bundle one export needs.
 *
 * QuickJS compiles every function of a script when it evaluates it (no lazy
 * parsing), so a sandboxed call that needs one handler pays to compile the
 * whole bundle: for an in-tree app's attention provider, 8-31 KB of source on
 * every feed poll, the provider itself being a few lines. This module keeps,
 * per (bundle content, export name), the bundle tree-shaken down to that
 * export (`Bun.build` with the export as the only entry point, side-effectful
 * top-level statements kept), and the executor still evaluates it in a FRESH
 * context per call.
 *
 * What is cached is source text derived from the bundle's bytes alone: no
 * caller data, no evaluated state, nothing one call can write and another
 * read. The key is the SHA-256 of the bundle source plus the export name, so
 * an app upgrade (new bundle bytes) misses and builds again; the cache is an
 * LRU of at most MAX_ENTRIES entries whatever the org count (orgs running the
 * same app version share its bundle text, hence its key).
 *
 * The build runs in the background: until it is done (or when it fails, or
 * when its output does not define the export as a global) the caller gets the
 * full bundle, exactly what it ran before.
 */
import { esmExportsToGlobalThis } from "~/modules/apps/sandbox/bundle-loader"

const MAX_ENTRIES = 64
/** The export names a bundle can be shaken for (they are interpolated). */
const SAFE_EXPORT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const ENTRY = "/liaison-export-only-entry.js"

type Entry = { state: "building" } | { state: "ready"; source: string } | { state: "full" }

const cache = new Map<string, Entry>()

function keyFor(source: string, exportName: string): string {
  return `${new Bun.CryptoHasher("sha256").update(source).digest("hex")}:${exportName}`
}

function remember(key: string, entry: Entry): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/**
 * Tree-shake `source` (a script-mode bundle whose top-level declarations are
 * its exports) down to `exportName`, returned in the same script shape: an
 * IIFE assigning `globalThis.<exportName>`. Null when the bundle cannot be
 * shaken (an IIFE-wrapped bundle, a syntax the bundler refuses, an import).
 */
export async function buildExportOnlyBundle(
  source: string,
  exportName: string,
): Promise<string | null> {
  if (!SAFE_EXPORT_RE.test(exportName)) return null
  const contents = `${source}\nexport { ${exportName} };\n`
  let output: string
  try {
    const built = await Bun.build({
      entrypoints: [ENTRY],
      target: "browser",
      format: "esm",
      // A handler bundle is self-contained: an import would not run in the
      // sandbox either, so refuse rather than resolve one.
      external: ["*"],
      plugins: [
        {
          name: "liaison-export-only",
          setup(build) {
            build.onResolve({ filter: /^\/liaison-export-only-entry\.js$/ }, (args) => ({
              path: args.path,
              namespace: "liaison-export-only",
            }))
            build.onLoad({ filter: /.*/, namespace: "liaison-export-only" }, () => ({
              contents,
              loader: "js",
            }))
          },
        },
      ],
    })
    const out = built.success ? built.outputs[0] : undefined
    if (!out || built.outputs.length !== 1) return null
    output = await out.text()
  } catch {
    return null
  }
  if (/^\s*import[\s{*]/m.test(output)) return null
  const shaped = esmExportsToGlobalThis(output)
  // The executor finds the handler as a global: anything else is the full bundle.
  if (!shaped.includes(`\nglobalThis.${exportName} = `)) return null
  return shaped
}

/**
 * The bundle to evaluate for a call of `exportName`: the export-only bundle
 * once built, else the full `source` (and the build is started).
 */
export function exportOnlyBundle(source: string, exportName: string): string {
  const key = keyFor(source, exportName)
  const hit = cache.get(key)
  if (hit) {
    remember(key, hit)
    return hit.state === "ready" ? hit.source : source
  }
  remember(key, { state: "building" })
  void buildExportOnlyBundle(source, exportName).then(
    (shaken) => {
      if (cache.get(key)?.state === "building") {
        remember(key, shaken ? { state: "ready", source: shaken } : { state: "full" })
      }
    },
    () => {
      if (cache.get(key)?.state === "building") remember(key, { state: "full" })
    },
  )
  return source
}

/**
 * Fall back to the full bundle for this export from now on: the export-only
 * bundle failed to load (evaluation error, missing export).
 */
export function useFullBundle(source: string, exportName: string): void {
  remember(keyFor(source, exportName), { state: "full" })
}

/** Cache size and contents, for tests. */
export function exportOnlyBundleCacheSize(): number {
  return cache.size
}

/** Clear the cache (for tests). */
export function clearExportOnlyBundleCache(): void {
  cache.clear()
}
