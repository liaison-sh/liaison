// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The timeline is read from each app when asked and stored nowhere: no app
// subscribes to an event to build one.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import contactsEn from "../../../../../packages/shared/src/i18n/locales/en/contacts.json"

const ROOTS = [
  join(import.meta.dir, "../../apps"),
  join(import.meta.dir, "../../../../../bundled-apps"),
]

function manifests(): Array<{ path: string; manifest: Record<string, unknown> }> {
  const out: Array<{ path: string; manifest: Record<string, unknown> }> = []
  for (const root of ROOTS) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, entry.name, "app.manifest.json")
      try {
        out.push({ path, manifest: JSON.parse(readFileSync(path, "utf8")) })
      } catch {
        // No manifest in this directory.
      }
    }
  }
  return out
}

describe("timeline sources", () => {
  it("no app subscribes an event to build a timeline", () => {
    const found = manifests()
    expect(found.length).toBeGreaterThan(5)
    const offending: string[] = []
    for (const { path, manifest } of found) {
      const events = (manifest.events ?? {}) as { subscribes?: unknown }
      const text = JSON.stringify(events.subscribes ?? [])
      if (/timeline|activity/i.test(text)) offending.push(path)
    }
    expect(offending).toEqual([])
  })

  it("every app that declares a timeline source declares it on a read-only tool of its own", () => {
    for (const { path, manifest } of manifests()) {
      const sources = (manifest.activitySources ?? []) as Array<{ tool: string }>
      const tools = (manifest.tools ?? {}) as Record<
        string,
        { readOnly?: boolean; gated?: boolean }
      >
      for (const source of sources) {
        expect({ path, tool: source.tool, readOnly: tools[source.tool]?.readOnly }).toEqual({
          path,
          tool: source.tool,
          readOnly: true,
        })
      }
    }
  })

  it("the timeline's chip for the projects rows names tasks and projects, not deals alone", () => {
    // The projects source reads tasks and projects as well as deals: a task row is no deal.
    const chips = contactsEn.activity.sources as Record<string, string>
    const projects = manifests()
      .flatMap(
        ({ manifest }) =>
          (manifest.activitySources ?? []) as Array<{ filterKey: string; label: string }>,
      )
      .find((s) => s.filterKey === "projects")
    expect(projects?.label).toBe("Deals and projects")
    expect(chips.projects).toBe(projects?.label)
  })
})
