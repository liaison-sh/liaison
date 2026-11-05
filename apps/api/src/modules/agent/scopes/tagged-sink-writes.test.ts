// SPDX-License-Identifier: FSL-1.1-ALv2
//
// There are three scope-tagged sinks (modules/agent/scopes/scope-taint.ts):
// `kernel.messages`, `kernel.agent_memory` and `app_knowledge.documents`.
// `modules/threads/message-writes-tagged.test.ts` guards the first. This guards
// the other two, in the same bypass spellings, because nothing did.
//
// Since migration 0065 both columns are NOT NULL with no default, so the
// database itself rejects an INSERT that omits the tag. It does NOT reject an
// UPDATE that rewrites the row's CONTENT without unioning the writing turn's
// scopes: the row keeps a tag that no longer describes what it now quotes, and
// every later reader judges the new text by the old tag. A new
// `UPDATE ${knowledgeRel("documents")} SET body = ...` that skips
// `unionRequiredScopesSql` is exactly that hole, and it is silently undetected
// without this scan.
//
// The scan runs without a database, names the offending file and line, and
// catches a bad write at review time rather than at whichever integration test
// happens to exercise the path.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(import.meta.dir, "..", "..", "..")

// Content-rewriting UPDATEs that deliberately keep the row's existing tag.
const EXEMPT_UPDATES: Record<string, string> = {
  "apps/knowledge/sync-reconciler.ts":
    "an external source refresh rewrites title and body from upstream and deliberately leaves required_scopes alone: the reconciler runs outside any turn, so there is no taint to add, and a refresh must never narrow the tag the document already carries",
}

// UPDATEs whose whole SET clause is one interpolated fragment, so the columns
// cannot be read from the source text. Each needs a reason naming what unions
// the tag, since the scan cannot see it.
const EXEMPT_OPAQUE_UPDATES: Record<string, string> = {
  "apps/knowledge/service.ts":
    "updateKnowledgeDocument builds its SET from a fragment array whose last entry is always unionRequiredScopesSql(requiredScopes), so an update unions the writing turn's scopes and never narrows",
}

/** `kernel.agent_memory`, `"kernel"."agent_memory"`, `${kernelRel("agent_memory")}`. */
const MEMORY_REL = String.raw`(?:\$\{\s*kernelRel\(\s*["']agent_memory["']\s*\)\s*\}|(?:"kernel"|kernel|"?\$\{[^}]*[Kk]ernel[^}]*\}"?)\s*\.\s*"?agent_memory"?)`
/** `app_knowledge.documents`, `"app_knowledge"."documents"`, `${knowledgeRel("documents")}`. */
const DOCUMENTS_REL = String.raw`(?:\$\{\s*knowledgeRel\(\s*["']documents["']\s*\)\s*\}|(?:"app_knowledge"|app_knowledge|"?\$\{[^}]*[Kk]nowledge[^}]*\}"?)\s*\.\s*"?documents"?)`

// The kernel schema modules that re-export the agent_memory table.
const MEMORY_MODULE = String.raw`["']~/db/schema/kernel(?:/agent-memory)?["']`

interface SinkSpec {
  sink: string
  rel: string
  /** Raw-SQL content columns: a write touching one of these changes what the row quotes. */
  rawContent: RegExp
  /**
   * Drizzle content properties, same meaning. Must match the ES SHORTHAND form
   * (`set({ content, updatedAt })`) as well as `content: x`: shorthand is how
   * both real upsert branches in memory.ts are written, and a colon-only
   * pattern walks straight past them.
   */
  propContent: RegExp
  /** The Drizzle table export, when the sink has one. */
  table?: { name: string; module: string }
}

const MEMORY: SinkSpec = {
  sink: "kernel.agent_memory",
  rel: MEMORY_REL,
  rawContent: /\b(?:content|description)\s*=/i,
  propContent: /[{,\s](?:content|description)\s*[:,}]/,
  table: { name: "agentMemory", module: MEMORY_MODULE },
}

const DOCUMENTS: SinkSpec = {
  sink: "app_knowledge.documents",
  rel: DOCUMENTS_REL,
  rawContent: /\b(?:body|title|summary)\s*=/i,
  propContent: /[{,\s](?:body|title|summary)\s*[:,}]/,
}

const SINKS = [MEMORY, DOCUMENTS]

export interface Site {
  file: string
  line: number
  sink: string
  tagged: boolean
  kind: "insert" | "update"
  /** The SET clause is a single interpolated fragment: the columns are unreadable. */
  opaque?: boolean
}

/** The text of the balanced parenthesised group opening at `open`. */
function balanced(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length
}

/** A tag is named only when it is actually given a value. */
function namesRawTag(body: string): boolean {
  return /\brequired_scopes\b/.test(body)
}

function namesPropTag(body: string): boolean {
  // `requiredScopes: undefined` reads as "not supplied": it used to let the
  // column default apply, and now it fails at the database instead.
  if (/\brequiredScopes\s*:\s*undefined\b/.test(body)) return false
  return /\brequiredScopes\b/.test(body)
}

/** Local names bound to a kernel schema table in a file, including `ns.table`. */
export function tableNames(text: string, exported: string, module: string): string[] {
  const names: string[] = []
  const STATIC = new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${module}`, "g")
  const DYNAMIC = new RegExp(String.raw`\{([^}]*)\}\s*=\s*await\s+import\(\s*${module}\s*\)`, "g")
  const NAMESPACE = new RegExp(
    String.raw`import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*${module}`,
    "g",
  )
  for (const re of [STATIC, DYNAMIC]) {
    for (const m of text.matchAll(re)) {
      for (const part of m[1].split(",")) {
        const [imported, local] = part.trim().split(/\s+as\s+|\s*:\s*/)
        if (imported === exported) names.push(local ?? imported)
      }
    }
  }
  for (const m of text.matchAll(NAMESPACE)) names.push(`${m[1]}.${exported}`)
  return names
}

/** Every write to one tagged sink in one source text, with whether it is tagged. */
function scanSink(file: string, text: string, spec: SinkSpec): Site[] {
  const sites: Site[] = []

  // --- Drizzle query-builder writes -------------------------------------
  if (spec.table) {
    for (const name of tableNames(text, spec.table.name, spec.table.module)) {
      const escaped = name.replace(/\./g, String.raw`\.`)
      for (const m of text.matchAll(new RegExp(String.raw`\.insert\(\s*${escaped}\s*\)`, "g"))) {
        const values = text.indexOf(".values(", m.index)
        const body = values < 0 ? "" : balanced(text, values + ".values".length)
        sites.push({
          file,
          line: lineOf(text, m.index ?? 0),
          sink: spec.sink,
          tagged: namesPropTag(body),
          kind: "insert",
        })
        // An upsert's conflict branch rewrites the EXISTING row: it is an
        // update wearing an insert's clothes, and it must re-state the tag.
        const conflict = text.indexOf(".onConflictDoUpdate(", m.index)
        const nextInsert = text.indexOf(".insert(", (m.index ?? 0) + 1)
        if (conflict > 0 && (nextInsert < 0 || conflict < nextInsert)) {
          const conflictBody = balanced(text, conflict + ".onConflictDoUpdate".length)
          if (spec.propContent.test(conflictBody)) {
            sites.push({
              file,
              line: lineOf(text, conflict),
              sink: spec.sink,
              tagged: namesPropTag(conflictBody),
              kind: "update",
            })
          }
        }
      }
      for (const m of text.matchAll(new RegExp(String.raw`\.update\(\s*${escaped}\s*\)`, "g"))) {
        const set = text.indexOf(".set(", m.index)
        if (set < 0) continue
        const body = balanced(text, set + ".set".length)
        if (!spec.propContent.test(body)) continue
        sites.push({
          file,
          line: lineOf(text, m.index ?? 0),
          sink: spec.sink,
          tagged: namesPropTag(body),
          kind: "update",
        })
      }
    }
  }

  // --- Raw SQL writes ----------------------------------------------------
  const RAW_INSERT = new RegExp(String.raw`insert\s+into\s+${spec.rel}`, "gi")
  // An optional table alias may sit between the relation and SET.
  const RAW_UPDATE = new RegExp(
    String.raw`update\s+${spec.rel}(?:\s+(?:as\s+)?(?!set\b)[A-Za-z_]\w*)?\s+set\b`,
    "gi",
  )
  for (const m of text.matchAll(RAW_INSERT)) {
    // The column list opens AFTER the matched table reference, never inside it
    // (`knowledgeRel("documents")` carries parentheses of its own).
    const end = (m.index ?? 0) + m[0].length
    const open = text.indexOf("(", end)
    const columns = open < 0 ? "" : balanced(text, open)
    sites.push({
      file,
      line: lineOf(text, m.index ?? 0),
      sink: spec.sink,
      tagged: namesRawTag(columns),
      kind: "insert",
    })
  }
  for (const m of text.matchAll(RAW_UPDATE)) {
    const end = (m.index ?? 0) + m[0].length
    const rest = text.slice(end, end + 400)
    // A SET clause that IS one interpolated fragment hides its own columns.
    if (/^\s*\$\{/.test(rest)) {
      sites.push({
        file,
        line: lineOf(text, m.index ?? 0),
        sink: spec.sink,
        tagged: namesRawTag(rest),
        kind: "update",
        opaque: true,
      })
      continue
    }
    if (!spec.rawContent.test(rest)) continue
    sites.push({
      file,
      line: lineOf(text, m.index ?? 0),
      sink: spec.sink,
      tagged: namesRawTag(rest),
      kind: "update",
    })
  }
  return sites
}

/** Every tagged-sink write in one source text. */
export function scanSource(file: string, text: string): Site[] {
  return SINKS.flatMap((spec) => scanSink(file, text, spec))
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === "node_modules" || name === "tests") continue
      out.push(...sourceFiles(path))
    } else if (
      name.endsWith(".ts") &&
      !name.includes(".test.") &&
      !name.includes("test-fixtures")
    ) {
      out.push(path)
    }
  }
  return out
}

function writeSites(): Site[] {
  const sites: Site[] = []
  for (const path of sourceFiles(SRC)) {
    sites.push(...scanSource(relative(SRC, path), readFileSync(path, "utf8")))
  }
  return sites
}

describe("agent_memory and knowledge document writes name their requiredScopes", () => {
  const sites = writeSites()

  it("the scan finds the known direct writes (the guard is not vacuous)", () => {
    const files = new Set(sites.map((s) => s.file))
    for (const known of [
      "modules/agent/memory/memory.ts",
      "apps/knowledge/service.ts",
      "apps/knowledge/sync-reconciler.ts",
    ]) {
      expect(files).toContain(known)
    }
    // Both sinks are actually reached, so neither half can rot into a no-op.
    expect(new Set(sites.map((s) => s.sink))).toEqual(
      new Set(["kernel.agent_memory", "app_knowledge.documents"]),
    )
    expect(sites.some((s) => s.kind === "insert")).toBe(true)
    expect(sites.some((s) => s.kind === "update")).toBe(true)
  })

  it("every insert names the tag: the column is NOT NULL with no default since 0065", () => {
    const untagged = sites
      .filter((s) => s.kind === "insert" && !s.tagged)
      .map((s) => `${s.sink} ${s.file}:${s.line}`)
    expect(untagged).toEqual([])
  })

  it("every content-changing UPDATE unions the tag, or is exempt with a reason", () => {
    const untagged = sites
      .filter((s) => s.kind === "update" && !s.opaque && !s.tagged && !(s.file in EXEMPT_UPDATES))
      .map((s) => `${s.sink} ${s.file}:${s.line}`)
    expect(untagged).toEqual([])
  })

  it("every UPDATE whose SET is one opaque fragment is exempt with a reason", () => {
    const unexplained = sites
      .filter((s) => s.opaque && !s.tagged && !(s.file in EXEMPT_OPAQUE_UPDATES))
      .map((s) => `${s.sink} ${s.file}:${s.line}`)
    expect(unexplained).toEqual([])
  })

  it("every exempt file still exists and still writes, so the lists cannot rot", () => {
    for (const file of Object.keys(EXEMPT_UPDATES)) {
      expect(sites.some((s) => s.file === file && s.kind === "update")).toBe(true)
    }
    for (const file of Object.keys(EXEMPT_OPAQUE_UPDATES)) {
      expect(sites.some((s) => s.file === file && s.opaque)).toBe(true)
    }
  })
})

// Each case below is a bypass the message guard already understands for
// kernel.messages and that nothing understood for these two sinks. They are
// exercised against the scanner directly, so the guard's own blind spots are
// falsifiable without planting a bad write in the tree.
describe("the scanner catches every spelling of an untagged agent_memory write", () => {
  const NAMED = `import { agentMemory } from "~/db/schema/kernel"\n`
  const NAMESPACE = `import * as k from "~/db/schema/kernel"\n`
  const SINGLE_QUOTED = `import { agentMemory } from '~/db/schema/kernel'\n`

  const bypasses: Array<[string, string]> = [
    ["a namespace import", `${NAMESPACE}await db.insert(k.agentMemory).values({ content: "x" })`],
    [
      "a single-quoted import specifier",
      `${SINGLE_QUOTED}await db.insert(agentMemory).values({ content: "x" })`,
    ],
    [
      "an explicit requiredScopes: undefined",
      `${NAMED}await db.insert(agentMemory).values({ content: "x", requiredScopes: undefined })`,
    ],
    ["a lowercase raw insert", "await sql`insert into kernel.agent_memory (content) values ('x')`"],
    [
      "a quoted schema and table",
      `await sql\`INSERT INTO "kernel"."agent_memory" (content) VALUES ('x')\``,
    ],
    [
      "an interpolated kernel schema",
      "await sql.unsafe(`INSERT INTO ${kernelSchema}.agent_memory (content) VALUES ($1)`)",
    ],
    [
      "a kernelRel helper",
      "await tx.execute(drizzleSql`INSERT INTO ${kernelRel(\"agent_memory\")} (content) VALUES ('x')`)",
    ],
    [
      "an UPDATE that rewrites the content without re-tagging",
      `${NAMED}await tx.update(agentMemory).set({ content, updatedAt: new Date() })`,
    ],
    [
      "an upsert whose conflict branch rewrites the content without re-tagging",
      `${NAMED}await db.insert(agentMemory).values({ content, requiredScopes: s }).onConflictDoUpdate({ target: [agentMemory.name], set: { content, updatedAt: new Date() } })`,
    ],
    [
      "a raw UPDATE that rewrites the content without re-tagging",
      "await sql`UPDATE kernel.agent_memory SET content = 'x' WHERE id = $1`",
    ],
  ]

  for (const [label, source] of bypasses) {
    it(`flags ${label}`, () => {
      const sites = scanSource("some/file.ts", source).filter(
        (s) => s.sink === "kernel.agent_memory",
      )
      expect(sites.length).toBeGreaterThan(0)
      expect(sites.some((s) => !s.tagged)).toBe(true)
    })
  }

  it("accepts the same writes once they name the tag", () => {
    const tagged: string[] = [
      `${NAMESPACE}await db.insert(k.agentMemory).values({ content: "x", requiredScopes: [] })`,
      `${SINGLE_QUOTED}await db.insert(agentMemory).values({ content: "x", requiredScopes: s })`,
      "await sql`insert into kernel.agent_memory (content, required_scopes) values ('x', '{}')`",
      `${NAMED}await tx.update(agentMemory).set({ content, requiredScopes: unionRequiredScopesSql(s) })`,
      "await sql`UPDATE kernel.agent_memory SET content = 'x', required_scopes = '{}' WHERE id = $1`",
    ]
    for (const source of tagged) {
      const sites = scanSource("some/file.ts", source).filter(
        (s) => s.sink === "kernel.agent_memory",
      )
      expect(sites.length).toBeGreaterThan(0)
      expect(sites.every((s) => s.tagged)).toBe(true)
    }
  })

  it("ignores an UPDATE that changes no content, which cannot change what the row quotes", () => {
    const source = `${NAMED}await tx.update(agentMemory).set({ updatedAt: new Date() }).where(x)`
    expect(scanSource("f.ts", source).filter((s) => s.kind === "update")).toEqual([])
  })
})

describe("the scanner catches every spelling of an untagged knowledge document write", () => {
  const bypasses: Array<[string, string]> = [
    [
      "a knowledgeRel insert",
      "await tx.execute(drizzleSql`INSERT INTO ${knowledgeRel(\"documents\")} (title, body) VALUES ('a', 'b')`)",
    ],
    [
      "a lowercase raw insert",
      "await sql`insert into app_knowledge.documents (title, body) values ('a', 'b')`",
    ],
    [
      "a quoted schema and table",
      `await sql\`INSERT INTO "app_knowledge"."documents" (title, body) VALUES ('a', 'b')\``,
    ],
    [
      "an interpolated knowledge schema",
      "await sql.unsafe(`INSERT INTO ${knowledgeSchema}.documents (title, body) VALUES ($1, $2)`)",
    ],
    [
      "an UPDATE that rewrites the body without unioning the tag",
      'await tx.execute(drizzleSql`UPDATE ${knowledgeRel("documents")} SET body = ${body}, updated_at = now() WHERE id = ${id}`)',
    ],
    [
      "an UPDATE through a table alias that rewrites the body",
      'await tx.execute(drizzleSql`UPDATE ${knowledgeRel("documents")} d SET body = ${body} WHERE d.id = ${id}`)',
    ],
    [
      "a lowercase raw UPDATE that rewrites the title",
      "await sql`update app_knowledge.documents set title = 'x' where id = $1`",
    ],
  ]

  for (const [label, source] of bypasses) {
    it(`flags ${label}`, () => {
      const sites = scanSource("some/file.ts", source).filter(
        (s) => s.sink === "app_knowledge.documents",
      )
      expect(sites.length).toBeGreaterThan(0)
      expect(sites.some((s) => !s.tagged && !s.opaque)).toBe(true)
    })
  }

  it("accepts the same writes once they name the tag", () => {
    const tagged: string[] = [
      "await tx.execute(drizzleSql`INSERT INTO ${knowledgeRel(\"documents\")} (title, body, required_scopes) VALUES ('a', 'b', '{}')`)",
      "await sql`insert into app_knowledge.documents (title, body, required_scopes) values ('a', 'b', '{}')`",
      'await tx.execute(drizzleSql`UPDATE ${knowledgeRel("documents")} SET body = ${body}, required_scopes = ${union} WHERE id = ${id}`)',
    ]
    for (const source of tagged) {
      const sites = scanSource("some/file.ts", source).filter(
        (s) => s.sink === "app_knowledge.documents",
      )
      expect(sites.length).toBeGreaterThan(0)
      expect(sites.every((s) => s.tagged)).toBe(true)
    }
  })

  it("reads the column list after the table reference, not inside the helper call", () => {
    // `knowledgeRel("documents")` has parentheses of its own; a scanner that
    // took the first `(` after the match read `"documents"` as the column list
    // and called every such write untagged.
    const source =
      "await tx.execute(drizzleSql`INSERT INTO ${knowledgeRel(\"documents\")} (title, required_scopes) VALUES ('a', '{}')`)"
    expect(scanSource("f.ts", source)).toEqual([
      {
        file: "f.ts",
        line: 1,
        sink: "app_knowledge.documents",
        tagged: true,
        kind: "insert",
      },
    ])
  })

  it("ignores an archive or sharing UPDATE, which changes no content", () => {
    const source =
      'await tx.execute(drizzleSql`UPDATE ${knowledgeRel("documents")} SET archived_at = now(), updated_at = now() WHERE id = ${id}`)'
    expect(scanSource("f.ts", source).filter((s) => s.kind === "update")).toEqual([])
  })

  it("reports an opaque fragment SET separately, so it cannot pass as a clean read", () => {
    const source =
      'await tx.execute(drizzleSql`UPDATE ${knowledgeRel("documents")} SET ${setSql} WHERE id = ${id}`)'
    const sites = scanSource("f.ts", source)
    expect(sites.map((s) => ({ kind: s.kind, opaque: s.opaque }))).toEqual([
      { kind: "update", opaque: true },
    ])
  })
})
