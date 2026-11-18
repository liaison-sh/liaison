// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Create invoice's handler around invoicing's answers, with the bridge and invoicing stubbed: what
// the card says when the draft is made but its issue approval could not park, and that a failed
// draft gives the card's work back.

import { describe, expect, it } from "bun:test"
import { reconcileCreateInvoice, reconcileGet } from "../handlers"

const ID = "11111111-1111-4111-8111-111111111111"

const BILLING_CONTACT = "55555555-5555-4555-8555-555555555555"

function ctxWith(draft: Record<string, unknown>, prepared: Record<string, unknown> = {}) {
  const steps: string[] = []
  const calls: string[] = []
  const bodies: Record<string, Record<string, unknown>> = {}
  const ctx = {
    projects_reconcileCreate: async (json: string) => {
      const input = JSON.parse(json) as { step: string }
      steps.push(input.step)
      if (input.step === "prepare") {
        return JSON.stringify({
          reconciliationId: ID,
          revision: 1,
          projectId: "22222222-2222-4222-8222-222222222222",
          projectName: "Maison Delorme platform",
          basis: "daily",
          companyId: "33333333-3333-4333-8333-333333333333",
          rateMinor: 93000,
          currency: "EUR",
          hoursPerDayMinutes: 420,
          lines: [{ billMinutes: 1260 }],
          contactId: BILLING_CONTACT,
          ...prepared,
        })
      }
      if (input.step === "finish") {
        return JSON.stringify({ reconciliationId: ID, revision: 1, state: "drafted" })
      }
      return JSON.stringify({ ok: true })
    },
    executeTool: async (tool: string, json: string) => {
      calls.push(tool)
      bodies[tool] = JSON.parse(json) as Record<string, unknown>
      if (tool === "invoicing:preview_totals") {
        return JSON.stringify({
          status: "completed",
          result: {
            ready: true,
            missing: [],
            excl: 279000,
            vat: 55800,
            incl: 334800,
            currency: "EUR",
          },
        })
      }
      return JSON.stringify({ status: "completed", result: draft })
    },
  }
  return { ctx, steps, calls, bodies }
}

describe("Create invoice's handler", () => {
  it("when the issue approval cannot park the draft stays and the card says to issue it from the pending list", async () => {
    const { ctx, steps } = ctxWith({
      status: "completed",
      draftId: "44444444-4444-4444-8444-444444444444",
      draftTitle: "Invoice draft for Maison Delorme platform, 2026-10-01 to 2026-10-31",
      approvalId: null,
      approved: true,
      created: true,
      totals: { excl: 279000, vat: 55800, incl: 334800, currency: "EUR" },
    })
    const out = (await reconcileCreateInvoice(
      { reconciliationId: ID, revision: 1 },
      ctx as never,
    )) as Record<string, unknown>
    expect(out.error).toBeUndefined()
    expect(steps).toEqual(["prepare", "reserve", "finish"])
    expect(out.approvalId).toBeNull()
    expect(out.documentId).toBe("44444444-4444-4444-8444-444444444444")
    expect(String(out.summary)).toContain("issue it from the pending list")
    expect(String(out.message)).toContain("issue it from the pending list")
  })

  it("a draft invoicing refuses gives the reservation back and says so", async () => {
    const { ctx, steps, calls } = ctxWith({
      status: "error",
      error: { code: "nothing_billed", message: "The card bills no line. No draft was made." },
    })
    const out = (await reconcileCreateInvoice(
      { reconciliationId: ID, revision: 1 },
      ctx as never,
    )) as { error?: { code?: string; message?: string } }
    expect(out.error?.code).toBe("nothing_billed")
    expect(out.error?.message).toContain("released")
    expect(steps).toEqual(["prepare", "reserve", "release"])
    // Never the issue tool: issuing is a person's act, elsewhere.
    expect(calls).not.toContain("invoicing:invoice_issue")
  })

  it("Create drafts the invoice to the billing contact of the project's company", async () => {
    const { ctx, bodies } = ctxWith({
      status: "completed",
      draftId: "44444444-4444-4444-8444-444444444444",
      approvalId: "66666666-6666-4666-8666-666666666666",
      approved: true,
      created: true,
      totals: { excl: 279000, vat: 55800, incl: 334800, currency: "EUR" },
    })
    const out = (await reconcileCreateInvoice(
      { reconciliationId: ID, revision: 1 },
      ctx as never,
    )) as Record<string, unknown>
    expect(out.error).toBeUndefined()
    expect(bodies["invoicing:preview_totals"]?.contactId).toBe(BILLING_CONTACT)
    expect(bodies["invoicing:draft_from_reconcile"]?.contactId).toBe(BILLING_CONTACT)
  })

  it("a retainer month created without its overage says Waived by you this month", async () => {
    const draft = {
      status: "completed",
      draftId: "44444444-4444-4444-8444-444444444444",
      approvalId: "66666666-6666-4666-8666-666666666666",
      approved: true,
      created: true,
      totals: { excl: 450000, vat: 90000, incl: 540000, currency: "EUR" },
    }
    const waived = ctxWith(draft, { basis: "retainer" })
    const out = (await reconcileCreateInvoice(
      { reconciliationId: ID, revision: 1, waiveOverage: true },
      waived.ctx as never,
    )) as Record<string, unknown>
    expect(out.error).toBeUndefined()
    expect(waived.bodies["invoicing:retainer_draft_from_reconcile"]?.waiveOverage).toBe(true)
    expect(out.summary).toBe(
      "Draft made, not issued yet, €5,400.00 incl. VAT. Waived by you this month",
    )
    const billed = ctxWith(draft, { basis: "retainer" })
    const plain = (await reconcileCreateInvoice(
      { reconciliationId: ID, revision: 1 },
      billed.ctx as never,
    )) as Record<string, unknown>
    expect(String(plain.summary)).not.toContain("Waived")
  })

  it("the month's timesheet goes on a dated-hours retainer's draft only, never on a card billed by the day", async () => {
    const draft = {
      status: "completed",
      draftId: "44444444-4444-4444-8444-444444444444",
      approvalId: "66666666-6666-4666-8666-666666666666",
      approved: true,
      created: true,
      totals: { excl: 450000, vat: 90000, incl: 540000, currency: "EUR" },
    }
    const withSheet = (prepared: Record<string, unknown>) => {
      const made = ctxWith(draft, { datedHours: true, month: "2026-11", ...prepared })
      const exports: string[] = []
      const ctx = {
        ...made.ctx,
        projects_timesheetExport: async (json: string) => {
          exports.push(json)
          return JSON.stringify({ fileId: "77777777-7777-4777-8777-777777777777" })
        },
      }
      return { ...made, ctx, exports }
    }
    const retainer = withSheet({ basis: "retainer" })
    const filed = (await reconcileCreateInvoice(
      { reconciliationId: ID, revision: 1 },
      retainer.ctx as never,
    )) as Record<string, unknown>
    expect(filed.error).toBeUndefined()
    expect(retainer.exports).toHaveLength(1)
    expect(retainer.bodies["invoicing:document_attachment_add"]).toMatchObject({
      documentId: "44444444-4444-4444-8444-444444444444",
      kind: "timesheet",
    })
    expect(String(filed.message)).toContain("The month's timesheet is filed on it.")

    const daily = withSheet({ basis: "daily" })
    const plain = (await reconcileCreateInvoice(
      { reconciliationId: ID, revision: 1 },
      daily.ctx as never,
    )) as Record<string, unknown>
    expect(plain.error).toBeUndefined()
    expect(daily.exports).toHaveLength(0)
    expect(daily.calls).not.toContain("invoicing:document_attachment_add")
    expect(String(plain.message)).not.toContain("timesheet")
  })

  it("a company with no billing contact refuses Create before anything is reserved and says to set one", async () => {
    const { ctx, steps, calls } = ctxWith({ status: "completed" }, { contactId: null })
    const out = (await reconcileCreateInvoice(
      { reconciliationId: ID, revision: 1 },
      ctx as never,
    )) as { error?: { code?: string; message?: string } }
    expect(out.error?.code).toBe("billing_contact_missing")
    expect(out.error?.message).toContain("set a billing contact on the project's company")
    expect(steps).toEqual(["prepare"])
    expect(calls).not.toContain("invoicing:draft_from_reconcile")
  })

  it("a card whose company has no billing contact offers no Create and says to set one", async () => {
    const cardCtx = (contactId: string | null) => ({
      projects_reconcileGet: async () =>
        JSON.stringify({ reconciliationId: ID, revision: 1, state: "proposed", fit: "close" }),
      projects_reconcileCreate: async () =>
        JSON.stringify({ projectId: "p", basis: "daily", companyId: "c", contactId }),
      executeTool: async () =>
        JSON.stringify({
          status: "completed",
          result: { ready: true, missing: [], excl: 1, vat: 0, incl: 1, currency: "EUR" },
        }),
    })
    const none = (await reconcileGet({ reconciliationId: ID }, cardCtx(null) as never)) as Record<
      string,
      unknown
    >
    expect(none.createInvoice ?? null).toBeNull()
    expect(JSON.stringify(none.notice)).toContain(
      "To create the invoice from this card, set a billing contact on the project's company.",
    )
    const named = (await reconcileGet(
      { reconciliationId: ID },
      cardCtx(BILLING_CONTACT) as never,
    )) as Record<string, unknown>
    expect(named.createInvoice).toBe("yes")
  })

  it("a retainer card above its hours offers to leave the overage off, one under them does not", async () => {
    const cardCtx = (overageMinutes: number | undefined) => ({
      projects_reconcileGet: async () =>
        JSON.stringify({ reconciliationId: ID, revision: 1, state: "proposed", fit: "close" }),
      projects_reconcileCreate: async () => JSON.stringify({ projectId: "p", basis: "retainer" }),
      executeTool: async () =>
        JSON.stringify({
          status: "completed",
          result: {
            ready: true,
            missing: [],
            excl: 1,
            vat: 0,
            incl: 1,
            currency: "EUR",
            overageMinutes,
          },
        }),
    })
    const over = (await reconcileGet({ reconciliationId: ID }, cardCtx(360) as never)) as Record<
      string,
      unknown
    >
    expect(over).toMatchObject({ createInvoice: "yes", waiveOverage: true })
    for (const minutes of [0, undefined]) {
      const under = (await reconcileGet(
        { reconciliationId: ID },
        cardCtx(minutes) as never,
      )) as Record<string, unknown>
      expect(under.createInvoice).toBe("yes")
      expect(under.waiveOverage ?? null).toBeNull()
    }
  })
})
