// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T17: the agent panel pipeline is retired. There is ONE thread surface
// (ThreadView, reached through a Home tab or a dock ConversationTab), so the
// panel, its composer, its message list and its chat switcher are gone and
// nothing may import them back. A deleted file that someone re-adds under the
// same name would otherwise be invisible until a reviewer noticed.
//
// Same shape as copy-dash-sweep.test.ts: walk every source file under
// apps/web/src with the TypeScript parser and read the import specifiers as
// syntax, so a name inside a comment or a string is never a false positive.
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const SRC = resolve(__dirname, "..")

/** Module basenames retired by P4c-T17. Matched on the import specifier's tail. */
const RETIRED = ["AgentPanel", "AgentInputBar", "AgentMessageList", "ChatSwitcher"]

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      out.push(...sourceFiles(full))
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push(full)
    }
  }
  return out
}

/** The retired basename this specifier resolves to, if any. */
function retiredTarget(specifier: string): string | null {
  const tail = specifier.split("/").pop() ?? ""
  const base = tail.replace(/\.(tsx?|jsx?)$/, "")
  return RETIRED.includes(base) ? base : null
}

function findImports(): string[] {
  const hits: string[] = []
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file)
    // This sweep names the retired modules itself; it is not an importer.
    if (rel === "lib/panel-retired-sweep.test.ts") continue
    const text = readFileSync(file, "utf8")
    if (!RETIRED.some((name) => text.includes(name))) continue
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    const record = (specifierNode: ts.Node | undefined) => {
      if (!specifierNode || !ts.isStringLiteralLike(specifierNode)) return
      const target = retiredTarget(specifierNode.text)
      if (target === null) return
      const line = sf.getLineAndCharacterOfPosition(specifierNode.getStart(sf)).line + 1
      hits.push(`${rel}:${line}: imports ${target} from "${specifierNode.text}"`)
    }
    const visit = (node: ts.Node): void => {
      // `import x from "..."`, `export { x } from "..."`
      if (ts.isImportDeclaration(node)) record(node.moduleSpecifier)
      if (ts.isExportDeclaration(node)) record(node.moduleSpecifier)
      // `import("...")`, and `vi.mock("...")` / `vi.doMock("...")`, which are
      // module references too: a mock of a deleted module is stale by
      // definition and vitest does not complain about it.
      if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sf)
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === "vi.mock" ||
          callee === "vi.doMock" ||
          callee === "require"
        ) {
          record(node.arguments[0])
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return hits
}

describe("retired agent panel pipeline", () => {
  it("no module under apps/web/src imports AgentPanel, AgentInputBar or AgentMessageList", () => {
    expect(findImports()).toEqual([])
  })
})
