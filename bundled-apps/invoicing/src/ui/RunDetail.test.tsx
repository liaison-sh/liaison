// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The detail of a month-end run once issued: when it issued, who approved it, the period, the
// number range ("none missing" only when the numbers really follow each other), and where each
// invoice stands with the e-invoicing platform. A partial run lists its failed rows with Fix.

import { afterEach, describe, expect, it } from "bun:test"
import { rowFacts } from "./month-end"
import {
  dayIn,
  numberRange,
  RunDetail,
  type RunDetailRow,
  type RunDetailRun,
  runDetailView,
} from "./RunDetail"

afterEach(() => {
  ;(globalThis as any).__liaisonHost = undefined
})

const run: RunDetailRun = {
  id: "run-1",
  status: "issued",
  issue_on: "2026-11-30",
  latest_issue_on: "2026-11-30",
  period: "November 2026",
  approved_by: "user-1",
  approved_at: "2026-11-27T10:12:00.000Z",
}

const row = (over: Partial<RunDetailRow>): RunDetailRow => ({
  item_id: "i",
  draft_id: null,
  document_id: "d",
  state: "issued",
  customer: "Maison Arlon",
  net_minor: "100000",
  vat_minor: "20000",
  total_minor: "120000",
  currency: "EUR",
  number: null,
  flags: [],
  failure: null,
  einvoice_state: null,
  collection_state: null,
  payment_status: "unpaid",
  ...over,
})

describe("an issued month-end run", () => {
  it('an issued run shows numbers, approver, period and each e-invoice state, and "no gaps" only when true', () => {
    const rows = [
      row({ item_id: "a", document_id: "da", number: "F-2026-0463", einvoice_state: "sent" }),
      row({
        item_id: "b",
        document_id: "db",
        number: "F-2026-0464",
        einvoice_state: "sent",
        collection_state: "reported",
        payment_status: "paid",
      }),
      row({ item_id: "c", document_id: "dc", number: "F-2026-0465", einvoice_state: "refused" }),
    ]
    const v = runDetailView(run, rows, "Claire Dubois")
    expect(v.issuedOn).toBe("2026-11-30")
    expect(v.approvedBy).toBe("Claire Dubois")
    expect(v.approvedOn).toBe("2026-11-27")
    expect(v.period).toBe("November 2026")
    expect(v.range).toEqual({ first: "F-2026-0463", last: "F-2026-0465", noGaps: true })
    expect(v.rows.map((r) => [r.number, r.einvoice])).toEqual([
      ["F-2026-0463", "Waiting for payment"],
      ["F-2026-0464", "Collected"],
      ["F-2026-0465", "Refused by the buyer"],
    ])
    expect(v.totals).toEqual({ net: "300000", vat: "60000", total: "360000", currency: "EUR" })

    // A hole in the numbers, or two series, never reads as none missing.
    expect(numberRange(["F-2026-0463", "F-2026-0465"])).toEqual({
      first: "F-2026-0463",
      last: "F-2026-0465",
      noGaps: false,
    })
    expect(numberRange(["F-2026-0463", "A-2026-0464"])?.noGaps).toBe(false)
    expect(numberRange(["F-2026-0463", "F-2026-0463"])?.noGaps).toBe(false)
    expect(numberRange([])).toBeNull()
    // Numbers come in any order from the rows; the range is still read in order.
    expect(numberRange(["F-2026-0010", "F-2026-0009"])).toEqual({
      first: "F-2026-0009",
      last: "F-2026-0010",
      noGaps: true,
    })
  })

  it("a partial run lists its failed rows with Fix, and they take no number", () => {
    const rows = [
      row({ item_id: "a", number: "F-2026-0463", einvoice_state: "sent" }),
      row({
        item_id: "b",
        state: "failed",
        number: null,
        failure: { message: "The customer's VAT number is not valid." },
        draft_id: "draft-b",
        document_id: "draft-b",
      }),
    ]
    const v = runDetailView({ ...run, status: "partial" }, rows, null)
    expect(v.failed).toEqual([
      {
        itemId: "b",
        customer: "Maison Arlon",
        why: "The customer's VAT number is not valid.",
        fixHref: "/invoicing/editor/draft-b",
      },
    ])
    expect(v.rows.map((r) => r.number)).toEqual(["F-2026-0463"])
    expect(v.approvedBy).toBeNull()
    expect(typeof RunDetail).toBe("function")
  })
})

describe("a run that has not issued yet", () => {
  it("a drafted run says so, lists its drafts with no number, and never claims the period is billed", () => {
    const rows = [
      row({ item_id: "a", state: "ready", draft_id: "da", document_id: "da" }),
      row({ item_id: "b", state: "ready", draft_id: "db", document_id: "db" }),
      row({ item_id: "c", state: "left_out", draft_id: "dc", document_id: "dc" }),
    ]
    const v = runDetailView(
      { ...run, status: "drafted", approved_by: null, approved_at: null },
      rows,
      null,
    )
    expect(v.issued).toBe(false)
    expect(v.statusWord).toBe("Drafted, waiting for approval")
    expect(v.approvalWord).toBe("Not approved yet")
    expect(v.range).toBeNull()
    // A run closed with no invoice issued never reads as issued.
    const none = runDetailView({ ...run, status: "nothing_to_issue" }, rows, null)
    expect(none.issued).toBe(false)
    expect(none.statusWord).toBe("Closed, nothing to issue")
    expect(v.rows.map((r) => [r.key, r.number, r.href])).toEqual([
      ["a", null, "/invoicing/editor/da"],
      ["b", null, "/invoicing/editor/db"],
    ])
    expect(v.totals.total).toBe("240000")
  })

  it("a late run lists the rows its card covers, and a row that needs a fix is not one", () => {
    const rows = [
      row({ item_id: "a", state: "ready", draft_id: "da", document_id: "da" }),
      row({ item_id: "b", state: "needs_fix", draft_id: "db", document_id: "db" }),
      row({ item_id: "c", state: "waiting_reapproval", draft_id: "dc", document_id: "dc" }),
      row({ item_id: "d", state: "left_out", draft_id: "dd", document_id: "dd" }),
    ]
    const v = runDetailView({ ...run, status: "late", approved_by: null }, rows, null)
    expect(v.lateSince).toBe(run.latest_issue_on)
    expect(v.toDecide.map((r) => r.item_id)).toEqual(["a", "c"])
    expect(v.runId).toBe(run.id)
  })

  it("a late run whose every row left needs a fix lists those rows with why and where to fix them", () => {
    // A late run with no row ready has no card (it would approve nothing): the page itself is the
    // way out, so it names each row to fix, never "open a row" over an empty list.
    const rows = [
      row({
        item_id: "a",
        state: "needs_fix",
        customer: "Iris Arlon",
        draft_id: "da",
        document_id: "da",
        flags: ["No billing address"],
      }),
      row({ item_id: "b", state: "left_out", draft_id: "db", document_id: "db" }),
      row({ item_id: "c", state: "needs_fix", draft_id: null, document_id: "dc" }),
    ]
    const v = runDetailView({ ...run, status: "late", approved_by: null }, rows, null)
    expect(v.toDecide).toEqual([])
    expect(v.needsFix).toEqual([
      {
        itemId: "a",
        customer: "Iris Arlon",
        why: "No billing address",
        fixHref: "/invoicing/editor/da",
      },
      {
        itemId: "c",
        customer: "Maison Arlon",
        why: "It needs a fix before it can issue.",
        fixHref: "/invoicing/editor/dc",
      },
    ])
    // A run with nothing to fix lists nothing.
    expect(
      runDetailView({ ...run, status: "late" }, [row({ state: "left_out" })], null).needsFix,
    ).toEqual([])
  })

  it("a row's due date, operation type and period are said before it is approved", () => {
    const facts = rowFacts({
      ...row({ state: "ready", number: null }),
      due_at: "2026-12-30",
      operation_category: "services",
      period_start: "2026-11-01",
      period_end: "2026-11-30",
      account_manager: null,
      updated_at: null,
      latest_change: null,
    } as never)
    expect(facts).toEqual(["Due 2026-12-30", "Services", "Period 2026-11-01 to 2026-11-30"])
    expect(rowFacts({ ...row({ state: "ready", number: null }), due_at: null } as never)).toEqual([
      "Due by the payment terms, counted from issue",
    ])
  })

  it("an approved run is approved, not issued, and shows the approval day in the issuer's zone", () => {
    const rows = [row({ item_id: "a", state: "approved", draft_id: "da", document_id: "da" })]
    const v = runDetailView(
      {
        ...run,
        status: "approved",
        approved_at: "2026-11-10T23:10:00.000Z",
        timezone: "Europe/Paris",
      },
      rows,
      "Claire Dubois",
    )
    expect(v.statusWord).toBe("Approved, not issued yet")
    expect(v.issued).toBe(false)
    expect(v.approvedOn).toBe("2026-11-11")
    expect(v.rows).toHaveLength(1)
    expect(dayIn("2026-11-10T23:10:00.000Z", null)).toBe("2026-11-10")
  })
})
