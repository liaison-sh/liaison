// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every routine template Liaison ships, the kernel's, the core apps' and the bundled apps', carries
// the reads its tools make before they act. A routine runs capped to its own scopes: a template that
// drafts a mail without `mail:accounts:read` names no mailbox, stages nothing, and every tick ends
// green.
import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  KERNEL_TEMPLATE_APP,
  registerKernelRoutineTemplates,
} from "~/modules/agent/routines/kernel-routine-templates"
import { missingRunReads, templateRunReadGaps } from "~/modules/agent/routines/routine-run-reads"
import { routineTemplateRegistry } from "~/modules/apps/app-registries"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")
const ORG = "00000000-0000-4000-8000-00000000d0f2"

interface Template {
  name: string
  promptTemplate?: string
  flow?: unknown
  scopes?: string[]
}

function manifestTemplates(): Template[] {
  const out: Template[] = []
  for (const root of ["bundled-apps", "apps/api/src/apps"]) {
    for (const app of readdirSync(join(REPO_ROOT, root))) {
      const file = join(REPO_ROOT, root, app, "app.manifest.json")
      if (!existsSync(file)) continue
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        routines?: Record<string, { promptTemplate?: string; flow?: unknown; scopes?: string[] }>
      }
      for (const [key, t] of Object.entries(manifest.routines ?? {}))
        out.push({
          name: `${app}/${key}`,
          promptTemplate: t.promptTemplate,
          flow: t.flow,
          scopes: t.scopes,
        })
    }
  }
  return out
}

function kernelTemplates(): Template[] {
  registerKernelRoutineTemplates(ORG)
  return [...routineTemplateRegistry.entriesOf(ORG)]
    .filter(([key]) => key[1] === KERNEL_TEMPLATE_APP)
    .map(([key, t]) => ({
      name: `${KERNEL_TEMPLATE_APP}/${key[2]}`,
      promptTemplate: t.promptTemplate,
      scopes: t.scopes,
    }))
}

describe("routine templates", () => {
  it("each carries the reads of the tools it names", () => {
    const templates = [...kernelTemplates(), ...manifestTemplates()]
    const names = templates.map((t) => t.name)
    expect(names).toContain("kernel/deal-followups")
    expect(names).toContain("stripe/failed-payments")
    const gaps = templates.flatMap((t) => templateRunReadGaps(t).map((gap) => `${t.name} ${gap}`))
    expect(gaps).toEqual([])
  })

  it("a template that names a mail tool without its reads is found, whichever way it names it", () => {
    const write = ["mail:conversations:write"]
    expect(missingRunReads({ text: "draft one with mail__compose, then", scopes: write })).toEqual([
      "mail__compose: mail:accounts:read",
    ])
    expect(missingRunReads({ text: "call mail:reply.", scopes: write })).toEqual([
      "mail__reply: mail:accounts:read",
    ])
    expect(missingRunReads({ text: "mail__forward it", scopes: [] })).toEqual([
      "mail__forward: mail:conversations:read",
      "mail__forward: mail:accounts:read",
    ])
    expect(
      missingRunReads({ text: "mail__compose", scopes: [...write, "mail:accounts:read"] }),
    ).toEqual([])
    expect(missingRunReads({ text: "read the mail composer", scopes: [] })).toEqual([])
  })

  it("an app's template is read in its prompt and its steps, as registration reads it", () => {
    expect(templateRunReadGaps({ promptTemplate: "call mail__compose", scopes: [] })).toEqual([
      "mail__compose: mail:accounts:read",
    ])
    expect(
      templateRunReadGaps({ flow: { steps: [{ tool: "mail:compose" }] }, scopes: [] }),
    ).toEqual(["mail__compose: mail:accounts:read"])
    expect(templateRunReadGaps({})).toEqual([])
  })
})
