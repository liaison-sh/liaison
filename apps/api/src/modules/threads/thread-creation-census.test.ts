// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T18: prove no code path creates an ephemeral or hidden agent
// conversation, now and in CI.
//
// This walks every non-test source file under apps/api/src and finds every
// site that inserts a `threads` row, in either shape production code uses:
// a raw Drizzle `.insert(threads)` call (the table import may be aliased,
// e.g. `threads as kernelThreads`; the "bites" fixture proves it) or a call to the named
// helper `insertThreadWithParticipants` (thread.ts), which wraps the one raw
// insert every plain/DM/channel thread funnels through. Every site found
// must be on the allowlist below, keyed by file + enclosing function; an
// unlisted site is a standing failure, not a warning — that is what makes a
// fixture drop in this test's own try/finally prove the census bites.
//
// Independently, every allowlisted site's literal `.values(...)` (or,
// for the helper, its call-argument object) is inspected: none may combine
// `type: "agent_chat"` with `hiddenFromList: true` while seating an agent
// participant. That combination is exactly an ephemeral, hidden agent
// conversation — the thing this census exists to make impossible to add
// silently.

import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"

const SRC = resolve(import.meta.dir, "../..")

/** File (relative to apps/api/src) + enclosing function name allowed to insert a `threads` row. */
interface AllowlistEntry {
  file: string
  function: string
  note: string
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    file: "modules/threads/thread.ts",
    function: "insertThreadWithParticipants",
    note:
      "The one raw insert every plain thread, channel and agent DM funnels through " +
      "(createThread -> insertThreadWithParticipants), reached via POST /threads, " +
      "POST /threads/dm (createOrGetAgentDm) and group DMs.",
  },
  {
    file: "modules/agent/routines/routine-worker.ts",
    function: "ensureOutputThread",
    note: "The routine output-thread anchor, created once per routine and reused on every tick.",
  },
  {
    file: "modules/agent/subruns/subrun-thread.ts",
    function: "insertSubrunThread",
    note:
      "The hidden sub-run anchor thread (type: 'subrun', hiddenFromList: true) a spawned " +
      "agent's own turns write into; it seats no human DM partner and is never surfaced as a chat. " +
      "Called by spawnAgent (spawn-agent.ts) and by the seed engine's sub run history " +
      "(seed/factories/agent/sub-runs.ts), so a seeded sub run has the spawn's exact thread shape.",
  },
  {
    file: "modules/mcp/connection-thread.ts",
    function: "ensureConnectionThread",
    note:
      "Lazily provisions the single approval anchor for a gated MCP connection " +
      "(type: 'approval', hiddenFromList, one human participant, no agent seat). Not in the " +
      "P4c-T01 read-only census's Table 1 (6 rows) -- found by this walk, not by grep.",
  },
  {
    file: "modules/apps/bulk-dispatch.ts",
    function: "defaultEnsureOriginThread",
    note:
      "Groups a bulk tool-dispatch run's per-item results under one thread (type: 'thread', " +
      "the requesting human only, no agent seat), then hides it from the sidebar list -- a " +
      "private bucket, not an agent_chat, so it cannot be the ephemeral-agent-conversation " +
      "pattern this census exists to catch. Not in Table 1.",
  },
  {
    file: "modules/apps/execute-tool.ts",
    function: "createHandlerApprovalRequest",
    note:
      "A threadless gated handler call (no conversation to attach to) auto-creates its own " +
      "approval anchor (type: 'approval', hiddenFromList, the requester only, no agent seat) " +
      "so approval_requests.thread_id has somewhere to point. Never shown in a sidebar. " +
      "Not in Table 1.",
  },
  {
    file: "modules/apps/execute-tool.ts",
    function: "ensureApprovalThreadId",
    note:
      "Same fallback as createHandlerApprovalRequest for a threadless gated TOOL call (as " +
      "opposed to a handler call): type 'approval', hiddenFromList, requester only, no agent " +
      "seat, created lazily only from the arm that actually inserts the approval request. " +
      "Not in Table 1.",
  },
  {
    file: "modules/apps/rest-tool-call.ts",
    function: "restrictedSessionThread",
    note:
      "The anchor a restricted session's REST tool calls hang off, one per sign-in and kept " +
      "across a refresh: its approvals point at it and its reads mark it for outside-text " +
      "taint, as an MCP connection's thread does (type: 'approval', hiddenFromList, the signed " +
      "in person only, no agent seat). Never shown in a sidebar.",
  },
]

function allowlistKey(entry: { file: string; function: string }): string {
  return `${entry.file}::${entry.function}`
}

const ALLOWLIST_KEYS = new Set(ALLOWLIST.map(allowlistKey))

/** Directories under apps/api/src excluded from the walk entirely. */
const EXCLUDED_DIRS = new Set(["node_modules", "tests"])

function isTestFile(name: string): boolean {
  return /\.test\.ts$/.test(name) || /\.integration\.test\.ts$/.test(name)
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // The one directory-based exclusion beyond `tests/`: the top-level
    // `tests/helpers` dir holds test-factory functions (5 allowlisted-by-
    // convention insert sites in factories.ts) that are never reached from
    // any HTTP route or job; excluding the whole `tests/` dir above already
    // covers it, this guard just documents the reason.
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      out.push(...sourceFiles(join(dir, entry.name)))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (isTestFile(entry.name)) continue
    out.push(join(dir, entry.name))
  }
  return out
}

/** Local names bound (directly or via alias) to the `threads` table export of `~/db/schema/kernel`. */
function threadsLocalNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const spec = stmt.moduleSpecifier
    if (!ts.isStringLiteral(spec)) continue
    if (spec.text !== "~/db/schema/kernel" && spec.text !== "~/db/schema/kernel/threads") continue
    const clause = stmt.importClause
    const named = clause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text
      if (imported === "threads") names.add(el.name.text)
    }
  }
  return names
}

/** Names bound to `insertThreadWithParticipants` (whatever alias, if any). */
function helperLocalNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const clause = stmt.importClause
    const named = clause?.namedBindings
    if (!named || !ts.isNamedImports(named)) continue
    for (const el of named.elements) {
      const imported = (el.propertyName ?? el.name).text
      if (imported === "insertThreadWithParticipants") names.add(el.name.text)
    }
  }
  // The defining file itself calls its own function unqualified.
  names.add("insertThreadWithParticipants")
  return names
}

/** Walk up to the nearest enclosing named function/method/arrow-assigned-to-const, for reporting. */
function enclosingFunctionName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p)) && p.name) return p.name.text
    if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text
    if (
      ts.isArrowFunction(p) &&
      ts.isVariableDeclaration(p.parent) &&
      ts.isIdentifier(p.parent.name)
    ) {
      return p.parent.name.text
    }
    // `threads.post("/path", ..., async (c) => {...})` route handlers have no
    // named function; identify them by the route literal instead.
    if (
      ts.isCallExpression(p) &&
      ts.isPropertyAccessExpression(p.expression) &&
      (p.expression.name.text === "post" || p.expression.name.text === "get") &&
      p.arguments.length > 0 &&
      ts.isStringLiteral(p.arguments[0])
    ) {
      return `${p.expression.name.text.toUpperCase()} ${p.arguments[0].text} (route handler)`
    }
  }
  return "<module scope>"
}

/** Pull literal `type` / `hiddenFromList` props (if statically literal) out of an object literal. */
function literalProps(obj: ts.ObjectLiteralExpression): {
  type?: string
  hiddenFromList?: boolean
} {
  const out: { type?: string; hiddenFromList?: boolean } = {}
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue
    if (prop.name.text === "type" && ts.isStringLiteral(prop.initializer)) {
      out.type = prop.initializer.text
    }
    if (prop.name.text === "hiddenFromList") {
      if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) out.hiddenFromList = true
      if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) out.hiddenFromList = false
    }
  }
  return out
}

interface FoundSite {
  file: string
  function: string
  line: number
  kind: "raw-insert" | "helper-call"
  dangerousCombo: boolean
}

function walkFile(file: string, rel: string): FoundSite[] {
  const text = readFileSync(file, "utf8")
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const rawNames = threadsLocalNames(sf)
  const helperNames = helperLocalNames(sf)
  const found: FoundSite[] = []

  const visit = (node: ts.Node): void => {
    // Raw `.insert(<threadsAlias>)` call, in any layout (the arg may sit on
    // its own line — this matches the AST node, not source text, so line
    // breaks inside the parens never matter).
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "insert" &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]) &&
      rawNames.has(node.arguments[0].text)
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      // Scan the whole enclosing statement's descendants for a `.values(...)`
      // call chained off this insert, and inspect its first object-literal
      // arg for the dangerous type/hiddenFromList combo.
      let dangerousCombo = false
      let stmt: ts.Node = node
      while (
        stmt.parent &&
        !ts.isExpressionStatement(stmt.parent) &&
        !ts.isVariableStatement(stmt.parent)
      ) {
        stmt = stmt.parent
      }
      const scanForValues = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === "values" &&
          n.arguments.length > 0 &&
          ts.isObjectLiteralExpression(n.arguments[0])
        ) {
          const { type, hiddenFromList } = literalProps(
            n.arguments[0] as ts.ObjectLiteralExpression,
          )
          if (type === "agent_chat" && hiddenFromList === true) dangerousCombo = true
        }
        ts.forEachChild(n, scanForValues)
      }
      scanForValues(stmt)
      found.push({
        file: rel,
        function: enclosingFunctionName(node),
        line,
        kind: "raw-insert",
        dangerousCombo,
      })
    }

    // `insertThreadWithParticipants(tx, { ... })` helper call, from OUTSIDE
    // the file that defines it. `createThread` (same file) calling it is
    // internal plumbing on the path to the SAME raw-insert site already
    // recorded above — counting it separately would double the one anchor
    // thread.ts:264 actually is.
    if (
      rel !== "modules/threads/thread.ts" &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      helperNames.has(node.expression.text) &&
      // Exclude the function's own declaration header.
      !(ts.isFunctionDeclaration(node.parent) || ts.isFunctionDeclaration(node))
    ) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      let dangerousCombo = false
      const argObj = node.arguments.find((a) => ts.isObjectLiteralExpression(a)) as
        | ts.ObjectLiteralExpression
        | undefined
      if (argObj) {
        const { type, hiddenFromList } = literalProps(argObj)
        if (type === "agent_chat" && hiddenFromList === true) dangerousCombo = true
      }
      found.push({
        file: rel,
        function: enclosingFunctionName(node),
        line,
        kind: "helper-call",
        dangerousCombo,
      })
    }

    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function census(): FoundSite[] {
  const sites: FoundSite[] = []
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file)
    sites.push(...walkFile(file, rel))
  }
  return sites
}

describe("thread creation census: every threads insert is an accounted-for anchor", () => {
  it("every found insert/helper-call site is on the allowlist (file + function)", () => {
    const sites = census()
    expect(sites.length).toBeGreaterThan(0)
    const unlisted = sites.filter((s) => !ALLOWLIST_KEYS.has(allowlistKey(s)))
    expect(unlisted.map((s) => `${s.file}:${s.line} in ${s.function} (${s.kind})`)).toEqual([])
  })

  it("no allowlisted site combines type: 'agent_chat' with hiddenFromList: true", () => {
    const sites = census()
    const dangerous = sites.filter((s) => s.dangerousCombo)
    expect(dangerous.map((s) => `${s.file}:${s.line} in ${s.function}`)).toEqual([])
  })

  it("bites: an unlisted insert(threads) site under apps/api/src fails the census", () => {
    const fixtureRel = "modules/threads/__census_fixture_offender.ts"
    const fixturePath = join(SRC, fixtureRel)
    const fixtureBody = `// SPDX-License-Identifier: FSL-1.1-ALv2
import { threads, threads as aliasedThreads } from "~/db/schema/kernel"
import { withPrivilegedDb } from "~/db/privileged"

export async function planAliasedThreadInsert(orgId: string): Promise<void> {
  await withPrivilegedDb(orgId, "census-fixture-aliased", async (tx) => {
    await tx.insert(aliasedThreads).values({ orgId, handle: "aliased", type: "thread" })
  })
}

export async function planEphemeralHiddenAgentChat(orgId: string): Promise<void> {
  await withPrivilegedDb(orgId, "census-fixture-offender", async (tx) => {
    await tx.insert(threads).values({
      orgId,
      handle: "offender",
      type: "agent_chat",
      hiddenFromList: true,
    })
  })
}
`
    expect(existsSync(fixturePath), "fixture path already exists; refusing to overwrite").toBe(
      false,
    )
    try {
      mkdirSync(dirname(fixturePath), { recursive: true })
      writeFileSync(fixturePath, fixtureBody)
      const sites = census()
      const planted = sites.filter((s) => s.file === fixtureRel)
      expect(planted.length).toBeGreaterThan(0)
      // An aliased table import is found too (no allowlisted file aliases
      // `threads` on its insert any more, so the fixture carries that proof).
      expect(planted.some((s) => s.function === "planAliasedThreadInsert")).toBe(true)
      const unlisted = planted.filter((s) => !ALLOWLIST_KEYS.has(allowlistKey(s)))
      // This is the assertion that would need to pass for the census to be
      // silently defeated by a dropped file; it must NOT pass.
      expect(unlisted.length).toBeGreaterThan(0)
      expect(planted.some((s) => s.dangerousCombo)).toBe(true)
    } finally {
      rmSync(fixturePath, { force: true })
      expect(existsSync(fixturePath)).toBe(false)
    }
  })

  it("finds no unclassified discussion or per-entity thread creation beyond the allowlist", () => {
    // Every current production anchor is a channel/DM (thread.ts), a routine
    // output thread (routine-worker.ts), a hidden approval anchor
    // (execute-tool.ts x2), a hidden sub-run thread
    // (subrun-thread.ts, shared by spawn-agent.ts and the seed engine), a
    // hidden MCP connection anchor (connection-thread.ts), a hidden
    // restricted session anchor (rest-tool-call.ts) or a hidden
    // bulk-dispatch origin bucket (bulk-dispatch.ts). The seed engine
    // (src/seed) creates threads only through these product paths
    // (createThread, createOrGetAgentDm, insertSubrunThread). There is no
    // OTHER "open a discussion thread for entity X" generic creator left in
    // the tree: if one is added, its insert or insertThreadWithParticipants
    // call surfaces above as an unlisted site. This list is intentionally
    // wider than the P4c-T01 read-only census's Table 1 (which counted 6
    // production rows): three of the original six files here were not in that
    // table, found instead by this walk actually resolving import aliases
    // and helper calls rather than a literal `insert(threads)` grep.
    const sites = census()
    const productionFiles = new Set(sites.map((s) => s.file))
    expect([...productionFiles].sort()).toEqual(
      [
        "modules/apps/bulk-dispatch.ts",
        "modules/apps/execute-tool.ts",
        "modules/apps/rest-tool-call.ts",
        "modules/mcp/connection-thread.ts",
        "modules/threads/thread.ts",
        "modules/agent/routines/routine-worker.ts",
        "modules/agent/subruns/subrun-thread.ts",
      ].sort(),
    )
  })
})
