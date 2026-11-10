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
