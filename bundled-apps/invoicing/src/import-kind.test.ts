// SPDX-License-Identifier: FSL-1.1-ALv2
// `invoicing.document`: historical invoices, credit notes and proformas with
// their original numbers, dates and totals (minor units, vendor-neutral), the
// original PDF attached by the host, and the numbering sequences raised past
// the imported numbers. Imports only create; no legal original is recorded
// (the legacy-originals backfill does that once the import is checked).
import { describe, expect, it } from "bun:test"
import { checkDocuments, importDocuments } from "./import-kind"
import { createMockDb as createSharedMockDb } from "@liaison/test-helpers/mock-db"

/** The bridge's `where` semantics (a `null` value is IS NULL), uuid ids like prod. */
const mockDb = () => createSharedMockDb({}, { ids: "uuid", bridgeWhereOperators: true })

const PDF = "0f6a1c9e-5b8d-4c2e-9a7f-3e1d2c4b5a60"

async function setup(issuers = 1) {
  const db = mockDb()
  const ids: string[] = []
  for (let i = 0; i < issuers; i++) {
    ids.push(
      (await db.insert("issuer_profiles", { legal_name: `Fabrikam ${i}`, country: "FR" })).id,
    )
  }
  return { db, ctx: { db }, issuerIds: ids }
}

const doc = (over: Record<string, unknown> = {}) => ({
  externalRef: "INV-1001",
  type: "invoice",
  number: "INV-1001",
  numberInt: 1001,
  issueDate: "2025-03-04",
  currency: "EUR",
  counterparty: { name: "Contoso", country: "DE", vatId: "DE123456789" },
  lines: [
    { description: "Controller", quantity: 2, unitPriceMinor: 50000, taxRateBp: 0, totalMinor: 100000 },
  ],
  taxTotalMinor: 0,
  grandTotalMinor: 100000,
  amountPaidMinor: 100000,
  pdf: { fileId: PDF },
  ...over,
})

const batch = (records: Array<Record<string, unknown>>, label = "erp") => ({
  runId: "run-1",
  kind: "invoicing.document",
  sourceLabel: label,
  records: records.map((record) => ({ record, dedupValue: `${label}:${String(record.externalRef)}` })),
})

describe("invoicing.document", () => {
  it("imports a legal original as issued, even a credit note dated before its invoice", async () => {
    const { db, ctx } = await setup()
    const out = await importDocuments(
      batch([
        doc({ issueDate: "2025-06-10" }),
        doc({
          externalRef: "CN-8",
          type: "credit_note",
          number: "CN-8",
          numberInt: 8,
          issueDate: "2025-03-04",
          grandTotalMinor: -100000,
          amountPaidMinor: undefined,
          lines: [{ description: "Refund", quantity: "1", unitPriceMinor: -100000, taxRateBp: 0, totalMinor: -100000 }],
          originalExternalRef: "INV-1001",
        }),
      ]),
      ctx,
    )
    expect(out.map((r) => r.status)).toEqual(["created", "created"])
    const credit = db.__all("documents").find((d) => d.external_ref === "erp:CN-8")!
    expect(String(credit.issued_at).slice(0, 10)).toBe("2025-03-04")
  })

  it("imports a paid invoice, an unpaid one and a credit note linked to its original", async () => {
    const { db, ctx, issuerIds } = await setup()
    const out = await importDocuments(
      batch([
        doc(),
        doc({ externalRef: "INV-1002", number: "INV-1002", numberInt: 1002, amountPaidMinor: 0, dueDate: "2025-04-04" }),
        doc({
          externalRef: "CN-7",
          type: "credit_note",
          number: "CN-7",
          numberInt: 7,
          grandTotalMinor: -100000,
          amountPaidMinor: undefined,
          lines: [{ description: "Refund", quantity: "1", unitPriceMinor: -100000, taxRateBp: 0, totalMinor: -100000 }],
          originalExternalRef: "INV-1002",
        }),
      ]),
      ctx,
    )
    expect(out.map((r) => r.status)).toEqual(["created", "created", "created"])
    const docs = db.__all("documents")
    const byRef = new Map(docs.map((d) => [d.external_ref, d]))
    const paid = byRef.get("erp:INV-1001")!
    expect([paid.type, paid.status, paid.payment_status, paid.number, paid.number_int, paid.year_of_issue]).toEqual(
      ["invoice", "paid", "paid", "INV-1001", 1001, 2025],
    )
    expect([paid.issuer_profile_id, paid.currency, String(paid.grand_total_minor), paid.pdf_status]).toEqual([
      issuerIds[0],
      "EUR",
      "100000",
      "ready",
    ])
    const unpaid = byRef.get("erp:INV-1002")!
    expect([unpaid.status, unpaid.payment_status]).toEqual(["issued", "unpaid"])
    const credit = byRef.get("erp:CN-7")!
    expect(credit.original_document_id).toBe(unpaid.id)
    expect((credit.lifecycle_log as Array<{ event: string; source: string }>)[0]).toMatchObject({
      event: "issued",
      source: "import:erp",
    })
    expect(db.__all("legal_originals")).toHaveLength(0)
    expect(db.__all("document_lines").filter((l) => l.document_id === paid.id)).toHaveLength(1)

    // The PDF is attached by the host, which records the copy as the
    // document's `import_file_id`; `import_source` marks it imported, so no
    // write path re-renders over the original and the backfill finds it.
    expect(out[0]!.attachments).toEqual([
      { fileId: PDF, parent: "pdf", rowId: String(paid.id), ref: "import_file_id" },
    ])
    expect((paid.external_refs as Record<string, unknown>).import_source).toBe("erp:INV-1001")
    expect(out[0]!.rows.map((r) => r.table)).toEqual([
      "app_invoicing.documents",
      "app_invoicing.document_lines",
    ])
    expect(out[2]!.sequenceFloors).toEqual([
      { key: `invoicing:doc_number:${issuerIds[0]}:credit_note:2025`, value: 7 },
    ])

    const again = await importDocuments(batch([doc()]), ctx)
    expect(again.map((r) => r.status)).toEqual(["skipped"])
  })

  it("reports a number the issuer already used as numberTaken, by number_int or by number", async () => {
    const { db, ctx, issuerIds } = await setup()
    await db.insert("documents", {
      type: "invoice",
      status: "issued",
      number: "INV-1001",
      number_int: 1001,
      year_of_issue: 2025,
      issuer_profile_id: issuerIds[0],
      currency: "EUR",
    })
    await db.insert("documents", {
      type: "invoice",
      status: "issued",
      number: "INV-77",
      number_int: null,
      year_of_issue: 2025,
      issuer_profile_id: issuerIds[0],
      currency: "EUR",
    })
    const out = await importDocuments(
      batch([
        doc({ externalRef: "other-1001" }),
        doc({ externalRef: "other-77", number: "INV-77", numberInt: 77 }),
      ]),
      ctx,
    )
    expect(out.map((r) => r.status)).toEqual(["failed", "failed"])
    for (const r of out) expect(r.error).toMatch(/^numberTaken: /)
    expect(db.__all("documents")).toHaveLength(2)
  })

  it("refuses a number and number_int that disagree", async () => {
    const { db, ctx } = await setup()
    const out = await importDocuments(batch([doc({ number: "INV-1001", numberInt: 1002 })]), ctx)
    expect(out[0]!.status).toBe("failed")
    expect(out[0]!.error).toMatch(/^number_mismatch: /)
    expect(db.__all("documents")).toHaveLength(0)
  })

  it("refuses a status that contradicts the payment", async () => {
    const { db, ctx } = await setup()
    const out = await importDocuments(
      batch([
        doc({ status: "paid", amountPaidMinor: 0 }),
        doc({ externalRef: "INV-1002", number: "INV-1002", numberInt: 1002, status: "issued" }),
      ]),
      ctx,
    )
    expect(out.map((r) => r.status)).toEqual(["failed", "failed"])
    for (const r of out) expect(r.error).toMatch(/^status_mismatch: /)
    expect(db.__all("documents")).toHaveLength(0)
  })

  it("writes nothing when a line is invalid (every line checked before the first insert)", async () => {
    const { db, ctx } = await setup()
    const out = await importDocuments(
      batch([
        doc({
          lines: [
            { description: "ok", quantity: 1, unitPriceMinor: 100, taxRateBp: 0, totalMinor: 100 },
            { description: "bad", quantity: 1, unitPriceMinor: "12.50", taxRateBp: 0, totalMinor: 100 },
          ],
        }),
      ]),
      ctx,
    )
    expect(out[0]!.status).toBe("failed")
    expect(out[0]!.rows).toEqual([])
    expect(db.__all("documents")).toHaveLength(0)
    expect(db.__all("document_lines")).toHaveLength(0)
  })

  it("finds the one active issuer among archived ones", async () => {
    const db = mockDb()
    for (let i = 0; i < 3; i++) {
      await db.insert("issuer_profiles", {
        legal_name: `Old ${i}`,
        country: "FR",
        archived_at: "2024-01-01T00:00:00Z",
      })
    }
    const active = await db.insert("issuer_profiles", { legal_name: "Current", country: "FR" })
    const out = await importDocuments(batch([doc()]), { db })
    expect(out[0]!.status).toBe("created")
    expect(db.__all("documents")[0]!.issuer_profile_id).toBe(active.id)
  })

  it("needs the issuer named when the org has several", async () => {
    const { ctx, issuerIds } = await setup(2)
    const out = await importDocuments(
      batch([doc(), doc({ externalRef: "INV-2", number: "INV-2", numberInt: 2, issuerProfileId: issuerIds[1] })]),
      ctx,
    )
    expect(out.map((r) => r.status)).toEqual(["failed", "created"])
    expect(out[0]!.error).toMatch(/issuer_ambiguous/)
  })
})

describe("invoicing.document check (the preview)", () => {
  it("refuses what the run refuses and writes nothing", async () => {
    const none = await setup(0)
    expect(await checkDocuments(batch([doc()]), none.ctx)).toEqual([
      {
        status: "failed",
        error:
          "issuer_missing: the org has no issuer profile yet. Ask the person for their company's legal name, address and legal identifiers (SIREN or SIRET, VAT number), or for a document that shows them; never make them up. Create the profile with what they give, then name it with issuerProfileId",
      },
    ])
    const two = await setup(2)
    const [several] = await checkDocuments(batch([doc()]), two.ctx)
    expect(several?.error).toMatch(/^issuer_ambiguous: the org has several/)
    expect(await two.db.findMany("documents", {})).toHaveLength(0)
  })

  it("passes a record the run would create, skips one already imported", async () => {
    const { db, ctx } = await setup()
    const [passed] = await checkDocuments(batch([doc()]), ctx)
    expect(passed?.status).toBe("created")
    expect(await db.findMany("documents", {})).toHaveLength(0)
    await importDocuments(batch([doc()]), ctx)
    expect(await checkDocuments(batch([doc()]), ctx)).toEqual([{ status: "skipped" }])
  })

  it("refuses a second record with the same number, in the preview and in the run", async () => {
    const { db, ctx } = await setup()
    const twin = doc({ externalRef: "INV-1001-B" })
    const preview = await checkDocuments(batch([doc(), twin]), ctx)
    expect(preview[0]?.status).toBe("created")
    expect(preview[1]?.status).toBe("failed")
    expect(preview[1]?.error).toMatch(/^numberTaken: INV-1001/)
    const run = await importDocuments(batch([doc(), twin]), ctx)
    expect(run.map((r) => r.status)).toEqual(["created", "failed"])
    expect(run[1]?.error).toMatch(/^numberTaken: /)
    expect(await db.findMany("documents", {})).toHaveLength(1)
  })

  it("refuses a number an earlier batch of the run claimed, and returns the claims it holds", async () => {
    const { ctx, issuerIds } = await setup()
    const [first] = await checkDocuments(batch([doc()]), ctx)
    expect(first?.claims).toEqual([
      `int:${issuerIds[0]}:invoice:2025:1001`,
      `str:${issuerIds[0]}:INV-1001`,
    ])
    // The next batch, with the run's claims so far (the host passes them).
    const next = { ...batch([doc({ externalRef: "INV-1001-B" })]), claimed: first?.claims ?? [] }
    const [second] = await checkDocuments(next, ctx)
    expect(second?.status).toBe("failed")
    expect(second?.error).toMatch(/^numberTaken: INV-1001 is used by an earlier record/)
  })

  it("claims a number only for a record that passed its other checks", async () => {
    const { ctx } = await setup()
    const refused = doc({ status: "paid", amountPaidMinor: 0 })
    const later = doc({ externalRef: "INV-1001-B" })
    const out = await checkDocuments(batch([refused, later]), ctx)
    expect(out[0]?.status).toBe("failed")
    expect(out[0]?.error).toMatch(/^status_mismatch/)
    expect(out[0]?.claims).toBeUndefined()
    expect(out[1]?.status).toBe("created")
  })
})

