// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every invoice is due: by the date given on it, else the customer's payment terms, else the
// issuer's, counted from the day it is issued. Once due, it is found overdue like any other.
import { describe, expect, test } from "bun:test"
import {
  draftFromCard,
  harness,
  issuedFromCard,
  type Harness,
} from "./__tests__/from-reconcile-harness"
import { overdueScanJob } from "./handlers/overdue-scan"
import { invoiceIssue } from "./mutations"
import { draftIssuePreview } from "./mutations/quote-proforma-po"
import { dueOn, paymentTermsOf, scheduleTermsDays, termsDays, termsText } from "./payment-terms"
import { addDays } from "./recurring/schedule"

type Row = Record<string, unknown>
const day = (v: unknown) => String(v ?? "").slice(0, 10)
const docOf = (h: Harness, id: string) => h.db.__all("documents").find((d) => d.id === id) as Row
const contactOf = (h: Harness) =>
  String(h.db.__all("counterparty_identities")[0]?.contact_id ?? "")

async function withIssuerTerms(h: Harness, days: number | null) {
  const [issuer] = h.db.__all("issuer_profiles")
  await h.db.update("issuer_profiles", String(issuer?.id), { default_payment_terms_days: days })
}

describe("the due date of an invoice made from a planned vs done card", () => {
  test("is the issuer's terms after the day it issues, on the row", async () => {
    const h = harness()
    await withIssuerTerms(h, 45)
    const { id } = await issuedFromCard(h)
    const doc = docOf(h, id)
    expect(day(doc.due_at)).toBe(addDays(day(doc.issued_at), 45))
  })

  test("is the customer's terms when the customer has some, 0 days included", async () => {
    for (const days of [10, 0]) {
      const h = harness()
      await withIssuerTerms(h, 45)
      const draftId = await draftFromCard(h)
      const contact = String(docOf(h, draftId).counterparty_contact_id)
      const row = h.db.__all("counterparty_identities").find((r) => r.contact_id === contact)
      if (row)
        await h.db.update("counterparty_identities", String(row.id), { payment_terms_days: days })
      else
        await h.db.insert("counterparty_identities", {
          contact_id: contact,
          payment_terms_days: days,
        })
      const issued = await invoiceIssue(h.ctx, { draft_id: draftId })
      if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
      const doc = docOf(h, String((issued as { document_id?: string }).document_id))
      expect(day(doc.due_at)).toBe(addDays(day(doc.issued_at), days))
    }
  })

  test("is the date given on the draft when there is one, and reaches the printed document", async () => {
    const h = harness()
    const draftId = await draftFromCard(h)
    await h.db.update("documents", draftId, { due_at: "2027-03-09" })
    const issued = await invoiceIssue(h.ctx, { draft_id: draftId })
    if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
    const id = String((issued as { document_id?: string }).document_id)
    expect(day(docOf(h, id).due_at)).toBe("2027-03-09")
  })

  test("is on the rendered document, and on the card before it issues", async () => {
    const h = harness()
    await withIssuerTerms(h, 45)
    const draftId = await draftFromCard(h)
    const card = h.approvals[0] as { summary_detail: { lines: string[] } }
    expect(card.summary_detail.lines).toContain("Due 45 days after issue")
    const preview = await draftIssuePreview(h.ctx as never, { draft_id: draftId })
    expect(preview?.due_terms).toBe("45 days after issue")
    const issued = await invoiceIssue(h.ctx, { draft_id: draftId })
    if (issued.status !== "completed") throw new Error(JSON.stringify(issued))
    const doc = docOf(h, String((issued as { document_id?: string }).document_id))
    expect(JSON.stringify(h.renders)).toContain(`"due_at":"${day(doc.due_at)}`)
  })

  test("makes it overdue the day after, and an invoice of zero never is", async () => {
    const h = harness()
    const { id } = await issuedFromCard(h)
    const due = day(docOf(h, id).due_at)
    const emitted: Row[] = []
    const ctx = { db: h.db, emit: async (e: Row) => void emitted.push(e) } as never
    await overdueScanJob(ctx, { now: new Date(`${due}T06:00:00Z`) })
    expect(emitted).toEqual([])
    await overdueScanJob(ctx, { now: new Date(`${addDays(due, 2)}T06:00:00Z`) })
    expect(emitted.map((e) => e.entityId)).toEqual([id])
    emitted.length = 0
    await h.db.update("documents", id, { grand_total_minor: "0" })
    await overdueScanJob(ctx, { now: new Date(`${addDays(due, 2)}T06:00:00Z`) })
    expect(emitted).toEqual([])
  })
})

describe("payment terms", () => {
  test("a schedule's own due rule comes first, whatever the customer and the issuer have", async () => {
    const h = harness()
    const issuer = { id: "iss-1", default_payment_terms_days: 45 }
    const refs = { due_days: scheduleTermsDays({ due_rule: "days_n", due_days: 14 }) }
    expect(
      await paymentTermsOf(h.db, { issuer, contactId: contactOf(h), externalRefs: refs }),
    ).toEqual({ days: 14, from: "schedule" })
    expect(
      await paymentTermsOf(h.db, {
        issuer,
        contactId: contactOf(h),
        externalRefs: JSON.stringify(refs),
      }),
    ).toEqual({ days: 14, from: "schedule" })
    expect(scheduleTermsDays({ due_rule: "on_issue" })).toBe(0)
    expect(scheduleTermsDays({ due_rule: "days_30" })).toBe(30)
    expect(scheduleTermsDays({})).toBe(30)
  })

  test("an issuer with no days recorded falls back to 30; nonsense is not a term", async () => {
    const h = harness()
    expect(
      await paymentTermsOf(h.db, {
        issuer: { id: "iss-1", default_payment_terms_days: null },
        contactId: null,
      }),
    ).toEqual({ days: 30, from: "issuer" })
    for (const bad of [-1, 1.5, "x", 1000, "", null, undefined]) expect(termsDays(bad)).toBeNull()
    expect(dueOn("2026-12-31T23:00:00Z", 1)).toBe("2027-01-01")
    expect([termsText(0), termsText(1), termsText(30)]).toEqual([
      "on the day it is issued",
      "1 day after issue",
      "30 days after issue",
    ])
  })
})
