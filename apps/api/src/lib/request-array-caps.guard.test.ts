// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ratchet: every array in an HTTP request schema carries a length cap.
//
// The bug class. zod validates an uncapped `z.array(...)` element by element
// and allocates one issue per bad element, so a 1 MB JSON body of 500 000
// wrong-typed elements costs a couple of hundred MB of issue objects in one
// request. A capped array (`.max(n)`) is refused on its length first, with one
// issue. So every array a client can send is capped, generously: the cap only
// has to sit above what the web app, the CLI and the app SDK legitimately send.
//
// Scope: request schemas, i.e. every non-test file under apps/api/src that
// handles routes (a `*routes*` file name, or a file that reads a request body
// or query), the schema modules routes build from, and the shared request
// validation schemas (packages/shared/src/validation). Response schemas are
// out of scope: the server writes them, a client never sends them.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import ts from "typescript"

const API_SRC = resolve(import.meta.dir, "..")
const REPO = resolve(API_SRC, "../../..")
const SHARED_VALIDATION = join(REPO, "packages/shared/src/validation")

/** Schema modules outside the route files whose schemas validate request bodies. */
const EXTRA_REQUEST_MODULES = [join(API_SRC, "modules/apps/settings-schema-from-manifest.ts")]

/** A file handles requests when it validates or reads a body or a query. */
const HANDLER = /zValidator\(|c\.req\.(json|valid|query|parseBody)\(/

/**
 * Top-level declarations in scope files that are response schemas (the server
 * builds them; no client sends them), each with its reason. Any declaration
 * whose name ends in `ResponseSchema` is a response schema too.
 */
const RESPONSE_SCHEMAS: Record<string, string> = {
  adminUserDetailSchema: "GET /api/admin/users/:id response",
  adminRoleDetailSchema: "GET /api/admin/roles/:id response",
  transcriptionSettingsSchema: "GET/PATCH /api/settings/ai/transcription response",
}

function listTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "migrations") continue
      listTs(full, out)
    } else if (
      /\.ts$/.test(entry.name) &&
      !/\.test\.ts$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full)
    }
  }
  return out
}

function scopeFiles(): string[] {
  const api = listTs(API_SRC).filter((file) => {
    const base = file.slice(file.lastIndexOf("/") + 1)
    return /routes/.test(base) || HANDLER.test(readFileSync(file, "utf8"))
  })
  return [...new Set([...api, ...EXTRA_REQUEST_MODULES, ...listTs(SHARED_VALIDATION)])].sort()
}

/** The leftmost identifier of a call/property chain (`z` in `z.string().array()`). */
function chainRoot(node: ts.Expression): ts.Expression {
  let cur = node
  for (;;) {
    if (ts.isCallExpression(cur)) cur = cur.expression
    else if (ts.isPropertyAccessExpression(cur)) cur = cur.expression
    else return cur
  }
}

function isZodArray(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  if (node.expression.name.text !== "array") return false
  const root = chainRoot(node.expression.expression)
  return ts.isIdentifier(root) && root.text === "z"
}

/** Whether the methods chained onto the array (`.min(1).max(n).optional()`) include a cap. */
function isCapped(node: ts.CallExpression): boolean {
  let cur: ts.Node = node
  while (ts.isPropertyAccessExpression(cur.parent) && ts.isCallExpression(cur.parent.parent)) {
    const method = cur.parent.name.text
    if (method === "max" || method === "length") return true
    cur = cur.parent.parent
  }
  return false
}

/** The name of the top-level variable the node sits in, if any. */
function topLevelName(node: ts.Node): string | undefined {
  let cur: ts.Node | undefined = node
  let name: string | undefined
  while (cur) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) name = cur.name.text
    cur = cur.parent
  }
  return name
}

function isResponseSchema(name: string | undefined): boolean {
  if (!name) return false
  return name.endsWith("ResponseSchema") || name in RESPONSE_SCHEMAS
}

/** Every `file:line` of an uncapped request-schema array. */
export function findUncappedArrays(): string[] {
  const found: string[] = []
  for (const file of scopeFiles()) {
    const text = readFileSync(file, "utf8")
    if (!text.includes(".array(")) continue
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isZodArray(node) && !isCapped(node)) {
        if (!isResponseSchema(topLevelName(node))) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart())
          found.push(`${relative(REPO, file)}:${line + 1}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return found
}

describe("request schema arrays are capped", () => {
  it("scans the route files and the shared validation schemas", () => {
    const files = scopeFiles().map((f) => relative(REPO, f))
    expect(files).toContain("apps/api/src/modules/mail/routes.ts")
    expect(files).toContain("packages/shared/src/validation/knowledge.ts")
  })

  it("the scanner flags an uncapped array and passes a capped one", () => {
    const probe = (code: string): boolean[] => {
      const source = ts.createSourceFile("probe.ts", code, ts.ScriptTarget.Latest, true)
      const out: boolean[] = []
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isZodArray(node)) out.push(isCapped(node))
        ts.forEachChild(node, visit)
      }
      visit(source)
      return out
    }
    expect(probe("const a = z.array(z.string()).optional()")).toEqual([false])
    expect(probe("const a = z.array(z.string()).min(1).max(10).optional()")).toEqual([true])
    expect(probe("const a = z.string().array()")).toEqual([false])
    expect(probe('const a = text("x").array()')).toEqual([])
  })

  it("no request schema array is uncapped", () => {
    expect(findUncappedArrays()).toEqual([])
  })
})
