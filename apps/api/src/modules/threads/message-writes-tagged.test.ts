// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every write into kernel.messages names its requiredScopes. Since migration
// 0066 the column is NOT NULL with NO default, so an insert that omits it
// raises 23502 in the database: that is the enforcement. This guard is the
// SECOND line of defence, in front of it. It runs without a database, names
// the offending file and line, and catches a bad write at review time rather
// than at the first integration test that happens to exercise the path.
//
// It deliberately understands more than one spelling, because the first
// version only understood `.insert(<named import>)` and every other form of
// the same write walked past it: a namespace import, a lowercase or quoted
// raw INSERT, an explicit `requiredScopes: undefined` (which let the old
// column default apply), and an UPDATE that rewrites the body without
// re-tagging the row.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(import.meta.dir, "..", "..")

// Inserts that may leave the column out, each with its reason. Only a test
// that ASSERTS the database refusal belongs here: since 0066 the database
// refuses an untagged insert, so any other entry would describe a write that
// cannot succeed.
const EXEMPT: Record<string, string> = {
  "db/schema/kernel/messages-required-scopes.test.ts":
    "the negative control: it writes an untagged row on purpose and asserts the 23502 the column raises",
}

// Body-changing UPDATEs that deliberately keep the row's existing tag.
const EXEMPT_UPDATES: Record<string, string> = {
  "db/migrations/0076_threads_discoverable_messages_author_agent.test.ts":
    "the migration guard proving an orphaned agent-authored row stays writable after its agent is deleted: it rewrites the body to show the row is not hostage to the agent, and the tag it was written with is the point",
  "modules/threads/message.ts":
    "author (or thread admin) editing a message in place: the human retypes the body and the row keeps the tag it was written with, so the edit cannot widen who can read it",
  "modules/users/merge-placeholder.ts":
    "merging a placeholder user into the real one rewrites the mention token from the placeholder's id to the real user's id: the same person is mentioned, so the row keeps the tag it was written with",
  "modules/search/reindex.rebuild.integration.test.ts":
    "a live edit during the rebuild: the fixture row's text changes so the test can see which version the swapped-in index carries; the tag is not under test",
  "modules/search/message-indexer.integration.test.ts":
    "an edit of a fixture row, so the test can check the window quoting it is rebuilt with the new text; the tag is not under test",
}

// Both quoting styles, and the two modules that re-export the table.
const KERNEL_MODULE = String.raw`["']~/db/schema/kernel(?:/threads)?["']`
const STATIC_IMPORT = new RegExp(
  String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*${KERNEL_MODULE}`,
  "g",
)
const DYNAMIC_IMPORT = new RegExp(
  String.raw`\{([^}]*)\}\s*=\s*await\s+import\(\s*${KERNEL_MODULE}\s*\)`,
  "g",
)
const NAMESPACE_IMPORT = new RegExp(
  String.raw`import\s*\*\s*as\s*([A-Za-z_$][\w$]*)\s*from\s*${KERNEL_MODULE}`,
  "g",
)

// `kernel.messages`, `"kernel"."messages"`, `${kernelRel("messages")}`,
// `${kernelSchema}.messages` and `"${kernelSchema}".messages`, in any case.
const KERNEL_REL = String.raw`\$\{\s*kernelRel\(\s*["']messages["']\s*\)\s*\}`
const KERNEL_QUALIFIER = String.raw`(?:"kernel"|kernel|"?\$\{[^}]*[Kk]ernel[^}]*\}"?)`

/**
 * Local names holding the kernel schema in one file.
 *
 * The e2e scenarios run against a per-worker schema and hold it in a short
 * local (`ks = env.schemaPrefix ? ... : "kernel"`), so `${ks}.messages` is a
 * write into kernel.messages that no spelling above matches. The name itself
 * says nothing, so the binding is what we read: a local assigned from an
 * expression that mentions the kernel schema. `${MAIL}.messages` and
 * `${ts(env)}.messages` are OTHER tables and must keep walking past.
 */
export function kernelSchemaLocals(text: string): string[] {
  const names: string[] = []
  const re = /\b(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*([^\n]*)/g
  // COMMENTS FIRST. The heuristic reads the right hand side for the word
  // "kernel", and a trailing comment is part of no binding: `const MAIL =
  // mailSchema(env) // not the kernel one` bound MAIL to another app's schema
  // and the scanner then read every `${MAIL}.messages` in the file as a write
  // into kernel.messages.
  for (const m of stripComments(text).matchAll(re)) {
    if (/[Kk]ernel/.test(m[2])) names.push(m[1])
  }
  return Array.from(new Set(names))
}

/**
 * `//` and block comments removed, quotes respected.
 *
 * A `//` inside a string is not a comment (`"https://kernel.example"`), so the
 * cut point is found by walking the line rather than by a regex. Block
 * comments are recognised where one opens a line, or opens and closes on one.
 */
export function stripComments(text: string): string {
  const out: string[] = []
  let inBlock = false
  for (const line of text.split("\n")) {
    if (inBlock) {
      const end = line.indexOf("*/")
      if (end === -1) {
        out.push("")
        continue
      }
      inBlock = false
      out.push(stripLineComment(line.slice(end + 2)))
      continue
    }
    const trimmed = line.trimStart()
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlock = true
      out.push("")
      continue
    }
    out.push(stripLineComment(line.replace(/\/\*[^\n]*?\*\//g, "")))
  }
  return out.join("\n")
}

function stripLineComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === "\\") i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      continue
    }
    if (ch === "/" && line[i + 1] === "/") return line.slice(0, i)
  }
  return line
}

/** The insert and update matchers for one file, widened by its kernel locals. */
function rawMatchers(text: string): { insert: RegExp; update: RegExp } {
  const locals = kernelSchemaLocals(text).map((n) => n.replace(/[$]/g, String.raw`\$`))
  const interpolated = locals.length ? `|"?\\$\\{\\s*(?:${locals.join("|")})\\s*\\}"?` : ""
  const qualifier = `(?:${KERNEL_QUALIFIER.slice(3, -1)}${interpolated})`
  return {
    insert: new RegExp(
      String.raw`insert\s+into\s+(?:${KERNEL_REL}|${qualifier}\s*\.\s*"?messages"?\b)`,
      "gi",
    ),
    update: new RegExp(
      String.raw`update\s+(?:${KERNEL_REL}|${qualifier}\s*\.\s*"?messages"?\b)\s+set\b`,
      "gi",
    ),
  }
}

// This file quotes every bad spelling as a fixture string, so scanning it
// would report its own examples as real writes.
const SELF = "modules/threads/message-writes-tagged.test.ts"

/**
 * Every TypeScript file under src, tests included.
 *
 * Tests used to be skipped, and that is exactly where the untagged writes
 * were: an e2e fixture that plants thread history is as real a write as a
 * production one, it fails the same 23502 at run time, and it fails it in a
 * scenario whose own assertion is about something else entirely.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === "node_modules") continue
      out.push(...sourceFiles(path))
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(path)
    }
  }
  return out
}

/** Local names bound to the kernel `messages` table in a file. */
export function messageTableNames(text: string): string[] {
  const names: string[] = []
  for (const re of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
    for (const m of text.matchAll(re)) {
      for (const part of m[1].split(",")) {
        const [imported, local] = part.trim().split(/\s+as\s+|\s*:\s*/)
        if (imported === "messages") names.push(local ?? imported)
      }
    }
  }
  // `import * as k from "~/db/schema/kernel"` reaches the same table as `k.messages`.
  for (const m of text.matchAll(NAMESPACE_IMPORT)) {
    names.push(`${m[1]}.messages`)
  }
  return names
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
function namesTag(body: string, key: "requiredScopes" | "required_scopes"): boolean {
  if (key === "required_scopes") return /\brequired_scopes\b/.test(body)
  // `requiredScopes: undefined` reads as "not supplied": it used to let the
  // column default apply, and now it fails at the database instead.
  if (/\brequiredScopes\s*:\s*undefined\b/.test(body)) return false
  return /\brequiredScopes\b/.test(body)
}

export interface Site {
  file: string
  line: number
  tagged: boolean
  kind: "insert" | "update"
}

/** Every kernel.messages write in one source text, with whether it is tagged. */
export function scanSource(file: string, text: string): Site[] {
  const sites: Site[] = []
  for (const name of messageTableNames(text)) {
    const escaped = name.replace(/\./g, String.raw`\.`)
    for (const m of text.matchAll(new RegExp(String.raw`\.insert\(\s*${escaped}\s*\)`, "g"))) {
      const values = text.indexOf(".values(", m.index)
      const body = values < 0 ? "" : balanced(text, values + ".values".length)
      sites.push({
        file,
        line: lineOf(text, m.index),
        tagged: namesTag(body, "requiredScopes"),
        kind: "insert",
      })
    }
    // An UPDATE that rewrites the body must re-state the tag: the new text can
    // quote something the old tag does not cover.
    for (const m of text.matchAll(new RegExp(String.raw`\.update\(\s*${escaped}\s*\)`, "g"))) {
      const set = text.indexOf(".set(", m.index)
      if (set < 0) continue
      const body = balanced(text, set + ".set".length)
      if (!/\bcontent\b/.test(body)) continue
      sites.push({
        file,
        line: lineOf(text, m.index),
        tagged: namesTag(body, "requiredScopes"),
        kind: "update",
      })
    }
  }
  const raw = rawMatchers(text)
  for (const m of text.matchAll(raw.insert)) {
    // The column list opens AFTER the matched table reference, never inside it
    // (`kernelRel("messages")` carries parentheses of its own).
    const end = (m.index ?? 0) + m[0].length
    const open = text.indexOf("(", end)
    const columns = open < 0 ? "" : balanced(text, open)
    sites.push({
      file,
      line: lineOf(text, m.index ?? 0),
      tagged: namesTag(columns, "required_scopes"),
      kind: "insert",
    })
  }
  for (const m of text.matchAll(raw.update)) {
    const end = (m.index ?? 0) + m[0].length
    // Read to the end of the statement, whichever terminator comes first.
    const rest = text.slice(end, end + 400)
    if (!/\bcontent\s*=/.test(rest)) continue
    sites.push({
      file,
      line: lineOf(text, m.index ?? 0),
      tagged: namesTag(rest, "required_scopes"),
      kind: "update",
    })
  }
  return sites
}

function writeSites(): Site[] {
  const sites: Site[] = []
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path)
    if (file === SELF) continue
    sites.push(...scanSource(file, readFileSync(path, "utf8")))
  }
  return sites
}

describe("kernel.messages writes name their requiredScopes", () => {
  const sites = writeSites()

  it("the scan finds the known direct writes (the guard is not vacuous)", () => {
    const files = new Set(sites.map((s) => s.file))
    for (const known of [
      "modules/threads/message.ts",
      "modules/threads/thread.ts",
      "modules/agent/context/compaction.ts",
      "modules/mcp-client/resource-notifier.ts",
      "modules/agent/subruns/spawn-agent.ts",
      "modules/agent/subruns/subrun-worker.ts",
      "modules/imports/kernel-kinds/chat.ts",
    ]) {
      expect(files).toContain(known)
    }
  })

  it("every direct write outside the exempt list sets requiredScopes explicitly", () => {
    const untagged = sites
      .filter((s) => s.kind === "insert" && !s.tagged && !(s.file in EXEMPT))
      .map((s) => `${s.file}:${s.line}`)
    expect(untagged).toEqual([])
  })

  it("every body-changing UPDATE re-states the tag, or is exempt with a reason", () => {
    const untagged = sites
      .filter((s) => s.kind === "update" && !s.tagged && !(s.file in EXEMPT_UPDATES))
      .map((s) => `${s.file}:${s.line}`)
    expect(untagged).toEqual([])
  })

  it("every exempt file still exists and still writes, so the list cannot rot", () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(sites.some((s) => s.file === file && s.kind === "insert")).toBe(true)
    }
    for (const file of Object.keys(EXEMPT_UPDATES)) {
      expect(sites.some((s) => s.file === file && s.kind === "update")).toBe(true)
    }
  })
})

// Each case below is a real bypass the first version of this guard missed.
// They are exercised against the scanner directly, so the guard's own blind
// spots are falsifiable without planting a bad write in the tree.
describe("the scanner catches every spelling of an untagged write", () => {
  const NAMED = `import { messages } from "~/db/schema/kernel"\n`
  const NAMESPACE = `import * as k from "~/db/schema/kernel"\n`
  const SINGLE_QUOTED = `import { messages } from '~/db/schema/kernel'\n`

  const bypasses: Array<[string, string]> = [
    ["a namespace import", `${NAMESPACE}await db.insert(k.messages).values({ content: "x" })`],
    [
      "a single-quoted import specifier",
      `${SINGLE_QUOTED}await db.insert(messages).values({ content: "x" })`,
    ],
    [
      "an explicit requiredScopes: undefined",
      `${NAMED}await db.insert(messages).values({ content: "x", requiredScopes: undefined })`,
    ],
    ["a lowercase raw insert", `await sql\`insert into kernel.messages (content) values ('x')\``],
    [
      "a quoted schema and table",
      `await sql\`INSERT INTO "kernel"."messages" (content) VALUES ('x')\``,
    ],
    [
      "an interpolated kernel schema",
      "await sql.unsafe(`INSERT INTO ${kernelSchema}.messages (content) VALUES ($1)`)",
    ],
    [
      "a quoted interpolated kernel schema",
      'await sql.unsafe(`INSERT INTO "${kernelSchema}".messages (content) VALUES ($1)`)',
    ],
    [
      "a kernelRel helper",
      "await tx.execute(drizzleSql`INSERT INTO ${kernelRel(\"messages\")} (content) VALUES ('x')`)",
    ],
    [
      "an UPDATE that rewrites the body without re-tagging",
      `${NAMED}await tx.update(messages).set({ content, editedAt: new Date() })`,
    ],
    // The e2e blind spot: a per-worker kernel schema in a local whose NAME
    // says nothing. Three scenario fixtures wrote through this spelling and
    // the guard walked past every one of them.
    [
      "a per-worker kernel schema held in a local",
      'const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"\nawait sql.unsafe(`INSERT INTO ${ks}.messages (thread_id, content) VALUES ($1, $2)`)',
    ],
  ]

  for (const [label, source] of bypasses) {
    it(`flags ${label}`, () => {
      const sites = scanSource("some/file.ts", source)
      expect(sites.length).toBeGreaterThan(0)
      expect(sites.every((s) => !s.tagged)).toBe(true)
    })
  }

  it("accepts the same writes once they name the tag", () => {
    const tagged: string[] = [
      `${NAMESPACE}await db.insert(k.messages).values({ content: "x", requiredScopes: [] })`,
      `${SINGLE_QUOTED}await db.insert(messages).values({ content: "x", requiredScopes: scopes })`,
      "await sql`insert into kernel.messages (content, required_scopes) values ('x', '{}')`",
      `await sql\`INSERT INTO "kernel"."messages" (content, required_scopes) VALUES ('x', '{}')\``,
      `${NAMED}await tx.update(messages).set({ content, requiredScopes: scopes })`,
    ]
    for (const source of tagged) {
      const sites = scanSource("some/file.ts", source)
      expect(sites.length).toBeGreaterThan(0)
      expect(sites.every((s) => s.tagged)).toBe(true)
    }
  })

  it("leaves another app's messages table alone, however the schema is interpolated", () => {
    // `mail.messages` and `tickets.messages` are different tables with no
    // required_scopes column at all. A scanner that matched any interpolated
    // qualifier would report every mail fixture in the tree as an untagged
    // kernel write.
    const sources = [
      "const MAIL = mailSchema(env)\nawait sql.unsafe(`INSERT INTO ${MAIL}.messages (id, subject) VALUES ($1, $2)`)",
      "const T = ticketsSchema(env)\nawait sql.unsafe(`INSERT INTO ${T}.messages (id, ticket_id) VALUES ($1, $2)`)",
    ]
    for (const source of sources) expect(scanSource("f.ts", source)).toEqual([])
  })

  it("does not read a trailing comment as part of the binding", () => {
    // The heuristic asks what the right hand side mentions. A comment is not
    // the right hand side: this line binds MAIL to another app's schema and
    // says so in prose, and the write below it is into mail.messages, which
    // has no required_scopes column to tag.
    const source =
      "const MAIL = mailSchema(env) // not the kernel one\n" +
      "await sql.unsafe(`INSERT INTO ${MAIL}.messages (id, subject) VALUES ($1, $2)`)"
    expect(kernelSchemaLocals(source)).toEqual([])
    expect(scanSource("f.ts", source)).toEqual([])
  })

  it("still reads a URL containing // as code, not as a comment", () => {
    // The cut point respects quotes, so a binding whose value is a string with
    // a scheme in it is still read in full.
    const source =
      'const ks = schemaFor("https://kernel.example.test")\n' +
      "await sql.unsafe(`INSERT INTO ${ks}.messages (thread_id, content) VALUES ($1, $2)`)"
    expect(kernelSchemaLocals(source)).toEqual(["ks"])
    expect(scanSource("f.ts", source).length).toBe(1)
  })

  it("reads the column list after the table reference, not inside a helper call", () => {
    // `kernelRel("messages")` has parentheses of its own; a scanner that took
    // the first `(` after the match read `"messages"` as the column list and
    // called every such write untagged.
    const source =
      "await tx.execute(drizzleSql`INSERT INTO ${kernelRel(\"messages\")} (content, required_scopes) VALUES ('x', '{}')`)"
    expect(scanSource("f.ts", source)).toEqual([
      { file: "f.ts", line: 1, tagged: true, kind: "insert" },
    ])
  })

  it("ignores a metadata-only or soft-delete UPDATE, which cannot change what the row quotes", () => {
    const source = `${NAMED}await tx.update(messages).set({ metadata }).where(x)\nawait tx.update(messages).set({ deletedAt: new Date() }).where(y)`
    expect(scanSource("f.ts", source).filter((s) => s.kind === "update")).toEqual([])
  })
})
