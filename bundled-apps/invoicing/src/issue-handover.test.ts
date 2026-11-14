// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The issue hand-over: a draft made from a billing source (a planned vs done card, a billing step,
// an advance, a retainer month) issues as ONE new numbered document that keeps the draft's key, its
// project and its service period, takes the rows that point at the draft (activity report, annexes,
// billing step, advance deduction), and deletes the draft, all in the commit that takes the number.
//
// The in-memory store gets the manifest's own constraints here (the unique keys and the `restrict`
// references to documents), so a hand-over that keeps the key on the draft, or deletes the draft
// before its rows moved, fails the issue as Postgres would.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { issueTogether } from "./issue"
import { issueDateParts } from "./issue-date"
import {
  documentsConvertLocal,
  draftsCreate,
  draftsDiscard,
  invoiceIssue,
  type MutationsCtx,
  quoteIssue,
} from "./mutations"
import { getDraft } from "./mutations/db-helpers"
import { invoiceIssuePreflight, issueRunDraft } from "./mutations/invoice-issue"
import { DRAFT_DEPENDENTS, handOverDraft } from "./mutations/issue-handover"
import { buildIssueInputFromDraft, counterpartyFromRow } from "./mutations/lines"
import { documentsSearch } from "./reads"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"

type Row = Record<string, unknown>

const MANIFEST = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as {
  schema: Record<string, { fields: Record<string, unknown>; constraints?: { unique?: unknown[] } }>
}

/**
 * The manifest's unique keys (those with no condition, or `<col> IS NOT NULL`) and its
 * `restrict` references to documents, enforced on the store's writes. The batch calls these
 * methods, and undoes everything when one throws, as the bridge's savepoint does.
 */
function enforceManifestConstraints(db: MockDb): void {
  const uniques: Array<{ table: string; columns: string[] }> = []
  const restricts: Array<{ table: string; column: string }> = []
  for (const [table, def] of Object.entries(MANIFEST.schema)) {
    for (const u of def.constraints?.unique ?? []) {
      if (Array.isArray(u)) uniques.push({ table, columns: u as string[] })
      else {
        const c = u as { columns: string[]; where?: string }
        if (!c.where || /^\w+ IS NOT NULL$/.test(c.where))
          uniques.push({ table, columns: c.columns })
      }
    }
    for (const [column, f] of Object.entries(def.fields)) {
      const ref = (f as { references?: { table: string; onDelete?: string } })?.references
      if (ref?.table === "documents" && ref.onDelete === "restrict")
        restricts.push({ table, column })
    }
  }
  const checkUnique = (table: string, row: Row, selfId: string) => {
    for (const u of uniques.filter((x) => x.table === table)) {
      if (u.columns.some((c) => row[c] === null || row[c] === undefined)) continue
      const clash = db
        .__all(table)
        .find((r) => r.id !== selfId && u.columns.every((c) => r[c] === row[c]))
      if (clash)
        throw new Error(
          `duplicate key value violates unique constraint on ${table}(${u.columns.join(", ")})`,
        )
    }
  }
  const insert = db.insert.bind(db)
  const update = db.update.bind(db)
  const updateMany = db.updateMany.bind(db)
  const del = db.delete.bind(db)
  db.insert = async (table, data) => {
    checkUnique(table, data, String(data.id ?? ""))
    return insert(table, data)
  }
  db.update = async (table, id, patch) => {
    const existing = db.__all(table).find((r) => r.id === id) ?? {}
    checkUnique(table, { ...existing, ...patch }, id)
    return update(table, id, patch)
  }
  db.updateMany = async (table, opts) => updateMany(table, opts)
  db.delete = async (table, id) => {
    if (table === "documents") {
      for (const r of restricts) {
        if (db.__all(r.table).some((row) => row[r.column] === id)) {
          throw new Error(
            `update or delete on table "documents" violates foreign key constraint on ${r.table}.${r.column}`,
          )
        }
      }
    }
    return del(table, id)
  }
}

const ISSUER = {
  id: "iss-1",
  legal_name: "Maison Studio SAS",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue Test, 75001 Paris",
  iban: null,
  swift_bic: null,
  bank_name: null,
  default_language: "fr",
  prefix_invoice: "F-{YYYY}-",
  prefix_quote: "D-{YYYY}-",
  prefix_proforma: "P-{YYYY}-",
  prefix_po: "BC-{YYYY}-",
  prefix_credit_note: "A-{YYYY}-",
  invoice_approval_threshold_minor: null,
  po_approval_threshold_minor: null,
  require_two_eyes: false,
  mail_account_id: "acct-mail-1",
}

const RECIPIENT = {
  counterparty_contact_id: "contact-1",
  counterparty_name: "Klangwerk GmbH",
  counterparty_address: "Rheinallee 4, 40545 Duesseldorf, Germany",
  counterparty_vat_id: "DE298765432",
  counterparty_email: "billing@klangwerk.example",
  counterparty_country: "DE",
}

const ITEMS = [
  {
    position: 1,
    description: "Data export, 3 d",
    quantity: "3",
    unit_price_minor: 93_000n,
    line_kind: "service",
    product_source: null,
    external_id: null,
  },
]

const PROJECT = "7a1d2c3e-0000-4000-8000-000000000001"
const RECONCILIATION = "7a1d2c3e-0000-4000-8000-0000000000aa"
const SOURCE = {
  billing_project_id: PROJECT,
  service_period_start: "2026-10-01",
  service_period_end: "2026-10-31",
  latest_issue_on: "2026-10-31",
  approved_by: "user-1",
}

interface Harness {
  ctx: MutationsCtx
  db: MockDb
  calls: Array<{ target: string; args: Row }>
  reserved: { value: boolean; documentRef: string | null }
}

function harness(): Harness {
  const db = createMockDb({ seed: { issuer_profiles: [ISSUER] } })
  enforceManifestConstraints(db)
  const calls: Harness["calls"] = []
  const reserved = { value: true, documentRef: null as string | null }
  let seq = 0
  const ctx: MutationsCtx = {
    getUserId: async () => "user-1",
    approval: null,
    db,
    time: testTime(),
    pdf: {
      async render() {
        return {
          file_id: `pdf-${++seq}`,
          byte_size: 1024,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: {
      async post() {
        return { message_id: `msg-${++seq}` }
      },
    },
    requestApproval: async () => ({ approval_id: `appr-${++seq}` }),
    decideApproval: async () => ({ status: "ok" }),
    executeTool: async (target: string, args: Row) => {
      calls.push({ target, args })
      if (target.startsWith("stripe:")) {
        return { status: "error" as const, error: { code: "tool_not_found", message: "absent" } }
      }
      if (target === "projects:reconcile_lines_read") {
        return {
          status: "completed" as const,
          result: {
            state: "drafted",
            revision: 2,
            document_ref: reserved.documentRef,
            claimsReserved: reserved.value,
          },
        }
      }
      return { status: "completed" as const, result: {} }
    },
    emit: async () => {},
  }
  return { ctx, db, calls, reserved }
}

async function draftWith(
  h: Harness,
  key: string | null,
  opts: { type?: "invoice" | "quote"; refs?: Row } = {},
): Promise<string> {
  const created = await draftsCreate(h.ctx, {
    type: opts.type ?? "invoice",
    issuer_profile_id: ISSUER.id,
    currency: "EUR",
    items: ITEMS,
    ...RECIPIENT,
  } as never)
  const id = created.draft_id
  await h.db.update("documents", id, {
    ...(key ? { external_ref: key } : {}),
    ...SOURCE,
    ...(opts.refs ? { external_refs: opts.refs } : {}),
  })
  if (key?.startsWith("reconcile:")) h.reserved.documentRef = key
  return id
}

const issuedDocs = (db: MockDb): Row[] => db.__all("documents").filter((d) => d.status !== "draft")
const docById = (db: MockDb, id: string): Row | undefined =>
  db.__all("documents").find((d) => d.id === id)
const marks = (h: Harness) => h.calls.filter((c) => c.target === "projects:reconcile_mark")
const sequenceTotal = (db: MockDb) => [...db.__sequences.values()].reduce((a, b) => a + b, 0)

async function seedDependents(h: Harness, draftId: string): Promise<Record<string, string>> {
  const report = await h.db.insert("activity_reports", {
    document_id: draftId,
    version: 1,
    content: {},
  })
  const annex = await h.db.insert("document_attachments", {
    document_id: draftId,
    file_id: "file-1",
    kind: "timesheet",
    partial: false,
  })
  const step = await h.db.insert("billing_steps", {
    billing_project_id: PROJECT,
    position: 1,
    kind: "milestone",
    label: "Beta",
    amount_minor: 1_600_000,
    currency: "EUR",
    document_id: draftId,
    state: "drafted",
  })
  const deduction = await h.db.insert("advance_deductions", {
    advance_document_id: "advance-doc",
    final_document_id: draftId,
    amount_minor: 100_000,
    tax_rate_bp: 2000,
    line_position: 2,
    state: "reserved",
  })
  return { report: report.id, annex: annex.id, step: step.id, deduction: deduction.id }
}

describe("issuing a draft hands its source over to the invoice", () => {
  test("a draft with a source key issues as one document that keeps the key, its project and its period, and the draft is gone", async () => {
    const h = harness()
    const key = `reconcile:${RECONCILIATION}:2`
    const draftId = await draftWith(h, key)
    const res = await invoiceIssue(h.ctx, { draft_id: draftId })
    expect(res.status).toBe("completed")
    const docs = issuedDocs(h.db)
    expect(docs).toHaveLength(1)
    const doc = docs[0] as Row
    expect(doc.id).not.toBe(draftId)
    expect(doc.external_ref).toBe(key)
    expect(doc.billing_project_id).toBe(PROJECT)
    expect(doc.service_period_start).toBe("2026-10-01")
    expect(doc.service_period_end).toBe("2026-10-31")
    expect(doc.latest_issue_on).toBe("2026-10-31")
    expect(doc.approved_by).toBe("user-1")
    expect(docById(h.db, draftId)).toBeUndefined()
    // The claims flip: projects hears the issued document, by the reconciliation in the key.
    expect(marks(h).map((m) => m.args)).toEqual([
      {
        reconciliationId: RECONCILIATION,
        to: "billed",
        documentId: String(doc.id),
        documentNumber: String(doc.number),
      },
    ])
  })

  test("creating a draft takes no number and leaves the series unchanged", async () => {
    const h = harness()
    const before = sequenceTotal(h.db)
    const draftId = await draftWith(h, `reconcile:${RECONCILIATION}:1`)
    expect(sequenceTotal(h.db)).toBe(before)
    expect(docById(h.db, draftId)?.number ?? null).toBeNull()
    expect(docById(h.db, draftId)?.number_int ?? null).toBeNull()
  })

  test("a discarded draft takes no number and the series stays gapless", async () => {
    const h = harness()
    const first = await draftWith(h, null)
    await invoiceIssue(h.ctx, { draft_id: first })
    const discarded = await draftWith(h, `reconcile:${RECONCILIATION}:1`)
    await draftsDiscard(h.ctx, { draft_id: discarded })
    const last = await draftWith(h, `milestone:${PROJECT}-step-1`)
    await invoiceIssue(h.ctx, { draft_id: last })
    const numbers = issuedDocs(h.db)
      .map((d) => Number(d.number_int))
      .sort((a, b) => a - b)
    expect(numbers).toEqual([1, 2])
    expect(issuedDocs(h.db).map((d) => String(d.number))).toContain("F-2026-0002")
  })

  test("a keyed draft that keeps its key on the draft fails the issue and uses no number", async () => {
    // What the hand-over's first write (the draft gives the key up) is for: without it the new
    // document's key collides with the draft's, the commit rolls back, and no number is used.
    const h = harness()
    const key = `milestone:${PROJECT}-step-2`
    const draftId = await draftWith(h, key)
    const draft = await getDraft(h.db, draftId)
    const issuer = h.db.__all("issuer_profiles")[0] as never
    const when = await issueDateParts(h.ctx, issuer)
    if (!when.ok || !draft) throw new Error("setup")
    const handed = handOverDraft(
      draft,
      buildIssueInputFromDraft(draft, issuer, counterpartyFromRow(draft, issuer), when),
    )
    const withoutClear = { ...handed, commit_before: [] }
    const { issueDocument } = await import("./issue")
    await expect(issueDocument(h.ctx, withoutClear)).rejects.toThrow(/unique/)
    expect(sequenceTotal(h.db)).toBe(0)
    expect(docById(h.db, draftId)?.external_ref).toBe(key)
    expect(issuedDocs(h.db)).toHaveLength(0)
  })

  test("a second draft for one billing step fails on its key", async () => {
    const h = harness()
    const key = `milestone:${PROJECT}-step-1`
    await draftWith(h, key)
    await expect(draftWith(h, key)).rejects.toThrow(/unique/)
    // Still one live document for the step once the first issues.
    expect(h.db.__all("documents").filter((d) => d.external_ref === key)).toHaveLength(1)
  })

  test("the same retainer month cannot be drafted twice", async () => {
    const h = harness()
    const key = "retainer:schedule-1:2026-10"
    const first = await draftWith(h, key, { refs: { reconciliation_id: RECONCILIATION } })
    await expect(draftWith(h, key)).rejects.toThrow(/unique/)
    // Issued, the month's key lives on the invoice, and a new draft for it still fails.
    await invoiceIssue(h.ctx, { draft_id: first })
    expect(issuedDocs(h.db)[0]?.external_ref).toBe(key)
    await expect(draftWith(h, key)).rejects.toThrow(/unique/)
  })

  test("the report and annexes keep their ids and follow the draft to the invoice", async () => {
    const h = harness()
    const draftId = await draftWith(h, `reconcile:${RECONCILIATION}:3`)
    const ids = await seedDependents(h, draftId)
    const res = await invoiceIssue(h.ctx, { draft_id: draftId })
    expect(res.status).toBe("completed")
    const docId = String(issuedDocs(h.db)[0]?.id)
    const one = (table: string, id: string) => h.db.__all(table).find((r) => r.id === id)
    expect(one("activity_reports", ids.report as string)?.document_id).toBe(docId)
    expect(one("document_attachments", ids.annex as string)?.document_id).toBe(docId)
    expect(one("billing_steps", ids.step as string)?.document_id).toBe(docId)
    expect(one("advance_deductions", ids.deduction as string)?.final_document_id).toBe(docId)
  })

  test("deleting the draft before its rows moved fails the whole issue and uses no number", async () => {
    // The four tables reference documents with `restrict`: the re-points must come first.
    const h = harness()
    const draftId = await draftWith(h, `reconcile:${RECONCILIATION}:3`)
    const ids = await seedDependents(h, draftId)
    const draft = await getDraft(h.db, draftId)
    const issuer = h.db.__all("issuer_profiles")[0] as never
    const when = await issueDateParts(h.ctx, issuer)
    if (!when.ok || !draft) throw new Error("setup")
    const handed = handOverDraft(
      draft,
      buildIssueInputFromDraft(draft, issuer, counterpartyFromRow(draft, issuer), when),
    )
    const ops = handed.commit_with ?? []
    const deleteFirst = {
      ...handed,
      commit_with: [...ops.filter((o) => "delete" in o), ...ops.filter((o) => !("delete" in o))],
    }
    const { issueDocument } = await import("./issue")
    await expect(issueDocument(h.ctx, deleteFirst)).rejects.toThrow(/foreign key/)
    expect(sequenceTotal(h.db)).toBe(0)
    expect(issuedDocs(h.db)).toHaveLength(0)
    expect(docById(h.db, draftId)).toBeDefined()
    expect(h.db.__all("activity_reports").find((r) => r.id === ids.report)?.document_id).toBe(
      draftId,
    )
  })

  test("a write of the issue commit that fails leaves the draft as it was and uses no number", async () => {
    const h = harness()
    const key = `reconcile:${RECONCILIATION}:4`
    const draftId = await draftWith(h, key)
    await seedDependents(h, draftId)
    const updateMany = h.db.updateMany.bind(h.db)
    h.db.updateMany = async (table, opts) => {
      if (table === "document_attachments") throw new Error("connection lost")
      return updateMany(table, opts)
    }
    await expect(invoiceIssue(h.ctx, { draft_id: draftId })).rejects.toThrow(/connection lost/)
    expect(sequenceTotal(h.db)).toBe(0)
    expect(issuedDocs(h.db)).toHaveLength(0)
    expect(docById(h.db, draftId)?.external_ref).toBe(key)
    expect(marks(h)).toHaveLength(0)
  })

  test("a plain draft issues exactly as before", async () => {
    const h = harness()
    const created = await draftsCreate(h.ctx, {
      type: "invoice",
      issuer_profile_id: ISSUER.id,
      currency: "EUR",
      items: ITEMS,
      ...RECIPIENT,
    } as never)
    const res = await invoiceIssue(h.ctx, { draft_id: created.draft_id })
    expect(res.status).toBe("completed")
    const doc = issuedDocs(h.db)[0] as Row
    // None of the source columns is written, and there is no key: the row is the one this path
    // always wrote.
    for (const k of [
      "external_ref",
      "billing_project_id",
      "invoice_role",
      "service_period_start",
      "service_period_end",
      "approved_by",
      "approved_at",
      "latest_issue_on",
    ]) {
      expect(Object.hasOwn(doc, k)).toBe(false)
    }
    expect(doc.number).toBe("F-2026-0001")
    expect(doc.counterparty_name).toBe("Klangwerk GmbH")
    expect(doc.grand_total_minor).toBe("279000")
    expect(docById(h.db, created.draft_id)).toBeUndefined()
    expect(marks(h)).toHaveLength(0)
  })
})

describe("a billing-keyed draft keeps its key, project and period, and its claims flip, whichever path issues it", () => {
  const key = `reconcile:${RECONCILIATION}:5`

  async function expectHandedOver(h: Harness, draftId: string, docId: string, keyed = true) {
    const doc = docById(h.db, docId) as Row
    if (keyed) expect(doc.external_ref).toBe(key)
    expect(doc.billing_project_id).toBe(PROJECT)
    expect(doc.service_period_start).toBe("2026-10-01")
    expect(doc.service_period_end).toBe("2026-10-31")
    expect(docById(h.db, draftId)).toBeUndefined()
    for (const { table, column } of DRAFT_DEPENDENTS) {
      expect(h.db.__all(table).filter((r) => r[column] === draftId)).toHaveLength(0)
    }
  }

  test("invoice_issue", async () => {
    const h = harness()
    const draftId = await draftWith(h, key)
    await seedDependents(h, draftId)
    const res = (await invoiceIssue(h.ctx, { draft_id: draftId })) as { document_id: string }
    await expectHandedOver(h, draftId, res.document_id)
    expect(marks(h)[0]?.args.documentId).toBe(res.document_id)
  })

  test("a month-end run's draft", async () => {
    const h = harness()
    const draftId = await draftWith(h, key)
    await seedDependents(h, draftId)
    const res = (await issueRunDraft(h.ctx, {
      draft_id: draftId,
      external_ref: key,
      lifecycle_log: [],
    })) as { document_id: string }
    await expectHandedOver(h, draftId, res.document_id)
    expect(marks(h)[0]?.args).toMatchObject({ to: "billed", documentId: res.document_id })
  })

  test("a quote draft, then the invoice converted from that quote", async () => {
    const h = harness()
    const quoteKey = `milestone:${PROJECT}-step-3`
    const draftId = await draftWith(h, quoteKey, { type: "quote" })
    await seedDependents(h, draftId)
    h.ctx.approval = {
      approvalRequestId: "appr-q",
      approvalDeciderId: "user-2",
      toolName: "invoicing:quote_issue",
    }
    const quote = (await quoteIssue(h.ctx, { draft_id: draftId })) as { document_id: string }
    expect(docById(h.db, quote.document_id)?.external_ref).toBe(quoteKey)
    await expectHandedOver(h, draftId, quote.document_id, false)
    h.ctx.approval = null
    const invoice = (await documentsConvertLocal(h.ctx, {
      source_document_id: quote.document_id,
    } as never)) as { status: string; document_id: string }
    expect(invoice.status).toBe("completed")
    const doc = docById(h.db, invoice.document_id) as Row
    expect(doc.billing_project_id).toBe(PROJECT)
    expect(doc.service_period_start).toBe("2026-10-01")
    // The quote keeps its own key: one live document per source.
    expect(Object.hasOwn(doc, "external_ref")).toBe(false)
  })

  test("several documents issued together", async () => {
    const h = harness()
    const draftId = await draftWith(h, key)
    await seedDependents(h, draftId)
    const draft = await getDraft(h.db, draftId)
    const other = await draftWith(h, "retainer:schedule-9:2026-10")
    const otherDraft = await getDraft(h.db, other)
    const issuer = h.db.__all("issuer_profiles")[0] as never
    const when = await issueDateParts(h.ctx, issuer)
    if (!when.ok || !draft || !otherDraft) throw new Error("setup")
    const input = (d: NonNullable<typeof draft>) =>
      handOverDraft(d, buildIssueInputFromDraft(d, issuer, counterpartyFromRow(d, issuer), when))
    const out = await issueTogether(h.ctx, [
      ["invoice", input(draft)],
      ["month", input(otherDraft)],
    ] as const)
    await expectHandedOver(h, draftId, out.invoice.document_id)
    expect(docById(h.db, out.month.document_id)?.external_ref).toBe("retainer:schedule-9:2026-10")
    expect(docById(h.db, other)).toBeUndefined()
  })
})

describe("a draft from a planned vs done card", () => {
  test("discarding a draft from planned vs done releases its month", async () => {
    const h = harness()
    const draftId = await draftWith(h, `reconcile:${RECONCILIATION}:6`)
    const ids = await seedDependents(h, draftId)
    await draftsDiscard(h.ctx, { draft_id: draftId })
    expect(docById(h.db, draftId)).toBeUndefined()
    expect(marks(h).map((m) => m.args)).toEqual([
      { reconciliationId: RECONCILIATION, to: "released" },
    ])
    // Its report and annexes go with it, its step is planned again, its deduction is freed.
    expect(h.db.__all("activity_reports")).toHaveLength(0)
    expect(h.db.__all("document_attachments")).toHaveLength(0)
    expect(h.db.__all("advance_deductions")).toHaveLength(0)
    const step = h.db.__all("billing_steps").find((r) => r.id === ids.step)
    expect(step?.document_id ?? null).toBeNull()
    expect(step?.state).toBe("planned")
  })

  test("discarding a plain draft tells projects nothing", async () => {
    const h = harness()
    const draftId = await draftWith(h, null)
    await draftsDiscard(h.ctx, { draft_id: draftId })
    expect(marks(h)).toHaveLength(0)
  })

  test("a draft whose card changed is refused before any number or card", async () => {
    const h = harness()
    const draftId = await draftWith(h, `reconcile:${RECONCILIATION}:7`)
    h.reserved.value = false
    const pre = await invoiceIssuePreflight(h.ctx, { draft_id: draftId })
    expect(JSON.stringify(pre)).toContain("reconcile_changed")
    const res = await invoiceIssue(h.ctx, { draft_id: draftId })
    expect(res).toMatchObject({ status: "error", error: { code: "reconcile_changed" } })
    expect(sequenceTotal(h.db)).toBe(0)
    expect(docById(h.db, draftId)).toBeDefined()
  })

  test("a draft whose reconciliation was made again under another key is refused", async () => {
    const h = harness()
    const draftId = await draftWith(h, `reconcile:${RECONCILIATION}:7`)
    h.reserved.documentRef = `reconcile:${RECONCILIATION}:8`
    const res = await invoiceIssue(h.ctx, { draft_id: draftId })
    expect(res).toMatchObject({ status: "error", error: { code: "reconcile_changed" } })
    expect(sequenceTotal(h.db)).toBe(0)
  })

  test("a mark that fails leaves the invoice issued for the sweep to settle", async () => {
    const h = harness()
    const draftId = await draftWith(h, `reconcile:${RECONCILIATION}:9`)
    const base = h.ctx.executeTool
    h.ctx.executeTool = async (target, args) => {
      if (target === "projects:reconcile_mark") throw new Error("projects unavailable")
      return base(target, args)
    }
    const res = await invoiceIssue(h.ctx, { draft_id: draftId })
    expect(res.status).toBe("completed")
    expect(issuedDocs(h.db)[0]?.external_ref).toBe(`reconcile:${RECONCILIATION}:9`)
  })
})

describe("a project's documents", () => {
  test("documents_search finds the invoices that bill one project", async () => {
    const h = harness()
    const billed = await draftWith(h, `reconcile:${RECONCILIATION}:10`)
    await invoiceIssue(h.ctx, { draft_id: billed })
    const plain = await draftsCreate(h.ctx, {
      type: "invoice",
      issuer_profile_id: ISSUER.id,
      currency: "EUR",
      items: ITEMS,
      ...RECIPIENT,
    } as never)
    await invoiceIssue(h.ctx, { draft_id: plain.draft_id })
    const found = await documentsSearch(h.ctx as never, { project_id: PROJECT, status: "issued" })
    expect(found.map((d) => d.number)).toEqual(["F-2026-0001"])
    expect(await documentsSearch(h.ctx as never, { project_id: "not-a-uuid" })).toEqual([])
  })
})
