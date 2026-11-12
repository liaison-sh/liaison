// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The legal original is fixed at issue (S23): the first render of an invoice / credit note is
// recorded in its own immutable row under its own file parent; for an e_invoice document that
// render is the Factur-X (PDF/A-3B with the CII attached, S7). Later renders never replace it,
// a Factur-X build failure leaves `facturx_failed` + attention and the retry fixes it.

import { testTime } from "../test-time"
import { describe, expect, test } from "bun:test"
import { validateFacturxXml } from "../../../../tools/schematron/validate"
import { sha256OfBase64 } from "../einvoicing/backfill-sha256"
import { FICTIONAL_SIRENS, FR_SELLER_IDENTITY } from "../einvoicing/test-fixtures"
import { readEinvoiceRowColumns } from "../einvoicing/issue-gate"
import { flatDocument } from "../facturx/input"
import { type IssueCtx, type IssueInput, issueDocument } from "../issue"
import { documentsUpdate } from "../mutations/documents-update"
import { ensureDocumentPdf } from "../mutations/pdf"
import { documentsDownloadPdf, documentsPreviewPdf, type ReadsCtx } from "../reads"
import type { MutationsCtx } from "../mutations/shared"
import { createMockDb, type MockDb } from "../test-db"

type RenderCall = Record<string, unknown> & {
  pdfa?: string
  attachments?: Array<{ name: string; mime: string; bytesBase64: string; afRelationship: string }>
  xmp?: { extensions: Array<{ prefix: string; namespaceUri: string; properties: Array<{ name: string; value: string }> }> }
  parent?: { entityType: string; entityId?: string; commitRow?: unknown }
  link?: unknown
}

function makeCtx() {
  const db: MockDb = createMockDb({
    seed: {
      einvoicing_settings: [{ gate_mode: "enforce", gate_mode_source: "config" }],
      counterparty_identities: [
        {
          contact_id: "contact-fr-1",
          customer_kind: "business",
          siren: FICTIONAL_SIRENS[0],
          registry_name: "Client Exemple SAS",
          registry_status: "A",
          source: "registry",
          confirmed_via: "auto",
        },
      ],
    },
  })
  const renders: RenderCall[] = []
  const imports: Array<Record<string, unknown>> = []
  const events: Array<{ entity: string; action: string; data?: unknown }> = []
  let seq = 0
  let failRender = false
  const ctx: IssueCtx & { files_importAttachment(a: string): Promise<string> } = {
    getUserId: async () => "user-1",
    db,
    time: testTime(),
    pdf: {
      async render(p) {
        renders.push(p as RenderCall)
        if (failRender) throw Object.assign(new Error("render boom"), { code: "render_failed" })
        const out = {
          file_id: `file-${renders.length}`,
          byte_size: 2048,
          page_count: 1,
          sha256: `${renders.length}`.padStart(64, "a"),
          parent_entity_id: (p.parent?.entityId as string | undefined) ?? crypto.randomUUID(),
        }
        // Mirror the host: `commitRow` inserts the parent row with the file columns filled.
        const cr = p.parent?.commitRow
        if (cr) {
          await db.insert("legal_originals", {
            ...cr.values,
            id: out.parent_entity_id,
            ...(cr.fileIdColumn ? { [cr.fileIdColumn]: out.file_id } : {}),
            ...(cr.sha256Column ? { [cr.sha256Column]: out.sha256 } : {}),
            ...(cr.sizeColumn ? { [cr.sizeColumn]: out.byte_size } : {}),
          })
        }
        return out
      },
    },
    messages: {
      async post() {
        return { message_id: "m-1" }
      },
    },
    emit: async (e) => {
      events.push({ entity: e.entity, action: e.action, data: e.data })
    },
    async files_importAttachment(a: string) {
      const parsed = JSON.parse(a) as Record<string, unknown>
      imports.push(parsed)
      return JSON.stringify({ id: `xml-file-${imports.length}` })
    },
  }
  return { ctx, db, renders, imports, events, setFailRender: (v: boolean) => (failRender = v) }
}

const issuer = {
  id: "issuer-1",
  legal_name: "Maison Exemple SAS",
  country: "FR",
  vat_id: "FR40902000009",
  address: "1 rue de Test, 75001 Paris",
  iban: "FR7630006000011234567890189",
  swift_bic: "AGRIFRPP",
  bank_name: "Banque Test",
  default_language: "fr" as const,
  prefix_invoice: "FA-{YYYY}-",
  prefix_quote: "DV-{YYYY}-",
  prefix_proforma: "PF-{YYYY}-",
  prefix_po: "BC-{YYYY}-",
  prefix_credit_note: "AV-{YYYY}-",
  ...FR_SELLER_IDENTITY,
}

const frBuyer = {
  contact_id: "contact-fr-1",
  legal_name: "Client Exemple SAS",
  country: "FR",
  vat_id: "FR83900000001",
  address: "10 rue Domestic, 69002 Lyon",
  email: "compta@client.example",
  customer_kind: "business" as const,
  billing_line1: "10 rue Domestic",
  billing_postcode: "69002",
  billing_city: "Lyon",
  billing_country_code: "FR",
}

const deBuyer = {
  contact_id: "contact-de-1",
  legal_name: "Kunde Beispiel GmbH",
  country: "DE",
  vat_id: "DE123456789",
  address: "Hauptstrasse 5, 10115 Berlin",
  email: "buchhaltung@kunde.example",
  customer_kind: "business" as const,
}

function draft(): IssueInput["draft"] {
  return {
    currency: "EUR",
    incoterm: "DAP",
    year_of_issue: 2026,
    issued_at: "2026-11-03",
    due_at: "2026-12-03",
    external_refs: {},
    lines: [
      { position: 0, description: "Contrôleur", quantity: "2", unit_price_minor: 34999n, product_source: null, external_id: null },
      { position: 1, description: "Câble", quantity: "1", unit_price_minor: 1250n, product_source: null, external_id: null },
    ],
  }
}

function legalRows(db: MockDb) {
  return db.__all("legal_originals") as Array<Record<string, unknown>>
}

describe("legal original at issue", () => {
  test("an e_invoice issue renders the Factur-X once and records it as the legal original", async () => {
    const { ctx, db, renders, imports } = makeCtx()
    const r = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer, counterparty: frBuyer, draft: draft() })
    expect(renders).toHaveLength(1)
    const call = renders[0]!
    expect(call.pdfa).toBe("3b")
    expect(call.attachments?.map((a) => [a.name, a.mime, a.afRelationship])).toEqual([["factur-x.xml", "text/xml", "Data"]])
    const fx = call.xmp?.extensions[0]
    expect(fx?.prefix).toBe("fx")
    expect(Object.fromEntries((fx?.properties ?? []).map((p) => [p.name, p.value]))).toEqual({
      DocumentFileName: "factur-x.xml",
      DocumentType: "INVOICE",
      Version: "1.0",
      ConformanceLevel: "EN 16931",
    })
    const rows = legalRows(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ document_id: r.document_id, kind: "facturx", file_id: "file-1", sha256: "1".padStart(64, "a"), byte_size: 2048 })
    // Rendered INTO the row's own file parent (never the `pdf` parent a re-render replaces).
    expect(call.parent).toEqual({ entityType: "legal_original", entityId: String(rows[0]!.id) })
    const doc = (db.__all("documents") as Array<Record<string, unknown>>)[0]!
    expect(doc).toMatchObject({ legal_original_id: rows[0]!.id, legal_original_sha256: rows[0]!.sha256, pdf_file_id: "file-1", pdf_status: "ready" })
    expect(r.pdf_file_id).toBe("file-1")
    // The XML is also kept as its own file, hashed, and it is exactly the embedded one.
    const xmlRows = db.__all("facturx_files") as Array<Record<string, unknown>>
    expect(xmlRows).toHaveLength(1)
    expect(imports[0]).toMatchObject({ targetApp: "invoicing", targetEntityType: "facturx_xml", targetEntityId: xmlRows[0]!.id, mimeType: "text/xml" })
    expect(imports[0]!.bytesBase64).toBe(call.attachments![0]!.bytesBase64)
    expect(xmlRows[0]).toMatchObject({ file_id: "xml-file-1", profile: "EN 16931", sha256: sha256OfBase64(String(imports[0]!.bytesBase64)).sha256 })
  })

  test("the embedded XML of an issued e-invoice passes the XSD and every schematron", async () => {
    const { ctx, renders } = makeCtx()
    await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer, counterparty: frBuyer, draft: draft() })
    const xml = Buffer.from(renders[0]!.attachments![0]!.bytesBase64, "base64").toString("utf8")
    const v = validateFacturxXml(xml)
    expect(v.xsd.errors).toEqual([])
    expect(v.blocking.map((b) => `${b.schematron}:${b.id}`)).toEqual([])
  }, 120_000)

  for (const [shape, lines] of [
    [
      "negative unit prices (refund, cancellation, reissue)",
      [
        { position: 0, description: "Contrôleur", quantity: "2", unit_price_minor: -34999n, product_source: null, external_id: null },
        { position: 1, description: "Câble", quantity: "1", unit_price_minor: -1250n, product_source: null, external_id: null },
      ],
    ],
    [
      "a negative quantity",
      [{ position: 0, description: "Contrôleur", quantity: "-1", unit_price_minor: 34999n, product_source: null, external_id: null }],
    ],
  ] as const) {
    test(`a credit note stored with ${shape} issues a Factur-X with positive amounts that passes every schematron`, async () => {
      const { ctx, db, renders } = makeCtx()
      const inv = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer, counterparty: frBuyer, draft: draft() })
      const invRow = (db.__all("documents") as Array<Record<string, unknown>>).find((d) => d.id === inv.document_id)!
      await issueDocument(ctx, {
        type: "credit_note",
        operation_category: "goods",
        issuer,
        counterparty: frBuyer,
        draft: { ...draft(), due_at: null, lines: lines.map((l) => ({ ...l })) },
        original: {
          id: inv.document_id,
          regime: "e_invoice",
          counterparty_contact_id: frBuyer.contact_id,
          snapshot: readEinvoiceRowColumns(flatDocument(invRow)),
        },
        original_invoice_number: String(invRow.number),
        original_invoice_date: "2026-11-03",
      })
      const cn = (db.__all("documents") as Array<Record<string, unknown>>).find((d) => d.type === "credit_note")!
      expect(cn.pdf_status).toBe("ready")
      const xml = Buffer.from(renders.at(-1)!.attachments![0]!.bytesBase64, "base64").toString("utf8")
      expect(xml).toContain("<ram:TypeCode>381</ram:TypeCode>")
      expect(xml).not.toMatch(/<ram:(ChargeAmount|GrandTotalAmount|DuePayableAmount|TaxBasisTotalAmount)>-/)
      const v = validateFacturxXml(xml)
      expect(v.xsd.errors).toEqual([])
      expect(v.blocking.map((b) => `${b.schematron}:${b.id}`)).toEqual([])
    }, 240_000)
  }

  test("an e_reporting invoice gets a PDF/A legal original without a Factur-X", async () => {
    const { ctx, db, renders } = makeCtx()
    await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer, counterparty: deBuyer, draft: draft() })
    expect(renders[0]?.pdfa).toBe("3b")
    expect(renders[0]?.attachments).toBeUndefined()
    expect(legalRows(db)[0]).toMatchObject({ kind: "issued_pdf" })
    expect(db.__all("facturx_files")).toHaveLength(0)
  })

  test("a quote has no legal original (plain render under the pdf parent)", async () => {
    const { ctx, db, renders } = makeCtx()
    await issueDocument(ctx, { type: "quote", operation_category: "goods", issuer, counterparty: deBuyer, draft: draft(), initial_status: "sent" })
    expect(renders[0]?.parent).toBeUndefined()
    expect(renders[0]?.pdfa).toBeUndefined()
    expect(legalRows(db)).toHaveLength(0)
  })

  test("a Factur-X that cannot be built leaves facturx_failed, raises attention, records nothing; the retry fixes it", async () => {
    const { ctx, db, renders, events } = makeCtx()
    const noSiren = { ...issuer, siren: null }
    const r = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer: noSiren, counterparty: frBuyer, draft: draft() })
    expect(r.pdf_file_id).toBeNull()
    expect(renders).toHaveLength(0)
    const doc = (db.__all("documents") as Array<Record<string, unknown>>)[0]!
    expect(doc.pdf_status).toBe("facturx_failed")
    expect(legalRows(db)).toHaveLength(0)
    expect(events.find((e) => e.action === "facturx_failed")?.data).toMatchObject({ code: "facturx_seller_incomplete", resolved: false })
    // The administrator completes the issuer profile; the retry builds the Factur-X.
    await db.insert("issuer_profiles", { ...issuer, id: "issuer-1" })
    const retried = await ensureDocumentPdf(ctx, String(doc.id), { force: true })
    expect(retried.ok).toBe(true)
    expect(legalRows(db)).toHaveLength(1)
    expect(legalRows(db)[0]?.kind).toBe("facturx")
    // The retry (an already committed document) lets the host commit the row with the file.
    expect(renders[0]?.parent?.commitRow).toBeDefined()
    expect(events.filter((e) => e.action === "facturx_failed").map((e) => (e.data as { resolved: boolean }).resolved)).toEqual([false, true])
  })

  test("a committed legal original whose call rolled back: the next render re-creates the XML copy and the pointers, never re-renders", async () => {
    const { ctx, db, renders, imports } = makeCtx()
    const noSiren = { ...issuer, siren: null }
    const r = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer: noSiren, counterparty: frBuyer, draft: draft() })
    await db.insert("issuer_profiles", { ...issuer, id: "issuer-1" })
    expect((await ensureDocumentPdf(ctx, r.document_id, { force: true })).ok).toBe(true)
    expect(renders[0]?.parent?.commitRow).toBeDefined()
    const committed = legalRows(db)[0]!
    // The host kept the legal original; everything the handler wrote in the same call is gone.
    for (const x of db.__all("facturx_files") as Array<Record<string, unknown>>) await db.delete("facturx_files", String(x.id))
    await db.update("documents", r.document_id, { legal_original_id: null, legal_original_sha256: null, pdf_file_id: null, pdf_status: "facturx_failed" })
    const again = await ensureDocumentPdf(ctx, r.document_id, { force: true })
    expect(again).toMatchObject({ ok: true, pdf_file_id: committed.file_id })
    expect(renders).toHaveLength(1)
    const xmlRows = db.__all("facturx_files") as Array<Record<string, unknown>>
    expect(xmlRows).toHaveLength(1)
    expect(xmlRows[0]).toMatchObject({ document_id: r.document_id, file_id: `xml-file-${imports.length}` })
    // The re-created copy is the XML embedded in the legal original, byte for byte.
    expect(imports.at(-1)!.bytesBase64).toBe(renders[0]!.attachments![0]!.bytesBase64)
    const doc = (db.__all("documents") as Array<Record<string, unknown>>).find((d) => d.id === r.document_id)!
    expect(doc).toMatchObject({ legal_original_id: committed.id, legal_original_sha256: committed.sha256, pdf_file_id: committed.file_id, pdf_status: "ready" })
    // A complete copy is never duplicated.
    await db.update("documents", r.document_id, { legal_original_id: null })
    await ensureDocumentPdf(ctx, r.document_id, { force: true })
    expect(db.__all("facturx_files")).toHaveLength(1)
  })

  test("BT-23 is the payment state AT ISSUE: a Factur-X first rendered after a mark-paid still says due", async () => {
    const { ctx, db, renders } = makeCtx()
    const noSiren = { ...issuer, siren: null }
    const r = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer: noSiren, counterparty: frBuyer, draft: draft() })
    const issued = (db.__all("documents") as Array<Record<string, unknown>>).find((d) => d.id === r.document_id)!
    expect(flatDocument(issued).payment_state).toBe("due")
    // Paid later, while the Factur-X is still parked; then the issuer is fixed and it renders.
    await db.update("documents", r.document_id, { payment_status: "paid", paid_at: "2026-11-20T10:00:00.000Z" })
    await db.insert("issuer_profiles", { ...issuer, id: "issuer-1" })
    expect((await ensureDocumentPdf(ctx, r.document_id, { force: true })).ok).toBe(true)
    const xml = Buffer.from(renders.at(-1)!.attachments![0]!.bytesBase64, "base64").toString("utf8")
    expect(xml).toContain("<ram:ID>B1</ram:ID>")
    expect(xml).toMatch(/<ram:TotalPrepaidAmount>0\.00<\/ram:TotalPrepaidAmount>/)
    expect(xml).not.toContain("20261120")
  })

  test("a render failure is a plain failed render (not facturx_failed); the retry fills the same row", async () => {
    const { ctx, db, setFailRender } = makeCtx()
    setFailRender(true)
    const r = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer, counterparty: frBuyer, draft: draft() })
    const doc = (db.__all("documents") as Array<Record<string, unknown>>)[0]!
    expect(doc.pdf_status).toBe("failed")
    expect(legalRows(db)).toHaveLength(1)
    expect(legalRows(db)[0]?.sha256).toBeNull()
    setFailRender(false)
    await db.insert("issuer_profiles", { ...issuer, id: "issuer-1" })
    const retried = await ensureDocumentPdf(ctx, r.document_id, { force: true })
    expect(retried.ok).toBe(true)
    expect(legalRows(db)).toHaveLength(1)
    expect(legalRows(db)[0]?.sha256).not.toBeNull()
  })

  test("a later re-render is a management copy: the legal original and its row never change", async () => {
    const { ctx, db, renders } = makeCtx()
    const r = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer, counterparty: frBuyer, draft: draft() })
    await db.insert("issuer_profiles", { ...issuer, id: "issuer-1" })
    const before = JSON.stringify(legalRows(db))
    const again = await ensureDocumentPdf(ctx, r.document_id, { force: true })
    expect(again.ok).toBe(true)
    expect(renders).toHaveLength(2)
    expect(renders[1]?.parent).toBeUndefined()
    expect(JSON.stringify(legalRows(db))).toBe(before)
    const doc = (db.__all("documents") as Array<Record<string, unknown>>)[0]!
    expect(doc.legal_original_id).toBe(legalRows(db)[0]!.id)
    expect(doc.pdf_file_id).toBe("file-2")
  })

  test("preview and download serve the legal original after a management re-render, and name both files", async () => {
    const { ctx, db } = makeCtx()
    const r = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer, counterparty: frBuyer, draft: draft() })
    await db.insert("issuer_profiles", { ...issuer, id: "issuer-1" })
    // A mark-paid / edit re-render repoints pdf_file_id to a management copy.
    await ensureDocumentPdf(ctx, r.document_id, { force: true })
    const doc = (db.__all("documents") as Array<Record<string, unknown>>)[0]!
    expect(doc.pdf_file_id).toBe("file-2")
    const reads = { db } as unknown as ReadsCtx
    for (const ref of [await documentsDownloadPdf(reads, { id: r.document_id }), await documentsPreviewPdf(reads, { id: r.document_id })]) {
      expect(ref).toEqual({
        file_id: "file-1",
        url: "/api/files/file-1/inline",
        legal_original: true,
        management_copy: { file_id: "file-2", url: "/api/files/file-2/inline" },
        facturx_xml_file_id: "xml-file-1",
        // The same files as rows, for a dashboard block.
        rows: [
          { kind: "legal_original", file_id: "file-1", url: "/api/files/file-1/inline" },
          { kind: "management_copy", file_id: "file-2", url: "/api/files/file-2/inline" },
          { kind: "facturx_xml", file_id: "xml-file-1", url: null },
        ],
      })
    }
  })

  test("documents_update: once the legal original exists, every CII-visible field is locked", async () => {
    const { ctx, db } = makeCtx()
    const r = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer, counterparty: frBuyer, draft: draft() })
    await db.insert("issuer_profiles", { ...issuer, id: "issuer-1" })
    const m = ctx as unknown as MutationsCtx
    for (const patch of [
      { due_at: "2027-01-31" },
      { issued_at: "2026-11-04" },
      { counterparty_country: "BE" },
      { counterparty_address: "99 rue Ailleurs, 69003 Lyon" },
      { counterparty_shipping_address: "9 quai des Livraisons, 13002 Marseille" },
      { counterparty_shipping_name: "Entrepôt Client" },
    ]) {
      const res = await documentsUpdate(m, { id: r.document_id, ...patch })
      expect(res.status).toBe("error")
      if (res.status === "error") expect(res.error.code).toBe("legal_original_locked")
    }
    // Re-sending the same value is not a change.
    expect((await documentsUpdate(m, { id: r.document_id, issued_at: "2026-11-03" })).status).toBe("completed")
    // Non-CII fields stay editable; the edit re-renders a management copy, the legal original stays.
    const before = JSON.stringify(legalRows(db))
    const ok = await documentsUpdate(m, { id: r.document_id, notes: "Merci", counterparty_email: "ap@client.example", po_number: "PO-NEW" })
    expect(ok.status).toBe("completed")
    expect(JSON.stringify(legalRows(db))).toBe(before)
  })

  test("documents_update: an issued document without a legal original keeps its amendable fields", async () => {
    const { ctx, db } = makeCtx()
    const r = await issueDocument(ctx, { type: "invoice", operation_category: "goods", issuer, counterparty: frBuyer, draft: draft() })
    await db.update("documents", r.document_id, { legal_original_id: null })
    await db.insert("issuer_profiles", { ...issuer, id: "issuer-1" })
    const res = await documentsUpdate(ctx as unknown as MutationsCtx, { id: r.document_id, due_at: "2027-01-31" })
    expect(res.status).toBe("completed")
  })
})
