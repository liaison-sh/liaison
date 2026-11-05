#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Lint check: no full-width Button squeezing its row.
 *
 * The shared web Button (apps/web/src/ui/Button.tsx) used to default to
 * `w-full`. In a horizontal flex row that button claims the whole row and the
 * text beside it shrinks to a word per line (Settings > Nodes, d3042fcf9, then
 * 57 more rows across Settings, Calendar, MCP and Mailbox). Full width is now
 * opt-in (`fullWidth`), for stacked forms.
 *
 * This keeps the opt-in where it belongs: for every `<Button>` imported from
 * `ui/Button` that is full width (`fullWidth`, or `w-full` in its class), it
 * finds the nearest enclosing HTML element (control-flow components such as
 * Show and For are see-through) and flags the button when that element lays
 * its children out in a row (`flex` or `inline-flex` without `flex-col` or
 * `flex-wrap`, or a `*:flex-row` breakpoint), unless the button's class gives it a row width of
 * its own (`flex-1` or `basis-*` for equal shares, or another `w-*`).
 *
 * A button whose nearest parent is another component (a Dialog footer, a
 * Tooltip trigger) is not judged: its layout lives in that component.
 *
 * Wired into the root `lint` script. Run standalone:
 *   bun run check:button-width [--root <repo root>]
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

/** Components that render their children in place, adding no box. */
const TRANSPARENT = new Set([
  "Show",
  "For",
  "Index",
  "Switch",
  "Match",
  "Suspense",
  "ErrorBoundary",
  "Dynamic",
])

export interface Finding {
  file: string
  line: number
  parentTag: string
  parentClass: string
}

function attr(
  el: ts.JsxOpeningLikeElement,
  name: string,
  sf: ts.SourceFile,
): { present: boolean; literal?: string; text?: string } {
  for (const p of el.attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText(sf) !== name) continue
    const init = p.initializer
    if (!init) return { present: true, text: "" }
    if (ts.isStringLiteral(init)) return { present: true, literal: init.text, text: init.text }
    if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression
      if (ts.isStringLiteralLike(e)) return { present: true, literal: e.text, text: e.text }
      return { present: true, text: e.getText(sf) }
    }
    return { present: true, text: init.getText(sf) }
  }
  return { present: false }
}

/** Class tokens from a class attribute's source text (literal or expression). */
function tokens(text: string): string[] {
  return text.split(/[\s"'`{}(),?+]+/).filter(Boolean)
}

/** Variant-free token: `sm:flex-row` -> `flex-row`. */
function base(tok: string): string {
  const i = tok.lastIndexOf(":")
  return i === -1 ? tok : tok.slice(i + 1)
}

/** The variants under which a class lays out as a row: `sm:flex-row` -> `sm`. */
export function rowBreakpoints(classText: string): string[] {
  return tokens(classText)
    .filter((t) => t.includes(":") && base(t) === "flex-row")
    .map((t) => t.slice(0, t.lastIndexOf(":")))
}

/** A row on every screen, before any breakpoint applies. */
function isPlainRow(toks: string[]): boolean {
  const plain = toks.filter((t) => !t.includes(":"))
  const flex = plain.includes("flex") || plain.includes("inline-flex")
  const col = plain.includes("flex-col") || plain.includes("flex-col-reverse")
  // In a wrapping row a full-width item takes a line of its own: a stack, not a squeeze.
  const wrap = plain.includes("flex-wrap")
  return flex && !col && !wrap
}

export function isRow(classText: string): boolean {
  // A breakpoint row (`sm:flex-row`) is a row on the wider screens.
  return rowBreakpoints(classText).length > 0 || isPlainRow(tokens(classText))
}

function isRowWidth(tok: string): boolean {
  return (/^w-/.test(tok) && tok !== "w-full") || tok === "flex-1" || /^basis-/.test(tok)
}

/**
 * The button's own row width: an unprefixed `w-*`, `flex-1` or `basis-*`, or,
 * when its parent becomes a row only at a breakpoint, the same at that
 * breakpoint (`w-full sm:w-auto` in `flex-col sm:flex-row`: full width while
 * stacked, its label's width once the row applies).
 */
export function hasWidthOverride(classText: string, parentClass = ""): boolean {
  const toks = tokens(classText)
  if (toks.filter((t) => !t.includes(":")).some(isRowWidth)) return true
  if (isPlainRow(tokens(parentClass))) return false
  const atRow = new Set(rowBreakpoints(parentClass))
  return toks.some(
    (t) => t.includes(":") && atRow.has(t.slice(0, t.lastIndexOf(":"))) && isRowWidth(base(t)),
  )
}

function importsSharedButton(sf: ts.SourceFile): boolean {
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue
    if (!/(^|\/)ui\/Button$/.test(st.moduleSpecifier.text)) continue
    const named = st.importClause?.namedBindings
    if (named && ts.isNamedImports(named) && named.elements.some((e) => e.name.text === "Button"))
      return true
  }
  return false
}

/** The nearest enclosing HTML element, skipping see-through components. */
function enclosing(
  node: ts.Node,
  sf: ts.SourceFile,
): { tag: string; el: ts.JsxOpeningLikeElement } | { component: string } | null {
  let cur: ts.Node | undefined = node.parent
  // A JsxSelfClosingElement's own JsxElement wrapper is not its parent.
  if (cur && ts.isJsxElement(cur) && cur.openingElement === node) cur = cur.parent
  while (cur) {
    if (ts.isJsxElement(cur)) {
      const tag = cur.openingElement.tagName.getText(sf)
      if (/^[a-z]/.test(tag)) return { tag, el: cur.openingElement }
      if (!TRANSPARENT.has(tag)) return { component: tag }
    }
    if (ts.isSourceFile(cur)) break
    cur = cur.parent
  }
  return null
}

export function checkSource(file: string, source: string): Finding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  if (!importsSharedButton(sf)) return []
  const out: Finding[] = []
  const visit = (node: ts.Node): void => {
    const el = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null
    if (el && el.tagName.getText(sf) === "Button") {
      const fw = attr(el, "fullWidth", sf)
      const cls = attr(el, "class", sf).text ?? ""
      const full = (fw.present && fw.text !== "false") || tokens(cls).includes("w-full")
      if (full) {
        const parent = enclosing(ts.isJsxElement(node) ? node : el, sf)
        if (parent && "tag" in parent) {
          const pc = attr(parent.el, "class", sf).text ?? ""
          if (isRow(pc) && !hasWidthOverride(cls, pc)) {
            out.push({
              file,
              line: sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1,
              parentTag: parent.tag,
              parentClass: pc,
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const SCAN = ["apps/web/src"]

function walk(dir: string, acc: string[]): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const name of entries) {
    if (name === "node_modules") continue
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (name.endsWith(".tsx") && !/\.test\.tsx$/.test(name)) acc.push(p)
  }
  return acc
}

export function checkRoot(root: string): Finding[] {
  const files = SCAN.flatMap((d) => walk(path.join(root, d), []))
  return files.flatMap((f) => checkSource(path.relative(root, f), readFileSync(f, "utf8")))
}

if (import.meta.main) {
  const i = process.argv.indexOf("--root")
  const root =
    i !== -1 ? path.resolve(process.argv[i + 1] ?? ".") : path.resolve(import.meta.dir, "..")
  const findings = checkRoot(root)
  if (findings.length) {
    for (const f of findings) {
      console.error(
        `${f.file}:${f.line}  full-width <Button> in a row <${f.parentTag} class=${JSON.stringify(f.parentClass)}>`,
      )
    }
    console.error(
      `\n✗ check:button-width — ${findings.length} full-width Button(s) stretch across a flex row.\n  Drop fullWidth (buttons size to their label), or use class="flex-1" for equal shares.`,
    )
    process.exit(1)
  }
  console.log("✓ check:button-width — no full-width Button stretches across a flex row")
}
