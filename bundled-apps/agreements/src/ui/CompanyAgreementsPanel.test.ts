// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An agreement's links and the company page's Agreements section: each record an agreement names
// opens its own page, and the company page lists the company's agreements.
import { afterEach, describe, expect, it } from "bun:test"
import manifest from "../../app.manifest.json"
import { COMPANY_AGREEMENTS_LIMIT, loadCompanyAgreements } from "./CompanyAgreementsPanel"
import { linkedTargets } from "./Detail"
import type { AgreementDetail } from "./model"

const COMPANY = "44444444-4444-4444-8444-444444444444"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
})

describe("what an agreement is linked to", () => {
  it("names its company, contact, deal, project and quote, each with its own page", () => {
    const a = {
      company_id: COMPANY,
      contact_id: "c1",
      deal_task_id: "t1",
      project_id: "p1",
      quote_document_id: "q1",
    } as unknown as AgreementDetail["agreement"]
    expect(linkedTargets(a).map((t) => [t.key, t.path])).toEqual([
      ["company", `/contacts/companies/${COMPANY}`],
      ["contact", "/contacts/c1"],
      ["deal", "/projects/tasks/t1"],
      ["project", "/projects/p1"],
      ["quote", "/invoicing/document/q1"],
    ])
    expect(linkedTargets({ company_id: null } as AgreementDetail["agreement"])).toEqual([])
  })
})

describe("the company page's Agreements section", () => {
  it("lists the company's agreements, and none when the read fails", async () => {
    const asked: Array<Record<string, unknown>> = []
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async (_app: string, tool: string, args: Record<string, unknown>) => {
        if (tool !== "agreements_search") throw new Error(`unexpected tool: ${tool}`)
        asked.push(args)
        return { status: "ok", items: [{ id: "a1", number: "AG-1", title: "Support" }] }
      },
    }
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "agreements"
    expect((await loadCompanyAgreements(COMPANY)).map((r) => r.id)).toEqual(["a1"])
    expect(asked).toEqual([{ company_id: COMPANY, limit: COMPANY_AGREEMENTS_LIMIT }])
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async () => {
        throw new Error("boom")
      },
    }
    expect(await loadCompanyAgreements(COMPANY)).toEqual([])
  })

  it("is declared on the company page for readers of agreements", () => {
    const slots = (
      manifest as { slots?: Record<string, { panels?: Array<Record<string, unknown>> }> }
    ).slots
    expect(slots?.company_detail?.panels?.[0]).toMatchObject({
      component: "CompanyAgreementsPanel",
      visibility_scope: "agreements:agreements:read",
    })
  })
})
