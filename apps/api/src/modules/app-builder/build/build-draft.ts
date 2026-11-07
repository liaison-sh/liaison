// SPDX-License-Identifier: FSL-1.1-ALv2
//
// buildDraft: an untrusted draft (app.manifest.json, handlers.ts, optional ui.tsx
// and README.md, 512 KiB at most) in, a .liaisonapp package out, with its handler
// bundle, UI bundle and Workers module and every sha256, or the validation errors
// with file and line.
//
// The caller decides the app's name and version (`<base>-o<orgKey>`, the next
// version): they overwrite whatever the draft's manifest says before anything is
// built, so the package bytes already carry them.
//
// The bundlers run in a subprocess (./build-worker.ts), each build in its own
// fresh temp dir, with:
//   - an environment holding only PATH, HOME and TMPDIR (both the temp dir), LANG;
//   - deny-by-default import resolution and no import attributes or macros
//     (./sandbox-resolve.ts);
//   - a wall-clock timeout (30 s at most) after which its whole process group is
//     killed;
//   - a 4 MiB cap on stdout + stderr together and on every output file;
//   - a memory limit: on Linux `prlimit --as` (1 GiB of address space; Bun and
//     esbuild run under it), elsewhere (a developer's macOS) an RSS watchdog that
//     samples the process every 250 ms and kills the group over 1 GiB.
// The caller holds a build slot first (./governance.ts).
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { forbiddenCustomAppDeclaration } from "~/modules/apps/app-org-scope"
import { customAppBase, customAppNameKey } from "~/modules/apps/custom-app-name"
import type { WorkerRequest, WorkerResult } from "./build-worker"
import { checkPackageManifest } from "./freeze-core"
import type { BuildIssue } from "./sandbox-resolve"

export type { BuildIssue } from "./sandbox-resolve"

export const DRAFT_FILE_NAMES = ["app.manifest.json", "handlers.ts", "ui.tsx", "README.md"] as const
export type DraftFileName = (typeof DRAFT_FILE_NAMES)[number]
export type DraftFiles = { "app.manifest.json": string; "handlers.ts": string } & Partial<
  Record<"ui.tsx" | "README.md", string>
>

export const DRAFT_MAX_TOTAL_BYTES = 512 * 1024
export const BUILD_TIMEOUT_MS = 30_000
export const BUILD_OUTPUT_CAP_BYTES = 4 * 1024 * 1024
export const BUILD_MEMORY_LIMIT_BYTES = 1024 * 1024 * 1024

const WORKER_SCRIPT = join(import.meta.dir, "build-worker.ts")
const BASE_RE = /^[a-z][a-z0-9-]{1,40}$/
const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

export interface BuiltFile {
  bytes: Uint8Array
  sha256: string
  sizeBytes: number
}

export interface BuildDraftOptions {
  /** The app's name, `<base>-o<orgKey>` (custom-app-name.ts). Overwrites the manifest's. */
  appName: string
  /** The version this build ships as. Overwrites the manifest's. */
  version: string
  /** Also run `tsc --noEmit` against the SDK types (apps_build_check). */
  typecheck?: boolean
  /** At most BUILD_TIMEOUT_MS. */
  timeoutMs?: number
  /** At most BUILD_OUTPUT_CAP_BYTES. */
  outputCapBytes?: number
}

export interface BuildDraftResult {
  /** The build succeeded (the typecheck result is separate). */
  ok: boolean
  errors: BuildIssue[]
  /** The manifest as packaged, name and version forced. */
  manifest?: Record<string, unknown>
  /** The .liaisonapp bytes; `sha256` repeats `package.sha256`. */
  package?: BuiltFile
  sha256?: string
  bundle?: BuiltFile
  ui?: BuiltFile
  worker?: BuiltFile
  typecheck?: { ok: boolean; errors: BuildIssue[] }
  durationMs: number
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** The line of `offset` in `text` (1-based). */
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

/** Parse the manifest JSON with positions (the TypeScript JSON parser runs no code). */
function parseManifest(text: string): {
  value?: Record<string, unknown>
  errors: BuildIssue[]
  lineOf: (key: string) => number | undefined
} {
  const file = "app.manifest.json"
  const sf = ts.parseJsonText(file, text)
  const diagnostics = [
    ...((sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? []),
  ]
  ts.convertToObject(sf, diagnostics)
  const keyLines = new Map<string, number>()
  const root = sf.statements[0]?.expression
  if (root && ts.isObjectLiteralExpression(root)) {
    for (const prop of root.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.name)) {
        keyLines.set(prop.name.text, lineAt(text, prop.getStart(sf)))
      }
    }
  }
  const lineOf = (key: string) => keyLines.get(key)
  if (diagnostics.length > 0) {
    return {
      errors: diagnostics.slice(0, 10).map((d) => ({
        file,
        line: lineAt(text, d.start ?? 0),
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        code: "manifest_json",
      })),
      lineOf,
    }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (err) {
    return { errors: [{ file, message: (err as Error).message, code: "manifest_json" }], lineOf }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      errors: [{ file, line: 1, message: "the manifest must be a JSON object", code: "manifest" }],
      lineOf,
    }
  }
  return { value: value as Record<string, unknown>, errors: [], lineOf }
}

/** Everything checked before a subprocess starts: files, sizes, name, manifest. */
function validate(
  files: Record<string, unknown>,
  opts: BuildDraftOptions,
): { errors: BuildIssue[]; manifest?: Record<string, unknown>; manifestJson?: string } {
  const errors: BuildIssue[] = []
  let total = 0
  for (const [name, value] of Object.entries(files)) {
    if (!(DRAFT_FILE_NAMES as readonly string[]).includes(name)) {
      errors.push({
        file: name,
        message: `a draft has only ${DRAFT_FILE_NAMES.join(", ")}`,
        code: "files",
      })
      continue
    }
    if (typeof value !== "string") {
      errors.push({ file: name, message: "file contents must be text", code: "files" })
      continue
    }
    total += Buffer.byteLength(value)
  }
  for (const required of ["app.manifest.json", "handlers.ts"]) {
    if (typeof files[required] !== "string") {
      errors.push({ file: required, message: `${required} is required`, code: "files" })
    }
  }
  if (total > DRAFT_MAX_TOTAL_BYTES) {
    errors.push({
      file: "<draft>",
      message: `the draft is ${total} bytes, over the ${DRAFT_MAX_TOTAL_BYTES}-byte limit`,
      code: "files_too_large",
    })
  }
  const key = customAppNameKey(opts.appName)
  if (key === null || !BASE_RE.test(customAppBase(opts.appName))) {
    errors.push({
      file: "app.manifest.json",
      message: `'${opts.appName}' is not a custom app name`,
      code: "app_name",
    })
  }
  if (!VERSION_RE.test(opts.version)) {
    errors.push({
      file: "app.manifest.json",
      message: `'${opts.version}' is not a version (x.y.z)`,
      code: "app_version",
    })
  }
  if (errors.length > 0 || typeof files["app.manifest.json"] !== "string") return { errors }

  const text = files["app.manifest.json"]
  const parsed = parseManifest(text)
  if (!parsed.value) return { errors: parsed.errors }
  const manifest: Record<string, unknown> = {
    ...parsed.value,
    name: opts.appName,
    version: opts.version,
  }
  const checked = checkPackageManifest(manifest)
  if (!checked.ok) {
    for (const message of checked.messages) {
      const top = message.split(/[.:]/)[0]
      errors.push({
        file: "app.manifest.json",
        line: parsed.lineOf(top),
        message,
        code: "manifest",
      })
    }
  }
  const forbidden = forbiddenCustomAppDeclaration(manifest)
  if (forbidden !== null) {
    errors.push({
      file: "app.manifest.json",
      line: parsed.lineOf(forbidden.split(".")[0]),
      message: `a custom app may not declare '${forbidden}'`,
      code: "custom_app_capability",
    })
  }
  if (Array.isArray(manifest.pdf_templates) && manifest.pdf_templates.length > 0) {
    errors.push({
      file: "app.manifest.json",
      line: parsed.lineOf("pdf_templates"),
      message: "a draft app cannot carry PDF templates",
      code: "manifest",
    })
  }
  return { errors, manifest, manifestJson: `${JSON.stringify(manifest, null, 2)}\n` }
}

// ── The subprocess ─────────────────────────────────────────────────────────

export interface WorkerLimits {
  timeoutMs: number
  outputCapBytes: number
  memoryLimitBytes: number
}

type RunOutcome =
  | { kind: "done"; result: WorkerResult; dir: string }
  | { kind: "failed"; issue: BuildIssue }

let prlimitPath: string | null | undefined
function prlimit(): string | null {
  if (prlimitPath === undefined) {
    prlimitPath =
      process.platform === "linux"
        ? (Bun.which("prlimit") ?? (existsSync("/usr/bin/prlimit") ? "/usr/bin/prlimit" : null))
        : null
  }
  return prlimitPath
}

/** The memory-limit mechanism this server applies to builds. */
export function buildMemoryLimitMechanism(): "prlimit-as" | "rss-watchdog" {
  return prlimit() ? "prlimit-as" : "rss-watchdog"
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
}

async function rssBytes(pid: number): Promise<number> {
  const ps = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const text = await new Response(ps.stdout).text()
  return (Number.parseInt(text.trim(), 10) || 0) * 1024
}

/**
 * Run `script` (the build worker) on `request` in a fresh temp dir. On success the
 * caller reads the outputs from the returned dir and removes it; on failure it is
 * already removed.
 */
async function runWorker(
  request: WorkerRequest,
  limits: WorkerLimits,
  script: string = WORKER_SCRIPT,
): Promise<RunOutcome> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "liaison-draft-")))
  const limiter = prlimit()
  const argv = [
    ...(limiter ? [limiter, `--as=${limits.memoryLimitBytes}`, "--"] : []),
    process.execPath,
    script,
  ]
  let failure: BuildIssue | null = null
  const fail = (issue: BuildIssue) => {
    failure ??= issue
  }
  const proc = Bun.spawn(argv, {
    cwd: dir,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: dir,
      TMPDIR: dir,
      LANG: "C.UTF-8",
      NO_COLOR: "1",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
  const timer = setTimeout(() => {
    fail({
      file: "<build>",
      message: `the build took longer than ${limits.timeoutMs} ms`,
      code: "build_timeout",
    })
    killGroup(proc.pid)
  }, limits.timeoutMs)
  let watchdog: ReturnType<typeof setInterval> | undefined
  if (!limiter) {
    watchdog = setInterval(() => {
      rssBytes(proc.pid)
        .then((rss) => {
          if (rss > limits.memoryLimitBytes) {
            fail({
              file: "<build>",
              message: "the build used more memory than allowed",
              code: "memory_limit",
            })
            killGroup(proc.pid)
          }
        })
        .catch(() => {})
    }, 250)
  }
  let outputBytes = 0
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) {
      outputBytes += chunk.byteLength
      if (outputBytes > limits.outputCapBytes) {
        fail({
          file: "<build>",
          message: `the build wrote more than ${limits.outputCapBytes} bytes of output`,
          code: "output_cap",
        })
        killGroup(proc.pid)
        break
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString("utf8")
  }
  try {
    proc.stdin.write(JSON.stringify(request))
    await proc.stdin.end()
  } catch {
    /* the worker died early: reported below */
  }
  const [stdout, stderr, code] = await Promise.all([
    collect(proc.stdout),
    collect(proc.stderr),
    proc.exited,
  ])
  clearTimeout(timer)
  if (watchdog) clearInterval(watchdog)
  // Whatever the worker left running in its group goes with it.
  killGroup(proc.pid)
  const done = (issue: BuildIssue): RunOutcome => {
    rmSync(dir, { recursive: true, force: true })
    return { kind: "failed", issue }
  }
  if (failure) return done(failure)
  const line = stdout.trim().split("\n").at(-1) ?? ""
  try {
    const result = JSON.parse(line) as WorkerResult
    if (typeof result?.ok !== "boolean" || !Array.isArray(result.errors))
      throw new Error("bad result")
    return { kind: "done", result, dir }
  } catch {
    const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500)
    const signal = proc.signalCode ? ` (${proc.signalCode})` : ""
    return done({
      file: "<build>",
      message: `the build stopped without a result, exit ${code}${signal}${detail ? `: ${detail}` : ""}`,
      code: code === 134 || proc.signalCode === "SIGABRT" ? "memory_limit" : "build_crashed",
    })
  }
}

function readOutput(dir: string, name: string, cap: number): BuiltFile {
  const path = join(dir, "out", name)
  const size = statSync(path).size
  if (size > cap) throw new Error(`${name} is ${size} bytes, over the ${cap}-byte limit`)
  const bytes = new Uint8Array(readFileSync(path))
  return { bytes, sha256: sha256(bytes), sizeBytes: bytes.byteLength }
}

/** Build a draft into a package (see the file header). Never throws for a bad draft. */
export async function buildDraft(
  files: Record<string, unknown>,
  opts: BuildDraftOptions,
): Promise<BuildDraftResult> {
  const started = Date.now()
  const limits: WorkerLimits = {
    timeoutMs: Math.min(opts.timeoutMs ?? BUILD_TIMEOUT_MS, BUILD_TIMEOUT_MS),
    outputCapBytes: Math.min(opts.outputCapBytes ?? BUILD_OUTPUT_CAP_BYTES, BUILD_OUTPUT_CAP_BYTES),
    memoryLimitBytes: BUILD_MEMORY_LIMIT_BYTES,
  }
  const finish = (r: Omit<BuildDraftResult, "durationMs">): BuildDraftResult => ({
    ...r,
    durationMs: Date.now() - started,
  })
  const valid = validate(files, opts)
  if (valid.errors.length > 0 || !valid.manifest || !valid.manifestJson) {
    return finish({ ok: false, errors: valid.errors, manifest: valid.manifest })
  }
  const workerFiles: Record<string, string> = {}
  for (const name of DRAFT_FILE_NAMES) {
    const value = files[name]
    if (typeof value === "string") workerFiles[name] = value
  }
  workerFiles["app.manifest.json"] = valid.manifestJson
  const request = (mode: WorkerRequest["mode"]): WorkerRequest => ({
    mode,
    files: workerFiles,
    appName: opts.appName,
    outputCap: limits.outputCapBytes,
  })

  const outcome = await runWorker(request("build"), limits)
  let result: BuildDraftResult
  if (outcome.kind === "failed") {
    result = finish({ ok: false, errors: [outcome.issue], manifest: valid.manifest })
  } else {
    try {
      const { result: worker, dir } = outcome
      if (!worker.ok || !worker.outputs) {
        result = finish({ ok: false, errors: worker.errors, manifest: valid.manifest })
      } else {
        const pkg = readOutput(dir, worker.outputs.package, limits.outputCapBytes)
        result = finish({
          ok: true,
          errors: [],
          manifest: valid.manifest,
          package: pkg,
          sha256: pkg.sha256,
          bundle: readOutput(dir, worker.outputs.bundle, limits.outputCapBytes),
          ui: worker.outputs.ui
            ? readOutput(dir, worker.outputs.ui, limits.outputCapBytes)
            : undefined,
          worker: readOutput(dir, worker.outputs.worker, limits.outputCapBytes),
        })
      }
    } catch (err) {
      result = finish({
        ok: false,
        errors: [{ file: "<build>", message: (err as Error).message, code: "output_cap" }],
        manifest: valid.manifest,
      })
    } finally {
      rmSync(outcome.dir, { recursive: true, force: true })
    }
  }

  if (opts.typecheck) {
    const checked = await runWorker(request("check"), limits)
    if (checked.kind === "failed") {
      result.typecheck = { ok: false, errors: [checked.issue] }
    } else {
      rmSync(checked.dir, { recursive: true, force: true })
      result.typecheck = { ok: checked.result.ok, errors: checked.result.errors }
    }
    result.durationMs = Date.now() - started
  }
  return result
}

/** Test seam: run the subprocess runner on any script, with any limits. */
export const BuildDraftTestAccess = {
  runWorker,
  validate,
}
