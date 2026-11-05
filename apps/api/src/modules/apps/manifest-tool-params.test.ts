// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Systematic guard for the missing-tool-params class of bug. A manifest tool that takes params
// but declares NO `params` schema is invisible to the agent's tool definition — the model omits
// the params and the call fails (empty query / empty title / no-op). This silently broke the
// knowledge-grounded (knowledge:search), projects (createProject/createTask) and tickets-write
// (create/setStatus/setCategory/…) scenario classes until each tool got a schema. Assert EVERY
// in-tree + bundled app tool that has a `handler` also declares a `params` object (an empty
// `{type:"object","properties":{}}` is the explicit "takes no params" marker and is allowed).
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

function manifestPaths(): string[] {
  const out: string[] = []
  const inTree = join(import.meta.dir, "../../apps")
  for (const name of readdirSync(inTree, { withFileTypes: true })) {
    if (!name.isDirectory()) continue
    const p = join(inTree, name.name, "app.manifest.json")
    if (existsSync(p)) out.push(p)
  }
  // bundled apps (shopify/invoicing/boxtal/…) — manifest at root or under src/
  const bundled = join(import.meta.dir, "../../../../../bundled-apps")
  if (existsSync(bundled)) {
    for (const name of readdirSync(bundled, { withFileTypes: true })) {
      if (!name.isDirectory()) continue
      for (const rel of ["app.manifest.json", "src/app.manifest.json"]) {
        const p = join(bundled, name.name, rel)
        if (existsSync(p)) out.push(p)
      }
    }
  }
  return out
}

describe("manifest tool params (systematic missing-params guard)", () => {
  it("every app tool that has a handler also declares a params schema", () => {
    const offenders: string[] = []
    const paths = manifestPaths()
    expect(paths.length).toBeGreaterThan(0)
    for (const p of paths) {
      const m = JSON.parse(readFileSync(p, "utf8")) as {
        name?: string
        tools?: Record<string, { handler?: string; params?: unknown }>
      }
      for (const [tool, def] of Object.entries(m.tools ?? {})) {
        if (def && typeof def === "object" && def.handler && !def.params) {
          offenders.push(`${m.name ?? p}:${tool}`)
        }
      }
    }
    expect(offenders, `tools missing a params schema: ${offenders.join(", ")}`).toEqual([])
  })
})
