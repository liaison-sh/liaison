// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a draft app's code may import while it is built, and the bundler plugins
// that enforce it. A draft is untrusted, agent-written code; the build runs on the
// API's own machine, so without this gate an import could inline any file the
// process can read (`/proc/1/environ` carries the server's secrets) or run code at
// build time (a Bun macro).
//
// Resolution is DENIED by default in both bundlers (onResolve `/.*/`). From a draft
// file, only these resolve:
//   - the fixed entry points of @liaison/app-sdk (handlers, Worker module, UI) and
//     of @liaison/app-ui and @liaison/host (UI), each to its exact file;
//   - solid-js, solid-js/web, solid-js/store (UI only): external, served at run time
//     by the host's import-map runtime shims;
//   - a relative import of another draft code file (handlers.ts, ui.tsx).
// Everything else is refused: other bare specifiers (node:*, bun:*, npm packages),
// absolute paths, relative paths to anything else, data: and file: URLs.
// Imports made by those fixed packages' own files resolve as usual: that code is
// the server's, not the draft's.
//
// Import attributes (`with { ... }` / `assert { ... }`) are refused outright: Bun
// inlines any file under `with { type: "text" | "file" }`, and `with { type:
// "macro" }` RUNS the imported function at build time. Bun runs a macro without
// calling any onResolve plugin and whatever `--no-macros` says, and even
// `Bun.Transpiler#scan` runs one, so the draft source is refused BEFORE Bun parses
// it: a TypeScript-AST pre-scan (`scanDraftSource`, which also checks every
// specifier with its line), `Bun.Transpiler#scanImports` as a second reader (it does
// not run macros), and the Bun plugin's onLoad re-checks the text. esbuild has no
// macros; its plugin refuses any import that carries attributes.
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { Plugin as EsbuildPlugin } from "esbuild"
import ts from "typescript"
import { REPO_ROOT, UI_EXTERNALS, WORKER_ENTRY } from "./freeze-core"

/** The draft files that hold code, in the order they are built. */
export const DRAFT_CODE_FILES = ["handlers.ts", "ui.tsx"] as const
export type DraftCodeFile = (typeof DRAFT_CODE_FILES)[number]

/** Which bundle is being built: the handler bundle, the UI bundle or the Worker module. */
export type BuildMode = "handlers" | "ui" | "worker"

export interface BuildIssue {
  file: string
  line?: number
  column?: number
  message: string
  code?: string
}

/** A package's export map as `{specifier: absolute file}` (string targets only). */
function packageEntryPoints(dir: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string
    main?: string
    exports?: Record<string, unknown>
  }
  const out: Record<string, string> = {}
  const exportsMap = manifest.exports ?? (manifest.main ? { ".": manifest.main } : {})
  for (const [sub, target] of Object.entries(exportsMap)) {
    if (typeof target !== "string" || sub.includes("*") || sub.endsWith(".json")) continue
    out[sub === "." ? manifest.name : `${manifest.name}/${sub.slice(2)}`] = join(dir, target)
  }
  return out
}

/** The specifiers a draft may import in `mode`, each to its file or "external". */
export function allowedSpecifiers(mode: BuildMode, root = REPO_ROOT): Map<string, string> {
  const allowed = new Map<string, string>()
  const add = (pkg: string) => {
    for (const [spec, file] of Object.entries(packageEntryPoints(join(root, "packages", pkg)))) {
      allowed.set(spec, file)
    }
  }
  add("app-sdk")
  if (mode === "ui") {
    add("app-ui")
    add("host-sdk")
    for (const spec of UI_EXTERNALS) allowed.set(spec, "external")
  }
  return allowed
}

export interface SandboxPolicy {
  mode: BuildMode
  /** The directory holding the draft's files (realpath). */
  draftDir: string
  /** Absolute entry points of this build; the bundler resolves them first. */
  entryPoints: string[]
  /** Generated entries (Worker module) and the only absolute paths each may import. */
  generated: Map<string, Set<string>>
  allowed: Map<string, string>
  /** Directories whose files are the server's own code: their imports resolve as usual. */
  trustedRoots: string[]
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function sandboxPolicy(input: {
  mode: BuildMode
  draftDir: string
  entryPoints: string[]
  generated?: Map<string, Set<string>>
  root?: string
}): SandboxPolicy {
  const root = real(input.root ?? REPO_ROOT)
  const trustedRoots = [join(root, "packages"), join(root, "node_modules")]
  if (input.mode === "worker")
    trustedRoots.push(dirname(real(WORKER_ENTRY)), join(root, "apps/api/src/modules/apps/sandbox"))
  return {
    mode: input.mode,
    draftDir: real(input.draftDir),
    entryPoints: input.entryPoints.map(real),
    generated: new Map([...(input.generated ?? new Map())].map(([k, v]) => [real(k), v])),
    allowed: allowedSpecifiers(input.mode, root),
    trustedRoots,
  }
}

function inside(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

function isDraftFile(policy: SandboxPolicy, path: string): boolean {
  const p = real(path)
  return DRAFT_CODE_FILES.some((f) => p === join(policy.draftDir, f))
}

export type ResolveDecision =
  | { kind: "path"; path: string }
  | { kind: "external" }
  /** Let the bundler resolve it (an import made by the server's own package code). */
  | { kind: "default" }
  | { kind: "refuse"; reason: string }

/** The one decision both bundler plugins apply to every import of a build. */
export function decideResolve(
  policy: SandboxPolicy,
  args: { specifier: string; importer: string },
): ResolveDecision {
  const { specifier } = args
  if (!args.importer) {
    const p = isAbsolute(specifier) ? real(specifier) : ""
    return policy.entryPoints.includes(p)
      ? { kind: "path", path: p }
      : { kind: "refuse", reason: `'${specifier}' is not an entry point of this build` }
  }
  const importer = real(args.importer)
  const generated = policy.generated.get(importer)
  if (generated) {
    return generated.has(specifier)
      ? { kind: "path", path: real(specifier) }
      : { kind: "refuse", reason: `generated entry may not import '${specifier}'` }
  }
  if (isDraftFile(policy, importer)) return decideDraftImport(policy, specifier)
  if (inside(importer, policy.draftDir)) {
    return { kind: "refuse", reason: `'${importer}' is not a draft file` }
  }
  if (policy.trustedRoots.some((dir) => inside(importer, dir))) return { kind: "default" }
  return { kind: "refuse", reason: `import from an unexpected file '${importer}'` }
}

/** The decision for an import written in a draft file. */
export function decideDraftImport(policy: SandboxPolicy, specifier: string): ResolveDecision {
  const target = policy.allowed.get(specifier)
  if (target === "external") return { kind: "external" }
  if (target) return { kind: "path", path: target }
  if (specifier.startsWith("./") && !specifier.slice(2).includes("/")) {
    const name = specifier.slice(2)
    for (const file of DRAFT_CODE_FILES) {
      if (name === file || name === file.replace(/\.tsx?$/, "")) {
        const path = join(policy.draftDir, file)
        if (existsSync(path)) return { kind: "path", path }
      }
    }
  }
  return { kind: "refuse", reason: refusalReason(policy, specifier) }
}

function refusalReason(policy: SandboxPolicy, specifier: string): string {
  const offered = [...policy.allowed.keys()].filter((s) => !s.includes("/") || s.startsWith("@"))
  const list = `${offered.slice(0, 6).join(", ")}${offered.length > 6 ? ", ..." : ""}`
  if (/^(data|file|https?|blob):/i.test(specifier)) {
    return `'${specifier.slice(0, 60)}': URL imports are not allowed`
  }
  if (isAbsolute(specifier) || specifier.startsWith("/")) {
    return `'${specifier}': absolute imports are not allowed`
  }
  if (specifier.startsWith(".")) {
    return `'${specifier}': a draft may import only its own files (./handlers, ./ui)`
  }
  return `'${specifier}' cannot be imported by a draft app; allowed: ${list}`
}

// ── Source pre-scan (before any Bun parse) ─────────────────────────────────

/**
 * A string literal followed (through spaces and comments) by `with`, `assert` or an
 * escaped identifier: the shape of an import attribute, written however. Parser-
 * independent on purpose; a false positive (prose such as `"x" with care` inside a
 * string) is refused with a message that says how to reword it.
 */
// A block comment's body never holds `*/`, so each stretch of text matches one way only
// (no backtracking blow-up on many `*//*` in a row).
const ATTRIBUTE_LIKE =
  /["'`](?:\s|\/\*(?:[^*]|\*+[^*/])*\*+\/|\/\/[^\n]*(?:\n|$))*(?:with\b|assert\b|\\u)/

function lineOf(source: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < source.length; i++) if (source.charCodeAt(i) === 10) line++
  return line
}

/** The attribute-shaped text of `source` (handlers only: Bun reads it), or null. */
export function attributeLikeText(source: string): { line: number } | null {
  const m = ATTRIBUTE_LIKE.exec(source)
  return m ? { line: lineOf(source, m.index) } : null
}

/**
 * Every refused import of a draft code file, with its line. Reads the source with
 * the TypeScript parser (which never runs code), then with Bun's import scanner,
 * then (handlers, which Bun builds) the attribute-shaped text check.
 */
export function scanDraftSource(
  policy: SandboxPolicy,
  file: DraftCodeFile,
  source: string,
): BuildIssue[] {
  const issues: BuildIssue[] = []
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const at = (node: ts.Node, message: string, code = "import_refused") => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
    issues.push({ file, line: line + 1, column: character + 1, message, code })
  }
  const checkSpecifier = (node: ts.Node, specifier: string) => {
    const decision = decideDraftImport(policy, specifier)
    if (decision.kind === "refuse") at(node, decision.reason)
  }
  for (const ref of [
    ...sf.referencedFiles,
    ...sf.typeReferenceDirectives,
    ...sf.libReferenceDirectives,
  ]) {
    issues.push({
      file,
      line: sf.getLineAndCharacterOfPosition(ref.pos).line + 1,
      message: "triple-slash references are not allowed",
      code: "import_refused",
    })
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (node.attributes)
        at(node, "import attributes (with/assert) are not allowed", "import_attribute")
      if (spec && ts.isStringLiteral(spec)) {
        const typeOnly = ts.isImportDeclaration(node)
          ? node.importClause?.isTypeOnly === true
          : node.isTypeOnly
        if (!typeOnly) checkSpecifier(spec, spec.text)
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference
      if (ts.isExternalModuleReference(ref)) {
        if (ts.isStringLiteral(ref.expression)) checkSpecifier(ref, ref.expression.text)
        else at(ref, "require() needs a string literal")
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression
      const isImport = callee.kind === ts.SyntaxKind.ImportKeyword
      const isRequire = ts.isIdentifier(callee) && callee.text === "require"
      if (isImport || isRequire) {
        const [first, second] = node.arguments
        if (second) at(node, "import() options (with/assert) are not allowed", "import_attribute")
        if (first && ts.isStringLiteralLike(first)) checkSpecifier(first, first.text)
        else at(node, `${isImport ? "import()" : "require()"} needs a string literal`)
      }
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isMetaProperty(node.expression) &&
      node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
      (node.name.text === "require" || node.name.text === "resolve")
    ) {
      at(node, `import.meta.${node.name.text} is not allowed`)
    } else if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      at(node, `require.${node.name.text} is not allowed`)
    } else if (ts.isIdentifier(node) && node.getText(sf).includes("\\")) {
      at(node, "escaped identifiers are not allowed")
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  const syntax =
    (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? []
  for (const d of syntax.slice(0, 10)) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start)
    issues.push({
      file,
      line: line + 1,
      column: character + 1,
      message: `syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
      code: "syntax",
    })
  }
  // Second reader: whatever Bun itself sees as an import must pass the same rule.
  try {
    const transpiler = new Bun.Transpiler({
      loader: file.endsWith(".tsx") ? "tsx" : "ts",
    })
    // Bun's scanner adds a React JSX runtime import to any file with JSX; the UI's
    // JSX is Solid's (compiled by esbuild), and a written `import "react"` is
    // already refused by the AST pass above.
    const jsxRuntime = new Set(["react", "react/jsx-runtime", "react/jsx-dev-runtime"])
    for (const imp of transpiler.scanImports(source)) {
      if (file.endsWith(".tsx") && jsxRuntime.has(imp.path)) continue
      const decision = decideDraftImport(policy, imp.path)
      if (decision.kind === "refuse" && !issues.some((i) => i.message === decision.reason)) {
        issues.push({ file, message: decision.reason, code: "import_refused" })
      }
    }
  } catch (err) {
    if (syntax.length === 0) {
      issues.push({ file, message: `syntax error: ${(err as Error).message}`, code: "syntax" })
    }
  }
  if (file === "handlers.ts") {
    const attr = attributeLikeText(source)
    if (attr) {
      issues.push({
        file,
        line: attr.line,
        message:
          "a string followed by `with` or `assert` (or an escaped name) reads as an import attribute, which is not allowed; reword the text",
        code: "import_attribute",
      })
    }
  }
  return issues
}

// ── Bundler plugins ────────────────────────────────────────────────────────

/** Bun.build plugin: deny-by-default resolution plus the source re-check on load. */
export function bunSandboxPlugin(policy: SandboxPolicy): Bun.BunPlugin {
  const draftFilter = new RegExp(
    `^${policy.draftDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${sep === "\\" ? "\\\\" : "/"}`,
  )
  return {
    name: "liaison-draft-sandbox",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const decision = decideResolve(policy, { specifier: args.path, importer: args.importer })
        if (decision.kind === "refuse") throw new Error(`import refused: ${decision.reason}`)
        if (decision.kind === "external") return { path: args.path, external: true }
        if (decision.kind === "path") return { path: decision.path }
        return undefined
      })
      build.onLoad({ filter: draftFilter }, (args) => {
        if (!isDraftFile(policy, args.path) || !args.path.endsWith(".ts")) {
          throw new Error(`load refused: ${args.path}`)
        }
        const contents = readFileSync(args.path, "utf8")
        if (attributeLikeText(contents)) {
          throw new Error("load refused: import attributes are not allowed")
        }
        return { contents, loader: "ts" }
      })
    },
  }
}

/** esbuild plugin (UI bundle): the same deny-by-default resolution; attributes refused. */
export function esbuildSandboxPlugin(policy: SandboxPolicy): EsbuildPlugin {
  return {
    name: "liaison-draft-sandbox",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.with && Object.keys(args.with).length > 0) {
          return { errors: [{ text: "import attributes (with/assert) are not allowed" }] }
        }
        const importer = args.kind === "entry-point" ? "" : args.importer
        const decision = decideResolve(policy, { specifier: args.path, importer })
        if (decision.kind === "refuse")
          return { errors: [{ text: `import refused: ${decision.reason}` }] }
        if (decision.kind === "external") return { path: args.path, external: true }
        if (decision.kind === "path") return { path: decision.path }
        return undefined
      })
    },
  }
}
