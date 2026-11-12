// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UI tool-call closure oracle: every tool the ads dashboard UI invokes (via
// invokeTool / limitedInvoke) MUST be a registered tool in app.manifest.json.
// A UI that calls an unregistered tool 404s that widget on every load ("tool
// ads:<name> not registered") — the regression this oracle closes. The UI's
// tool-call surface must be closed under the manifest's declared tools.
//
// Mirrors the philosophy of apps/api/src/modules/apps/detail-view-closure.test.ts:
// scan the REAL shipped artifacts (UI source + manifest), not hand-built fixtures.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const UI_DIR = join(import.meta.dir, "ui")
const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")

/** Every string literal passed as the tool name to invokeTool / limitedInvoke
 *  across the UI source. Matches both `invokeTool<T>("name"` and
 *  `limitedInvoke<T>("name"` (and the untyped forms). */
function collectUiToolCalls(): Set<string> {
  const names = new Set<string>()
  const pattern = /(?:invokeTool|limitedInvoke)\s*(?:<[^>]*>)?\s*\(\s*["']([a-z0-9_]+)["']/g
  for (const file of readdirSync(UI_DIR)) {
    if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue
    if (file.includes(".test.")) continue
    const src = readFileSync(join(UI_DIR, file), "utf8")
    for (const m of src.matchAll(pattern)) {
      if (m[1]) names.add(m[1])
    }
  }
  return names
}

function manifestToolNames(): Set<string> {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    tools?: Record<string, unknown>
  }
  return new Set(Object.keys(manifest.tools ?? {}))
}

describe("ads UI tool-call closure", () => {
  it("finds the UI tool calls (sanity: the scan is not empty)", () => {
    expect(collectUiToolCalls().size).toBeGreaterThan(5)
  })

  it("every tool the UI invokes is registered in app.manifest.json", () => {
    const declared = manifestToolNames()
    const called = collectUiToolCalls()
    const unregistered = [...called].filter((name) => !declared.has(name))
    expect(
      unregistered,
      `UI calls tools missing from the manifest: ${unregistered.join(", ")}`,
    ).toEqual([])
  })

  it("registers pending_approvals_list (the widget the dashboard reads)", () => {
    // Regression guard: the dashboard's Pending Approvals tile invokes
    // pending_approvals_list; it must be a real registered ads tool, not a
    // 404-on-every-load call into the void.
    expect(manifestToolNames().has("pending_approvals_list")).toBe(true)
    expect(collectUiToolCalls().has("pending_approvals_list")).toBe(true)
  })
})
