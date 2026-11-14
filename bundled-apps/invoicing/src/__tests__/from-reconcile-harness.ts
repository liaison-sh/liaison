// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test harness: an invoice draft from a planned vs done card, through the real draft, issue and
// send code, on the mock database, with the PDF renders, mails and approvals it raises recorded.

import { invoiceIssue, type MutationsCtx } from "../mutations"
import { draftFromReconcile } from "../mutations/from-reconcile"
import { createMockDb, type MockDb } from "../test-db"
import { testTime } from "../test-time"

export type Row = Record<string, unknown>

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
  mail_account_id: "acct-1",
}
export const REC = "7a1d2c3e-0000-4000-8000-0000000000ab"
const PROJECT = "7a1d2c3e-0000-4000-8000-000000000002"
const COMPANY = "7a1d2c3e-0000-4000-8000-0000000000c2"
const HPD = 420
// What a card may hold beside its billed lines, which nothing sent may carry.
export const MEMBER = "Tomas Novak"
export const NOTE = "spent ages debugging the export"
export const REAL_FORMS = ["3.5", "3,5", "3 h 30"]
export const FORBIDDEN_KEYS = /real|note|estimate|member|assignee|unplanned|minutes|person|user/i

export function linesRead(period = { from: "2026-10-01", to: "2026-10-31" }, rec = REC): Row {
  return {
    reconciliationId: rec,
    projectId: PROJECT,
    projectName: "Maison Alpine platform",
    companyId: COMPANY,
    basis: "daily",
    state: "proposed",
    revision: 1,
    documentRef: `reconcile:${rec}:1`,
    claimsReserved: true,
    period,
    rate: { rateMinor: 93_000, currency: "EUR", hoursPerDayMinutes: HPD, unit: "day" },
    lines: [
      {
        lineId: "line-1",
        position: 1,
        wording: "Data export",
        billMinutes: 3 * HPD,
        proofLabels: ["Export merged"],
        // A wider read than the card's must still not reach the client.
        realMinutes: 210,
        realNote: NOTE,
        estimateMinutes: 210,
        assignee: MEMBER,
      },
      {
        lineId: "line-2",
        position: 2,
        wording: "Monitoring",
        billMinutes: 4 * HPD,
        proofLabels: ["Dashboard delivered"],
      },
    ],
  }
}

export interface Harness {
  ctx: MutationsCtx
  db: MockDb
  renders: Row[]
  mails: Row[]
  render: { failReport: boolean }
  mail: { fail: boolean }
  /** What `projects:reconcile_lines_read` answers: per reconciliation, else `value`. */
  read: { value: Row; byRec: Map<string, Row> }
  /** The approvals the draft raised, as requested. */
  approvals: Row[]
}

export function harness(): Harness {
  const db = createMockDb({ seed: { issuer_profiles: [ISSUER] } })
  const renders: Row[] = []
  const mails: Row[] = []
  const render = { failReport: false }
  const mail = { fail: false }
  const read = { value: linesRead(), byRec: new Map<string, Row>() }
  const approvals: Row[] = []
  let seq = 0
  const ctx = {
    getUserId: async () => "user-1",
    approval: { approvalRequestId: "ap-send", approvalDeciderId: "user-1", toolName: "t" },
    db,
    time: testTime(),
    pdf: {
      async render(p: Row) {
        renders.push(p)
        if (p.template_kind === "invoicing:activity_report_v1" && render.failReport)
          return { error: { code: "render_failed", message: "the renderer is down" } }
        const file_id = `file-${++seq}`
        const parent = p.parent as { commitRow?: { values: Row } } | undefined
        if (parent?.commitRow)
          await db.insert("document_attachments", { ...parent.commitRow.values, file_id })
        return {
          file_id,
          byte_size: 1,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: { post: async () => ({ message_id: `m-${++seq}` }) },
    hasScope: async () => true,
    requestApproval: async (input: Row) => {
      approvals.push(input)
      return { approval_id: crypto.randomUUID() }
    },
    approvals: { pendingFor: async () => [], withdraw: async () => ({ ok: true }) },
    decideApproval: async () => ({ status: "ok" }),
    executeTool: async (target: string, args: Row) => {
      if (target === "projects:reconcile_lines_read")
        return {
          status: "completed" as const,
          result: read.byRec.get(String(args?.reconciliationId)) ?? read.value,
        }
      if (target === "kernel:companies_read")
        return { status: "completed" as const, result: { company: { name: "Maison Alpine SA" } } }
      if (target === "mail:composeForApp") {
        mails.push(args)
        return mail.fail
          ? { status: "error" as const, error: { code: "send_failed", message: "mail is down" } }
          : { status: "completed" as const, result: { messageId: "<m-1>" } }
      }
      if (target.startsWith("stripe:"))
        return { status: "error" as const, error: { code: "tool_not_found", message: "absent" } }
      return { status: "completed" as const, result: {} }
    },
    emit: async () => {},
  } as unknown as MutationsCtx
  return { ctx, db, renders, mails, render, mail, read, approvals }
}

/** A draft from the card, issued, with a partial timesheet filed on it. */
export async function issuedFromCard(
  h: Harness,
  rec = REC,
): Promise<{ id: string; number: string }> {
  const draftId = await draftFromCard(h, rec)
  const issued = await invoiceIssue(h.ctx, { draft_id: draftId })
  if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
  const id = String((issued as { document_id?: string }).document_id)
  const doc = h.db.__all("documents").find((d) => d.id === id) as Row
  return { id, number: String(doc.number) }
}

/** A draft from the card, its recipient completed, with a partial timesheet filed on it. */
export async function draftFromCard(h: Harness, rec = REC): Promise<string> {
  const res = await draftFromReconcile(h.ctx as never, {
    reconciliationId: rec,
    revision: 1,
    leadName: "Claire Martin",
  })
  if (res.status !== "completed") throw new Error(JSON.stringify(res))
  await h.db.update("documents", res.draftId, {
    counterparty_address: "Rheinallee 4, 40545 Duesseldorf, Germany",
    counterparty_email: "billing@alpine.example",
    counterparty_country: "DE",
    counterparty_vat_id: "DE298765432",
  })
  await h.db.insert("document_attachments", {
    document_id: res.draftId,
    file_id: "timesheet-file",
    kind: "timesheet",
    partial: true,
  })
  return res.draftId
}
