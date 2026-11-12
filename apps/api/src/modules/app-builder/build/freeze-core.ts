// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The packaging steps shared by the `app:freeze` CLI (scripts/freeze-app.ts), the
// Worker-module CLI (scripts/apps-build-worker-bundle.ts) and the in-product draft
// build (./build-worker.ts). One copy of each step, so a draft package has exactly
// the shape of a catalog package, and the CLI output stays byte-identical.
//
// Pure helpers only: no database, no `~/` imports (the CLIs run outside apps/api).
import { spawnSync } from "node:child_process"
import { chmodSync, utimesSync } from "node:fs"
import { join, resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { type PackageManifest, packageManifestSchema } from "@liaison/app-sdk"

/** The repo root (where packages/ and node_modules/ live), from this file's place. */
export const REPO_ROOT = resolve(import.meta.dir, "../../../../../..")

/** The Worker module's entry and core (apps/api/src/modules/apps/workers). */
export const WORKER_ENTRY = join(REPO_ROOT, "apps/api/src/modules/apps/workers/worker-entry.ts")
export const WORKER_CORE = join(REPO_ROOT, "apps/api/src/modules/apps/workers/worker-core.ts")

/** The UI bundle's shared Solid runtime: served by the host's import-map shims. */
export const UI_EXTERNALS = ["solid-js", "solid-js/web", "solid-js/store"] as const

export type ManifestCheck =
  | { ok: true; manifest: PackageManifest }
  | { ok: false; messages: string[]; trusted: boolean }

/** Validate a raw manifest against the package format (packageManifestSchema). */
export function checkPackageManifest(raw: unknown): ManifestCheck {
  const result = packageManifestSchema.safeParse(raw)
  if (result.success) return { ok: true, manifest: result.data }
  return {
    ok: false,
    messages: result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    trusted: (raw as { trusted?: unknown } | null)?.trusted === true,
  }
}

/** The freeze's error text for a manifest `checkPackageManifest` refused. */
export function manifestErrorMessage(check: { messages: string[]; trusted: boolean }): string {
  // Surface the `trusted: true` rejection explicitly — installed apps can
  // never be trusted, and the freeze tool fails loud at the source.
  if (check.trusted) {
    return `Manifest declares "trusted: true" — installed apps are always sandboxed and cannot claim trust. Remove the field. (${check.messages.join("; ")})`
  }
  return `Invalid app manifest: ${check.messages.join("; ")}`
}

/**
 * Phase 16 Task A6 — the first webhook whose `handler` or `verify` export is
 * missing from the built bundle, as an error message, or null. Read from the raw
 * manifest because the SDK's zod schema strips unknown keys (webhooks live in the
 * runtime manifest, not the packaging manifest).
 */
export function webhookExportError(raw: unknown, bundleSource: string): string | null {
  const rawWebhooks = (raw as { webhooks?: Record<string, { handler: string; verify: string }> })
    .webhooks
  if (!rawWebhooks) return null
  for (const [topic, entry] of Object.entries(rawWebhooks)) {
    for (const role of ["handler", "verify"] as const) {
      const exportName = entry[role]
      if (!exportName) return `webhook '${topic}': missing '${role}' in manifest`
      if (!isExportPresentInBundle(bundleSource, exportName)) {
        return `webhook '${topic}': ${role} export '${exportName}' not found in built bundle`
      }
    }
  }
  return null
}

/** The Bun.build log lines of a failed build, or a fallback when it gave none. */
export function bunBuildFailureDetail(logs: ReadonlyArray<unknown>): string {
  return logs.length
    ? logs.map(String).join("\n")
    : "<bun.build returned no logs — entry resolution or transformer failure>"
}

/**
 * The generated entry of an app's Worker module: default export = the
 * WorkerEntrypoint whose run(req, bridge) dispatches into the app's handlers.
 */
export function workerEntrySource(handlersPath: string, entryPath = WORKER_ENTRY): string {
  return [
    `import * as handlers from ${JSON.stringify(handlersPath)}`,
    `import { createWorkerEntrypoint } from ${JSON.stringify(entryPath)}`,
    `export default createWorkerEntrypoint(handlers as Record<string, unknown>)`,
    "",
  ].join("\n")
}

/** The generated entry of the Cloudflare-free core (`export function run(req, bridge)`). */
export function workerCoreEntrySource(handlersPath: string, corePath = WORKER_CORE): string {
  return [
    `import * as handlers from ${JSON.stringify(handlersPath)}`,
    `import { runWithBridge, type WorkerBridge, type WorkerRunRequest } from ${JSON.stringify(corePath)}`,
    "export function run(req: WorkerRunRequest, bridge: WorkerBridge) {",
    "  return runWithBridge(handlers as Record<string, unknown>, req, bridge)",
    "}",
    "",
  ].join("\n")
}

/** The first Node builtin a Worker module still imports, or null (Workers have none). */
export function workerNodeImport(text: string): string | null {
  return /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']node:[^"']+["']/.exec(text)?.[0] ?? null
}

/**
 * The directories (repo-relative) of the platform code a Worker module inlines
 * besides the app's own sources and the workspace packages: the entry and core
 * (workers/) and what they import from the sandbox (sandbox/). A change there
 * changes every app's worker.js, so the bundled-app version guard
 * (scripts/check-bundled-app-version.ts) treats these like `packages/`, and
 * `buildWorkerModule` refuses to inline platform code from anywhere else.
 */
export const WORKER_RUNTIME_DIRS = [
  "apps/api/src/modules/apps/workers/",
  "apps/api/src/modules/apps/sandbox/",
] as const

/** The Worker module's file name inside a `.liaisonapp`, beside `bundle.js`. */
export const WORKER_MODULE_FILE = "worker.js"

const WORKER_ENTRY_SPECIFIER = "liaison-worker-entry.ts"

export interface WorkerModuleBuild {
  /** The module's text (ES module, default export = the WorkerEntrypoint). */
  text: string
  /** The bundler's metafile outputs (paths relative to the process's cwd). */
  outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }>
}

/**
 * Build an app's Worker module in process: the generated entry (or, with
 * `core`, the Cloudflare-free core entry) is served as a virtual module, so no
 * temporary path reaches the output and the bytes depend only on the sources
 * (and, like bundle.js, on the process's cwd: run from the repo root). Fails
 * when the module still imports a Node builtin. `plugins` run first (a source
 * overlay).
 */
export async function buildWorkerModule(opts: {
  handlersPath: string
  core?: boolean
  plugins?: Bun.BunPlugin[]
}): Promise<WorkerModuleBuild> {
  const source = opts.core
    ? workerCoreEntrySource(opts.handlersPath)
    : workerEntrySource(opts.handlersPath)
  const entryPlugin: Bun.BunPlugin = {
    name: "liaison-worker-entry",
    setup(build) {
      build.onResolve({ filter: /^liaison-worker-entry\.ts$/ }, () => ({
        path: WORKER_ENTRY_SPECIFIER,
        namespace: "liaison-worker",
      }))
      build.onLoad({ filter: /.*/, namespace: "liaison-worker" }, () => ({
        contents: source,
        loader: "ts",
      }))
    },
  }
  const result = await Bun.build({
    entrypoints: [WORKER_ENTRY_SPECIFIER],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
    metafile: true,
    plugins: [...(opts.plugins ?? []), entryPlugin],
  })
  if (!result.success) {
    throw new Error(`Worker module failed: ${bunBuildFailureDetail(result.logs)}`)
  }
  const text = await result.outputs[0].text()
  const nodeImport = workerNodeImport(text)
  if (nodeImport) throw new Error(`the Worker module still imports a Node builtin: ${nodeImport}`)
  return {
    text,
    outputs: (result.metafile?.outputs ?? {}) as WorkerModuleBuild["outputs"],
  }
}

// Every packaged file's mtime, so the tar headers never carry the build time.
const FIXED_MTIME = new Date("2000-01-01T00:00:00Z")

/**
 * Pack `files` (relative to `stage`) into a gzipped tar whose bytes depend only on
 * the files' contents: sorted entries, fixed mtime and mode, owner 0:0 without
 * names, no extended attributes, and a gzip header without a timestamp.
 *
 * The artifact sha256 is the install's identity: the catalog reconcile reinstalls
 * a first-party app whose stored sha256 differs from the tarball the image bakes.
 * A tarball stamped with build-time metadata changes sha on every image build,
 * so every deploy reinstalled every catalog app although nothing in it changed.
 */
export function reproducibleTarGz(stage: string, files: string[]): Buffer {
  const sorted = [...files].sort()
  for (const f of sorted) {
    chmodSync(join(stage, f), 0o644)
    utimesSync(join(stage, f), FIXED_MTIME, FIXED_MTIME)
  }
  const version = spawnSync("tar", ["--version"]).stdout?.toString() ?? ""
  const ownerFlags = version.includes("GNU tar")
    ? ["--owner=0", "--group=0", "--numeric-owner", "--format=gnu"]
    : ["--uid", "0", "--gid", "0", "--uname", "", "--gname", "", "--format=ustar"]
  const tarRes = spawnSync("tar", ["-cf", "-", ...ownerFlags, "-C", stage, ...sorted], {
    // macOS tar otherwise adds AppleDouble entries for extended attributes.
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    maxBuffer: 1024 * 1024 * 1024,
  })
  if (tarRes.status !== 0) {
    throw new Error(`tar failed: ${tarRes.stderr?.toString() ?? "unknown error"}`)
  }
  // zlib writes a zero MTIME and no file name into the gzip header.
  return gzipSync(tarRes.stdout, { level: 9 })
}

/**
 * Strip the trailing ESM `export { ... };` block Bun.build (target:"bun",
 * format:"esm") emits. QuickJS `evalCode` is script-mode and rejects a bare
 * `export` statement; PDF template bundles bind their export to
 * `globalThis.renderTemplate` instead. Mirrors the handler bundle-loader's
 * `esmExportsToGlobalThis`.
 */
export function stripEsmExportBlock(source: string): string {
  return source.replace(/\nexport\s*\{[\s\S]*?\}\s*;?\s*$/, "\n")
}

/**
 * Resolve the LOCAL binding name that a Bun.build ESM bundle exports as
 * `exportName`, from the trailing `export { ... };` block. Returns:
 *   - the local name for `export { local as exportName }` (alias / bundler-rename),
 *   - `exportName` for a bare `export { exportName }` (local === exported),
 *   - `null` when the bundle does not export `exportName` (e.g. only a default
 *     export, or no such export) — caller fails the freeze with a clear error.
 * This lets the PDF-template binding `globalThis.renderTemplate = <local>` use
 * the real local identifier rather than assuming it equals `renderTemplate`.
 */
export function resolveExportedLocalName(source: string, exportName: string): string | null {
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exportName)) return null
  const block = source.match(/export\s*\{([\s\S]*?)\}\s*;?\s*$/)
  if (!block) return null
  for (const spec of block[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const aliased = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
    if (aliased) {
      if (aliased[2] === exportName) return aliased[1]
    } else if (spec === exportName) {
      return exportName
    }
  }
  return null
}

/**
 * Phase 16 Task A6 — light export-presence check on the built bundle.
 * Bun.build emits ES-module bundles whose exports appear as one of:
 *   export {NAME}, export {NAME as ...}, export {... as NAME},
 *   export const NAME, export function NAME, export async function NAME, export class NAME,
 *   or `... NAME };` re-exports.
 * The check is intentionally textual — robust enough to catch fat-finger typos and
 * deleted exports without booting a sandbox. A false-positive on minified output
 * is acceptable for now (freeze is run on un-minified Bun.build output).
 */
export function isExportPresentInBundle(source: string, exportName: string): boolean {
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(exportName)) return false
  const escaped = exportName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
  const patterns = [
    new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\bexport\\s+class\\s+${escaped}\\b`),
    // `export { foo, bar, NAME }` — anywhere in a named-export list.
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
    // `export { other as NAME }` — aliased re-export.
    new RegExp(`\\bas\\s+${escaped}\\b[^}]*\\}`),
  ]
  return patterns.some((p) => p.test(source))
}
