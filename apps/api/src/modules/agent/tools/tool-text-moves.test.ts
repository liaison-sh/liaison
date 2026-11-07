// SPDX-License-Identifier: FSL-1.1-ALv2
//
// TEXT MOVED OFF APP TOOLS, NOTHING LOST. Two kinds of move took text the
// model reads off app tools, word for word, into a section of the app's own
// guide that names the tool:
//
//   1. a sentence repeated word for word across two or more tools of an app
//      (the invoicing document tools share their line, customer and notes
//      rules; projects' task tools their linking rules), so a turn holding
//      several of them reads it once;
//   2. the part of a long description past its first 600 characters.
//
// The moves list (`tool-text-moves.json`) names every sentence that left a
// tool and where it went; it comes from a script run on the text before the
// move, so a sentence the mover left off shows up there and fails. Pinned
// here: each app line has a destination, its sentence is off the tool and in a
// section of that app's guide naming the tool, and that section reaches the
// model with the tool loaded, through the same selection the system prompt,
// the mid-run guide note and the MCP first result use.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  type AppGuideInput,
  normalizeAppGuide,
  renderAppGuideBlock,
  selectAppGuideParts,
} from "~/modules/agent/context/app-guide"

interface MoveLine {
  tool: string
  field: string
  sentence: string
  to: string
}

interface ManifestTool {
  description?: string
  params?: unknown
}

interface Manifest {
  name: string
  agentInstructions?: AppGuideInput
  tools: Record<string, ManifestTool>
}

const REPO = path.join(import.meta.dir, "../../../../../..")
const MOVES = JSON.parse(
  readFileSync(path.join(import.meta.dir, "tool-text-moves.json"), "utf8"),
) as { v: number; moves: MoveLine[] }

const MANIFEST_PATHS: Record<string, string> = {
  invoicing: "bundled-apps/invoicing/app.manifest.json",
  projects: "apps/api/src/apps/projects/app.manifest.json",
  tickets: "apps/api/src/apps/tickets/app.manifest.json",
  boxtal: "bundled-apps/boxtal/app.manifest.json",
  shopify: "bundled-apps/shopify/app.manifest.json",
  knowledge: "apps/api/src/apps/knowledge/app.manifest.json",
}

const manifests = new Map<string, Manifest>()
function manifestOf(app: string): Manifest {
  const cached = manifests.get(app)
  if (cached) return cached
  const rel = MANIFEST_PATHS[app]
  if (!rel) throw new Error(`no manifest path for app ${app}`)
  const m = JSON.parse(readFileSync(path.join(REPO, rel), "utf8")) as Manifest
  manifests.set(app, m)
  return m
}

const fold = (s: string) => s.replace(/\s+/g, " ").trim()

/** Every description the tool carries: its own and each one in its schema. */
function toolText(def: ManifestTool): string {
  const out: string[] = [def.description ?? ""]
  const walk = (node: unknown) => {
    if (Array.isArray(node)) for (const v of node) walk(v)
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (k === "description" && typeof v === "string") out.push(v)
        else walk(v)
      }
    }
  }
  walk(def.params)
  return fold(out.join("\n"))
}

/** The lines this test reads: moves off app tools, into that app's guide. */
const APP_LINES = MOVES.moves.filter((m) => {
  const app = m.tool.split(":")[0]
  return app in MANIFEST_PATHS
})

/**
 * The batch of the description ratchet: the heaviest descriptions an app
 * tool had, now at most the ratchet's length.
 */
const RATCHET_BATCH = [
  "tickets:search",
  "tickets:assign",
  "boxtal:create_shipment",
  "boxtal:quote",
  "boxtal:search",
  "boxtal:stuck_list",
  "boxtal:prep_list",
  "boxtal:to_prepare_list",
  "boxtal:quote_batch",
  "shopify:customers_search",
  "shopify:customers_segment_search",
  "invoicing:documents_update",
  "invoicing:credit_note_create_and_issue",
  "projects:tasks_byProject",
  "projects:createProject",
  "knowledge:create",
] as const

const RATCHET_CHARS = 600
const overRatchet = (description: string) => description.length > RATCHET_CHARS

describe("text moved off app tools", () => {
  it("lists moves for the shared sentences of invoicing and projects and for the batch", () => {
    const tools = new Set(APP_LINES.map((m) => m.tool))
    for (const t of RATCHET_BATCH) expect(tools.has(t)).toBe(true)
    expect(APP_LINES.some((m) => m.tool.startsWith("invoicing:"))).toBe(true)
    expect(APP_LINES.some((m) => m.tool.startsWith("projects:"))).toBe(true)
  })

  it("every sentence removed has a stated destination", () => {
    const missing = APP_LINES.filter((m) => !/^(guide|result|error):\S+$/.test(m.to))
    expect(missing.map((m) => `${m.tool}: ${m.sentence.slice(0, 80)}`)).toEqual([])
  })

  it("a listed sentence is no longer on its tool", () => {
    const still = APP_LINES.filter((m) => {
      const [app, name] = m.tool.split(":")
      const def = manifestOf(app).tools[name]
      return def !== undefined && toolText(def).includes(fold(m.sentence))
    })
    expect(still.map((m) => `${m.tool}: ${m.sentence.slice(0, 80)}`)).toEqual([])
  })

  it("each one in a guide is found in the section its tool points to", () => {
    const lost: string[] = []
    for (const m of APP_LINES) {
      if (!m.to.startsWith("guide:")) continue
      const [app, name] = m.tool.split(":")
      expect(m.to).toBe(`guide:${app}`)
      const guide = normalizeAppGuide(manifestOf(app).agentInstructions ?? "")
      const found = guide.sections.some(
        (s) => s.tools.includes(name) && fold(s.text).includes(fold(m.sentence)),
      )
      if (!found) lost.push(`${m.tool}: ${m.sentence.slice(0, 80)}`)
    }
    expect(lost).toEqual([])
  })

  it("each guide section reaches the model through selectAppGuideParts with its tool loaded", () => {
    const lost: string[] = []
    for (const m of APP_LINES) {
      if (!m.to.startsWith("guide:")) continue
      const [app, name] = m.tool.split(":")
      const guide = normalizeAppGuide(manifestOf(app).agentInstructions ?? "")
      const rendered = fold(
        renderAppGuideBlock(app, selectAppGuideParts(app, guide, new Set([`${app}__${name}`]))),
      )
      if (!rendered.includes(fold(m.sentence))) lost.push(`${m.tool}: ${m.sentence.slice(0, 80)}`)
    }
    expect(lost).toEqual([])
  })

  it("no sentence of this move went to a result or an error", () => {
    // A sentence moved to a result or an error is proven only by calling the
    // tool and reading that output; none of these took that path.
    expect(APP_LINES.filter((m) => !m.to.startsWith("guide:")).length).toBe(0)
  })

  it("each batch description is at most 600 characters", () => {
    const over = RATCHET_BATCH.filter((t) => {
      const [app, name] = t.split(":")
      return overRatchet(manifestOf(app).tools[name]?.description ?? "")
    })
    expect(over).toEqual([])
  })

  it("the ratchet passes 600 characters and fails 601", () => {
    expect(overRatchet("x".repeat(599))).toBe(false)
    expect(overRatchet("x".repeat(600))).toBe(false)
    expect(overRatchet("x".repeat(601))).toBe(true)
  })
})
