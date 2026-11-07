// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The draft build's subprocess (spawned by ./build-draft.ts, never imported by the
// API). It runs in a fresh, empty temp dir (its cwd) with a stripped environment,
// reads one JSON request on stdin, writes the outputs under `out/` and prints one
// JSON result line on stdout.
//
//   build: handlers.ts -> bundle.js (Bun.build, target bun, node:* external)
//          ui.tsx      -> ui.js     (esbuild + Solid, solid-js* external)
//          handlers.ts -> worker.js (the Workers module, as scripts/apps-build-worker-bundle.ts)
//          + package.liaisonapp (app.manifest.json, bundle.js, ui.js?, README.md?)
//   check: tsc --noEmit of the draft's code against the @liaison/app-sdk types.
//
// Every import goes through ./sandbox-resolve.ts. Draft files are written as real
// files under `app/` (the Solid transform reads JSX from disk).
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { build as esbuild, type Message } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import ts from "typescript"
import {
  findUnsupportedBundleImports,
  parseShimExports,
  SHIM_SPECIFIERS,
  SHIMS,
} from "../../../../../../scripts/lib/app-runtime-shims"
import {
  bunBuildFailureDetail,
  REPO_ROOT,
  reproducibleTarGz,
  UI_EXTERNALS,
  WORKER_ENTRY,
  webhookExportError,
  workerEntrySource,
  workerNodeImport,
} from "./freeze-core"
import {
  allowedSpecifiers,
  type BuildIssue,
  bunSandboxPlugin,
  esbuildSandboxPlugin,
  sandboxPolicy,
  scanDraftSource,
} from "./sandbox-resolve"

export interface WorkerRequest {
  mode: "build" | "check"
  /** The draft's files; app.manifest.json already carries the forced name and version. */
  files: Record<string, string>
  appName: string
  /** Per-output byte cap. */
  outputCap: number
}

export interface WorkerResult {
  ok: boolean
  errors: BuildIssue[]
  /** Output files written under out/ (build mode, ok only). */
  outputs?: { package: string; bundle: string; ui?: string; worker: string }
}

const MAX_TYPE_ERRORS = 50

class BuildFailure extends Error {
  constructor(readonly issues: BuildIssue[]) {
    super(issues.map((i) => i.message).join("; "))
  }
}

function capped(name: string, text: string | Uint8Array, cap: number): void {
  const size = typeof text === "string" ? Buffer.byteLength(text) : text.byteLength
  if (size > cap) {
    throw new BuildFailure([
      {
        file: name,
        message: `${name} is ${size} bytes, over the ${cap}-byte limit`,
        code: "output_cap",
      },
    ])
  }
}

/** Bun.build log lines as issues, keeping the file and line Bun reports. */
function bunIssues(
  logs: ReadonlyArray<BuildMessage | ResolveMessage>,
  appDir: string,
): BuildIssue[] {
  if (logs.length === 0) return [{ file: "handlers.ts", message: bunBuildFailureDetail(logs) }]
  return logs.map((log) => {
    const pos = log.position
    const file = pos?.file ? relative(appDir, pos.file) || pos.file : "handlers.ts"
    return {
      file: file.startsWith("..") ? "handlers.ts" : file,
      line: pos?.line || undefined,
      column: pos?.column || undefined,
      message: log.message,
      code: "bundle",
    }
  })
}

function esbuildIssues(errors: Message[], appDir: string): BuildIssue[] {
  return errors.map((e) => {
    const file = e.location?.file ? relative(appDir, join(appDir, e.location.file)) : "ui.tsx"
    return {
      file: file.startsWith("..") ? "ui.tsx" : file,
      line: e.location?.line,
      column: e.location ? e.location.column + 1 : undefined,
      message: e.text,
      code: "bundle",
    }
  })
}

/** The host's runtime shims: in the source tree, or in the image's web build. */
function readShims(): Record<string, string[]> {
  const dirs = [
    join(REPO_ROOT, "apps/web/public/_app-runtime"),
    join(REPO_ROOT, "apps/api/public/_app-runtime"),
  ]
  for (const dir of dirs) {
    try {
      const out: Record<string, string[]> = {}
      for (const spec of SHIM_SPECIFIERS) {
        out[spec] = parseShimExports(readFileSync(join(dir, SHIMS[spec].file), "utf8"))
      }
      return out
    } catch {
      /* try the next place */
    }
  }
  throw new BuildFailure([
    { file: "ui.tsx", message: "the host runtime shims are missing on this server" },
  ])
}

async function buildHandlers(appDir: string, cap: number): Promise<string> {
  const entry = join(appDir, "handlers.ts")
  const result = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    // Bun keeps builtins (node:*, bun:*) external before any plugin runs, so the
    // plugin never sees them: the pre-scan refuses a draft's own builtin import.
    // A builtin is a run-time import of the sandbox, never a file read at build time.
    external: ["node:*"],
    plugins: [
      bunSandboxPlugin(sandboxPolicy({ mode: "handlers", draftDir: appDir, entryPoints: [entry] })),
    ],
  }).catch((err: unknown) => {
    const logs = (err as AggregateError).errors as BuildMessage[] | undefined
    throw new BuildFailure(
      bunIssues(logs ?? [], appDir).concat(
        logs ? [] : [{ file: "handlers.ts", message: String(err) }],
      ),
    )
  })
  if (!result.success) throw new BuildFailure(bunIssues(result.logs as BuildMessage[], appDir))
  const text = await result.outputs[0].text()
  capped("bundle.js", text, cap)
  return text
}

async function buildUi(appDir: string, appName: string, cap: number): Promise<string> {
  const entry = join(appDir, "ui.tsx")
  try {
    const result = await esbuild({
      entryPoints: [entry],
      bundle: true,
      format: "esm",
      outfile: join(appDir, "ui.js"),
      write: false,
      platform: "browser",
      external: [...UI_EXTERNALS],
      // Never the freeze's repo-root working dir or nodePaths: nothing resolves
      // except through the sandbox plugin, and no tsconfig is searched for.
      absWorkingDir: appDir,
      tsconfigRaw: "{}",
      define: { __LIAISON_APP_NAME__: JSON.stringify(appName) },
      plugins: [
        esbuildSandboxPlugin(sandboxPolicy({ mode: "ui", draftDir: appDir, entryPoints: [entry] })),
        solidPlugin(),
      ],
      logLevel: "silent",
    })
    const text = result.outputFiles[0].text
    capped("ui.js", text, cap)
    const unsupported = findUnsupportedBundleImports(text, readShims())
    if (unsupported.length > 0) {
      const detail = unsupported.map((u) => `${u.imported} (from '${u.specifier}')`).join(", ")
      throw new BuildFailure([
        {
          file: "ui.tsx",
          message: `the UI imports ${detail}, which the host runtime does not provide`,
        },
      ])
    }
    return text
  } catch (err) {
    if (err instanceof BuildFailure) throw err
    const errors = (err as { errors?: Message[] }).errors
    throw new BuildFailure(
      errors?.length ? esbuildIssues(errors, appDir) : [{ file: "ui.tsx", message: String(err) }],
    )
  }
}

async function buildWorkerModule(dir: string, appDir: string, cap: number): Promise<string> {
  const handlers = join(appDir, "handlers.ts")
  const genDir = join(dir, "gen")
  mkdirSync(genDir, { recursive: true })
  const entry = join(genDir, "worker.ts")
  writeFileSync(entry, workerEntrySource(handlers))
  const policy = sandboxPolicy({
    mode: "worker",
    draftDir: appDir,
    entryPoints: [entry],
    generated: new Map([[entry, new Set([handlers, WORKER_ENTRY])]]),
  })
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "esm",
    external: ["cloudflare:workers"],
    plugins: [bunSandboxPlugin(policy)],
  }).catch((err: unknown) => {
    throw new BuildFailure([{ file: "handlers.ts", message: `Worker module: ${String(err)}` }])
  })
  if (!result.success) {
    throw new BuildFailure(
      bunIssues(result.logs as BuildMessage[], appDir).map((i) => ({
        ...i,
        message: `Worker module: ${i.message}`,
      })),
    )
  }
  const text = await result.outputs[0].text()
  capped("worker.js", text, cap)
  const nodeImport = workerNodeImport(text)
  if (nodeImport) {
    throw new BuildFailure([
      {
        file: "handlers.ts",
        message: `the Worker module still imports a Node builtin: ${nodeImport}`,
      },
    ])
  }
  return text
}

async function build(req: WorkerRequest, dir: string, appDir: string): Promise<WorkerResult> {
  const manifestRaw = JSON.parse(req.files["app.manifest.json"]) as unknown
  const bundle = await buildHandlers(appDir, req.outputCap)
  const webhookError = webhookExportError(manifestRaw, bundle)
  if (webhookError) throw new BuildFailure([{ file: "app.manifest.json", message: webhookError }])
  const ui =
    req.files["ui.tsx"] !== undefined
      ? await buildUi(appDir, req.appName, req.outputCap)
      : undefined
  const worker = await buildWorkerModule(dir, appDir, req.outputCap)

  const stage = join(dir, "pkg")
  mkdirSync(stage)
  const packaged = ["app.manifest.json", "bundle.js"]
  writeFileSync(join(stage, "app.manifest.json"), req.files["app.manifest.json"])
  writeFileSync(join(stage, "bundle.js"), bundle)
  if (ui !== undefined) {
    writeFileSync(join(stage, "ui.js"), ui)
    packaged.push("ui.js")
  }
  if (req.files["README.md"] !== undefined) {
    writeFileSync(join(stage, "README.md"), req.files["README.md"])
    packaged.push("README.md")
  }
  const tarball = reproducibleTarGz(stage, packaged)
  capped("package", tarball, req.outputCap)

  const out = join(dir, "out")
  mkdirSync(out)
  writeFileSync(join(out, "package.liaisonapp"), tarball)
  writeFileSync(join(out, "bundle.js"), bundle)
  writeFileSync(join(out, "worker.js"), worker)
  if (ui !== undefined) writeFileSync(join(out, "ui.js"), ui)
  return {
    ok: true,
    errors: [],
    outputs: {
      package: "package.liaisonapp",
      bundle: "bundle.js",
      worker: "worker.js",
      ...(ui !== undefined ? { ui: "ui.js" } : {}),
    },
  }
}

/**
 * tsc --noEmit of the draft's code against the SDK types. The compiler host reads
 * only the draft's files, the repo's packages/ and node_modules/ and TypeScript's
 * own lib files, so a reference to any other path is a missing file, never its text
 * in a diagnostic. Only diagnostics in draft files are reported.
 */
function check(appDir: string, codeFiles: string[]): WorkerResult {
  const root = realpathSync(REPO_ROOT)
  const libDir = dirname(ts.getDefaultLibFilePath({}))
  const readable = [appDir, join(root, "packages"), join(root, "node_modules"), libDir]
  const allowedPath = (p: string) => {
    let r: string
    try {
      r = realpathSync(p)
    } catch {
      return false
    }
    return readable.some((dir) => r === dir || r.startsWith(`${dir}/`))
  }
  const paths: Record<string, string[]> = {}
  for (const [spec, file] of allowedSpecifiers("ui", root)) {
    if (file !== "external") paths[spec] = [file]
  }
  const solid = join(root, "node_modules/solid-js")
  paths["solid-js"] = [join(solid, "types/index.d.ts")]
  paths["solid-js/web"] = [join(solid, "web/types/index.d.ts")]
  paths["solid-js/store"] = [join(solid, "store/types/index.d.ts")]
  paths["solid-js/jsx-runtime"] = [join(solid, "types/jsx.d.ts")]
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    jsxImportSource: "solid-js",
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    types: [],
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    paths,
  }
  const host = ts.createCompilerHost(options)
  const readFile = host.readFile.bind(host)
  const fileExists = host.fileExists.bind(host)
  host.readFile = (p) => (allowedPath(p) ? readFile(p) : undefined)
  host.fileExists = (p) => allowedPath(p) && fileExists(p)
  host.directoryExists = (p) => allowedPath(p) && ts.sys.directoryExists(p)
  host.realpath = (p) => (allowedPath(p) ? realpathSync(p) : p)
  host.getDirectories = (p) => (allowedPath(p) ? ts.sys.getDirectories(p) : [])
  const program = ts.createProgram({
    rootNames: codeFiles.map((f) => join(appDir, f)),
    options,
    host,
  })
  const errors: BuildIssue[] = []
  const draftFiles = new Set(codeFiles.map((f) => join(appDir, f)))
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (!d.file || !draftFiles.has(d.file.fileName)) continue
    if (d.category !== ts.DiagnosticCategory.Error) continue
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0)
    errors.push({
      file: relative(appDir, d.file.fileName),
      line: line + 1,
      column: character + 1,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n").slice(0, 2000),
      code: `TS${d.code}`,
    })
    if (errors.length >= MAX_TYPE_ERRORS) break
  }
  return { ok: errors.length === 0, errors }
}

async function main(): Promise<void> {
  const req = JSON.parse(await Bun.stdin.text()) as WorkerRequest
  const dir = realpathSync(process.cwd())
  const appDir = join(dir, "app")
  mkdirSync(appDir)
  const codeFiles: string[] = []
  for (const name of ["app.manifest.json", "handlers.ts", "ui.tsx", "README.md"]) {
    const text = req.files[name]
    if (text === undefined) continue
    writeFileSync(join(appDir, name), text)
    if (name.endsWith(".ts") || name.endsWith(".tsx")) codeFiles.push(name)
  }
  let result: WorkerResult
  try {
    // The pre-scan runs before Bun parses any draft file (a Bun parse runs macros).
    const issues: BuildIssue[] = []
    for (const file of ["handlers.ts", "ui.tsx"] as const) {
      const text = req.files[file]
      if (text === undefined) continue
      const mode = file === "ui.tsx" ? "ui" : "handlers"
      issues.push(
        ...scanDraftSource(sandboxPolicy({ mode, draftDir: appDir, entryPoints: [] }), file, text),
      )
    }
    if (issues.length > 0) result = { ok: false, errors: issues }
    else if (req.mode === "check") result = check(appDir, codeFiles)
    else result = await build(req, dir, appDir)
  } catch (err) {
    result =
      err instanceof BuildFailure
        ? { ok: false, errors: err.issues }
        : {
            ok: false,
            errors: [{ file: "handlers.ts", message: (err as Error).message ?? String(err) }],
          }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.main) await main()
