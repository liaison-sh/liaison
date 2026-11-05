// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Build round-trip: assert that EVERY export name the manifest references
// (tools[].handler, events.subscribes values, jobs[].handler, search.handler) is
// exported from the handler bundle (src/handlers), and that every component named
// in views/slots/detail is exported from the UI barrel (src/ui/index). This
// catches a missing/renamed export before freeze. Pennylane declares no
// webhooks/search in v1. Its settings are a declarative connector card the
// kernel renders, so it ships no UI bundle and names no UI component.
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as handlers from "./handlers"

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as {
  tools?: Record<string, { handler: string }>
  webhooks?: Record<string, { handler: string; verify: string }>
  events?: { subscribes?: Record<string, string> }
  jobs?: Record<string, { handler: string }>
  search?: { handler: string }
  views?: {
    activityBar?: { icon?: string }
    tabTypes?: Record<string, { component?: string; sidebar?: string; icon?: string }>
    settings?: Array<{ component: string }>
    detail?: Record<string, { component: string }>
  }
  slots?: Record<
    string,
    { panels?: Array<{ component: string }> } | Record<string, { tabs?: Array<{ component: string }> }>
  >
}

function collectHandlerExports(): Set<string> {
  const out = new Set<string>()
  for (const t of Object.values(MANIFEST.tools ?? {})) out.add(t.handler)
  for (const w of Object.values(MANIFEST.webhooks ?? {})) {
    out.add(w.handler)
    out.add(w.verify)
  }
  for (const v of Object.values(MANIFEST.events?.subscribes ?? {})) out.add(v)
  for (const j of Object.values(MANIFEST.jobs ?? {})) out.add(j.handler)
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

  it("names no UI component and ships no UI bundle", () => {
    expect([...collectUiComponents()]).toEqual([])
    expect(existsSync(join(import.meta.dir, "..", "ui.tsx"))).toBe(false)
    expect(existsSync(join(import.meta.dir, "ui"))).toBe(false)
  })
})
