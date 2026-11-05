// SPDX-License-Identifier: FSL-1.1-ALv2
//
// mock.module() global-leak hygiene guard.
//
// THE BUG CLASS THIS PREVENTS. The backend unit suite runs as a FLAT `bun test`
// over hundreds of files in ONE process (see `scripts/test-run.ts` → `unit`).
// A test file that calls `mock.module("<specifier>", factory)` permanently
// replaces that module for EVERY later file in the run — Bun's `mock.restore()`
// does NOT undo `mock.module`. When the replacement factory is a PARTIAL stub
// (returns only the few exports the file overrides), every later file that
// imports the real module gets a broken / missing-exports version, producing
// failures that ONLY appear in the full suite and are green in isolation —
// maddening to debug.
//
// THE REQUIRED CONVENTION. Any `mock.module(<specifier>, factory)` whose factory
// returns an object literal MUST make that object COMPLETE by spreading an EAGER
// SNAPSHOT of the real module taken BEFORE the mock was installed:
//
//     import * as realFoo from "~/path/to/foo"   // LIVE namespace view
//     const realFooModule = { ...realFoo }       // eager snapshot — still real here
//     mock.module("~/path/to/foo", () => ({ ...realFooModule, someOverride }))
//
// The snapshot is load-bearing: `import * as realFoo` (and `await import(...)`)
// is a LIVE view that mock.module patches IN PLACE, so spreading `realFoo`
// inside a later factory (e.g. an afterAll restore) spreads the MOCK — the
// "restore" silently re-installs the fake and it leaks to every later file.
// Now later files get every real export except the few intentionally overridden
// — no missing-export poison. Pair it with an `afterAll` that re-installs the
// snapshot (`mock.module(spec, () => realFooModule)`) when the override's
// VALUE (not just its presence) would also mislead a later importer.
//
// This guard statically scans every `apps/api/src/**/*.test.ts` and FAILS if a
// `mock.module(...)` factory returns an object literal that does NOT spread an
// identifier (`...something`). A factory that returns a non-object (e.g. the
// real module record `() => realFoo`) is also accepted. Comment lines and the
// allowlist below are skipped. Extend the allowlist only with a real reason.

import { describe, expect, it } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

const srcDir = path.resolve(__dirname, "..", "..")

function findTestFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      results.push(...findTestFiles(full))
    } else if (entry.name.endsWith(".test.ts")) {
      results.push(full)
    }
  }
  return results
}

// Strip line (`//`) and block (`/* … */`) comments + string/template literals so
// that `mock.module(` mentioned in prose or inside a string is never matched.
// Pragmatic single-pass tokenizer — good enough for our test files, which never
// nest these forms pathologically.
function stripCommentsAndStrings(src: string): string {
  let out = ""
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++
      continue
    }
    if (c === "/" && c2 === "*") {
      i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      out += " " // preserve a token boundary
      i++
      while (i < n) {
        if (src[i] === "\\") {
          i += 2
          continue
        }
        if (src[i] === quote) {
          i++
          break
        }
        // keep newlines so line numbers in a fallback scan stay sane
        if (src[i] === "\n") out += "\n"
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

interface MockCall {
  // 1-based line where `mock.module(` begins (in the ORIGINAL source).
  line: number
  // The factory body text (everything after the `=>` up to the matching close).
  factory: string
  // Whether the factory returns an object literal (`=> ({ … })` or `=> { return { … } }`).
  returnsObjectLiteral: boolean
  // Whether that object literal spreads an identifier (`...foo`).
  spreadsIdentifier: boolean
  // The identifiers spread into the object literal, in source order.
  spreadNames: string[]
}

/**
 * Identifiers bound to a LIVE module namespace view: `import * as N from "..."`
 * and `const N = await import("...")`. mock.module patches such a view IN
 * PLACE, so spreading one into a factory spreads whatever is installed at the
 * time the factory runs, which for a restore factory is the mock itself. The
 * convention is to snapshot first (`const snapshot = { ...N }`) and spread the
 * snapshot.
 *
 * The set is closed over the three ways a live view travels under another name,
 * each of which used to walk past a name- and position-blind check:
 *  - an ALIAS (`const snap = ns`) is the same live object, spelled differently;
 *  - a `new Proxy(ns, {})` forwards every read to the live view;
 *  - a SNAPSHOT taken AFTER the first `mock.module(` call in the file is a
 *    snapshot of the mock, which is exactly what the convention forbids.
 * `firstMockModuleOffset` is the char offset of that first call; leave it out
 * and every snapshot counts as taken in time.
 */
function liveNamespaceBindings(
  stripped: string,
  firstMockModuleOffset: number = Number.POSITIVE_INFINITY,
): Set<string> {
  const names = new Set<string>()
  // A namespace import, with or without a default binding beside it
  // (`import def, * as ns from "..."` is the shape the `import\s*\*` form missed).
  for (const m of stripped.matchAll(
    /import\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?\*\s*as\s+([A-Za-z_$][\w$]*)\s+from/g,
  )) {
    names.add(m[1])
  }
  for (const m of stripped.matchAll(
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(/g,
  )) {
    names.add(m[1])
  }
  // Propagate to every name that is one of those views under another spelling,
  // to a fixed point: an alias of an alias is still the live view.
  const ALIAS = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/g
  const PROXY =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Proxy\s*\(\s*([A-Za-z_$][\w$]*)/g
  const SNAPSHOT =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\}/g
  let grew = true
  while (grew) {
    grew = false
    const add = (name: string) => {
      if (names.has(name)) return
      names.add(name)
      grew = true
    }
    for (const m of stripped.matchAll(ALIAS)) if (names.has(m[2])) add(m[1])
    for (const m of stripped.matchAll(PROXY)) if (names.has(m[2])) add(m[1])
    for (const m of stripped.matchAll(SNAPSHOT)) {
      if (!names.has(m[2])) continue
      // Taken before the first mock.module call, this is the convention and the
      // result is a real snapshot. Taken after, it snapshots the mock.
      if ((m.index ?? 0) > firstMockModuleOffset) add(m[1])
    }
  }
  return names
}

// Walk the comment/string-stripped source, find every `mock.module(` call, and
// extract its factory by brace/paren matching. Returns one entry per call.
function extractMockModuleCalls(stripped: string): MockCall[] {
  const calls: MockCall[] = []
  const re = /mock\.module\s*\(/g
  // Map a char offset in `stripped` → 1-based line. `stripped` preserves the
  // original newline positions, so line numbers match the source file.
  const lineAt = (offset: number) => stripped.slice(0, offset).split("\n").length

  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(stripped)) !== null) {
    const callStart = m.index
    // Find the `=>` that opens the factory, then capture the factory body by
    // matching brackets from the first `{` or `(` after it.
    const arrowIdx = stripped.indexOf("=>", re.lastIndex)
    if (arrowIdx === -1) continue
    let j = arrowIdx + 2
    while (j < stripped.length && /\s/.test(stripped[j])) j++
    const opener = stripped[j]
    // factory bodies are either `({ … })` (object) or `{ … }` (block) or `realFoo`
    let factory = ""
    let returnsObjectLiteral = false
    if (opener === "(" || opener === "{") {
      const open = opener
      const close = opener === "(" ? ")" : "}"
      let depth = 0
      let k = j
      for (; k < stripped.length; k++) {
        const ch = stripped[k]
        if (ch === open) depth++
        else if (ch === close) {
          depth--
          if (depth === 0) {
            k++
            break
          }
        }
      }
      factory = stripped.slice(j, k)
      // `=> ({ … })` is an object literal; `=> { return { … } }` is a block that
      // returns an object literal.
      if (open === "(") {
        returnsObjectLiteral = /^\(\s*\{/.test(factory)
      } else {
        returnsObjectLiteral = /return\s*\{/.test(factory)
      }
    } else {
      // `=> realFoo` — returns an identifier (assumed a full real-module record).
      const rest = stripped.slice(j)
      factory = rest.split(/[\n,)]/)[0] ?? ""
      returnsObjectLiteral = false
    }
    const spreadNames = [...factory.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].map((s) => s[1])
    const spreadsIdentifier = spreadNames.length > 0
    calls.push({
      line: lineAt(callStart),
      factory,
      returnsObjectLiteral,
      spreadsIdentifier,
      spreadNames,
    })
  }
  return calls
}

/**
 * True when `src` stubs `spec` with mock.module and has no afterAll that puts a
 * real module record back (`mock.module(spec, () => ident)`).
 */
function stubsWithoutRestore(src: string, spec: string): boolean {
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
  const q = spec.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")
  const call = new RegExp(`mock\\.module\\(\\s*["']${q}["']`, "g")
  if (!call.test(code)) return false
  const restore = new RegExp(
    `afterAll\\(\\s*(?:async\\s*)?\\(\\)\\s*=>\\s*\\{?\\s*(?:await\\s+)?mock\\.module\\(\\s*["']${q}["']\\s*,\\s*\\(\\)\\s*=>\\s*[A-Za-z_$][\\w$]*\\s*\\)`,
  )
  return !restore.test(code)
}

describe("mock.module() global-leak hygiene", () => {
  // Allowlist: files whose `mock.module(...)` is a deliberate, reviewed
  // exception to the spread-the-real-module rule. Extend only with a reason.
  // Empty on purpose. The one entry this set ever held,
  // `tests/e2e/projects-agent-runtime.scenario.test.ts`, was justified by
  // "spreading the real `ai` would risk leaking the real network-backed
  // provider into the fake", which is not what that package is: `ai` exports
  // helper functions, and the model is injected into the two entry points the
  // scenario overrides anyway. The exemption cost what it always costs: when
  // production grew an `import { jsonSchema } from "ai"`, the hand-listed fake
  // had no such export and the whole scenario file stopped loading. It now
  // spreads like everything else. A new entry needs a reason this one did not
  // have.
  const allowlist = new Set<string>([])

  const files = findTestFiles(srcDir)

  it("scanned a meaningful number of test files", () => {
    // Sanity floor so a broken walk can't make the guard pass vacuously.
    expect(files.length).toBeGreaterThan(300)
  })

  it("every mock.module() factory spreads the real module (no partial-stub global leak)", () => {
    const violations: Array<{ file: string; line: number; reason: string }> = []
    for (const file of files) {
      const rel = path.relative(srcDir, file).split(path.sep).join("/")
      if (allowlist.has(rel)) continue
      const original = fs.readFileSync(file, "utf-8")
      const stripped = stripCommentsAndStrings(original)
      if (!stripped.includes("mock.module")) continue
      const calls = extractMockModuleCalls(stripped)
      const live = liveNamespaceBindings(stripped, stripped.indexOf("mock.module"))
      for (const call of calls) {
        // A factory that returns a bare identifier (the real-module record) or an
        // object literal that spreads `...real` is safe. A partial object literal
        // (no spread) is the leak.
        if (call.returnsObjectLiteral && !call.spreadsIdentifier) {
          violations.push({
            file: rel,
            line: call.line,
            reason:
              "mock.module() factory returns a PARTIAL object literal with no `...realModule` spread",
          })
          continue
        }
        // The spread has to be a SNAPSHOT. Spreading the live namespace view
        // reads whatever mock.module has installed by the time the factory
        // runs, so a "complete" stub and a "restore" can both re-install the
        // mock. This half was missing, and three of the four jobs mockers
        // spread the live view.
        const liveSpreads = call.spreadNames.filter((name) => live.has(name))
        if (liveSpreads.length > 0) {
          violations.push({
            file: rel,
            line: call.line,
            reason: `mock.module() factory spreads the LIVE namespace view \`${liveSpreads[0]}\` instead of an eager snapshot`,
          })
        }
      }
    }
    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.file}:${v.line}  ${v.reason}`).join("\n")
      throw new Error(
        "mock.module() global-leak hygiene violated. In the flat unit `bun test` " +
          "process, mock.module() replaces a module for EVERY later file and is " +
          "never restored by mock.restore(). A partial stub poisons later importers.\n" +
          "FIX: capture an EAGER SNAPSHOT of the real module BEFORE the mock " +
          '(`import * as real from "<spec>"; const realModule = { ...real }`) ' +
          "and spread the snapshot so the stub is complete: " +
          '`mock.module("<spec>", () => ({ ...realModule, <overrides> }))`. ' +
          "(Namespace imports are LIVE views that mock.module patches in place — " +
          "spreading them in a restore factory re-installs the mock.) " +
          "Re-install the snapshot in `afterAll` if the override's value would also mislead a later " +
          "importer. If the mock is a deliberate full-module replacement in a separate " +
          "test suite, add the file to the allowlist in mock-module-hygiene.test.ts with a reason.\n" +
          `Violations:\n${detail}`,
      )
    }
    expect(violations).toEqual([])
  })

  // A complete stub still LIES to a later file when its overrides change behaviour.
  // The jobs module is the case that bit: five event-routine files left
  // `enqueueAppJob` and `upsertJobScheduler` stubbed, and skills-routines-tools'
  // spyOn(Queue.prototype, ...) cases then watched a queue nothing called. A file
  // that stubs one of these shared modules must re-install the real snapshot in
  // `afterAll`.
  const MUST_RESTORE = ["~/infra/jobs/jobs"]

  it("a file that stubs a shared infra module restores it in afterAll", () => {
    const missing: string[] = []
    for (const file of files) {
      const rel = path.relative(srcDir, file).split(path.sep).join("/")
      if (rel === "modules/apps/mock-module-hygiene.test.ts") continue
      const original = fs.readFileSync(file, "utf-8")
      for (const spec of MUST_RESTORE) {
        if (!stubsWithoutRestore(original, spec)) continue
        missing.push(`  ${rel}  stubs ${spec} with no afterAll restore`)
      }
    }
    if (missing.length > 0) {
      throw new Error(
        "mock.module() of a shared infra module outlives the file. Add " +
          '`afterAll(() => { mock.module("<spec>", () => realModule) })` with the eager ' +
          `snapshot taken before the stub.\n${missing.join("\n")}`,
      )
    }
    expect(missing).toEqual([])
  })

  it("the restore check flags a jobs stub without a restore and accepts one with it", () => {
    const stub = `const realJobs = await import("~/infra/jobs/jobs")
const realJobsModule = { ...realJobs }
mock.module("~/infra/jobs/jobs", () => ({ ...realJobsModule, enqueueAppJob: async () => "x" }))`
    expect(stubsWithoutRestore(stub, "~/infra/jobs/jobs")).toBe(true)
    const restored = `${stub}
afterAll(() => {
  mock.module("~/infra/jobs/jobs", () => realJobsModule)
})`
    expect(stubsWithoutRestore(restored, "~/infra/jobs/jobs")).toBe(false)
    expect(
      stubsWithoutRestore(
        `afterAll(() => mock.module("~/infra/jobs/jobs", () => realJobsModule))`,
        "~/infra/jobs/jobs",
      ),
    ).toBe(false)
  })

  // Self-tests: the extractor must classify the safe and unsafe shapes correctly,
  // so the guard cannot silently rot into a vacuous pass.
  it("flags a partial object-literal factory and accepts a spread factory", () => {
    const unsafe = `import { mock } from "bun:test"
mock.module("~/x/foo", () => ({ bar: () => 1 }))`
    const unsafeCalls = extractMockModuleCalls(stripCommentsAndStrings(unsafe))
    expect(unsafeCalls).toHaveLength(1)
    expect(unsafeCalls[0]?.returnsObjectLiteral).toBe(true)
    expect(unsafeCalls[0]?.spreadsIdentifier).toBe(false)

    const safe = `import * as realFoo from "~/x/foo"
mock.module("~/x/foo", () => ({ ...realFoo, bar: () => 1 }))`
    const safeCalls = extractMockModuleCalls(stripCommentsAndStrings(safe))
    expect(safeCalls).toHaveLength(1)
    expect(safeCalls[0]?.spreadsIdentifier).toBe(true)

    const blockSafe = `mock.module("~/x/foo", () => { return { ...realFoo, bar: 1 } })`
    const blockCalls = extractMockModuleCalls(stripCommentsAndStrings(blockSafe))
    expect(blockCalls[0]?.returnsObjectLiteral).toBe(true)
    expect(blockCalls[0]?.spreadsIdentifier).toBe(true)

    const liveSpread = `import * as realFoo from "~/x/foo"
mock.module("~/x/foo", () => ({ ...realFoo, bar: () => 1 }))`
    const liveStripped = stripCommentsAndStrings(liveSpread)
    expect(extractMockModuleCalls(liveStripped)[0]?.spreadNames).toEqual(["realFoo"])
    expect(liveNamespaceBindings(liveStripped).has("realFoo")).toBe(true)

    const snapshotSpread = `import * as realFoo from "~/x/foo"
const realFooModule = { ...realFoo }
mock.module("~/x/foo", () => ({ ...realFooModule, bar: () => 1 }))`
    const snapStripped = stripCommentsAndStrings(snapshotSpread)
    expect(extractMockModuleCalls(snapStripped)[0]?.spreadNames).toEqual(["realFooModule"])
    expect(liveNamespaceBindings(snapStripped).has("realFooModule")).toBe(false)

    const dynamicLive = `const realJobs = await import("~/infra/jobs/jobs")
mock.module("~/infra/jobs/jobs", () => ({ ...realJobs, enqueueAppJob: async () => "x" }))`
    const dynStripped = stripCommentsAndStrings(dynamicLive)
    expect(liveNamespaceBindings(dynStripped).has("realJobs")).toBe(true)
    expect(extractMockModuleCalls(dynStripped)[0]?.spreadNames).toEqual(["realJobs"])

    const identReturn = `mock.module("~/x/foo", () => realFoo)`
    const identCalls = extractMockModuleCalls(stripCommentsAndStrings(identReturn))
    expect(identCalls[0]?.returnsObjectLiteral).toBe(false)
  })

  // Each of these four spellings spreads the LIVE view while reading like a
  // snapshot, and each one used to pass: the check compared names only, and
  // only the two it had seeded.
  it("follows a live namespace view through an alias, a Proxy and a late snapshot", () => {
    const firstMock = (src: string) => src.indexOf("mock.module")

    const alias = `import * as realFoo from "~/x/foo"
const snap = realFoo
mock.module("~/x/foo", () => ({ ...snap, bar: () => 1 }))`
    const aliasStripped = stripCommentsAndStrings(alias)
    expect(liveNamespaceBindings(aliasStripped, firstMock(aliasStripped)).has("snap")).toBe(true)

    const lateSnapshot = `import * as realFoo from "~/x/foo"
mock.module("~/x/foo", () => ({ ...realFoo, bar: () => 1 }))
const snap = { ...realFoo }
afterAll(() => mock.module("~/x/foo", () => ({ ...snap })))`
    const lateStripped = stripCommentsAndStrings(lateSnapshot)
    expect(liveNamespaceBindings(lateStripped, firstMock(lateStripped)).has("snap")).toBe(true)

    const proxied = `import * as realFoo from "~/x/foo"
const snap = new Proxy(realFoo, {})
mock.module("~/x/foo", () => ({ ...snap, bar: () => 1 }))`
    const proxyStripped = stripCommentsAndStrings(proxied)
    expect(liveNamespaceBindings(proxyStripped, firstMock(proxyStripped)).has("snap")).toBe(true)

    const defaultAndNamespace = `import def, * as realFoo from "~/x/foo"
mock.module("~/x/foo", () => ({ ...realFoo, bar: () => 1 }))`
    const defStripped = stripCommentsAndStrings(defaultAndNamespace)
    expect(liveNamespaceBindings(defStripped, firstMock(defStripped)).has("realFoo")).toBe(true)

    // And the convention itself still reads as a snapshot: taken BEFORE the
    // first mock.module call, `snap` is a real copy and is not flagged.
    const inTime = `import * as realFoo from "~/x/foo"
const snap = { ...realFoo }
mock.module("~/x/foo", () => ({ ...snap, bar: () => 1 }))`
    const inTimeStripped = stripCommentsAndStrings(inTime)
    expect(liveNamespaceBindings(inTimeStripped, firstMock(inTimeStripped)).has("snap")).toBe(false)
  })

  it("ignores mock.module mentioned in comments or string literals", () => {
    const commented = `// mock.module("~/x/foo", () => ({ bar: 1 }))
const s = "mock.module(\\"~/x/foo\\")"
export const x = 1`
    const calls = extractMockModuleCalls(stripCommentsAndStrings(commented))
    expect(calls).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// global-fetch leak hygiene guard.
//
// THE BUG CLASS THIS PREVENTS. Sibling to the mock.module leak above, and just as
// nasty in the flat unit `bun test` process. A test file that assigns
// `globalThis.fetch = <stub>` (to fake an HTTP boundary) replaces the PROCESS-WIDE
// global fetch. If it never restores the real fetch, every LATER file in the run
// that calls the global `fetch` — directly, or via a default param like
// bulk-blob's `fetchImpl = globalThis.fetch` — gets the stale stub. A stub that
// returns e.g. 401 then makes those later files fail with errors that only ever
// appear in the full suite and are green in isolation (this guard was added after
// `settings/ai-keys-routes.test.ts` leaked a 401-returning fetch that broke the
// `apps/sandbox/bulk-blob.test.ts` cluster).
//
// THE REQUIRED CONVENTION. Capture the real fetch BEFORE overwriting it, and
// restore it in `afterEach` (preferred — always runs, even when a test throws) or
// `afterAll`:
//
//     const realFetch = globalThis.fetch
//     afterEach(() => { globalThis.fetch = realFetch })
//     // …tests may do `globalThis.fetch = someStub` freely…
//
// This guard statically scans every `apps/api/src/**/*.test.ts`. For each file
// that assigns `globalThis.fetch =` (or `global.fetch =`) with a STUB value (any
// RHS that is not a bare identifier), it FAILS unless the file also contains a
// RESTORE assignment (`globalThis.fetch = <bareIdentifier>`) located INSIDE an
// `afterEach(`/`afterAll(` callback. Comments/strings are stripped first. The
// `OutboundFetchTestAccess.setFetch(...)` seam (`~/lib/outbound-fetch`) is a DIFFERENT,
// self-restoring seam (callers pass `null` to reset) and does not touch
// `globalThis.fetch`, so it is intentionally out of scope here.

interface FetchAssign {
  line: number
  // char offset of the assignment in the stripped source
  offset: number
  // true when the RHS is a bare identifier (a restore to the captured real fetch);
  // false when it's a stub (function expression, mock(...), cast, etc.)
  isRestore: boolean
}

// Find the spans of every `afterEach(...)` / `afterAll(...)` call body by matching
// parens from the opening `(`. Returns [start,end) char offsets in `stripped`.
function findHookSpans(stripped: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const re = /\b(?:afterEach|afterAll)\s*\(/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(stripped)) !== null) {
    const open = re.lastIndex - 1 // index of the `(`
    let depth = 0
    let k = open
    for (; k < stripped.length; k++) {
      const ch = stripped[k]
      if (ch === "(") depth++
      else if (ch === ")") {
        depth--
        if (depth === 0) {
          k++
          break
        }
      }
    }
    spans.push([open, k])
  }
  return spans
}

// Extract every `globalThis.fetch =` / `global.fetch =` assignment (ignoring `==`
// / `===` comparisons), classifying each as a restore or a stub.
function extractFetchAssignments(stripped: string): FetchAssign[] {
  const out: FetchAssign[] = []
  const re = /\b(?:globalThis|global)\s*\.\s*fetch\s*=(?!=)/g
  const lineAt = (offset: number) => stripped.slice(0, offset).split("\n").length
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
  while ((m = re.exec(stripped)) !== null) {
    const offset = m.index
    // RHS starts right after the `=`.
    let j = re.lastIndex
    while (j < stripped.length && /\s/.test(stripped[j])) j++
    // A restore is a bare identifier RHS terminated by `;`/newline/`)` with no
    // call/paren/brace/arrow — e.g. `globalThis.fetch = realFetch`.
    const rest = stripped.slice(j)
    const identMatch = /^([A-Za-z_$][\w$]*)\s*(;|\n|\)|}|,|$)/.exec(rest)
    out.push({ line: lineAt(offset), offset, isRestore: identMatch !== null })
  }
  return out
}

describe("global-fetch leak hygiene", () => {
  // Allowlist: files that assign `globalThis.fetch` but are exempt, WITH a reason.
  // (Empty today — every leaker found was fixed polluter-side.)
  const allowlist = new Set<string>([])

  const files = findTestFiles(srcDir)

  it("every file that stubs globalThis.fetch restores the real fetch in afterEach/afterAll", () => {
    const violations: Array<{ file: string; line: number; reason: string }> = []
    for (const file of files) {
      const rel = path.relative(srcDir, file).split(path.sep).join("/")
      if (allowlist.has(rel)) continue
      const original = fs.readFileSync(file, "utf-8")
      const stripped = stripCommentsAndStrings(original)
      if (!/\b(?:globalThis|global)\s*\.\s*fetch\s*=(?!=)/.test(stripped)) continue

      const assigns = extractFetchAssignments(stripped)
      const stubs = assigns.filter((a) => !a.isRestore)
      if (stubs.length === 0) continue // only restores / no stubs → nothing to leak

      const hookSpans = findHookSpans(stripped)
      const restoreInHook = assigns.some(
        (a) => a.isRestore && hookSpans.some(([s, e]) => a.offset >= s && a.offset < e),
      )
      if (!restoreInHook) {
        violations.push({
          file: rel,
          line: stubs[0]?.line ?? 0,
          reason:
            "assigns globalThis.fetch to a stub but never restores the real fetch inside afterEach/afterAll",
        })
      }
    }
    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.file}:${v.line}  ${v.reason}`).join("\n")
      throw new Error(
        "global-fetch leak hygiene violated. In the flat unit `bun test` process, " +
          "`globalThis.fetch = <stub>` replaces the PROCESS-WIDE fetch; if it is not " +
          "restored it poisons every later file that uses the global fetch (e.g. the " +
          "bulk-blob sandbox suite, which 401'd).\n" +
          "FIX: capture the real fetch first (`const realFetch = globalThis.fetch`) and " +
          "restore it in `afterEach` (preferred — always runs, even on a thrown test) or " +
          "`afterAll`: `afterEach(() => { globalThis.fetch = realFetch })`. If a file is a " +
          "deliberate, reviewed exception, add it to the allowlist in " +
          "mock-module-hygiene.test.ts with a reason.\n" +
          `Violations:\n${detail}`,
      )
    }
    expect(violations).toEqual([])
  })

  // Self-tests so the guard can't rot into a vacuous pass.
  it("classifies restore vs stub assignments correctly", () => {
    const src = `const realFetch = globalThis.fetch
globalThis.fetch = (async () => new Response("x", { status: 401 })) as unknown as typeof fetch
afterEach(() => { globalThis.fetch = realFetch })`
    const assigns = extractFetchAssignments(stripCommentsAndStrings(src))
    // two assignments: one stub, one restore
    expect(assigns.length).toBe(2)
    expect(assigns.filter((a) => !a.isRestore).length).toBe(1)
    expect(assigns.filter((a) => a.isRestore).length).toBe(1)
  })

  it("locates a restore inside an afterEach hook span", () => {
    const src = `globalThis.fetch = mock(async () => new Response("{}"))
afterAll(() => {
  globalThis.fetch = originalFetch
})`
    const stripped = stripCommentsAndStrings(src)
    const assigns = extractFetchAssignments(stripped)
    const spans = findHookSpans(stripped)
    const restore = assigns.find((a) => a.isRestore)!
    expect(spans.some(([s, e]) => restore.offset >= s && restore.offset < e)).toBe(true)
    // the stub assignment is OUTSIDE the hook span
    const stub = assigns.find((a) => !a.isRestore)!
    expect(spans.some(([s, e]) => stub.offset >= s && stub.offset < e)).toBe(false)
  })

  it("flags a file that stubs fetch with no restore in any hook", () => {
    // restore exists but is NOT inside afterEach/afterAll → still a leak.
    const leak = `const realFetch = globalThis.fetch
describe("x", () => {
  it("t", () => { globalThis.fetch = (async () => new Response("nope", { status: 401 })) as any })
})`
    const stripped = stripCommentsAndStrings(leak)
    const assigns = extractFetchAssignments(stripped)
    const stubs = assigns.filter((a) => !a.isRestore)
    expect(stubs.length).toBe(1)
    const spans = findHookSpans(stripped)
    const restoreInHook = assigns.some(
      (a) => a.isRestore && spans.some(([s, e]) => a.offset >= s && a.offset < e),
    )
    expect(restoreInHook).toBe(false) // would be reported as a violation
  })

  it("ignores fetch comparisons and the OutboundFetchTestAccess.setFetch seam", () => {
    const benign = `if (globalThis.fetch === realFetch) {}
const { OutboundFetchTestAccess } = await import("~/lib/outbound-fetch")
OutboundFetchTestAccess.setFetch(fakeFetch)
afterEach(() => OutboundFetchTestAccess.setFetch(null))`
    const assigns = extractFetchAssignments(stripCommentsAndStrings(benign))
    // `===` is excluded by the negative lookahead; the seam is not a fetch assign.
    expect(assigns.length).toBe(0)
  })
})
