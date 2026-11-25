// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An advance invoice's own page: its own number, the deduction its final carries (worded by the
// one deduction function), the final that took it, no credit offered while that final stands,
// refusals said in words, and money received first giving the person two choices that issue
// nothing.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
const navigated: string[] = []
let answers: Record<string, (params: Record<string, unknown>) => unknown> = {}

// Fixture copy, kept out of the copy guard's literal scan as the other rendered tests do.
const [ADVANCE_LABEL, LAUNCH, ADV_NO, FINAL_NO, DEDUCTION, DRAFTED] = [
  "Advance 20%",
  "Launch",
  "F-0201",
  "F-0240",
  "Advance invoice F-0201 of 16 Apr 2026",
  "Created the advance draft; no number was taken.",
]

const PROJECT = "11111111-1111-4111-8111-111111111111"
const ADVANCE_ID = "22222222-2222-4222-8222-222222222222"
const FINAL_ID = "33333333-3333-4333-8333-333333333333"

const advance = (over: Record<string, unknown> = {}) => ({
  id: ADVANCE_ID,
  status: "paid",
  number: ADV_NO,
  currency: "EUR",
  subtotal_minor: "1280000",
  tax_total_minor: "256000",
  grand_total_minor: "1536000",
  issued_at: "2026-04-16",
  external_ref: "advance:step-adv",
  billing_project_id: PROJECT,
  invoice_role: "advance",
  ...over,
})

const ADVANCE_LINES = [
  { description: ADVANCE_LABEL, subtotal_minor: "1280000", tax_rate_bp: 2000, external_id: null },
]

const plan = (finalAmount = 1_600_000) => ({
  status: "completed",
  steps: [
    {
      id: "step-adv",
      kind: "advance",
      label: ADVANCE_LABEL,
      amountMinor: 1_280_000,
      currency: "EUR",
      state: "paid",
      document: { id: ADVANCE_ID, number: ADV_NO, status: "paid" },
    },
    {
      id: "step-final",
      kind: "final",
      label: LAUNCH,
      amountMinor: finalAmount,
      currency: "EUR",
      state: "planned",
      document: null,
    },
  ],
})

const finalDoc = {
  id: FINAL_ID,
  status: "issued",
  number: FINAL_NO,
  invoice_role: "final",
  lines: [
    { description: LAUNCH, subtotal_minor: "1600000", tax_rate_bp: 2000, external_id: null },
    {
      description: DEDUCTION,
      subtotal_minor: "-1280000",
      tax_rate_bp: 2000,
      external_id: `advance_deduction:${ADVANCE_ID}:2000`,
    },
  ],
}

/** The reads of a project whose final either deducts the advance already or does not exist yet. */
function project(opts: { deducted: boolean; finalAmount?: number }) {
  answers = {
    billing_plan_get: () => plan(opts.finalAmount),
    documents_search: () =>
      opts.deducted
        ? [{ id: FINAL_ID, status: "issued", number: FINAL_NO, invoice_role: "final" }]
        : [],
    documents_get: () => finalDoc,
  }
}

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: (path: string) => navigated.push(path),
  app: {
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      calls.push({ tool, params })
      return answers[tool]?.(params) ?? null
    },
  },
}))

const { AdvanceLedgerPanel, MoneyFirstChoices } = await import("./AdvanceLedger")

/** A test id's text, with the app's thousands spaces read as commas ("12,800.00"). */
const text = (id: string): string =>
  (screen.getByTestId(id).textContent ?? "").replace(/(\d)[\u202f\u00a0 ](?=\d{3}\b)/g, "$1,")

afterEach(() => {
  cleanup()
  calls.length = 0
  navigated.length = 0
  answers = {}
})

describe("an advance invoice's own page", () => {
  it("an advance shows its own number, its deduction preview and the final that took it", async () => {
    project({ deducted: true })
    render(() => <AdvanceLedgerPanel doc={advance()} lines={ADVANCE_LINES} />)
    await waitFor(() => expect(screen.getByTestId("advance-taken-by")).toBeTruthy())
    expect(text("advance-ledger-number")).toContain(ADV_NO)
    const deduction = text("advance-preview-deduction")
    expect(deduction).toContain(DEDUCTION)
    expect(deduction).toContain("-12,800.00 EUR")
    expect(text("advance-preview-left")).toContain("3,200.00 EUR")
    expect(text("advance-taken-by")).toContain(`invoice ${FINAL_NO}`)
    expect(text("advance-accountant-note")).toContain("accountant")
    fireEvent.click(screen.getByTestId("advance-open-final"))
    expect(navigated).toEqual([`/invoicing/document/${FINAL_ID}`])
  })

  it("a deducted advance offers no full credit and names its final", async () => {
    project({ deducted: true })
    render(() => <AdvanceLedgerPanel doc={advance()} lines={ADVANCE_LINES} />)
    await waitFor(() =>
      expect(screen.getByTestId("advance-ledger").getAttribute("data-state")).toBe("deducted"),
    )
    expect(screen.queryByTestId("advance-refund-prepare")).toBeNull()
    expect(text("advance-taken-by")).toContain(
      `cannot be fully credited while invoice ${FINAL_NO} stands`,
    )
  })

  it("an advance still open offers its credit note and says a refusal in the tool's words", async () => {
    project({ deducted: false })
    const refusal = `Advance ${ADV_NO} is deducted from invoice ${FINAL_NO}, so no credit note was made.`
    answers.advance_refund_prepare = () => ({
      status: "error",
      error: { code: "advance_already_deducted", message: refusal },
    })
    render(() => <AdvanceLedgerPanel doc={advance()} lines={ADVANCE_LINES} />)
    await waitFor(() =>
      expect(screen.getByTestId("advance-ledger").getAttribute("data-state")).toBe("open"),
    )
    fireEvent.click(screen.getByTestId("advance-refund-prepare"))
    await waitFor(() => expect(text("advance-ledger-note")).toBe(refusal))
    expect(calls.filter((c) => c.tool === "advance_refund_prepare")).toEqual([
      { tool: "advance_refund_prepare", params: { advanceDocumentId: ADVANCE_ID } },
    ])
  })

  it("an advance larger than its final says in words that the final will not be drafted", async () => {
    project({ deducted: false, finalAmount: 1_000_000 })
    render(() => <AdvanceLedgerPanel doc={advance()} lines={ADVANCE_LINES} />)
    await waitFor(() => expect(screen.getByTestId("advance-preview-exceeds")).toBeTruthy())
    expect(text("advance-preview-exceeds")).toContain(`larger than ${LAUNCH} (10,000.00 EUR)`)
    expect(screen.queryByTestId("advance-preview-left")).toBeNull()
  })

  it("a draft advance has no number yet and words no deduction without one", async () => {
    project({ deducted: false })
    render(() => (
      <AdvanceLedgerPanel
        doc={advance({ status: "draft", number: null, issued_at: null })}
        lines={ADVANCE_LINES}
      />
    ))
    await waitFor(() => expect(screen.getByTestId("advance-preview-pending")).toBeTruthy())
    expect(text("advance-ledger-number")).toContain("No number yet")
    expect(screen.queryByTestId("advance-preview-deduction")).toBeNull()
  })

  it("VAT is never shown as due on the deducted part", async () => {
    project({ deducted: true })
    render(() => <AdvanceLedgerPanel doc={advance()} lines={ADVANCE_LINES} />)
    await waitFor(() => expect(screen.getByTestId("advance-preview-deduction")).toBeTruthy())
    // The VAT is on the advance itself...
    expect(text("advance-ledger-own")).toContain("2,560.00 EUR VAT")
    // ...and never on the deduction: no VAT figure, no VAT word in the preview's money rows.
    const preview = text("advance-preview")
    expect(preview).not.toContain("2,560.00")
    expect(text("advance-preview-deduction")).not.toMatch(/VAT/)
    expect(text("advance-preview-left")).not.toMatch(/incl\. VAT|VAT \d/)
  })

  it("a cancelled advance shows no deduction and no credit", async () => {
    project({ deducted: false })
    render(() => (
      <AdvanceLedgerPanel doc={advance({ status: "cancelled" })} lines={ADVANCE_LINES} />
    ))
    await waitFor(() => expect(screen.getByTestId("advance-ledger-cancelled")).toBeTruthy())
    expect(screen.queryByTestId("advance-preview")).toBeNull()
    expect(screen.queryByTestId("advance-refund-prepare")).toBeNull()
  })

  it("a prepaid retainer month's advance names the month that deducts it", async () => {
    project({ deducted: false })
    render(() => (
      <AdvanceLedgerPanel
        doc={advance({ external_ref: `advance:${PROJECT}:2026-05` })}
        lines={ADVANCE_LINES}
      />
    ))
    await waitFor(() => expect(screen.getByTestId("advance-ledger-retainer")).toBeTruthy())
    expect(text("advance-ledger-retainer")).toContain("2026-05")
    expect(screen.queryByTestId("advance-preview")).toBeNull()
  })

  it("an invoice that is not an advance shows no ledger", () => {
    project({ deducted: false })
    render(() => (
      <AdvanceLedgerPanel doc={advance({ invoice_role: "standard" })} lines={ADVANCE_LINES} />
    ))
    expect(screen.queryByTestId("advance-ledger")).toBeNull()
    expect(calls).toEqual([])
  })
})

describe("money received before the advance has an invoice", () => {
  it("money first shows the person's two choices and issues nothing", async () => {
    answers.advance_draft_create = () => ({
      status: "completed",
      draftId: ADVANCE_ID,
      message: DRAFTED,
    })
    render(() => <MoneyFirstChoices projectId={PROJECT} stepId="step-adv" />)
    expect(text("money-first-draft-step-adv")).toBe("Draft the advance invoice")
    expect(text("money-first-not-step-adv")).toBe("Not an advance")

    fireEvent.click(screen.getByTestId("money-first-not-step-adv"))
    expect(calls).toEqual([])
    expect(text("money-first-note-step-adv")).toContain("Nothing was drafted")

    fireEvent.click(screen.getByTestId("money-first-draft-step-adv"))
    await waitFor(() => expect(navigated).toEqual([`/invoicing/document/${ADVANCE_ID}`]))
    expect(calls).toEqual([
      { tool: "advance_draft_create", params: { projectId: PROJECT, stepId: "step-adv" } },
    ])
    expect(calls.some((c) => /issue/.test(c.tool))).toBe(false)
  })
})
