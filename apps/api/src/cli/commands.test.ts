// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The CLI command table (`cli/commands.ts`) and the dispatchers agree.
 *
 * main.ts and index.ts are read as source with the TypeScript parser, never
 * imported: both validate the environment or set process flags at import.
 * - every key of main.ts's `HANDLERS` is a table command, and every table
 *   command has a handler;
 * - `main()` dispatches through `HANDLERS` (no hand-written `cmd ===` branch
 *   that would bypass the table);
 * - every command group index.ts routes offline is a table group, and every
 *   `OFFLINE_COMMANDS` entry is a table command the offline runner handles.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import ts from "typescript"
import { runApiConnectorOffline } from "~/cli/api-connector/validate"
import { runAppOffline } from "~/cli/app/verify"
import {
  COMMANDS,
  groupUsage,
  OFFLINE_COMMANDS,
  resolveCommand,
  topLevelUsage,
} from "~/cli/commands"

const CLI_DIR = dirname(new URL(import.meta.url).pathname)
const TABLE = new Set<string>(COMMANDS.map((c) => c.name))

function parse(file: string): ts.SourceFile {
  const path = join(CLI_DIR, file)
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true)
}

function propName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  throw new Error(`unexpected handler key ${name.getText()}`)
}

/** The keys of main.ts's `HANDLERS` object literal. */
function handlerKeys(): string[] {
  const sf = parse("main.ts")
  const keys: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "HANDLERS" &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const p of node.initializer.properties) {
        if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          keys.push(propName(p.name))
        } else throw new Error(`unexpected HANDLERS member ${p.getText()}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return keys
}

/** String literals compared to `argv[0]` / `argv[1]` / `cmd` in a file. */
function comparedWords(file: string): string[] {
  const sf = parse(file)
  const words: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const left = node.left.getText()
      if (/^(argv\[\d\]|cmd)$/.test(left) && ts.isStringLiteral(node.right)) {
        words.push(node.right.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return words
}

describe("CLI command table", () => {
  test("command names are unique", () => {
    expect(TABLE.size).toBe(COMMANDS.length)
  })

  test("every table command has a main.ts handler, and every handler a table command", () => {
    const keys = handlerKeys()
    expect(keys.length).toBeGreaterThan(0)
    expect([...keys].sort()).toEqual([...TABLE].sort())
  })

  test("main() dispatches only through HANDLERS (no command branch outside the table)", () => {
    // The only argv comparisons left in main.ts are inside handlers that
    // pick between two table commands sharing one runner.
    const words = comparedWords("main.ts")
    const tableWords = new Set(COMMANDS.flatMap((c) => c.name.split(" ")))
    for (const w of words) expect(tableWords.has(w)).toBe(true)
  })

  test("every group index.ts routes offline is a table group", () => {
    const groups = new Set(COMMANDS.map((c) => c.name.split(" ")[0]))
    const words = comparedWords("index.ts")
    expect(words.length).toBeGreaterThan(0)
    for (const w of words) expect(groups.has(w)).toBe(true)
  })

  test("OFFLINE_COMMANDS are table commands the offline runner handles", async () => {
    for (const name of OFFLINE_COMMANDS) {
      expect(TABLE.has(name)).toBe(true)
      const [group, sub] = name.split(" ") as [string, string]
      const args = [sub, "/nonexistent/file"]
      // Handled offline (non-null), even for a missing file (exit 2).
      const res = group === "app" ? await runAppOffline(args) : runApiConnectorOffline(args)
      expect([name, res?.exitCode]).toEqual([name, 2])
    }
    // The online commands of those groups are left to main.ts.
    expect(runApiConnectorOffline(["test", "id", "op"])).toBeNull()
    expect(await runAppOffline(["status"])).toBeNull()
    expect(await runAppOffline(["rollback", "x"])).toBeNull()
  })

  test("every usage line starts with `liaison <name>`", () => {
    for (const c of COMMANDS) expect(c.usage.startsWith(`liaison ${c.name}`)).toBe(true)
  })

  test("resolveCommand picks the longest matching name", () => {
    expect(resolveCommand(["tickets", "inbox", "create", "--name", "x"])).toBe(
      "tickets inbox create",
    )
    expect(resolveCommand(["tickets", "import", "--file", "f"])).toBe("tickets import")
    expect(resolveCommand(["connect", "mail/gmail"])).toBe("connect")
    expect(resolveCommand(["guide", "google", "--email", "a@b.example"])).toBe("guide")
    expect(resolveCommand(["tickets", "frob"])).toBeNull()
    expect(resolveCommand(["frobnicate"])).toBeNull()
  })

  test("groupUsage lists the group's commands; unknown group → null", () => {
    const inbox = groupUsage(["tickets", "inbox", "frob"])
    expect(inbox?.startsWith("usage: liaison tickets inbox list")).toBe(true)
    expect(inbox).toContain("liaison tickets inbox move")
    expect(inbox).not.toContain("tickets import")
    expect(groupUsage(["config"])).toContain("liaison config verify")
    expect(groupUsage(["frobnicate"])).toBeNull()
  })

  test("top-level usage lists every command", () => {
    const usage = topLevelUsage()
    expect(usage.startsWith("usage: liaison <command>")).toBe(true)
    for (const c of COMMANDS) expect(usage).toContain(`  ${c.usage.replace(/^liaison /, "")}`)
  })
})
