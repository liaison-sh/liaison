// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Guard: code that is not the repo's own never reaches Bun's bundler or
// transpiler in the API process.
//
// Bun runs a macro import (`with { type: "macro" }`) while it parses, in the
// process that parses, before any plugin hook sees it. So every place that hands
// text to `Bun.build`, `Bun.Transpiler` or `Bun.plugin` (and every helper that
// wraps one of them) must be one of:
//   - "repo":       it builds the repo's own files or platform-generated text
//                   only; a `gate` names the path check in the same function
//                   where the input could come from elsewhere;
//   - "checked":    it takes a CheckedSource (sandbox/import-attributes.ts),
//                   which only the TypeScript-parser checks make, and parses
//                   nothing but that source's text;
//   - "subprocess": it runs in the draft build's own process (stripped
//                   environment, empty temp dir), which the API never imports.
// Each call site is listed in untrusted-host-build.d/<name>.json, one file per
// source file, with its reason. A new call site, a moved one or a stale entry
// fails here. The scan reads the TypeScript AST, so comments and strings that
// mention the APIs are no site, and aliases (`const { build } = Bun`,
// `globalThis.Bun`, `import { Transpiler } from "bun"`) are.

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"
import {
  type CheckedSource,
  checkAttributeFree,
  checkPlainScript,
  isCheckedSource,
  transpileChecked,
} from "~/modules/apps/sandbox/import-attributes"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..")
const API_SRC = join(REPO_ROOT, "apps/api/src")
const ALLOWLIST_DIR = join(import.meta.dir, "untrusted-host-build.d")

/** The Bun members that parse text (and so run a macro import). */
const PARSING_MEMBERS = new Set(["build", "Transpiler", "plugin"])
/** The Bun parser methods a "checked" site may call, each on `<param>.text`. */
const PARSE_METHODS = new Set(["transformSync", "transform", "scan", "scanImports"])
const CHECKED_TYPES = new Set(["CheckedSource", "CheckedScript"])

type Input = "repo" | "checked" | "subprocess"

interface Entry {
  /** The source file, relative to the repo root. */
  file: string
  /** `<kind>@<enclosing function>` -> how many times. */
  sites: Record<string, number>
  input: Input
  reason: string
  /** Site key -> a function the enclosing function calls to keep the input in the repo. */
  gate?: Record<string, string>
  /** Exported helpers that hand their caller's input to Bun: their callers are sites too. */
  wraps?: string[]
}

interface Site {
  file: string
  kind: string
  fn: string
  node: ts.Node
}

// -- Scanner ----------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
      out.push(p)
  }
  return out
}

/** Every non-test source file of the API process and the packages it loads. */
function scopeFiles(): string[] {
  const roots = [API_SRC]
  const packages = join(REPO_ROOT, "packages")
  for (const name of readdirSync(packages)) {
    const src = join(packages, name, "src")
    if (existsSync(src)) roots.push(src)
  }
  return roots.flatMap(sourceFiles).sort()
}

function parse(file: string, text = readFileSync(file, "utf8")): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function functionName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node)) &&
    node.name
  ) {
    return node.name.getText()
  }
  if (ts.isConstructorDeclaration(node)) return "constructor"
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    if (node.parent && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText()
    if (node.parent && ts.isPropertyAssignment(node.parent)) return node.parent.name.getText()
  }
  return null
}

/** The nearest named function around `node` (anonymous callbacks are skipped). */
function enclosing(node: ts.Node): { name: string; fn: ts.Node | null } {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) {
      const name = functionName(p)
      if (name) return { name, fn: p }
    }
  }
  return { name: "<module>", fn: null }
}

function resolveSpecifier(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith("~/")) base = join(API_SRC, spec.slice(2))
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec)
  else return null
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

function dynamicImportSpecifier(node: ts.Node | undefined): string | null {
  let n = node
  while (n && (ts.isParenthesizedExpression(n) || ts.isAwaitExpression(n))) n = n.expression
  if (
    n &&
    ts.isCallExpression(n) &&
    n.expression.kind === ts.SyntaxKind.ImportKeyword &&
    n.arguments[0] &&
    ts.isStringLiteralLike(n.arguments[0])
  ) {
    return n.arguments[0].text
  }
  return null
}

/** Is `id` the `Bun` global (bare, or `globalThis.Bun`), in a value position? */
function bunExpression(node: ts.Node): ts.Expression | null {
  if (ts.isIdentifier(node) && node.text === "Bun") {
    const p = node.parent
    if (ts.isPropertyAccessExpression(p) && p.name === node) {
      return ["globalThis", "global", "self"].includes(p.expression.getText()) ? p : null
    }
    if (
      ts.isQualifiedName(p) ||
      ts.isTypeReferenceNode(p) ||
      ts.isImportSpecifier(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isTypeQueryNode(p)
    ) {
      return null
    }
    return node
  }
  return null
}

/**
 * The call sites of one file: Bun's parsing members however reached, imports of
 * them from "bun", and calls of a wrapping helper imported from `wrappers`.
 */
function scanSource(
  file: string,
  sf: ts.SourceFile,
  wrappers: Map<string, Set<string>> = new Map(),
): Site[] {
  const sites: Site[] = []
  const add = (kind: string, node: ts.Node) =>
    sites.push({ file, kind, fn: enclosing(node).name, node })
  // local name -> wrapped helper name
  const helpers = new Map<string, string>()
  const wrapped = (spec: string) => {
    const target = resolveSpecifier(file, spec)
    return target ? wrappers.get(target) : undefined
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      const clause = node.importClause
      if (spec === "bun" && clause && !clause.isTypeOnly) {
        if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)))
          add('import from "bun"', node)
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            const name = (el.propertyName ?? el.name).text
            if (!el.isTypeOnly && PARSING_MEMBERS.has(name)) add(`import ${name} from "bun"`, el)
          }
        }
      }
      const helperNames = wrapped(spec)
      if (helperNames && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          const name = (el.propertyName ?? el.name).text
          if (helperNames.has(name) && !el.isTypeOnly && !clause.isTypeOnly)
            helpers.set(el.name.text, name)
        }
      }
    }
    // const { helper } = await import("…")
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) {
      const spec = dynamicImportSpecifier(node.initializer)
      const helperNames = spec ? wrapped(spec) : undefined
      if (helperNames) {
        for (const el of node.name.elements) {
          const name = (el.propertyName ?? el.name).getText()
          if (helperNames.has(name) && ts.isIdentifier(el.name)) helpers.set(el.name.text, name)
        }
      }
    }
    // (await import("…")).helper
    if (ts.isPropertyAccessExpression(node)) {
      const spec = dynamicImportSpecifier(node.expression)
      if (spec && wrapped(spec)?.has(node.name.text)) add(node.name.text, node)
    }
    const bun = bunExpression(node)
    if (bun) {
      const p = bun.parent
      if (ts.isPropertyAccessExpression(p) && p.expression === bun) {
        if (PARSING_MEMBERS.has(p.name.text)) add(`Bun.${p.name.text}`, p)
      } else if (!ts.isTypeOfExpression(p)) {
        // Bun["build"], const { build } = Bun, const B = Bun, f(Bun): anything
        // that lets the members be reached under another name.
        add("Bun (indirect)", bun)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (helpers.size > 0) {
    const refs = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && helpers.has(node.text)) {
        const p = node.parent
        const declaration =
          ts.isImportSpecifier(p) ||
          ts.isBindingElement(p) ||
          (ts.isPropertyAccessExpression(p) && p.name === node)
        if (!declaration) add(helpers.get(node.text) ?? node.text, node)
      }
      ts.forEachChild(node, refs)
    }
    refs(sf)
  }
  return sites
}

function siteKey(s: Pick<Site, "kind" | "fn">): string {
  return `${s.kind}@${s.fn}`
}

function readEntries(): Map<string, Entry & { json: string }> {
  const out = new Map<string, Entry & { json: string }>()
  for (const name of readdirSync(ALLOWLIST_DIR).sort()) {
    if (!name.endsWith(".json")) throw new Error(`${name}: only .json entries belong here`)
    const entry = JSON.parse(readFileSync(join(ALLOWLIST_DIR, name), "utf8")) as Entry
    if (out.has(entry.file)) throw new Error(`${name}: ${entry.file} has another entry`)
    out.set(entry.file, { ...entry, json: name })
  }
  return out
}

/** Value imports (static, re-export, dynamic) of `file`, resolved to files. */
function valueImports(file: string, sf: ts.SourceFile): string[] {
  const out: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      let typeOnly = false
      if (ts.isImportDeclaration(node)) {
        const c = node.importClause
        typeOnly =
          !!c &&
          (c.isTypeOnly ||
            (!c.name &&
              !!c.namedBindings &&
              ts.isNamedImports(c.namedBindings) &&
              c.namedBindings.elements.every((e) => e.isTypeOnly)))
      } else {
        typeOnly = node.isTypeOnly
      }
      const target = resolveSpecifier(file, node.moduleSpecifier.text)
      if (target && !typeOnly) out.push(target)
    }
    const spec = ts.isCallExpression(node) ? dynamicImportSpecifier(node) : null
    if (spec) {
      const target = resolveSpecifier(file, spec)
      if (target) out.push(target)
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const target = resolveSpecifier(file, node.arguments[0].text)
      if (target) out.push(target)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

// -- The scan of the tree, once -------------------------------------------------

const entries = readEntries()
const files = scopeFiles()
const parsed = new Map(files.map((f) => [f, parse(f)]))
const wrappers = new Map<string, Set<string>>()
for (const e of entries.values()) {
  if (e.wraps?.length) wrappers.set(join(REPO_ROOT, e.file), new Set(e.wraps))
}
const sites: Site[] = []
for (const [file, sf] of parsed) sites.push(...scanSource(file, sf, wrappers))

function grouped(): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>()
  for (const s of sites) {
    const rel = relative(REPO_ROOT, s.file)
    const rec = out.get(rel) ?? {}
    rec[siteKey(s)] = (rec[siteKey(s)] ?? 0) + 1
    out.set(rel, rec)
  }
  return out
}

describe("untrusted code never reaches Bun's parser in the API process", () => {
  test("every allowlist entry is well formed", () => {
    for (const e of entries.values()) {
      expect({ json: e.json, input: e.input }).toMatchObject({
        input: expect.stringMatching(/^(repo|checked|subprocess)$/),
      })
      expect({ json: e.json, reasonLength: e.reason?.trim().length > 40 }).toEqual({
        json: e.json,
        reasonLength: true,
      })
      expect({ json: e.json, exists: existsSync(join(REPO_ROOT, e.file)) }).toEqual({
        json: e.json,
        exists: true,
      })
      expect(Object.keys(e.sites).length).toBeGreaterThan(0)
      for (const key of Object.keys(e.gate ?? {})) {
        expect({ json: e.json, gatedSiteListed: key in e.sites }).toEqual({
          json: e.json,
          gatedSiteListed: true,
        })
      }
    }
  })

  test("every call site is on the allowlist, and every listed site still exists", () => {
    const found = grouped()
    const listed = new Map([...entries.values()].map((e) => [e.file, e.sites]))
    const unlisted: string[] = []
    for (const [file, rec] of found) {
      if (JSON.stringify(sorted(rec)) !== JSON.stringify(sorted(listed.get(file) ?? {}))) {
        unlisted.push(
          `${file}: found ${JSON.stringify(sorted(rec))}, listed ${JSON.stringify(sorted(listed.get(file) ?? {}))}`,
        )
      }
    }
    for (const [file, rec] of listed) {
      if (!found.has(file)) unlisted.push(`${file}: listed ${JSON.stringify(rec)}, found none`)
    }
    // A new site: hand it only the repo's own files, or a CheckedSource through
    // transpileChecked, then add or update apps/api/src/tests/untrusted-host-build.d/<name>.json.
    expect(unlisted).toEqual([])
  })

  test("a gated site's function calls its gate", () => {
    const missing: string[] = []
    for (const e of entries.values()) {
      for (const [key, gate] of Object.entries(e.gate ?? {})) {
        const fileSites = sites.filter(
          (s) => relative(REPO_ROOT, s.file) === e.file && siteKey(s) === key,
        )
        for (const s of fileSites) {
          const { fn } = enclosing(s.node)
          let calls = false
          const visit = (n: ts.Node): void => {
            if (ts.isCallExpression(n) && n.expression.getText() === gate) calls = true
            ts.forEachChild(n, visit)
          }
          if (fn) visit(fn)
          if (!calls) missing.push(`${e.file} ${key}: no call of ${gate}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test("a checked site parses only the text of a CheckedSource parameter, after the run-time test", () => {
    const problems: string[] = []
    const checked = [...entries.values()].filter((e) => e.input === "checked")
    expect(checked.length).toBeGreaterThan(0)
    for (const e of checked) {
      for (const s of sites.filter((x) => relative(REPO_ROOT, x.file) === e.file)) {
        const { fn } = enclosing(s.node)
        if (!fn || !ts.isFunctionLike(fn)) {
          problems.push(`${e.file} ${siteKey(s)}: not inside a function`)
          continue
        }
        const params = fn.parameters
          .filter((p) => p.type && CHECKED_TYPES.has(p.type.getText()))
          .map((p) => p.name.getText())
        if (params.length === 0) {
          problems.push(`${e.file} ${siteKey(s)}: no CheckedSource parameter`)
          continue
        }
        let guarded = false
        const parseArgs: string[] = []
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n)) {
            const callee = n.expression
            if (
              callee.getText() === "Checked.checkedBrandHeld" &&
              params.includes(n.arguments[0]?.getText() ?? "")
            )
              guarded = true
            if (ts.isPropertyAccessExpression(callee) && PARSE_METHODS.has(callee.name.text))
              parseArgs.push(n.arguments[0]?.getText() ?? "")
          }
          ts.forEachChild(n, visit)
        }
        visit(fn)
        if (!guarded)
          problems.push(`${e.file} ${siteKey(s)}: no Checked.checkedBrandHeld run-time test`)
        if (parseArgs.length === 0 || parseArgs.some((a) => !params.some((p) => a === `${p}.text`)))
          problems.push(`${e.file} ${siteKey(s)}: parses ${parseArgs.join(", ")}`)
      }
    }
    expect(problems).toEqual([])
  })

  test("the subprocess's own modules are never loaded into the API process", () => {
    const own = new Set(
      [...entries.values()]
        .filter((e) => e.input === "subprocess")
        .map((e) => join(REPO_ROOT, e.file)),
    )
    expect(own.size).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const [file, sf] of parsed) {
      if (own.has(file)) continue
      for (const target of valueImports(file, sf)) {
        if (own.has(target))
          offenders.push(`${relative(REPO_ROOT, file)} -> ${relative(REPO_ROOT, target)}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("the draft build is spawned as its own process, with a stripped environment", () => {
    const file = join(API_SRC, "modules/app-builder/build/build-draft.ts")
    const sf = parsed.get(file)
    expect(sf).toBeDefined()
    if (!sf) return
    const text = sf.getFullText()
    expect(text).toMatch(/const WORKER_SCRIPT = join\(import\.meta\.dir, "build-worker\.ts"\)/)
    const envKeys: string[][] = []
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        n.expression.getText() === "Bun.spawn" &&
        n.arguments[1] &&
        ts.isObjectLiteralExpression(n.arguments[1])
      ) {
        const argv = n.arguments[0]?.getText() ?? ""
        if (argv === "argv") {
          for (const prop of n.arguments[1].properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              prop.name.getText() === "env" &&
              ts.isObjectLiteralExpression(prop.initializer)
            ) {
              envKeys.push(
                prop.initializer.properties.map((p) => {
                  // A spread (`...process.env`) has no name: it would carry the host's secrets.
                  if (!ts.isPropertyAssignment(p)) return `<${ts.SyntaxKind[p.kind]}>`
                  return p.name.getText()
                }),
              )
            }
          }
        }
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    expect(envKeys.length).toBe(1)
    for (const keys of envKeys) {
      for (const k of keys) expect(["PATH", "HOME", "TMPDIR", "LANG", "NO_COLOR"]).toContain(k)
    }
  })
})

describe("CheckedSource is made by the checks only", () => {
  test("a raw string or a look-alike does not typecheck and is refused at run time", () => {
    // @ts-expect-error a raw string is no CheckedSource
    expect(() => transpileChecked("var a = 1")).toThrow(TypeError)
    const lookAlike = { text: "var a = 1", kind: "attribute-free" }
    // @ts-expect-error an object literal lacks the private brand
    expect(() => transpileChecked(lookAlike)).toThrow(TypeError)
    expect(isCheckedSource(lookAlike)).toBe(false)
  })

  test("the checks refuse a macro import and pass a plain bundle", async () => {
    const macro = 'import { m } from "./m.ts" with { type: "macro" }\nm()\n'
    expect((await checkAttributeFree(macro)).ok).toBe(false)
    expect((await checkPlainScript(macro)).ok).toBe(false)
    const plain = await checkAttributeFree("var a = 1\nfunction f() { return a }\n")
    expect(plain.ok).toBe(true)
    if (!plain.ok) return
    const source: CheckedSource = plain.source
    expect(isCheckedSource(source)).toBe(true)
    expect(transpileChecked(source)).toContain("function f()")
  })
})

describe("the scanner itself", () => {
  const scan = (text: string, wraps?: Map<string, Set<string>>) =>
    scanSource(join(API_SRC, "probe.ts"), parse(join(API_SRC, "probe.ts"), text), wraps).map(
      siteKey,
    )

  test("finds every way of reaching the parsing members", () => {
    expect(
      scan(`
        async function a(p: string) { await Bun.build({ entrypoints: [p] }) }
        function b(s: string) { return new Bun.Transpiler({ loader: "js" }).transformSync(s) }
        function c() { Bun.plugin({ name: "x", setup() {} }) }
        function d() { return globalThis.Bun.build }
        function e() { const { build } = Bun; return build }
        function f() { return Bun["Transpiler"] }
        const g = () => { const B = Bun; return B }
      `),
    ).toEqual([
      "Bun.build@a",
      "Bun.Transpiler@b",
      "Bun.plugin@c",
      "Bun.build@d",
      "Bun (indirect)@e",
      "Bun (indirect)@f",
      "Bun (indirect)@g",
    ])
    expect(scan('import { build, Transpiler, file } from "bun"\n')).toEqual([
      'import build from "bun"@<module>',
      'import Transpiler from "bun"@<module>',
    ])
    expect(scan('import * as B from "bun"\n')).toEqual(['import from "bun"@<module>'])
  })

  test("ignores comments, strings, types and the members that parse nothing", () => {
    expect(
      scan(`
        // Bun.build and new Bun.Transpiler() in a comment
        const s = "Bun.build(x)"
        type P = Bun.BunPlugin
        function ok() { Bun.spawn(["ls"]); return Bun.file("x").text() }
        const has = typeof Bun !== "undefined"
        import type { BuildConfig } from "bun"
      `),
    ).toEqual([])
  })

  test("finds the callers of a wrapping helper, static or dynamic import", () => {
    const helper = join(API_SRC, "modules/app-builder/build/freeze-core.ts")
    const wraps = new Map([[helper, new Set(["buildWorkerModule"])]])
    expect(
      scan(
        `
        import { buildWorkerModule as bwm } from "~/modules/app-builder/build/freeze-core"
        async function x() { return bwm({ handlersPath: "h" }) }
        async function y() {
          const { buildWorkerModule } = await import("~/modules/app-builder/build/freeze-core")
          return buildWorkerModule({ handlersPath: "h" })
        }
        async function z() {
          return (await import("~/modules/app-builder/build/freeze-core")).buildWorkerModule({ handlersPath: "h" })
        }
      `,
        wraps,
      ),
    ).toEqual(["buildWorkerModule@z", "buildWorkerModule@x", "buildWorkerModule@y"])
  })
})

function sorted(rec: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)))
}
