// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A fixed-price project's billing plan, its milestone drafts and the final's deductions. The plan
// follows its quote; a milestone is invoiced from its task only (never from hours); the final
// deducts every advance by itself, one line per advance and VAT rate, citing the advance.

import { describe, expect, test } from "bun:test"
import {
  done,
  harness,
  issuedAdvance,
  PLAN_STEPS,
  PROJECT,
  QUOTE,
  T_BETA,
  T_LAUNCH,
  type Task,
  withPlan,
} from "./__tests__/billing-plan-fixtures"
import { buildCii, businessProcessCode } from "./facturx/cii"
import { invoiceIssue } from "./mutations"
import {
  billingPlanSet,
  milestoneDraftCreate,
  renderDeductionLines,
} from "./mutations/billing-plan"
import type { MockDb } from "./test-db"

type Row = Record<string, unknown>

const docs = (db: MockDb) => db.__all("documents").filter((d) => d.type === "invoice")
const linesOf = (db: MockDb, id: unknown) =>
  db
    .__all("document_lines")
    .filter((l) => l.document_id === id)
    .sort((a, b) => Number(a.position) - Number(b.position))

describe("a billing plan", () => {
  test("milestones that do not add up to the quote are refused with the difference, and an advance does not count", async () => {
    const h = harness()
    const short = PLAN_STEPS.map((s) =>
      s.label === "Gamma" ? { ...s, amountMinor: 1_500_000 } : s,
    )
    const res = await billingPlanSet(h.ctx, {
      projectId: PROJECT,
      quoteDocumentId: QUOTE,
      steps: short,
    })
    expect(res).toMatchObject({ status: "error", error: { code: "plan_total_mismatch" } })
    expect((res as { error: { message: string } }).error.message).toContain("1000.00")
    expect(h.db.__all("billing_steps")).toHaveLength(0)
    // 4 x 16,000 = 64,000 with a 12,800 advance on top is right: the advance is not additive.
    const ok = await billingPlanSet(h.ctx, {
      projectId: PROJECT,
      quoteDocumentId: QUOTE,
      steps: PLAN_STEPS,
    })
    expect(ok.status).toBe("completed")
    expect(h.db.__all("billing_steps")).toHaveLength(5)
    expect(ok).toMatchObject({ milestonesMinor: 6_400_000, advancesMinor: 1_280_000 })
  })

  test("a plan on an hourly project is refused", async () => {
    for (const b of ["hourly", "daily"]) {
      const h = harness()
      h.basis.value = b
      const res = await billingPlanSet(h.ctx, {
        projectId: PROJECT,
        quoteDocumentId: QUOTE,
        steps: PLAN_STEPS,
      })
      expect(res).toMatchObject({ status: "error", error: { code: "plan_on_rate_project" } })
      expect(h.db.__all("billing_steps")).toHaveLength(0)
    }
  })

  test("the milestone read hands invoicing no assignee or time", async () => {
    const h = harness()
    await withPlan(h)
    done(h, T_BETA)
    await milestoneDraftCreate(h.ctx, { taskId: T_BETA })
    const reads = h.calls.filter((c) => c.target.startsWith("projects:"))
    expect(reads.length).toBeGreaterThan(0)
    // Only the declared milestone read, never projects:get or a time read.
    expect(new Set(reads.map((c) => c.target))).toEqual(new Set(["projects:milestone_status_read"]))
    const text = JSON.stringify(reads.map((c) => c.result))
    for (const field of ["assignee", "realMinutes", "minutes", "activity", "estimate"])
      expect(text).not.toContain(field)
  })
})

describe("a milestone's invoice", () => {
  test("moving Beta to done gives one draft of 16,000.00 and 19,200.00 whatever the time spent", async () => {
    const amounts: unknown[] = []
    for (const real of [0, 600, 9_000]) {
      const h = harness()
      await withPlan(h)
      ;(h.tasks.get(T_BETA) as Task).realMinutes = real
      done(h, T_BETA)
      const res = await milestoneDraftCreate(h.ctx, { taskId: T_BETA })
      if (res.status !== "completed") throw new Error(JSON.stringify(res))
      expect(res.totals).toEqual({
        excl: 1_600_000,
        vat: 320_000,
        incl: 1_920_000,
        currency: "EUR",
      })
      const all = docs(h.db)
      expect(all).toHaveLength(1)
      const d = all[0] as Row
      expect(d.status).toBe("draft")
      expect(d.number ?? null).toBeNull()
      expect(d.external_ref).toBe(`milestone:${res.stepId}`)
      expect(d.billing_project_id).toBe(PROJECT)
      expect(h.approvals).toHaveLength(1)
      expect(h.approvals[0]).toMatchObject({
        tool_name: "invoicing:invoice_issue",
        approve_scope: "invoicing:documents:write",
      })
      amounts.push(
        linesOf(h.db, d.id).map((l) => [
          String(l.quantity),
          String(l.unit_price_minor),
          l.line_kind,
        ]),
      )
    }
    expect(amounts[0]).toEqual([["1", "1600000", "service"]])
    expect(amounts[1]).toEqual(amounts[0])
    expect(amounts[2]).toEqual(amounts[0])
  })

  test("a milestone not done answers not_done and drafts nothing", async () => {
    const h = harness()
    await withPlan(h)
    const res = await milestoneDraftCreate(h.ctx, { taskId: T_BETA })
    expect(res).toMatchObject({ status: "error", error: { code: "not_done" } })
    // Done but not flagged a milestone: still not_done.
    const t = h.tasks.get(T_BETA) as Task
    t.terminal = true
    t.isMilestone = false
    expect(await milestoneDraftCreate(h.ctx, { taskId: T_BETA })).toMatchObject({
      error: { code: "not_done" },
    })
    expect(docs(h.db)).toHaveLength(0)
    expect(h.approvals).toHaveLength(0)
  })

  test("a second draft for one step fails", async () => {
    const h = harness()
    await withPlan(h)
    done(h, T_BETA)
    const a = await milestoneDraftCreate(h.ctx, { taskId: T_BETA })
    const b = await milestoneDraftCreate(h.ctx, { taskId: T_BETA })
    expect(a.status).toBe("completed")
    expect(b).toMatchObject({ status: "error", error: { code: "already_drafted" } })
    expect(docs(h.db)).toHaveLength(1)
    expect(h.approvals).toHaveLength(1)
  })
})

describe("the final invoice", () => {
  test("the final adds the deduction from the plan by itself", async () => {
    const h = harness()
    await withPlan(h)
    const adv = await issuedAdvance(h)
    done(h, T_LAUNCH)
    const res = await milestoneDraftCreate(h.ctx, { taskId: T_LAUNCH })
    if (res.status !== "completed") throw new Error(JSON.stringify(res))
    expect(res.deductions).toHaveLength(1)
    expect(res.deductions[0]).toMatchObject({
      advanceDocumentId: adv.id,
      advanceNumber: adv.number,
      amountMinor: 1_280_000,
    })
    const deductions = h.db.__all("advance_deductions")
    expect(deductions).toHaveLength(1)
    expect(deductions[0]).toMatchObject({
      advance_document_id: adv.id,
      final_document_id: res.draftId,
      state: "reserved",
    })
  })

  test("Launch shows 16,000.00, minus 12,800.00 citing the advance's number and date, 3,200.00, 640.00, 3,840.00 to pay, marked final after deposit", async () => {
    // The wording, from the advance as issued.
    const lines = renderDeductionLines([
      {
        doc: { id: "adv-1", number: "F-2026-0201", issued_at: "2026-04-16T09:30:00.000Z" },
        lines: [{ subtotal_minor: 1_280_000n, tax_rate_bp: 2000 }],
      },
    ])
    expect(lines).toEqual([
      expect.objectContaining({
        advanceNumber: "F-2026-0201",
        advanceDate: "16 Apr 2026",
        amountMinor: 1_280_000,
        taxRateBp: 2000,
      }),
    ])
    expect(lines[0]?.description).toContain("F-2026-0201")
    expect(lines[0]?.description).toContain("16 Apr 2026")

    // The figures, through the real draft and issue.
    const h = harness()
    await withPlan(h)
    const adv = await issuedAdvance(h)
    done(h, T_LAUNCH)
    const res = await milestoneDraftCreate(h.ctx, { taskId: T_LAUNCH })
    if (res.status !== "completed") throw new Error(JSON.stringify(res))
    expect(res.totals).toEqual({ excl: 320_000, vat: 64_000, incl: 384_000, currency: "EUR" })
    expect(res.paymentState).toBe("final_after_deposit")
    const issued = await invoiceIssue(h.ctx, { draft_id: res.draftId })
    expect(issued).toMatchObject({ status: "completed" })
    const fin = h.db
      .__all("documents")
      .find((d) => d.id === (issued as { document_id: string }).document_id) as Row
    expect(String(fin.subtotal_minor)).toBe("320000")
    expect(String(fin.tax_total_minor)).toBe("64000")
    expect(String(fin.grand_total_minor)).toBe("384000")
    expect(fin.payment_state).toBe("final_after_deposit")
    expect(fin.invoice_role).toBe("final")
    expect(fin.external_ref).toBe(`milestone:${res.stepId}`)
    expect(fin.billing_project_id).toBe(PROJECT)
    const fl = linesOf(h.db, fin.id)
    expect(fl.map((l) => [l.description, String(l.quantity), String(l.unit_price_minor)])).toEqual([
      ["Launch", "1", "1600000"],
      [expect.stringContaining(String(adv.number)), "-1", "1280000"],
    ])
    // The deduction follows the draft to the invoice.
    expect(h.db.__all("advance_deductions")[0]).toMatchObject({ final_document_id: fin.id })
    // BT-23 says final after deposit (services) and BG-3 cites the advance, through the Factur-X writer.
    const xml = buildCii({
      type: "invoice",
      number: String(fin.number),
      issue_date: "2026-06-30",
      due_date: "2026-07-30",
      currency: "EUR",
      operation_category: "services",
      payment_state: "final_after_deposit",
      invoice_role: "final",
      preceding: [{ number: String(adv.number), issue_date: "2026-04-16" }],
      vat_on_debits: false,
      tax_treatment: "eu_domestic",
      seller: {
        legal_name: "Maison Studio SAS",
        siren: "123456789",
        vat_id: "FR12345678901",
        address: { line1: "1 rue Test", postcode: "75001", city: "Paris", country_code: "FR" },
      },
      buyer: {
        legal_name: "Maison Rivage SA",
        siren: "987654321",
        address: { line1: "4 quai Test", postcode: "69002", city: "Lyon", country_code: "FR" },
      },
      lines: fl.map((l) => ({
        position: Number(l.position),
        description: String(l.description),
        quantity: String(l.quantity),
        unit_price_minor: BigInt(String(l.unit_price_minor)),
        discount_minor: 0n,
        tax_rate_bp: Number(l.tax_rate_bp),
        subtotal_minor: BigInt(String(l.subtotal_minor)),
        tax_minor: BigInt(String(l.tax_minor)),
      })),
      subtotal_minor: 320_000n,
      tax_total_minor: 64_000n,
      grand_total_minor: 384_000n,
    } as never)
    expect(xml).toContain(
      `<ram:ID>${businessProcessCode("services", "final_after_deposit")}</ram:ID>`,
    )
    expect(businessProcessCode("services", "final_after_deposit")).toBe(["S", 4].join(""))
    expect(xml).toContain("<ram:TypeCode>380</ram:TypeCode>")
    expect(xml).toContain(`<ram:IssuerAssignedID>${String(adv.number)}</ram:IssuerAssignedID>`)
  })

  test("an advance larger than the invoice is refused", async () => {
    const h = harness()
    const steps = PLAN_STEPS.map((s) =>
      s.kind === "advance" ? { ...s, amountMinor: 1_600_001 } : s,
    )
    const set = await billingPlanSet(h.ctx, { projectId: PROJECT, quoteDocumentId: QUOTE, steps })
    expect(set.status).toBe("completed")
    await issuedAdvance(h)
    done(h, T_LAUNCH)
    const before = docs(h.db).length
    const res = await milestoneDraftCreate(h.ctx, { taskId: T_LAUNCH })
    expect(res).toMatchObject({ status: "error", error: { code: "advance_exceeds_invoice" } })
    expect(docs(h.db)).toHaveLength(before)
    expect(h.db.__all("advance_deductions")).toHaveLength(0)
  })

  test("an advance equal to the final is deducted, one minor unit more is refused", async () => {
    for (const [amount, code] of [
      [1_599_999, null],
      [1_600_000, null],
      [1_600_001, "advance_exceeds_invoice"],
    ] as const) {
      const h = harness()
      const steps = PLAN_STEPS.map((s) =>
        s.kind === "advance" ? { ...s, amountMinor: amount } : s,
      )
      await billingPlanSet(h.ctx, { projectId: PROJECT, quoteDocumentId: QUOTE, steps })
      await issuedAdvance(h)
      done(h, T_LAUNCH)
      const res = await milestoneDraftCreate(h.ctx, { taskId: T_LAUNCH })
      if (code) expect(res).toMatchObject({ error: { code } })
      else expect(res.status).toBe("completed")
    }
  })

  test("a final deducts only what remains of an advance after its credit notes", async () => {
    const h = harness()
    await withPlan(h)
    const adv = await issuedAdvance(h)
    // 4,000.00 net (4,800.00 incl. VAT) of the 12,800.00 advance was credited.
    h.db.__seed("documents", [
      {
        id: crypto.randomUUID(),
        type: "credit_note",
        status: "issued",
        number: "A-2026-0001",
        original_document_id: adv.id,
        grand_total_minor: -480_000n,
      },
    ])
    done(h, T_LAUNCH)
    const res = await milestoneDraftCreate(h.ctx, { taskId: T_LAUNCH })
    if (res.status !== "completed") throw new Error(JSON.stringify(res))
    expect(res.deductions.map((d) => d.amountMinor)).toEqual([880_000])
    expect(res.totals).toMatchObject({ excl: 720_000 })
    const deductionLine = linesOf(h.db, res.draftId).find((l) =>
      String(l.external_id ?? "").startsWith("advance_deduction:"),
    )
    expect(String(deductionLine?.unit_price_minor)).toBe("880000")
  })

  test("a final whose advance is not issued yet is refused and drafts nothing", async () => {
    const h = harness()
    await withPlan(h)
    done(h, T_LAUNCH)
    const res = await milestoneDraftCreate(h.ctx, { taskId: T_LAUNCH })
    expect(res).toMatchObject({ status: "error", error: { code: "advance_not_issued" } })
    expect(docs(h.db)).toHaveLength(0)
  })

  test("a two-rate advance gives one deduction line per rate", () => {
    const lines = renderDeductionLines([
      {
        doc: { id: "adv-2", number: "F-2026-0210", issued_at: "2026-05-02" },
        lines: [
          { subtotal_minor: 100_000n, tax_rate_bp: 2000 },
          { subtotal_minor: 40_000n, tax_rate_bp: 550 },
          { subtotal_minor: 10_000n, tax_rate_bp: 2000 },
        ],
      },
    ])
    expect(lines.map((l) => [l.taxRateBp, l.amountMinor])).toEqual([
      [2000, 110_000],
      [550, 40_000],
    ])
    for (const l of lines) expect(l.description).toContain("F-2026-0210")
  })
})
