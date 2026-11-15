// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Retainers: a recurring schedule with included hours and an overage rate, whose month is
// invoiced from its planned vs done card, never by the month-end run. The fee, the overage above
// the included and rolled-in hours, a waiver for one month, a prepaid month settled by a final,
// and the one predicate every drafting path asks.

import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { harness as runHarness, schedule as runSchedule } from "./__fixtures__/recurring-draft"
import { draftsDiscard, invoiceIssue, type MutationsCtx } from "./mutations"
import { advanceDraftCreate } from "./mutations/advances"
import { reconcileDraftDiscard, retainerDraftFromReconcile } from "./mutations/retainer"
import { recurringDraftJob } from "./recurring/draft-job"
import { importSchedules } from "./recurring/import-kind"
import {
  isRetainerMonth,
  isRetainerSchedule,
  retainerMonth,
  rolloverOut,
} from "./recurring/retainer"
import {
  checkScheduleInput,
  type RecurringCtx,
  recurringScheduleCreate,
  recurringScheduleUpdate,
} from "./recurring/tools"
import { retainerTimeboxRoll } from "./retainer-timebox-roll"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"
import { previewTotals } from "./tools/preview-totals"

type Row = Record<string, unknown>

const ISSUER = {
  id: "iss-1",
  legal_name: "Maison Studio SAS",
  country: "FR",
  vat_id: "FR12345678901",
  address: "1 rue Test, 75001 Paris",
  default_currency: "EUR",
  default_language: "fr",
  timezone: "Europe/Paris",
  prefix_invoice: "F-{YYYY}-",
  prefix_credit_note: "A-{YYYY}-",
  invoice_approval_threshold_minor: null,
  require_two_eyes: false,
}
const PROJECT = "7a1d2c3e-0000-4000-8000-000000000001"
const COMPANY = "7a1d2c3e-0000-4000-8000-0000000000c1"
const SCHEDULE = "7a1d2c3e-0000-4000-8000-0000000000f1"
const CONTACT = "7a1d2c3e-0000-4000-8000-0000000000e1"
const REC_OCT = "7a1d2c3e-0000-4000-8000-0000000000a1"
const REC_NOV = "7a1d2c3e-0000-4000-8000-0000000000a2"
const REC_DEC = "7a1d2c3e-0000-4000-8000-0000000000a3"
const H = 60

function retainerSchedule(over: Row = {}): Row {
  return {
    id: SCHEDULE,
    issuer_profile_id: ISSUER.id,
    company_id: COMPANY,
    contact_id: null,
    status: "active",
    repeats: "month",
    billing_day: "last",
    covers: "period_ended",
    issue_mode: "review",
    lines: [{ description: "Monthly retainer", qty: 1, unit_price_minor: 450_000, vat_bp: 2000 }],
    retainer_project_id: PROJECT,
    retainer_minutes: 40 * H,
    retainer_overage_rate_minor: 12_000,
    retainer_rollover: "none",
    retainer_from: "2026-10",
    version: 1,
    ...over,
  }
}

function card(id: string, month: string, usedHours: number, over: Row = {}): Row {
  const [y, m] = month.split("-").map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return {
    reconciliationId: id,
    projectId: PROJECT,
    projectName: "Maison Sorbier site",
    companyId: COMPANY,
    basis: "retainer",
    state: "proposed",
    revision: 1,
    documentRef: `retainer:${SCHEDULE}:${month}`,
    claimsReserved: true,
    period: { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` },
    timeboxMinutes: 40 * H,
    rate: { rateMinor: null, currency: "EUR", hoursPerDayMinutes: 420, unit: "hour" },
    lines: [
      {
        lineId: `${id}-l1`,
        position: 1,
        wording: "Site upkeep",
        billMinutes: usedHours * H,
        proofLabels: [],
      },
    ],
    ...over,
  }
}

function harness(opts: { schedule?: Row; docs?: Row[]; lines?: Row[]; scopes?: string[] } = {}) {
  const db = createMockDb({
    seed: {
      issuer_profiles: [ISSUER],
      counterparty_identities: [
        {
          id: "ident-1",
          contact_id: "contact-1",
          vat_id: "DE298765432",
          customer_kind: "business",
        },
      ],
      recurring_schedules: [opts.schedule ?? retainerSchedule()],
      ...(opts.docs ? { documents: opts.docs } : {}),
      ...(opts.lines ? { document_lines: opts.lines } : {}),
    },
  })
  const cards = new Map<string, Row>()
  const marks: Row[] = []
  const approvals: Array<Row & { id: string; status: string }> = []
  const scopes = new Set(opts.scopes ?? ["invoicing:documents:write"])
  const ctx = {
    getUserId: async () => "user-1",
    approval: null,
    db,
    time: testTime(),
    pdf: {
      async render() {
        return {
          file_id: crypto.randomUUID(),
          byte_size: 1,
          page_count: 1,
          sha256: "0".repeat(64),
          parent_entity_id: crypto.randomUUID(),
        }
      },
    },
    messages: { post: async () => ({ message_id: crypto.randomUUID() }) },
    hasScope: async (s: string) => scopes.has(s),
    requestApproval: async (input: Row) => {
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
      if (target === "projects:reconcile_lines_read")
        return { status: "completed" as const, result: cards.get(String(params.reconciliationId)) }
      if (target === "projects:reconcile_mark") {
        marks.push(params)
        return { status: "completed" as const, result: { changed: true } }
      }
      if (target === "kernel:companies_read")
        return {
          status: "completed" as const,
          result: {
            company: {
              name: "Maison Sorbier SA",
              billingAddress: {
                street1: "2 rue Haute",
                postalCode: "69001",
                city: "Lyon",
                countryIso2: "FR",
              },
              email: "compta@sorbier.example",
            },
          },
        }
      if (target === "kernel:contacts_read")
        return {
          status: "completed" as const,
          result: {
            contact: {
              id: params.contactId,
              name: "Anne Sorbier",
              email: "compta@sorbier.example",
            },
          },
        }
      if (target === "kernel:contacts_addresses_list")
        return {
          status: "completed" as const,
          result: {
            addresses: [
              {
                role: "billing",
                street1: "2 Hochstrasse",
                postalCode: "10115",
                city: "Berlin",
                countryIso2: "DE",
              },
            ],
          },
        }
      if (target.startsWith("stripe:"))
        return { status: "error" as const, error: { code: "tool_not_found", message: "absent" } }
      return { status: "completed" as const, result: {} }
    },
    emit: async () => {},
  } as unknown as MutationsCtx & { hasScope(s: string): Promise<boolean> }
  return { ctx, db, cards, marks, approvals, scopes }
}

const docs = (db: MockDb): Row[] => db.__all("documents")
const linesOf = (db: MockDb, id: string) =>
  db
    .__all("document_lines")
    .filter((l) => l.document_id === id)
    .map((l) => [l.description, String(l.quantity), String(l.unit_price_minor)])

async function draft(h: ReturnType<typeof harness>, rec: string, waive = false) {
  const res = await retainerDraftFromReconcile(h.ctx, {
    reconciliationId: rec,
    revision: 1,
    ...(waive ? { waiveOverage: true } : {}),
  })
  if (res.status !== "completed") throw new Error(JSON.stringify(res))
  return res
}

describe("a retainer month's invoice", () => {
  test("a month of 46 h on a 40 h retainer bills the 4,500.00 fee and 6 h at 120.00: 5,220.00 and 6,264.00, and under the timebox no overage line", async () => {
    const h = harness()
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 46))
    const res = await draft(h, REC_OCT)
    expect(res.totals).toEqual({ excl: 522_000, vat: 104_400, incl: 626_400, currency: "EUR" })
    const d = docs(h.db)[0] as Row
    expect(d.external_ref).toBe(`retainer:${SCHEDULE}:2026-10`)
    expect(d.number ?? null).toBeNull()
    expect(d.billing_project_id).toBe(PROJECT)
    expect(d.service_period_start).toBe("2026-10-01")
    expect(linesOf(h.db, String(d.id))).toEqual([
      ["Monthly retainer", "1", "450000"],
      ["Hours above the retainer, 2026-10", "6", "12000"],
    ])
    const overage = h.db
      .__all("document_lines")
      .find((l) => String(l.external_id).startsWith("retainer_overage"))
    expect(overage).toBeDefined()
    expect(res.message).toContain("No number was taken")

    const under = harness()
    under.cards.set(REC_OCT, card(REC_OCT, "2026-10", 30))
    const u = await draft(under, REC_OCT)
    expect(u.totals.excl).toBe(450_000)
    expect(linesOf(under.db, u.draftId)).toEqual([["Monthly retainer", "1", "450000"]])
  })

  test("waiving this month's overage leaves next month unaffected", async () => {
    const h = harness()
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 46))
    h.cards.set(REC_NOV, card(REC_NOV, "2026-11", 46))
    const oct = await draft(h, REC_OCT, true)
    expect(oct.totals).toMatchObject({ excl: 450_000, incl: 540_000 })
    expect(oct.retainer).toMatchObject({ overage_minutes: 0, waived_minutes: 6 * H })
    expect(oct.message).toContain("waived this month")
    const nov = await draft(h, REC_NOV)
    expect(nov.totals).toMatchObject({ excl: 522_000, incl: 626_400 })
  })

  test("unused hours roll to the next month only, capped, never to the month after", async () => {
    // Pure rule, as a table: [included, used] -> hours passed on.
    const table: Array<[number, number, number]> = [
      [40, 30, 10],
      [40, 0, 40],
      [40, 40, 0],
      [40, 55, 0],
    ]
    for (const [inc, used, out] of table)
      expect(rolloverOut("next", inc * H, used * H)).toBe(out * H)
    expect(rolloverOut("none", 40 * H, 0)).toBe(0)
    // Rolled-in hours count before any overage, and at most the month's timebox.
    expect(
      retainerMonth({
        includedMinutes: 2400,
        usedMinutes: 3300,
        rolloverInMinutes: 600,
        waived: false,
      }).overageMinutes,
    ).toBe(300)
    expect(
      retainerMonth({
        includedMinutes: 2400,
        usedMinutes: 0,
        rolloverInMinutes: 9000,
        waived: false,
      }).rolloverInMinutes,
    ).toBe(2400)

    // Through the drafts: October uses 30 h, November gets 10 h more and uses 50 h (no overage),
    // December gets nothing from October.
    const h = harness({ schedule: retainerSchedule({ retainer_rollover: "next" }) })
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 30))
    h.cards.set(REC_NOV, card(REC_NOV, "2026-11", 50))
    h.cards.set(REC_DEC, card(REC_DEC, "2026-12", 45))
    await draft(h, REC_OCT)
    const nov = await draft(h, REC_NOV)
    expect(nov.retainer).toMatchObject({ rollover_in_minutes: 10 * H, overage_minutes: 0 })
    const dec = await draft(h, REC_DEC)
    expect(dec.retainer).toMatchObject({ rollover_in_minutes: 0, overage_minutes: 5 * H })
  })

  test("a task bills in October and November but a month is drafted only once", async () => {
    const h = harness()
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
    h.cards.set(REC_NOV, card(REC_NOV, "2026-11", 40))
    const a = await draft(h, REC_OCT)
    const again = await draft(h, REC_OCT)
    const b = await draft(h, REC_NOV)
    expect(again.created).toBe(false)
    expect(again.draftId).toBe(a.draftId)
    expect(b.draftId).not.toBe(a.draftId)
    expect(
      docs(h.db)
        .map((d) => d.external_ref)
        .sort(),
    ).toEqual([`retainer:${SCHEDULE}:2026-10`, `retainer:${SCHEDULE}:2026-11`])
  })

  test("a prepaid retainer issues an advance each month and a final with the deduction", async () => {
    const advance = {
      id: "7a1d2c3e-0000-4000-8000-0000000000d1",
      type: "invoice",
      status: "issued",
      number: "F-2026-0040",
      issued_at: "2026-10-01",
      invoice_role: "advance",
      billing_project_id: PROJECT,
      service_period_start: "2026-10-01",
      grand_total_minor: "540000",
      currency: "EUR",
    }
    const advLine = {
      id: "adv-l1",
      document_id: advance.id,
      subtotal_minor: "450000",
      tax_rate_bp: 2000,
    }
    const h = harness({
      schedule: retainerSchedule({ covers: "period_ahead" }),
      docs: [advance],
      lines: [advLine],
    })
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
    const zero = await draft(h, REC_OCT)
    expect(zero.totals.incl).toBe(0)
    const d = docs(h.db).find((x) => x.id === zero.draftId) as Row
    expect(d).toMatchObject({ invoice_role: "final", payment_state: "final_after_deposit" })
    expect(h.db.__all("advance_deductions")).toEqual([
      expect.objectContaining({ advance_document_id: advance.id, final_document_id: zero.draftId }),
    ])

    // With overage, the final bills it: 6 h at 120.00.
    const o = harness({
      schedule: retainerSchedule({ covers: "period_ahead" }),
      docs: [advance],
      lines: [advLine],
    })
    o.cards.set(REC_OCT, card(REC_OCT, "2026-10", 46))
    expect((await draft(o, REC_OCT)).totals).toMatchObject({ excl: 72_000, incl: 86_400 })
  })

  test("a prepaid retainer deducts each month's own advance, after its credits, three months running", async () => {
    const h = harness({
      schedule: retainerSchedule({ covers: "period_ahead", contact_id: "contact-1" }),
    })
    const advance = async (month?: string) => {
      const res = await advanceDraftCreate(h.ctx, {
        projectId: PROJECT,
        amountMinor: 450_000,
        contactId: CONTACT,
        ...(month ? { month } : {}),
      })
      if (res.status !== "completed") throw new Error(JSON.stringify(res))
      const before = new Set(docs(h.db).map((d) => d.id))
      await invoiceIssue(h.ctx, { draft_id: res.draftId } as never)
      return docs(h.db).find(
        (d) => d.status === "issued" && d.invoice_role === "advance" && !before.has(d.id),
      ) as Row
    }
    const finalOf = async (rec: string, month: string) => {
      h.cards.set(rec, card(rec, month, 40))
      const res = await draft(h, rec)
      await invoiceIssue(h.ctx, { draft_id: res.draftId } as never)
      return res
    }
    const deducted = (advanceId: unknown) =>
      h.db
        .__all("advance_deductions")
        .filter((x) => x.advance_document_id === advanceId && x.state !== "released")
        .map((x) => String(x.amount_minor))

    // October's and November's advances are both issued before October's final.
    const oct = await advance("2026-10")
    const nov = await advance("2026-11")
    expect(oct.service_period_start).toBe("2026-10-01")
    expect(oct.service_period_end).toBe("2026-10-31")
    expect(nov.external_ref).toBe(`advance:${PROJECT}:2026-11`)
    const f1 = await finalOf(REC_OCT, "2026-10")
    expect(f1.totals.incl).toBe(0)
    expect([deducted(oct.id), deducted(nov.id)]).toEqual([["450000"], []])

    // October's final does not block December's advance; November deducts only its own.
    const dec = await advance("2026-12")
    expect(dec.status).toBe("issued")
    const f2 = await finalOf(REC_NOV, "2026-11")
    expect(f2.totals.incl).toBe(0)
    expect([deducted(nov.id), deducted(dec.id)]).toEqual([["450000"], []])

    // December's advance was credited 900.00 incl. VAT: the final deducts what remains of it.
    h.db.__seed("documents", [
      {
        id: crypto.randomUUID(),
        type: "credit_note",
        status: "issued",
        original_document_id: dec.id,
        grand_total_minor: -108_000n,
        lifecycle_log: [],
      },
    ])
    const f3 = await finalOf(REC_DEC, "2026-12")
    expect(f3.totals).toMatchObject({ excl: 90_000, incl: 108_000 })
    expect(deducted(dec.id)).toEqual(["360000"])

    // The same month twice is refused; an advance with no month takes the month after the last.
    const again = await advanceDraftCreate(h.ctx, {
      projectId: PROJECT,
      amountMinor: 450_000,
      contactId: CONTACT,
      month: "2026-11",
    })
    expect(again).toMatchObject({ status: "error", error: { code: "already_drafted" } })
    expect((await advance()).service_period_start).toBe("2027-01-01")
  })

  test("a prepaid retainer waits on one issue approval per project at a time", async () => {
    const h = harness({
      schedule: retainerSchedule({ covers: "period_ahead", contact_id: "contact-1" }),
    })
    const waiting = () => h.approvals.filter((a) => a.status === "pending")
    const oct = await advanceDraftCreate(h.ctx, {
      projectId: PROJECT,
      amountMinor: 450_000,
      contactId: CONTACT,
      month: "2026-10",
    })
    if (oct.status !== "completed") throw new Error(JSON.stringify(oct))
    await invoiceIssue(h.ctx, { draft_id: oct.draftId } as never)
    // November's advance waits on its approval when October's final is drafted.
    const nov = await advanceDraftCreate(h.ctx, {
      projectId: PROJECT,
      amountMinor: 450_000,
      contactId: CONTACT,
      month: "2026-11",
    })
    if (nov.status !== "completed") throw new Error(JSON.stringify(nov))
    expect(waiting()).toHaveLength(1)
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
    const final = await draft(h, REC_OCT)
    expect(final.approvalId).toBeNull()
    expect(final.message).toContain(nov.draftId)
    expect(waiting().map((a) => (a.current_payload as Row).draft_id)).toEqual([nov.draftId])
    // Once November's advance is issued, October's final takes its place.
    await invoiceIssue(h.ctx, { draft_id: nov.draftId } as never)
    expect(waiting().map((a) => (a.current_payload as Row).draft_id)).toEqual([final.draftId])
  })

  test("a prepaid retainer raises the held approval once the waiting one is turned down or runs out", async () => {
    for (const ended of ["rejected", "expired"]) {
      const h = harness({
        schedule: retainerSchedule({ covers: "period_ahead", contact_id: "contact-1" }),
      })
      const waiting = () => h.approvals.filter((a) => a.status === "pending")
      const oct = await advanceDraftCreate(h.ctx, {
        projectId: PROJECT,
        amountMinor: 450_000,
        contactId: CONTACT,
        month: "2026-10",
      })
      if (oct.status !== "completed") throw new Error(JSON.stringify(oct))
      await invoiceIssue(h.ctx, { draft_id: oct.draftId } as never)
      const nov = await advanceDraftCreate(h.ctx, {
        projectId: PROJECT,
        amountMinor: 450_000,
        contactId: CONTACT,
        month: "2026-11",
      })
      if (nov.status !== "completed") throw new Error(JSON.stringify(nov))
      h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
      const final = await draft(h, REC_OCT)
      expect(final.approvalId).toBeNull()
      // November's request ends without an issue: the hourly job raises the held final, once.
      for (const a of waiting()) a.status = ended
      await recurringDraftJob(h.ctx as never)
      expect(waiting().map((a) => (a.current_payload as Row).draft_id)).toEqual([final.draftId])
      await recurringDraftJob(h.ctx as never)
      expect(waiting()).toHaveLength(1)
      // The turned-down draft is not asked again by itself.
      expect(
        h.approvals.filter((a) => (a.current_payload as Row).draft_id === nov.draftId),
      ).toHaveLength(1)
    }
  })

  test("a second card for a month already drafted is refused, named, and never attached to that draft", async () => {
    const h = harness()
    const OTHER = "7a1d2c3e-0000-4000-8000-0000000000b1"
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
    h.cards.set(OTHER, card(OTHER, "2026-10", 12))
    const first = await draft(h, REC_OCT)
    const second = await retainerDraftFromReconcile(h.ctx, { reconciliationId: OTHER, revision: 1 })
    expect(second).toMatchObject({ status: "error", error: { code: "month_on_other_card" } })
    const message = second.status === "error" ? second.error.message : ""
    expect(message).toContain(first.draftId)
    expect(message).toContain("Nothing was made")
    expect(docs(h.db)).toHaveLength(1)
    // The other card's Undo cannot discard the first card's draft.
    expect(
      await reconcileDraftDiscard(h.ctx, { draft_id: first.draftId, reconciliationId: OTHER }),
    ).toMatchObject({ status: "error", error: { code: "not_a_card_draft" } })
    expect(docs(h.db).map((d) => d.id)).toEqual([first.draftId])
  })

  test("a month whose invoice was credited in full is drafted again from its new card", async () => {
    const h = harness({ schedule: retainerSchedule({ contact_id: "contact-1" }) })
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
    const res = await draft(h, REC_OCT)
    await invoiceIssue(h.ctx, { draft_id: res.draftId } as never)
    const issued = docs(h.db).find((d) => d.status === "issued") as Row
    h.db.__seed("documents", [
      {
        id: crypto.randomUUID(),
        type: "credit_note",
        status: "issued",
        original_document_id: issued.id,
        grand_total_minor: -BigInt(String(issued.grand_total_minor)),
        lifecycle_log: [],
      },
    ])
    const AGAIN = "7a1d2c3e-0000-4000-8000-0000000000b2"
    const rebill = `retainer:${SCHEDULE}:2026-10:2`
    h.cards.set(AGAIN, card(AGAIN, "2026-10", 40, { documentRef: rebill }))
    const next = await draft(h, AGAIN)
    expect(next.created).toBe(true)
    expect(docs(h.db).find((d) => d.id === next.draftId)?.external_ref).toBe(rebill)
  })

  test("a schedule made a retainer on 15 Nov keeps November on the run and reconciles from December", async () => {
    const s = retainerSchedule({ retainer_from: "2026-12" })
    expect(isRetainerMonth(s, "2026-11")).toBe(false)
    expect(isRetainerMonth(s, "2026-12")).toBe(true)
    // The retainer side: November is refused, December drafts.
    const h = harness({ schedule: s })
    h.cards.set(REC_NOV, card(REC_NOV, "2026-11", 40))
    h.cards.set(REC_DEC, card(REC_DEC, "2026-12", 40))
    const nov = await retainerDraftFromReconcile(h.ctx, { reconciliationId: REC_NOV, revision: 1 })
    expect(nov).toMatchObject({ status: "error", error: { code: "period_on_run" } })
    expect((await draft(h, REC_DEC)).month).toBe("2026-12")

    // The run side: November drafts on the run; in December the run drafts nothing.
    const runId = "33333333-3333-4333-8333-333333333331"
    const r = runHarness("2026-11-27", {
      schedules: [
        runSchedule(runId, {
          retainer_project_id: PROJECT,
          retainer_minutes: 2400,
          retainer_from: "2026-12",
        }),
      ],
    })
    expect((await recurringDraftJob(r.ctx)).drafted).toBe(1)
    const dec = runHarness("2026-12-28", {
      schedules: [
        runSchedule(runId, {
          retainer_project_id: PROJECT,
          retainer_minutes: 2400,
          retainer_from: "2026-12",
          next_issue_on: "2026-12-31",
          next_draft_on: "2026-12-28",
        }),
      ],
    })
    expect((await recurringDraftJob(dec.ctx)).drafted).toBe(0)
  })

  test("a month the run already drafted is refused and makes nothing", async () => {
    const h = harness({
      docs: [
        {
          id: "run-doc",
          type: "invoice",
          status: "draft",
          external_ref: `recurring:${SCHEDULE}:2026-10`,
        },
      ],
    })
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
    const res = await retainerDraftFromReconcile(h.ctx, { reconciliationId: REC_OCT, revision: 1 })
    expect(res).toMatchObject({ status: "error", error: { code: "period_on_run" } })
    expect(docs(h.db)).toHaveLength(1)
  })

  test("the month-end job drafts nothing for a retainer", async () => {
    const r = runHarness("2026-11-27", {
      schedules: [
        runSchedule("33333333-3333-4333-8333-333333333331", {
          retainer_project_id: PROJECT,
          retainer_minutes: 2400,
          retainer_from: "2026-10",
        }),
      ],
    })
    const res = await recurringDraftJob(r.ctx)
    expect(res.drafted).toBe(0)
    expect(r.db.__all("documents")).toHaveLength(0)
    expect(r.db.__all("recurring_run_items")).toHaveLength(0)
  })

  test("issuing the retainer draft marks its reconciliation billed, and discarding it releases the month", async () => {
    const h = harness({ schedule: retainerSchedule({ contact_id: "contact-1" }) })
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 46))
    const res = await draft(h, REC_OCT)
    const issued = await invoiceIssue(h.ctx, { draft_id: res.draftId } as never)
    expect(JSON.stringify(issued)).not.toContain('"status":"error"')
    const doc = docs(h.db).find((d) => d.status === "issued") as Row
    expect(doc.external_ref).toBe(`retainer:${SCHEDULE}:2026-10`)
    expect(doc.billing_project_id).toBe(PROJECT)
    expect(doc.service_period_start).toBe("2026-10-01")
    expect(h.marks).toContainEqual(
      expect.objectContaining({ reconciliationId: REC_OCT, to: "billed" }),
    )

    const d2 = harness()
    d2.cards.set(REC_NOV, card(REC_NOV, "2026-11", 40))
    const nov = await draft(d2, REC_NOV)
    await draftsDiscard(d2.ctx, { draft_id: nov.draftId })
    expect(d2.marks).toContainEqual(
      expect.objectContaining({ reconciliationId: REC_NOV, to: "released" }),
    )
  })

  test("issuing a retainer draft whose card no longer reserves it is refused with no number", async () => {
    const h = harness({ schedule: retainerSchedule({ contact_id: "contact-1" }) })
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
    const res = await draft(h, REC_OCT)
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40, { claimsReserved: false }))
    const out = await invoiceIssue(h.ctx, { draft_id: res.draftId } as never)
    expect(JSON.stringify(out)).toContain("reconcile_changed")
    expect(docs(h.db).every((d) => (d.number ?? null) === null)).toBe(true)
  })

  test("the card's own discard removes its draft only, never another document", async () => {
    const h = harness({
      docs: [{ id: "plain", type: "invoice", status: "draft", external_ref: null }],
    })
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
    const res = await draft(h, REC_OCT)
    expect(await reconcileDraftDiscard(h.ctx, { draft_id: "plain" })).toMatchObject({
      status: "error",
      error: { code: "not_a_card_draft" },
    })
    expect(await reconcileDraftDiscard(h.ctx, { draft_id: res.draftId })).toMatchObject({
      status: "completed",
    })
    expect(docs(h.db).map((d) => d.id)).toEqual(["plain"])
    expect(h.marks).toContainEqual(
      expect.objectContaining({ reconciliationId: REC_OCT, to: "released" }),
    )
  })

  test("the card's preview prices a retainer month as its draft will be", async () => {
    const h = harness()
    const p = await previewTotals(h.ctx as never, {
      projectId: PROJECT,
      basis: "retainer",
      companyId: COMPANY,
      currency: null,
      rateMinor: null,
      periodFrom: "2026-10-01",
      timeboxMinutes: 40 * H,
      lines: [{ billMinutes: 46 * H }],
    })
    expect(p).toMatchObject({ ready: true, excl: 522_000, vat: 104_400, incl: 626_400 })
    // The card offers to waive only what is above the retainer: six hours here.
    expect(p).toMatchObject({ overageMinutes: 6 * H })
    const none = harness({ schedule: retainerSchedule({ status: "ended" }) })
    const q = await previewTotals(none.ctx as never, {
      projectId: PROJECT,
      basis: "retainer",
      companyId: COMPANY,
      periodFrom: "2026-10-01",
      lines: [{ billMinutes: 46 * H }],
    })
    expect(q).toMatchObject({ ready: false, missing: ["retainer"] })
  })
})

// ---------------------------------------------------------------------------------------------
// Saving a retainer

function scheduleCtx(opts: { scopes?: string[]; seed?: Row[] } = {}) {
  const db = createMockDb({
    seed: {
      issuer_profiles: [ISSUER],
      ...(opts.seed ? { recurring_schedules: opts.seed } : {}),
    },
  })
  const calls: Row[] = []
  const scopes = new Set(opts.scopes ?? ["invoicing:documents:write", "projects:money:write"])
  const ctx = {
    getUserId: async () => "user-1",
    db: db as never,
    time: testTime(),
    approval: null,
    hasScope: async (s: string) => scopes.has(s),
    executeTool: async (target: string, params: Row) => {
      if (target.startsWith("stripe:"))
        return { status: "error" as const, error: { code: "tool_not_found", message: "absent" } }
      calls.push({ target, ...params })
      return { status: "completed" as const, result: {} }
    },
  } as unknown as RecurringCtx
  return { ctx, db, calls }
}

const RETAINER_INPUT = {
  issuer_profile_id: ISSUER.id,
  contact_id: "contact-1",
  company_id: COMPANY,
  repeats: "month" as const,
  billing_day: "last",
  lines: [{ description: "Monthly retainer", qty: 1, unit_price_minor: 450_000, vat_bp: 2000 }],
  retainer_project_id: PROJECT,
  retainer_minutes: 40 * H,
  retainer_overage_rate_minor: 12_000,
}

describe("saving a retainer", () => {
  test("a retainer cannot issue by itself", async () => {
    expect(checkScheduleInput({ ...RETAINER_INPUT, issue_mode: "auto" })).toMatchObject({
      error: { code: "retainer_needs_reconcile" },
    })
    const c = scheduleCtx({ seed: [retainerSchedule({ id: SCHEDULE, contact_id: "contact-1" })] })
    const up = await recurringScheduleUpdate(c.ctx, { id: SCHEDULE, issue_mode: "auto" })
    expect(up).toMatchObject({ status: "error", error: { code: "retainer_needs_reconcile" } })
    expect(checkScheduleInput({ ...RETAINER_INPUT, retainer_minutes: 0 })).toMatchObject({
      error: { code: "invalid_schedule" },
    })
    expect(
      checkScheduleInput({ ...RETAINER_INPUT, retainer_overage_rate_minor: -1 }),
    ).toMatchObject({ error: { code: "invalid_schedule" } })
  })

  test("a retainer is refused on a schedule that does not repeat every month", async () => {
    for (const repeats of ["quarter", "year"] as const)
      expect(checkScheduleInput({ ...RETAINER_INPUT, repeats })).toMatchObject({
        error: { code: "invalid_schedule", message: expect.stringContaining("every month") },
      })
    const c = scheduleCtx({ seed: [retainerSchedule({ id: SCHEDULE, contact_id: "contact-1" })] })
    const up = await recurringScheduleUpdate(c.ctx, { id: SCHEDULE, repeats: "year" })
    expect(up).toMatchObject({ status: "error", error: { code: "invalid_schedule" } })
    expect(c.db.__all("recurring_schedules")[0]?.repeats).toBe("month")
    const imported = await importSchedules(
      {
        records: [
          {
            dedupValue: "ext-q",
            record: {
              externalRef: "ext-q",
              contactId: "contact-1",
              repeats: "quarter",
              billingDay: "last",
              retainerProjectId: PROJECT,
              retainerMinutes: 2400,
              retainerOverageRateMinor: 12_000,
              lines: [{ description: "Retainer", unitPriceMinor: 450_000, taxRateBp: 2000 }],
            },
          },
        ],
      } as never,
      scheduleCtx().ctx as never,
    )
    expect(imported[0]).toMatchObject({ status: "failed" })
  })

  test("an imported retainer cannot issue by itself", async () => {
    const c = scheduleCtx()
    const out = await importSchedules(
      {
        records: [
          {
            dedupValue: "ext-1",
            record: {
              externalRef: "ext-1",
              contactId: "contact-1",
              repeats: "month",
              billingDay: "last",
              issueMode: "auto",
              retainerProjectId: PROJECT,
              retainerMinutes: 2400,
              retainerOverageRateMinor: 12_000,
              lines: [{ description: "Retainer", unitPriceMinor: 450_000, taxRateBp: 2000 }],
            },
          },
        ],
      } as never,
      c.ctx as never,
    )
    expect(out[0]).toMatchObject({ status: "failed" })
    expect(String(out[0]?.error)).toContain("retainer_needs_reconcile")
    expect(c.db.__all("recurring_schedules")).toHaveLength(0)
  })

  test("a finance-only invoicing member cannot set a project's retainer", async () => {
    const c = scheduleCtx({ scopes: ["invoicing:documents:write"] })
    const res = await recurringScheduleCreate(c.ctx, RETAINER_INPUT)
    expect(res).toMatchObject({ status: "error", error: { code: "retainer_needs_project_money" } })
    expect(c.db.__all("recurring_schedules")).toHaveLength(0)
    expect(c.calls).toHaveLength(0)
  })

  test("saving a retainer writes this and next month's timeboxes and the daily job adds the next", async () => {
    const c = scheduleCtx()
    const res = await recurringScheduleCreate(c.ctx, RETAINER_INPUT)
    if (res.status !== "completed") throw new Error(JSON.stringify(res))
    const [row] = c.db.__all("recurring_schedules")
    expect(isRetainerSchedule(row)).toBe(true)
    const writes = c.calls.filter((x) => x.target === "projects:period_timebox_set")
    expect(writes.map((w) => [w.month, w.timebox, w.sourceRef])).toHaveLength(2)
    expect(
      writes.every((w) => w.projectId === PROJECT && w.timebox === "40h" && w.sourceRef === res.id),
    ).toBe(true)
    expect(res.message).toContain("never drafts it")
    const roll = await retainerTimeboxRoll(c.ctx as never)
    expect(roll.written).toBe(1)
    expect(c.calls.at(-1)).toMatchObject({ target: "projects:period_timebox_set", timebox: "40h" })
  })

  test("a prepaid retainer's terms carry the warning", async () => {
    const c = scheduleCtx()
    const res = await recurringScheduleCreate(c.ctx, { ...RETAINER_INPUT, covers: "period_ahead" })
    expect(res).toMatchObject({ status: "completed" })
    expect((res as { warning?: string }).warning).toContain("accountant")
    const plain = await recurringScheduleCreate(scheduleCtx().ctx, RETAINER_INPUT)
    expect((plain as { warning?: string }).warning).toBeUndefined()
  })
})

describe("the latest issue day on a retainer month's approval", () => {
  afterEach(() => setSystemTime())

  test("a retainer month reconciled in the next month's first days is late from its creation, on one approval", async () => {
    setSystemTime(new Date(Date.UTC(2026, 10, 3, 12)))
    const h = harness()
    h.cards.set(REC_OCT, card(REC_OCT, "2026-10", 40))
    await draft(h, REC_OCT)
    expect(h.approvals).toHaveLength(1)
    const detail = h.approvals[0]?.summary_detail as { lines: string[]; latest_on?: string }
    expect(detail.latest_on).toBe("2026-10-31")
    expect(detail.lines.at(-1)).toBe(
      "Late: the latest issue date was 2026-10-31; it issues with the date of the day it is issued",
    )
  })
})
