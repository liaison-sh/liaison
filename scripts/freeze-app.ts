// SPDX-License-Identifier: FSL-1.1-ALv2
// `bun run app:freeze <app-name>` — package an in-tree app directory into a
// distributable `.liaisonapp` tarball.
//
// Run from the monorepo root (where package.json lives). The script resolves
// the app dir as `<repoRoot>/apps/api/src/apps/<name>` and never depends on the
// current working directory being `apps/api`.
//
// The build runs entirely inside an isolated staging dir — the source tree never
// receives a generated `bundle.js` / `ui.js`.
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { type PackageManifest, packageManifestSchema } from "@liaison/app-sdk"
import { build as esbuild } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import { findUnsupportedBundleImports, readAllShimExports } from "./lib/app-runtime-shims"

export interface FreezeOptions {
  appName: string
  /** Monorepo root (where package.json lives). Defaults to process.cwd(). */
  repoRoot?: string
  /** Output directory for the tarball. Defaults to `<repoRoot>/dist/apps`. */
  outDir?: string
  /**
   * Phase 16 — Explicit app source directory. When set, overrides the default
   * `<repoRoot>/apps/api/src/apps/<appName>` resolution. Used for out-of-tree
   * plugin apps that live outside `liaison/` (e.g. `bundled-apps/shopify/`
   * in the wrapper monorepo).
   */
  appDir?: string
  /**
   * Contents to bundle in place of these repo files (repo-relative path → text), read
   * from nowhere else: the bundled-app version guard builds a package as it would be
   * with some shared files at their previous contents, without touching the tree.
   * JSX files cannot be overlaid (the Solid transform reads them from disk): the
   * freeze throws when the UI bundle reaches one.
   */
  sourceOverrides?: ReadonlyMap<string, string>
}

export interface FreezeResult {
  tarballPath: string
  manifest: PackageManifest
  /**
   * Every repo file whose bytes reach the package, `/`-separated and relative to
   * `repoRoot`, sorted: the bundlers' inputs that put code in an output (the app's
   * own sources and the workspace packages it inlines, e.g. `packages/app-sdk`)
   * and the files copied verbatim. A workspace package the bundlers read from the
   * app's installed copy is reported at its `packages/` path (see `workspaceFileOf`).
   * Installed npm dependencies are left out. The bundled-app version guard
   * (scripts/check-bundled-app-version.ts) reads it, so a change to any of these
   * files is a change to the package.
   */
  sources: string[]
}

const LOADERS = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  json: "json",
} as const

/** Workspace packages by name: `@liaison/host` -> `packages/host-sdk`. */
function readWorkspacePackages(repoRoot: string): ReadonlyMap<string, string> {
  const packages = new Map<string, string>()
  const packagesDir = join(repoRoot, "packages")
  if (!existsSync(packagesDir)) return packages
  for (const dir of readdirSync(packagesDir)) {
    const manifestPath = join(packagesDir, dir, "package.json")
    if (!existsSync(manifestPath)) continue
    const { name } = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string }
    if (name) packages.set(name, `packages/${dir}`)
  }
  return packages
}

/**
 * The `packages/` file an installed path stands for, or null when it is a real npm
 * dependency. scripts/build-bundled-app.sh runs `bun install` in the app, which
 * installs its `file:` dependencies as copies under `bundled-apps/<app>/node_modules/`,
 * and from then on the bundlers read those instead of `packages/`. Which of the two
 * happens depends only on whether that checkout has built the app.
 */
function workspaceFileOf(
  installedPath: string,
  workspacePackages: ReadonlyMap<string, string>,
): string | null {
  const parts = installedPath.split("/")
  const after = parts.slice(parts.lastIndexOf("node_modules") + 1)
  const dir = workspacePackages.get(after.slice(0, 2).join("/"))
  return dir ? [dir, ...after.slice(2)].join("/") : null
}

/**
 * Serve `overrides` (absolute path -> contents) to a Bun or esbuild build in place of
 * the disk, and `copies` the same way (a path from `node_modules/` on -> contents) for
 * a file the bundlers reach through an app's installed copy.
 */
function overlayPlugin(
  overrides: ReadonlyMap<string, string>,
  copies: ReadonlyMap<string, string>,
  refuseJsx: boolean,
) {
  const escapeRe = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const filter = new RegExp(
    `^(?:${[
      ...[...overrides.keys()].map(escapeRe),
      ...[...copies.keys()].map((k) => `.*/${escapeRe(k)}`),
    ].join("|")})$`,
  )
  return {
    name: "liaison-source-overlay",
    setup(build: {
      onLoad: (
        o: { filter: RegExp },
        cb: (args: { path: string }) => {
          contents: string
          loader: (typeof LOADERS)[keyof typeof LOADERS]
        },
      ) => void
    }) {
      build.onLoad({ filter }, (args) => {
        const ext = args.path.split(".").pop() ?? ""
        const loader = LOADERS[ext as keyof typeof LOADERS]
        if (!loader || (refuseJsx && (loader === "tsx" || loader === "jsx"))) {
          throw new Error(`cannot overlay ${args.path}`)
        }
        const contents =
          overrides.get(args.path) ??
          copies.get(args.path.slice(args.path.lastIndexOf("/node_modules/") + 1))
        if (contents === undefined) throw new Error(`no overlay for ${args.path}`)
        return { contents, loader }
      })
    },
  }
}

type BundleOutputs = Record<string, { inputs: Record<string, { bytesInOutput: number }> }>

/** Repo-relative paths of the inputs that put bytes in any of `outputs`. */
function bundleSources(
  outputs: BundleOutputs | undefined,
  pathBase: string,
  repoRoot: string,
  workspacePackages: ReadonlyMap<string, string>,
): string[] {
  if (!outputs) throw new Error("the bundler returned no metafile")
  const root = realpathSync(repoRoot)
  const out: string[] = []
  for (const output of Object.values(outputs)) {
    for (const [input, info] of Object.entries(output.inputs)) {
      if (info.bytesInOutput <= 0) continue
      const abs = resolve(pathBase, input)
      if (!existsSync(abs)) continue // a plugin's virtual module
      const real = realpathSync(abs)
      const rel = relative(root, real).split("\\").join("/")
      if (rel.startsWith("../") || isAbsolute(rel)) continue
      if (!rel.split("/").includes("node_modules")) {
        out.push(rel)
        continue
      }
      const source = workspaceFileOf(rel, workspacePackages)
      if (!source) continue // an npm dependency
      // A package built from a copy older than its source would carry code nobody
      // reviewed under this version, and hide a shared change from the version guard.
      const sourceAbs = join(root, source)
      if (!existsSync(sourceAbs) || !readFileSync(real).equals(readFileSync(sourceAbs))) {
        throw new Error(
          `${rel} differs from ${source}: the installed copy is stale. Run \`bun install\` in the app's directory.`,
        )
      }
      out.push(source)
    }
  }
  return out
}

export async function freezeApp(opts: FreezeOptions): Promise<FreezeResult> {
  const repoRoot = opts.repoRoot ?? process.cwd()
  const appDir = opts.appDir ?? join(repoRoot, "apps/api/src/apps", opts.appName)
  const manifestPath = join(appDir, "app.manifest.json")
  if (!existsSync(manifestPath)) {
    throw new Error(`No app manifest at ${manifestPath}`)
  }

  const raw = JSON.parse(readFileSync(manifestPath, "utf8"))
  const sources = new Set<string>()
  const workspacePackages = readWorkspacePackages(repoRoot)
  const overrides = new Map<string, string>()
  const copies = new Map<string, string>()
  for (const [rel, contents] of opts.sourceOverrides ?? []) {
    overrides.set(resolve(realpathSync(repoRoot), rel), contents)
    for (const [name, dir] of workspacePackages) {
      if (rel.startsWith(`${dir}/`)) {
        copies.set(`node_modules/${name}/${rel.slice(dir.length + 1)}`, contents)
      }
    }
  }
  const bunPlugins = overrides.size > 0 ? [overlayPlugin(overrides, copies, false)] : []
  // First, so it answers before the Solid transform's own onLoad.
  const esbuildPlugins = overrides.size > 0 ? [overlayPlugin(overrides, copies, true)] : []
  const appSource = (name: string) =>
    relative(realpathSync(repoRoot), realpathSync(join(appDir, name)))
      .split("\\")
      .join("/")
  const result = packageManifestSchema.safeParse(raw)
  if (!result.success) {
    const messages = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
    // Surface the `trusted: true` rejection explicitly — installed apps can
    // never be trusted, and the freeze tool fails loud at the source.
    if (raw.trusted === true) {
      throw new Error(
        `Manifest declares "trusted: true" — installed apps are always sandboxed and cannot claim trust. Remove the field. (${messages.join("; ")})`,
      )
    }
    throw new Error(`Invalid app manifest: ${messages.join("; ")}`)
  }
  const manifest = result.data

  const outDir = opts.outDir ?? join(repoRoot, "dist/apps")
  mkdirSync(outDir, { recursive: true })

  // Build into an isolated staging dir so the source tree never receives
  // generated artifacts — keeps `apps/api/src/apps/<name>/` clean and prevents
  // discovery from confusing an in-tree app with an installed-app shape.
  const stage = mkdtempSync(join(tmpdir(), `liaison-freeze-${manifest.name}-`))
  try {
    copyFileSync(manifestPath, join(stage, "app.manifest.json"))
    sources.add(appSource("app.manifest.json"))

    const handlersEntry = join(appDir, "handlers.ts")
    if (!existsSync(handlersEntry)) {
      throw new Error(`No handlers.ts at ${handlersEntry}`)
    }
    // Handler bundles run in the sandbox HOST (Bun worker), not the browser —
    // they import `node:crypto`, `node:buffer`, etc. via `@liaison/app-sdk`
    // and direct usage in webhook verifiers. Browser target rejects those.
    // Only the optional UI bundle below uses `target: "browser"`.
    const build = await Bun.build({
      entrypoints: [handlersEntry],
      outdir: stage,
      naming: "bundle.js",
      target: "bun",
      external: ["node:*"],
      metafile: true,
      plugins: bunPlugins,
    })
    if (!build.success) {
      const detail = build.logs.length
        ? build.logs.map(String).join("\n")
        : "<bun.build returned no logs — entry resolution or transformer failure>"
      throw new Error(`Bundle failed: ${detail}`)
    }
    // Bun.build reports metafile paths relative to the process's cwd.
    for (const p of bundleSources(
      build.metafile?.outputs,
      process.cwd(),
      repoRoot,
      workspacePackages,
    )) {
      sources.add(p)
    }

    // Phase 16 Task A6 — verify every webhook's `handler` AND `verify` export
    // resolves to a callable in the built bundle. Fails freeze with a clear
    // error if missing. Read from the raw manifest because the SDK's zod
    // schema strips unknown keys (webhooks live in the runtime manifest, not
    // the packaging manifest).
    const builtBundlePath = join(stage, "bundle.js")
    const builtBundleSource = readFileSync(builtBundlePath, "utf8")
    const rawWebhooks = (raw as { webhooks?: Record<string, { handler: string; verify: string }> })
      .webhooks
    if (rawWebhooks) {
      for (const [topic, entry] of Object.entries(rawWebhooks)) {
        for (const role of ["handler", "verify"] as const) {
          const exportName = entry[role]
          if (!exportName) {
            throw new Error(`webhook '${topic}': missing '${role}' in manifest`)
          }
          if (!isExportPresentInBundle(builtBundleSource, exportName)) {
            throw new Error(
              `webhook '${topic}': ${role} export '${exportName}' not found in built bundle`,
            )
          }
        }
      }
    }

    // Optional frontend UI bundle (Phase 16.5). Build with target:"browser" and
    // externalize solid-js / solid-js/web / solid-js/store so the kernel + the
    // plugin share one reactive runtime (resolved at runtime via the import map
    // in apps/web/index.html). esbuild + esbuild-plugin-solid is used here
    // because Bun.build's default JSX transform is React-style and lacks a
    // SolidJS preset — the preflight probe confirmed Bun.build would emit
    // unusable output.
    const uiEntry = join(appDir, "ui.tsx")
    if (existsSync(uiEntry)) {
      const uiBuild = await esbuild({
        entryPoints: [uiEntry],
        bundle: true,
        format: "esm",
        outfile: join(stage, "ui.js"),
        platform: "browser",
        // Phase 16.6 — `@liaison/host` is NOT externalized. The package is bundled
        // INTO this plugin's ui.js so the `__LIAISON_APP_NAME__` substitution below
        // takes effect (module caching would otherwise force one shim instance to
        // serve all plugins simultaneously). The package's runtime body reads from
        // window.__liaisonHost, so the bundled copy is small and stateless.
        external: ["solid-js", "solid-js/web", "solid-js/store"],
        // Anchor module resolution at the repo root so `@liaison/host` resolves
        // via `<repoRoot>/node_modules/@liaison/host` (the workspace symlink).
        // Without this, builds whose entrypoint lives in a tmp dir (e.g. e2e
        // fixtures) walk upward from /tmp and never reach the workspace.
        absWorkingDir: repoRoot,
        nodePaths: [join(repoRoot, "node_modules")],
        define: {
          __LIAISON_APP_NAME__: JSON.stringify(manifest.name),
        },
        plugins: [...esbuildPlugins, solidPlugin()],
        logLevel: "silent",
        metafile: true,
      })
      // esbuild reports metafile paths relative to absWorkingDir.
      for (const p of bundleSources(
        uiBuild.metafile?.outputs,
        repoRoot,
        repoRoot,
        workspacePackages,
      )) {
        sources.add(p)
      }

      // The host serves `solid-js{,/web,/store}` to plugin bundles through the
      // literal-export shims under apps/web/public/_app-runtime/. An ESM named
      // import the shim does not re-export kills the WHOLE app UI in the
      // browser ("does not provide an export named ..."), and nothing else
      // catches it before a deploy. Compare here, on the build machine.
      const uiSource = readFileSync(join(stage, "ui.js"), "utf8")
      const unsupported = findUnsupportedBundleImports(
        uiSource,
        readAllShimExports(join(import.meta.dir, "..")),
      )
      if (unsupported.length > 0) {
        const detail = unsupported.map((u) => `${u.imported} (from '${u.specifier}')`).join(", ")
        throw new Error(
          `ui bundle imports ${detail}, which the host runtime shims do not export. ` +
            "Run `bun run scripts/gen-app-runtime-shims.ts` and commit the regenerated shims.",
        )
      }
    }

    // Sandboxed PDF template DSL — bundle each declared `pdf_templates[]`
    // source into a SANDBOX-EXECUTABLE artifact (NOT a host `new Function`
    // body). The template `.ts` exports `renderTemplate(data) => DrawCommand[]`
    // authored against `@liaison/app-sdk`'s `PdfBuilder`; we bundle it with
    // `Bun.build` (target `bun`, like the handler bundle above), bundling in the
    // SDK's `PdfBuilder`, and append `globalThis.renderTemplate = renderTemplate`
    // so the kernel can call it inside the QuickJS app sandbox via
    // `executeInSandbox({ exportName: "renderTemplate" })`. There is NO pdf-lib
    // import (pdf-lib runs host-side in the replayer) and NO host-closure
    // injection — the template emits a validated JSON command list and the host
    // replays it (see apps/api/src/modules/pdf/replay.ts).
    const templateFiles: string[] = []
    const pdfTemplates = (raw as { pdf_templates?: Array<{ kind: string; source: string }> })
      .pdf_templates
    if (pdfTemplates && pdfTemplates.length > 0) {
      mkdirSync(join(stage, "templates"), { recursive: true })
      for (const tpl of pdfTemplates) {
        if (!tpl.kind.startsWith(`${manifest.name}:`)) {
          throw new Error(
            `pdf_templates[].kind '${tpl.kind}' must be namespaced with the app id ('${manifest.name}:...')`,
          )
        }
        const sourcePath = join(appDir, tpl.source)
        if (!existsSync(sourcePath)) {
          throw new Error(`pdf_templates[].source not found at ${sourcePath}`)
        }
        const templateBuild = await Bun.build({
          entrypoints: [sourcePath],
          target: "bun",
          external: ["node:*"],
          metafile: true,
          plugins: bunPlugins,
        })
        if (!templateBuild.success) {
          const detail = templateBuild.logs.length
            ? templateBuild.logs.map(String).join("\n")
            : "<bun.build returned no logs — entry resolution or transformer failure>"
          throw new Error(`pdf template '${tpl.kind}' bundle failed: ${detail}`)
        }
        for (const p of bundleSources(
          templateBuild.metafile?.outputs,
          process.cwd(),
          repoRoot,
          workspacePackages,
        )) {
          sources.add(p)
        }
        let js = await templateBuild.outputs[0].text()
        // Resolve the LOCAL binding Bun.build exported as `renderTemplate`.
        // Handles a direct export (`export { renderTemplate }`), an alias
        // (`export { foo as renderTemplate }`), and a bundler-renamed binding
        // (`export { renderTemplate2 as renderTemplate }`). A default export or
        // a missing `renderTemplate` export → reject. We bind globalThis to the
        // RESOLVED local name (not the literal `renderTemplate`) so an aliased
        // re-export can't bind to an undefined identifier at sandbox eval.
        const localName = resolveExportedLocalName(js, "renderTemplate")
        if (!localName) {
          throw new Error(
            `pdf template '${tpl.kind}' must export a 'renderTemplate(data) => DrawCommand[]' function`,
          )
        }
        // QuickJS `evalCode` is script-mode and rejects the trailing ESM
        // `export { ... };` block Bun.build emits — strip it (mirrors the
        // handler bundle-loader's `esmExportsToGlobalThis`) and bind
        // `globalThis.renderTemplate` to the resolved local so the sandbox
        // executor can resolve it regardless of how the template re-exported it.
        js = stripEsmExportBlock(js)
        js += `\nglobalThis.renderTemplate = ${localName};\n`
        // Filename sanitises the kind to ASCII-alphanumeric so the artifact
        // is portable to Windows hosts (colon is reserved on NTFS).
        // The kind itself is preserved in the manifest's `pdf_templates[]`
        // and is what the install service uses to key the registry.
        const safeName = tpl.kind.replace(/[^A-Za-z0-9._-]+/g, "__")
        const outName = `templates/${safeName}.js`
        writeFileSync(join(stage, outName), js)
        templateFiles.push(outName)
      }
    }

    // Optional docs / license pulled verbatim from the source tree.
    for (const optional of ["README.md", "CHANGELOG.md", "LICENSE"]) {
      const src = join(appDir, optional)
      if (existsSync(src)) {
        copyFileSync(src, join(stage, optional))
        sources.add(appSource(optional))
      }
    }

    const tarballPath = join(outDir, `${manifest.name}-${manifest.version}.liaisonapp`)
    const files = ["app.manifest.json", "bundle.js", ...templateFiles]
    for (const optional of ["ui.js", "README.md", "CHANGELOG.md", "LICENSE"]) {
      if (existsSync(join(stage, optional))) files.push(optional)
    }
    writeFileSync(tarballPath, reproducibleTarGz(stage, files))
    return { tarballPath, manifest, sources: [...sources].sort() }
  } finally {
    rmSync(stage, { recursive: true, force: true })
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
function reproducibleTarGz(stage: string, files: string[]): Buffer {
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
 * Phase 16 Task A6 — light export-presence check on the built bundle.
 * Bun.build emits ES-module bundles whose exports appear as one of:
 *   export {NAME}, export {NAME as ...}, export {... as NAME},
 *   export const NAME, export function NAME, export async function NAME, export class NAME,
 *   or `... NAME };` re-exports.
 * The check is intentionally textual — robust enough to catch fat-finger typos and
 * deleted exports without booting a sandbox. A false-positive on minified output
 * is acceptable for now (freeze is run on un-minified Bun.build output).
 */
/**
 * Strip the trailing ESM `export { ... };` block Bun.build (target:"bun",
 * format:"esm") emits. QuickJS `evalCode` is script-mode and rejects a bare
 * `export` statement; PDF template bundles bind their export to
 * `globalThis.renderTemplate` instead. Mirrors the handler bundle-loader's
 * `esmExportsToGlobalThis` (kept inline here so this repo-root script does not
 * import apps/api internals).
 */
function stripEsmExportBlock(source: string): string {
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
function resolveExportedLocalName(source: string, exportName: string): string | null {
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

function isExportPresentInBundle(source: string, exportName: string): boolean {
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

// CLI entry point.
//   bun run app:freeze <app-name>
//   bun run app:freeze <app-name> --app-dir <abs-path> [--out-dir <abs-path>]
if (import.meta.main) {
  const args = process.argv.slice(2)
  const appName = args[0]
  if (!appName || appName.startsWith("--")) {
    console.error("usage: bun run app:freeze <app-name> [--app-dir <path>] [--out-dir <path>]")
    process.exit(1)
  }
  let appDir: string | undefined
  let outDir: string | undefined
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--app-dir" && i + 1 < args.length) {
      appDir = args[i + 1]
      i++
    } else if (args[i] === "--out-dir" && i + 1 < args.length) {
      outDir = args[i + 1]
      i++
    }
  }
  freezeApp({ appName, appDir, outDir })
    .then(({ tarballPath }) => console.log(`✓ ${tarballPath}`))
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e))
      process.exit(1)
    })
}
