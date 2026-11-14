// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The invoice draft a planned vs done card makes: one draft per card revision, priced from the
// billed lines and the rate frozen at Create, with no number, its activity report, and an issue
// approval decided by the people who can issue invoices. Issuing it by any path withdraws that
// approval.

import { describe, expect, test } from "bun:test"
import { draftsDiscard, invoiceIssue, type MutationsCtx } from "./mutations"
import { draftFromReconcile, monthEnd } from "./mutations/from-reconcile"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"

type Row = Record<string, unknown>

const ISSUER = {
  id: "iss-1",
  legal_name: "Maison Studio SAS",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue Test, 75001 Paris",
  default_currency: "EUR",
  default_language: "fr",
  prefix_invoice: "F-{YYYY}-",
  prefix_credit_note: "A-{YYYY}-",
  invoice_approval_threshold_minor: null,
  require_two_eyes: false,
}
const REC = "7a1d2c3e-0000-4000-8000-0000000000aa"
const PROJECT = "7a1d2c3e-0000-4000-8000-000000000001"
const COMPANY = "7a1d2c3e-0000-4000-8000-0000000000c1"
const HPD = 420

function linesRead(over: Row = {}): Row {
  return {
    reconciliationId: REC,
    projectId: PROJECT,
    projectName: "Maison Alpine platform",
    companyId: COMPANY,
    basis: "daily",
    state: "proposed",
    revision: 2,
    documentRef: `reconcile:${REC}:2`,
    claimsReserved: true,
    period: { from: "2026-10-01", to: "2026-10-31" },
    rate: { rateMinor: 93_000, currency: "EUR", hoursPerDayMinutes: HPD, unit: "day" },
    lines: [
      {
        lineId: "line-1",
        position: 1,
        wording: "Data export",
        billMinutes: 3 * HPD,
        proofLabels: ["Export merged"],
      },
      {
        lineId: "line-2",
        position: 2,
        wording: "Monitoring",
        billMinutes: 4 * HPD,
        proofLabels: ["Dashboard delivered"],
      },
    ],
    ...over,
  }
}

interface Harness {
  ctx: MutationsCtx & { hasScope(s: string): Promise<boolean> }
  db: MockDb
  approvals: Array<Row & { id: string; status: string }>
  read: { value: Row }
  scopes: Set<string>
  park: { fail: Error | null }
}

function harness(opts: { scopes?: string[]; issuer?: boolean } = {}): Harness {
  const db = createMockDb({ seed: { issuer_profiles: opts.issuer === false ? [] : [ISSUER] } })
  const approvals: Harness["approvals"] = []
  const read = { value: linesRead() }
  const scopes = new Set(opts.scopes ?? ["invoicing:documents:write"])
  const park: Harness["park"] = { fail: null }
  let seq = 0
  const ctx = {
    getUserId: async () => "user-1",
    approval: null,
    db,
    time: testTime(),
    pdf: {
      async render() {
        return {
          file_id: `pdf-${++seq}`,
          byte_size: 1,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: { post: async () => ({ message_id: `m-${++seq}` }) },
    hasScope: async (s: string) => scopes.has(s),
    requestApproval: async (input: Row) => {
      if (park.fail) throw park.fail
      const id = crypto.randomUUID()
      approvals.push({ id, status: "pending", ...input })
      return { approval_id: id }
    },
    approvals: {
      pendingFor: async (key: string, tools?: string[]) =>
        approvals
          .filter((a) => a.status === "pending" && (!tools || tools.includes(String(a.tool_name))))
          .map((a) => ({
            id: a.id,
            tool_name: a.tool_name,
            target_id: (a.current_payload as Row)[key],
            payload: a.current_payload,
          })),
      withdraw: async (id: string) => {
        const a = approvals.find((x) => x.id === id && x.status === "pending")
        if (!a) return { ok: false, code: "not_pending" }
        a.status = "cancelled"
        return { ok: true, approval_id: id }
      },
    },
    decideApproval: async () => ({ status: "ok" }),
    executeTool: async (target: string) => {
      if (target === "projects:reconcile_lines_read")
        return { status: "completed" as const, result: read.value }
      if (target === "kernel:companies_read")
        return { status: "completed" as const, result: { company: { name: "Maison Alpine SA" } } }
      if (target.startsWith("stripe:"))
        return { status: "error" as const, error: { code: "tool_not_found", message: "absent" } }
      return { status: "completed" as const, result: {} }
    },
    emit: async () => {},
  } as unknown as Harness["ctx"]
  return { ctx, db, approvals, read, scopes, park }
}

const docs = (db: MockDb): Row[] => db.__all("documents")
const sequenceTotal = (db: MockDb) => [...db.__sequences.values()].reduce((a, b) => a + b, 0)

describe("a draft from planned vs done", () => {
  test("the October lines give one draft of 3 d and 4 d at 930.00, totals 6,510.00, 1,302.00 and 7,812.00, approved, with no number and a report", async () => {
    const h = harness()
    const res = await draftFromReconcile(h.ctx, {
      reconciliationId: REC,
      revision: 2,
      leadName: "Claire Martin",
    })
    if (res.status !== "completed") throw new Error(JSON.stringify(res))
    expect(res.totals).toEqual({ excl: 651_000, vat: 130_200, incl: 781_200, currency: "EUR" })
    expect(res.approved).toBe(true)
    expect(res.created).toBe(true)
    const all = docs(h.db)
    expect(all).toHaveLength(1)
    const d = all[0] as Row
    expect(d.number ?? null).toBeNull()
    expect(d.status).toBe("draft")
    expect(d.external_ref).toBe(`reconcile:${REC}:2`)
    expect(d.billing_project_id).toBe(PROJECT)
    expect(d.service_period_start).toBe("2026-10-01")
    expect(d.service_period_end).toBe("2026-10-31")
    expect(d.latest_issue_on).toBe("2026-10-31")
    expect(d.approved_by).toBe("user-1")
    expect(d.operation_category).toBe("services")
    const lines = h.db.__all("document_lines").filter((l) => l.document_id === d.id)
    expect(
      lines.map((l) => [
        l.description,
        String(l.quantity),
        String(l.unit_price_minor),
        l.line_kind,
        l.external_id,
      ]),
    ).toEqual([
      ["Data export", "3", "93000", "service", "reconcile_line:line-1"],
      ["Monitoring", "4", "93000", "service", "reconcile_line:line-2"],
    ])
    expect(sequenceTotal(h.db)).toBe(0)
    const reports = h.db.__all("activity_reports")
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ document_id: d.id, version: 1 })
    expect(h.approvals).toHaveLength(1)
    expect(h.approvals[0]).toMatchObject({
      tool_name: "invoicing:invoice_issue",
      current_payload: { draft_id: d.id },
      approve_scope: "invoicing:documents:write",
      expiry_hours: 720,
    })
    // Never auto-approvable: an org's auto-approve policy cannot issue it.
    expect(h.approvals[0]?.auto_approvable).toBeUndefined()
    expect(res.approvalId).toBe(h.approvals[0]?.id as string)
  })

  test("asking twice returns the same draft", async () => {
    const h = harness()
    const a = await draftFromReconcile(h.ctx, { reconciliationId: REC, revision: 2 })
    const b = await draftFromReconcile(h.ctx, { reconciliationId: REC, revision: 2 })
    if (a.status !== "completed" || b.status !== "completed") throw new Error("refused")
    expect(b.draftId).toBe(a.draftId)
    expect(b.created).toBe(false)
    expect(b.approvalId).toBe(a.approvalId)
    expect(docs(h.db)).toHaveLength(1)
    expect(h.approvals).toHaveLength(1)
    expect(h.db.__all("activity_reports")).toHaveLength(1)
  })

  test("a creator without the issuing scope gets an unapproved draft and an issue approval for the issuers", async () => {
    const h = harness({ scopes: [] })
    const res = await draftFromReconcile(h.ctx, { reconciliationId: REC, revision: 2 })
    if (res.status !== "completed") throw new Error(JSON.stringify(res))
    expect(res.approved).toBe(false)
    expect((docs(h.db)[0] as Row).approved_by ?? null).toBeNull()
    expect(h.approvals[0]?.approve_scope).toBe("invoicing:documents:write")
    expect(res.message).toContain("waiting for someone who can issue invoices")
  })

  test("a two-approver org with one finance member still creates the draft", async () => {
    const h = harness()
    h.park.fail = Object.assign(new Error("approvers_unavailable: not enough people can decide"), {
      code: "approvers_unavailable",
    })
    const res = await draftFromReconcile(h.ctx, { reconciliationId: REC, revision: 2 })
    if (res.status !== "completed") throw new Error(JSON.stringify(res))
    expect(res.approvalId).toBeNull()
    expect(docs(h.db)).toHaveLength(1)
    expect(res.message).toContain("issue it from the pending list")
  })

  test("a stale revision makes nothing and says the card changed", async () => {
    const h = harness()
    const res = await draftFromReconcile(h.ctx, { reconciliationId: REC, revision: 1 })
    expect(res.status === "error" && res.error.code).toBe("card_changed")
    expect(docs(h.db)).toHaveLength(0)
  })

  test("an org without an issuer profile gets no draft and is told what to set", async () => {
    const h = harness({ issuer: false })
    const res = await draftFromReconcile(h.ctx, { reconciliationId: REC, revision: 2 })
    expect(res.status === "error" && res.error.code).toBe("no_issuer_profile")
    expect(docs(h.db)).toHaveLength(0)
    expect(h.approvals).toHaveLength(0)
  })

  test("issuing from the pending list clears the pending approval", async () => {
    const h = harness()
    const res = await draftFromReconcile(h.ctx, { reconciliationId: REC, revision: 2 })
    if (res.status !== "completed") throw new Error(JSON.stringify(res))
    // The company record had no address yet: the person completes the recipient on the draft.
    await h.db.update("documents", res.draftId, {
      counterparty_address: "Rheinallee 4, 40545 Duesseldorf, Germany",
      counterparty_email: "billing@alpine.example",
      counterparty_country: "DE",
      counterparty_vat_id: "DE298765432",
    })
    // A direct issue of the draft (the Issue button), not the approval's own re-entry.
    const issued = await invoiceIssue(h.ctx, { draft_id: res.draftId })
    expect(issued).toMatchObject({ status: "completed" })
    expect(h.approvals[0]?.status).toBe("cancelled")
    // The lines stay services from the draft to the invoice.
    const docId = (issued as { document_id?: string }).document_id
    const issuedLines = h.db.__all("document_lines").filter((l) => l.document_id === docId)
    expect(issuedLines.map((l) => l.line_kind)).toEqual(["service", "service"])
  })

  test("discarding the draft withdraws its issue approval", async () => {
    const h = harness()
    const res = await draftFromReconcile(h.ctx, { reconciliationId: REC, revision: 2 })
    if (res.status !== "completed") throw new Error(JSON.stringify(res))
    await draftsDiscard(h.ctx, { draft_id: res.draftId })
    expect(h.approvals[0]?.status).toBe("cancelled")
  })

  test("the issue date limit is the last day of the service month", () => {
    expect(monthEnd("2026-02-10")).toBe("2026-02-28")
    expect(monthEnd("2028-02-01")).toBe("2028-02-29")
    expect(monthEnd("2026-12-31")).toBe("2026-12-31")
  })
})
