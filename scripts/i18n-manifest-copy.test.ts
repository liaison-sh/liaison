// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App words a reader sees come from the manifests in English: the action an
// approval asks for, the app store's one-line summary, a routine template's
// description. The web client reads each in the reader's language from the
// shared catalog (`kernel.approvalActions`, `kernel.appSummaries`,
// `kernel.routineTemplates`), keyed by app. A French walk found all three in
// English: a new gated tool, listing or template had no catalog entry. This
// pins every one of them to an entry, so the next one fails here instead.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const kernelEn = JSON.parse(
  readFileSync(join(ROOT, "packages/shared/src/i18n/locales/en/kernel.json"), "utf8"),
)

type Manifest = {
  name: string
  listing?: { summary?: string }
  tools?: Record<string, { gated?: boolean; summarizer?: unknown; conditionalGate?: unknown }>
  routines?: Record<string, { description?: string }>
}

function manifests(): Manifest[] {
  const out: Manifest[] = []
  for (const dir of ["bundled-apps", "apps/api/src/apps"]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      try {
        out.push(JSON.parse(readFileSync(join(ROOT, dir, name, "app.manifest.json"), "utf8")))
      } catch {
        // Not an app directory.
      }
    }
  }
  return out
}

describe("manifest words have a catalog entry", () => {
  const all = manifests()

  test("there are manifests to check", () => {
    expect(all.length).toBeGreaterThan(10)
  })

  test("every gated tool names its action in kernel.approvalActions", () => {
    const missing: string[] = []
    for (const m of all) {
      for (const [tool, def] of Object.entries(m.tools ?? {})) {
        if (!def.gated && !def.summarizer && !def.conditionalGate) continue
        const key = tool.replace(/\./g, "_")
        if (typeof kernelEn.approvalActions?.[m.name]?.[key] !== "string") {
          missing.push(`${m.name}.${key}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  test("every listing summary is kernel.appSummaries, word for word", () => {
    const wrong: string[] = []
    for (const m of all) {
      const summary = m.listing?.summary
      if (summary && kernelEn.appSummaries?.[m.name] !== summary) wrong.push(m.name)
    }
    expect(wrong).toEqual([])
  })

  test("every routine template has a title and its description in kernel.routineTemplates", () => {
    const wrong: string[] = []
    for (const m of all) {
      for (const [key, def] of Object.entries(m.routines ?? {})) {
        const entry = kernelEn.routineTemplates?.[m.name]?.[key]
        if (typeof entry?.title !== "string" || entry.description !== def.description) {
          wrong.push(`${m.name}.${key}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})
