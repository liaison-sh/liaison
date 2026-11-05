// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UI tool-call closure oracle: every tool the boxtal UI invokes (via
// invokeTool) MUST be a registered tool in app.manifest.json. A UI that calls
// an unregistered tool 404s that widget on every load ("tool boxtal:<name>
// not registered") -- the regression this oracle closes. The UI's tool-call
// surface must be closed under the manifest's declared tools.
//
// Mirrors bundled-apps/ads/src/ui-tool-closure.test.ts: scan the REAL shipped
// artifacts (UI source + manifest), not hand-built fixtures.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"

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
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { tools?: Record<string, unknown> }
  return new Set(Object.keys(manifest.tools ?? {}))
}

describe("boxtal UI tool-call closure", () => {
  it("finds the UI tool calls (sanity: the scan is not empty)", () => {
    expect(collectUiToolCalls().size).toBeGreaterThan(5)
  })

  it("every tool the UI invokes is registered in app.manifest.json", () => {
    const declared = manifestToolNames()
    const called = collectUiToolCalls()
    const unregistered = [...called].filter((name) => !declared.has(name))
    expect(unregistered, `UI calls tools missing from the manifest: ${unregistered.join(", ")}`).toEqual([])
  })

  it("registers every prep-grid tool the new dashboard invokes", () => {
    const declared = manifestToolNames()
    const called = collectUiToolCalls()
    for (const tool of [
      "prep_list",
      "prep_sync",
      "prep_set_category",
      "prep_select_offer",
      "prep_exclude",
      "prep_restore",
      "prep_set_status",
      "prep_add_shipment",
      "prep_order_prefill",
      "prep_document_pdf",
      "create_shipment",
      "print_pack",
      "get_documents",
      "shipment_draft_set_package",
    ]) {
      expect(declared.has(tool), `${tool} missing from app.manifest.json`).toBe(true)
      expect(called.has(tool), `${tool} not actually invoked by the boxtal UI`).toBe(true)
    }
  })

  // The UI's invokeTool bridge can only reach THIS app's tools. A NAMESPACED name
  // ("invoicing:documents_download_pdf") is another app's tool: it is legal from a handler through
  // the cross-app bridge, and a 404 from the browser. Nearly shipped exactly that on the prep
  // grid's invoice download, which is why this is an oracle and not a review note.
  it("never invokes a cross-app (namespaced) tool from the browser", () => {
    const pattern = /(?:invokeTool|limitedInvoke)\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g
    const offenders: string[] = []
    for (const file of readdirSync(UI_DIR)) {
      if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue
      if (file.includes(".test.")) continue
      const src = readFileSync(join(UI_DIR, file), "utf8")
      for (const m of src.matchAll(pattern)) {
        if (m[1]?.includes(":")) offenders.push(`${file}: ${m[1]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
