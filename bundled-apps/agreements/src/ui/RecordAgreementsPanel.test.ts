// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agreements a deal or a project holds, on its own page: the deal says how many link to it,
// the project page links each agreement, its company and its quote.
import { afterEach, describe, expect, it } from "bun:test"
import manifest from "../../app.manifest.json"
import { loadRecordAgreements, RECORD_AGREEMENTS_LIMIT } from "./RecordAgreementsPanel"

const DEAL = "11111111-1111-4111-8111-111111111111"
const PROJECT = "22222222-2222-4222-8222-222222222222"
const COMPANY = "33333333-3333-4333-8333-333333333333"
const QUOTE = "44444444-4444-4444-8444-444444444444"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
})

function host(rows: Array<{ id: string }>, detail: Record<string, Record<string, unknown>>) {
  const asked: Array<[string, Record<string, unknown>]> = []
  ;(globalThis as any).__liaisonHost = {
    invokeTool: async (_app: string, tool: string, args: Record<string, unknown>) => {
      asked.push([tool, args])
      if (tool === "activity_read") return { rows }
      if (tool === "agreement_get") {
        const agreement = detail[String(args.id)]
        if (!agreement) return { status: "error", error: { code: "not_found", message: "gone" } }
        return { agreement }
      }
      throw new Error(`unexpected tool: ${tool}`)
    },
  }
  ;(globalThis as any).__LIAISON_TEST_APP_NAME = "agreements"
  return asked
}

describe("the agreements of a deal or a project", () => {
  it("a deal lists how many documents link to it", async () => {
    const asked = host([{ id: "a1" }, { id: "a2" }], {
      a1: { id: "a1", number: "AG-1", title: "Support", status: "signed", deal_task_id: DEAL },
      a2: { id: "a2", number: "AG-2", title: "Build", status: "sent", deal_task_id: DEAL },
    })
    const out = await loadRecordAgreements({ dealId: DEAL })
    expect(out.count).toBe(2)
    expect(out.rows.map((r) => r.number)).toEqual(["AG-1", "AG-2"])
    expect(asked[0]).toEqual(["activity_read", { dealIds: [DEAL], limit: RECORD_AGREEMENTS_LIMIT }])
  })

  it("the project page links its company, agreement and quote", async () => {
    host([{ id: "a1" }], {
      a1: {
        id: "a1",
        number: "AG-1",
        title: "Support",
        status: "signed",
        company_id: COMPANY,
        project_id: PROJECT,
        quote_document_id: QUOTE,
      },
    })
    const out = await loadRecordAgreements({ projectId: PROJECT })
    expect(out.count).toBe(1)
    expect(out.rows[0]?.path).toBe("/agreements/agreement/a1")
    // The project itself is the page it sits on: only the company and the quote link out.
    expect(out.rows[0]?.links.map((l) => [l.key, l.path])).toEqual([
      ["company", `/contacts/companies/${COMPANY}`],
      ["quote", `/invoicing/document/${QUOTE}`],
    ])
  })

  it("says nothing when the read fails, and an agreement it can no longer read is left out", async () => {
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async () => {
        throw new Error("down")
      },
    }
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "agreements"
    expect(await loadRecordAgreements({ projectId: PROJECT })).toEqual({ count: 0, rows: [] })
    host([{ id: "a1" }, { id: "gone" }], {
      a1: { id: "a1", number: "AG-1", title: "Support", status: "signed" },
    })
    expect((await loadRecordAgreements({ dealId: DEAL })).rows.map((r) => r.id)).toEqual(["a1"])
  })

  it("is declared on the project page and in a task's actions for readers of agreements", () => {
    const slots = (
      manifest as {
        slots?: Record<
          string,
          { panels?: Array<Record<string, unknown>>; actions?: Array<Record<string, unknown>> }
        >
      }
    ).slots
    expect(slots?.["project:detail:panel"]?.panels?.[0]).toMatchObject({
      component: "ProjectAgreementsPanel",
      visibility_scope: "agreements:agreements:read",
    })
    expect(slots?.["project:task:actions"]?.actions?.[0]).toMatchObject({
      component: "DealAgreementsCount",
      visibility_scope: "agreements:agreements:read",
    })
  })
})
