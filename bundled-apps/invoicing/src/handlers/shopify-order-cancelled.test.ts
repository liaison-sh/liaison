// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real-engine tests for onShopifyOrderCancelled, including the auto
// credit-note-on-cancel behavior (mirrors shopify-refund-credit-note.test.ts's
// approach: run the ACTUAL creditNoteCreateAndIssue pipeline against the
// in-memory mock db, no stubbing of the issuance itself).
import { describe, expect, test } from "bun:test"
import { ISSUER_ROW, invoiceRow, issuePipelineCtx, lineRow } from "../__tests__/credit-note-fixtures"
import { createMockDb, type MockDb } from "../test-db"
import { onShopifyOrderCancelled, type OrderCancelledCtx } from "./shopify-order-cancelled"

function makeFullCtx(db: MockDb): OrderCancelledCtx {
  return {
    ...issuePipelineCtx(db),
    // db is a superset of OrderCancelledDb (adds findOne/count/etc. used by the CN pipeline).
    db: db as unknown as OrderCancelledCtx["db"],
  }
}

function creditNotes(db: MockDb) {
  return db.__all("documents").filter((d) => d.type === "credit_note")
}

describe("onShopifyOrderCancelled auto credit-note issuance", () => {
  test("cancelling an order with an issued invoice issues exactly one credit note for the full invoice total", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: "00000000-0000-4000-8000-000000000901",
            grand_total_minor: "89900",
          }),
        ],
        document_lines: [
          lineRow({
            id: "l-g",
            document_id: "00000000-0000-4000-8000-000000000901",
            description: "Tessera 2",
            unit_price_minor: "89900",
          }),
        ],
      },
    })
    const ctx = makeFullCtx(db)

    const res = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res.status).toBe("ok")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(1)
    expect(Number(cns[0]!.grand_total_minor)).toBe(-89900)
    const ref = String((cns[0]!.external_refs as Record<string, unknown>).original_document_id)
    expect(ref).toBe("00000000-0000-4000-8000-000000000901")

    const cnLines = db.__all("document_lines").filter((l) => l.document_id === cns[0]!.id)
    expect(cnLines).toHaveLength(1)
    expect(Number(cnLines[0]!.unit_price_minor)).toBe(-89900)

    const inv = (await db.findOne("documents", "00000000-0000-4000-8000-000000000901")) as Record<
      string,
      unknown
    >
    const log = inv.lifecycle_log as Array<Record<string, unknown>>
    expect(log.some((e) => e.event === "credit_note_issued")).toBe(true)
    expect(log.some((e) => e.event === "shopify_order_cancelled")).toBe(true)

    // A second cancelled event for the SAME order issues no second credit note.
    const res2 = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res2.status).toBe("ok")
    expect(creditNotes(db)).toHaveLength(1)
  })

  test("a draft invoice is skipped: no credit note, lifecycle event still recorded", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: "00000000-0000-4000-8000-000000000902",
            status: "draft",
            grand_total_minor: "12000",
          }),
        ],
      },
    })
    const ctx = makeFullCtx(db)
    const res = await onShopifyOrderCancelled({ data: { orderId: "ORD-1" } }, ctx)
    expect(res.status).toBe("ok")
    expect(creditNotes(db)).toHaveLength(0)
    const inv = (await db.findOne("documents", "00000000-0000-4000-8000-000000000902")) as Record<
      string,
      unknown
    >
    const log = inv.lifecycle_log as Array<Record<string, unknown>>
    expect(log.some((e) => e.event === "shopify_order_cancelled")).toBe(true)
  })

  test("cancelling does not issue a second credit note when the lifecycle marker is missing", async () => {
    const INVOICE_ID = "00000000-0000-4000-8000-000000000904"
    const CN_ID = "00000000-0000-4000-8000-000000000905"
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          // The invoice's OWN lifecycle_log carries NO "credit_note_issued" marker
          // (e.g. lost/crashed between issuing the credit note and writing the
          // marker) -- the credit note is only discoverable via the durable
          // external_refs.original_document_id back-link on the credit note itself.
          invoiceRow({
            id: INVOICE_ID,
            grand_total_minor: "50000",
            lifecycle_log: [{ event: "issued" }],
          }),
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
            subtotal_minor: "-50000",
            tax_total_minor: "0",
            grand_total_minor: "-50000",
            tax_treatment: "eu_export_non_eu",
            incoterm: "DAP",
            shopify_order_id: "ORD-1",
            external_refs: { original_document_id: INVOICE_ID },
            lifecycle_log: [{ event: "issued" }],
          },
        ],
      },
    })
    const ctx = makeFullCtx(db)

    // BEFORE the fix, `isFullyCredited` was called with neither the invoice's `id` nor
    // `candidateDocs`, so it fell back to the lifecycle_log marker ONLY -- which this
    // invoice does not carry -- and issued a SECOND credit note.
    const res = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res.status).toBe("ok")
    expect(creditNotes(db)).toHaveLength(1)
    expect(creditNotes(db)[0]!.id).toBe(CN_ID)
  })

  test("cancelling does not credit an invoice that was never issued", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: "00000000-0000-4000-8000-000000000906",
            status: "pending_approval",
            grand_total_minor: "30000",
          }),
        ],
      },
    })
    const ctx = makeFullCtx(db)

    // BEFORE the fix, the gate was `status !== "draft"`, which let a pending_approval
    // invoice (never actually sent to the customer) through and issued a real credit
    // note against it.
    const res = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res.status).toBe("ok")
    expect(creditNotes(db)).toHaveLength(0)
  })

  test("cancelling an invoice that was already partially credit noted reverses only the remainder", async () => {
    const INVOICE_ID = "00000000-0000-4000-8000-000000000907"
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          // A prior Shopify partial refund of 30 EUR already auto-issued a 30 EUR adjustment
          // credit note (the partial branch of shopify-refund-created.ts). The invoice `status`
          // stays "issued" -- only `payment_status` moves to "partial" -- so ISSUED_INVOICE_STATUSES
          // still matches it, and 30 < 100 means the old boolean `isFullyCredited` read false.
          invoiceRow({
            id: INVOICE_ID,
            grand_total_minor: "10000",
            payment_status: "partial",
            lifecycle_log: [{ event: "issued" }],
          }),
          {
            id: "00000000-0000-4000-8000-000000000908",
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
            subtotal_minor: "-3000",
            tax_total_minor: "0",
            grand_total_minor: "-3000",
            tax_treatment: "eu_export_non_eu",
            incoterm: "DAP",
            shopify_order_id: "ORD-1",
            external_refs: { original_document_id: INVOICE_ID },
            lifecycle_log: [{ event: "issued" }],
          },
        ],
        document_lines: [
          lineRow({
            id: "l-g",
            document_id: INVOICE_ID,
            description: "Tessera 2",
            unit_price_minor: "10000",
          }),
        ],
      },
    })
    const ctx = makeFullCtx(db)

    const res = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res.status).toBe("ok")

    const cns = creditNotes(db)
    // BEFORE the fix this issued a SECOND credit note for the FULL 100 EUR (10000 minor), so
    // creditNotes had length 2 with totals -3000 and -10000 -- summing to -13000, i.e. 130 EUR
    // credited against a 100 EUR invoice.
    expect(cns).toHaveLength(2)
    const secondCn = cns.find((c) => c.id !== "00000000-0000-4000-8000-000000000908")!
    expect(Number(secondCn.grand_total_minor)).toBe(-7000)
    const sumOfCreditNotes = cns.reduce((sum, c) => sum + Number(c.grand_total_minor), 0)
    expect(sumOfCreditNotes).toBe(-10000)
  })

  test("cancelling an already fully credit noted invoice issues nothing", async () => {
    const INVOICE_ID = "00000000-0000-4000-8000-000000000909"
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: INVOICE_ID,
            grand_total_minor: "10000",
            payment_status: "refunded",
            lifecycle_log: [{ event: "issued" }],
          }),
          {
            id: "00000000-0000-4000-8000-000000000910",
            type: "credit_note",
            scope: null,
            status: "issued",
            payment_status: "unpaid",
            number: "CN-2026-0002",
            number_int: 2,
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
      },
    })
    const ctx = makeFullCtx(db)

    const res = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res.status).toBe("ok")
    expect(creditNotes(db)).toHaveLength(1)
  })

  test("no invoice for the order is a no-op", async () => {
    const db = createMockDb({ seed: { issuer_profiles: [ISSUER_ROW] } })
    const ctx = makeFullCtx(db)
    const res = await onShopifyOrderCancelled({ data: { orderId: "ORD-none" } }, ctx)
    expect(res.status).toBe("noop")
    expect(creditNotes(db)).toHaveLength(0)
  })

  test("db-only ctx (no issue pipeline) still records the cancellation but issues NO credit note", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: "00000000-0000-4000-8000-000000000903",
            grand_total_minor: "50000",
          }),
        ],
      },
    })
    const minimal: OrderCancelledCtx = {
      getUserId: async () => "system",
      db: db as unknown as OrderCancelledCtx["db"],
      emit: async () => {},
    }
    const res = await onShopifyOrderCancelled({ data: { orderId: "ORD-1" } }, minimal)
    expect(res.status).toBe("ok")
    expect(creditNotes(db)).toHaveLength(0)
  })

  function priorCreditNote(
    id: string,
    invoiceId: string,
    amountMinor: string,
  ): Record<string, unknown> {
    return {
      id,
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
      subtotal_minor: amountMinor,
      tax_total_minor: "0",
      grand_total_minor: amountMinor,
      tax_treatment: "eu_export_non_eu",
      incoterm: "DAP",
      shopify_order_id: "ORD-1",
      external_refs: { original_document_id: invoiceId },
      lifecycle_log: [{ event: "issued" }],
    }
  }

  test("a partial cancellation reversal carries the VAT it reverses", async () => {
    const INVOICE_ID = "00000000-0000-4000-8000-000000000930"
    // One line at 20% VAT: net 10000, tax 2000, gross 12000. A prior partial refund already
    // credited 6000, leaving 6000 outstanding for the cancellation to reverse.
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: INVOICE_ID,
            grand_total_minor: "12000",
            payment_status: "partial",
            lifecycle_log: [{ event: "issued" }],
          }),
          priorCreditNote("00000000-0000-4000-8000-000000000931", INVOICE_ID, "-6000"),
        ],
        document_lines: [
          lineRow({
            id: "l-vat",
            document_id: INVOICE_ID,
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

    const res = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res.status).toBe("ok")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(2)
    const newCn = cns.find((c) => c.id !== "00000000-0000-4000-8000-000000000931")!
    // BEFORE the fix newCn.tax_total_minor was 0 (single 0-tax adjustment line). AFTER the fix it
    // carries the proportional 20% VAT on the reversed net amount.
    expect(Number(newCn.tax_total_minor)).toBe(-1000)
    expect(Number(newCn.grand_total_minor)).toBe(-6000)

    const cnLines = db.__all("document_lines").filter((l) => l.document_id === newCn.id)
    const netPlusTax = cnLines.reduce(
      (sum, l) => sum + Number(l.subtotal_minor) + Number(l.tax_minor),
      0,
    )
    expect(netPlusTax).toBe(-6000)
  })

  test("a partial cancellation of a two rate invoice reverses both rates in proportion", async () => {
    const INVOICE_ID = "00000000-0000-4000-8000-000000000932"
    // Line A at 20% VAT: net 10000, tax 2000, gross 12000.
    // Line B at 10% VAT: net 10000, tax 1000, gross 11000.
    // Invoice total gross: 23000. A prior partial refund already credited 11500, leaving 11500
    // outstanding for the cancellation to reverse.
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: INVOICE_ID,
            grand_total_minor: "23000",
            payment_status: "partial",
            lifecycle_log: [{ event: "issued" }],
          }),
          priorCreditNote("00000000-0000-4000-8000-000000000933", INVOICE_ID, "-11500"),
        ],
        document_lines: [
          lineRow({
            id: "l-a",
            document_id: INVOICE_ID,
            description: "Line A (20 pct)",
            unit_price_minor: "10000",
            tax_rate_bp: 2000,
            subtotal_minor: "10000",
            tax_minor: "2000",
            total_minor: "12000",
          }),
          lineRow({
            id: "l-b",
            document_id: INVOICE_ID,
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

    const res = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res.status).toBe("ok")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(2)
    const newCn = cns.find((c) => c.id !== "00000000-0000-4000-8000-000000000933")!
    expect(Number(newCn.grand_total_minor)).toBe(-11500)

    const cnLines = db
      .__all("document_lines")
      .filter((l) => l.document_id === newCn.id)
      .sort((a, b) => Number(a.tax_rate_bp) - Number(b.tax_rate_bp))
    expect(cnLines).toHaveLength(2)
    expect(Number(cnLines[0]!.tax_rate_bp)).toBe(1000)
    expect(Number(cnLines[0]!.subtotal_minor)).toBe(-5000)
    expect(Number(cnLines[0]!.tax_minor)).toBe(-500)
    expect(Number(cnLines[1]!.tax_rate_bp)).toBe(2000)
    expect(Number(cnLines[1]!.subtotal_minor)).toBe(-5000)
    expect(Number(cnLines[1]!.tax_minor)).toBe(-1000)

    const netPlusTax = cnLines.reduce(
      (sum, l) => sum + Number(l.subtotal_minor) + Number(l.tax_minor),
      0,
    )
    expect(netPlusTax).toBe(-11500)
  })

  test("a partial cancellation reversal is exact to the minor unit when the split does not divide evenly", async () => {
    const INVOICE_ID = "00000000-0000-4000-8000-000000000934"
    // One line at 20% VAT: net 50000, tax 10000, gross 60000. A prior partial refund already
    // credited 59067, leaving 933 outstanding -- netOfIncludedTax/lineTax's forward split does
    // NOT reconstruct 933 exactly (it lands on 934), forcing the rounding-residual sweep line.
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: INVOICE_ID,
            grand_total_minor: "60000",
            payment_status: "partial",
            lifecycle_log: [{ event: "issued" }],
          }),
          priorCreditNote("00000000-0000-4000-8000-000000000935", INVOICE_ID, "-59067"),
        ],
        document_lines: [
          lineRow({
            id: "l-odd",
            document_id: INVOICE_ID,
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

    const res = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res.status).toBe("ok")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(2)
    const newCn = cns.find((c) => c.id !== "00000000-0000-4000-8000-000000000935")!
    expect(Number(newCn.grand_total_minor)).toBe(-933)

    const cnLines = db.__all("document_lines").filter((l) => l.document_id === newCn.id)
    const netPlusTax = cnLines.reduce(
      (sum, l) => sum + Number(l.subtotal_minor) + Number(l.tax_minor),
      0,
    )
    expect(netPlusTax).toBe(-933)
  })

  test("a partial cancellation of an invoice with a negative discount line never emits a positive reversal line", async () => {
    const INVOICE_ID = "00000000-0000-4000-8000-000000000936"
    // Line A at 20% VAT: net 10000, tax 2000, gross 12000.
    // Line B: a -30.00 discount at 0bp, gross -3000, with no offsetting positive line at 0bp --
    // the same shape as buildAdjustmentReversalItems's counter-case 1 (shared with
    // shopify-refund-created.ts). Invoice total gross: 9000. A prior partial refund already
    // credited 8500, leaving 500 outstanding for the cancellation to reverse.
    const db = createMockDb({
      seed: {
        issuer_profiles: [ISSUER_ROW],
        documents: [
          invoiceRow({
            id: INVOICE_ID,
            grand_total_minor: "9000",
            payment_status: "partial",
            lifecycle_log: [{ event: "issued" }],
          }),
          priorCreditNote("00000000-0000-4000-8000-000000000937", INVOICE_ID, "-8500"),
        ],
        document_lines: [
          lineRow({
            id: "l-vat",
            document_id: INVOICE_ID,
            unit_price_minor: "10000",
            tax_rate_bp: 2000,
            subtotal_minor: "10000",
            tax_minor: "2000",
            total_minor: "12000",
          }),
          lineRow({
            id: "l-discount",
            document_id: INVOICE_ID,
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

    const res = await onShopifyOrderCancelled(
      { data: { orderId: "ORD-1", cancel_reason: "customer request" } },
      ctx,
    )
    expect(res.status).toBe("ok")

    const cns = creditNotes(db)
    expect(cns).toHaveLength(2)
    const newCn = cns.find((c) => c.id !== "00000000-0000-4000-8000-000000000937")!
    expect(Number(newCn.grand_total_minor)).toBe(-500)

    const cnLines = db.__all("document_lines").filter((l) => l.document_id === newCn.id)
    // The negative 0bp group is excluded from the allocation: no line here charges the
    // customer, matching buildAdjustmentReversalItems's counter-case 1 fix exactly.
    for (const l of cnLines) {
      expect(Number(l.unit_price_minor)).toBeLessThanOrEqual(0)
    }
    const netPlusTax = cnLines.reduce(
      (sum, l) => sum + Number(l.subtotal_minor) + Number(l.tax_minor),
      0,
    )
    expect(netPlusTax).toBe(-500)
  })
})

describe("order cancellation closes the order's open parks", () => {
  test("a park waiting on a customer email is resolved when the order is cancelled", async () => {
    const db = createMockDb({
      seed: {
        deferred_events: [
          {
            id: "00000000-0000-4000-8000-00000000c001",
            event_id: "ORD-P",
            event_payload_json: { id: "ORD-P" },
            status: "awaiting_data",
            reason: "customer_email_missing",
            blocked_on: { kind: "customer_email", customer_id: "c-1" },
            retry_count: 0,
          },
          {
            id: "00000000-0000-4000-8000-00000000c002",
            event_id: "ORD-OTHER",
            event_payload_json: { id: "ORD-OTHER" },
            status: "awaiting_data",
            reason: "customer_email_missing",
            blocked_on: { kind: "customer_email", customer_id: "c-2" },
            retry_count: 0,
          },
        ],
      },
    })
    const result = await onShopifyOrderCancelled({ id: "ORD-P", shop_id: "shop-1" }, makeFullCtx(db))
    expect(result).toEqual({ status: "noop", reason: "no_invoice_yet" })
    const rows = db.__all("deferred_events") as Array<Record<string, unknown>>
    expect(rows.find((r) => r.event_id === "ORD-P")).toMatchObject({
      status: "resolved",
      reason: "order_cancelled",
    })
    // Another order's park is untouched.
    expect(rows.find((r) => r.event_id === "ORD-OTHER")!.status).toBe("awaiting_data")
  })
})
