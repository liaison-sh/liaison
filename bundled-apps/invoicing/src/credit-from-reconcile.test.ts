// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Correcting one billed line of an invoice made from a planned vs done card: a credit note citing
// the invoice, for what the line billed too much, waiting for a person when an agent asks, checked
// again when it is approved, with a corrected activity report and the project told what the line
// now bills. The invoice itself is never edited.

import { describe, expect, test } from "bun:test"
import { invoiceIssue, type MutationsCtx } from "./mutations"
import { creditFromReconcile } from "./mutations/credit-from-reconcile"
import { creditNoteIssue } from "./mutations/credit-notes"
import { draftFromReconcile } from "./mutations/from-reconcile"
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
const TOOL = "invoicing:credit_note_from_reconcile"
const BUYER = {
  counterparty_address: "12 rue du Port, 69002 Lyon",
  counterparty_email: "billing@alpine.example",
  counterparty_country: "FR",
  billing_line1: "12 rue du Port",
  billing_postcode: "69002",
  billing_city: "Lyon",
  billing_country_code: "FR",
  customer_kind: "individual",
}
const ADVANCE = "7a1d2c3e-0000-4000-8000-0000000000d1"
const FINAL = "7a1d2c3e-0000-4000-8000-0000000000d2"

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
  calls: Array<{ target: string; params: Row }>
  read: { value: Row }
  /** A person's own click: the kernel grants the handler's approval request inline. */
  person: { value: boolean }
}

function harness(): Harness {
  const db = createMockDb({ seed: { issuer_profiles: [ISSUER] } })
  const approvals: Harness["approvals"] = []
  const calls: Harness["calls"] = []
  const read = { value: linesRead() }
  const person = { value: true }
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
    hasScope: async () => true,
    requestApproval: async (input: Row) => {
      if (person.value) return { approval_id: null, auto_approved: true }
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
    executeTool: async (target: string, params: Row) => {
      calls.push({ target, params })
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
  return { ctx, db, approvals, calls, read, person }
}

/** The card's October invoice, issued by a person: 3 d and 4 d at 930.00, 20% VAT. */
async function issuedInvoice(h: Harness): Promise<Row> {
  const made = await draftFromReconcile(h.ctx, {
    reconciliationId: REC,
    revision: 2,
  })
  if (made.status !== "completed") throw new Error(JSON.stringify(made))
  await h.db.update("documents", made.draftId, {
    ...BUYER,
  })
  const issued = await invoiceIssue(h.ctx, { draft_id: made.draftId })
  if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
  h.read.value = linesRead({ state: "invoiced", claimsReserved: false })
  h.calls.length = 0
  return h.db.__all("documents").find((d) => d.id === issued.document_id) as Row
}

const creditNotes = (db: MockDb) => db.__all("documents").filter((d) => d.type === "credit_note")
const linesOf = (db: MockDb, id: unknown) =>
  db.__all("document_lines").filter((l) => l.document_id === id)
const marks = (h: Harness) => h.calls.filter((c) => c.target === "projects:reconcile_mark")
const approvalCtx = (h: Harness) =>
  ({
    ...h.ctx,
    approval: { approvalRequestId: "ap-1", approvalDeciderId: "user-2", toolName: TOOL },
  }) as unknown as MutationsCtx

describe("a correction of a billed line", () => {
  test(`"Data export was 2.5 days, not 3" gives a pending credit note of -465.00, -93.00, -558.00 citing the invoice's number and date`, async () => {
    const h = harness()
    const invoice = await issuedInvoice(h)
    h.person.value = false
    const res = await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-1",
      correctedQuantity: 2.5,
    })
    expect(res).toMatchObject({
      status: "pending_approval",
      totals: { excl: -46_500, vat: -9_300, incl: -55_800, currency: "EUR" },
    })
    const message = (res as { message: string }).message
    expect(message).toContain(
      `invoice ${String(invoice.number)} of ${String(invoice.issued_at).slice(0, 10)}`,
    )
    expect(message).toContain("not issued until a person approves it")
    expect(h.approvals).toHaveLength(1)
    expect(h.approvals[0]).toMatchObject({
      tool_name: TOOL,
      current_payload: { reconciliationId: REC, lineId: "line-1", correctedQuantity: "2.5" },
      approve_scope: "invoicing:documents:write",
    })
    expect(h.approvals[0]?.auto_approvable).toBeUndefined()
    expect(creditNotes(h.db)).toHaveLength(0)

    // Approved: the note issues in the credit note series, citing the invoice, with its key.
    const done = await creditFromReconcile(approvalCtx(h), h.approvals[0]?.current_payload as Row)
    expect(done).toMatchObject({ status: "completed" })
    const [note] = creditNotes(h.db)
    expect(String(note?.number)).toMatch(/^A-2026-/)
    expect(note?.original_document_id).toBe(invoice.id)
    expect(note?.external_ref).toBe(`credit:${REC}:line-1:1`)
    expect(BigInt(String(note?.subtotal_minor))).toBe(-46_500n)
    expect(BigInt(String(note?.tax_total_minor))).toBe(-9_300n)
    expect(BigInt(String(note?.grand_total_minor))).toBe(-55_800n)
    const refs = note?.external_refs as Row
    expect(refs.original_document_number).toBe(invoice.number)
    expect(
      linesOf(h.db, note?.id).map((l) => [
        String(l.quantity),
        String(l.unit_price_minor),
        l.external_id,
      ]),
    ).toEqual([["0.5", "-93000", "reconcile_line:line-1"]])
  })

  test("the billed figure moves when the credit note issues, with a corrected report, and the invoice row is unchanged", async () => {
    const h = harness()
    const invoice = await issuedInvoice(h)
    const before = JSON.stringify(h.db.__all("documents").find((d) => d.id === invoice.id))
    const linesBefore = JSON.stringify(linesOf(h.db, invoice.id))

    // Parked: nothing moves yet.
    h.person.value = false
    await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-1",
      correctedQuantity: 2.5,
    })
    expect(marks(h)).toHaveLength(0)
    expect(h.db.__all("activity_reports")).toHaveLength(1)

    const done = await creditFromReconcile(approvalCtx(h), h.approvals[0]?.current_payload as Row)
    if (done.status !== "completed") throw new Error(JSON.stringify(done))
    const note = creditNotes(h.db)[0] as Row
    expect(marks(h)).toEqual([
      {
        target: "projects:reconcile_mark",
        params: {
          reconciliationId: REC,
          to: "partly_credited",
          documentId: invoice.id,
          creditedMinutesByLine: { "line-1": HPD / 2 },
        },
      },
    ])
    const reports = h.db
      .__all("activity_reports")
      .sort((a, b) => Number(a.version) - Number(b.version))
    expect(reports).toHaveLength(2)
    expect(reports[1]).toMatchObject({
      document_id: invoice.id,
      version: 2,
      corrects_version: 1,
      credit_note_id: note.id,
    })
    const content = reports[1]?.content as { lines: Row[] }
    expect(content.lines.map((l) => [l.wording, l.billed])).toEqual([
      ["Data export", "2.5"],
      ["Monitoring", "4"],
    ])
    expect((reports[0]?.content as { lines: Row[] } | undefined)?.lines[0]?.billed).toBe("3")

    // The invoice itself: only its log gained the credit note entry; its lines are untouched.
    const after = h.db.__all("documents").find((d) => d.id === invoice.id) as Row
    const { lifecycle_log: _a, updated_at: _b, ...rest } = after
    const { lifecycle_log: _c, updated_at: _d, ...restBefore } = JSON.parse(before) as Row
    expect(JSON.parse(JSON.stringify(rest))).toEqual(restBefore)
    expect(JSON.stringify(linesOf(h.db, invoice.id))).toBe(linesBefore)
  })

  test("a credit above what remains and a correction raising billed are refused", async () => {
    const h = harness()
    await issuedInvoice(h)
    const raise = await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-1",
      correctedQuantity: 3.5,
    })
    expect(raise).toMatchObject({ status: "error", error: { code: "use_new_line" } })
    const same = await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-1",
      correctedQuantity: "3",
    })
    expect(same).toMatchObject({ status: "error", error: { code: "nothing_to_credit" } })

    // A hand-made credit note already took most of the invoice: the correction would pass it.
    const invoice = h.db.__all("documents").find((d) => d.type === "invoice") as Row
    await h.db.update("documents", String(invoice.id), {
      lifecycle_log: [
        ...((invoice.lifecycle_log as Row[] | undefined) ?? []),
        { event: "credit_note_issued", credit_note_id: "cn-manual", number: "A-2026-0099" },
      ],
    })
    await h.db.insert("documents", {
      id: "cn-manual",
      type: "credit_note",
      status: "issued",
      number: "A-2026-0099",
      original_document_id: invoice.id,
      currency: "EUR",
      subtotal_minor: -630_000n,
      tax_total_minor: -126_000n,
      grand_total_minor: -756_000n,
      external_refs: { original_document_id: invoice.id },
    })
    const over = await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-1",
      correctedQuantity: 2.5,
    })
    expect(over).toMatchObject({ status: "error", error: { code: "over_credit" } })
    expect(creditNotes(h.db)).toHaveLength(1)
  })

  test("a full credit frees the sources for a new revision", async () => {
    const h = harness()
    h.read.value = linesRead({ lines: [(linesRead().lines as Row[])[0]] })
    const made = await draftFromReconcile(h.ctx, { reconciliationId: REC, revision: 2 })
    if (made.status !== "completed") throw new Error(JSON.stringify(made))
    await h.db.update("documents", made.draftId, {
      ...BUYER,
    })
    const issued = await invoiceIssue(h.ctx, { draft_id: made.draftId })
    if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
    h.read.value = linesRead({ state: "invoiced", lines: [(linesRead().lines as Row[])[0]] })
    h.calls.length = 0
    const res = await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-1",
      correctedQuantity: 0,
    })
    expect(res).toMatchObject({ status: "completed" })
    expect(marks(h)).toHaveLength(1)
    expect(marks(h)[0]?.params).toMatchObject({ to: "credited", documentId: issued.document_id })
    expect((res as { message: string }).message).toContain("can be billed again")
  })

  test("time entered after issue moves margin only", async () => {
    const h = harness()
    const invoice = await issuedInvoice(h)
    const invoiceBefore = JSON.stringify(h.db.__all("documents"))
    const reportsBefore = JSON.stringify(h.db.__all("activity_reports"))
    // More time logged on the project after the issue: the card's lines read longer now.
    const longer = (linesRead().lines as Row[]).map((l) => ({
      ...l,
      billMinutes: Number(l.billMinutes) + 2 * HPD,
    }))
    h.read.value = linesRead({ state: "invoiced", lines: longer })
    // Nothing in invoicing moved, and a correction still starts from the issued 3 days.
    expect(JSON.stringify(h.db.__all("documents"))).toBe(invoiceBefore)
    expect(JSON.stringify(h.db.__all("activity_reports"))).toBe(reportsBefore)
    const raise = await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-1",
      correctedQuantity: 4,
    })
    expect(raise).toMatchObject({ status: "error", error: { code: "use_new_line" } })
    expect((raise as { error: { message: string } }).error.message).toContain(
      `billed 3 days on invoice ${String(invoice.number)}`,
    )
  })

  test("an agent's or a coding agent's correction waits for a person; a person's click runs on their scope", async () => {
    const h = harness()
    await issuedInvoice(h)
    h.person.value = false
    const agent = await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-1",
      correctedQuantity: 2.5,
    })
    expect(agent).toMatchObject({ status: "pending_approval" })
    // Asked again while it waits (a double click, a second agent turn): the same approval.
    const again = await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-1",
      correctedQuantity: 2.5,
    })
    expect(again).toMatchObject({
      status: "pending_approval",
      approval_id: (agent as { approval_id: string }).approval_id,
    })
    expect(h.approvals).toHaveLength(1)
    expect(creditNotes(h.db)).toHaveLength(0)

    // A person's own click: the kernel decides it by the tool's scope and it issues at once.
    h.person.value = true
    const click = await creditFromReconcile(h.ctx, {
      reconciliationId: REC,
      lineId: "line-2",
      correctedQuantity: 3,
    })
    expect(click).toMatchObject({ status: "completed" })
    expect(creditNotes(h.db)).toHaveLength(1)
  })

  test("two parked corrections of one line: the second is refused when approved", async () => {
    const h = harness()
    await issuedInvoice(h)
    const payload = { reconciliationId: REC, lineId: "line-1", correctedQuantity: "2.5" }
    const first = await creditFromReconcile(approvalCtx(h), payload)
    expect(first).toMatchObject({ status: "completed" })
    const second = await creditFromReconcile(approvalCtx(h), payload)
    expect(second).toMatchObject({ status: "error", error: { code: "nothing_to_credit" } })
    // A deeper second correction credits only what the first left: 2.5 to 2 days.
    const deeper = await creditFromReconcile(approvalCtx(h), { ...payload, correctedQuantity: 2 })
    expect(deeper).toMatchObject({ status: "completed" })
    const notes = creditNotes(h.db)
    expect(notes.map((n) => n.external_ref)).toEqual([
      `credit:${REC}:line-1:1`,
      `credit:${REC}:line-1:2`,
    ])
    expect(notes.map((n) => BigInt(String(n.subtotal_minor)))).toEqual([-46_500n, -46_500n])
    expect(marks(h).at(-1)?.params.creditedMinutesByLine).toEqual({ "line-1": HPD })
  })
})

describe("issuing a credit-note draft", () => {
  test("a credit-note draft of an advance a live final deducts is refused", async () => {
    const h = harness()
    await h.db.insert("documents", {
      id: ADVANCE,
      type: "invoice",
      invoice_role: "advance",
      status: "issued",
      number: "F-2026-0201",
      currency: "EUR",
      grand_total_minor: 120_000n,
    })
    await h.db.insert("documents", {
      id: FINAL,
      type: "invoice",
      invoice_role: "final",
      status: "draft",
      currency: "EUR",
      grand_total_minor: 0n,
    })
    await h.db.insert("advance_deductions", {
      advance_document_id: ADVANCE,
      final_document_id: FINAL,
      state: "planned",
    })
    const draft = await h.db.insert("documents", {
      type: "credit_note",
      status: "draft",
      issuer_profile_id: "iss-1",
      currency: "EUR",
      counterparty_name: "Maison Alpine SA",
      ...BUYER,
      external_refs: { original_document_id: ADVANCE },
    })
    await h.db.insert("document_lines", {
      document_id: (draft as Row).id,
      position: 1,
      description: "Refund",
      quantity: "1",
      unit_price_minor: -100_000n,
      line_kind: "service",
    })
    const res = await creditNoteIssue(h.ctx, { draft_id: String((draft as Row).id) })
    expect(res).toMatchObject({ status: "error", error: { code: "advance_already_deducted" } })
    expect(creditNotes(h.db).filter((d) => d.status !== "draft")).toHaveLength(0)
  })
})
