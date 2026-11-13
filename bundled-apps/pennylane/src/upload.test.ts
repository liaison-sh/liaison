// SPDX-License-Identifier: FSL-1.1-ALv2
//
// supplier_invoice_upload: the real import (file attachment from the bill's own bytes, then the
// supplier invoice import with the stated figures), the supplier resolved exactly or refused with
// candidates, the same file never imported twice (lookup by external reference first, a 409 on
// the attachment adopted), and a record of what was imported.
import { describe, expect, it } from "bun:test"
import { createMockDb } from "@liaison/test-helpers/mock-db"
import type { PennylaneToolCtx } from "./ctx"
import { PennylaneFake } from "./einvoicing/fake/server"
import { minorAmountsRefusal, minorToDecimal, supplierInvoiceUpload, vatRateCode } from "./upload"

function setup() {
  const fake = new PennylaneFake()
  fake.files.set("file-bill-1", {
    sha256: "b".repeat(64),
    invoice_number: null,
    date: null,
    buyer_siren: null,
    valid: true,
  })
  const db = createMockDb({}, { bridgeWhereOperators: true, ids: "uuid", stampCreatedAt: true })
  const ctx = {
    orgId: "org",
    db,
    fetch: fake.sandboxFetch,
    connections: {
      pennylane: { getSettings: async () => ({ values: { scope: "company" }, missing: [] }) },
    },
  } as unknown as PennylaneToolCtx
  return { fake, ctx, db }
}

const INPUT = {
  file_id: "file-bill-1",
  supplier_name: "Transporteur Exemple",
  invoice_number: "TR-2026-0042",
  invoice_date: "2026-06-30",
  due_date: "2026-07-30",
  amount_minor: "41260",
  tax_minor: "6877",
  currency: "EUR",
}

type R = Record<string, any>

describe("supplier_invoice_upload", () => {
  it("imports the bill: attachment with the file's bytes, then the supplier invoice with the stated figures", async () => {
    const { fake, ctx, db } = setup()
    fake.receive({ supplier: "Transporteur Exemple" }) // creates the supplier
    fake.receive({ supplier: "Transporteur Exemple SAS" }) // a prefix sibling, not an exact match
    const sup = [...fake.suppliers.values()].find((s) => s.name === "Transporteur Exemple")!
    const r = (await supplierInvoiceUpload(ctx, INPUT)) as R
    expect(r).toMatchObject({
      disposition: "imported",
      posted_to_pennylane: true,
      adopted: false,
      supplier: { id: String(sup.id) },
    })
    const att = fake.calls.find((c) => c.path === "/file_attachments")!
    expect(att.parts?.find((p) => p.name === "file")?.sha256).toBe("b".repeat(64))
    const imp = fake.calls.find((c) => c.path === "/supplier_invoices/import")!.json as R
    expect(imp).toMatchObject({
      supplier_id: sup.id,
      date: "2026-06-30",
      deadline: "2026-07-30",
      invoice_number: "TR-2026-0042",
      currency: "EUR",
      currency_amount: "412.60",
      currency_tax: "68.77",
      currency_amount_before_tax: "343.83",
      external_reference: "liaison-file-bill-1",
    })
    expect(imp.invoice_lines).toEqual([
      {
        currency_amount: "412.60",
        currency_tax: "68.77",
        label: "Invoice TR-2026-0042",
        vat_rate: "FR_200",
      },
    ])
    const rows = (await db.findMany("supplier_invoice_upload", {})) as R[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      status: "imported",
      provider_ref: r.provider_ref,
      source_file_id: "file-bill-1",
    })
  })

  it("a supplier e-invoice received through the platform is never uploaded again: an actionable refusal, nothing sent", async () => {
    const { fake, ctx, db } = setup()
    fake.receive({ supplier: "Transporteur Exemple" })
    fake.files.set("file-received-1", {
      sha256: "c".repeat(64),
      invoice_number: null,
      date: null,
      buyer_siren: null,
      valid: true,
      parent: { app: "invoicing", entityType: "received_file" },
    })
    const r = (await supplierInvoiceUpload(ctx, { ...INPUT, file_id: "file-received-1" })) as R
    expect(r.status).toBe("error")
    expect(r.error.code).toBe("received_einvoice_in_pennylane")
    expect(r.error.message).toContain("already in Pennylane")
    expect(r.error.message).toContain("received_einvoices_get")
    expect(
      fake.calls.some(
        (c) => c.path === "/file_attachments" || c.path === "/supplier_invoices/import",
      ),
    ).toBe(false)
    expect(await db.findMany("supplier_invoice_upload", {})).toHaveLength(0)
  })

  it("the same file again is adopted, never imported twice", async () => {
    const { fake, ctx } = setup()
    fake.receive({ supplier: "Transporteur Exemple" })
    const first = (await supplierInvoiceUpload(ctx, INPUT)) as R
    const again = (await supplierInvoiceUpload(ctx, INPUT)) as R
    expect(again).toMatchObject({ provider_ref: first.provider_ref, adopted: true })
    expect(fake.calls.filter((c) => c.path === "/supplier_invoices/import")).toHaveLength(1)
  })

  it("a 409 on the attachment (crash window) adopts the id Pennylane names", async () => {
    const { fake, ctx } = setup()
    fake.receive({ supplier: "Transporteur Exemple" })
    fake.fail((c) => c.path === "/supplier_invoices/import", "replace", {
      status: 409,
      body: { status: 409, error: "A document with ID 4242 already exists with such attachment." },
    })
    const r = (await supplierInvoiceUpload(ctx, INPUT)) as R
    expect(r).toMatchObject({ provider_ref: "4242", adopted: true })
  })

  it("no exact supplier: refused with the candidates, nothing created", async () => {
    const { fake, ctx } = setup()
    fake.receive({ supplier: "Transporteur Exemple SAS" })
    const r = (await supplierInvoiceUpload(ctx, INPUT)) as R
    expect(r.error.code).toBe("supplier_not_found")
    expect(r.error.detail.candidates).toEqual([
      expect.objectContaining({ name: "Transporteur Exemple SAS" }),
    ])
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false)
  })

  it("supplier_id skips the name lookup", async () => {
    const { fake, ctx } = setup()
    fake.receive({ supplier: "Autre nom" })
    const sup = [...fake.suppliers.values()][0]!
    const r = (await supplierInvoiceUpload(ctx, { ...INPUT, supplier_id: String(sup.id) })) as R
    expect(r.supplier.id).toBe(String(sup.id))
    expect(fake.calls.some((c) => c.path.startsWith("/suppliers?"))).toBe(false)
  })

  it("refuses bad input before any call", async () => {
    const { fake, ctx } = setup()
    for (const bad of [
      { invoice_date: "30/06/2026" },
      { currency: "euro" },
      { due_date: "soon" },
    ]) {
      const r = (await supplierInvoiceUpload(ctx, { ...INPUT, ...bad })) as R
      expect(r.error.code).toBe("invalid_input")
    }
    expect(fake.calls).toHaveLength(0)
  })

  it("refuses an amount with a decimal point, naming what to send, before any call", async () => {
    const { fake, ctx } = setup()
    const r = (await supplierInvoiceUpload(ctx, { ...INPUT, amount_minor: "412.60" })) as R
    expect(r.error.code).toBe("invalid_amount")
    expect(r.error.message).toContain("41260")
    expect(fake.calls).toHaveLength(0)
    expect(minorAmountsRefusal({ amount_minor: "41260", tax_minor: "68.5" })).toContain("tax_minor")
    expect(minorAmountsRefusal({ amount_minor: "41260" })).toBeNull()
  })

  it("names the line's VAT rate code from the stated figures (Pennylane requires one per line)", () => {
    expect(vatRateCode(10000n, 2000n)).toBe("FR_200")
    expect(vatRateCode(34383n, 6877n)).toBe("FR_200")
    expect(vatRateCode(10000n, 1000n)).toBe("FR_100")
    expect(vatRateCode(10000n, 550n)).toBe("FR_55")
    expect(vatRateCode(10000n, 210n)).toBe("FR_21")
    expect(vatRateCode(10000n, 0n)).toBe("exempt")
    // Lines at several rates folded into one total: no single French rate fits.
    expect(vatRateCode(10000n, 1500n)).toBe("mixed")
  })

  it("converts minor units by the currency's decimals", () => {
    expect(minorToDecimal("41260", "EUR")).toBe("412.60")
    expect(minorToDecimal("5", "EUR")).toBe("0.05")
    expect(minorToDecimal("-1050", "EUR")).toBe("-10.50")
    expect(minorToDecimal("1200", "JPY")).toBe("1200")
    expect(minorToDecimal("1.5", "EUR")).toBeNull()
  })
})
