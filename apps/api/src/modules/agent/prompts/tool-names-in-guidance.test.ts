// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Guidance the model reads names every tool by its callable name, `app__tool`.
// A prompt that says "call tool_search" or a guide that says "use
// knowledge:search" teaches the model a name no tool has, and it calls it.
// This scans the model-facing text: the prompt files, the app manifests' prose
// (agent instructions, tool descriptions, guides, skills) and the prose string
// literals of the kernel tool and context sources.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const API_SRC = path.resolve(import.meta.dir, "../../..")
const REPO = path.resolve(API_SRC, "../../..")
const AGENT = path.join(API_SRC, "modules/agent")

/** Kernel tool names, from the registrations themselves. */
function kernelToolNames(): string[] {
  const names = new Set<string>()
  const files = [
    ...readdirSync(path.join(AGENT, "tools")).map((f) => path.join(AGENT, "tools", f)),
    ...readdirSync(path.join(AGENT, "subruns")).map((f) => path.join(AGENT, "subruns", f)),
    path.join(API_SRC, "modules/notifications/agent-tools.ts"),
  ].filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(
      /toolRegistry\.set\(\[orgId, "kernel", "([a-z][a-z_]*_[a-z_]+)"\]/g,
    ))
      names.add(m[1])
  }
  return [...names]
}

/** app -> tool names, from every app manifest. */
function appTools(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const base of [path.join(API_SRC, "apps"), path.join(REPO, "bundled-apps")]) {
    for (const d of readdirSync(base)) {
      const p = path.join(base, d, "app.manifest.json")
      if (!existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, "utf8")) as { name: string; tools?: object }
      if (j.tools && typeof j.tools === "object") out.set(j.name, new Set(Object.keys(j.tools)))
    }
  }
  return out
}

function manifestPaths(): string[] {
  const out: string[] = []
  for (const base of [path.join(API_SRC, "apps"), path.join(REPO, "bundled-apps")]) {
    for (const d of readdirSync(base)) {
      const p = path.join(base, d, "app.manifest.json")
      if (existsSync(p)) out.push(p)
    }
  }
  return out
}

/** Bare kernel tool names in `text` (not already `kernel__`-prefixed). */
function bareKernelNames(text: string, names: readonly string[]): string[] {
  const re = new RegExp(`(?<![A-Za-z0-9_:.\\/\\-{\\[<])(${names.join("|")})(?![A-Za-z0-9_(])`, "g")
  return [...text.matchAll(re)].map((m) => m[1])
}

/** `app:tool` / `app.tool` forms that name a real tool of that app. */
function separatorFormNames(text: string, tools: Map<string, Set<string>>): string[] {
  const apps = [...tools.keys()].map((a) => a.replace(/-/g, "\\-")).join("|")
  const re = new RegExp(
    `(?<![A-Za-z0-9_:.\\-])(${apps})[:.]([a-zA-Z][A-Za-z_]*)(?![A-Za-z0-9_:\\-]|\\.[A-Za-z])`,
    "g",
  )
  return [...text.matchAll(re)]
    .filter((m) => tools.get(m[1])?.has(m[2]))
    .map((m) => `${m[1]}${text[m.index + m[1].length]}${m[2]}`)
}

/** String literals that read as prose (six or more spaces), log messages aside. */
function proseLiterals(source: string): string {
  const withoutLogs = source.replace(
    /\.(?:trace|debug|info|warn|error|fatal)\(\s*(?:\{[^{}]*\},\s*)?("(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)/g,
    "",
  )
  const lits = withoutLogs.match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []
  return lits
    .filter((s) => (s.match(/ /g) ?? []).length >= 6)
    .map((s) => s.replace(/\$\{[^}]*\}/g, ""))
    .join("\n")
}

const KERNEL = kernelToolNames()

describe("tool names in model-facing guidance", () => {
  it("the kernel tool list is read from the registrations", () => {
    expect(KERNEL).toContain("tool_search")
    expect(KERNEL).toContain("skill_read")
    expect(KERNEL).toContain("approvals_list")
  })

  it("the scanners catch the wrong forms and pass the callable one", () => {
    expect(bareKernelNames("call `tool_search` first", KERNEL)).toEqual(["tool_search"])
    expect(bareKernelNames("call `kernel__tool_search` first", KERNEL)).toEqual([])
    const tools = new Map([["knowledge", new Set(["search"])]])
    expect(separatorFormNames("ground it via knowledge:search", tools)).toEqual([
      "knowledge:search",
    ])
    expect(separatorFormNames("ground it via knowledge__search", tools)).toEqual([])
    expect(separatorFormNames("from knowledge__search/knowledge:search", tools)).toEqual([
      "knowledge:search",
    ])
    // A scope or an event name is not a tool name.
    expect(
      separatorFormNames("needs knowledge:search:read, on knowledge:search.done", tools),
    ).toEqual([])
  })

  it("prompt files name kernel tools as kernel__<tool>", () => {
    const dirs = [path.join(AGENT, "prompts"), path.join(AGENT, "prompts/kernel")]
    const offenders: string[] = []
    for (const dir of dirs) {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
        const hits = bareKernelNames(readFileSync(path.join(dir, f), "utf8"), KERNEL)
        if (hits.length) offenders.push(`${f}: ${[...new Set(hits)].join(", ")}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it("kernel tool descriptions, hints and context blocks name kernel tools as kernel__<tool>", () => {
    const files = [
      "tools/kernel-tools.ts",
      "tools/skills-routines-tools.ts",
      "tools/chat-tools.ts",
      "tools/contact-tools.ts",
      "tools/coordination-tools.ts",
      "tools/admin-tools.ts",
      "tools/config-tools.ts",
      "tools/tool-search.ts",
      "tools/tool-bridge.ts",
      "context/context.ts",
      "skills/owner-skills.ts",
    ].map((f) => path.join(AGENT, f))
    files.push(path.join(API_SRC, "modules/notifications/agent-tools.ts"))
    const offenders: string[] = []
    for (const f of files) {
      const hits = bareKernelNames(proseLiterals(readFileSync(f, "utf8")), KERNEL)
      if (hits.length) offenders.push(`${path.basename(f)}: ${[...new Set(hits)].join(", ")}`)
    }
    expect(offenders).toEqual([])
  })

  it("tool results and routine guidance name app tools as app__tool", () => {
    const tools = appTools()
    const files = [
      path.join(AGENT, "tools/skills-routines-tools.ts"),
      path.join(AGENT, "routines/routine-draft-claim-guard.ts"),
      path.join(API_SRC, "apps/tickets/admin.ts"),
      path.join(API_SRC, "apps/tickets/tools.ts"),
      path.join(REPO, "bundled-apps/google-drive/src/tools.ts"),
      path.join(REPO, "bundled-apps/boxtal/src/shipment.ts"),
      path.join(REPO, "bundled-apps/boxtal/src/proforma.ts"),
      path.join(REPO, "bundled-apps/ads/src/merchant-reads.ts"),
    ]
    const offenders: string[] = []
    for (const f of files) {
      const hits = separatorFormNames(proseLiterals(readFileSync(f, "utf8")), tools)
      if (hits.length) offenders.push(`${path.basename(f)}: ${[...new Set(hits)].join(", ")}`)
    }
    expect(offenders).toEqual([])
  })

  it("app manifests name tools as app__tool, never app:tool or app.tool", () => {
    const tools = appTools()
    tools.set("kernel", new Set(KERNEL))
    const offenders: string[] = []
    for (const p of manifestPaths()) {
      const hits = separatorFormNames(proseLiterals(readFileSync(p, "utf8")), tools)
      if (hits.length) offenders.push(`${path.relative(REPO, p)}: ${[...new Set(hits)].join(", ")}`)
    }
    expect(offenders).toEqual([])
  })
})
