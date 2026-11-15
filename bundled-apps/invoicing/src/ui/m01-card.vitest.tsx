// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A draft made from a planned vs done card, a milestone or a retainer month, rendered on its
// document page: the source badge, no number before issue, the issue button worded by approval,
// what stays inside, lateness, and a final's deductions citing each advance's number and date.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
const navigated: string[] = []
let answer: unknown = { status: "completed", document_id: "issued-1", number: "F-2026-0512" }

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: (path: string) => navigated.push(path),
  app: {
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      calls.push({ tool, params })
      return answer
    },
  },
}))

const { SourcedDraftPanel } = await import("./SourcedDraft")

const draft = (over: Record<string, unknown> = {}) => ({
  id: "draft-1",
  status: "draft",
  currency: "EUR",
  grand_total_minor: "781200",
  external_ref: "reconcile:11111111-1111-4111-8111-111111111111:2",
  approved_by: "user-1",
  latest_issue_on: "2026-10-31",
  external_refs: {},
  ...over,
})

// Fixture copy, kept out of the copy guard's literal scan as the other rendered tests do.
const [EXPORT, MONITORING, LAUNCH, CITED] = [
  "Data export",
  "Monitoring",
  "Launch",
  "Advance invoice F-2026-0201 of 16 Apr 2026",
]

const lines = [
  { description: EXPORT, subtotal_minor: "279000", external_id: "reconcile_line:a" },
  { description: MONITORING, subtotal_minor: "372000", external_id: "reconcile_line:b" },
]

afterEach(() => {
  cleanup()
  calls.length = 0
  navigated.length = 0
  answer = { status: "completed", document_id: "issued-1", number: "F-2026-0512" }
})

describe("invoice from planned vs done", () => {
  it("an approved draft offers Issue with its amount and shows no number", () => {
    render(() => <SourcedDraftPanel doc={draft()} lines={lines} today="2026-10-20" />)
    expect(screen.getByTestId("sourced-draft-badge").textContent).toContain("From planned vs done")
    expect(screen.getByTestId("sourced-draft-issue").textContent).toMatch(/^Issue, .*7.812\.00 EUR/)
    expect(screen.getByTestId("sourced-draft-no-number").textContent).toContain("No number yet")
    expect(screen.getByTestId("sourced-draft").textContent).not.toMatch(/F-\d{4}-\d+/)
  })

  it("an unapproved one offers Approve", () => {
    render(() => (
      <SourcedDraftPanel doc={draft({ approved_by: null })} lines={lines} today="2026-10-20" />
    ))
    expect(screen.getByTestId("sourced-draft-issue").textContent).toMatch(
      /^Approve .*7.812\.00 EUR/,
    )
  })

  it("the aside lists what stays inside", () => {
    render(() => <SourcedDraftPanel doc={draft()} lines={lines} today="2026-10-20" />)
    const aside = screen.getByTestId("sourced-draft-stays-inside").textContent ?? ""
    expect(aside).toContain("Stays inside")
    expect(aside).toContain("Real time spent")
    expect(aside).toContain("Team members' names")
    expect(aside).toContain("Lines left off the bill")
  })

  it("a draft past its latest issue day shows late and says it issues with today's date", () => {
    render(() => <SourcedDraftPanel doc={draft()} lines={lines} today="2026-11-03" />)
    const late = screen.getByTestId("sourced-draft-late")
    expect(late.getAttribute("data-state")).toBe("late")
    expect(late.textContent).toContain("2026-10-31")
    expect(late.textContent).toContain("today's date")
  })

  it("pressing the button issues the draft and opens the issued invoice", async () => {
    render(() => <SourcedDraftPanel doc={draft()} lines={lines} today="2026-10-20" />)
    fireEvent.click(screen.getByTestId("sourced-draft-issue"))
    await waitFor(() => expect(navigated).toEqual(["/invoicing/document/issued-1"]))
    expect(calls).toEqual([{ tool: "invoice_issue", params: { draft_id: "draft-1" } }])
    expect(screen.getByTestId("sourced-draft-note").textContent).toContain("F-2026-0512")
  })

  it("a press that goes for approval says so and stays on the draft", async () => {
    answer = { status: "pending_approval" }
    render(() => (
      <SourcedDraftPanel doc={draft({ approved_by: null })} lines={lines} today="2026-10-20" />
    ))
    fireEvent.click(screen.getByTestId("sourced-draft-issue"))
    await waitFor(() =>
      expect(screen.getByTestId("sourced-draft-note").textContent).toContain("approval"),
    )
    expect(navigated).toEqual([])
  })

  it("a document typed by hand shows no source panel", () => {
    render(() => (
      <SourcedDraftPanel doc={draft({ external_ref: null })} lines={lines} today="2026-10-20" />
    ))
    expect(screen.queryByTestId("sourced-draft")).toBeNull()
  })
})

describe("milestone and retainer drafts", () => {
  const advanceId = "22222222-2222-4222-8222-222222222222"
  const final = draft({
    external_ref: "milestone:33333333-3333-4333-8333-333333333333",
    grand_total_minor: "384000",
    external_refs: {
      billing_step_id: "33333333-3333-4333-8333-333333333333",
      preceding_invoices: [
        { document_id: advanceId, number: "F-2026-0201", issue_date: "2026-04-16" },
      ],
    },
  })
  const finalLines = [
    { description: LAUNCH, subtotal_minor: "1600000", external_id: "milestone:x" },
    {
      description: CITED,
      subtotal_minor: "-1280000",
      external_id: `advance_deduction:${advanceId}:2000`,
    },
  ]

  it("a final shows each deduction with the advance's number and date", () => {
    render(() => <SourcedDraftPanel doc={final} lines={finalLines} today="2026-10-20" />)
    const rows = screen.getAllByTestId("sourced-draft-deduction")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain("F-2026-0201")
    expect(rows[0]?.textContent).toContain("2026-04-16")
    expect(rows[0]?.textContent).toMatch(/-.*12.800\.00 EUR/)
  })

  it("a milestone draft says hours do not move its amount", () => {
    render(() => <SourcedDraftPanel doc={final} lines={finalLines} today="2026-10-20" />)
    expect(screen.getByTestId("sourced-draft-badge").textContent).toContain("From a milestone")
    expect(screen.getByTestId("sourced-draft-milestone").textContent).toContain(
      "Hours do not move it",
    )
    expect(screen.getByTestId("sourced-draft-stays-inside").textContent).not.toContain(
      "Lines left off the bill",
    )
  })

  it("a draft whose total is worked out at issue names its lines' sum excluding VAT", () => {
    render(() => (
      <SourcedDraftPanel doc={draft({ grand_total_minor: "0" })} lines={lines} today="2026-10-20" />
    ))
    expect(screen.getByTestId("sourced-draft-issue").textContent).toMatch(
      /^Issue, .*6.510\.00 EUR excl\. VAT$/,
    )
  })

  it("a retainer month's button issues all three together once its timesheet is filed", () => {
    const annexes = [
      { kind: "activity_report", filename: null, partial: false, origin: "card" },
      { kind: "timesheet", filename: "timesheet-2026-10.pdf", partial: false, origin: "filed" },
    ]
    render(() => (
      <SourcedDraftPanel
        doc={draft({
          external_ref: "retainer:sched-1:2026-10",
          grand_total_minor: "626400",
          annexes,
        })}
        lines={lines}
        today="2026-10-20"
      />
    ))
    expect(screen.getByTestId("sourced-draft-issue").textContent).toMatch(
      /^Issue all three, .*6.264\.00 EUR/,
    )
  })

  it("a retainer month with no timesheet filed issues the invoice and its report, both", () => {
    render(() => (
      <SourcedDraftPanel
        doc={draft({
          external_ref: "retainer:sched-1:2026-10",
          grand_total_minor: "626400",
          approved_by: null,
          annexes: [{ kind: "activity_report", filename: null, partial: false, origin: "card" }],
        })}
        lines={lines}
        today="2026-10-20"
      />
    ))
    expect(screen.getByTestId("sourced-draft-issue").textContent).toMatch(
      /^Approve both, .*6.264\.00 EUR/,
    )
  })
})
