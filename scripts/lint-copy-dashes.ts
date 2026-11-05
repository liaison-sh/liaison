// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * CI lint check: customer-visible copy never carries dash punctuation. No em
 * dash, no en dash, no " -- ". Plain hyphens (compounds, ranges like 8-128)
 * are fine.
 *
 * This walks every string literal, template literal chunk and JSX text node
 * under the UI string modules (apps/web/src, apps/desktop/src, apps/mobile/src
 * and each bundled app's src), plus the prose of the markdown documents a
 * customer or an operator reads (MARKDOWN_COPY_FILES), using
 * a real TypeScript AST rather than line regexes: comments are not syntax
 * nodes, so a dash in a comment is never flagged, and a multi-line JSX text
 * node is caught where a line scanner misses it.
 *
 * Exempt, because only developers read them: log calls, and Error messages
 * built inside a `framework/` directory.
 *
 * A string that is not copy at all (a transliteration table keyed by the dash
 * character, a regex, a CSS value, a machine identifier) is exempted at its
 * own line with a `// copy-lint: exempt <reason>` comment, on that line or the
 * line directly above it. The reason is mandatory: a bare marker exempts
 * nothing, so the exemption surface can never grow silently.
 *
 * Exported `scanSource` / `scanFile` are unit-tested in
 * scripts/lint-copy-dashes.test.ts.
 */
import { readdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import ts from "typescript"

export interface DashViolation {
  file: string
  line: number
  text: string
}

// An em/en dash anywhere, a spaced `--`, or a `--` wedged between word
// characters ("confirm--then ship"): all three read as dash punctuation. A
// plain hyphen in a compound or a range (1-8) stays fine.
const DASH = /[–—]|\s--\s|\w--\w/
// A logger call, however it is reached: `console.warn`, `logger.error`,
// `ctx.logger.warn`, `ctx.logger?.warn?.`. The receiver chain and the optional
// chaining are part of the SAME documented developer-only exemption; without
// them a sandboxed app's `ctx.logger.warn` was flagged as customer copy.
const LOG_CALL = /(^|\.)(console|\w*[lL]og(ger)?)\??\.(log|info|warn|error|debug|trace)\??\.?$/
/**
 * `// copy-lint: exempt <reason>`. The reason is required (at least one
 * non-space character after the marker): a bare marker is not an exemption.
 */
const EXEMPT_MARKER = /\/\/\s*copy-lint:\s*exempt\s+\S/

/**
 * Line numbers (1-based) suppressed by a documented exemption: the marker's
 * own line, and the line directly below it so a marker can sit above the
 * string it exempts.
 */
export function exemptLines(content: string): Set<number> {
  const out = new Set<number>()
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    if (EXEMPT_MARKER.test(lines[i])) {
      out.add(i + 1)
      out.add(i + 2)
    }
  }
  return out
}

/** Roots whose strings are read by customers. */
export const COPY_ROOTS = ["apps/web/src", "apps/desktop/src", "apps/mobile/src", "bundled-apps"]

/**
 * The MARKDOWN a customer or an operator reads, named file by file.
 *
 * `docs/` is mostly written for the people working on Liaison (the spec, the
 * roadmap, the backend and frontend overviews, the QA coverage table), and
 * those are not copy: they carry hundreds of dashes and gating them would be a
 * rewrite of the developer handbook, not a copy rule. The document below
 * ships AT a customer, so it is held to the same rule as a string in the
 * interface. A new customer facing document joins this list;
 * that is the whole maintenance cost.
 */
export const MARKDOWN_COPY_FILES = ["docs/release-notes.md"]

/**
 * MODEL FACING copy on the api side: prose the agent is handed and can quote
 * back to a person verbatim, so it is held to the same rule as a button label.
 * Named file by file rather than as a root, because `modules/agent` is mostly
 * machinery whose strings are identifiers and log text, not copy (P4c-T47, C8).
 */
export const MODEL_FACING_COPY_FILES = ["apps/api/src/modules/agent/context/cold-resume.ts"]

/**
 * Markdown the MODEL reads: the system prompt, the charter, the roster, the
 * compaction brief and the kernel shipped skill bodies. The agent quotes these
 * to a person, so the dash rule applies to them (P4c-T47, C8). Walked as a
 * root so a new prompt file is covered the day it lands.
 */
export const PROMPT_MARKDOWN_ROOTS = ["apps/api/src/modules/agent/prompts"]

/**
 * Locale JSON roots. This is where apps/web's copy actually lives: a string
 * that reaches a customer arrives through `i18n.t("kernel.x")`, so scanning
 * only the TypeScript sources misses the entire translated surface. Keys are
 * identifiers, never read by a customer, so only VALUES are scanned.
 */
export const LOCALE_ROOTS = ["packages/shared/src/i18n/locales"]

/**
 * The SCOPE CATALOG. Its `description` strings are what the capability picker
 * (the role, the user and the agent scope editors) prints under every scope
 * name, so they are interface copy that merely happens to live in a
 * TypeScript file on the api side. It is scanned with the same AST scanner the
 * web sources get, so the file's own comments are never flagged.
 */
export const SCOPE_CATALOG_FILES = ["apps/api/src/modules/permissions/scope-catalog.ts"]

/**
 * Roots holding `app.manifest.json`. A manifest mixes two audiences in one
 * file: the app's own `description` and every `label` are printed in the Apps
 * settings list and the connection dialogs, while `agentInstructions` and each
 * tool/param `description` are handed to the MODEL as a tool schema and are
 * never shown to a person. Only the first class is copy, so
 * `scanAppManifest` scans exactly those fields.
 */
export const APP_MANIFEST_ROOTS = ["bundled-apps", "apps/api/src/apps"]

/** Manifest keys a person reads, at any depth. */
const USER_FACING_MANIFEST_KEYS = new Set([
  "label",
  "title",
  "placeholder",
  "help",
  "hint",
  "emptyText",
  "subtitle",
])

function isDeveloperOnly(node: ts.Node, file: string): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && LOG_CALL.test(p.expression.getText())) return true
    if (
      ts.isNewExpression(p) &&
      p.expression.getText() === "Error" &&
      /(^|\/)framework\//.test(file)
    ) {
      return true
    }
    if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true
  }
  return false
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
    return node.text
  if (ts.isJsxText(node)) return node.text
  return null
}

export function scanSource(file: string, content: string): DashViolation[] {
  if (!DASH.test(content)) return []
  const out: DashViolation[] = []
  const exempt = exemptLines(content)
  const sf = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const visit = (node: ts.Node): void => {
    const value = literalText(node)
    if (value !== null && DASH.test(value) && !isDeveloperOnly(node, file)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      if (!exempt.has(line)) out.push({ file, line, text: value.trim().slice(0, 80) })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * A line locator for a JSON document: each offending value is matched back
 * against the raw text, which is exact for the one-value-per-line shape these
 * files are written in. A line is consumed once so two identical values do not
 * both report the first one.
 */
function lineFinder(content: string): (value: string) => number {
  const lines = content.split("\n")
  const consumed = new Set<number>()
  return (value: string): number => {
    const needle = JSON.stringify(value).slice(1, -1)
    for (let i = 0; i < lines.length; i++) {
      if (!consumed.has(i) && lines[i].includes(needle)) {
        consumed.add(i)
        return i + 1
      }
    }
    return 1
  }
}

/**
 * Scan one locale JSON file's string values. Keys are exempt. Line numbers are
 * recovered by matching each offending value back against the raw text, which
 * is exact for the one-key-per-line shape these files are written in.
 */
export function scanLocaleJson(file: string, content: string): DashViolation[] {
  if (!DASH.test(content)) return []
  let root: unknown
  try {
    root = JSON.parse(content)
  } catch {
    return []
  }
  const lineOf = lineFinder(content)
  const out: DashViolation[] = []
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (DASH.test(node)) out.push({ file, line: lineOf(node), text: node.trim().slice(0, 80) })
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node)) walk(value)
    }
  }
  walk(root)
  return out
}

/**
 * Scan ONE `app.manifest.json`, user-facing fields only: the app's own
 * top-level `description` (the Apps settings list prints it) and every
 * `label` / `title` / `placeholder` / `help` / `hint` / `emptyText` /
 * `subtitle` at any depth (connection dialogs, settings rows, activity bar).
 * A tool or parameter `description`, and `agentInstructions`, are model
 * facing tool-schema prose, not copy, and are deliberately not scanned.
 */
export function scanAppManifest(file: string, content: string): DashViolation[] {
  if (!DASH.test(content)) return []
  let root: unknown
  try {
    root = JSON.parse(content)
  } catch {
    return []
  }
  const lineOf = lineFinder(content)
  const out: DashViolation[] = []
  const walk = (node: unknown, path: string[]): void => {
    if (typeof node === "string") {
      const key = path[path.length - 1] ?? ""
      const isCopy =
        USER_FACING_MANIFEST_KEYS.has(key) || (path.length === 1 && key === "description")
      if (isCopy && DASH.test(node)) {
        out.push({ file, line: lineOf(node), text: node.trim().slice(0, 80) })
      }
      return
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walk(node[i], [...path, String(i)])
      return
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, [...path, k])
    }
  }
  walk(root, [])
  return out
}

/**
 * Scan one markdown document's PROSE. Code is not copy: a fenced block holds
 * SQL whose comments open with `--`, a shell line carries `--flag` and a
 * backticked identifier may be a table name with a dash in it, none of which a
 * customer reads as punctuation. Fenced blocks, inline code spans and HTML
 * comments are removed before the scan, and the line numbers survive because
 * each is replaced in place rather than deleted.
 */
export function scanMarkdown(file: string, content: string): DashViolation[] {
  if (!DASH.test(content)) return []
  const lines = content.split("\n")
  const out: DashViolation[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const prose = raw
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/^\s{4,}\S.*$/, " ")
    if (DASH.test(prose)) out.push({ file, line: i + 1, text: prose.trim().slice(0, 80) })
  }
  return out
}

export async function scanFile(absPath: string, relPath: string): Promise<DashViolation[]> {
  return scanSource(relPath, await Bun.file(absPath).text())
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "tests" || entry.name === "node_modules" || entry.name === "dist") continue
      out.push(...sourceFiles(full))
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full)
    }
  }
  return out
}

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...markdownFiles(full))
    else if (entry.name.endsWith(".md")) out.push(full)
  }
  return out
}

function appManifestFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      out.push(...appManifestFiles(full))
    } else if (entry.name === "app.manifest.json") out.push(full)
  }
  return out
}

function localeJsonFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...localeJsonFiles(full))
    else if (entry.name.endsWith(".json")) out.push(full)
  }
  return out
}

export async function lintCopyDashes(repoRoot: string): Promise<DashViolation[]> {
  const violations: DashViolation[] = []
  for (const root of COPY_ROOTS) {
    const abs = resolve(repoRoot, root)
    for (const file of sourceFiles(abs)) {
      violations.push(...(await scanFile(file, relative(repoRoot, file))))
    }
  }
  for (const file of MARKDOWN_COPY_FILES) {
    const abs = resolve(repoRoot, file)
    violations.push(...scanMarkdown(file, await Bun.file(abs).text()))
  }
  for (const file of MODEL_FACING_COPY_FILES) {
    const abs = resolve(repoRoot, file)
    violations.push(...(await scanFile(abs, file)))
  }
  for (const root of PROMPT_MARKDOWN_ROOTS) {
    const abs = resolve(repoRoot, root)
    for (const file of markdownFiles(abs)) {
      const rel = relative(repoRoot, file)
      violations.push(...scanMarkdown(rel, await Bun.file(file).text()))
    }
  }
  for (const file of SCOPE_CATALOG_FILES) {
    const abs = resolve(repoRoot, file)
    violations.push(...(await scanFile(abs, file)))
  }
  for (const root of APP_MANIFEST_ROOTS) {
    const abs = resolve(repoRoot, root)
    for (const file of appManifestFiles(abs)) {
      violations.push(...scanAppManifest(relative(repoRoot, file), await Bun.file(file).text()))
    }
  }
  for (const root of LOCALE_ROOTS) {
    const abs = resolve(repoRoot, root)
    for (const file of localeJsonFiles(abs)) {
      violations.push(...scanLocaleJson(relative(repoRoot, file), await Bun.file(file).text()))
    }
  }
  return violations
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..")
  const violations = await lintCopyDashes(repoRoot)
  if (violations.length > 0) {
    for (const v of violations) console.error(`${v.file}:${v.line}: dash punctuation: "${v.text}"`)
    console.error(
      `\n${violations.length} dash violation(s). Rewrite with a colon, a comma, parentheses or a sentence split.`,
    )
    process.exit(1)
  }
  console.log("No dash punctuation in customer-visible copy.")
}
