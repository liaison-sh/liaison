// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Ratchet: no raw SQL in API source names the kernel schema literally.
//
// The bug class. Test lanes run each namespace under a prefixed schema
// (SCHEMA_PREFIX, e.g. `w3_kernel`). Drizzle tables and every query that
// resolves the schema through `schemaRef("kernel")` follow the prefix; a raw
// SQL string that says `FROM kernel.messages` reads the unprefixed schema
// instead, so a test sees another namespace's rows or none (an agent turn
// assembled with an empty history). Production runs unprefixed, so the bug
// only ever shows up as a test that lies.
//
// The rule: inside a SQL template literal (one whose text carries an upper-case
// SQL keyword), `kernel.<table>`
// is spelled `${K}.<table>` with K = sql.raw(schemaRef("kernel")) or an
// equivalent helper. Test files and migrations are out of scope: unit tests run
// unprefixed, and migrations create the real schema.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import ts from "typescript"

const SRC = resolve(import.meta.dir, "..")

/** Why the org transfer's own connection names the kernel schema literally. */
const TRANSFER_CONNECTION =
  "the org transfer's bundle export/import: SQL on its own migration-role connection (TransferSql, not the server pool) over the catalog of the real `kernel` and `app_*` schemas that closure.ts readCatalog reads by name; the relation names travel in the bundle to another instance, so they are the unprefixed ones by design. Its server-pool queries (after-commit.ts, purge.ts) go through schemaRef"

/**
 * Files skipped on purpose, each with its reason. Paths are relative to
 * apps/api/src; an entry ending in "/" covers a directory.
 */
const ALLOWLIST: Record<string, string> = {
  "modules/org/transfer/export.ts": TRANSFER_CONNECTION,
  "modules/org/transfer/import.ts": TRANSFER_CONNECTION,
  "modules/org/transfer/custom-apps.ts": TRANSFER_CONNECTION,
}

/**
 * A literal schema-qualified kernel relation or function: `kernel.users`,
 * `"kernel".users`, `kernel.can_manage_sharing(`, `'kernel.agents'::regclass`.
 * Not matched: a prefixed `"${prefix}kernel"`, a quoted value such as the
 * resource type `'kernel.contact'`, and i18n keys such as `kernel.auth.${key}`,
 * `kernel.demo.refusal.${code}` or `kernel.mcpUi.${key}` (never relations).
 * A column qualified as `kernel.table.column` still matches.
 */
const KERNEL_LITERAL =
  /(?<![A-Za-z0-9_$."}])('?)"?kernel"?\.([a-z_][a-z0-9_]*)(?![A-Za-z0-9_$]|\.\$\{|\.[a-z_]+\.)('::regclass)?/g

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "migrations") continue
      listSourceFiles(full, out)
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full)
    }
  }
  return out
}

function isAllowlisted(rel: string): boolean {
  return Object.keys(ALLOWLIST).some((key) =>
    key.endsWith("/") ? rel.startsWith(key) : rel === key,
  )
}

/** A template is SQL when its literal text carries an upper-case SQL keyword. */
const SQL_KEYWORD =
  /\b(SELECT|INSERT|UPDATE|DELETE|FROM|JOIN|WHERE|CREATE|DROP|ALTER|TRUNCATE|REFERENCES|POLICY)\b/

/** The literal pieces of a template: the whole literal, or its head and span texts. */
function templateParts(node: ts.TemplateLiteral): ts.Node[] {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [node]
  return [node.head, ...node.templateSpans.map((span) => span.literal)]
}

/** Every `file:line: kernel.<table>` found inside a SQL template literal. */
function findKernelLiterals(file: string, rel: string): string[] {
  const text = readFileSync(file, "utf8")
  if (!text.includes("kernel")) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      const parts = templateParts(node)
      const isSql = parts.some((part) => SQL_KEYWORD.test(part.getText(source)))
      for (const part of isSql ? parts : []) {
        const raw = part.getText(source)
        for (const match of raw.matchAll(KERNEL_LITERAL)) {
          // A single-quoted 'kernel.x' is a SQL string value unless it is cast to a relation.
          if (match[1] === "'" && !match[3]) continue
          const offset = part.getStart(source) + (match.index ?? 0)
          const line = source.getLineAndCharacterOfPosition(offset).line + 1
          hits.push(`${rel}:${line}: ${match[0]}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return hits
}

describe("raw SQL resolves the kernel schema through schemaRef", () => {
  const files = listSourceFiles(SRC)
  const scanned = files.map((file) => ({ file, rel: relative(SRC, file) }))

  it("scans the API source", () => {
    expect(scanned.length).toBeGreaterThan(500)
  })

  it("no template literal names kernel.<table> outside the allowlist", () => {
    const hits = scanned
      .filter(({ rel }) => !isAllowlisted(rel))
      .flatMap(({ file, rel }) => findKernelLiterals(file, rel))
    expect(hits).toEqual([])
  })

  it("every allowlisted file still exists and still holds a literal", () => {
    // Directory entries may cover a module that has not landed yet.
    const stale = Object.keys(ALLOWLIST).filter((key) => {
      if (key.endsWith("/")) return false
      const match = scanned.find(({ rel }) => rel === key)
      return !match || findKernelLiterals(match.file, match.rel).length === 0
    })
    expect(stale).toEqual([])
  })
})
