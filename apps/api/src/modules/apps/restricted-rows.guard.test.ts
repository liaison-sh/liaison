// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every agent-visible read of an app whose rows can be closed to the organization declares
// `restrictedRows`, so the kernel stamps the turn when it returns such a row, or says here why
// it never returns one. A new read tool of such an app fails this guard until it does either.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const REPO = join(import.meta.dir, "../../../../..")

/** Reads that never return a restricted row, with the reason. */
const NO_RESTRICTED_ROWS: Record<string, string> = {
  "agreements.templates_list": "templates are org-wide documents, never closed to the organization",
  "agreements.template_get": "templates are org-wide documents, never closed to the organization",
}

/** Apps whose closed rows are hand-written in a migration rather than `sharedRows`. */
const MIGRATION_RESTRICTED_APPS = new Set(["knowledge"])

interface Tool {
  readOnly?: boolean
  agentVisible?: boolean
  restrictedRows?: { entity: string; idPath: string }
}
interface Manifest {
  name: string
  tools?: Record<string, Tool>
  schema?: Record<string, { sharedRows?: unknown }>
}

function manifests(): Manifest[] {
  const out: Manifest[] = []
  for (const dir of ["bundled-apps", "apps/api/src/apps"]) {
    for (const name of readdirSync(join(REPO, dir))) {
      try {
        out.push(JSON.parse(readFileSync(join(REPO, dir, name, "app.manifest.json"), "utf8")))
      } catch {
        // Not an app directory.
      }
    }
  }
  return out
}

describe("restricted rows guard", () => {
  it("every agent-visible read of an app with closable rows declares restrictedRows or a reason", () => {
    const missing: string[] = []
    let checked = 0
    for (const m of manifests()) {
      const closable =
        MIGRATION_RESTRICTED_APPS.has(m.name) ||
        Object.values(m.schema ?? {}).some((t) => t && t.sharedRows !== undefined)
      if (!closable) continue
      for (const [name, tool] of Object.entries(m.tools ?? {})) {
        if (tool.readOnly !== true || tool.agentVisible === false) continue
        checked += 1
        if (tool.restrictedRows) continue
        if (NO_RESTRICTED_ROWS[`${m.name}.${name}`]) continue
        missing.push(`${m.name}.${name}`)
      }
    }
    expect(checked).toBeGreaterThan(0)
    expect(missing).toEqual([])
  })

  it("every stated reason still names a read tool that exists", () => {
    const tools = new Set(
      manifests().flatMap((m) => Object.keys(m.tools ?? {}).map((t) => `${m.name}.${t}`)),
    )
    expect(Object.keys(NO_RESTRICTED_ROWS).filter((k) => !tools.has(k))).toEqual([])
  })
})
