// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Create invoice's handler around invoicing's answers, with the bridge and invoicing stubbed: what
// the card says when the draft is made but its issue approval could not park, and that a failed
// draft gives the card's work back.

import { describe, expect, it } from "bun:test"
import { reconcileCreateInvoice, reconcileGet } from "../handlers"

const ID = "11111111-1111-4111-8111-111111111111"

function ctxWith(draft: Record<string, unknown>) {
  const steps: string[] = []
  const calls: string[] = []
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
        })
      }
      if (input.step === "finish") {
        return JSON.stringify({ reconciliationId: ID, revision: 1, state: "drafted" })
      }
      return JSON.stringify({ ok: true })
    },
    executeTool: async (tool: string) => {
      calls.push(tool)
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
  return { ctx, steps, calls }
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
      expect(under.waiveOverage).toBeUndefined()
    }
  })
})
