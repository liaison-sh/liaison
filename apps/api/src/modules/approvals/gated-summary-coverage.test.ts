// SPDX-License-Identifier: FSL-1.1-ALv2
// Every gated tool has a human summary (the card title never falls back to
// the raw tool id): each kernel gated tool has a registered summarizer, and
// each gated tool of every in-tree and bundled app manifest declares a
// `summarizer` or an `approvalCard.summary` title template.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { approvalSummarizerRegistry, toolRegistry } from "~/modules/apps/app-registries"

const ORG_ID = "00000000-0000-4000-8000-00000000c0de"
const REPO = resolve(import.meta.dir, "../../../../..")
const MANIFEST_ROOTS = [join(REPO, "apps/api/src/apps"), join(REPO, "bundled-apps")]

interface ManifestTool {
  gated?: boolean
  conditionalGate?: boolean
  summarizer?: unknown
  approvalCard?: { summary?: unknown }
}

function manifestGatedTools(): Array<{ app: string; tool: string; def: ManifestTool }> {
  const out: Array<{ app: string; tool: string; def: ManifestTool }> = []
  for (const root of MANIFEST_ROOTS) {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, "app.manifest.json")
      if (!existsSync(file)) continue
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        name?: string
        tools?: Record<string, ManifestTool> | Array<ManifestTool & { name: string }>
      }
      const tools = manifest.tools ?? {}
      const entries: Array<[string, ManifestTool]> = Array.isArray(tools)
        ? tools.map((t) => [t.name, t])
        : Object.entries(tools)
      for (const [tool, def] of entries) {
        if (def.gated === true || def.conditionalGate === true)
          out.push({ app: manifest.name ?? dir, tool, def })
      }
    }
  }
  return out
}

describe("every gated tool has a human summary", () => {
  it("each gated manifest tool declares a summarizer or an approvalCard title template", () => {
    const gated = manifestGatedTools()
    expect(gated.length).toBeGreaterThan(50)
    const missing = gated
      .filter(
        ({ def }) =>
          !(typeof def.summarizer === "string" && def.summarizer.length > 0) &&
          !(typeof def.approvalCard?.summary === "string" && def.approvalCard.summary.length > 0),
      )
      .map(({ app, tool }) => `${app}:${tool}`)
    expect(missing).toEqual([])
  })

  describe("kernel tools", () => {
    beforeAll(async () => {
      const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
      const { registerSkillRoutineTools } = await import(
        "~/modules/agent/tools/skills-routines-tools"
      )
      await registerKernelAgentTools(ORG_ID)
      await registerSkillRoutineTools(ORG_ID)
    })
    afterAll(() => {
      toolRegistry.deleteByPrefix([ORG_ID])
      approvalSummarizerRegistry.deleteByPrefix([ORG_ID])
    })

    it("each gated kernel tool has a registered summarizer", () => {
      const gated: string[] = []
      for (const [[orgId, appName, name], entry] of toolRegistry.entries()) {
        if (orgId !== ORG_ID || appName !== "kernel") continue
        const def = entry as { gated?: boolean; conditionalGate?: boolean }
        if (def.gated === true || def.conditionalGate === true) gated.push(name)
      }
      expect(gated.length).toBeGreaterThan(10)
      const missing = gated.filter(
        (name) => !approvalSummarizerRegistry.get([ORG_ID, "kernel", name]),
      )
      expect(missing).toEqual([])
    })
  })
})
