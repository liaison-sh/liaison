// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Customer-visible copy never carries dash punctuation: no em dash, no en dash,
// no " -- ". Plain hyphens (compounds, ranges like 8-128) are fine. This walks
// every string literal, template literal and JSX text node under apps/web/src.
// Comments are not syntax nodes, so they are never flagged. Exempt: log calls
// and Error messages built inside src/framework, which only developers read.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const SRC = resolve(__dirname, "..")
const DASH = /[–—]|\s--\s/
const LOG_CALL = /^(console|\w*[lL]og(ger)?)\.(log|info|warn|error|debug|trace)$/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "tests" || entry.name === "node_modules") continue
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

function developerOnly(node: ts.Node, rel: string): boolean {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && LOG_CALL.test(p.expression.getText())) return true
    if (ts.isNewExpression(p) && p.expression.getText() === "Error" && rel.startsWith("framework/"))
      return true
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

function findDashes(): string[] {
  const hits: string[] = []
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file)
    const text = readFileSync(file, "utf8")
    if (!DASH.test(text)) continue
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const visit = (node: ts.Node): void => {
      const value = literalText(node)
      if (value !== null && DASH.test(value) && !developerOnly(node, rel)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        hits.push(`${rel}:${line}: ${value.trim().slice(0, 80)}`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return hits
}

describe("customer-visible copy", () => {
  it("carries no em dash, en dash or ' -- ' in apps/web/src strings and JSX text", () => {
    expect(findDashes()).toEqual([])
  })
})
