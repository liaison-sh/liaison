// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Received tab's view model against its charter: statuses in words with their official code,
// rows without provider ids, the empty state explaining where invoices come from, the file's own
// totals beside the platform's when they differ, an XML original never previewed, the history in
// words, the platform's reasons in plain words, and no action on a refused, rejected or paid
// invoice (the tab saying why) or while a decision awaits approval.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  confirmText,
  detailView,
  EMPTY_TEXT,
  FILTERS,
  listRows,
  localDateTime,
  type ReceivedDetailData,
  statusText,
} from "./view"

const listSource = readFileSync(join(import.meta.dir, "ReceivedList.tsx"), "utf8")
const detailSource = readFileSync(join(import.meta.dir, "ReceivedDetail.tsx"), "utf8")

const REASONS = [
  {
    reason: "duplicate_invoice",
    afnor_code: "DOUBLON",
    label_en: "Duplicate invoice",
    label_fr: "Facture en double",
  },
  {
    reason: "incorrect_vat_rate",
    afnor_code: "TX_TVA_ERR",
    label_en: "Incorrect VAT rate",
    label_fr: "Taux de TVA erroné",
  },
]

function data(
  over: Partial<ReceivedDetailData["invoice"]> = {},
  rest: Partial<ReceivedDetailData> = {},
): ReceivedDetailData {
  return {
    status: "ok",
    invoice: {
      id: "r1",
      supplier: { name: "Fournisseur Exemple", siren: "732829320", vat_id: "FR44732829320" },
      invoice_number: "FS-1",
      issue_date: "2026-11-03",
      due_date: "2026-12-03",
      currency: "EUR",
      totals: { before_tax: "100.0", tax: "20.0", total: "120.0" },
      file_facts: { totals: { before_tax: "100.00", tax: "20.00", total: "120.00" } },
      totals_mismatch: [],
      parse_status: "parsed",
      status: "received",
      status_code: null,
      status_reason: null,
      payment_linked: false,
      received_at: "2026-11-03T08:00:00Z",
      last_synced_at: "2026-11-03T08:00:00Z",
      files_pending: false,
      ...over,
    },
    files: [
      {
        kind: "original",
        file_id: "f1",
        filename: "FS-1.xml",
        mime_type: "application/xml",
        byte_size: 1200,
        sha256: "a".repeat(64),
        url: "/api/files/f1/inline",
      },
      {
        kind: "rendering",
        file_id: "f2",
        filename: "FS-1.pdf",
        mime_type: "application/pdf",
        byte_size: 3000,
        sha256: "b".repeat(64),
        url: "/api/files/f2/inline",
      },
    ],
    history: [
      {
        raw: null,
        mapped: "received",
        code: null,
        provider_ts: "2026-11-03T08:00:00Z",
        observed_at: "2026-11-03T08:01:00Z",
        source: "webhook",
      },
    ],
    actions: [
      { action: "refuse", reasons: REASONS },
      { action: "dispute", reasons: REASONS },
    ],
    pending_action: null,
    ...rest,
  }
}

describe("Received list", () => {
  it("rows carry words, never provider ids; a status code always comes with its words", () => {
    const rows = listRows([
      {
        id: "r1",
        supplier_name: "Fournisseur Exemple",
        invoice_number: "FS-1",
        issue_date: "2026-11-03",
        due_date: "2026-12-03",
        total: "1234.5",
        currency: "EUR",
        status: "refused",
        status_code: 210,
        received_at: "2026-11-03T08:00:00Z",
      },
      {
        id: "r2",
        supplier_name: null,
        invoice_number: null,
        issue_date: null,
        due_date: null,
        total: null,
        currency: null,
        status: "received",
        status_code: null,
        received_at: null,
        awaiting_approval: "dispute",
      },
    ])
    expect(rows[0]).toMatchObject({
      supplier: "Fournisseur Exemple",
      number: "FS-1",
      total: "1 234.50",
      currency: "EUR",
      status: "Refused (210)",
      received: "2026-11-03",
      note: null,
    })
    expect(rows[1]).toMatchObject({
      supplier: "Unknown supplier",
      number: "No number",
      total: "-",
      status: "Received",
      note: "Dispute awaiting approval",
    })
    expect(statusText("in_dispute", 207)).toBe("In dispute (207)")
  })

  it("the empty state says where invoices come from; the list has a refresh and a status filter", () => {
    expect(EMPTY_TEXT).toContain("e-invoicing platform")
    expect(EMPTY_TEXT).toContain("by themselves")
    for (const id of [
      "invoicing-received",
      "received-refresh",
      "received-filter",
      "received-empty",
      "received-table",
    ])
      expect(listSource).toContain(id)
  })
})

describe("Received detail", () => {
  it("facts, totals in the currency, files: the PDF previewable, the XML original download-only", () => {
    const v = detailView(data(), { timeZone: "UTC" })
    expect(v.title).toBe("Fournisseur Exemple · FS-1")
    expect(v.status).toBe("Received")
    expect(v.totals.map((t) => t.value)).toEqual(["100.00 EUR", "20.00 EUR", "120.00 EUR"])
    expect(v.mismatch).toBe(false)
    expect(v.files.map((f) => [f.kind, f.previewable])).toEqual([
      ["original", false],
      ["rendering", true],
    ])
    expect(v.timeline).toEqual([{ at: "03/11/2026, 08:00", text: "Received" }])
  })

  it("a total that differs shows the file's figure beside the platform's", () => {
    const v = detailView(
      data({
        totals: { before_tax: "100.0", tax: "20.0", total: "121.0" },
        totals_mismatch: ["total"],
      }),
    )
    expect(v.mismatch).toBe(true)
    expect(v.totals.find((t) => t.testid === "received-total-total")).toMatchObject({
      value: "121.00 EUR",
      file: "120.00 EUR",
    })
  })

  it("actions offer the platform's reasons in plain words; withdrawing a dispute needs none", () => {
    const v = detailView(
      data(
        { status: "in_dispute", status_code: 207 },
        {
          actions: [
            { action: "refuse", reasons: REASONS },
            { action: "undispute", reasons: [] },
          ],
        },
      ),
    )
    expect(v.actions.map((a) => [a.action, a.label, a.needsReason])).toEqual([
      ["refuse", "Refuse", true],
      ["undispute", "Withdraw the dispute", false],
    ])
    expect(v.actions[0]!.reasons).toEqual([
      { value: "duplicate_invoice", label: "Duplicate invoice", code: "DOUBLON" },
      { value: "incorrect_vat_rate", label: "Incorrect VAT rate", code: "TX_TVA_ERR" },
    ])
  })

  it("no action on a refused, rejected or paid invoice, and the tab says why", () => {
    expect(
      detailView(data({ status: "refused", status_code: 210 }, { actions: [] })),
    ).toMatchObject({ actions: [], noActionWhy: expect.stringContaining("refused") })
    expect(
      detailView(data({ status: "rejected", status_code: 213 }, { actions: [] })).noActionWhy,
    ).toContain("rejected")
    expect(detailView(data({ payment_linked: true }, { actions: [] })).noActionWhy).toContain(
      "payment",
    )
    // A terminal row never shows an action even if one were (wrongly) listed: the server drops them.
  })

  it("while a decision awaits approval, no other action is offered and the tab says it waits", () => {
    const v = detailView(
      data(
        {},
        {
          pending_action: {
            action: "refuse",
            reason: "duplicate_invoice",
            requested_at: "2026-11-03T09:00:00Z",
          },
        },
      ),
    )
    expect(v.actions).toEqual([])
    expect(v.pending).toBe("Refusal awaiting approval")
    expect(v.noActionWhy).toBeNull()
  })

  it("the history reads in words, decisions included", () => {
    const v = detailView(
      data(
        { status: "refused", status_code: 210 },
        {
          actions: [],
          history: [
            {
              raw: null,
              mapped: "received",
              code: null,
              provider_ts: null,
              observed_at: "2026-11-03T08:01:00Z",
              source: "webhook",
            },
            {
              source: "action",
              action: "refuse",
              reason_label: "Duplicate invoice",
              outcome: "sent",
              observed_at: "2026-11-04T10:00:00Z",
            },
            {
              raw: "refused",
              mapped: "refused",
              code: 210,
              provider_ts: "2026-11-04T10:00:01Z",
              observed_at: "2026-11-04T10:00:02Z",
              source: "action",
              reason_text: "duplicate_invoice",
            },
          ],
        },
      ),
    )
    expect(v.timeline.map((e) => e.text)).toEqual([
      "Received",
      "Refusal sent: Duplicate invoice",
      "Refused (210): duplicate_invoice",
    ])
  })

  it("the confirmation says it is sent now, and a refusal is final", () => {
    const t = confirmText("refuse", "Duplicate invoice")
    expect(t).toContain("final")
    expect(t).toContain("Reason: Duplicate invoice")
    expect(t).toContain("sent to the supplier's platform now")
    expect(t).not.toContain("approve permission")
  })

  it("calm, testids stable, the XML never rendered (no innerHTML, octet-stream download)", () => {
    for (const src of [listSource, detailSource]) {
      expect(src).not.toMatch(/text-(danger|error|red)|bg-(error|danger|red)/)
      expect(src).not.toContain("innerHTML")
    }
    expect(detailSource).toContain('"application/octet-stream"')
    for (const id of [
      "invoicing-received-detail",
      "received-detail-status",
      "received-action-form",
      "received-action-reason",
      "received-action-submit",
      "received-action-confirm",
      "received-no-action",
      "received-pending",
      "received-history",
    ]) {
      expect(detailSource).toContain(id)
    }
  })
})

describe("Received: statuses, reasons, times and permission", () => {
  const withFrench = <T>(fn: () => T): T => {
    const g = globalThis as { __liaisonHost?: unknown }
    const before = g.__liaisonHost
    g.__liaisonHost = { locale: () => "fr" }
    try {
      return fn()
    } finally {
      g.__liaisonHost = before
    }
  }

  it("the status filter reaches every status, rejected and partly paid included", () => {
    expect(FILTERS.map((f) => f.value)).toEqual([
      "all",
      "received",
      "in_dispute",
      "approved",
      "refused",
      "rejected",
      "partially_collected",
      "collected",
    ])
  })

  it("a decision's reason and a refusal's reason read in French for a French reader", () => {
    const d = data(
      { status: "refused", status_code: 210, status_reason: "duplicate_invoice" },
      {
        actions: [],
        history: [
          {
            source: "action",
            action: "refuse",
            reason: "duplicate_invoice",
            reason_label: "Duplicate invoice",
            reason_label_fr: "Facture en double",
            outcome: "sent",
            observed_at: "2026-11-04T10:00:00Z",
          },
          {
            raw: "refused",
            mapped: "refused",
            code: 210,
            provider_ts: null,
            observed_at: "2026-11-04T10:00:02Z",
            source: "action",
            reason_text: "duplicate_invoice",
            reason_label: "Duplicate invoice",
            reason_label_fr: "Facture en double",
          },
        ],
      },
    )
    const v = withFrench(() => detailView(d))
    expect(v.timeline.map((e) => e.text)).toEqual([
      "Refus envoyé : Facture en double",
      "Refusée (210) : Facture en double",
    ])
    expect(v.statusNote).toBe("Motif indiqué : Facture en double")
    expect(detailView(d).timeline.map((e) => e.text)).toEqual([
      "Refusal sent: Duplicate invoice",
      "Refused (210): Duplicate invoice",
    ])
  })

  it("an older decision entry with only the English label still reads in French through the offered reasons", () => {
    const v = withFrench(() =>
      detailView(
        data(
          {},
          {
            history: [
              {
                source: "action",
                action: "dispute",
                reason: "incorrect_vat_rate",
                reason_label: "Incorrect VAT rate",
                outcome: "sent",
                observed_at: "2026-11-04T10:00:00Z",
              },
            ],
          },
        ),
      ),
    )
    expect(v.timeline[0]!.text).toContain("Taux de TVA erroné")
  })

  it("times are the reader's local time, not a UTC slice", () => {
    expect(localDateTime("2026-11-03T23:30:00Z", "Europe/Paris")).toBe("04/11/2026, 00:30")
    expect(withFrench(() => localDateTime("2026-11-03T23:30:00Z", "Europe/Paris"))).toBe(
      "04/11/2026 00:30",
    )
    expect(localDateTime(null)).toBe("-")
  })

  it("without the permission to act: no action offered, the tab says why", () => {
    const v = detailView(data({}, { can_act: false }))
    expect(v.actions).toEqual([])
    expect(v.canAct).toBe(false)
    expect(v.noActionWhy).toContain("permission")
    expect(detailView(data()).canAct).toBe(true)
  })
})
