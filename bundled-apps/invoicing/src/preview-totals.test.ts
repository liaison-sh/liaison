// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The card's invoice preview: its totals with VAT, and what must be set before an invoice can be
// made from it, named before any draft exists.

import { describe, expect, test } from "bun:test"
import { activityReportText, buildActivityReport } from "./activity-report"
import { lineAmountMinor, lineQuantity } from "./line-amount"
import { createMockDb } from "./test-db"
import { documentAttachmentAdd } from "./tools/document-attachment-add"
import { previewTotals } from "./tools/preview-totals"

type Row = Record<string, unknown>

const ISSUER = {
  id: "iss-1",
  legal_name: "Maison Studio SAS",
  country: "FR",
  default_currency: "EUR",
}
const PROJECT = "7a1d2c3e-0000-4000-8000-000000000001"
const COMPANY = "7a1d2c3e-0000-4000-8000-0000000000c1"
const OTHER_COMPANY = "7a1d2c3e-0000-4000-8000-0000000000c2"
const CONTACT = "7a1d2c3e-0000-4000-8000-0000000000d1"
const HPD = 420

function ctxWith(opts: { issuer?: boolean; steps?: Row[]; contactCompany?: string } = {}) {
  const db = createMockDb({
    seed: {
      issuer_profiles: opts.issuer === false ? [] : [ISSUER],
      billing_steps: opts.steps ?? [],
    },
  })
  return {
    db,
    executeTool: async (target: string) => {
      if (target === "kernel:contacts_read")
        return {
          status: "completed" as const,
          result: { contact: { companyId: opts.contactCompany ?? COMPANY } },
        }
      return { status: "completed" as const, result: {} }
    },
  }
}

const CARD = {
  projectId: PROJECT,
  basis: "daily",
  companyId: COMPANY,
  currency: "EUR",
  rateMinor: 93_000,
  hoursPerDayMinutes: HPD,
  lines: [{ billMinutes: 3 * HPD }, { billMinutes: 4 * HPD }],
}

describe("the card's invoice preview", () => {
  test("the October lines preview 6,510.00 excl. VAT, 1,302.00 VAT and 7,812.00 incl. VAT", async () => {
    const r = await previewTotals(ctxWith() as never, CARD)
    expect(r).toMatchObject({
      ready: true,
      missing: [],
      excl: 651_000,
      vat: 130_200,
      incl: 781_200,
      rateBp: 2000,
      currency: "EUR",
    })
  })

  test("an org without an issuer profile is told before any draft", async () => {
    const r = await previewTotals(ctxWith({ issuer: false }) as never, CARD)
    if ("error" in r) throw new Error(r.error.message)
    expect(r.ready).toBe(false)
    expect(r.missing).toContain("issuer_profile")
    expect(r.message).toContain("issuer profile")
  })

  test("a missing rate or currency is named", async () => {
    const r = await previewTotals(ctxWith() as never, { ...CARD, rateMinor: null, currency: null })
    if ("error" in r) throw new Error(r.error.message)
    expect(r.missing).toEqual(expect.arrayContaining(["rate", "currency"]))
    expect(r.excl).toBeNull()
    const noCompany = await previewTotals(ctxWith() as never, { ...CARD, companyId: null })
    if ("error" in noCompany) throw new Error(noCompany.error.message)
    expect(noCompany.missing).toContain("company")
  })

  test("a project whose company differs from the counterparty is named", async () => {
    const r = await previewTotals(ctxWith({ contactCompany: OTHER_COMPANY }) as never, {
      ...CARD,
      contactId: CONTACT,
    })
    if ("error" in r) throw new Error(r.error.message)
    expect(r.missing).toContain("counterparty_mismatch")
    const same = await previewTotals(ctxWith() as never, { ...CARD, contactId: CONTACT })
    if ("error" in same) throw new Error(same.error.message)
    expect(same.missing).not.toContain("counterparty_mismatch")
  })

  test("a fixed-price project or one with a billing plan has nothing to create", async () => {
    const fixed = await previewTotals(ctxWith() as never, { ...CARD, basis: "fixed" })
    if ("error" in fixed) throw new Error(fixed.error.message)
    expect(fixed.ready).toBe(false)
    expect(fixed.missing).toContain("basis")
    const planned = await previewTotals(
      ctxWith({
        steps: [
          { billing_project_id: PROJECT, position: 1, state: "issued" },
          { billing_project_id: PROJECT, position: 2, state: "planned" },
        ],
      }) as never,
      CARD,
    )
    if ("error" in planned) throw new Error(planned.error.message)
    expect(planned.missing).toContain("basis")
    expect(planned.openPlanSteps).toBe(1)
  })
})

describe("one rule for a billed line's amount", () => {
  test("minutes become a quantity rounded half up to two decimals, priced as the issued line", () => {
    // 1 h = 60 min; 0.005 h = 0.3 min: around the .5 boundary of the second decimal.
    expect(lineQuantity(3 * HPD, "day", HPD)).toBe("3")
    expect(lineQuantity(90, "hour", 60)).toBe("1.5")
    // 7 h 20 min = 7.333 h -> 7.33; 7 h 21 min = 7.35 h; 1 min = 0.0166 h -> 0.02.
    expect(lineQuantity(440, "hour", 60)).toBe("7.33")
    expect(lineQuantity(441, "hour", 60)).toBe("7.35")
    expect(lineQuantity(1, "hour", 60)).toBe("0.02")
    // Days at 7 h: 1 min short of half a hundredth (N-1), on it (N), past it (N+1).
    // 0.005 d * 420 = 2.1 min: 2 min -> 0.0047 d -> 0; 3 min -> 0.0071 d -> 0.01.
    expect(lineQuantity(2, "day", HPD)).toBe("0")
    expect(lineQuantity(3, "day", HPD)).toBe("0.01")
    // Exactly half a hundredth: 0.005 h = 0.3 min cannot be hit in whole minutes; at 200 min a day
    // 1 min = 0.005 d, the tie rounds up.
    expect(lineQuantity(1, "day", 200)).toBe("0.01")
    expect(lineAmountMinor(440, "hour", 12_000, 60)).toBe(87_960n)
    expect(lineAmountMinor(7 * HPD, "day", 93_000, HPD)).toBe(651_000n)
  })
})

// The member names, notes and real figures a card may hold, which no report may carry.
const MEMBER = "Tomas Novak"
const NOTE = "spent ages debugging the export"
const REAL_FORMS = ["3.5", "3,5", "3 h 30"]

describe("the client activity report", () => {
  const content = buildActivityReport({
    project: { id: PROJECT, name: "Maison Alpine platform" },
    period: { from: "2026-10-01", to: "2026-10-31" },
    hoursPerDayMinutes: HPD,
    lines: [
      {
        wording: "Data export",
        billedMinutes: 3 * HPD,
        unit: "day",
        proofLabels: ["Export merged"],
      },
      {
        wording: "Monitoring",
        billedMinutes: 4 * HPD,
        unit: "day",
        proofLabels: ["Dashboard delivered"],
      },
    ],
    lead: "Claire Martin",
  })

  test("the report holds no real time, note, estimate, member name or unplanned line, in any form a French PDF prints", () => {
    const FORBIDDEN_KEYS = /real|note|estimate|member|assignee|unplanned|minutes|person|user/i
    const walk = (v: unknown, path: string) => {
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          expect(`${path}.${k}`).not.toMatch(FORBIDDEN_KEYS)
          walk(x, `${path}.${k}`)
        }
      }
    }
    walk(content, "report")
    const printed = [
      JSON.stringify(content),
      activityReportText(content, "fr"),
      activityReportText(content, "en"),
    ]
    for (const text of printed) {
      expect(text).not.toContain(MEMBER)
      expect(text).not.toContain(NOTE)
      for (const f of REAL_FORMS) expect(text).not.toContain(f)
    }
    // The typed input has no field for any of them: passing one is a compile error.
    buildActivityReport({
      project: { id: PROJECT, name: "x" },
      period: { from: "2026-10-01", to: "2026-10-31" },
      hoursPerDayMinutes: HPD,
      // @ts-expect-error a real figure has no place in the report's input
      lines: [{ wording: "x", billedMinutes: 60, unit: "hour", proofLabels: [], realMinutes: 210 }],
      lead: null,
    })
  })

  test("the report is signed by the project lead and carries the card's proof labels", () => {
    expect(content.signedBy).toBe("Claire Martin")
    expect(content.lines).toEqual([
      { wording: "Data export", billed: "3", unit: "day", proofLabels: ["Export merged"] },
      { wording: "Monitoring", billed: "4", unit: "day", proofLabels: ["Dashboard delivered"] },
    ])
    const fr = activityReportText(content, "fr")
    expect(fr).toContain("Data export: 3 jours (Export merged)")
    expect(fr).toContain("Signé : Claire Martin")
  })
})

describe("filing an annex on an invoice", () => {
  const DOC = "7a1d2c3e-0000-4000-8000-0000000000e1"
  const FILE = "7a1d2c3e-0000-4000-8000-0000000000f1"
  function annexCtx(status: string, readable: boolean, scopes = ["invoicing:documents:write"]) {
    const db = createMockDb({
      seed: {
        documents: [
          { id: DOC, type: "invoice", status, number: status === "draft" ? null : "F-2026-0042" },
        ],
      },
    })
    const attached: Row[] = []
    return {
      db,
      attached,
      ctx: {
        db,
        hasScope: async (s: string) => scopes.includes(s),
        files: {
          attachToParent: async (args: Row) => {
            if (!readable) throw new Error("PARENT_NOT_FOUND: Source file not visible to caller")
            attached.push(args)
            return { id: "copy-1" }
          },
        },
      },
    }
  }

  test("an annex is filed on a draft and refused on a sent invoice", async () => {
    const a = annexCtx("draft", true)
    const r = await documentAttachmentAdd(a.ctx as never, {
      documentId: DOC,
      fileId: FILE,
      kind: "timesheet",
      partial: true,
    })
    expect(r).toMatchObject({
      status: "completed",
      fileId: "copy-1",
      kind: "timesheet",
      partial: true,
    })
    const rows = a.db.__all("document_attachments")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      document_id: DOC,
      file_id: "copy-1",
      kind: "timesheet",
      partial: true,
    })
    expect(a.attached[0]).toMatchObject({
      targetApp: "invoicing",
      targetEntityType: "document_attachment",
    })

    const sent = annexCtx("sent", true)
    const s = await documentAttachmentAdd(sent.ctx as never, {
      documentId: DOC,
      fileId: FILE,
      kind: "timesheet",
    })
    expect(s.status === "error" && s.error.code).toBe("document_sent")
    expect(sent.db.__all("document_attachments")).toHaveLength(0)
  })

  test("a file the caller cannot read is refused and nothing is filed", async () => {
    const a = annexCtx("draft", false)
    const r = await documentAttachmentAdd(a.ctx as never, {
      documentId: DOC,
      fileId: FILE,
      kind: "activity_report",
    })
    expect(r.status === "error" && r.error.code).toBe("file_not_readable")
    expect(a.db.__all("document_attachments")).toHaveLength(0)
    const noScope = annexCtx("draft", true, [])
    const n = await documentAttachmentAdd(noScope.ctx as never, {
      documentId: DOC,
      fileId: FILE,
      kind: "timesheet",
    })
    expect(n.status === "error" && n.error.code).toBe("forbidden")
    expect(noScope.attached).toHaveLength(0)
  })
})
