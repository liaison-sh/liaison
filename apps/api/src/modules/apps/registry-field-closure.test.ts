// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CLOSURE ORACLE: every manifest tool field a reader pulls off the tool REGISTRY
// must actually be copied onto the registry entry when the app is registered.
//
// The registry entry in runtime.ts is assembled by COPYING named fields off the
// manifest tool, one `if (…) entry.x = tool.x` at a time. Nothing links that
// hand-written copy list to the readers, so a new field can be declared in the
// manifest schema, consumed by a reader, shipped with UI and unit tests, and
// still be `undefined` at runtime for every app in the org.
//
// That is exactly what happened on 2026-08-05 with `decideInContext`: the
// manifest declared it on tickets:reply, the attention feed read it, the UI
// tests passed against hand-made metadata, and the copy line did not exist — so
// ticket-reply approvals stayed fully decidable from the feed in prod, which is
// the precise thing the change existed to prevent. Unit tests could not catch it
// because every layer was individually correct; only the CHAIN was broken.
//
// READERS are DISCOVERED, not hand-listed. The first version of this oracle
// carried a one-element READERS list (attention.ts), which left execute-tool's
// reads of `tool.approveScope` / `tool.approvalDimension` unguarded — the exact
// shape of the gap it existed to close. Any non-test file under apps/api/src
// that touches `toolRegistry.get` is now a reader.
//
// HOST-ONLY FIELDS (`approveScope`, `approvalDimension`) are the documented
// exception surface: they are set by host-registered tools (the skill tools in
// skills-routines-tools.ts), deliberately NOT declarable in a third-party
// manifest (privilege-escalation surface — see the comment in contract.ts), and
// therefore deliberately NOT in runtime.ts's copy list. This oracle pins all
// three legs of that decision, so the day someone adds the manifest field
// without threading the runtime.ts copy, CI fails on the stale exception
// instead of shipping a silent `undefined`.
//
// This test walks the source rather than the runtime because registering a real
// app needs a live org, a bundle and a DB. A static check is enough: the failure
// mode is a missing assignment, which is visible in the text.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "..")
const RUNTIME = join(import.meta.dir, "runtime.ts")
const CONTRACT = join(import.meta.dir, "contract.ts")
const SKILL_TOOLS = join(SRC, "modules", "agent", "tools", "skills-routines-tools.ts")
const KERNEL_TOOLS = join(SRC, "modules", "agent", "tools", "kernel-tools.ts")
const SECRET_TOOLS = join(SRC, "modules", "agent", "tools", "secret-request-tools.ts")
const MCP_PROJECTOR = join(SRC, "modules", "mcp-client", "projector.ts")
const REPORT_BUG_TOOL = join(SRC, "modules", "bug-reports", "tool.ts")
const APP_BUILDER_TOOLS = join(SRC, "modules", "app-builder", "tools.ts")

/**
 * Registry fields set ONLY by host-registered tools — see header — each with the
 * host registration path that sets it. None is declarable in a manifest: a
 * function (`gatedAgentNotes`, `refuseBeforeGate`) cannot cross the package boundary,
 * and the rest decide what a tool may do without an approval.
 */
const HOST_ONLY_FIELDS: Record<string, string> = {
  approveScope: SKILL_TOOLS,
  approvalDimension: SKILL_TOOLS,
  gatedAgentNotes: SKILL_TOOLS,
  sinkReadersSelf: SKILL_TOOLS,
  // request_secret: its row is read by the requester and the conversation's participants alone.
  sinkReadersConversation: SECRET_TOOLS,
  taintEditsPendingApproval: KERNEL_TOOLS,
  requiresHumanTurn: KERNEL_TOOLS,
  refuseBeforeGate: KERNEL_TOOLS,
  // A fetch of exactly one of the turn's own search results skips the web-read shape checks.
  searchResultUrlParam: KERNEL_TOOLS,
  // A public web read never parks; the web-read guardrails bound it.
  outboundWebRead: KERNEL_TOOLS,
  // Tools that run only inside a routine run, or only on the agent's own execution thread
  // (the dashboard source check refuses both): kernel tools only.
  routineOnly: KERNEL_TOOLS,
  requiresAgentExecutionThread: KERNEL_TOOLS,
  // A function of the call's params (gated for some params only): cannot cross the package boundary.
  gatedWhen: KERNEL_TOOLS,
  // Who reads an agent post into a kernel thread (threads_reply, threads_create): a function of
  // the call's params, set by the kernel thread tools only (scope-taint.ts, rule 11).
  taintPostAudience: KERNEL_TOOLS,
  // Whether a routine create/update grants scopes: such a call is never auto-approved.
  grantsScopes: SKILL_TOOLS,
  // A bug report about Liaison itself is never judged by the scope taint.
  taintUnjudgedWrite: REPORT_BUG_TOOL,
  // A personal MCP connection's tools belong to the person who connected it.
  ownerUserId: MCP_PROJECTOR,
  // An inbound MCP tool's own tools/list annotations, set when the tool is projected.
  mcpAnnotations: MCP_PROJECTOR,
  // The app builder's publish: its pending approval takes no edit, a change is a new request.
  payloadImmutable: APP_BUILDER_TOOLS,
  // The app builder's build and publish run short transactions per step, never one whole-call tx.
  ownsTransactions: APP_BUILDER_TOOLS,
}

/** Recursively list every non-test .ts source file under a directory. */
function walkSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...walkSources(full))
      continue
    }
    if (!name.endsWith(".ts")) continue
    if (name.endsWith(".test.ts") || name.endsWith(".d.ts")) continue
    out.push(full)
  }
  return out
}

/**
 * Field names read off a `toolRegistry.get(...)` result in a reader. Two forms:
 * the direct chain `toolRegistry.get(...)?.field`, and the two-step form where
 * the variable ASSIGNED from `toolRegistry.get` (whatever its name) is read as
 * `theVar?.field`. Tracking the assigned names — rather than assuming `tool` —
 * keeps the extractor from over-collecting unrelated variables in large files.
 */
function fieldsReadFromRegistry(source: string): string[] {
  const out = new Set<string>()
  for (const m of source.matchAll(/toolRegistry\.get\([^)]*\)\s*\??\.\s*([A-Za-z_]\w*)/g)) {
    out.add(m[1] as string)
  }
  const assigned = new Set<string>()
  // Only variables holding the ENTRY itself: `const x = toolRegistry.get([...])`
  // with nothing chained — `const y = toolRegistry.get([...])?.field` is already
  // a direct field read (captured above) and `y` is the field's value, whose own
  // property reads (`y.includes`, `y.length`) are not registry fields.
  for (const m of source.matchAll(
    /(?:const|let)\s+([A-Za-z_]\w*)\s*=\s*toolRegistry\.get\(\[[^\]]*\]\)(?!\s*\??\.)/g,
  )) {
    assigned.add(m[1] as string)
  }
  for (const v of assigned) {
    // No whitespace allowed around the dot: a sentence in a comment ("…the
    // tool.\n  const …") or a hyphenated filename ("execute-tool.ts") must not
    // read as a field access. `(?<![-\w])` keeps `-tool.ts` from matching.
    for (const m of source.matchAll(new RegExp(`(?<![-\\w])${v}\\??\\.([A-Za-z_]\\w*)`, "g"))) {
      out.add(m[1] as string)
    }
  }
  return [...out]
}

/** Code lines only — a COMMENTED-OUT copy line must not satisfy the oracle
 *  (verified red-first: `// entry.decideInContext = …` used to pass it). */
function stripComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      const t = line.trim()
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return ""
      const slashes = line.indexOf("//")
      return slashes >= 0 ? line.slice(0, slashes) : line
    })
    .join("\n")
}

/** Whether runtime.ts materializes a field on the built entry: a conditional
 *  copy (`entry.f = …`), a literal property (`f: …`), or a shorthand (`f,`). */
function copiedInRuntime(runtime: string, field: string): boolean {
  return (
    new RegExp(`entry\\.${field}\\s*=`).test(runtime) ||
    new RegExp(`^\\s*${field}\\s*:`, "m").test(runtime) ||
    new RegExp(`^\\s*${field},\\s*$`, "m").test(runtime)
  )
}

describe("registry field closure", () => {
  const runtime = stripComments(readFileSync(RUNTIME, "utf8"))
  const readers = walkSources(SRC).filter((f) =>
    readFileSync(f, "utf8").includes("toolRegistry.get("),
  )

  it("discovers readers, including the ones the hand-list missed", () => {
    const names = readers.map((f) => f.slice(SRC.length + 1))
    // The original incident pair: the feed reader AND the gate-path reader.
    expect(names).toContain(join("modules", "approvals", "attention.ts"))
    expect(names).toContain(join("modules", "apps", "execute-tool.ts"))
  })

  it("every registry field ANY reader reads is materialized by runtime.ts (host-only fields excepted)", () => {
    const allFields = new Set<string>()
    for (const reader of readers) {
      for (const f of fieldsReadFromRegistry(readFileSync(reader, "utf8"))) allFields.add(f)
    }
    // Sanity: the extractor must actually find something, or this oracle is
    // silently vacuous and would pass no matter what.
    expect(allFields.size).toBeGreaterThan(0)
    // And it must still see the field the 2026-08-05 incident was about.
    expect([...allFields]).toContain("decideInContext")

    const hostOnly = new Set<string>(Object.keys(HOST_ONLY_FIELDS))
    const missing = [...allFields].filter((f) => !hostOnly.has(f) && !copiedInRuntime(runtime, f))
    expect(missing).toEqual([])
  })

  // The host-only exception surface, pinned leg by leg (see header).
  describe("host-only fields", () => {
    const contract = readFileSync(CONTRACT, "utf8")

    for (const [field, registration] of Object.entries(HOST_ONLY_FIELDS)) {
      const hostRegistration = readFileSync(registration, "utf8")
      it(`${field} stays OUT of the manifest tool schema (contract.ts)`, () => {
        // A schema declaration would look like `approveScope: z.…` — the
        // documented deliberate-omission comment mentions the name, so match
        // the declaration shape, not the bare word.
        expect(new RegExp(`^\\s*${field}\\s*:\\s*z\\.`, "m").test(contract)).toBe(false)
      })

      it(`${field} is actually set on the host-registration path`, () => {
        // If the host tools stop setting it, the exception above is stale and
        // the field is dead — either way this oracle must be revisited.
        expect(new RegExp(`\\b${field}\\s*:`).test(hostRegistration)).toBe(true)
      })
    }
  })

  // The specific regressions, stated directly so they cannot be lost in a
  // refactor of the generic check above.
  it("copies decideInContext onto the registry entry", () => {
    expect(/entry\.decideInContext\s*=/.test(runtime)).toBe(true)
  })

  it("copies approvalImpact onto the registry entry", () => {
    expect(/entry\.approvalImpact\s*=/.test(runtime)).toBe(true)
  })
})
