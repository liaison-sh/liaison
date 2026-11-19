// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The company page's Money section: declared on the kernel's `company_detail`
// slot for a reader of documents, and reading only the company's documents.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import manifest from "../../app.manifest.json"
import {
  COMPANY_MONEY_LIMIT,
  companyMoneyDate,
  companyMoneyTotal,
  loadCompanyMoney,
  loadCompanySchedules,
} from "./CompanyMoneyPanel"

const LUMEN = "44444444-4444-4444-8444-444444444444"
const OTHER = "55555555-5555-4555-8555-555555555555"

const DOCS: Record<string, Array<Record<string, unknown>>> = {
  [LUMEN]: [
    {
      id: "inv-lumen",
      type: "invoice",
      number: "INV-7",
      status: "issued",
      currency: "EUR",
      grand_total_minor: "120000",
    },
  ],
  [OTHER]: [
    {
      id: "inv-other",
      type: "invoice",
      number: "INV-8",
      status: "issued",
      currency: "EUR",
      grand_total_minor: "5000",
    },
  ],
}

describe("the company page's Money section", () => {
  let calls: Array<Record<string, unknown>> = []

  beforeEach(() => {
    calls = []
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async (_app: string, tool: string, args: Record<string, unknown>) => {
        if (tool !== "documents_search") throw new Error(`unexpected tool: ${tool}`)
        calls.push(args)
        // The read filters by company (reads.ts): a call without one would get every document.
        return args.company_id ? (DOCS[String(args.company_id)] ?? []) : Object.values(DOCS).flat()
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: test-bound app name for the `app` namespace.
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = "invoicing"
  })

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: clear the global host slot.
    ;(globalThis as any).__liaisonHost = undefined
    // biome-ignore lint/suspicious/noExplicitAny: clear the bound app name.
    ;(globalThis as any).__LIAISON_TEST_APP_NAME = undefined
  })

  it("the money panel lists only this company's documents", async () => {
    const rows = await loadCompanyMoney(LUMEN)
    expect(rows.map((r) => r.id)).toEqual(["inv-lumen"])
    expect(calls).toEqual([{ company_id: LUMEN, limit: COMPANY_MONEY_LIMIT }])
  })

  it("writes dates and totals the way the rest of the page does, not as stored", () => {
    expect(companyMoneyDate("2026-06-29", "en-GB")).toBe("29 Jun 2026")
    expect(companyMoneyDate("2026-06-29T22:30:00.000Z", "en-GB")).toBe("29 Jun 2026")
    expect(companyMoneyDate(null, "en-GB")).toBe("-")
    const issued = { id: "i", type: "invoice", status: "issued", currency: "EUR" }
    expect(companyMoneyTotal({ ...issued, grand_total_minor: "1920000" }, "en-US")).toBe(
      "€19,200.00",
    )
    expect(companyMoneyTotal({ ...issued, grand_total_minor: "1920000" }, "fr-FR")).toContain("19")
    expect(companyMoneyTotal({ ...issued, grand_total_minor: "1920000" }, "en-US")).not.toContain(
      "EUR",
    )
    expect(
      companyMoneyTotal({ ...issued, currency: "JPY", grand_total_minor: 5000 }, "en-US"),
    ).toBe("¥5,000")
  })

  it("lists the schedules that bill this company, ended ones left out", async () => {
    const asked: Array<Record<string, unknown>> = []
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async (_app: string, tool: string, args: Record<string, unknown>) => {
        if (tool !== "recurring_list") throw new Error(`unexpected tool: ${tool}`)
        asked.push(args)
        return {
          rows: [
            { id: "s-live", status: "active", lines: [], next_issue_on: "2027-01-31" },
            { id: "s-ended", status: "ended", lines: [], next_issue_on: null },
          ],
        }
      },
    }
    const rows = await loadCompanySchedules(LUMEN)
    expect(rows.map((r) => r.id)).toEqual(["s-live"])
    expect(asked).toEqual([{ company_id: LUMEN, limit: COMPANY_MONEY_LIMIT }])
  })

  it("a failed read shows the empty section rather than breaking the page", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = {
      invokeTool: async () => {
        throw new Error("boom")
      },
    }
    expect(await loadCompanyMoney(LUMEN)).toEqual([])
  })

  it("is declared on the company page's Money group for readers of documents", () => {
    const slots = (
      manifest as { slots?: Record<string, { panels?: Array<Record<string, unknown>> }> }
    ).slots
    const panel = slots?.company_detail?.panels?.find((p) => p.id === "invoicing-money")
    expect(panel).toMatchObject({
      component: "CompanyMoneyPanel",
      group: "money",
      visibility_scope: "invoicing:documents:read",
    })
  })
})
