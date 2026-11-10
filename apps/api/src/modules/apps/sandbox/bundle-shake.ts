// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Export-only handler bundles: the part of a bundle one export needs.
 *
 * QuickJS compiles every function of a script when it evaluates it (no lazy
 * parsing), so a sandboxed call that needs one handler pays to compile the
 * whole bundle: for an in-tree app's attention provider, 8-31 KB of source on
 * every feed poll, the provider itself being a few lines. This module keeps,
 * per (bundle content, export), the bundle tree-shaken down to that export
 * (`Bun.build` with the export as the only entry point, side-effectful
 * top-level statements kept), and the executor still evaluates it in a FRESH
 * context per call.
 *
 * ONLY CODE THE PLATFORM VOUCHES FOR IS SHAKEN. `Bun.build` runs in the API
 * process, and a bundler runs code of its own at build time (a macro import
 * runs whatever `onResolve` or `external` say). So the shake takes a trusted
 * app's bundle or a first-party one (in-tree, or the image's own catalog
 * tarball), never a third-party package (a signed publisher's included) or an
 * org's custom app: those always run their full bundle, in the sandbox only.
 * And a bundle carrying an import attribute (`with {` / `assert {`), or one
 * the TypeScript parser cannot read, is refused before any build, whoever it
 * comes from (import-attributes.ts).
 *
 * What is cached is source text derived from the bundle's bytes alone: no
 * caller data, no evaluated state, nothing one call can write and another
 * read. The key is the bundle content (a hash and its length: a new app
 * version, new bytes, misses and builds again) and the export it keeps. The
 * cache is bounded by the text of the export-only bundles it holds
 * (MAX_BYTES, sized from every first-party read-only handler warm at once) and
 * by its entry count.
 *
 * The build runs in the background: until it is done (or when it fails, or
 * when its output does not define the export as a global) the caller gets the
 * full bundle, exactly what it ran before. A build is a whole-bundle parse on
 * the API host (CPU, and part of it on the API thread), so builds queue and run
 * one at a time, and only while no sandboxed run that asked for one is in
 * flight (`holdingExportOnlyBuilds`): the burst of first calls a page open
 * makes is answered first, and the builds follow in the quiet after it. A build
 * that waits MAX_DEFER_MS runs anyway, so a host that is never idle still trims.
 */
import {
  esmExportsToGlobalThis,
  unwrapGlobalThisExports,
} from "~/modules/apps/sandbox/bundle-loader"
import { importAttributeIssue } from "~/modules/apps/sandbox/import-attributes"

/**
 * Export-only bundle text kept, in characters (bytes, for ASCII source). Every
 * first-party read-only handler warm at once, 268 of them, holds 48.2 M
 * (bundle-shake.test.ts measures it): all of them fit, so the population the
 * image ships never thrashes, and after an upgrade the old version's entries,
 * gone cold, are the ones evicted. Most of each trimmed handler is the schema
 * library the SDK's index pulls in: an app that only refuses (`refuseTool`)
 * imports it from `@liaison/app-sdk/errors` and leaves the library out.
 */
const MAX_BYTES = 48 * 1024 * 1024
/** Entries kept, any state: bounds the keys of bundles that hold no text. */
const MAX_ENTRIES = 2048
/** Builds waiting at once; a miss past it runs the full bundle and asks again later. */
const MAX_QUEUED = 512
/** Longest a queued build waits for the runs in flight to end before it runs anyway. */
const MAX_DEFER_MS = 30_000
/** How often a build held by runs in flight looks again. */
const RECHECK_MS = 250
/** The export names a bundle can be shaken for (they are interpolated). */
const SAFE_EXPORT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const ENTRY = "/liaison-export-only-entry.js"
type Entry = { state: "building" } | { state: "ready"; source: string } | { state: "full" }

const cache = new Map<string, Entry>()
let cachedBytes = 0
/** Sandboxed runs in flight that asked for an export-only bundle. */
let running = 0
let buildRunning = false
let buildTimer: ReturnType<typeof setTimeout> | null = null
const queue: Array<{ key: string; source: string; exportName: string; queuedAt: number }> = []

/** Who an app's code comes from, as the registry recorded it at install. */
export interface BundleProvenance {
  /** An in-tree or trusted app. */
  trusted?: boolean
  /** An in-tree app, or an install whose artifact is the image's own catalog tarball. */
  firstParty?: boolean
}

/** Does the platform vouch for this code, so the host may build over it? */
export function platformVouchesFor(provenance: BundleProvenance): boolean {
  return provenance.trusted === true || provenance.firstParty === true
}

function keyFor(source: string, exportName: string): string {
  return `${Bun.hash(source).toString(36)}:${source.length}:${exportName}`
}

const sizeOf = (entry: Entry | undefined): number =>
  entry?.state === "ready" ? entry.source.length : 0

function remember(key: string, entry: Entry): void {
  cachedBytes -= sizeOf(cache.get(key))
  cache.delete(key)
  cache.set(key, entry)
  cachedBytes += sizeOf(entry)
  while (cache.size > MAX_ENTRIES || cachedBytes > MAX_BYTES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cachedBytes -= sizeOf(cache.get(oldest))
    cache.delete(oldest)
  }
}

/**
 * Tree-shake `source` (a script-mode bundle whose top-level declarations are
 * its exports) down to `exportName`, returned in the same script shape: an
 * IIFE assigning `globalThis.<exportName>`. Null when the bundle cannot be
 * shaken (an IIFE-wrapped bundle, a syntax the bundler refuses, an import, an
 * import attribute). The caller has checked that the platform vouches for it.
 */
export async function buildExportOnlyBundle(
  source: string,
  exportName: string,
): Promise<string | null> {
  if (!SAFE_EXPORT_RE.test(exportName)) return null
  // Refused before the bundler sees it: a macro import runs during the build.
  if ((await importAttributeIssue(source)) !== null) return null
  // An installed bundle comes scoped, its exports assigned to globalThis
  // (bundle-loader.ts): shake its body, exporting the handler's local name.
  const scoped = unwrapGlobalThisExports(source)
  const local = scoped ? scoped.exports.get(exportName) : exportName
  if (!local) return null
  const contents = scoped
    ? `${scoped.body}\nexport { ${local} as ${exportName} };\n`
    : `${source}\nexport { ${exportName} };\n`
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
 * once built, else the full `source` (and the build is started). Code the
 * platform does not vouch for always gets its full `source`, and no build.
 */
export function exportOnlyBundle(
  source: string,
  exportName: string,
  provenance: BundleProvenance,
): string {
  if (!platformVouchesFor(provenance)) return source
  const key = keyFor(source, exportName)
  const hit = cache.get(key)
  if (hit) {
    remember(key, hit)
    return hit.state === "ready" ? hit.source : source
  }
  // The queue is full: this call runs the full bundle, a later one queues the build.
  if (queue.length >= MAX_QUEUED) return source
  remember(key, { state: "building" })
  queue.push({ key, source, exportName, queuedAt: performance.now() })
  scheduleBuild(0)
  return source
}

/**
 * Run `run` (a sandboxed run of a bundle `exportOnlyBundle` chose) with the
 * export-only builds held: none starts while a held run is in flight.
 */
export async function holdingExportOnlyBuilds<T>(run: () => Promise<T>): Promise<T> {
  running++
  try {
    return await run()
  } finally {
    running--
    if (running === 0) scheduleBuild(0)
  }
}

function scheduleBuild(delayMs: number): void {
  if (buildTimer || buildRunning || queue.length === 0) return
  buildTimer = setTimeout(startNextBuild, delayMs)
  buildTimer.unref?.()
}

function startNextBuild(): void {
  buildTimer = null
  const next = queue[0]
  if (buildRunning || !next) return
  if (running > 0 && performance.now() - next.queuedAt < MAX_DEFER_MS) {
    scheduleBuild(RECHECK_MS)
    return
  }
  queue.shift()
  const { key, source, exportName } = next
  // Evicted, or asked to use the full bundle, while it waited: nothing to build.
  if (cache.get(key)?.state !== "building") {
    scheduleBuild(0)
    return
  }
  buildRunning = true
  void buildExportOnlyBundle(source, exportName)
    .then(
      (shaken) => {
        if (cache.get(key)?.state === "building") {
          remember(key, shaken ? { state: "ready", source: shaken } : { state: "full" })
        }
      },
      () => {
        if (cache.get(key)?.state === "building") remember(key, { state: "full" })
      },
    )
    .finally(() => {
      buildRunning = false
      scheduleBuild(0)
    })
}

/**
 * Fall back to the full bundle for this export from now on: the export-only
 * bundle failed to load (evaluation error, missing export).
 */
export function useFullBundle(source: string, exportName: string): void {
  remember(keyFor(source, exportName), { state: "full" })
}

/**
 * `bridge` with every method call noted, so a caller can tell a bundle that
 * failed before its handler reached the host from a handler that failed
 * after. Each method keeps its kind (async or not), which decides how the
 * executor marshals it, and the non-enumerable marks the bridge carries.
 */
export function watchBridgeCalls(bridge: Record<string, any>): {
  bridge: Record<string, any>
  called: () => boolean
} {
  let called = false
  const out: Record<string, any> = {}
  for (const key of Reflect.ownKeys(bridge)) {
    const desc = Object.getOwnPropertyDescriptor(bridge, key)
    if (desc) Object.defineProperty(out, key, desc)
  }
  for (const [name, member] of Object.entries(bridge)) {
    if (typeof member !== "function") continue
    out[name] =
      member.constructor.name === "AsyncFunction"
        ? async (...args: unknown[]) => {
            called = true
            return await member(...args)
          }
        : (...args: unknown[]) => {
            called = true
            return member(...args)
          }
  }
  return { bridge: out, called: () => called }
}

/** Cache size (entries), for tests. */
export function exportOnlyBundleCacheSize(): number {
  return cache.size
}

/** Bytes of export-only bundle text the cache holds, for tests. */
export function exportOnlyBundleCacheBytes(): number {
  return cachedBytes
}

/** Clear the cache (for tests). */
export function clearExportOnlyBundleCache(): void {
  cache.clear()
  cachedBytes = 0
  queue.length = 0
}
