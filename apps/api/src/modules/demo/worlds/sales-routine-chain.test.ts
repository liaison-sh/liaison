// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SOFTWARE AND SERVICES SALES ROUTINES PREPARE ONE REQUEST.
//
// Their tours wait for one request on Home whose last step is the reply: the
// company first, then the steps that cite it with @ref tokens. The tours'
// scripted runs synthesise every event from the tour's own bindings, so they
// passed while a real run stopped at the company: its gated result listed no
// `outputs` (no token to cite), and a uuid field refused a token, so every
// later write became a request of its own, one approval at a time. This file
// checks the chain each routine's instructions describe against the tools
// themselves: what each cited step declares, and that each citing field takes
// the token.
import { describe, expect, it } from "bun:test"
import { buildRefToken } from "@liaison/shared"
import { z } from "zod"
import { registerCompanyTools } from "~/modules/agent/tools/company-tools"
import { toolRegistry } from "~/modules/apps/app-registries"
import { validateParamsForTool } from "~/modules/apps/execute-tool"
import agreementsManifest from "../../../../../../bundled-apps/agreements/app.manifest.json"
import invoicingManifest from "../../../../../../bundled-apps/invoicing/app.manifest.json"
import projectsManifest from "../../../apps/projects/app.manifest.json"
import { prospectRoutinePrompt } from "./saas/scenario-routines"
import { studioProposalRoutinePrompt } from "./studio/scenario-routines"

const ORG = "00000000-0000-4000-8000-00000000c4a1"
const HEAD = "0f2c6a3e-58b1-4d7e-9a0c-2b1e7d4c9f10"
const ISSUER = "11111111-2222-4333-8444-555555555555"

registerCompanyTools(ORG)

/** Every `outputs.<key>` a routine's instructions tell the model to copy. */
function citedOutputs(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/outputs\.([a-z_]+)/g)].map((m) => m[1] as string))]
}

const manifestTool = (params: unknown) => ({
  handler: { bundlePath: "b", exportName: "e" },
  params,
})

const declared = (app: string, name: string): string[] =>
  toolRegistry.get([ORG, app, name])?.referenceableOutputs ?? []

const QUOTE_OUTPUTS = (
  invoicingManifest.tools as unknown as Record<string, { referenceableOutputs?: string[] }>
).quote_create_and_issue?.referenceableOutputs

describe("the sales routines chain their writes into one request", () => {
  it("the company step lists the outputs the instructions cite", () => {
    const company = declared("kernel", "companies_write")
    const quote = QUOTE_OUTPUTS ?? []
    for (const prompt of [prospectRoutinePrompt(ISSUER), studioProposalRoutinePrompt()]) {
      for (const key of citedOutputs(prompt)) {
        expect(company.includes(key) || quote.includes(key), `outputs.${key}`).toBe(true)
      }
    }
    expect(company).toEqual(expect.arrayContaining(["id", "name"]))
  })

  // Once the first write is proposed, a call that only reads is not run
  // (agent-service.ts ROUTINE_CHAIN_ONLY_RESULT): a read the chain needs comes
  // before it, or the run pauses half way (demo walk 2026-11-25).
  it("every read the chain needs comes before its first write", () => {
    const prompt = studioProposalRoutinePrompt()
    const firstWrite = prompt.indexOf("call kernel__companies_write")
    expect(firstWrite).toBeGreaterThan(0)
    expect(prompt.indexOf("agreements__templates_list")).toBeGreaterThan(0)
    expect(prompt.lastIndexOf("agreements__templates_list")).toBeLessThan(firstWrite)
  })

  it("every field that cites the company takes its id token", () => {
    const idToken = buildRefToken(HEAD, "id")
    // The proposal: the agreements app's company_id is a uuid.
    const agreement = manifestTool(agreementsManifest.tools.agreement_create.params)
    expect(() =>
      validateParamsForTool(agreement as never, ORG, "agreements", "agreement_create", {
        kind: "sow",
        title: "Booking site",
        company_id: idToken,
      }),
    ).not.toThrow()
    // The deal.
    const deal = manifestTool(
      (projectsManifest.tools as unknown as Record<string, { params: unknown }>).create?.params,
    )
    expect(() =>
      validateParamsForTool(deal as never, ORG, "projects", "create", {
        title: "Booking site",
        projectName: "Sales pipeline",
        companyId: idToken,
      }),
    ).not.toThrow()
    // The contact: the kernel's Zod uuid.
    const contactsWrite = toolRegistry.get([ORG, "kernel", "contacts_write"]) ?? {
      handler: async () => ({}),
      params: z.object({
        name: z.string().optional(),
        email: z.string().email().optional(),
        companyId: z.string().uuid().nullable().optional(),
      }),
    }
    const out = validateParamsForTool(contactsWrite as never, ORG, "kernel", "contacts_write", {
      name: "Ana Prospect",
      email: "ana@hotel-group.example",
      companyId: idToken,
    }) as { companyId: string }
    expect(out.companyId).toBe(idToken)
  })

  it("a uuid field still refuses a value that is neither a uuid nor a whole token", () => {
    const agreement = manifestTool(agreementsManifest.tools.agreement_create.params)
    for (const bad of ["not-an-id", `see ${buildRefToken(HEAD, "id")}`]) {
      expect(() =>
        validateParamsForTool(agreement as never, ORG, "agreements", "agreement_create", {
          kind: "sow",
          title: "Booking site",
          company_id: bad,
        }),
      ).toThrow()
    }
  })
})
