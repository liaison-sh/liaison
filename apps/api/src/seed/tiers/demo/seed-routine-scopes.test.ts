// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY SCOPE A SEEDED ROUTINE IS GRANTED NAMES A REAL CAPABILITY.
//
// A routine's scopes are its ceiling: a tool whose required scope is not under
// one of them is never offered to its ticks. A scope that no app declares is
// therefore a silent hole, not an error. The sales scenario's routine was
// granted `mail:messages:send`, which no mail tool requires (the reply tool
// needs `mail:conversations:write`), so every run briefed the owner and could
// never stage the reply it was asked for (live demo, 2026-10-24).
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", "..", "..")

/** Every `requiredScopes` entry of every app manifest, kernel apps and bundled apps alike. */
function declaredAppScopes(): Set<string> {
  const out = new Set<string>()
  const dirs = [path.join(ROOT, "apps", "api", "src", "apps"), path.join(ROOT, "bundled-apps")]
  for (const dir of dirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      let manifest: { tools?: Record<string, { requiredScopes?: string[] }> }
      try {
        manifest = JSON.parse(readFileSync(path.join(dir, entry.name, "app.manifest.json"), "utf8"))
      } catch {
        continue
      }
      for (const tool of Object.values(manifest.tools ?? {})) {
        for (const s of tool.requiredScopes ?? []) out.add(s)
      }
    }
  }
  return out
}

/** The scope lists of the routines the agent-native seed writes, read from its source. */
function seededRoutineScopes(): string[][] {
  const src = readFileSync(path.join(import.meta.dir, "seed-agent-native.ts"), "utf8")
  const lists: string[][] = []
  for (const m of src.matchAll(/scopes: \[([^\]]*)\]/g)) {
    const body = m[1] ?? ""
    lists.push([...body.matchAll(/"([^"]+)"/g)].map((s) => s[1] ?? ""))
  }
  return lists
}

describe("the demo seed's routines", () => {
  it("grant only scopes some app tool requires (or a parent of one)", () => {
    const declared = declaredAppScopes()
    const lists = seededRoutineScopes()
    // The scan sees the routines (the guard is not vacuous).
    expect(lists.length).toBeGreaterThanOrEqual(5)
    const unknown: string[] = []
    for (const list of lists) {
      for (const scope of list) {
        // Kernel capabilities are not declared in an app manifest.
        if (scope.startsWith("kernel:")) continue
        const known = [...declared].some((d) => d === scope || d.startsWith(`${scope}:`))
        if (!known) unknown.push(scope)
      }
    }
    expect(unknown).toEqual([])
  })
})
