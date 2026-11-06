// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Can a tool be found by what people say? This runs the real ranker over the real
// catalog (kernel and in-tree apps as registered, bundled apps from their manifests)
// with the phrases in tool-bench/corpus.json:
//
// - `seed`: phrases people say and forms a model types, some of which the keyword
//   lists were written from. An upper bound.
// - `screen`: the product's own labels, read while writing keywords. Same.
// - `heldout`: the action labels of the approval screens, French and English, not
//   read while writing keywords. Every line is a label and the tool it names.
//
// The floors below are what the ranker reached when they were set. A floor moves up
// when a change earns it; a fall names the phrases that fell.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { sql } from "~/db"
import { isDeferredTool } from "~/modules/agent/tools/tool-bridge"
import { rankDeferredTools } from "~/modules/agent/tools/tool-rank"
import {
  agentInstructionsRegistry,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { orgSetupStamp } from "~/modules/apps/setup-stamp"
import corpus from "./tool-bench/corpus.json"

const ORG_ID = "00000000-0000-0000-0000-000000db0002"
const BUNDLED_APPS = join(import.meta.dir, "../../../../../../bundled-apps")
const LEFT_OUT_APPS = new Set(["example", "contacts"])
const ACCENT = /[àâäéèêëîïôöùûüçœæ]/i

const FLOOR_SEED = 93 // of 107
const FLOOR_SCREEN = 38 // of 40
const FLOOR_ACCENTED = 26 // of 29
const FLOOR_HELDOUT_FR = 75 // of 88
const FLOOR_HELDOUT_EN = 87 // of 88

interface CatalogTool {
  sdkName: string
  toolName: string
  appName: string
  description: string
  keywords?: readonly string[]
}

const sdkNameOf = (app: string, tool: string) => `${app}__${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`

function registeredTools(): CatalogTool[] {
  const out: CatalogTool[] = []
  for (const [key, def] of toolRegistry.entries()) {
    if (key[0] !== ORG_ID || LEFT_OUT_APPS.has(key[1]) || key[1].startsWith("test")) continue
    if (def.agentVisible === false) continue
    if (!isDeferredTool(key[1], def) && !def.routineOnly) continue
    out.push({
      sdkName: sdkNameOf(key[1], key[2]),
      toolName: key[2],
      appName: key[1],
      description: def.description,
      ...(def.searchKeywords?.length ? { keywords: def.searchKeywords } : {}),
    })
  }
  return out
}

/** Bundled apps install from a package, so a test org has none: read their manifests. */
function bundledTools(): CatalogTool[] {
  const out: CatalogTool[] = []
  for (const dir of readdirSync(BUNDLED_APPS)) {
    let text: string
    try {
      text = readFileSync(join(BUNDLED_APPS, dir, "app.manifest.json"), "utf8")
    } catch {
      continue
    }
    const manifest = JSON.parse(text) as {
      name: string
      tools?: Record<
        string,
        {
          description?: string
          searchKeywords?: string[]
          agentVisible?: boolean
          deferLoading?: boolean
          contractOnly?: boolean
        }
      >
    }
    if (LEFT_OUT_APPS.has(manifest.name)) continue
    for (const [name, def] of Object.entries(manifest.tools ?? {})) {
      if (def.agentVisible === false || def.deferLoading === false || def.contractOnly) continue
      out.push({
        sdkName: sdkNameOf(manifest.name, name),
        toolName: name,
        appName: manifest.name,
        description: def.description ?? "",
        ...(def.searchKeywords?.length ? { keywords: def.searchKeywords } : {}),
      })
    }
  }
  return out
}

describe("a tool is found by what people say", () => {
  let catalog: CatalogTool[] = []
  let appNames = new Set<string>()

  beforeAll(async () => {
    orgSetupStamp.enabled = false
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'ToolBenchOrg', 'tool-bench-org') ON CONFLICT (id) DO NOTHING`
    await ensureAppsForOrg(ORG_ID)
    const { registerKernelAgentTools } = await import("./kernel-tools")
    await registerKernelAgentTools(ORG_ID)
    catalog = [...registeredTools(), ...bundledTools()]
    appNames = new Set(catalog.map((t) => t.appName))
    appNames.delete("kernel")
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    skillRegistry.deleteByPrefix([ORG_ID])
    agentInstructionsRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.role_scope_grants WHERE role_id IN (SELECT id FROM kernel.roles WHERE org_id = ${ORG_ID})`
    await sql`DELETE FROM kernel.user_roles WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.roles WHERE org_id = ${ORG_ID}`
    orgSetupStamp.enabled = true
  })

  /** Forms in the top 5 and the ones that are not, for the lines picked. */
  function reach(
    lines: typeof corpus,
    formsOf: (line: (typeof corpus)[number]) => string[] = (l) => l.typed,
  ) {
    const missed: string[] = []
    let forms = 0
    let found = 0
    let noHit = 0
    for (const line of lines) {
      for (const form of formsOf(line)) {
        const { ranked, all } = rankDeferredTools(catalog, form, { cap: 5, appNames })
        forms++
        if (all.length === 0) noHit++
        if (ranked.some((s) => line.any.includes(s.tool.sdkName))) found++
        else missed.push(`${line.id} "${form}" (top: ${ranked[0]?.tool.sdkName ?? "none"})`)
      }
    }
    return { forms, found, noHit, missed }
  }

  const set = (name: string) => corpus.filter((l) => l.set === name)

  it("a manifest keyword is one word", () => {
    for (const tool of catalog) {
      if (tool.appName === "kernel") continue
      for (const word of tool.keywords ?? []) expect(word, tool.sdkName).toMatch(/^\S+$/)
    }
  })

  it("every tool the corpus names is in the catalog", () => {
    const names = new Set(catalog.map((t) => t.sdkName))
    expect(corpus.flatMap((l) => l.any).filter((n) => !names.has(n))).toEqual([])
  })

  it("a keyword declared in a manifest reaches the registered tool", () => {
    expect(toolRegistry.get([ORG_ID, "tickets", "close"])?.searchKeywords).toContain("fermer")
    expect(toolRegistry.get([ORG_ID, "kernel", "assign_role"])?.searchKeywords).toContain("rôle")
  })

  it("no keyword sits on so many tools that it stops telling them apart", () => {
    const toolsOfWord = new Map<string, string[]>()
    for (const tool of catalog) {
      for (const word of tool.keywords ?? []) {
        toolsOfWord.set(word, [...(toolsOfWord.get(word) ?? []), tool.sdkName])
      }
    }
    const crowded = [...toolsOfWord].filter(([, tools]) => tools.length > 25).map(([w]) => w)
    expect(crowded).toEqual([])
  })

  it("the seed phrases reach the right tool", () => {
    const r = reach(set("seed"))
    expect(r.found, r.missed.join("\n")).toBeGreaterThanOrEqual(FLOOR_SEED)
    expect(r.noHit, r.missed.join("\n")).toBeLessThanOrEqual(1)
  })

  it("the product's screen labels reach the right tool", () => {
    const r = reach(set("screen"))
    expect(r.found, r.missed.join("\n")).toBeGreaterThanOrEqual(FLOOR_SCREEN)
    expect(r.noHit).toBe(0)
  })

  it("accented French phrases reach the right tool", () => {
    const lines = corpus.filter((l) => l.set !== "heldout" && l.lang === "fr")
    const r = reach(lines, (l) => l.typed.filter((form) => ACCENT.test(form)))
    expect(r.found, r.missed.join("\n")).toBeGreaterThanOrEqual(FLOOR_ACCENTED)
    expect(r.noHit).toBe(0)
  })

  it("the held-out labels reach the right tool, in French and in English", () => {
    const fr = reach(set("heldout").filter((l) => l.lang === "fr"))
    const en = reach(set("heldout").filter((l) => l.lang === "en"))
    expect(fr.found, fr.missed.join("\n")).toBeGreaterThanOrEqual(FLOOR_HELDOUT_FR)
    expect(en.found, en.missed.join("\n")).toBeGreaterThanOrEqual(FLOOR_HELDOUT_EN)
  })

  it("an accent typed or left out finds the same tools", () => {
    const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "")
    const names = (query: string) =>
      rankDeferredTools(catalog, query, { cap: 5, appNames }).ranked.map((s) => s.tool.sdkName)
    for (const line of corpus) {
      for (const form of line.typed) {
        // Words under 3 letters are left as typed, by design ("à" is not "a").
        if (form.split(/\s+/).some((w) => w.length < 3 && ACCENT.test(w))) continue
        if (ACCENT.test(form)) expect(names(fold(form)), form).toEqual(names(form))
      }
    }
  })
})
