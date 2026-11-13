// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Import attributes in a handler bundle, found before Bun reads the bundle.
 *
 * Bun runs a macro import (`import { f } from "m" with { type: "macro" }`) while
 * it parses: `Bun.Transpiler#transformSync`, `#scan` and `Bun.build` all run it,
 * in the host process. So the host never hands Bun a bundle that carries an
 * import attribute. No handler bundle needs one: the sandbox evaluates a bundle
 * as a script that cannot import.
 *
 * The bundle is read with the TypeScript parser, which never runs code, so the
 * check is syntactic: strings, template literals, comments and regular
 * expression literals that only contain `with {` are no attribute. A bundle the
 * parser cannot read is refused too, so text it reads one way and Bun another
 * never reaches Bun.
 */
import type ts from "typescript"

/** Why `source` must not reach Bun's parser, or null when it may. */
export async function importAttributeIssue(source: string): Promise<string | null> {
  const t = (await import("typescript")).default
  const sf = t.createSourceFile("bundle.js", source, t.ScriptTarget.Latest, false, t.ScriptKind.JS)
  const syntax =
    (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? []
  const first = syntax[0]
  if (first) {
    return `it does not parse at line ${lineOf(sf, first.start)}: ${t.flattenDiagnosticMessageText(first.messageText, "\n")}`
  }
  let found: string | null = null
  const visit = (node: ts.Node): void => {
    if (found) return
    if ((t.isImportDeclaration(node) || t.isExportDeclaration(node)) && node.attributes) {
      found = `it carries an import attribute (\`with { ... }\` or \`assert { ... }\`) at line ${lineOf(sf, node.pos)}`
      return
    }
    if (
      t.isCallExpression(node) &&
      node.expression.kind === t.SyntaxKind.ImportKeyword &&
      node.arguments.length > 1
    ) {
      found = `it passes import options (\`import(x, { with: ... })\`) at line ${lineOf(sf, node.pos)}`
      return
    }
    t.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(Math.max(0, pos)).line + 1
}

/**
 * Why `source` is not a plain script, or null when it is one. A plain script (an
 * import transform, a PDF template bundle, the code of a draft's preview) may
 * load nothing and export nothing: it has no import or export declaration, no
 * `import(...)`, no `import.meta` and no `return` outside a function. Read with
 * the TypeScript parser, which never runs code, so the answer does not depend on
 * how the text is spaced, commented or escaped. A script the parser cannot read
 * is refused.
 */
export async function plainScriptIssue(source: string): Promise<string | null> {
  const t = (await import("typescript")).default
  const sf = t.createSourceFile("script.js", source, t.ScriptTarget.Latest, false, t.ScriptKind.JS)
  const syntax =
    (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? []
  const first = syntax[0]
  if (first) {
    return `it does not parse at line ${lineOf(sf, first.start)}: ${t.flattenDiagnosticMessageText(first.messageText, "\n")}`
  }
  let found: string | null = null
  const at = (node: ts.Node) => `at line ${lineOf(sf, node.getStart(sf))}`
  const visit = (node: ts.Node, inFunction: boolean): void => {
    if (found) return
    if (t.isImportDeclaration(node) || t.isImportEqualsDeclaration(node)) {
      found = `it imports a module ${at(node)}; a script may import nothing`
      return
    }
    if (
      t.isExportDeclaration(node) ||
      t.isExportAssignment(node) ||
      (t.canHaveModifiers(node) &&
        t.getModifiers(node)?.some((m) => m.kind === t.SyntaxKind.ExportKeyword))
    ) {
      found = `it exports ${at(node)}; a script may export nothing`
      return
    }
    if (t.isCallExpression(node) && node.expression.kind === t.SyntaxKind.ImportKeyword) {
      found = `it loads a module (\`import(...)\`) ${at(node)}; a script may import nothing`
      return
    }
    if (t.isMetaProperty(node) && node.keywordToken === t.SyntaxKind.ImportKeyword) {
      found = `it reads \`import.meta\` ${at(node)}; a script is no module`
      return
    }
    if (t.isReturnStatement(node) && !inFunction) {
      found = `it returns outside a function ${at(node)}`
      return
    }
    const nested = inFunction || t.isFunctionLike(node) || t.isClassStaticBlockDeclaration(node)
    t.forEachChild(node, (child) => visit(child, nested))
  }
  visit(sf, false)
  return found
}

/**
 * The number of top-level statements of `source`, or null when it does not
 * parse: a script wrapped in a function scope must stay one statement, so a
 * script whose text closes the wrapper is refused.
 */
export async function topLevelStatementCount(source: string): Promise<number | null> {
  const t = (await import("typescript")).default
  const sf = t.createSourceFile("module.js", source, t.ScriptTarget.Latest, false, t.ScriptKind.JS)
  const syntax =
    (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? []
  return syntax.length > 0 ? null : sf.statements.length
}
