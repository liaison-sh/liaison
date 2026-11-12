// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real-engine tests for the auto credit-note-on-refund behavior of
// onShopifyRefundCreated. These run the ACTUAL creditNoteCreateAndIssue pipeline
// (numbering + PDF + lifecycle) against the in-memory mock db — no stubbing of
// the issuance itself. The refund handler must, when handed the full issue
// pipeline ctx (as the kernel injects at runtime), auto-issue the reversing
// credit note(s).
import { describe, expect, test } from "bun:test"
import { ISSUER_ROW, invoiceRow as baseInvoiceRow, issuePipelineCtx, lineRow } from "../__tests__/credit-note-fixtures"
import { createMockDb, type MockDb } from "../test-db"
import {
  buildAdjustmentReversalItems,
  onShopifyRefundCreated,
  type RefundCtx,
} from "./shopify-refund-created"

// The refunded invoice is paid; everything else is the shared issued US export
// invoice (zero-rated, mirrors the real scenario).
function invoiceRow(over: Record<string, unknown>): Record<string, unknown> {
  return baseInvoiceRow({ payment_status: "paid", lifecycle_log: [{ event: "issued" }, { event: "marked_paid" }], ...over })
}

function makeFullCtx(db: MockDb): RefundCtx {
  return {
    ...issuePipelineCtx(db),
    // db is a superset of RefundDb (adds findOne/count/etc. used by the CN pipeline).
    db: db as unknown as RefundCtx["db"],
  }
}

function creditNotes(db: MockDb) {
  return db.__all("documents").filter((d) => d.type === "credit_note")
}

/** Narrow the RefundResult union to its "ok" payment_status (throws otherwise). */
function okPaymentStatus(r: Awaited<ReturnType<typeof onShopifyRefundCreated>>): string {
  if (r.status !== "ok") throw new Error(`expected ok result, got ${JSON.stringify(r)}`)
  return r.payment_status
}

/** The issuing batch of a credit note (issue.ts writes the numbered document in one `db.batch`). */
function issuesCreditNote(spec: { ops: Array<Record<string, unknown>> }): boolean {
  return spec.ops.some(
    (o) => o.insert === "documents" && (o.data as Record<string, unknown>).type === "credit_note",
  )
}

describe("onShopifyRefundCreated auto credit-note issuance", () => {
  test("FULL refund of a split order issues a reversing credit note for BOTH invoices", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({ id: "00000000-0000-4000-8000-000000000901", scope: "goods", grand_total_minor: "89900", number: "INV-2026-0001", number_int: 1 }),
          invoiceRow({ id: "00000000-0000-4000-8000-000000000902", scope: "software", grand_total_minor: "16500", number: "INV-2026-0002", number_int: 2 }),
        ],
        document_lines: [
          lineRow({ id: "l-g", document_id: "00000000-0000-4000-8000-000000000901", description: "Tessera 2", unit_price_minor: "89900" }),
          lineRow({ id: "l-s", document_id: "00000000-0000-4000-8000-000000000902", description: "Tessera Sound", unit_price_minor: "8900", line_kind: "software", hs_code: null, country_of_origin: null, customs_description: null }),
          lineRow({ id: "l-sh", document_id: "00000000-0000-4000-8000-000000000902", position: 2, description: "Shipping", unit_price_minor: "7600", line_kind: "shipping", hs_code: null, country_of_origin: null, customs_description: null }),
        ],
      },
    })
    const ctx = makeFullCtx(db)

    const res = await onShopifyRefundCreated(
      { data: { id: "refund-1", order_id: "ORD-1", refund_amount_minor: 106400n } },
      ctx,
    )
    expect(res.status).toBe("ok")

    // Both invoices reversed with a credit note.
    const cns = creditNotes(db)
    expect(cns).toHaveLength(2)
    for (const cn of cns) {
      expect(Number(cn.grand_total_minor)).toBeLessThan(0)
      const ref = String((cn.external_refs as Record<string, unknown>).original_document_id)
      expect(["00000000-0000-4000-8000-000000000901", "00000000-0000-4000-8000-000000000902"]).toContain(ref)
    }
    // Each CN mirrors its invoice's lines, negated.
    const cnLines = db.__all("document_lines").filter((l) => cns.some((c) => c.id === l.document_id))
    expect(cnLines.length).toBe(3)
    for (const l of cnLines) expect(Number(l.unit_price_minor)).toBeLessThan(0)

    // Both invoices refunded + carry the credit_note_issued marker.
    for (const id of ["00000000-0000-4000-8000-000000000901", "00000000-0000-4000-8000-000000000902"]) {
      const inv = (await db.findOne("documents", id)) as Record<string, unknown>
      expect(inv.payment_status).toBe("refunded")
      const log = inv.lifecycle_log as Array<Record<string, unknown>>
      expect(log.some((e) => e.event === "credit_note_issued")).toBe(true)
    }
  })

  test("split order FULL refund: first credit note fails, the second is still issued and the failure is logged", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({ id: "00000000-0000-4000-8000-000000000901", scope: "goods", grand_total_minor: "89900", number: "INV-2026-0001", number_int: 1 }),
          invoiceRow({ id: "00000000-0000-4000-8000-000000000902", scope: "software", grand_total_minor: "16500", number: "INV-2026-0002", number_int: 2 }),
        ],
        document_lines: [
          lineRow({ id: "l-g", document_id: "00000000-0000-4000-8000-000000000901", description: "Tessera 2", unit_price_minor: "89900" }),
          lineRow({ id: "l-s", document_id: "00000000-0000-4000-8000-000000000902", description: "Tessera Sound", unit_price_minor: "8900", line_kind: "software", hs_code: null, country_of_origin: null, customs_description: null }),
          lineRow({ id: "l-sh", document_id: "00000000-0000-4000-8000-000000000902", position: 2, description: "Shipping", unit_price_minor: "7600", line_kind: "shipping", hs_code: null, country_of_origin: null, customs_description: null }),
        ],
      },
    })
    const baseCtx = makeFullCtx(db)
    const errors: Array<{ msg: string; data?: unknown }> = []
    let creditNoteInsertCount = 0
    // Fails the FIRST credit note document insert only (whichever invoice is processed first);
    // the underlying `db` is untouched otherwise, so a second, successful insert lands for real.
    const throwingDb = {
      ...db,
      async batch(spec: Parameters<typeof db.batch>[0]) {
        if (issuesCreditNote(spec)) {
          creditNoteInsertCount += 1
          if (creditNoteInsertCount === 1) throw new Error("simulated credit note insert failure")
        }
        return db.batch(spec)
      },
    } as unknown as RefundCtx["db"]
    const ctx: RefundCtx = {
      ...baseCtx,
      db: throwingDb,
      logger: { error: (msg, data) => errors.push({ msg, data }) },
    }

    const res = await onShopifyRefundCreated(
      { data: { id: "refund-1", order_id: "ORD-1", refund_amount_minor: 106400n } },
      ctx,
    )
    expect(res.status).toBe("ok")

    // The first target's credit note failed to insert; the second still went through.
    expect(creditNoteInsertCount).toBe(2)
    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)

    // Both invoices were still marked refunded (the recorded refund never unwinds on a
    // credit-note failure), but only the one whose credit note actually landed carries the
    // credit_note_issued marker.
    const inv901 = (await db.findOne("documents", "00000000-0000-4000-8000-000000000901")) as Record<string, unknown>
    const inv902 = (await db.findOne("documents", "00000000-0000-4000-8000-000000000902")) as Record<string, unknown>
    expect(inv901.payment_status).toBe("refunded")
    expect(inv902.payment_status).toBe("refunded")
    const markedCount = [inv901, inv902].filter((inv) =>
      (inv.lifecycle_log as Array<Record<string, unknown>>).some((e) => e.event === "credit_note_issued"),
    ).length
    expect(markedCount).toBe(1)

    // The failure was logged with real context, not swallowed.
    expect(errors.length).toBeGreaterThan(0)
    const logged = errors.find((e) => JSON.stringify(e.data ?? {}).includes("refund-1"))
    expect(logged).toBeDefined()
    expect(JSON.stringify(logged?.data ?? {})).toContain("simulated credit note insert failure")
  })

  test("outer credit-note issuance guard logs, not swallows, a failure that escapes per-target isolation, and the refund status change still stands", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [invoiceRow({ id: "00000000-0000-4000-8000-000000000901", grand_total_minor: "89900" })],
        document_lines: [lineRow({ id: "l-g", document_id: "00000000-0000-4000-8000-000000000901", description: "Tessera 2", unit_price_minor: "89900" })],
      },
    })
    const baseCtx = makeFullCtx(db)
    const calls: Array<{ msg: string; data?: unknown }> = []
    // The credit-note document INSERT itself fails on the single target (a PDF render
    // failure alone does not throw -- issueDocument captures that and still persists the
    // document -- so the insert is the real failure point that reaches issueOneRefundCreditNote).
    const throwingDb = {
      ...db,
      async batch(spec: Parameters<typeof db.batch>[0]) {
        if (issuesCreditNote(spec)) throw new Error("simulated credit note insert failure")
        return db.batch(spec)
      },
    } as unknown as RefundCtx["db"]
    const ctx: RefundCtx = {
      ...baseCtx,
      db: throwingDb,
      // The FIRST logger call (the per-target catch, inside autoIssueRefundCreditNotes) itself
      // throws, so the failure escapes the per-target try and only the OUTER guard around the
      // whole autoIssueRefundCreditNotes call gets a chance to log it.
      logger: {
        error: (msg, data) => {
          calls.push({ msg, data })
          if (calls.length === 1) throw new Error("logger transport down")
        },
      },
    }

    const res = await onShopifyRefundCreated(
      { data: { id: "refund-outer", order_id: "ORD-1", refund_amount_minor: 89900n } },
      ctx,
    )
    expect(res.status).toBe("ok")
    if (res.status !== "ok") throw new Error("unreachable")
    // The refund status change stands even though the credit note never got issued.
    expect(res.payment_status).toBe("refunded")
    const inv = (await db.findOne("documents", "00000000-0000-4000-8000-000000000901")) as Record<string, unknown>
    expect(inv.payment_status).toBe("refunded")
    expect(creditNotes(db)).toHaveLength(0)

    // The outer guard's own log call succeeded (the second logger invocation) and carries
    // the refund id -- proving the failure was surfaced, not silently swallowed.
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const outerLog = calls[calls.length - 1]!
    expect(JSON.stringify(outerLog.data ?? {})).toContain("refund-outer")
  })

  test("PARTIAL refund issues ONE credit note with a single negative adjustment line", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [invoiceRow({ id: "00000000-0000-4000-8000-000000000901", grand_total_minor: "89900" })],
        document_lines: [lineRow({ id: "l-g", document_id: "00000000-0000-4000-8000-000000000901", description: "Tessera 2", unit_price_minor: "89900" })],
      },
    })
    const ctx = makeFullCtx(db)

    const res = await onShopifyRefundCreated(
      { data: { id: "refund-partial", order_id: "ORD-1", refund_amount_minor: 20000n } },
      ctx,
    )
    expect(okPaymentStatus(res)).toBe("partial")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    expect(Number(cns[0]!.grand_total_minor)).toBe(-20000)
    const cnLines = db.__all("document_lines").filter((l) => l.document_id === cns[0]!.id)
    expect(cnLines).toHaveLength(1)
    expect(Number(cnLines[0]!.unit_price_minor)).toBe(-20000)
    expect(cnLines[0]!.description).toBe("Refund")
  })

  test("PARTIAL refund of an invoice with a negative discount line never emits a positive reversal line", async () => {
    // Line A at 20% VAT: net 10000, tax 2000, gross 12000.
    // Line B: a -30.00 discount at 0bp, gross -3000, with no offsetting positive line at 0bp --
    // the exact counter-case-1 shape from buildAdjustmentReversalItems. Invoice total gross: 9000.
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [invoiceRow({ id: "00000000-0000-4000-8000-000000000920", grand_total_minor: "9000" })],
        document_lines: [
          lineRow({
            id: "l-vat",
            document_id: "00000000-0000-4000-8000-000000000920",
            unit_price_minor: "10000",
            tax_rate_bp: 2000,
            subtotal_minor: "10000",
            tax_minor: "2000",
            total_minor: "12000",
          }),
          lineRow({
            id: "l-discount",
            document_id: "00000000-0000-4000-8000-000000000920",
            position: 2,
            description: "Discount",
            unit_price_minor: "-3000",
            tax_rate_bp: 0,
            subtotal_minor: "-3000",
            tax_minor: "0",
            total_minor: "-3000",
          }),
        ],
      },
    })
    const ctx = makeFullCtx(db)

    const res = await onShopifyRefundCreated(
      { data: { id: "refund-discount", order_id: "ORD-1", refund_amount_minor: 500n } },
      ctx,
    )
    expect(okPaymentStatus(res)).toBe("partial")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    expect(Number(cns[0]!.grand_total_minor)).toBe(-500)
    const cnLines = db.__all("document_lines").filter((l) => l.document_id === cns[0]!.id)
    for (const l of cnLines) expect(Number(l.unit_price_minor)).toBeLessThanOrEqual(0)
    const netPlusTax = cnLines.reduce(
      (sum, l) => sum + Number(l.subtotal_minor) + Number(l.tax_minor),
      0,
    )
    expect(netPlusTax).toBe(-500)
  })

  test("idempotent: the SAME refund delivered twice issues the credit notes only once", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [invoiceRow({ id: "00000000-0000-4000-8000-000000000901", grand_total_minor: "89900" })],
        document_lines: [lineRow({ id: "l-g", document_id: "00000000-0000-4000-8000-000000000901", description: "Tessera 2", unit_price_minor: "89900" })],
      },
    })
    const ctx = makeFullCtx(db)
    const evt = { data: { id: "refund-1", order_id: "ORD-1", refund_amount_minor: 89900n } }
    await onShopifyRefundCreated(evt, ctx)
    await onShopifyRefundCreated(evt, ctx) // retry / dual-delivery
    expect(creditNotes(db)).toHaveLength(1)
  })

  test("a partial refund against an already credit noted invoice does not mark everything refunded", async () => {
    const INVOICE_ID = "00000000-0000-4000-8000-000000000905"
    const CN_ID = "00000000-0000-4000-8000-000000000906"
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          // A 100.00 invoice already FULLY credit noted (its own credit note below).
          invoiceRow({ id: INVOICE_ID, grand_total_minor: "10000", payment_status: "unpaid" }),
          {
            id: CN_ID,
            type: "credit_note",
            scope: null,
            status: "issued",
            payment_status: "unpaid",
            number: "CN-2026-0001",
            number_int: 1,
            year_of_issue: 2026,
            issuer_profile_id: "iss-1",
            counterparty_contact_id: "contact-1",
            counterparty_name: "Jane Buyer",
            counterparty_address: "10 Main St",
            counterparty_vat_id: null,
            counterparty_email: "jane@example.com",
            counterparty_country: "US",
            currency: "USD",
            subtotal_minor: "-10000",
            tax_total_minor: "0",
            grand_total_minor: "-10000",
            tax_treatment: "eu_export_non_eu",
            incoterm: "DAP",
            shopify_order_id: "ORD-1",
            external_refs: { original_document_id: INVOICE_ID },
            lifecycle_log: [{ event: "issued" }],
          },
        ],
        document_lines: [
          lineRow({ id: "l-g2", document_id: INVOICE_ID, unit_price_minor: "10000" }),
        ],
      },
    })
    const ctx = makeFullCtx(db)

    // A 10.00 EUR partial refund against the 100.00 invoice. BEFORE the fix,
    // `findDocumentsByShopifyOrderId` returned the credit note alongside the
    // invoice: `docs.find(d => d.scope === "goods" || d.scope === null)` could
    // pick the credit note (scope null) as the refund TARGET, and
    // `combinedTotal` summed the invoice (10000) with the credit note
    // (-10000) to 0 -- so a mere 1000-minor-unit refund already read as
    // ">= combinedTotal" and flipped EVERY document to "refunded".
    const res = await onShopifyRefundCreated(
      { data: { id: "refund-partial-cn", order_id: "ORD-1", refund_amount_minor: 1000n } },
      ctx,
    )
    expect(okPaymentStatus(res)).toBe("partial")
    if (res.status !== "ok") throw new Error("unreachable")
    // Recorded against the INVOICE, never the credit note.
    expect(res.document_id).toBe(INVOICE_ID)

    const invoice = (await db.findOne("documents", INVOICE_ID)) as Record<string, unknown>
    expect(invoice.payment_status).toBe("partial")
    const creditNote = (await db.findOne("documents", CN_ID)) as Record<string, unknown>
    // The credit note itself is untouched -- it was never a refund target.
    expect(creditNote.payment_status).toBe("unpaid")
  })

  test("db-only ctx (no issue pipeline) still records the refund but issues NO credit note", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [invoiceRow({ id: "00000000-0000-4000-8000-000000000901", grand_total_minor: "89900" })],
        document_lines: [lineRow({ id: "l-g", document_id: "00000000-0000-4000-8000-000000000901", unit_price_minor: "89900" })],
      },
    })
    const minimal: RefundCtx = { getUserId: async () => "system", db: db as unknown as RefundCtx["db"] }
    const res = await onShopifyRefundCreated(
      { data: { id: "refund-1", order_id: "ORD-1", refund_amount_minor: 89900n } },
      minimal,
    )
    expect(okPaymentStatus(res)).toBe("refunded")
    expect(creditNotes(db)).toHaveLength(0)
  })

  test("a partial reversal carries the VAT it reverses", async () => {
    // One line at 20% VAT: net 10000, tax 2000, gross 12000.
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [invoiceRow({ id: "00000000-0000-4000-8000-000000000920", grand_total_minor: "12000" })],
        document_lines: [
          lineRow({
            id: "l-vat",
            document_id: "00000000-0000-4000-8000-000000000920",
            unit_price_minor: "10000",
            tax_rate_bp: 2000,
            subtotal_minor: "10000",
            tax_minor: "2000",
            total_minor: "12000",
          }),
        ],
      },
    })
    const ctx = makeFullCtx(db)

    // Half the invoice: 6000 minor units refunded.
    const res = await onShopifyRefundCreated(
      { data: { id: "refund-vat", order_id: "ORD-1", refund_amount_minor: 6000n } },
      ctx,
    )
    expect(okPaymentStatus(res)).toBe("partial")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    // BEFORE the fix the credit note's tax_total_minor was 0 (single 0-tax adjustment line).
    // AFTER the fix it carries the proportional 20% VAT on the reversed net amount.
    expect(Number(cns[0]!.tax_total_minor)).toBe(-1000)
    expect(Number(cns[0]!.grand_total_minor)).toBe(-6000)

    const cnLines = db.__all("document_lines").filter((l) => l.document_id === cns[0]!.id)
    // net (-5000) + tax (-1000) == -6000 exactly.
    const netPlusTax = cnLines.reduce(
      (sum, l) => sum + Number(l.subtotal_minor) + Number(l.tax_minor),
      0,
    )
    expect(netPlusTax).toBe(-6000)
  })

  test("a partial reversal of a two rate invoice reverses both rates in proportion", async () => {
    // Line A at 20% VAT: net 10000, tax 2000, gross 12000.
    // Line B at 10% VAT: net 10000, tax 1000, gross 11000.
    // Invoice total gross: 23000.
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [invoiceRow({ id: "00000000-0000-4000-8000-000000000921", grand_total_minor: "23000" })],
        document_lines: [
          lineRow({
            id: "l-a",
            document_id: "00000000-0000-4000-8000-000000000921",
            description: "Line A (20 pct)",
            unit_price_minor: "10000",
            tax_rate_bp: 2000,
            subtotal_minor: "10000",
            tax_minor: "2000",
            total_minor: "12000",
          }),
          lineRow({
            id: "l-b",
            document_id: "00000000-0000-4000-8000-000000000921",
            position: 2,
            description: "Line B (10 pct)",
            unit_price_minor: "10000",
            tax_rate_bp: 1000,
            subtotal_minor: "10000",
            tax_minor: "1000",
            total_minor: "11000",
          }),
        ],
      },
    })
    const ctx = makeFullCtx(db)

    // Half the invoice: 11500 minor units refunded -- proportional split is exact by
    // construction here (6000 @ 20pct + 5500 @ 10pct).
    const res = await onShopifyRefundCreated(
      { data: { id: "refund-two-rate", order_id: "ORD-1", refund_amount_minor: 11500n } },
      ctx,
    )
    expect(okPaymentStatus(res)).toBe("partial")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    expect(Number(cns[0]!.grand_total_minor)).toBe(-11500)

    const cnLines = db
      .__all("document_lines")
      .filter((l) => l.document_id === cns[0]!.id)
      .sort((a, b) => Number(a.tax_rate_bp) - Number(b.tax_rate_bp))
    expect(cnLines).toHaveLength(2)
    // 10 pct group: net -5000, tax -500.
    expect(Number(cnLines[0]!.tax_rate_bp)).toBe(1000)
    expect(Number(cnLines[0]!.subtotal_minor)).toBe(-5000)
    expect(Number(cnLines[0]!.tax_minor)).toBe(-500)
    // 20 pct group: net -5000, tax -1000.
    expect(Number(cnLines[1]!.tax_rate_bp)).toBe(2000)
    expect(Number(cnLines[1]!.subtotal_minor)).toBe(-5000)
    expect(Number(cnLines[1]!.tax_minor)).toBe(-1000)

    const netPlusTax = cnLines.reduce(
      (sum, l) => sum + Number(l.subtotal_minor) + Number(l.tax_minor),
      0,
    )
    expect(netPlusTax).toBe(-11500)
  })

  test("a partial reversal is exact to the minor unit when the split does not divide evenly", async () => {
    // One line at 20% VAT: net 50000, tax 10000, gross 60000.
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [invoiceRow({ id: "00000000-0000-4000-8000-000000000922", grand_total_minor: "60000" })],
        document_lines: [
          lineRow({
            id: "l-odd",
            document_id: "00000000-0000-4000-8000-000000000922",
            unit_price_minor: "50000",
            tax_rate_bp: 2000,
            subtotal_minor: "50000",
            tax_minor: "10000",
            total_minor: "60000",
          }),
        ],
      },
    })
    const ctx = makeFullCtx(db)

    // 933 minor units at 20pct: netOfIncludedTax/lineTax's forward split does NOT reconstruct
    // 933 exactly (it lands on 934), forcing the rounding-residual sweep line.
    const res = await onShopifyRefundCreated(
      { data: { id: "refund-odd", order_id: "ORD-1", refund_amount_minor: 933n } },
      ctx,
    )
    expect(okPaymentStatus(res)).toBe("partial")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    // Exact to the minor unit, despite the rounding mismatch.
    expect(Number(cns[0]!.grand_total_minor)).toBe(-933)

    const cnLines = db.__all("document_lines").filter((l) => l.document_id === cns[0]!.id)
    const netPlusTax = cnLines.reduce(
      (sum, l) => sum + Number(l.subtotal_minor) + Number(l.tax_minor),
      0,
    )
    expect(netPlusTax).toBe(-933)
  })

  describe("split order refund routes to the document that carries the refunded line", () => {
    const GOODS_ID = "00000000-0000-4000-8000-000000000901"
    const SOFTWARE_ID = "00000000-0000-4000-8000-000000000902"
    const GOODS_VARIANT = "gid://shopify/ProductVariant/GOODS"
    const SOFTWARE_VARIANT = "gid://shopify/ProductVariant/SOFTWARE"

    function splitOrderDb() {
      return createMockDb({
        seed: {
          issuer_profiles: [ISSUER_ROW],
          documents: [
            invoiceRow({ id: GOODS_ID, scope: "goods", grand_total_minor: "89900", number: "INV-2026-0001", number_int: 1 }),
            invoiceRow({ id: SOFTWARE_ID, scope: "software", grand_total_minor: "16500", number: "INV-2026-0002", number_int: 2 }),
          ],
          document_lines: [
            lineRow({ id: "l-g", document_id: GOODS_ID, description: "Tessera 2", unit_price_minor: "89900", external_id: GOODS_VARIANT }),
            lineRow({ id: "l-s", document_id: SOFTWARE_ID, description: "Tessera Sound", unit_price_minor: "8900", line_kind: "software", hs_code: null, country_of_origin: null, customs_description: null, external_id: SOFTWARE_VARIANT }),
            lineRow({ id: "l-sh", document_id: SOFTWARE_ID, position: 2, description: "Shipping", unit_price_minor: "7600", line_kind: "shipping", hs_code: null, country_of_origin: null, customs_description: null, external_id: null }),
          ],
        },
      })
    }

    test("a software-only refund credits ONLY the software invoice, never the goods invoice", async () => {
      const db = splitOrderDb()
      const ctx = makeFullCtx(db)

      const res = await onShopifyRefundCreated(
        {
          data: {
            id: "refund-sw",
            order_id: "ORD-1",
            refund_line_items: [{ external_id: SOFTWARE_VARIANT, amount_minor: 8900n }],
          },
        },
        ctx,
      )
      expect(okPaymentStatus(res)).toBe("partial")
      if (res.status !== "ok") throw new Error("unreachable")
      expect(res.document_id).toBe(SOFTWARE_ID)

      const cns = creditNotes(db)
      expect(cns).toHaveLength(1)
      expect(String((cns[0]!.external_refs as Record<string, unknown>).original_document_id)).toBe(SOFTWARE_ID)
      expect(Number(cns[0]!.grand_total_minor)).toBe(-8900)

      const goods = (await db.findOne("documents", GOODS_ID)) as Record<string, unknown>
      const software = (await db.findOne("documents", SOFTWARE_ID)) as Record<string, unknown>
      // The goods invoice is untouched: no credit note, no payment_status change.
      expect(goods.payment_status).toBe("paid")
      expect(software.payment_status).toBe("partial")
    })

    test("a refund spanning both halves credits each document for its own share", async () => {
      const db = splitOrderDb()
      const ctx = makeFullCtx(db)

      const res = await onShopifyRefundCreated(
        {
          data: {
            id: "refund-both",
            order_id: "ORD-1",
            refund_line_items: [
              { external_id: GOODS_VARIANT, amount_minor: 20000n },
              { external_id: SOFTWARE_VARIANT, amount_minor: 5000n },
            ],
          },
        },
        ctx,
      )
      expect(res.status).toBe("ok")

      const cns = creditNotes(db)
      expect(cns).toHaveLength(2)
      const byOriginal = new Map(
        cns.map((cn) => [
          String((cn.external_refs as Record<string, unknown>).original_document_id),
          Number(cn.grand_total_minor),
        ]),
      )
      expect(byOriginal.get(GOODS_ID)).toBe(-20000)
      expect(byOriginal.get(SOFTWARE_ID)).toBe(-5000)

      const goods = (await db.findOne("documents", GOODS_ID)) as Record<string, unknown>
      const software = (await db.findOne("documents", SOFTWARE_ID)) as Record<string, unknown>
      expect(goods.payment_status).toBe("partial")
      expect(software.payment_status).toBe("partial")
    })

    test("an unattributable refund line is deferred, never guessed onto either document", async () => {
      const db = splitOrderDb()
      const ctx = makeFullCtx(db)

      const res = await onShopifyRefundCreated(
        {
          data: {
            id: "refund-unknown",
            order_id: "ORD-1",
            refund_line_items: [{ external_id: "gid://shopify/ProductVariant/UNKNOWN", amount_minor: 5000n }],
          },
        },
        ctx,
      )
      expect(res.status).toBe("deferred")

      // Neither document was touched: no credit note, no payment_status change.
      expect(creditNotes(db)).toHaveLength(0)
      const goods = (await db.findOne("documents", GOODS_ID)) as Record<string, unknown>
      const software = (await db.findOne("documents", SOFTWARE_ID)) as Record<string, unknown>
      expect(goods.payment_status).toBe("paid")
      expect(software.payment_status).toBe("paid")
    })
  })

  // A shipping refund carries no refund_line_items. It used to fall back to the GOODS invoice,
  // which never carried the shipping line.
  describe("shipping refunds follow the shipping line", () => {
    const GOODS_ID = "00000000-0000-4000-8000-000000000911"
    const SERVICES_ID = "00000000-0000-4000-8000-000000000912"

    function db2(softwareRateBp: number) {
      const softwareGross = 8900 + Math.round((8900 * softwareRateBp) / 10000)
      return createMockDb({
        seed: {
          issuer_profiles: [ISSUER_ROW],
          documents: [
            invoiceRow({ id: GOODS_ID, scope: "goods", grand_total_minor: "89900", number: "INV-2026-0011", number_int: 11 }),
            invoiceRow({
              id: SERVICES_ID,
              scope: "software",
              grand_total_minor: String(softwareGross + 7600),
              number: "INV-2026-0012",
              number_int: 12,
            }),
          ],
          document_lines: [
            lineRow({ id: "g1", document_id: GOODS_ID, description: "Tessera 2", unit_price_minor: "89900", external_id: "gid://shopify/ProductVariant/G" }),
            lineRow({ id: "s1", document_id: SERVICES_ID, description: "Licence", unit_price_minor: "8900", tax_rate_bp: softwareRateBp, line_kind: "software", hs_code: null, country_of_origin: null, customs_description: null, external_id: "gid://shopify/ProductVariant/S" }),
            lineRow({ id: "s2", document_id: SERVICES_ID, position: 2, description: "Shipping", unit_price_minor: "7600", tax_rate_bp: 0, line_kind: "shipping", hs_code: null, country_of_origin: null, customs_description: null, external_id: null }),
          ],
        },
      })
    }

    // red: drop the shipping_refund_minor branch in onShopifyRefundCreated -> the credit note is
    // issued against the goods invoice.
    test("a shipping only refund credits the document that carried the shipping line", async () => {
      const db = db2(0)
      const res = await onShopifyRefundCreated(
        { data: { id: "refund-ship", order_id: "ORD-1", amount: "76.00", currency: "USD", shipping_refund_minor: "7600" } },
        makeFullCtx(db),
      )
      expect(res.status).toBe("ok")
      const cns = creditNotes(db)
      expect(cns).toHaveLength(1)
      expect(String((cns[0]!.external_refs as Record<string, unknown>).original_document_id)).toBe(SERVICES_ID)
      expect(Number(cns[0]!.grand_total_minor)).toBe(-7600)
      const goods = (await db.findOne("documents", GOODS_ID)) as Record<string, unknown>
      expect(goods.payment_status).toBe("paid")
    })

    // red: drop the shippingAmount split in issueOneRefundCreditNote -> the 76.00 is spread pro rata
    // over the 20% licence and the 0% shipping, reversing VAT the shipping never bore.
    test("a refund equal to the shipping is reversed on the shipping line's rate only, labelled shipping", async () => {
      const db = db2(2000)
      await onShopifyRefundCreated(
        { data: { id: "refund-ship2", order_id: "ORD-1", amount: "76.00", currency: "USD", shipping_refund_minor: "7600" } },
        makeFullCtx(db),
      )
      const cn = creditNotes(db)[0]!
      expect(Number(cn.tax_total_minor)).toBe(0)
      expect(Number(cn.grand_total_minor)).toBe(-7600)
      const lines = db.__all("document_lines").filter((l) => l.document_id === cn.id)
      expect(lines.length).toBeGreaterThan(0)
      for (const l of lines) {
        expect(l.line_kind).toBe("shipping")
        expect(Number(l.tax_rate_bp)).toBe(0)
      }
    })
  })

  // red: map a shipping-only source back to the scope ("software") in buildAdjustmentReversalItems.
  test("a partial reversal of shipping lines is labelled shipping, not software", () => {
    const items = buildAdjustmentReversalItems(
      [{ unit_price_minor: 8300n, quantity: "1", tax_rate_bp: 0, line_kind: "shipping" }],
      3000n,
      "software",
    )
    expect(items.length).toBeGreaterThan(0)
    for (const i of items) expect(i.line_kind).toBe("shipping")
    expect(items[0]!.description).toBe("Shipping refund")
  })

  // red: drop `tax_country: storedTaxCountry(fresh)` in issueOneRefundCreditNote -> the credit note
  // classifies on the Italian billing country (EU B2C) instead of the US delivery (export).
  test("a credit note classifies on the invoice's recorded tax country, not its printed billing country", async () => {
    const DOC = "00000000-0000-4000-8000-000000000921"
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: DOC,
            scope: null,
            counterparty_country: "IT",
            grand_total_minor: "89900",
            external_refs: { tax_country: "US" },
          }),
        ],
        document_lines: [lineRow({ id: "x1", document_id: DOC, unit_price_minor: "89900" })],
      },
    })
    await onShopifyRefundCreated(
      { data: { id: "refund-full", order_id: "ORD-1", amount: "899.00", currency: "USD" } },
      makeFullCtx(db),
    )
    const cn = creditNotes(db)[0]!
    expect(cn.tax_treatment).toBe("eu_export_non_eu")
    expect(cn.counterparty_country).toBe("IT")
  })
})


describe("refund credit note against a French company buyer: the e-invoicing gate parks, never drops", () => {
  const SETTINGS = [{ id: "set-1", gate_mode: "enforce", gate_mode_source: "config" }]
  const FR_CONTACT = "00000000-0000-4000-8000-0000000c0931"

  /** An e-invoice to a French company whose stored snapshot carries no SIREN. */
  function eInvoiceWithoutSiren(id: string, orderId: string): Record<string, unknown> {
    return invoiceRow({
      id,
      scope: null,
      shopify_order_id: orderId,
      currency: "EUR",
      counterparty_contact_id: FR_CONTACT,
      counterparty_name: "Atelier Exemple SARL",
      counterparty_address: "1 rue de l'Exemple, 75002 Paris",
      counterparty_country: "FR",
      tax_treatment: "fr_domestic",
      grand_total_minor: "12000",
      regime: "e_invoice",
      customer_kind: "business",
      buyer_legal_name: "ATELIER EXEMPLE",
      buyer_siren: null,
      billing_line1: "1 rue de l'Exemple",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
      operation_category: "goods",
      operation_category_source: "lines_authoritative",
    })
  }

  test("refund against an e_invoice original whose snapshot lost its SIREN parks a parked_credit_note (not silence)", async () => {
    const DOC = "00000000-0000-4000-8000-000000000931"
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        einvoicing_settings: SETTINGS,
        documents: [eInvoiceWithoutSiren(DOC, "ORD-931")],
        document_lines: [
          lineRow({ id: "y1", document_id: DOC, unit_price_minor: "10000", tax_rate_bp: 2000, tax_minor: "2000", total_minor: "12000" }),
        ],
      },
    })
    const emitted: Array<{ entity: string; action: string; entityId?: string }> = []
    const ctx: RefundCtx = {
      ...makeFullCtx(db),
      emit: async (e) => {
        emitted.push(e)
      },
    }
    const res = await onShopifyRefundCreated(
      { data: { id: "refund-931", order_id: "ORD-931", refund_amount_minor: 12000n } },
      ctx,
    )
    expect(okPaymentStatus(res)).toBe("refunded")
    expect(creditNotes(db)).toHaveLength(0)
    const parked = db.__all("deferred_events")
    expect(parked).toHaveLength(1)
    expect(parked[0]!.event_id).toBe(`cn:refund-931:${DOC}`)
    expect(parked[0]!.status).toBe("awaiting_data")
    expect(parked[0]!.reason).toBe("einvoice_data_missing")
    expect(parked[0]!.blocked_on).toEqual({
      kind: "einvoice_identity",
      contact_id: FR_CONTACT,
      document_id: DOC,
      code: "einvoice_data_missing",
    })
    const payload = parked[0]!.event_payload_json as Record<string, unknown>
    expect(payload.kind).toBe("parked_credit_note")
    expect(payload.full_reversal).toBe(true)
    expect(payload.amount_minor).toBe("12000")
    expect((payload.items as unknown[]).length).toBe(1)
    const attention = emitted.filter((e) => e.action === "identity_missing")
    expect(attention).toHaveLength(1)
    expect(attention[0]!.entityId).toBe(FR_CONTACT)
  })

  test("a second refund waiting on the same buyer parks too but raises no second attention item", async () => {
    const A = "00000000-0000-4000-8000-000000000932"
    const B = "00000000-0000-4000-8000-000000000933"
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        einvoicing_settings: SETTINGS,
        documents: [eInvoiceWithoutSiren(A, "ORD-932"), eInvoiceWithoutSiren(B, "ORD-933")],
        document_lines: [
          lineRow({ id: "z1", document_id: A, unit_price_minor: "10000", tax_rate_bp: 2000 }),
          lineRow({ id: "z2", document_id: B, unit_price_minor: "10000", tax_rate_bp: 2000 }),
        ],
      },
    })
    const emitted: Array<{ action: string }> = []
    const ctx: RefundCtx = {
      ...makeFullCtx(db),
      emit: async (e) => {
        emitted.push(e)
      },
    }
    await onShopifyRefundCreated({ data: { id: "refund-932", order_id: "ORD-932", refund_amount_minor: 3000n } }, ctx)
    await onShopifyRefundCreated({ data: { id: "refund-933", order_id: "ORD-933", refund_amount_minor: 3000n } }, ctx)
    // A webhook redelivery of the first refund refreshes nothing new either.
    await onShopifyRefundCreated({ data: { id: "refund-932", order_id: "ORD-932", refund_amount_minor: 3000n } }, ctx)
    expect(db.__all("deferred_events")).toHaveLength(2)
    expect(emitted.filter((e) => e.action === "identity_missing")).toHaveLength(1)
    expect(creditNotes(db)).toHaveLength(0)
  })
})
