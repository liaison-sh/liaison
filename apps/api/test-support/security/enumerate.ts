// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Attack-surface enumerator.
//
// Lists every member of each surface class (HTTP routes, tables, privileged
// database sites, raw SQL, agent tools, webhooks, jobs, sandbox bridge, ...)
// so that an invariant test can iterate a whole class and a new member fails
// until it is classified. Each row carries a stable id (no line numbers) and
// the place it was found.
//
// Runtime first: routes come from the booted Hono app (`app.routes` plus the
// app's own router deciding which middleware a request passes through), tables
// from pg_catalog after every bundled app is installed, tools and webhooks from
// the runtime registries of an initialised org. Kinds that have no runtime
// listing (privileged call sites, raw SQL, jobs, CLI, desktop, push, WS) come
// from the TypeScript AST, or a text scan for non-TypeScript sources, and each
// row says which (`source`).
//
// CLI (run from apps/api, inside a test namespace for the runtime kinds):
//   bun test-support/security/enumerate.ts static            AST/text kinds
//   bun test-support/security/enumerate.ts routes [--variant]  one route variant
//   bun test-support/security/enumerate.ts runtime           tables, tools, webhooks, bridge
//   bun test-support/security/enumerate.ts all --out <file>  everything, variants in children
// `all` must run under scripts/with-test-lock.ts (it installs the bundled apps
// into the namespace database).

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Hono } from "hono"
import ts from "typescript"

// ─── Row model ──────────────────────────────────────────────────────────────

export type SurfaceKind =
  | "route"
  | "ws"
  | "table"
  | "priv"
  | "rawsql"
  | "search"
  | "redis"
  | "tool"
  | "webhook"
  | "job"
  | "bridge"
  | "hostcall"
  | "cli"
  | "service"
  | "desktop-ipc"
  | "deeplink"
  | "push"

export type RowSource = "runtime" | "ast" | "manifest" | "text"

export type AttrValue = string | number | boolean | string[] | null

export interface SurfaceRow {
  kind: SurfaceKind
  /** Stable across unrelated edits: never contains a line number. */
  id: string
  /** `file:line` relative to the liaison root, or a runtime source label. */
  location: string
  attrs: Record<string, AttrValue>
  source: RowSource
}

export interface EnumerationNote {
  kind: SurfaceKind
  note: string
}

export interface Enumeration {
  generatedAt: string
  liaisonRoot: string
  rows: SurfaceRow[]
  /** Kinds or parts that could not be enumerated at runtime, and why. */
  notes: EnumerationNote[]
  /** Independent counts the inventory cross-checks against. */
  crossCounts: CrossCount[]
}

export interface CrossCount {
  kind: SurfaceKind
  label: string
  enumerated: number
  independent: number
  method: string
}

export const LIAISON_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..")
const API_ROOT = path.join(LIAISON_ROOT, "apps", "api")

function rel(file: string, root = LIAISON_ROOT): string {
  return path.relative(root, file).split(path.sep).join("/")
}

// ─── Source file sets ───────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "tests",
  "__fixtures__",
  "__test-helpers__",
  "__tests__",
  "target",
  ".svelte-kit",
])

export function isProductSourceFile(file: string): boolean {
  if (!/\.(ts|tsx)$/.test(file)) return false
  if (/\.d\.ts$/.test(file)) return false
  if (/\.(test|spec|bench)\.tsx?$/.test(file)) return false
  if (/(^|\/)(test-helpers|test-fixtures|fixtures?)(\.|\/)/.test(file)) return false
  // foo.test-fixtures.ts: a test's own fixtures, beside it.
  if (/\.test-(fixtures?|helpers?)\.tsx?$/.test(file)) return false
  return true
}

export function listSourceFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
      listSourceFiles(full, out)
    } else if (isProductSourceFile(full)) {
      out.push(full)
    }
  }
  return out.sort()
}

/** The server-side TypeScript the privileged / raw-SQL / job scans read. */
export function serverSourceFiles(root = LIAISON_ROOT): string[] {
  const files = listSourceFiles(path.join(root, "apps", "api", "src"))
  for (const pkg of safeReaddir(path.join(root, "packages"))) {
    listSourceFiles(path.join(root, "packages", pkg, "src"), files)
  }
  listSourceFiles(path.join(root, "apps", "db-gate", "src"), files)
  return files.sort()
}

export function bundledAppSourceFiles(root = LIAISON_ROOT): string[] {
  const files: string[] = []
  for (const app of safeReaddir(path.join(root, "bundled-apps"))) {
    const dir = path.join(root, "bundled-apps", app)
    if (!statSync(dir).isDirectory()) continue
    for (const name of safeReaddir(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === "src") listSourceFiles(full, files)
      } else if (isProductSourceFile(full) && !/vitest|config/.test(name)) {
        files.push(full)
      }
    }
  }
  return files.sort()
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

const sourceCache = new Map<string, ts.SourceFile>()
export function parseFile(file: string, text?: string): ts.SourceFile {
  const cached = text === undefined ? sourceCache.get(file) : undefined
  if (cached) return cached
  const sf = ts.createSourceFile(
    file,
    text ?? readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  if (text === undefined) sourceCache.set(file, sf)
  return sf
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

function calleeName(call: ts.CallExpression): string | undefined {
  const e = call.expression
  if (ts.isIdentifier(e)) return e.text
  if (ts.isPropertyAccessExpression(e)) return e.name.text
  return undefined
}

function stringValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"])

/**
 * Name of the function a node sits in: a declared name, the variable or
 * property it is assigned to, or for an anonymous route handler the route it
 * serves (`POST /install`).
 */
export function enclosingFunctionName(node: ts.Node, sf: ts.SourceFile): string {
  const parts: string[] = []
  let cur: ts.Node | undefined = node.parent
  let routeFound = false
  while (cur) {
    if (routeFound && ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) {
      parts.unshift(cur.name.text)
      break
    }
    if (ts.isFunctionDeclaration(cur) && cur.name) {
      parts.unshift(cur.name.text)
      break
    }
    if (ts.isMethodDeclaration(cur) && cur.name) {
      parts.unshift(cur.name.getText(sf))
      const cls = cur.parent
      if (ts.isClassDeclaration(cls) && cls.name) parts.unshift(cls.name.text)
      break
    }
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      const p = cur.parent
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
        parts.unshift(p.name.text)
        break
      }
      if (ts.isPropertyAssignment(p)) {
        parts.unshift(p.name.getText(sf))
        // keep climbing to name the object owner as well
      } else if (ts.isCallExpression(p)) {
        const name = calleeName(p)
        const first = stringValue(p.arguments[0])
        if (name && HTTP_METHODS.has(name) && first !== undefined && !routeFound) {
          // Name the route, then keep climbing for the router it is defined on.
          parts.unshift(`${name.toUpperCase()} ${first}`)
          routeFound = true
        }
      }
    }
    cur = cur.parent
  }
  return parts.length > 0 ? parts.join(".") : "<module>"
}

/** True when the node is lexically inside a Hono route handler (`.get("/x", ...)`). */
function insideRouteHandler(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent
  while (cur) {
    if (ts.isCallExpression(cur)) {
      const name = calleeName(cur)
      if (name && HTTP_METHODS.has(name) && stringValue(cur.arguments[0]) !== undefined) return true
    }
    cur = cur.parent
  }
  return false
}

/** Per (file, enclosing function, label) ordinal, so ids survive line shifts. */
class OrdinalIds {
  private counts = new Map<string, number>()
  next(key: string): string {
    const n = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, n)
    return n === 1 ? key : `${key}#${n}`
  }
}

// ─── Privileged database sites (AST) ────────────────────────────────────────

export type OrgIdSource =
  | "auth-context"
  | "job/system"
  | "caller-input"
  | "db-derived"
  | "literal"
  | "no-org"
  | "unknown"

const PRIVILEGED_FNS = new Set(["withPrivilegedDb", "withSystemDb", "withSchemaAdmin"])
const ROLE_SWITCH = /SET\s+(LOCAL\s+|SESSION\s+)?ROLE\s+"?liaison_(admin|schema_admin)\b/i

const JOB_NAMES =
  /^(job|jobs|event|evt|ev|payload|msg|message|data|delivery|task|tick|outbox|envelope)$/i
const AUTH_CALL =
  /^(get|getAuth|requireAuth|getOrgId|authContext|getActor|requireOrgId|currentOrgId|extractRlsContext|actorFromCtx|getRlsContext|rlsContext)$/
/** Values read straight off the request: a URL parameter, query string or body. */
const REQUEST_INPUT_CALL = /^(param|query|queries|json|parseBody|formData|valid|header)$/

function findDeclaration(
  id: ts.Identifier,
):
  | { kind: "param"; decl: ts.ParameterDeclaration; fn: ts.SignatureDeclaration }
  | { kind: "var"; init: ts.Expression | undefined; decl: ts.Node }
  | undefined {
  const name = id.text
  let cur: ts.Node | undefined = id.parent
  while (cur) {
    if (ts.isFunctionLike(cur)) {
      for (const p of cur.parameters) {
        if (bindingHasName(p.name, name)) return { kind: "param", decl: p, fn: cur }
      }
    }
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur) || ts.isCaseClause(cur)) {
      const statements = (cur as ts.Block).statements
      for (const st of statements) {
        if (st.getStart() > id.getStart()) break
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (bindingHasName(d.name, name)) {
              const init = ts.isIdentifier(d.name) ? d.initializer : d.initializer // destructured: classify the object it came from
              return { kind: "var", init, decl: d }
            }
          }
        }
      }
    }
    if (ts.isForOfStatement(cur) || ts.isForInStatement(cur)) {
      const init = cur.initializer
      if (ts.isVariableDeclarationList(init)) {
        for (const d of init.declarations) {
          if (bindingHasName(d.name, name)) return { kind: "var", init: cur.expression, decl: d }
        }
      }
    }
    cur = cur.parent
  }
  return undefined
}

function bindingHasName(b: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(b)) return b.text === name
  for (const el of b.elements) {
    if (ts.isOmittedExpression(el)) continue
    if (bindingHasName(el.name, name)) return true
  }
  return false
}

function unwrapExpr(e: ts.Expression): ts.Expression {
  let cur = e
  for (;;) {
    if (
      ts.isAwaitExpression(cur) ||
      ts.isParenthesizedExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression
    } else if (
      ts.isAsExpression(cur) ||
      ts.isTypeAssertionExpression(cur) ||
      ts.isSatisfiesExpression(cur)
    ) {
      cur = cur.expression
    } else {
      return cur
    }
  }
}

/**
 * Best-effort classification of where an org id expression comes from:
 * the request's auth context, a job or event payload, a parameter of the
 * enclosing function (its caller decides it), a database lookup, a literal.
 */
export function classifyOrgIdExpression(
  expr: ts.Expression | undefined,
  depth = 0,
): { source: OrgIdSource; detail: string } {
  if (!expr) return { source: "unknown", detail: "missing" }
  const e = unwrapExpr(expr)
  if (depth > 6) return { source: "unknown", detail: "depth" }
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e))
    return { source: "literal", detail: e.text }
  if (ts.isCallExpression(e)) {
    const name = calleeName(e)
    const arg0 = stringValue(e.arguments[0])
    // c.get("orgId"), c.get("auth")
    if (name === "get" && ts.isPropertyAccessExpression(e.expression)) {
      const recv = e.expression.expression
      if (ts.isIdentifier(recv) && /^(c|ctx|context)$/.test(recv.text) && arg0 !== undefined) {
        return { source: "auth-context", detail: `${recv.text}.get("${arg0}")` }
      }
    }
    if (name && AUTH_CALL.test(name) && name !== "get")
      return { source: "auth-context", detail: `${name}()` }
    if (name && REQUEST_INPUT_CALL.test(name) && /\breq\b|^c\./.test(e.expression.getText())) {
      return { source: "caller-input", detail: `request ${e.expression.getText().slice(0, 40)}()` }
    }
    if (
      name &&
      /find|select|lookup|load|resolve|fetch|query|read|with(System|Privileged)Db|withRlsContext/i.test(
        name,
      )
    ) {
      return { source: "db-derived", detail: `${name}()` }
    }
    return { source: "unknown", detail: `call ${name ?? "?"}()` }
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    // c.var.orgId
    const text = e.getText()
    if (/^c\.var\./.test(text)) return { source: "auth-context", detail: text }
    let base: ts.Expression = e.expression
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base))
      base = base.expression
    base = unwrapExpr(base)
    if (ts.isIdentifier(base)) {
      if (JOB_NAMES.test(base.text)) return { source: "job/system", detail: text }
      const inner = classifyOrgIdExpression(base, depth + 1)
      if (inner.source === "caller-input")
        return { source: "caller-input", detail: `${text} (${inner.detail})` }
      if (
        inner.source === "unknown" &&
        /^(row|conn|connection|node|owner|device|session|account|org|user|install|record|r|u|t|existing|target|thread|doc)$/i.test(
          base.text,
        )
      ) {
        return { source: "db-derived", detail: text }
      }
      return { source: inner.source, detail: `${text} <- ${inner.detail}` }
    }
    if (ts.isCallExpression(base)) {
      const inner = classifyOrgIdExpression(base, depth + 1)
      return { source: inner.source, detail: `${text}` }
    }
    return { source: "unknown", detail: text }
  }
  if (ts.isIdentifier(e)) {
    if (/^[A-Z][A-Z0-9_]*$/.test(e.text)) return { source: "literal", detail: `const ${e.text}` }
    const decl = findDeclaration(e)
    if (!decl) return { source: "unknown", detail: `free ${e.text}` }
    if (decl.kind === "param") {
      const fn = decl.fn
      const fnName =
        fn.name && ts.isIdentifier(fn.name)
          ? fn.name.text
          : enclosingFunctionName(fn.parameters[0] ?? fn, fn.getSourceFile())
      if (JOB_NAMES.test(decl.decl.name.getText()))
        return { source: "job/system", detail: `param ${e.text} of ${fnName}` }
      return { source: "caller-input", detail: `param ${e.text} of ${fnName}` }
    }
    if (!decl.init) return { source: "unknown", detail: `uninitialised ${e.text}` }
    const inner = classifyOrgIdExpression(decl.init, depth + 1)
    return { source: inner.source, detail: `${e.text} = ${inner.detail}` }
  }
  if (ts.isConditionalExpression(e)) return classifyOrgIdExpression(e.whenTrue, depth + 1)
  if (ts.isBinaryExpression(e)) return classifyOrgIdExpression(e.left, depth + 1)
  return { source: "unknown", detail: ts.SyntaxKind[e.kind] }
}

export function enumeratePrivilegedSites(
  files: string[],
  root = LIAISON_ROOT,
  texts?: Map<string, string>,
  reviews: OrgTraceReviews = {},
): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  for (const file of files) {
    const text = texts?.get(file) ?? readFileSync(file, "utf8")
    if (!/withPrivilegedDb|withSystemDb|withSchemaAdmin|ROLE/.test(text)) continue
    const sf = parseFile(file, texts ? text : undefined)
    const ids = new OrdinalIds()
    const relFile = rel(file, root)
    walk(sf, (n) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n)
        if (!name || !PRIVILEGED_FNS.has(name)) return
        // the definitions themselves are declarations, not calls; imports are not calls
        const fn = enclosingFunctionName(n, sf)
        let cls: { source: OrgIdSource; detail: string }
        let reason: string | undefined
        if (name === "withSystemDb") {
          cls = { source: "no-org", detail: "system: no org pinned (BYPASSRLS across orgs)" }
          reason = stringValue(n.arguments[0])
        } else {
          cls = classifyOrgIdExpression(n.arguments[0])
          reason = stringValue(n.arguments[1])
        }
        // An org id taken from a parameter: what the function's callers pass.
        // A parameter, or an expression the classifier could not place.
        const orgArg = name === "withSystemDb" ? undefined : n.arguments[0]
        const traceable =
          orgArg !== undefined &&
          ((cls.source === "caller-input" && !/^request|\(request/.test(cls.detail)) ||
            cls.source === "unknown")
        const trace = traceable ? traceOrgIdParameter(orgArg, files, texts, reviews) : undefined
        rows.push({
          kind: "priv",
          id: `priv:${ids.next(`${relFile}#${fn}#${name}`)}`,
          location: `${relFile}:${lineOf(sf, n)}`,
          attrs: {
            fn: name,
            enclosing: fn,
            orgIdSource: cls.source,
            orgIdDetail: cls.detail.slice(0, 160),
            reason: reason ?? null,
            inRouteHandler: insideRouteHandler(n),
            ...(trace
              ? {
                  orgIdTrace:
                    trace.verdict === "traced"
                      ? `traced: callers pass ${trace.via.join(", ") || "(cycle)"}`
                      : `untraced: ${trace.why}`.slice(0, 1200),
                }
              : {}),
          },
          source: "ast",
        })
      } else if (
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        ts.isTemplateHead(n)
      ) {
        const t = n.text
        if (!ROLE_SWITCH.test(t)) return
        const fn = enclosingFunctionName(n, sf)
        rows.push({
          kind: "priv",
          id: `priv:${ids.next(`${relFile}#${fn}#SET-ROLE`)}`,
          location: `${relFile}:${lineOf(sf, n)}`,
          attrs: {
            fn: "SET ROLE",
            enclosing: fn,
            orgIdSource: "unknown",
            orgIdDetail: t.trim().slice(0, 160),
            reason: null,
            inRouteHandler: insideRouteHandler(n),
          },
          source: "ast",
        })
      }
    })
  }
  return rows
}

// ─── Import resolution (for caller matching) ───────────────────────────────

interface FileImports {
  /** local name → the file it is imported from (null: not resolvable) and the exported name. */
  named: Map<string, { file: string | null; name: string }>
  /** `import * as ns`: local name → file. */
  namespaces: Map<string, string | null>
}

const importsCache = new Map<string, FileImports>()

/** The source file a module specifier names, or null when it is not one of ours. */
function resolveModule(fromFile: string, spec: string): string | null {
  let base: string | undefined
  if (spec.startsWith("~/")) base = path.join(API_ROOT, "src", spec.slice(2))
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec)
  else if (spec.startsWith("@liaison/")) {
    const [pkg, ...sub] = spec.slice("@liaison/".length).split("/")
    const root = path.join(LIAISON_ROOT, "packages", pkg ?? "")
    base = sub.length > 0 ? path.join(root, "src", ...sub) : path.join(root, "src", "index")
  }
  if (!base) return null
  const stripped = base.replace(/\.(js|ts|tsx)$/, "")
  for (const c of [`${stripped}.ts`, `${stripped}.tsx`, path.join(stripped, "index.ts"), base]) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

function importsOf(sf: ts.SourceFile): FileImports {
  const cached = importsCache.get(sf.fileName)
  if (cached) return cached
  const named = new Map<string, { file: string | null; name: string }>()
  const namespaces = new Map<string, string | null>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    const file = resolveModule(sf.fileName, st.moduleSpecifier.text)
    const clause = st.importClause
    if (!clause) continue
    if (clause.name) named.set(clause.name.text, { file, name: "default" })
    const b = clause.namedBindings
    if (b && ts.isNamespaceImport(b)) namespaces.set(b.name.text, file)
    if (b && ts.isNamedImports(b)) {
      for (const el of b.elements) {
        named.set(el.name.text, { file, name: (el.propertyName ?? el.name).getText() })
      }
    }
  }
  const out = { named, namespaces }
  importsCache.set(sf.fileName, out)
  return out
}

/** True when `file` exports `name` from `target`, itself or through re-exports. */
function exportsFrom(file: string, name: string, target: string, depth = 0): boolean {
  if (file === target) return true
  if (depth > 6 || !existsSync(file)) return false
  const sf = parseFile(file)
  for (const st of sf.statements) {
    if (
      !ts.isExportDeclaration(st) ||
      !st.moduleSpecifier ||
      !ts.isStringLiteral(st.moduleSpecifier)
    )
      continue
    const from = resolveModule(file, st.moduleSpecifier.text)
    if (!from) continue
    const clause = st.exportClause
    if (!clause) {
      if (exportsFrom(from, name, target, depth + 1)) return true
      continue
    }
    if (ts.isNamedExports(clause)) {
      for (const el of clause.elements) {
        if (el.name.text !== name) continue
        if (exportsFrom(from, (el.propertyName ?? el.name).getText(), target, depth + 1))
          return true
      }
    }
  }
  return false
}

/** A function declared at module level (not a method or an object property). */
function isModuleLevelFunction(fn: ts.SignatureDeclaration): boolean {
  if (ts.isFunctionDeclaration(fn)) return ts.isSourceFile(fn.parent)
  const v = fn.parent
  return (
    !!v &&
    ts.isVariableDeclaration(v) &&
    ts.isVariableDeclarationList(v.parent) &&
    ts.isVariableStatement(v.parent.parent) &&
    ts.isSourceFile(v.parent.parent.parent)
  )
}

/** In `(deps.f ?? f)(...)`, the operand that names `name`. */
function calleeOperand(e: ts.Expression, name: string): ts.Expression {
  const x = unwrapExpr(e)
  const names = (o: ts.Expression) => {
    const u = unwrapExpr(o)
    return (
      (ts.isIdentifier(u) && u.text === name) ||
      (ts.isPropertyAccessExpression(u) && u.name.text === name)
    )
  }
  if (ts.isBinaryExpression(x)) {
    if (names(x.right)) return unwrapExpr(x.right)
    if (names(x.left)) return unwrapExpr(x.left)
    return calleeOperand(x.right, name)
  }
  if (ts.isConditionalExpression(x))
    return names(x.whenTrue) ? unwrapExpr(x.whenTrue) : unwrapExpr(x.whenFalse)
  return x
}

/**
 * Whether a call named like `fn` really calls it. A module-level function is
 * called by its own file, by a file that imports it (directly or through a
 * re-export), or through a namespace import; a call of a same-named function
 * from another module, or of a method of some object, is not its caller. An
 * import that does not resolve to one of our files is kept (conservative).
 */
function isCallOf(call: ts.CallExpression, fn: ts.SignatureDeclaration, name: string): boolean {
  if (!isModuleLevelFunction(fn)) return true
  const defFile = fn.getSourceFile().fileName
  const sf = call.getSourceFile()
  const e = calleeOperand(unwrapExpr(call.expression), name)
  const imports = importsOf(sf)
  if (ts.isIdentifier(e)) {
    const imp = imports.named.get(e.text)
    if (imp) return imp.file === null || (imp.name === name && exportsFrom(imp.file, name, defFile))
    if (sf.fileName === defFile) return true
    // const { fn } = await import("~/x")
    const d = findDeclaration(e)
    const init = d?.kind === "var" && d.init ? unwrapExpr(d.init) : undefined
    if (
      init &&
      ts.isCallExpression(init) &&
      init.expression.kind === ts.SyntaxKind.ImportKeyword &&
      init.arguments[0] &&
      ts.isStringLiteral(init.arguments[0])
    ) {
      const file = resolveModule(sf.fileName, init.arguments[0].text)
      return file === null || exportsFrom(file, name, defFile)
    }
    return false
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    // const mod = await import("~/x"); mod.fn(...)
    const d = findDeclaration(e.expression)
    const init = d?.kind === "var" && d.init ? unwrapExpr(d.init) : undefined
    if (
      init &&
      ts.isCallExpression(init) &&
      init.expression.kind === ts.SyntaxKind.ImportKeyword &&
      init.arguments[0] &&
      ts.isStringLiteral(init.arguments[0])
    ) {
      const file = resolveModule(sf.fileName, init.arguments[0].text)
      return file === null || exportsFrom(file, name, defFile)
    }
    if (!imports.namespaces.has(e.expression.text)) return false
    const file = imports.namespaces.get(e.expression.text) ?? null
    return file === null || exportsFrom(file, name, defFile)
  }
  return false
}

// ─── Org id callers (AST) ───────────────────────────────────────────────────
//
// A privileged site whose org id is a parameter of its function is as safe as
// what that function's callers pass. `traceOrgIdParameters` follows the
// parameter to every call of the function (by name, across the server
// sources) and classifies the argument each one passes, climbing again when
// that argument is itself a parameter of the caller. A site is `traced` when
// every caller passes the request's auth context or a job / event payload's
// org, and `untraced` (with why) when a caller passes anything else, when no
// caller is found, or when the function escapes as a value (a callback, a
// registry entry, `.call`) so its callers cannot all be seen.

type OrgParamPath = { fn: ts.SignatureDeclaration; index: number; path: string[] }

/** Follows an org id expression back to a parameter of an enclosing function. */
function resolveOrgParam(expr: ts.Expression, depth = 0): OrgParamPath | undefined {
  if (depth > 8) return undefined
  const e = unwrapExpr(expr)
  if (ts.isPropertyAccessExpression(e)) {
    const base = resolveOrgParam(e.expression, depth + 1)
    return base ? { ...base, path: [...base.path, e.name.text] } : undefined
  }
  if (ts.isElementAccessExpression(e)) {
    const key = stringValue(e.argumentExpression)
    if (key === undefined) return undefined
    const base = resolveOrgParam(e.expression, depth + 1)
    return base ? { ...base, path: [...base.path, key] } : undefined
  }
  if (ts.isConditionalExpression(e)) return undefined
  if (ts.isBinaryExpression(e)) {
    // orgId ?? fallback, orgId || fallback: the left side is what is passed.
    const op = e.operatorToken.kind
    if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken)
      return resolveOrgParam(e.left, depth + 1)
    return undefined
  }
  if (!ts.isIdentifier(e)) return undefined
  const decl = findDeclaration(e)
  if (!decl) return undefined
  if (decl.kind === "param") {
    const index = decl.fn.parameters.indexOf(decl.decl)
    if (decl.decl.dotDotDotToken) return undefined
    return { fn: decl.fn, index, path: bindingPath(decl.decl.name, e.text) ?? [] }
  }
  if (!decl.init) return undefined
  const v = decl.decl as ts.VariableDeclaration
  if (!ts.isVariableDeclaration(v)) return undefined
  // for (const x of list): not a single value.
  if (ts.isForOfStatement(v.parent?.parent) || ts.isForInStatement(v.parent?.parent))
    return undefined
  const inner = resolveOrgParam(decl.init, depth + 1)
  if (!inner) return undefined
  const sub = bindingPath(v.name, e.text)
  return sub ? { ...inner, path: [...inner.path, ...sub] } : undefined
}

/** The property path of `name` inside a binding (`{ a: { orgId } }` → ["a", "orgId"]). */
function bindingPath(b: ts.BindingName, name: string): string[] | undefined {
  if (ts.isIdentifier(b)) return b.text === name ? [] : undefined
  if (ts.isArrayBindingPattern(b)) return undefined
  for (const el of b.elements) {
    // const { a, ...rest } = obj: rest is obj without a, so a path into rest is a path into obj.
    if (el.dotDotDotToken) {
      if (ts.isIdentifier(el.name) && el.name.text === name) return []
      continue
    }
    const key = el.propertyName ? el.propertyName.getText() : el.name.getText()
    const inner = bindingPath(el.name, name)
    if (inner) return [key, ...inner]
  }
  return undefined
}

/** The name a function is called by, or undefined for an anonymous one. */
function callableName(fn: ts.SignatureDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return ts.isIdentifier(fn.name) ? fn.name.text : undefined
  }
  if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || !fn.parent) return undefined
  // const run = deps.run ?? ((org) => ...): the default is called as run.
  let p: ts.Node = fn.parent
  while (
    p.parent &&
    (ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isConditionalExpression(p) ||
      (ts.isBinaryExpression(p) &&
        (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          p.operatorToken.kind === ts.SyntaxKind.BarBarToken)))
  )
    p = p.parent
  if (
    (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) &&
    ts.isIdentifier(p.name)
  )
    return p.name.text
  // return async (...) => ...: called as outer()(...), or under the name outer()'s result is
  // stored under.
  if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === fn)) {
    let f: ts.Node | undefined = p.parent
    while (f && !ts.isFunctionLike(f)) f = f.parent
    const outer = f && ts.isFunctionLike(f) ? callableName(f) : undefined
    return outer ? `${outer}()` : undefined
  }
  return undefined
}

interface CallIndex {
  calls: Map<string, ts.CallExpression[]>
  /** Named functions (declarations, arrow constants, methods) by name. */
  decls: Map<string, ts.SignatureDeclaration[]>
  /** Names referenced other than as a callee (passed, stored, bound), with where. */
  escapes: Map<string, Array<{ why: string; node: ts.Node; local: boolean }>>
  /**
   * A function stored under another name (`const run = deps.run ?? runIt`, `{ handler: h }`).
   * A local name (a variable, a parameter) is scoped: only calls and uses inside its scope count.
   */
  aliases: Map<string, Alias[]>
}

interface Alias {
  name: string
  scope?: ts.Node
}

/** The key aliases are stored under: a global name, or a local name with its scope. */
function aliasKey(name: string, scope?: ts.Node): string {
  return scope ? `${name}@${scope.getSourceFile().fileName}:${scope.pos}` : name
}

/**
 * The function a declaration is visible in, or undefined at module level (a module-level
 * binding can be exported and called from anywhere, so it is matched by name).
 */
function declarationScope(n: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = n.parent
  while (cur && !ts.isFunctionLike(cur) && !ts.isSourceFile(cur)) cur = cur.parent
  return cur && !ts.isSourceFile(cur) ? cur : undefined
}

/** Arguments to these do not keep the function: type guards, regex tests, logging. */
const HARMLESS_ARG_CALLEE =
  /^(is[A-Z]\w*|test|has|includes|String|Boolean|Number|stringify|debug|info|warn|error|log)$/

type AliasUse =
  | { name: string; scope?: ts.Node }
  | { call: ts.CallExpression }
  | { harmless: true }
  | { argOf: string; index: number; call: ts.CallExpression }
  | undefined

/**
 * What becomes of a function value: stored under another name (a variable, a property, a
 * parameter default, a returned value), called on the spot (`(deps.f ?? f)(...)`), handed to a
 * call that does not keep it, or (undefined) anything else. Climbs parentheses, casts, `??` /
 * `||` defaults, conditionals and `withX(fn)` wrappers.
 */
function aliasTarget(n: ts.Expression): AliasUse {
  let cur: ts.Node = n
  for (;;) {
    const p: ts.Node | undefined = cur.parent
    if (!p) return undefined
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      (ts.isConditionalExpression(p) && p.condition !== cur) ||
      (ts.isBinaryExpression(p) &&
        (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
          p.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === cur)))
    ) {
      cur = p
      continue
    }
    if (ts.isCallExpression(p) && p.expression === cur) return { call: p }
    if (ts.isTypeOfExpression(p)) return { harmless: true }
    // Tested, not kept: `!fn`, `if (fn)`, `fn === x`, `fn && ...`, the target of `fn = ...`.
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken)
      return { harmless: true }
    if ((ts.isIfStatement(p) || ts.isWhileStatement(p)) && p.expression === cur)
      return { harmless: true }
    if (ts.isConditionalExpression(p) && p.condition === cur) return { harmless: true }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind
      if (
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken ||
        op === ts.SyntaxKind.InstanceOfKeyword ||
        (op === ts.SyntaxKind.AmpersandAmpersandToken && p.left === cur) ||
        (op === ts.SyntaxKind.EqualsToken && p.left === cur)
      )
        return { harmless: true }
    }
    if (ts.isCallExpression(p) && p.arguments.includes(cur as ts.Expression)) {
      const callee = calleeName(p)
      if (callee && HARMLESS_ARG_CALLEE.test(callee)) return { harmless: true }
      // handler: withResultHint(fn, hint): the wrapper calls fn with its own arguments.
      if (callee && /^with[A-Z]/.test(callee)) {
        cur = p
        continue
      }
      // run(tool.handler, ...): stored as run's parameter, called by that name inside run.
      if (callee)
        return { argOf: callee, index: p.arguments.indexOf(cur as ts.Expression), call: p }
      return undefined
    }
    if (ts.isVariableDeclaration(p) && p.initializer === cur && ts.isIdentifier(p.name))
      return { name: p.name.text, scope: declarationScope(p) }
    if (ts.isParameter(p) && p.initializer === cur && ts.isIdentifier(p.name))
      return { name: p.name.text, scope: p.parent }
    if (ts.isPropertyAssignment(p) && p.initializer === cur && ts.isIdentifier(p.name))
      return { name: p.name.text }
    if (ts.isPropertyDeclaration(p) && p.initializer === cur && ts.isIdentifier(p.name))
      return { name: p.name.text }
    // return fn: the callers of the enclosing function's result, `outer()(...)`.
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === cur)) {
      let f: ts.Node | undefined = p
      while (f && !ts.isFunctionLike(f)) f = f.parent
      const outer = f && ts.isFunctionLike(f) ? callableName(f) : undefined
      return outer ? { name: `${outer}()` } : undefined
    }
    if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      p.right === cur
    ) {
      const l = p.left
      if (ts.isIdentifier(l)) {
        const d = findDeclaration(l)
        const scope = d ? declarationScope(d.decl) : undefined
        return { name: l.text, ...(scope ? { scope } : {}) }
      }
      if (ts.isPropertyAccessExpression(l)) return { name: l.name.text }
    }
    return undefined
  }
}

const callIndexCache = new WeakMap<string[], CallIndex>()

function buildCallIndex(files: string[], texts?: Map<string, string>): CallIndex {
  const cached = texts ? undefined : callIndexCache.get(files)
  if (cached) return cached
  const calls = new Map<string, ts.CallExpression[]>()
  const decls = new Map<string, ts.SignatureDeclaration[]>()
  const escapes = new Map<string, Array<{ why: string; node: ts.Node; local: boolean }>>()
  const aliases = new Map<string, Alias[]>()
  // `from` is an aliasKey: a global name, or a local name with its scope.
  const addAlias = (from: string, to: string, scope?: ts.Node) => {
    if (from === to && !scope) return
    aliases.set(from, [...(aliases.get(from) ?? []), { name: to, ...(scope ? { scope } : {}) }])
  }
  const addEscape = (name: string, why: string, node: ts.Node, local = false) => {
    escapes.set(name, [...(escapes.get(name) ?? []), { why, node, local }])
  }
  const passedTo: Array<{
    /** aliasKey of what was passed. */
    name: string
    /** Its plain name. */
    plain: string
    argOf: string
    index: number
    call: ts.CallExpression
    why: string
  }> = []
  // `name` is the referenced name; `from` the aliasKey it is known under (a local binding's
  // key carries its scope, so two parameters named alike never share aliases).
  const recordUse = (
    name: string,
    use: NonNullable<AliasUse>,
    why = "",
    from: string = name,
  ): boolean => {
    if ("harmless" in use) return true
    if ("argOf" in use) {
      passedTo.push({
        name: from,
        plain: name,
        argOf: use.argOf,
        index: use.index,
        call: use.call,
        why,
      })
      return true
    }
    if ("call" in use) {
      calls.set(name, [...(calls.get(name) ?? []), use.call])
      return true
    }
    addAlias(from, use.name, use.scope)
    return true
  }
  for (const file of files) {
    // Test-world seeding and test helpers never run in a deployment: not callers.
    if (/\/packages\/test-helpers\//.test(file)) continue
    const sf = parseFile(file, texts?.get(file))
    walk(sf, (n) => {
      if (ts.isFunctionLike(n)) {
        const fname = callableName(n)
        if (fname) decls.set(fname, [...(decls.get(fname) ?? []), n])
      }
      if (ts.isCallExpression(n)) {
        // handler: withResultHint(fn): what withResultHint returns is stored as "handler".
        const made = calleeName(n)
        if (made) {
          const use = aliasTarget(n)
          if (use && "name" in use) addAlias(`${made}()`, use.name, use.scope)
        }
        // outer()(...): a call of what outer returns.
        const inner = unwrapExpr(n.expression)
        const innerName = ts.isCallExpression(inner) ? calleeName(inner) : undefined
        const name = innerName ? `${innerName}()` : calleeName(n)
        if (name) {
          const list = calls.get(name) ?? []
          list.push(n)
          calls.set(name, list)
        }
        return
      }
      if (!ts.isIdentifier(n)) return
      const p = n.parent
      if (!p) return
      const noteEscape = (why: string) =>
        addEscape(n.text, `${why} at ${rel(file)}:${lineOf(sf, n)}`, n)
      if ((ts.isExportSpecifier(p) || ts.isImportSpecifier(p)) && p.propertyName) {
        // import { a as b }: b's callers in this file are a's; export { a as b }: everywhere.
        if (p.propertyName === n)
          addAlias(n.text, p.name.text, ts.isImportSpecifier(p) ? sf : undefined)
        return
      }
      // A declaration's own name.
      if ((p as { name?: ts.Node }).name === n && !ts.isPropertyAccessExpression(p)) return
      if (ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isQualifiedName(p)) return
      if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p) || ts.isExpressionWithTypeArguments(p))
        return
      if (ts.isCallExpression(p) && p.expression === n) return
      if (ts.isPropertyAccessExpression(p)) {
        const gp = p.parent
        if (p.name === n) {
          if (gp && ts.isCallExpression(gp) && gp.expression === p) return
          if (gp && ts.isPropertyAccessExpression(gp) && gp.expression === p) {
            if (/^(call|apply|bind)$/.test(gp.name.text)) noteEscape(`.${gp.name.text}`)
            return
          }
          // A bare property read (obj.fn) stored under another name, or handed on as a value.
          const use = aliasTarget(p)
          if (use && recordUse(n.text, use, `read as a value at ${rel(file)}:${lineOf(sf, n)}`))
            return
          if (
            gp &&
            (ts.isCallExpression(gp) ||
              ts.isPropertyAssignment(gp) ||
              ts.isShorthandPropertyAssignment(gp) ||
              ts.isVariableDeclaration(gp) ||
              ts.isReturnStatement(gp) ||
              ts.isArrayLiteralExpression(gp))
          )
            noteEscape("read as a value")
          return
        }
        if (/^(call|apply|bind)$/.test(p.name.text)) noteEscape(`.${p.name.text}`)
        return
      }
      if (ts.isExportAssignment(p)) {
        noteEscape("default export")
        return
      }
      // A local binding (a parameter, a variable) of the same name is not a module function;
      // its uses matter only to an alias scoped to it (a function handed in as that parameter).
      const local = findDeclaration(n)
      // A module-level binding is matched by name like a module function (it can be exported).
      const localScope = local ? declarationScope(local.decl) : undefined
      const isLocal =
        !!local &&
        !!localScope &&
        !(
          local.kind === "var" &&
          local.init &&
          (ts.isArrowFunction(local.init) || ts.isFunctionExpression(local.init))
        )
      // { handler } is a property of the same name: its callers are already matched by name.
      if (ts.isShorthandPropertyAssignment(p)) return
      const use = aliasTarget(n)
      if (isLocal && local) {
        const from = aliasKey(n.text, localScope)
        if (use && recordUse(n.text, use, `used as a value at ${rel(file)}:${lineOf(sf, n)}`, from))
          return
        addEscape(n.text, `used as a value at ${rel(file)}:${lineOf(sf, n)}`, n, true)
        return
      }
      if (use && recordUse(n.text, use, `used as a value at ${rel(file)}:${lineOf(sf, n)}`)) return
      noteEscape("used as a value")
    })
  }
  // A function passed to a named function becomes that function's parameter; one passed
  // anywhere else (a registry, an unknown or overloaded callee) escapes.
  for (const u of passedTo) {
    // The callee this call really reaches (imports resolved), when there is exactly one.
    // Methods are matched by name only, too loosely to follow a function into them.
    const targets = (decls.get(u.argOf) ?? []).filter(
      (d) => isModuleLevelFunction(d) && isCallOf(u.call, d, u.argOf),
    )
    const param = targets.length === 1 ? targets[0]?.parameters[u.index] : undefined
    const target = targets[0]
    if (param && target && ts.isIdentifier(param.name) && !param.dotDotDotToken)
      addAlias(u.name, param.name.text, target)
    else addEscape(u.plain, `${u.why} (passed to ${u.argOf})`, u.call, u.name !== u.plain)
  }
  const index = { calls, decls, escapes, aliases }
  if (!texts) callIndexCache.set(files, index)
  return index
}

export type OrgTrace = { verdict: "traced"; via: string[] } | { verdict: "untraced"; why: string }

const TRUSTED_ORG_SOURCES = new Set<OrgIdSource>(["auth-context", "job/system"])
/** Above this many calls by one name, a method's callers are not attributable by name. */
const GENERIC_METHOD_CALLS = 30

/** A path step meaning "an element of this list". */
const ELEMENT = "[]"

/** Reviewed knowledge the tracer may lean on (the invariant test supplies it). */
export interface OrgTraceReviews {
  /** Calls whose result carries an org the caller is authenticated for: name → why. */
  trustedSources?: Record<string, string>
  /** Functions that escape as values to a reviewed dispatcher: name → why its callers are safe. */
  reviewedEscapes?: Record<string, string>
  /**
   * Functions (`file#enclosing`) whose calls pass an org id a person reviewed (a sweep over
   * every org, an operator command): a call made from one of them is not followed further.
   */
  reviewedOrigins?: Record<string, string>
  /**
   * Functions (`file#name`) that keep the function they are given in a registry and call it
   * later: what they are handed is traced as called by a reviewed dispatcher.
   */
  reviewedRegistries?: Record<string, string>
}

/** The expression at `path` inside an object literal (through spreads). */
function navigate(
  expr: ts.Expression,
  path: string[],
): { expr: ts.Expression; path: string[] } | { missing: string } {
  let cur = expr
  let rest = path
  while (rest.length > 0) {
    const x = unwrapExpr(cur)
    if (!ts.isObjectLiteralExpression(x)) break
    const key = rest[0]
    // The last writer of the key wins: an explicit property, or a spread that can carry it.
    let next: { expr: ts.Expression; consumed: boolean } | undefined
    for (const p of [...x.properties].reverse()) {
      if (ts.isPropertyAssignment(p) && p.name.getText() === key) {
        next = { expr: p.initializer, consumed: true }
      } else if (ts.isShorthandPropertyAssignment(p) && p.name.text === key) {
        next = { expr: p.name, consumed: true }
      } else if (ts.isSpreadAssignment(p) && mayCarryKey(p.expression, key)) {
        next = { expr: p.expression, consumed: false }
      }
      if (next) break
    }
    if (!next) return { missing: `no ${key} in the object passed` }
    cur = next.expr
    if (next.consumed) rest = rest.slice(1)
  }
  return { expr: cur, path: rest }
}

/** False only when the expression is plainly an object without `key` (`{ a }`, `x ? { a } : {}`). */
function mayCarryKey(e: ts.Expression, key: string): boolean {
  const x = unwrapExpr(e)
  if (ts.isConditionalExpression(x))
    return mayCarryKey(x.whenTrue, key) || mayCarryKey(x.whenFalse, key)
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    return mayCarryKey(x.right, key)
  // ...(() => { ...; return cond ? { a } : {} })(): what the inline function returns.
  if (ts.isCallExpression(x)) {
    const f = unwrapExpr(x.expression)
    if (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) {
      return returnedObjects(f).some((r) => mayCarryKey(r, key))
    }
  }
  if (!ts.isObjectLiteralExpression(x)) return true
  return x.properties.some(
    (p) =>
      ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name.getText() === key) ||
      (ts.isSpreadAssignment(p) && mayCarryKey(p.expression, key)),
  )
}

/** The object literals a function returns (its body's return statements, or an arrow's body). */
function returnedObjects(fn: ts.SignatureDeclaration): ts.Expression[] {
  const body = (fn as ts.FunctionLikeDeclaration).body
  if (!body) return []
  if (!ts.isBlock(body)) return [body]
  const out: ts.Expression[] = []
  const visit = (n: ts.Node) => {
    if (n !== body && ts.isFunctionLike(n)) return
    if (ts.isReturnStatement(n) && n.expression) out.push(n.expression)
    ts.forEachChild(n, visit)
  }
  visit(body)
  return out
}

/**
 * Follows an org id to where it is minted: the request's auth context, a job
 * payload, a reviewed source, or (through every call of the function whose
 * parameter it is, and through factories that copy a parameter into the object
 * they return) to each caller in turn. `files` are the sources searched for
 * callers and factories (the server sources).
 */
export function traceOrgIdParameter(
  orgExpr: ts.Expression,
  files: string[],
  texts?: Map<string, string>,
  reviews: OrgTraceReviews = {},
): OrgTrace {
  const index = buildCallIndex(files, texts)
  const trusted = reviews.trustedSources ?? {}
  const reviewedEscapes = reviews.reviewedEscapes ?? {}
  const reviewedOrigins = reviews.reviewedOrigins ?? {}
  const reviewedRegistries = reviews.reviewedRegistries ?? {}
  const memo = new Map<string, OrgTrace | "pending">()
  const untraced = (why: string): OrgTrace => ({ verdict: "untraced", why })

  const traceParam = (p: OrgParamPath, depth: number): OrgTrace => {
    const name = callableName(p.fn)
    const where = `${rel(p.fn.getSourceFile().fileName)}:${lineOf(p.fn.getSourceFile(), p.fn)}`
    if (!name)
      return untraced(
        `anonymous function at ${where} (a callback; its caller is not visible by name)`,
      )
    const key = `${where}#${p.index}#${p.path.join(".")}`
    const seen = memo.get(key)
    if (seen === "pending") return { verdict: "traced", via: [] }
    if (seen) return seen
    if (depth > 60) return untraced(`caller chain deeper than 60 at ${name}`)
    memo.set(key, "pending")
    const result = ((): OrgTrace => {
      const via: string[] = []
      // The function's own name and every name it is stored under (a local name only
      // within its scope).
      const names: Alias[] = [{ name }]
      const seenNames = new Set<string>([name])
      for (let i = 0; i < names.length; i++) {
        const cur = names[i]
        for (const a of index.aliases.get(cur ? aliasKey(cur.name, cur.scope) : "") ?? []) {
          const k = `${a.name}@${a.scope ? `${a.scope.getSourceFile().fileName}:${a.scope.pos}` : "*"}`
          if (seenNames.has(k)) continue
          seenNames.add(k)
          names.push(a)
        }
      }
      const inScope = (a: Alias, node: ts.Node) => !a.scope || isInside(node, a.scope)
      // Handed to a reviewed registry: called later by its reviewed dispatcher, so what the
      // registry does with it (stores it, passes it on) is not an escape.
      const registered = new Set<Alias>()
      for (const a of names) {
        if (!a.scope || !ts.isFunctionLike(a.scope)) continue
        const reg = `${rel(a.scope.getSourceFile().fileName)}#${callableName(a.scope) ?? "?"}`
        if (!reviewedRegistries[reg]) continue
        via.push(`reviewed registry ${reg}`)
        registered.add(a)
      }
      for (const a of names) {
        if (registered.has(a)) continue
        // A reviewed dispatch point: whatever is stored under that name is called by it.
        if (reviewedEscapes[a.name]) {
          via.push(`reviewed dispatch of ${a.name}`)
          continue
        }
        // A global name ignores local bindings that share it; a scoped one sees only its scope.
        const escaped = (index.escapes.get(a.name) ?? []).find((x) =>
          a.scope ? isInside(x.node, a.scope) : !x.local,
        )
        if (!escaped) continue
        if (!reviewedEscapes[a.name])
          return untraced(
            `${a.name} ${escaped.why}${a.name === name ? "" : ` (stored from ${name})`}`,
          )
        via.push(`reviewed dispatch of ${a.name}`)
      }
      // A method (or an object's function property) is matched by name only. Under a name
      // called all over the code (execute, run, get, parse, ...) its callers cannot be told
      // apart from other functions' callers: stop and say so.
      if (!isModuleLevelFunction(p.fn)) {
        const n = (index.calls.get(name) ?? []).length
        if (n > GENERIC_METHOD_CALLS && !reviewedEscapes[name])
          return untraced(
            `method ${name} shares its name with ${n} calls; its callers are not attributable`,
          )
      }
      // Calls by the function's own name must really reach it (imports resolved); calls by a
      // name it is stored under are taken by name.
      const calls = [
        ...new Set(
          names.flatMap((a) =>
            (index.calls.get(a.name) ?? []).filter(
              (c) => inScope(a, c) && (a.name !== name || a.scope || isCallOf(c, p.fn, name)),
            ),
          ),
        ),
      ].filter((c) => !isInside(c, p.fn))
      if (calls.length === 0 && via.length === 0)
        return untraced(`no caller of ${[...new Set(names.map((a) => a.name))].join(" / ")} found`)
      for (const call of calls) {
        const sf = call.getSourceFile()
        const at = `${rel(sf.fileName)}:${lineOf(sf, call)}`
        const origin = `${rel(sf.fileName)}#${enclosingFunctionName(call, sf)}`
        if (reviewedOrigins[origin]) {
          via.push(`reviewed origin ${origin}`)
          continue
        }
        const spreadAt = call.arguments.findIndex((a) => ts.isSpreadElement(a))
        if (spreadAt >= 0 && spreadAt <= p.index) {
          // A forwarding wrapper, `(...args) => f(...args)`: the argument is the one its own
          // callers pass at the same offset into its rest parameter.
          const spread = call.arguments[spreadAt] as ts.SpreadElement
          const rest = ts.isIdentifier(spread.expression)
            ? findDeclaration(spread.expression)
            : undefined
          if (rest?.kind === "param" && rest.decl.dotDotDotToken) {
            const t = traceParam(
              {
                fn: rest.fn,
                index: rest.fn.parameters.indexOf(rest.decl) + (p.index - spreadAt),
                path: p.path,
              },
              depth + 1,
            )
            if (t.verdict === "untraced") return untraced(`${t.why} ← ${at} forwards to ${name}`)
            via.push(...t.via)
            continue
          }
          return untraced(`spread argument ← ${at} calls ${name}`)
        }
        const arg = call.arguments[p.index]
        // Not passed: the parameter's default, or undefined (no org at all).
        const given = arg ?? p.fn.parameters[p.index]?.initializer
        if (!given) {
          via.push("not passed")
          continue
        }
        // A job dispatch, `handler(job.data, { signal })`: the run options handed beside the
        // job payload plainly carry no org (no key, no spread that could hold one), so the
        // handler gets none from them, as when they are not passed. Its org is the payload's.
        if (
          p.path.length > 0 &&
          ts.isObjectLiteralExpression(unwrapExpr(given)) &&
          "missing" in navigate(given, p.path.slice(0, 1)) &&
          call.arguments.some(
            (a, i) => i !== p.index && classifyOrgIdExpression(a).source === "job/system",
          )
        ) {
          via.push("run options beside a job payload")
          continue
        }
        const t = traceValue(given, p.path, depth + 1)
        if (t.verdict === "untraced") return untraced(`${t.why} ← ${at} [${origin}] calls ${name}`)
        via.push(...t.via)
      }
      return { verdict: "traced", via: [...new Set(via)] }
    })()
    memo.set(key, result)
    return result
  }

  const traceValue = (expr: ts.Expression, path: string[], depth: number): OrgTrace => {
    if (depth > 160) return untraced("value chain too deep")
    const cls = classifyOrgIdExpression(expr)
    if (TRUSTED_ORG_SOURCES.has(cls.source)) return { verdict: "traced", via: [cls.source] }
    const e = unwrapExpr(expr)
    // undefined / null / void: no org at all.
    if (
      e.kind === ts.SyntaxKind.NullKeyword ||
      ts.isVoidExpression(e) ||
      (ts.isIdentifier(e) && e.text === "undefined")
    )
      return { verdict: "traced", via: ["no value"] }
    if (ts.isPropertyAccessExpression(e))
      return traceValue(e.expression, [e.name.text, ...path], depth + 1)
    if (ts.isElementAccessExpression(e)) {
      const k = stringValue(e.argumentExpression)
      if (k !== undefined) return traceValue(e.expression, [k, ...path], depth + 1)
      return untraced(`indexed by a computed key (${e.getText().slice(0, 60)})`)
    }
    if (path[0] === ELEMENT) {
      // An element of an array literal: every element must be traced.
      if (ts.isArrayLiteralExpression(e)) {
        const via: string[] = []
        for (const el of e.elements) {
          const t = traceValue(
            ts.isSpreadElement(el) ? el.expression : el,
            ts.isSpreadElement(el) ? path : path.slice(1),
            depth + 1,
          )
          if (t.verdict === "untraced") return t
          via.push(...t.via)
        }
        return { verdict: "traced", via }
      }
      // list.map((x) => x.orgId) / Object.values(...) and the like are not followed.
      if (ts.isCallExpression(e)) {
        const name = calleeName(e)
        if (name && trusted[name]) return { verdict: "traced", via: [`reviewed ${name}()`] }
        return untraced(`loop over ${e.expression.getText().slice(0, 60)}(...)`)
      }
    }
    if (ts.isObjectLiteralExpression(e) && path.length > 0) {
      const nav = navigate(e, path)
      if ("missing" in nav) return untraced(nav.missing)
      return traceValue(nav.expr, nav.path, depth + 1)
    }
    if (ts.isConditionalExpression(e)) {
      const a = traceValue(e.whenTrue, path, depth + 1)
      if (a.verdict === "untraced") return a
      const b = traceValue(e.whenFalse, path, depth + 1)
      return b.verdict === "untraced" ? b : { verdict: "traced", via: [...a.via, ...b.via] }
    }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        // a ?? b: either side can be the value; an empty-string fallback carries no org.
        const left = traceValue(e.left, path, depth + 1)
        if (left.verdict === "untraced") return left
        const r = unwrapExpr(e.right)
        if ((ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r)) && r.text === "")
          return left
        const right = traceValue(e.right, path, depth + 1)
        return right.verdict === "untraced"
          ? right
          : { verdict: "traced", via: [...left.via, ...right.via] }
      }
    }
    if (ts.isIdentifier(e)) {
      const decl = findDeclaration(e)
      if (decl?.kind === "param") {
        if (decl.decl.dotDotDotToken) return untraced(`rest parameter ${e.text}`)
        const sub = bindingPath(decl.decl.name, e.text) ?? []
        return traceParam(
          { fn: decl.fn, index: decl.fn.parameters.indexOf(decl.decl), path: [...sub, ...path] },
          depth,
        )
      }
      if (decl?.kind === "var" && decl.init) {
        const v = decl.decl
        const sub = ts.isVariableDeclaration(v) ? bindingPath(v.name, e.text) : undefined
        if (sub === undefined) return untraced(`${e.text}: unsupported binding`)
        // for (const x of list): x is an element of list.
        const loop = v.parent?.parent
        if (loop && ts.isForInStatement(loop)) return untraced(`for-in key ${e.text}`)
        const elem = loop && ts.isForOfStatement(loop) ? [ELEMENT] : []
        return traceValue(decl.init, [...elem, ...sub, ...path], depth + 1)
      }
      return untraced(`passes ${cls.source} (${cls.detail.slice(0, 80)})`)
    }
    if (ts.isCallExpression(e)) {
      const name = calleeName(e)
      if (name && trusted[name]) return { verdict: "traced", via: [`reviewed ${name}()`] }
      // A factory: the object it returns copies one of its parameters.
      // The function this call reaches (imports resolved), when there is exactly one.
      const named = name ? (index.decls.get(name) ?? []) : []
      const fns =
        named.length > 1 && name
          ? named.filter((d) => isCallOf(e, d, name) && isModuleLevelFunction(d))
          : named
      if (fns.length === 1 && path.length > 0) {
        const fn = fns[0] as ts.SignatureDeclaration
        const returned = returnedObjects(fn)
        if (returned.length === 0) return untraced(`${name}() returns nothing traceable`)
        const via: string[] = []
        for (const ret of returned) {
          // return ctx, where const ctx = { ... }: the object it was built as.
          const rx = unwrapExpr(ret)
          const rd = ts.isIdentifier(rx) ? findDeclaration(rx) : undefined
          const r = rd?.kind === "var" && rd.init ? rd.init : ret
          const nav = navigate(r, path)
          if ("missing" in nav) return untraced(`${name}() returns ${nav.missing}`)
          const inner = resolveOrgParam(nav.expr)
          if (inner && inner.fn === fn) {
            const arg = e.arguments[inner.index]
            if (!arg) return untraced(`${name}() called without the argument it copies`)
            const t = traceValue(arg, [...inner.path, ...nav.path], depth + 1)
            if (t.verdict === "untraced") return untraced(`${t.why} ← through ${name}()`)
            via.push(...t.via)
            continue
          }
          const ic = classifyOrgIdExpression(nav.expr)
          if (TRUSTED_ORG_SOURCES.has(ic.source)) {
            via.push(ic.source)
            continue
          }
          return untraced(`${name}() returns ${ic.source} (${ic.detail.slice(0, 60)})`)
        }
        return { verdict: "traced", via }
      }
    }
    return untraced(
      `passes ${cls.source} (${cls.detail.slice(0, 80)}) [${e.getText().replace(/\s+/g, " ").slice(0, 60)}]`,
    )
  }
  return traceValue(orgExpr, [], 0)
}

function isInside(node: ts.Node, container: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node; cur; cur = cur.parent)
    if (cur === container) return true
  return false
}

// ─── Raw SQL sites (AST) ────────────────────────────────────────────────────

/**
 * The source text of one spliced expression, whitespace collapsed so a re-indent does not
 * change it. Long enough that two different expressions do not share a text: the raw-SQL
 * invariant reviews each interpolation by this text.
 */
export function interpolationText(e: ts.Expression): string {
  return e.getText().replace(/\s+/g, " ").trim().slice(0, 240)
}

function templateInterpolations(e: ts.Expression): string[] {
  const out: string[] = []
  const x = unwrapExpr(e)
  if (ts.isTemplateExpression(x)) {
    for (const span of x.templateSpans) out.push(interpolationText(span.expression))
  } else if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    out.push(...templateInterpolations(x.left), ...templateInterpolations(x.right))
  } else if (!ts.isStringLiteral(x) && !ts.isNoSubstitutionTemplateLiteral(x)) {
    out.push(interpolationText(x))
  }
  return out
}

function isStringBuilt(e: ts.Expression): boolean {
  const x = unwrapExpr(e)
  if (ts.isTemplateExpression(x)) return true
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) return true
  return false
}

const SQL_KEYWORD =
  /\b(select|insert|update|delete|create|alter|drop|grant|revoke|set|with|truncate|copy|do)\b/i

export function enumerateRawSql(
  files: string[],
  root = LIAISON_ROOT,
  texts?: Map<string, string>,
): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  for (const file of files) {
    const text = texts?.get(file) ?? readFileSync(file, "utf8")
    if (!/\.raw\(|\.unsafe\(|\.execute\(|\.query\(/.test(text)) continue
    const sf = parseFile(file, texts ? text : undefined)
    const ids = new OrdinalIds()
    const relFile = rel(file, root)
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return
      const method = n.expression.name.text
      const recv = n.expression.expression.getText(sf)
      const arg = n.arguments[0]
      let form: string | undefined
      if (method === "raw" && /sql/i.test(recv)) form = `${recv}.raw`
      else if (method === "unsafe") form = `${recv.split(".").pop()}.unsafe`
      else if ((method === "execute" || method === "query") && arg && isStringBuilt(arg)) {
        const head = unwrapExpr(arg).getText(sf).slice(0, 80)
        if (SQL_KEYWORD.test(head)) form = `${method}(string-built)`
      }
      if (!form || !arg) return
      const dynamic = !(
        ts.isStringLiteral(unwrapExpr(arg)) || ts.isNoSubstitutionTemplateLiteral(unwrapExpr(arg))
      )
      const fn = enclosingFunctionName(n, sf)
      rows.push({
        kind: "rawsql",
        id: `rawsql:${ids.next(`${relFile}#${fn}#${form}`)}`,
        location: `${relFile}:${lineOf(sf, n)}`,
        attrs: {
          form,
          enclosing: fn,
          dynamic,
          // Every interpolation, uncapped: each one is reviewed on its own.
          interpolations: dynamic ? templateInterpolations(arg) : [],
          inRouteHandler: insideRouteHandler(n),
        },
        source: "ast",
      })
    })
  }
  return rows
}

// ─── Search filter sites (AST) ──────────────────────────────────────────────
//
// Every search document lives in one Meilisearch index shared by all orgs, so
// the filter of a read or delete is the only thing standing between one org's
// documents and another's. Two row forms:
//   - a call on a Meilisearch index (`search`, `getDocuments`, `deleteDocuments`,
//     ...): the filter it passes, and whether that filter pins an org;
//   - a filter builder: a string or template that writes an `org_id = "..."` /
//     `org_id IN [...]` clause, with where the spliced org id comes from and
//     whether it is escaped.

const MEILI_READ_METHODS = new Set([
  "search",
  "multiSearch",
  "searchForFacetValues",
  "getDocuments",
  "deleteDocuments",
  "updateDocumentsByFunction",
])
/** A Meilisearch filter clause on the org: `org_id = "` or `org_id IN [`. */
const MEILI_ORG_CLAUSE = /\borg_id\s*(=|!=|IN)\s*["[]/
const ESCAPE_CALL = /escape|quote/i

/** True when the expression is (or is a variable bound to) a Meilisearch index handle. */
function isMeiliIndex(e: ts.Expression, depth = 0): boolean {
  const x = unwrapExpr(e)
  if (depth > 4) return false
  if (ts.isCallExpression(x)) {
    const name = calleeName(x)
    if (name === "index" || name === "getIndex") return true
    if (name === "getMeili") return true
    return false
  }
  if (ts.isIdentifier(x)) {
    const decl = findDeclaration(x)
    if (!decl) return false
    if (decl.kind === "param") {
      const t = decl.decl.type?.getText() ?? ""
      return /\b(Index|MeiliSearch|Meili)\b/.test(t)
    }
    return decl.init ? isMeiliIndex(decl.init, depth + 1) : false
  }
  return false
}

/** The filter property of a search / document call's options, if any. */
function filterArgument(call: ts.CallExpression): ts.Expression | null {
  const objects = call.arguments.filter((a) => ts.isObjectLiteralExpression(unwrapExpr(a)))
  for (const o of objects) {
    for (const p of (unwrapExpr(o) as ts.ObjectLiteralExpression).properties) {
      if (p.name?.getText() !== "filter") continue
      if (ts.isPropertyAssignment(p)) return p.initializer
      if (ts.isShorthandPropertyAssignment(p)) return p.name
    }
  }
  // deleteDocuments(ids) / getDocuments() with no options: no filter.
  return null
}

/** Text a filter expression resolves to inside its function (one variable hop at most). */
function resolvedFilterText(e: ts.Expression): string {
  const x = unwrapExpr(e)
  if (ts.isIdentifier(x)) {
    const decl = findDeclaration(x)
    if (decl?.kind === "var" && decl.init) return decl.init.getText()
  }
  return x.getText()
}

/** A string, a template, or a choice between them: filter text written in place. */
function isFilterText(e: ts.Expression): boolean {
  const x = unwrapExpr(e)
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return true
  if (ts.isTemplateExpression(x)) return true
  if (ts.isConditionalExpression(x)) return isFilterText(x.whenTrue) && isFilterText(x.whenFalse)
  return false
}

/** Where a filter pins the org: written inline, through a builder call, nowhere, or unknown. */
function orgFilterOf(e: ts.Expression | null): string {
  if (!e) return "none"
  const x = unwrapExpr(e)
  const text = resolvedFilterText(x)
  if (MEILI_ORG_CLAUSE.test(text)) return "inline"
  const target = ts.isIdentifier(x) ? (findDeclaration(x) ?? null) : null
  const init = target?.kind === "var" && target.init ? unwrapExpr(target.init) : x
  if (ts.isCallExpression(init)) return `builder ${calleeName(init) ?? "?"}()`
  if (target?.kind === "param") return `caller (param ${x.getText()})`
  if (isFilterText(init)) return "none"
  return "unresolved"
}

/** The org id spliced into a builder's clause: its source, and whether an escape wraps it. */
function orgClauseValue(t: ts.TemplateExpression): {
  expr: ts.Expression | undefined
  escaped: boolean
} {
  let head = t.head.text
  for (const span of t.templateSpans) {
    if (MEILI_ORG_CLAUSE.test(head.slice(-40)) || /\borg_id\s*(=|!=|IN)\s*["[]\s*$/.test(head)) {
      let v = unwrapExpr(span.expression)
      let escaped = false
      while (ts.isCallExpression(v) && ESCAPE_CALL.test(calleeName(v) ?? "")) {
        escaped = true
        const a0 = v.arguments[0]
        if (!a0) break
        v = unwrapExpr(a0)
      }
      return { expr: v, escaped }
    }
    head = span.literal.text
  }
  return { expr: undefined, escaped: false }
}

export function enumerateSearchFilters(
  files: string[],
  root = LIAISON_ROOT,
  texts?: Map<string, string>,
): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  for (const file of files) {
    const text = texts?.get(file) ?? readFileSync(file, "utf8")
    const hasCall =
      /\.(search|multiSearch|searchForFacetValues|getDocuments|deleteDocuments|updateDocumentsByFunction)\(/.test(
        text,
      )
    if (!hasCall && !/org_id/.test(text)) continue
    const sf = parseFile(file, texts ? text : undefined)
    const ids = new OrdinalIds()
    const relFile = rel(file, root)
    walk(sf, (n) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text
        if (!MEILI_READ_METHODS.has(method) || !isMeiliIndex(n.expression.expression)) return
        const filter = filterArgument(n)
        const fn = enclosingFunctionName(n, sf)
        rows.push({
          kind: "search",
          id: `search:${ids.next(`${relFile}#${fn}#${method}`)}`,
          location: `${relFile}:${lineOf(sf, n)}`,
          attrs: {
            form: `index.${method}`,
            enclosing: fn,
            filter: filter ? interpolationText(filter).slice(0, 160) : null,
            orgFilter: orgFilterOf(filter),
            inRouteHandler: insideRouteHandler(n),
          },
          source: "ast",
        })
        return
      }
      if (ts.isTemplateExpression(n) && !ts.isTaggedTemplateExpression(n.parent)) {
        const whole = n.getText(sf)
        if (!MEILI_ORG_CLAUSE.test(whole)) return
        const { expr, escaped } = orgClauseValue(n)
        // An org clause with a constant value is no splice: no builder row.
        if (!expr) return
        const cls = classifyOrgIdExpression(expr)
        const fn = enclosingFunctionName(n, sf)
        rows.push({
          kind: "search",
          id: `search:${ids.next(`${relFile}#${fn}#org-clause`)}`,
          location: `${relFile}:${lineOf(sf, n)}`,
          attrs: {
            form: "filter-builder",
            enclosing: fn,
            filter: interpolationText(n).slice(0, 160),
            orgIdSource: cls.source,
            orgIdDetail: cls.detail.slice(0, 160),
            escaped,
            inRouteHandler: insideRouteHandler(n),
          },
          source: "ast",
        })
      }
    })
  }
  return rows
}

// ─── Redis key sites (AST) ──────────────────────────────────────────────────
//
// One Redis serves every org, and the app keys it by string. A row per command
// call on a Redis client (the shared `redis` / `redisSub` clients, their
// duplicates, a `multi()` / `pipeline()` off them, a parameter typed as Redis)
// naming the key it touches: the key expression, its static head, the values
// spliced into it, the builder function that made it (`stepUpCodeKey(...)`)
// with that builder's own template, and whether an org id is part of the key.

const REDIS_KEY_COMMANDS = new Set([
  "get",
  "set",
  "setex",
  "psetex",
  "setnx",
  "getdel",
  "getex",
  "getset",
  "del",
  "unlink",
  "exists",
  "incr",
  "incrby",
  "decr",
  "decrby",
  "expire",
  "pexpire",
  "expireat",
  "persist",
  "ttl",
  "pttl",
  "type",
  "hget",
  "hset",
  "hsetnx",
  "hdel",
  "hgetall",
  "hmget",
  "hmset",
  "hincrby",
  "hkeys",
  "hlen",
  "hexists",
  "sadd",
  "srem",
  "smembers",
  "sismember",
  "scard",
  "spop",
  "zadd",
  "zrem",
  "zrange",
  "zrangebyscore",
  "zrevrange",
  "zremrangebyscore",
  "zremrangebyrank",
  "zcard",
  "zscore",
  "zcount",
  "zincrby",
  "lpush",
  "rpush",
  "lrange",
  "ltrim",
  "llen",
  "lpop",
  "rpop",
  "lrem",
  "xadd",
  "xrange",
  "xlen",
  "xtrim",
  "mget",
  "publish",
  "subscribe",
  "psubscribe",
  "unsubscribe",
  "punsubscribe",
  "watch",
  "scan",
  "keys",
  "eval",
  "evalsha",
])
/** The clients lib/redis.ts exports. */
const REDIS_CLIENT_NAMES = /^(redis|redisSub|redisBullMQ|redisPub|redisClient)$/
const REDIS_CLIENT_FACTORIES = new Set(["multi", "pipeline", "duplicate"])
const REDIS_TYPE = /\b(Redis|IORedis|RedisLike|RedisClient|ChainableCommander|Pipeline)\b/

function isRedisClient(e: ts.Expression, depth = 0): boolean {
  const x = unwrapExpr(e)
  if (depth > 5) return false
  if (ts.isNewExpression(x)) return /^(Redis|IORedis)$/.test(x.expression.getText())
  if (ts.isCallExpression(x)) {
    const name = calleeName(x)
    if (name === "getRedis") return true
    if (name && ts.isPropertyAccessExpression(x.expression)) {
      // redis.multi().set(...).get(...): a chain off a client is the client.
      if (REDIS_CLIENT_FACTORIES.has(name) || REDIS_KEY_COMMANDS.has(name))
        return isRedisClient(x.expression.expression, depth + 1)
    }
    return false
  }
  if (ts.isPropertyAccessExpression(x)) return isRedisClient(x.name, depth + 1)
  if (ts.isIdentifier(x)) {
    const decl = findDeclaration(x)
    if (!decl) return REDIS_CLIENT_NAMES.test(x.text)
    const declared = (decl.decl as ts.ParameterDeclaration | ts.VariableDeclaration).type
    if (declared && REDIS_TYPE.test(declared.getText())) return true
    if (decl.kind === "param") return false
    if (!decl.init) return false
    // const { redis } = await import("~/lib/redis")
    const init = unwrapExpr(decl.init)
    if (
      ts.isCallExpression(init) &&
      init.expression.kind === ts.SyntaxKind.ImportKeyword &&
      /redis/i.test(stringValue(init.arguments[0]) ?? "")
    )
      return REDIS_CLIENT_NAMES.test(x.text)
    return isRedisClient(decl.init, depth + 1)
  }
  return false
}

/** The static head of a key template (`magic-link:attempts:`), or the literal key. */
function keyHead(e: ts.Expression): string | null {
  const x = unwrapExpr(e)
  if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text
  if (ts.isTemplateExpression(x)) return x.head.text
  return null
}

/** The template a key builder function returns, when it is a one-expression builder. */
function builderTemplate(
  name: string,
  sf: ts.SourceFile,
  index: Map<string, string>,
): string | null {
  const local = index.get(`${sf.fileName}#${name}`) ?? index.get(`*#${name}`)
  return local ?? null
}

/** `fnName` → the key text a builder function returns (`return \`...\`` or an arrow body). */
function indexKeyBuilders(files: string[], texts?: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const file of files) {
    const text = texts?.get(file) ?? readFileSync(file, "utf8")
    if (!/Key\b|key\(/i.test(text)) continue
    const sf = parseFile(file, texts ? text : undefined)
    const note = (name: string, body: ts.Expression) => {
      const x = unwrapExpr(body)
      if (!ts.isTemplateExpression(x) && !ts.isNoSubstitutionTemplateLiteral(x)) return
      const t = interpolationText(x).slice(0, 160)
      out.set(`${file}#${name}`, t)
      const g = `*#${name}`
      if (out.has(g) && out.get(g) !== t) ambiguous.add(g)
      else out.set(g, t)
    }
    walk(sf, (n) => {
      let name: string | undefined
      let body: ts.ConciseBody | undefined
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && n.body) {
        name = n.name.getText(sf)
        body = n.body
      } else if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) {
        name = n.name.text
        body = n.initializer.body
      }
      if (!name || !body || !/key/i.test(name)) return
      if (ts.isBlock(body)) {
        const returns = body.statements.filter(ts.isReturnStatement)
        if (returns.length === 1 && returns[0]?.expression) note(name, returns[0].expression)
      } else {
        note(name, body)
      }
    })
  }
  for (const g of ambiguous) out.delete(g)
  return out
}

/** The arguments of a command that name keys (eval: the `numkeys` that follow the script). */
function keyArguments(method: string, call: ts.CallExpression): ts.Expression[] {
  const args = [...call.arguments]
  if (method === "eval" || method === "evalsha") {
    const n = args[1] && ts.isNumericLiteral(unwrapExpr(args[1])) ? Number(args[1].getText()) : NaN
    return Number.isFinite(n) ? args.slice(2, 2 + n) : args.slice(2, 3)
  }
  if (method === "scan") return args.slice(1)
  if (
    method === "del" ||
    method === "unlink" ||
    method === "exists" ||
    method === "mget" ||
    method === "watch" ||
    method === "subscribe" ||
    method === "psubscribe" ||
    method === "unsubscribe" ||
    method === "punsubscribe"
  )
    return args
  return args.slice(0, 1)
}

const ORG_IN_KEY = /\borg(Id|_id|ID)?\b|\.orgId\b/

export function enumerateRedisKeys(
  files: string[],
  root = LIAISON_ROOT,
  texts?: Map<string, string>,
): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  const builders = indexKeyBuilders(files, texts)
  for (const file of files) {
    const text = texts?.get(file) ?? readFileSync(file, "utf8")
    if (!/redis|Redis/.test(text)) continue
    const sf = parseFile(file, texts ? text : undefined)
    const ids = new OrdinalIds()
    const relFile = rel(file, root)
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return
      const method = n.expression.name.text
      if (!REDIS_KEY_COMMANDS.has(method) || !isRedisClient(n.expression.expression)) return
      const fn = enclosingFunctionName(n, sf)
      // A key held in a local variable is read through it (one hop).
      const keys = keyArguments(method, n).map((k) => {
        const x = unwrapExpr(k)
        const decl = ts.isIdentifier(x) ? findDeclaration(x) : undefined
        if (decl?.kind === "var" && decl.init && ts.isVariableDeclaration(decl.decl)) {
          if (ts.isIdentifier(decl.decl.name)) {
            return { text: `${x.getText()} = ${interpolationText(decl.init)}`, expr: decl.init }
          }
        }
        return { text: interpolationText(k), expr: k }
      })
      const keyTexts = keys.map((k) => k.text.slice(0, 160))
      const heads = keys.map((k) => keyHead(k.expr)).filter((h): h is string => h !== null)
      const spliced = keys.flatMap((k) => {
        const x = unwrapExpr(k.expr)
        return ts.isTemplateExpression(x)
          ? x.templateSpans.map((span) => interpolationText(span.expression))
          : []
      })
      const builderNames = keys.flatMap((k) => {
        const x = unwrapExpr(k.expr)
        const name = ts.isCallExpression(x) ? calleeName(x) : undefined
        return name ? [name] : []
      })
      const builderTexts = builderNames
        .map((b) => builderTemplate(b, sf, builders))
        .filter((t): t is string => t !== null)
      const all = [...keyTexts, ...builderTexts].join(" ")
      rows.push({
        kind: "redis",
        id: `redis:${ids.next(`${relFile}#${fn}#${method}`)}`,
        location: `${relFile}:${lineOf(sf, n)}`,
        attrs: {
          command: method,
          enclosing: fn,
          key: keyTexts.length > 0 ? keyTexts : ["(none)"],
          keyHead: heads.length > 0 ? heads : [],
          spliced,
          builder: builderNames,
          builderTemplate: builderTexts,
          orgInKey: ORG_IN_KEY.test(all),
          inRouteHandler: insideRouteHandler(n),
        },
        source: "ast",
      })
    })
  }
  return rows
}

// ─── Routes (runtime) ───────────────────────────────────────────────────────

/** The route entry type Hono keeps in `app.routes`. */
export interface HonoRouteEntry {
  basePath: string
  path: string
  method: string
  handler: (...args: any[]) => any
}

/** Any Hono app: `routes` and `router` are public; the error handler is read by name. */
type HonoLike = Hono<any, any, any>

function errorHandlerOf(app: HonoLike): (err: Error, c: unknown) => Response | Promise<Response> {
  const handler: unknown = Reflect.get(app, "errorHandler")
  if (typeof handler !== "function") throw new Error("Hono app has no errorHandler")
  return (err, c) => handler.call(app, err, c)
}

interface RegistrationSite {
  /** Where the handler was handed to Hono (file:line), outside hono itself. */
  site: string
}

/**
 * Records the call site of every Hono registration (`app.get`, `app.use`,
 * `app.route`, ...) by hooking the router's `add`, which every Hono instance
 * calls once per handler. Install BEFORE the app modules are imported.
 */
export class RouteRegistrationRecorder {
  readonly byEntry = new WeakMap<object, RegistrationSite>()
  /** First definition site of each handler function, keyed by identity. */
  readonly byHandler = new WeakMap<object, RegistrationSite>()
  private restore: (() => void) | undefined

  async install(): Promise<void> {
    const mod = (await import("hono/router/smart-router")) as { SmartRouter: { prototype: any } }
    const proto = mod.SmartRouter.prototype
    const original = proto.add
    const self = this
    proto.add = function patchedAdd(this: unknown, method: string, p: string, handler: unknown) {
      const site = callSite(new Error().stack ?? "")
      if (Array.isArray(handler) && handler.length === 2 && typeof handler[1] === "object") {
        const [fn, entry] = handler as [object, object]
        self.byEntry.set(entry, { site })
        const orig = unwrapHandler(fn)
        if (!self.byHandler.has(orig)) self.byHandler.set(orig, { site })
      }
      return original.call(this, method, p, handler)
    }
    this.restore = () => {
      proto.add = original
    }
  }

  uninstall(): void {
    this.restore?.()
    this.restore = undefined
  }
}

function callSite(stack: string): string {
  for (const line of stack.split("\n").slice(1)) {
    const m = /\(?((?:\/|[A-Za-z]:)[^()]+?):(\d+):\d+\)?\s*$/.exec(line.trim())
    if (!m) continue
    const file = m[1]
    if (file.includes("/node_modules/") || file.endsWith("enumerate.ts")) continue
    return `${rel(file)}:${m[2]}`
  }
  return "unknown"
}

const COMPOSED_HANDLER = "__COMPOSED_HANDLER"
function unwrapHandler(fn: any): any {
  let cur = fn
  for (let i = 0; i < 10 && cur && typeof cur === "function" && cur[COMPOSED_HANDLER]; i++) {
    cur = cur[COMPOSED_HANDLER]
  }
  return cur
}

/** Which `app.routes` entries are endpoints (the handler that answers) rather than middleware. */
export function endpointEntries(routes: HonoRouteEntry[]): HonoRouteEntry[] {
  const out: HonoRouteEntry[] = []
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i]
    if (r.method === "ALL") {
      // `use()` middleware takes (c, next); an `.all()` / `.on()` endpoint does not.
      if (unwrapHandler(r.handler).length < 2) out.push(r)
      continue
    }
    const next = routes[i + 1]
    // `.get(path, mw, handler)` registers each handler in turn: the last one answers.
    if (next && next.method === r.method && next.path === r.path && next.basePath === r.basePath)
      continue
    out.push(r)
  }
  return out
}

const SAMPLE_SEGMENTS = ["00000000-0000-4000-8000-000000000001", "1.0.0", "1", "sample"]

/** A value shaped like what the parameter's name says it holds. */
function sampleForParam(name: string): string {
  if (/version/i.test(name)) return "1.0.0"
  if (/(^id$|Id$|_id$|uuid)/.test(name)) return SAMPLE_SEGMENTS[0]
  if (/name|slug|app|provider|kind|type|handle/i.test(name)) return "sample"
  return SAMPLE_SEGMENTS[0]
}

/** A concrete request path (index -1: each parameter by its name, else one sample for all) that the route pattern matches (`:id` → a uuid, `*` → a segment). */
export function concretePath(pattern: string, sampleIndex = 0): string {
  return pattern
    .replace(/:[A-Za-z0-9_]+\{([^}]*)\}\??/g, (_m, re: string) => {
      const rx = new RegExp(`^(?:${re})$`)
      return SAMPLE_SEGMENTS.find((s) => rx.test(s)) ?? "1"
    })
    .replace(/:([A-Za-z0-9_]+)\??/g, (_m, name: string) =>
      sampleIndex < 0 ? sampleForParam(name) : (SAMPLE_SEGMENTS[sampleIndex] ?? SAMPLE_SEGMENTS[0]),
    )
    .replace(/\*/g, "sample")
}

type MatchElement = [[(...args: any[]) => any, HonoRouteEntry], Record<string, string>]

function matchedEntries(
  app: HonoLike,
  method: string,
  p: string,
): { list: MatchElement[]; stash: unknown } | undefined {
  const result: unknown = app.router.match(method, p)
  if (!Array.isArray(result) || !Array.isArray(result[0])) return undefined
  const list: MatchElement[] = result[0]
  return { list, stash: result[1] }
}

export type GateOutcome =
  | { kind: "pass" }
  | { kind: "reject"; status: number; missingScope?: string }
  | { kind: "error"; message: string }

/**
 * Run one middleware alone against an anonymous request (no credentials, no
 * scopes) and report what it does: lets it through, or answers with a status.
 * No endpoint handler is executed.
 */
export async function simulateMiddleware(
  app: HonoLike,
  fn: (...args: any[]) => any,
  method: string,
  requestPath: string,
  match: { list: MatchElement[]; stash: unknown },
  index: number,
): Promise<GateOutcome> {
  const { Context } = await import("hono")
  const req = new Request(`http://localhost${requestPath}`, {
    method: method === "ALL" ? "GET" : method,
    headers: { "x-forwarded-for": "203.0.113.7" },
  })
  const c: any = new Context(req, {
    path: requestPath,
    matchResult: (match.stash === undefined ? [match.list] : [match.list, match.stash]) as any,
    notFoundHandler: (ctx: any) => ctx.text("404 Not Found", 404),
  } as any)
  c.req.routeIndex = index
  c.set("scopes", [])
  c.set("roles", [])
  c.set("dimensionGrants", {})
  let nextCalled = false
  const next = async () => {
    nextCalled = true
  }
  try {
    const out = await Promise.race([
      Promise.resolve(fn(c, next)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("middleware simulation timed out")), 3000),
      ),
    ])
    if (nextCalled) return { kind: "pass" }
    const res = out instanceof Response ? out : c.finalized ? c.res : undefined
    if (res) return { kind: "reject", status: res.status }
    return { kind: "pass" }
  } catch (err) {
    const raw = err as {
      missingScope?: string
      details?: { missingScope?: string }
      message?: string
      status?: number
    }
    const e = {
      ...raw,
      message: raw?.message,
      missingScope: raw?.missingScope ?? raw?.details?.missingScope,
    }
    if (e?.message === "middleware simulation timed out")
      return { kind: "error", message: e.message }
    try {
      const res = await errorHandlerOf(app)(err as Error, c)
      return {
        kind: "reject",
        status: res.status,
        ...(typeof e?.missingScope === "string" ? { missingScope: e.missingScope } : {}),
      }
    } catch {
      return { kind: "error", message: String(e?.message ?? err).slice(0, 120) }
    }
  }
}

export interface RouteEnumerationOptions {
  variant?: string
  recorder?: RouteRegistrationRecorder
  /** Skip running middleware (chain is reported by name only). */
  noSimulation?: boolean
}

export type AuthClass =
  | "authenticated"
  | "public"
  | "hidden-404"
  | "forbidden"
  | "path-dependent"
  | "unknown"

function middlewareLabel(fn: any, recorder?: RouteRegistrationRecorder, entry?: object): string {
  const orig = unwrapHandler(fn)
  const name = orig?.name && orig.name !== "anonymous" ? orig.name : "anon"
  const site =
    recorder?.byHandler.get(orig)?.site ?? (entry ? recorder?.byEntry.get(entry)?.site : undefined)
  return site ? `${name}@${site}` : name
}

/**
 * Every endpoint of a Hono app, with the middleware a request to it passes
 * through (decided by the app's own router) and how that chain treats an
 * anonymous request.
 */
export async function enumerateRoutes(
  app: HonoLike,
  opts: RouteEnumerationOptions = {},
): Promise<SurfaceRow[]> {
  const rows: SurfaceRow[] = []
  const seen = new Set<string>()
  const simCache = new Map<string, GateOutcome>()
  const analyse = async (
    ep: HonoRouteEntry,
    method: string,
    reqPath: string,
    match: { list: MatchElement[]; stash: unknown },
    idx: number,
  ) => {
    const chain: string[] = []
    const scopes: string[] = []
    let auth: AuthClass = "public"
    let firstGate: string | null = null
    for (let i = 0; i < idx; i++) {
      const [fn, entry] = match.list[i][0]
      const label = middlewareLabel(fn, opts.recorder, entry)
      if (opts.noSimulation) {
        chain.push(label)
        continue
      }
      const cacheKey = `${i}\0${reqPath}\0${method}\0${label}`
      let outcome = simCache.get(cacheKey)
      if (!outcome) {
        outcome = await simulateMiddleware(app, fn, method, reqPath, match, i)
        simCache.set(cacheKey, outcome)
      }
      if (outcome.kind === "pass") {
        chain.push(label)
        continue
      }
      if (outcome.kind === "error") {
        chain.push(`${label}→error`)
        if (auth === "public") auth = "unknown"
        continue
      }
      chain.push(
        `${label}→${outcome.status}${outcome.missingScope ? `(${outcome.missingScope})` : ""}`,
      )
      if (outcome.missingScope) scopes.push(outcome.missingScope)
      // Only an identity / permission answer is a gate. A 400 (body validation),
      // 405, 413 or 429 stops THIS anonymous probe but not a caller who sends a
      // valid request, so the scan carries on past it.
      if (![401, 403, 404].includes(outcome.status)) continue
      if (firstGate === null && (auth === "public" || auth === "unknown")) {
        firstGate = `${outcome.status}`
        auth =
          outcome.status === 401
            ? "authenticated"
            : outcome.status === 404
              ? "hidden-404"
              : "forbidden"
      }
    }
    void ep
    return { chain, scopes, auth, firstGate }
  }
  for (const ep of endpointEntries(app.routes)) {
    const method = ep.method
    const key = `${method} ${ep.path}`
    if (seen.has(key)) continue
    seen.add(key)
    // A gate can depend on the path's VALUE (a regex bypass for one shape of
    // segment), so every sample the route accepts is probed; disagreeing
    // samples make the route `path-dependent`.
    const results: Array<{
      sample: string
      chain: string[]
      scopes: string[]
      auth: AuthClass
      firstGate: string | null
    }> = []
    const tried = new Set<string>()
    for (let s = -1; s < SAMPLE_SEGMENTS.length; s++) {
      const reqPath = concretePath(ep.path, s)
      if (tried.has(reqPath)) continue
      tried.add(reqPath)
      const match = matchedEntries(app, method === "ALL" ? "GET" : method, reqPath)
      const idx = match ? match.list.findIndex((m) => m[0][1] === ep) : -1
      if (!match || idx < 0) continue
      results.push({
        sample: s < 0 ? "by-name" : SAMPLE_SEGMENTS[s],
        ...(await analyse(ep, method, reqPath, match, idx)),
      })
    }
    const primary = results[0] ?? {
      sample: "",
      chain: [],
      scopes: [],
      auth: "unknown" as AuthClass,
      firstGate: null,
    }
    const auths = [...new Set(results.map((r) => r.auth))]
    const chain = primary.chain
    const scopes = [...new Set(results.flatMap((r) => r.scopes))]
    const auth: AuthClass = auths.length > 1 ? "path-dependent" : primary.auth
    const firstGate = primary.firstGate
    const authBySample = auths.length > 1 ? results.map((r) => `${r.sample}:${r.auth}`) : []
    const definition = opts.recorder?.byHandler.get(unwrapHandler(ep.handler))?.site ?? null
    const mount = opts.recorder?.byEntry.get(ep)?.site ?? null
    rows.push({
      kind: "route",
      id: `route:${key}`,
      location: definition ?? mount ?? "runtime",
      attrs: {
        method,
        path: ep.path,
        mountPrefix: ep.basePath,
        mount,
        definition,
        auth,
        firstGateStatus: firstGate,
        scopes,
        authBySample,
        chain,
        variants: opts.variant ? [opts.variant] : [],
      },
      source: "runtime",
    })
  }
  return rows
}

/**
 * Env-flag variants of the app's route table. Each one is booted in its own
 * process (app.ts reads the flags at import). `null` env value = unset.
 */
export const ROUTE_VARIANTS: Record<string, Record<string, string | null>> = {
  test: {},
  development: { NODE_ENV: "development" },
  demo: { LIAISON_DEMO_MODE: "true" },
  "qa-routes": { LIAISON_QA_ROUTES: "true" },
  loadtest: { ENABLE_LOAD_TEST_ENDPOINT: "true" },
  managed: {
    CONTROL_PLANE_URL: "https://control-plane.invalid",
    CONTROL_PLANE_API_KEY: "inventory-control-plane-key-0123456789abcdef",
  },
  chaos: { CHAOS_DEBUG: "1", CHAOS_LOCAL_ONLY: "1", CHAOS_DEBUG_TOKEN: "inventory-chaos-token" },
}

async function bootAppRoutes(variant: string): Promise<SurfaceRow[]> {
  const recorder = new RouteRegistrationRecorder()
  await recorder.install()
  const { app } = await import("~/app")
  recorder.uninstall()
  return enumerateRoutes(app, { variant, recorder })
}

/** Merge per-variant route rows: one row per id, `variants` lists where it exists. */
export function mergeRouteVariants(perVariant: Record<string, SurfaceRow[]>): SurfaceRow[] {
  const byId = new Map<string, SurfaceRow>()
  for (const [variant, rows] of Object.entries(perVariant)) {
    for (const row of rows) {
      const prev = byId.get(row.id)
      if (!prev) {
        byId.set(row.id, { ...row, attrs: { ...row.attrs, variants: [variant] } })
        continue
      }
      const variants = new Set([...(prev.attrs.variants as string[]), variant])
      // Different chains across variants are recorded on the first (test) row,
      // with every variant whose classification differs named.
      if (prev.attrs.auth !== row.attrs.auth) {
        const diff = new Set((prev.attrs.authDiffers as string[] | undefined) ?? [])
        diff.add(`${variant}:${row.attrs.auth}`)
        prev.attrs.authDiffers = [...diff]
      }
      prev.attrs.variants = [...variants]
    }
  }
  const all = Object.keys(perVariant)
  for (const row of byId.values()) {
    const v = row.attrs.variants as string[]
    row.attrs.variantOnly = v.length !== all.length
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

// ─── WebSocket message types (AST) ──────────────────────────────────────────

export function enumerateWsMessages(root = LIAISON_ROOT): SurfaceRow[] {
  const file = path.join(root, "apps", "api", "src", "lib", "server.ts")
  if (!existsSync(file)) return []
  const sf = parseFile(file)
  const rows: SurfaceRow[] = []
  const seen = new Set<string>()
  walk(sf, (n) => {
    if (!ts.isBinaryExpression(n) || n.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
      return
    const left = n.left.getText(sf)
    const value = stringValue(n.right)
    if (!value || !/^(data|msg|message|parsed)\.type$/.test(left)) return
    if (seen.has(value)) return
    seen.add(value)
    rows.push({
      kind: "ws",
      id: `ws:${value}`,
      location: `${rel(file, root)}:${lineOf(sf, n)}`,
      attrs: { type: value, handler: enclosingFunctionName(n, sf) },
      source: "ast",
    })
  })
  return rows
}

// ─── Manifests ──────────────────────────────────────────────────────────────

export interface ManifestFile {
  app: string
  file: string
  bundled: boolean
  /** A fixture app only a test process loads. */
  testOnly?: boolean
  manifest: Record<string, any>
}

export function readManifests(root = LIAISON_ROOT): ManifestFile[] {
  const out: ManifestFile[] = []
  for (const app of safeReaddir(path.join(root, "apps", "api", "src", "apps"))) {
    const file = path.join(root, "apps", "api", "src", "apps", app, "app.manifest.json")
    if (existsSync(file))
      out.push({ app, file, bundled: false, manifest: JSON.parse(readFileSync(file, "utf8")) })
  }
  for (const app of safeReaddir(path.join(root, "bundled-apps"))) {
    const file = path.join(root, "bundled-apps", app, "app.manifest.json")
    if (existsSync(file))
      out.push({ app, file, bundled: true, manifest: JSON.parse(readFileSync(file, "utf8")) })
  }
  // Fixture apps a test process loads beside the in-tree ones (never shipped).
  for (const app of safeReaddir(path.join(root, "apps", "api", "test-support", "apps"))) {
    const file = path.join(root, "apps", "api", "test-support", "apps", app, "app.manifest.json")
    if (existsSync(file))
      out.push({
        app,
        file,
        bundled: false,
        testOnly: true,
        manifest: JSON.parse(readFileSync(file, "utf8")),
      })
  }
  return out
}

function manifestTools(m: ManifestFile): Array<[string, Record<string, any>]> {
  const tools = m.manifest.tools
  if (!tools) return []
  if (Array.isArray(tools)) return tools.map((t: any) => [t.name, t])
  return Object.entries(tools) as Array<[string, Record<string, any>]>
}

/** Manifest-declared tools, as written (the runtime registry is `enumerateRuntimeTools`). */
export function enumerateManifestTools(
  manifests: ManifestFile[],
  root = LIAISON_ROOT,
): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  for (const m of manifests) {
    const name = m.manifest.name ?? m.app
    for (const [tool, def] of manifestTools(m)) {
      rows.push({
        kind: "tool",
        id: `tool:${name}:${tool}`,
        location: rel(m.file, root),
        attrs: {
          origin: m.testOnly
            ? "manifest:test-fixture"
            : m.bundled
              ? "manifest:bundled"
              : "manifest:in-tree",
          gated: def.gated === true,
          readOnly: def.readOnly === true,
          externalEffect: def.externalEffect === true,
          approvalImpact: def.approvalImpact ?? null,
          scopes: def.requiredScopes ?? (def.scope ? [def.scope] : []),
          registered: null,
        },
        source: "manifest",
      })
    }
  }
  return rows
}

export function enumerateManifestWebhooks(
  manifests: ManifestFile[],
  root = LIAISON_ROOT,
): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  for (const m of manifests) {
    const name = m.manifest.name ?? m.app
    for (const [endpoint, def] of Object.entries(
      (m.manifest.webhooks ?? {}) as Record<string, any>,
    )) {
      rows.push({
        kind: "webhook",
        id: `webhook:${name}:${endpoint}`,
        location: rel(m.file, root),
        attrs: {
          origin: "manifest",
          receiver: `/webhooks/:orgId/${name}/${endpoint}`,
          verifier: def.verify ?? null,
          handler: def.handler ?? null,
          bodyLimitBytes: def.bodyLimitBytes ?? null,
          requiresUserActor: def.requiresUserActor === true,
          registered: null,
        },
        source: "manifest",
      })
    }
  }
  return rows
}

/** Manifest jobs, event subscriptions, routines, provider contracts and cross-app calls. */
export function enumerateManifestJobs(
  manifests: ManifestFile[],
  root = LIAISON_ROOT,
): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  for (const m of manifests) {
    const name = m.manifest.name ?? m.app
    const loc = rel(m.file, root)
    for (const [job, def] of Object.entries((m.manifest.jobs ?? {}) as Record<string, any>)) {
      rows.push({
        kind: "job",
        id: `job:manifest:${name}:${job}`,
        location: loc,
        attrs: {
          class: "manifest-job",
          handler: def.handler ?? null,
          schedule: def.schedule ?? null,
        },
        source: "manifest",
      })
    }
    const events = m.manifest.events ?? {}
    const subs = events.subscribes ?? events.subscriptions ?? events.on ?? {}
    const subEntries: Array<[string, any]> = Array.isArray(subs)
      ? subs.map((s: any) => [typeof s === "string" ? s : (s.event ?? s.name), s])
      : Object.entries(subs)
    for (const [event, def] of subEntries) {
      rows.push({
        kind: "job",
        id: `job:event:${name}:${event}`,
        location: loc,
        attrs: {
          class: "manifest-event-subscription",
          handler: typeof def === "object" ? (def.handler ?? null) : def,
        },
        source: "manifest",
      })
    }
    for (const [routine, def] of Object.entries(
      (m.manifest.routines ?? {}) as Record<string, any>,
    )) {
      rows.push({
        kind: "job",
        id: `job:routine:${name}:${routine}`,
        location: loc,
        attrs: {
          class: "manifest-routine",
          trigger: def.kind ?? null,
          cron: def.cron ?? null,
          event: def.event ?? null,
        },
        source: "manifest",
      })
    }
    for (const impl of (m.manifest.implements ?? []) as any[]) {
      rows.push({
        kind: "job",
        id: `job:contract-impl:${name}:${impl.contract}@${impl.version}`,
        location: loc,
        attrs: { class: "contract-implementation", ops: Object.keys(impl.tools ?? {}) },
        source: "manifest",
      })
    }
    for (const call of (m.manifest.contract_calls ?? []) as any[]) {
      rows.push({
        kind: "job",
        id: `job:contract-call:${name}:${call.contract}`,
        location: loc,
        attrs: { class: "contract-call", bindingSetting: call.bindingSetting ?? null },
        source: "manifest",
      })
    }
    for (const call of (m.manifest.cross_app_calls ?? []) as any[]) {
      rows.push({
        kind: "job",
        id: `job:cross-app:${name}->${call.target}`,
        location: loc,
        attrs: { class: "cross-app-call", target: call.target },
        source: "manifest",
      })
    }
  }
  return rows
}

// ─── Kernel jobs and subscribers (AST) ──────────────────────────────────────

const JOB_REGISTRARS: Record<string, string> = {
  registerJobWorker: "job-worker",
  registerScheduledJob: "scheduled-job",
  upsertJobScheduler: "scheduled-job",
  registerDurableEventConsumer: "durable-consumer",
  onEvent: "event-bus-handler",
  subscribeToEvent: "event-subscription",
  registerKernelJob: "kernel-job",
  registerKernelJobWorker: "kernel-job",
}

export function enumerateKernelJobs(files: string[], root = LIAISON_ROOT): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    if (!Object.keys(JOB_REGISTRARS).some((k) => text.includes(k))) continue
    const sf = parseFile(file)
    const ids = new OrdinalIds()
    const relFile = rel(file, root)
    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return
      const name = calleeName(n)
      if (!name || !Object.hasOwn(JOB_REGISTRARS, name)) return
      if (ts.isFunctionDeclaration(n.parent)) return
      const args = n.arguments.map((a) => stringValue(a) ?? a.getText(sf).slice(0, 40))
      const label = args.slice(0, 2).join("/")
      rows.push({
        kind: "job",
        id: `job:kernel:${ids.next(`${relFile}#${name}#${label}`)}`,
        location: `${relFile}:${lineOf(sf, n)}`,
        attrs: {
          class: JOB_REGISTRARS[name],
          registrar: name,
          args: args.slice(0, 3),
          enclosing: enclosingFunctionName(n, sf),
        },
        source: "ast",
      })
    })
  }
  return rows
}

// ─── Bundled-app host calls (AST) ───────────────────────────────────────────

/** `ctx.<method>(...)` calls in bundled-app sources whose name is a bridge method. */
export function enumerateHostCalls(
  files: string[],
  bridgeMethods: Set<string>,
  root = LIAISON_ROOT,
): SurfaceRow[] {
  const byKey = new Map<string, SurfaceRow>()
  for (const file of files) {
    const sf = parseFile(file)
    const appName = rel(file, root).split("/")[1] ?? "?"
    walk(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return
      const method = n.expression.name.text
      if (!bridgeMethods.has(method)) return
      const recv = n.expression.expression.getText(sf)
      if (!/(^|\.)(ctx|context|bridge|host|sdk)$/.test(recv)) return
      const id = `hostcall:${appName}:${method}`
      const prev = byKey.get(id)
      if (prev) {
        prev.attrs.callSites = (prev.attrs.callSites as number) + 1
        return
      }
      byKey.set(id, {
        kind: "hostcall",
        id,
        location: `${rel(file, root)}:${lineOf(sf, n)}`,
        attrs: { app: appName, method, callSites: 1 },
        source: "ast",
      })
    })
  }
  return [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Bridge method names as written in the bridge factories (fallback and location). */
export function bridgeMethodsFromAst(root = LIAISON_ROOT): Map<string, string> {
  const dir = path.join(root, "apps", "api", "src", "modules", "apps", "sandbox", "bridge")
  const out = new Map<string, string>()
  for (const name of safeReaddir(dir)) {
    const file = path.join(dir, name)
    if (!isProductSourceFile(file)) continue
    const sf = parseFile(file)
    walk(sf, (n) => {
      if (
        !ts.isFunctionDeclaration(n) ||
        !n.name ||
        !/^create\w+Methods$/.test(n.name.text) ||
        !n.body
      )
        return
      const body = n.body
      const addObject = (obj: ts.ObjectLiteralExpression) => {
        for (const p of obj.properties) {
          if (!p.name) continue
          const key = p.name.getText(sf).replace(/^["']|["']$/g, "")
          if (!out.has(key)) out.set(key, `${rel(file, root)}:${lineOf(sf, p)}`)
        }
      }
      const factory = n
      walk(body, (r) => {
        if (!ts.isReturnStatement(r) || !r.expression) return
        // Only the factory's own return, not one of a method it defines.
        let owner: ts.Node | undefined = r.parent
        while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
        if (owner !== factory) return
        const obj = unwrapExpr(r.expression)
        if (ts.isObjectLiteralExpression(obj)) {
          addObject(obj)
          return
        }
        if (!ts.isIdentifier(obj)) return
        // `const methods = { ... }; methods.x = ...; return methods`
        const name = obj.text
        walk(body, (d) => {
          if (
            ts.isVariableDeclaration(d) &&
            ts.isIdentifier(d.name) &&
            d.name.text === name &&
            d.initializer
          ) {
            const init = unwrapExpr(d.initializer)
            if (ts.isObjectLiteralExpression(init)) addObject(init)
          }
          if (
            ts.isBinaryExpression(d) &&
            d.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(d.left) &&
            ts.isIdentifier(d.left.expression) &&
            d.left.expression.text === name
          ) {
            const key = d.left.name.text
            if (!out.has(key)) out.set(key, `${rel(file, root)}:${lineOf(sf, d)}`)
          }
        })
      })
    })
  }
  return out
}

// ─── CLI, services, desktop, deep links, push ───────────────────────────────

/** The CLI entry and the module it dispatches to; the USAGE table lives in one of them. */
const CLI_USAGE_FILES = ["index.ts", "main.ts"]

/** The command table the top-level USAGE is built from (`USAGE = topLevelUsage()`). */
const CLI_COMMAND_TABLE = "commands.ts"

export function enumerateCliCommands(root = LIAISON_ROOT): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  for (const name of CLI_USAGE_FILES) {
    const file = path.join(root, "apps", "api", "src", "cli", name)
    if (existsSync(file)) rows.push(...cliUsageRows(file, root))
  }
  const table = path.join(root, "apps", "api", "src", "cli", CLI_COMMAND_TABLE)
  if (existsSync(table)) {
    const seen = new Set(rows.map((r) => r.id))
    for (const r of cliCommandTableRows(table, root)) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      rows.push(r)
    }
  }
  return rows
}

/** The `COMMANDS` array's entries: `{ name: "config apply", usage: "liaison config apply ..." }`. */
function cliCommandTableRows(file: string, root: string): SurfaceRow[] {
  const sf = parseFile(file)
  const rows: SurfaceRow[] = []
  walk(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || n.name.text !== "COMMANDS")
      return
    const list = n.initializer ? unwrapExpr(n.initializer) : undefined
    if (!list || !ts.isArrayLiteralExpression(list)) return
    for (const el of list.elements) {
      if (!ts.isObjectLiteralExpression(el)) continue
      const prop = (key: string) => {
        const p = el.properties.find(
          (x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && x.name.getText() === key,
        )
        return p ? stringValue(p.initializer) : undefined
      }
      const cmd = prop("name")
      if (!cmd) continue
      rows.push({
        kind: "cli",
        id: `cli:${cmd}`,
        location: `${rel(file, root)}:${lineOf(sf, el)}`,
        attrs: { usage: (prop("usage") ?? cmd).slice(0, 160) },
        source: "ast",
      })
    }
  })
  return rows
}

function cliUsageRows(file: string, root: string): SurfaceRow[] {
  const sf = parseFile(file)
  const rows: SurfaceRow[] = []
  walk(sf, (n) => {
    if (
      !ts.isVariableDeclaration(n) ||
      !ts.isIdentifier(n.name) ||
      n.name.text !== "USAGE" ||
      !n.initializer
    )
      return
    const text = stringValue(n.initializer) ?? n.initializer.getText(sf)
    const seen = new Set<string>()
    for (const line of text.split("\n").slice(1)) {
      const m = /^ {2}([a-z][a-z-]*(?: [a-z][a-z-]*(?:\|[a-z-]+)*)?)(?=\s|$)/.exec(line)
      if (!m) continue
      const words = m[1].split(" ").filter((w) => !w.startsWith("<"))
      const cmd = words.join(" ")
      if (seen.has(cmd)) continue
      seen.add(cmd)
      rows.push({
        kind: "cli",
        id: `cli:${cmd}`,
        location: `${rel(file, root)}:${lineOf(sf, n)}`,
        attrs: { usage: line.trim().slice(0, 160) },
        source: "ast",
      })
    }
  })
  return rows
}

/** Standalone processes that listen (Bun.serve / createServer / a Hono app with its own entry). */
export function enumerateServices(root = LIAISON_ROOT): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  const dirs = [
    path.join(root, "apps", "db-gate", "src"),
    path.join(root, "apps", "desktop", "sidecar"),
    path.join(root, "apps", "api", "src", "lib"),
    path.join(root, "apps", "api", "src", "index.ts"),
  ]
  const files: string[] = []
  for (const d of dirs) {
    if (!existsSync(d)) continue
    if (statSync(d).isFile()) files.push(d)
    else listSourceFiles(d, files)
  }
  for (const pkg of safeReaddir(path.join(root, "packages")))
    listSourceFiles(path.join(root, "packages", pkg, "src"), files)
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    if (!/Bun\.serve\(|createServer\(|\.listen\(/.test(text)) continue
    const sf = parseFile(file)
    const ids = new OrdinalIds()
    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return
      const t = n.expression.getText(sf)
      if (!/^(Bun\.serve|(\w+\.)?createServer|\w+\.listen)$/.test(t)) return
      if (/\.listen$/.test(t) && !/server|app|srv/i.test(t)) return
      const relFile = rel(file, root)
      rows.push({
        kind: "service",
        id: `service:${ids.next(`${relFile}#${t}`)}`,
        location: `${relFile}:${lineOf(sf, n)}`,
        attrs: { call: t, enclosing: enclosingFunctionName(n, sf) },
        source: "ast",
      })
    })
  }
  // db-gate's own HTTP surface: routes registered on its Hono app.
  const gate = path.join(root, "apps", "db-gate", "src")
  for (const file of listSourceFiles(gate)) {
    const sf = parseFile(file)
    walk(sf, (n) => {
      if (!ts.isCallExpression(n)) return
      const name = calleeName(n)
      const p = stringValue(n.arguments[0])
      if (
        !name ||
        !HTTP_METHODS.has(name) ||
        p === undefined ||
        !ts.isPropertyAccessExpression(n.expression)
      )
        return
      if (!p.startsWith("/")) return
      rows.push({
        kind: "service",
        id: `service:db-gate:${name.toUpperCase()} ${p}`,
        location: `${rel(file, root)}:${lineOf(sf, n)}`,
        attrs: { call: `${name.toUpperCase()} ${p}`, enclosing: enclosingFunctionName(n, sf) },
        source: "ast",
      })
    })
  }
  return rows
}

/** Tauri IPC commands: `#[tauri::command]` functions (Rust, text scan) and whether a release build registers them. */
export function enumerateDesktopIpc(root = LIAISON_ROOT): SurfaceRow[] {
  const dir = path.join(root, "apps", "desktop", "src-tauri", "src")
  const rows: SurfaceRow[] = []
  const main = path.join(dir, "main.rs")
  const mainText = existsSync(main) ? readFileSync(main, "utf8") : ""
  // The release handler list: the generate_handler! under #[cfg(not(debug_assertions))].
  const releaseBlock =
    /#\[cfg\(not\(debug_assertions\)\)\]\s*let builder = builder\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/.exec(
      mainText,
    )?.[1] ?? ""
  const allBlocks = [...mainText.matchAll(/generate_handler!\[([\s\S]*?)\]/g)]
    .map((m) => m[1])
    .join("\n")
  const registered = (block: string, mod: string, fn: string) =>
    new RegExp(`(^|[\\s,])(${mod}::)?${fn}\\s*(,|$)`, "m").test(block)
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith(".rs")) continue
    const file = path.join(dir, name)
    const lines = readFileSync(file, "utf8").split("\n")
    const mod = name.replace(/\.rs$/, "")
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*#\[tauri::command/.test(lines[i])) continue
      let j = i + 1
      while (j < lines.length && !/\bfn\s+\w+/.test(lines[j])) j++
      const fn = /\bfn\s+(\w+)/.exec(lines[j] ?? "")?.[1]
      if (!fn) continue
      rows.push({
        kind: "desktop-ipc",
        id: `desktop-ipc:${mod}::${fn}`,
        location: `${rel(file, root)}:${j + 1}`,
        attrs: {
          module: mod,
          command: fn,
          inReleaseHandler: registered(releaseBlock, mod, fn),
          inAnyHandler: registered(allBlocks, mod, fn),
        },
        source: "text",
      })
    }
  }
  return rows
}

const DEEPLINK_PATTERNS: Array<[RegExp, string]> = [
  [/onOpenUrl\s*\(/, "tauri deep-link onOpenUrl"],
  [/getCurrent\s*\(\s*\)/, "tauri deep-link getCurrent (cold start)"],
  [/on_open_url\s*\(/, "tauri deep-link on_open_url (rust)"],
  [/addListener\(\s*["']appUrlOpen["']/, "capacitor appUrlOpen"],
  [/getLaunchUrl\s*\(/, "capacitor getLaunchUrl (cold start)"],
  [/addListener\(\s*["']pushNotificationActionPerformed["']/, "push notification tap"],
  [
    /addListener\(\s*["']notificationclick["']|addEventListener\(\s*["']notificationclick["']/,
    "web push notificationclick",
  ],
  [
    /register_uri_scheme_protocol|register_asynchronous_uri_scheme_protocol/,
    "tauri custom URI protocol",
  ],
  [/\blisten(<[^>]*>)?\(\s*\w*DEEP_LINK\w*/, "tauri deep-link event (webview)"],
  [/\blisten(<[^>]*>)?\(\s*\w*CLICK_EVENT\w*/, "desktop notification click event"],
]

/** Handlers for URLs and notification taps arriving from outside the app (text scan). */
export function enumerateDeepLinks(root = LIAISON_ROOT): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  const files: string[] = []
  for (const d of [
    path.join(root, "apps", "desktop", "src"),
    path.join(root, "apps", "mobile", "src"),
    path.join(root, "apps", "web", "src"),
    path.join(root, "apps", "web", "public"),
  ]) {
    if (!existsSync(d)) continue
    for (const f of listAll(d))
      if (/\.(ts|tsx|js)$/.test(f) && isProductSourceFile(f.replace(/\.js$/, ".ts"))) files.push(f)
  }
  const tauriSrc = path.join(root, "apps", "desktop", "src-tauri", "src")
  for (const f of safeReaddir(tauriSrc)) if (f.endsWith(".rs")) files.push(path.join(tauriSrc, f))
  for (const file of files.sort()) {
    const lines = readFileSync(file, "utf8").split("\n")
    const ids = new OrdinalIds()
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(\/\/|\*)/.test(lines[i])) continue
      for (const [rx, label] of DEEPLINK_PATTERNS) {
        if (!rx.test(lines[i])) continue
        const relFile = rel(file, root)
        rows.push({
          kind: "deeplink",
          id: `deeplink:${ids.next(`${relFile}#${label}`)}`,
          location: `${relFile}:${i + 1}`,
          attrs: { handler: label },
          source: "text",
        })
      }
    }
  }
  return rows
}

function listAll(dir: string, out: string[] = []): string[] {
  for (const name of safeReaddir(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name) || name.startsWith(".")) continue
      listAll(full, out)
    } else out.push(full)
  }
  return out
}

/** Exported functions of the push module that build or send a push payload. */
export function enumeratePushBuilders(root = LIAISON_ROOT): SurfaceRow[] {
  const rows: SurfaceRow[] = []
  const dirs = [
    path.join(root, "apps", "api", "src", "modules", "push"),
    path.join(root, "apps", "api", "src", "modules", "notifications"),
  ]
  for (const dir of dirs) {
    for (const file of listSourceFiles(dir)) {
      const sf = parseFile(file)
      for (const st of sf.statements) {
        const exported =
          ts.canHaveModifiers(st) &&
          ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        if (!exported) continue
        let name: string | undefined
        if (ts.isFunctionDeclaration(st) && st.name) name = st.name.text
        if (ts.isVariableStatement(st)) {
          const d = st.declarationList.declarations[0]
          if (
            d &&
            ts.isIdentifier(d.name) &&
            d.initializer &&
            (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
          )
            name = d.name.text
        }
        if (!name || !/push|payload|deliver|notify|badge|deep ?link|send/i.test(name)) continue
        rows.push({
          kind: "push",
          id: `push:${rel(file, root)}#${name}`,
          location: `${rel(file, root)}:${lineOf(sf, st)}`,
          attrs: { fn: name },
          source: "ast",
        })
      }
    }
  }
  return rows
}

// ─── Runtime: tables, tools, webhooks, bridge ───────────────────────────────

export interface TableQueryRow {
  schema: string
  table: string
  rls_enabled: boolean
  rls_forced: boolean
  policy_count: number | string
  has_org_id: boolean
}

export const TABLES_SQL = `
  SELECT n.nspname AS schema, c.relname AS table,
         c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count,
         EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id'
                 AND a.attnum > 0 AND NOT a.attisdropped) AS has_org_id
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND (n.nspname = 'kernel' OR n.nspname LIKE 'app\\_%')
  ORDER BY 1, 2`

export const TABLES_INDEPENDENT_SQL = `
  SELECT count(*) AS n FROM information_schema.tables
  WHERE table_type = 'BASE TABLE' AND (table_schema = 'kernel' OR table_schema LIKE 'app\\_%')`

export function tableRows(result: TableQueryRow[]): SurfaceRow[] {
  return result.map((r) => ({
    kind: "table" as const,
    id: `table:${r.schema}.${r.table}`,
    location: "pg_catalog",
    attrs: {
      rlsEnabled: r.rls_enabled,
      rlsForced: r.rls_forced,
      policies: Number(r.policy_count),
      hasOrgId: r.has_org_id,
    },
    source: "runtime" as const,
  }))
}

/** Tables of `kernel` and every `app_*` schema, from a postgres.js client. */
export async function enumerateTables(sql: {
  unsafe(q: string): Promise<any[]>
}): Promise<SurfaceRow[]> {
  const result = (await sql.unsafe(TABLES_SQL)) as TableQueryRow[]
  return tableRows(result)
}

interface RuntimeResult {
  rows: SurfaceRow[]
  notes: EnumerationNote[]
  crossCounts: CrossCount[]
}

/**
 * Bring up one org with every bundled app installed, then read the runtime
 * registries and the catalog. TRUNCATES the namespace's org tables (it uses the
 * integration-test org bootstrap): run only inside a test namespace.
 */
async function runtimeInventory(root: string): Promise<RuntimeResult> {
  const notes: EnumerationNote[] = []
  const crossCounts: CrossCount[] = []
  const rows: SurfaceRow[] = []
  const appsDir = mkdtempSync(path.join(tmpdir(), "surface-inventory-apps-"))
  process.env.LIAISON_APPS_DIR = appsDir
  try {
    const { createTestOrg } = await import("~/tests/helpers/org")
    const { installAppFromTarball } = await import("~/modules/apps/install-service")
    // A bundled app is first-party only when its artifact is the catalog's
    // (install-trust.ts), so install the copy baked into this process's test
    // catalog, as the tests do. A raw dist tarball is refused as an outside app
    // claiming the first-party publisher.
    const { bakeIntoTestCatalog } = await import("~/tests/helpers/test-app-catalog")
    const installFailures: string[] = []
    const { reloadInstalledApps } = await import("~/modules/apps/init")
    const { sql } = await import("~/db")
    const org = await createTestOrg()
    const installed: string[] = []
    for (const m of readManifests(root).filter((x) => x.bundled)) {
      const tarball = path.join(
        root,
        "bundled-apps",
        m.app,
        "dist",
        `${m.manifest.name}-${m.manifest.version}.liaisonapp`,
      )
      if (!existsSync(tarball)) {
        installFailures.push(
          `bundled app ${m.app}: no built tarball at ${rel(tarball, root)} (run scripts/bootstrap-test-env.ts)`,
        )
        continue
      }
      try {
        await installAppFromTarball({
          tarballPath: bakeIntoTestCatalog(tarball),
          installedBy: crypto.randomUUID(),
          grantedScopes: m.manifest.scopes ?? [],
          grantedConnections: Object.keys(m.manifest.connections ?? {}),
          requireSignature: false,
          approveUiFullAccess: true,
          sourceUrl: `inventory:${m.app}`,
        })
        installed.push(m.app)
      } catch (err) {
        installFailures.push(
          `bundled app ${m.app}: install failed: ${String((err as Error).message).slice(0, 200)}`,
        )
      }
    }
    // An app that did not install takes its tables, tools and webhooks out of
    // every count below while the cross-counts stay equal (they compare against
    // what installed), so a partial inventory is refused, never reported.
    if (installFailures.length > 0) {
      throw new Error(`runtime inventory incomplete:\n${installFailures.join("\n")}`)
    }
    await reloadInstalledApps(org.id)
    notes.push({ kind: "table", note: `installed bundled apps: ${installed.join(", ")}` })

    // Tables
    const tables = await enumerateTables(sql as any)
    rows.push(...tables)
    const [ind] = (await (sql as any).unsafe(TABLES_INDEPENDENT_SQL)) as Array<{
      n: string | number
    }>
    crossCounts.push({
      kind: "table",
      label: "kernel + app_* base tables",
      enumerated: tables.length,
      independent: Number(ind?.n ?? -1),
      method: "information_schema.tables",
    })

    // Tools
    const { toolRegistry, webhookHandlers, appBridgeManifestRegistry } = await import(
      "~/modules/apps/app-registries"
    )
    const toolRows: SurfaceRow[] = []
    for (const [[orgId, appName, toolName], def] of toolRegistry.entries()) {
      if (orgId !== org.id && orgId !== "*") continue
      const d = def as Record<string, any>
      toolRows.push({
        kind: "tool",
        id: `tool:${appName}:${toolName}`,
        location: "runtime:toolRegistry",
        attrs: {
          origin: appName === "kernel" ? "kernel" : d._manifest ? "manifest" : "host",
          gated: d.gated === true,
          conditionalGate: d.conditionalGate === true,
          readOnly: d.readOnly === true,
          externalEffect: d.externalEffect === true,
          approvalImpact: d.approvalImpact ?? null,
          writesToTable: d.writesToTable ?? null,
          scopes: d.requiredScopes ?? [],
          agentVisible: d.agentVisible !== false,
          registered: true,
        },
        source: "runtime",
      })
    }
    rows.push(...toolRows)
    const declaredToolIds = new Set(
      readManifests(root)
        .filter((m) => !m.bundled || installed.includes(m.app))
        .flatMap((m) => manifestTools(m).map(([t]) => `tool:${m.manifest.name ?? m.app}:${t}`)),
    )
    const registeredIds = new Set(toolRows.map((r) => r.id))
    for (const r of toolRows) {
      if (r.attrs.origin !== "kernel" && !declaredToolIds.has(r.id))
        r.attrs.origin = "host-registered"
    }
    crossCounts.push({
      kind: "tool",
      label:
        "manifest-declared tools that registered (a declared tool missing at runtime = a failed registration)",
      enumerated: [...declaredToolIds].filter((id) => registeredIds.has(id)).length,
      independent: declaredToolIds.size,
      method: "manifest JSON (installed apps)",
    })
    notes.push({
      kind: "tool",
      note: "MCP-projected tools exist only for an org with a remote MCP connection; they are one class (modules/mcp-client/projector.ts), listed as the row tool:mcp:<projected>",
    })
    rows.push({
      kind: "tool",
      id: "tool:mcp:<projected>",
      location: "apps/api/src/modules/mcp-client/projector.ts",
      attrs: {
        origin: "mcp-projected",
        gated: null,
        readOnly: null,
        externalEffect: null,
        approvalImpact: null,
        scopes: [],
        registered: false,
      },
      source: "ast",
    })

    // Webhooks (manifest-declared, as registered)
    let webhookCount = 0
    for (const [[orgId, appName, endpoint], def] of webhookHandlers.entries()) {
      if (orgId !== org.id && orgId !== "*") continue
      webhookCount++
      const d = def as Record<string, any>
      const verify = d.verify
      rows.push({
        kind: "webhook",
        id: `webhook:${appName}:${endpoint}`,
        location: "runtime:webhookHandlers",
        attrs: {
          origin: "manifest",
          receiver: `/webhooks/:orgId/${appName}/${endpoint}`,
          verifier:
            typeof verify === "function" ? verify.name || "host-fn" : (verify?.exportName ?? null),
          handler:
            typeof d.handler === "function"
              ? d.handler.name || "host-fn"
              : (d.handler?.exportName ?? null),
          bodyLimitBytes: d.bodyLimitBytes ?? null,
          requiresUserActor: d.requiresUserActor === true,
          registered: true,
        },
        source: "runtime",
      })
    }
    const declaredWebhookIds = readManifests(root)
      .filter((m) => !m.bundled || installed.includes(m.app))
      .flatMap((m) =>
        Object.keys(m.manifest.webhooks ?? {}).map(
          (e) => `webhook:${m.manifest.name ?? m.app}:${e}`,
        ),
      )
    const registeredWebhooks = new Set(rows.filter((r) => r.kind === "webhook").map((r) => r.id))
    crossCounts.push({
      kind: "webhook",
      label: "manifest-declared webhooks that registered",
      enumerated: declaredWebhookIds.filter((id) => registeredWebhooks.has(id)).length,
      independent: declaredWebhookIds.length,
      method: "manifest JSON (installed apps)",
    })
    void webhookCount

    // Bridge
    const astBridge = bridgeMethodsFromAst(root)
    let bridgeNames: string[] = []
    try {
      const { createRpcBridge } = await import("~/modules/apps/sandbox/rpc-bridge")
      const bridge = createRpcBridge(
        "surface-inventory",
        "system",
        org.id,
        {} as never,
        { name: "surface-inventory" } as never,
      )
      bridgeNames = Object.keys(bridge).sort()
    } catch (err) {
      notes.push({
        kind: "bridge",
        note: `createRpcBridge could not be built at runtime (${String((err as Error).message).slice(0, 120)}); methods from AST`,
      })
      bridgeNames = [...astBridge.keys()].sort()
    }
    for (const name of bridgeNames) {
      rows.push({
        kind: "bridge",
        id: `bridge:${name}`,
        location: astBridge.get(name) ?? "runtime:createRpcBridge",
        attrs: { method: name, origin: "kernel", inAst: astBridge.has(name) },
        source: "runtime",
      })
    }
    crossCounts.push({
      kind: "bridge",
      label: "kernel bridge methods runtime vs factory object keys",
      enumerated: bridgeNames.length,
      independent: astBridge.size,
      method: "AST of sandbox/bridge/*.ts return objects",
    })
    // Per-app bridge extensions
    try {
      const ext = (await import("~/modules/apps/sandbox/bridge-extensions")) as Record<string, any>
      const registry = ext.appBridgeExtensionRegistry
      if (registry?.entries) {
        for (const [[orgId, appName], factory] of registry.entries()) {
          if (orgId !== org.id && orgId !== "*") continue
          let names: string[] = []
          try {
            names = Object.keys(
              factory({ appName, orgId: org.id, userId: "system", txDb: {}, actorType: "system" }),
            )
          } catch {
            names = ["<factory threw on probe>"]
          }
          for (const n of names) {
            rows.push({
              kind: "bridge",
              id: `bridge:ext:${appName}:${n}`,
              location: "runtime:appBridgeExtensionRegistry",
              attrs: { method: n, origin: `extension:${appName}`, inAst: false },
              source: "runtime",
            })
          }
        }
      }
    } catch (err) {
      notes.push({
        kind: "bridge",
        note: `bridge extensions not enumerable: ${String((err as Error).message).slice(0, 120)}`,
      })
    }
    void appBridgeManifestRegistry
    notes.push({
      kind: "job",
      note: "kernel job workers have no runtime listing (infra/jobs/jobs.ts keeps jobHandlers private; a JobsTestAccess.list() seam would make it runtime); kernel jobs and subscribers come from the AST of their registration calls",
    })
    return { rows, notes, crossCounts }
  } finally {
    rmSync(appsDir, { recursive: true, force: true })
  }
}

// ─── Static (AST/text) pass ─────────────────────────────────────────────────

/** Count non-comment occurrences of a pattern: the grep side of a cross-check. */
export function grepCount(
  files: string[],
  rx: RegExp,
  exclude?: RegExp,
  stripStrings = true,
): number {
  let n = 0
  for (const file of files) {
    const text = readFileSync(file, "utf8")
    let inBlock = false
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (inBlock) {
        if (t.includes("*/")) inBlock = false
        continue
      }
      if (t.startsWith("/*")) {
        if (!t.includes("*/")) inBlock = true
        continue
      }
      if (t.startsWith("//") || t.startsWith("*")) continue
      if (exclude?.test(line)) continue
      // A mention inside a quoted string is not a call.
      const code = stripStrings ? line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""') : line
      const m = code.match(
        new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : `${rx.flags}g`),
      )
      if (m) n += m.length
    }
  }
  return n
}

export function staticInventory(root = LIAISON_ROOT): RuntimeResult {
  const notes: EnumerationNote[] = []
  const crossCounts: CrossCount[] = []
  const server = serverSourceFiles(root)
  const bundled = bundledAppSourceFiles(root)
  const manifests = readManifests(root)
  const priv = enumeratePrivilegedSites([...server, ...bundled], root)
  const raw = enumerateRawSql([...server, ...bundled], root)
  const search = enumerateSearchFilters(server, root)
  const redisKeys = enumerateRedisKeys(server, root)
  notes.push({
    kind: "search",
    note: "AST only: calls on a Meilisearch index (search, getDocuments, deleteDocuments, ...) with the filter they pass and whether it pins an org, and every template writing an org_id clause with the org id's source",
  })
  notes.push({
    kind: "redis",
    note: "AST only: command calls on a Redis client (the lib/redis clients, their duplicates, multi/pipeline chains, Redis-typed parameters) with the key expression, its static head, the spliced values and the key builder's template",
  })
  const privCalls = priv.filter((r) => r.attrs.fn !== "SET ROLE").length
  crossCounts.push({
    kind: "priv",
    label: "withPrivilegedDb/withSystemDb/withSchemaAdmin call sites",
    enumerated: privCalls,
    independent: grepCount(
      [...server, ...bundled],
      /\b(withPrivilegedDb|withSystemDb|withSchemaAdmin)\s*(<[^>]*>)?\(/,
      /^\s*(export\s+)?(async\s+)?function\s|^\s*import\s/,
    ),
    method: "grep (non-comment lines, excluding declarations and imports)",
  })
  const rawCore = raw.filter((r) => /\.(raw|unsafe)$/.test(String(r.attrs.form))).length
  crossCounts.push({
    kind: "rawsql",
    label: "sql.raw / .unsafe sites",
    enumerated: rawCore,
    independent: grepCount(
      [...server, ...bundled],
      /\b\w*[sS]ql\w*\.raw\(|\.unsafe\(/,
      undefined,
      false,
    ),
    method: "grep (non-comment lines)",
  })
  notes.push({
    kind: "priv",
    note: "AST only: call sites are static code; org-id source is a syntactic best-effort trace inside the enclosing function",
  })
  notes.push({
    kind: "rawsql",
    note: "AST only: sql.raw / .unsafe / string-built execute|query arguments",
  })
  const kernelJobs = enumerateKernelJobs(server, root)
  const manifestJobs = enumerateManifestJobs(manifests, root)
  crossCounts.push({
    kind: "job",
    label: "kernel job/subscriber registration calls",
    enumerated: kernelJobs.length,
    independent: grepCount(
      server,
      new RegExp(`\\b(${Object.keys(JOB_REGISTRARS).join("|")})\\s*(<[^>]*>)?\\(`),
      /^\s*(export\s+)?(async\s+)?function\s|import\s/,
    ),
    method: "grep (non-comment lines, excluding declarations and imports)",
  })
  const ws = enumerateWsMessages(root)
  notes.push({
    kind: "ws",
    note: "AST only: message types the server's socket handler compares `data.type` against (lib/server.ts)",
  })
  const cli = enumerateCliCommands(root)
  notes.push({
    kind: "cli",
    note:
      cli.length > 0
        ? `AST only: the USAGE table of apps/api/src/cli/{${CLI_USAGE_FILES.join(",")}}`
        : `USAGE table not enumerable: no USAGE declaration in apps/api/src/cli/{${CLI_USAGE_FILES.join(",")}}`,
  })
  const services = enumerateServices(root)
  notes.push({
    kind: "service",
    note: "AST only: listen sites (Bun.serve / createServer / .listen) and apps/db-gate routes",
  })
  const ipc = enumerateDesktopIpc(root)
  notes.push({
    kind: "desktop-ipc",
    note: "text scan of Rust sources (not TypeScript): #[tauri::command] functions and the release generate_handler! list",
  })
  crossCounts.push({
    kind: "desktop-ipc",
    label: "#[tauri::command] attributes",
    enumerated: ipc.length,
    independent: grepCount(
      safeReaddir(path.join(root, "apps", "desktop", "src-tauri", "src"))
        .filter((f) => f.endsWith(".rs"))
        .map((f) => path.join(root, "apps", "desktop", "src-tauri", "src", f)),
      /^\s*#\[tauri::command/,
      undefined,
      false,
    ),
    method: "grep",
  })
  const deeplinks = enumerateDeepLinks(root)
  notes.push({
    kind: "deeplink",
    note: "text scan: deep-link, launch-URL and notification-tap listeners in desktop, mobile and web clients",
  })
  const push = enumeratePushBuilders(root)
  notes.push({
    kind: "push",
    note: "AST only: exported build/send functions of modules/push and modules/notifications",
  })
  return {
    rows: [
      ...priv,
      ...raw,
      ...search,
      ...redisKeys,
      ...kernelJobs,
      ...manifestJobs,
      ...ws,
      ...cli,
      ...services,
      ...ipc,
      ...deeplinks,
      ...push,
      ...enumerateManifestTools(manifests, root),
      ...enumerateManifestWebhooks(manifests, root),
    ],
    notes,
    crossCounts,
  }
}

/** Kernel webhook receivers: the runtime routes under /webhooks. */
export function kernelWebhookRows(routes: SurfaceRow[]): SurfaceRow[] {
  return routes
    .filter((r) => String(r.attrs.path).startsWith("/webhooks"))
    .map((r) => ({
      kind: "webhook" as const,
      id: `webhook:kernel:${r.attrs.method} ${r.attrs.path}`,
      location: r.location,
      attrs: {
        origin: "kernel",
        receiver: String(r.attrs.path),
        auth: r.attrs.auth,
        verifier: null,
        registered: true,
      },
      source: "runtime" as const,
    }))
}

/**
 * Merge manifest-declared rows with their runtime registration: the runtime row
 * wins, and a declared row the runtime never registered keeps `registered: false`.
 */
export function mergeDeclaredWithRuntime(
  declared: SurfaceRow[],
  runtime: SurfaceRow[],
): SurfaceRow[] {
  const byId = new Map<string, SurfaceRow>()
  for (const r of runtime) byId.set(r.id, r)
  for (const d of declared) {
    const rt = byId.get(d.id)
    if (rt) {
      rt.attrs = { ...d.attrs, ...rt.attrs, declaredIn: d.location }
      continue
    }
    byId.set(d.id, { ...d, attrs: { ...d.attrs, registered: false } })
  }
  return [...byId.values()]
}

// ─── Orchestration ──────────────────────────────────────────────────────────

function runChild(
  args: string[],
  env: Record<string, string | null>,
): { rows: SurfaceRow[]; notes: EnumerationNote[]; crossCounts: CrossCount[]; error?: string } {
  const childEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v
  childEnv.NODE_ENV = childEnv.NODE_ENV || "test"
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete childEnv[k]
    else childEnv[k] = v
  }
  const envFile = path.join(LIAISON_ROOT, ".env.test")
  const preload = path.join(API_ROOT, "src", "tests", "test-env-defaults.ts")
  // A caller whose variant needs a module from outside this repository (the
  // chaos injector) names its loader here; comma-separated paths.
  const extra = (process.env.ENUMERATE_EXTRA_PRELOAD ?? "")
    .split(",")
    .filter(Boolean)
    .flatMap((p) => ["--preload", p])
  const res = spawnSync(
    "bun",
    [
      ...(existsSync(envFile) ? [`--env-file=${envFile}`] : []),
      "--preload",
      preload,
      ...extra,
      import.meta.path,
      ...args,
      "--json-stdout",
    ],
    {
      cwd: API_ROOT,
      env: childEnv,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    },
  )
  const out = res.stdout ?? ""
  const start = out.lastIndexOf("\n<<<ENUM-JSON>>>\n")
  if (res.status !== 0 || start < 0) {
    return {
      rows: [],
      notes: [],
      crossCounts: [],
      error: `exit ${res.status}: ${(res.stderr ?? "")
        .split("\n")
        .filter((l) => !l.startsWith("{"))
        .slice(-6)
        .join(" | ")
        .slice(0, 600)}`,
    }
  }
  return JSON.parse(out.slice(start + "\n<<<ENUM-JSON>>>\n".length))
}

export interface FullEnumerationOptions {
  variants?: string[]
  /** Skip the runtime pass (tables, registries): it needs a test namespace. */
  skipRuntime?: boolean
}

/** Everything: route variants and the runtime pass in child processes, static in-process. */
export function enumerateAll(opts: FullEnumerationOptions = {}): Enumeration {
  const notes: EnumerationNote[] = []
  const crossCounts: CrossCount[] = []
  const perVariant: Record<string, SurfaceRow[]> = {}
  for (const variant of opts.variants ?? Object.keys(ROUTE_VARIANTS)) {
    const env = { ...ROUTE_VARIANTS[variant] }
    if (variant === "chaos" && !process.env.CHAOS_DEBUG_INJECTOR_MODULE) {
      notes.push({
        kind: "route",
        note: "variant chaos skipped: CHAOS_DEBUG=1 needs CHAOS_DEBUG_INJECTOR_MODULE (the injector is not part of this repository)",
      })
      continue
    }
    const r = runChild(["routes", "--variant", variant], env)
    if (r.error) {
      notes.push({ kind: "route", note: `variant ${variant} failed to boot: ${r.error}` })
      continue
    }
    perVariant[variant] = r.rows
    notes.push({ kind: "route", note: `variant ${variant}: ${r.rows.length} endpoints` })
  }
  const routes = mergeRouteVariants(perVariant)
  const stat = staticInventory()
  notes.push(...stat.notes)
  crossCounts.push(...stat.crossCounts)
  let runtime: RuntimeResult = { rows: [], notes: [], crossCounts: [] }
  if (!opts.skipRuntime) {
    const r = runChild(["runtime"], {})
    // Hard failure: without the runtime pass every app table, tool and webhook
    // is missing, and an inventory that exits 0 on that is read as complete.
    if (r.error) throw new Error(`runtime pass failed: ${r.error}`)
    runtime = r
  }
  notes.push(...runtime.notes)
  crossCounts.push(...runtime.crossCounts)
  const declaredTools = stat.rows.filter((r) => r.kind === "tool")
  const declaredWebhooks = stat.rows.filter((r) => r.kind === "webhook")
  const tools = opts.skipRuntime
    ? declaredTools
    : mergeDeclaredWithRuntime(
        declaredTools,
        runtime.rows.filter((r) => r.kind === "tool"),
      )
  const webhooks = [
    ...kernelWebhookRows(routes),
    ...(opts.skipRuntime
      ? declaredWebhooks
      : mergeDeclaredWithRuntime(
          declaredWebhooks,
          runtime.rows.filter((r) => r.kind === "webhook"),
        )),
  ]
  const bridgeRows = runtime.rows.filter((r) => r.kind === "bridge")
  const bridgeNames = new Set(
    bridgeRows.length > 0
      ? bridgeRows.map((r) => String(r.attrs.method))
      : [...bridgeMethodsFromAst().keys()],
  )
  if (bridgeRows.length === 0) {
    for (const [name, loc] of bridgeMethodsFromAst()) {
      bridgeRows.push({
        kind: "bridge",
        id: `bridge:${name}`,
        location: loc,
        attrs: { method: name, origin: "kernel", inAst: true },
        source: "ast",
      })
    }
  }
  const hostcalls = enumerateHostCalls(bundledAppSourceFiles(), bridgeNames)
  notes.push({
    kind: "hostcall",
    note: "AST only: ctx.<bridge method>(...) calls in bundled-app sources",
  })
  const rows = [
    ...routes,
    ...stat.rows.filter((r) => r.kind !== "tool" && r.kind !== "webhook"),
    ...runtime.rows.filter((r) => r.kind === "table"),
    ...tools,
    ...webhooks,
    ...bridgeRows,
    ...hostcalls,
  ]
  // Duplicate ids would break the overlay's merge: fail loudly.
  const seen = new Set<string>()
  for (const r of rows) {
    if (seen.has(r.id)) notes.push({ kind: r.kind, note: `duplicate id ${r.id}` })
    seen.add(r.id)
  }
  return {
    generatedAt: new Date().toISOString(),
    liaisonRoot: LIAISON_ROOT,
    rows,
    notes,
    crossCounts,
  }
}

async function emit(payload: unknown, toStdout: boolean, outFile?: string): Promise<void> {
  const json = JSON.stringify(payload)
  if (outFile) await Bun.write(outFile, json)
  if (toStdout) process.stdout.write(`\n<<<ENUM-JSON>>>\n${json}`)
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0]
  const flag = (f: string) => {
    const i = argv.indexOf(f)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const jsonStdout = argv.includes("--json-stdout")
  const out = flag("--out")
  if (cmd === "routes") {
    const variant = flag("--variant") ?? "test"
    const rows = await bootAppRoutes(variant)
    await emit({ rows, notes: [], crossCounts: [] }, jsonStdout, out)
    if (!jsonStdout && !out) console.log(JSON.stringify(rows, null, 1))
  } else if (cmd === "runtime") {
    const r = await runtimeInventory(LIAISON_ROOT)
    await emit(r, jsonStdout, out)
    if (!jsonStdout && !out) console.log(JSON.stringify(r, null, 1))
  } else if (cmd === "static") {
    const r = staticInventory()
    await emit(r, jsonStdout, out)
    if (!jsonStdout && !out) console.log(JSON.stringify(r.crossCounts, null, 1))
  } else if (cmd === "all") {
    const variants = flag("--variants")?.split(",")
    const r = enumerateAll({
      ...(variants ? { variants } : {}),
      skipRuntime: argv.includes("--skip-runtime"),
    })
    await emit(r, jsonStdout, out)
    if (!jsonStdout) {
      const counts: Record<string, number> = {}
      for (const row of r.rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1
      console.log(JSON.stringify({ counts, crossCounts: r.crossCounts, notes: r.notes }, null, 1))
    }
  } else {
    console.error(
      "usage: enumerate.ts static | routes [--variant <name>] | runtime | all [--out <file>] [--variants a,b] [--skip-runtime]",
    )
    process.exit(2)
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}
