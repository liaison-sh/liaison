// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Build round-trip: assert that EVERY export name the manifest references
// (tools[].handler, webhooks[].handler, webhooks[].verify, events.subscribes
// values, search.handler) is exported from the handler bundle (src/handlers),
// and that every component named in views/slots/detail is exported from the UI
// barrel (src/ui/index). This catches a missing/renamed export before freeze.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import * as handlers from "./handlers"
// NOTE: the UI barrel (src/ui/index.tsx) is NOT runtime-imported — SolidJS uses a
// compile-time JSX transform (no React-style automatic jsx/jsxDEV runtime), so
// importing a .tsx component into bun's generic test transpiler fails to resolve
// `solid-js/jsx-dev-runtime`. The UI-export check below STATICALLY parses the
// barrel's re-export names instead (the freeze build does the real solid transform;
// the invoicing/shopify round-trips regex the packed ui.js). l612.

const UI_BARREL_EXPORTS: ReadonlySet<string> = (() => {
  const src = readFileSync(join(import.meta.dir, "ui", "index.tsx"), "utf8")
  const names = new Set<string>()
  // Re-export barrel form: `export { A, B as C } from "./x"` — collect the
  // EXPORTED name (the part after `as`, else the identifier).
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    const group = m[1]
    if (!group) continue
    for (const part of group.split(",")) {
      const id = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (id) names.add(id)
    }
  }
  return names
})()

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as {
  tools?: Record<string, { handler: string; preflight?: string }>
  webhooks?: Record<string, { handler: string; verify: string }>
  events?: { subscribes?: Record<string, string> }
  search?: { handler: string }
  views?: {
    activityBar?: { icon?: string }
    tabTypes?: Record<string, { component?: string; sidebar?: string; icon?: string }>
    settings?: Array<{ component: string }>
    detail?: Record<string, { component: string }>
  }
  slots?: Record<string, { panels?: Array<{ component: string }> } | Record<string, { tabs?: Array<{ component: string }> }>>
}

function collectHandlerExports(): Set<string> {
  const out = new Set<string>()
  for (const t of Object.values(MANIFEST.tools ?? {})) {
    out.add(t.handler)
    // A gated tool's stage-time preflight is resolved by export name exactly like its handler, so a
    // missing/renamed preflight export must fail here and not silently disable the staging refusal.
    if (t.preflight) out.add(t.preflight)
  }
  for (const w of Object.values(MANIFEST.webhooks ?? {})) {
    out.add(w.handler)
    out.add(w.verify)
  }
  for (const v of Object.values(MANIFEST.events?.subscribes ?? {})) out.add(v)
  if (MANIFEST.search?.handler) out.add(MANIFEST.search.handler)
  return out
}

function collectUiComponents(): Set<string> {
  const out = new Set<string>()
  const v = MANIFEST.views ?? {}
  if (v.activityBar?.icon) out.add(v.activityBar.icon)
  for (const tab of Object.values(v.tabTypes ?? {})) {
    if (tab.component) out.add(tab.component)
    if (tab.sidebar) out.add(tab.sidebar)
    if (tab.icon) out.add(tab.icon)
  }
  for (const s of v.settings ?? []) out.add(s.component)
  for (const d of Object.values(v.detail ?? {})) out.add(d.component)
  for (const slot of Object.values(MANIFEST.slots ?? {})) {
    const flat = (slot as { panels?: Array<{ component: string }> }).panels
    if (flat) for (const p of flat) out.add(p.component)
    for (const inner of Object.values(slot as Record<string, { tabs?: Array<{ component: string }> }>)) {
      const tabs = inner?.tabs
      if (Array.isArray(tabs)) for (const t of tabs) out.add(t.component)
    }
  }
  return out
}

describe("build round-trip — manifest exports resolve", () => {
  it("every manifest handler export is exported from src/handlers", () => {
    const bundle = handlers as Record<string, unknown>
    for (const name of collectHandlerExports()) {
      expect(typeof bundle[name], `handler export "${name}"`).toBe("function")
    }
  })

  it("every manifest UI component is re-exported from src/ui/index", () => {
    for (const name of collectUiComponents()) {
      expect(UI_BARREL_EXPORTS.has(name), `UI component "${name}" missing from ui/index barrel`).toBe(true)
    }
  })
})
