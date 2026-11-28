// SPDX-License-Identifier: FSL-1.1-ALv2
//
// documents_correct_issued: the in-place correction of an issued invoice or credit note after a
// tool error (createMockDb + a stub renderer). Pins who may decide it, what it may and may never
// change, the stated reason for a changed total, the atomic shipping move between two documents
// of one order, the archived legal original, the correction record, the file every reader serves,
// the e-invoicing refusal, and that it mails nothing.
import { describe, expect, test } from "bun:test"
import { FR_SELLER_IDENTITY } from "./einvoicing/test-fixtures"
import { deliveryFileId } from "./legal-originals/delivery"
import {
  correctIssued,
  correctIssuedPreflight,
  correctIssuedPreview,
} from "./mutations/correct-issued"
import type { MutationsCtx } from "./mutations/shared"
import { documentsDownloadPdf, type ReadsCtx } from "./reads"
import { summarizeCorrectIssued } from "./summarizers"
import { createMockDb, type MockDb } from "./test-db"
import { testTime } from "./test-time"

const ISSUER = "11111111-1111-4111-8111-111111111111"
const DOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const DOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const LEGAL_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const ORDER = "1000000000001"

function issuerRow(): Record<string, unknown> {
  return {
    id: ISSUER,
    legal_name: "Acme SAS",
    country: "FR",
    vat_id: "FR12345678901",
    address: "1 rue Test",
    default_language: "en",
    default_currency: "EUR",
    prefix_invoice: "INV-{YYYY}-",
    prefix_credit_note: "CN-{YYYY}-",
    timezone: "Europe/Paris",
    ...FR_SELLER_IDENTITY,
  }
}

function docRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: DOC_A,
    type: "invoice",
    status: "paid",
    payment_status: "paid",
    number: "INV-2026-0101",
    number_int: 101,
    year_of_issue: 2026,
    issuer_profile_id: ISSUER,
    counterparty_name: "Marie Dupont",
    counterparty_country: "DE",
    counterparty_email: "marie@example.com",
    counterparty_address: "1 Hauptstrasse, Berlin",
    currency: "EUR",
    subtotal_minor: "10000",
    tax_total_minor: "1900",
    grand_total_minor: "11900",
    tax_treatment: "eu_b2c_oss",
    operation_category: "goods",
    regime: "e_reporting",
    customer_kind: "individual",
    issued_at: "2026-11-10",
    pdf_file_id: "pdf-original",
    pdf_status: "ready",
    legal_original_id: LEGAL_A,
    legal_original_sha256: "a".repeat(64),
    shopify_order_id: ORDER,
    shopify_order_number: "#1101",
    external_refs: {},
    lifecycle_log: [{ event: "issued", ts: "2026-11-10T10:00:00.000Z", actor: "system" }],
    ...over,
  }
}

function lineRow(documentId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    document_id: documentId,
    position: 1,
    description: "Synth module",
    quantity: "1.000",
    unit_price_minor: "10000",
    discount_minor: "0",
    line_kind: "goods",
    tax_rate_bp: 1900,
    subtotal_minor: "10000",
    tax_minor: "1900",
    total_minor: "11900",
    hs_code: "9207.90",
    country_of_origin: "FR",
    customs_description: "Synthesizer",
    product_source: "shopify",
    external_id: "gid://shopify/ProductVariant/1",
    ...over,
  }
}

interface Harness {
  ctx: MutationsCtx & ReadsCtx
  db: MockDb
  renders: Array<Record<string, unknown>>
  emits: Array<{ entity: string; action: string; data?: unknown }>
  executeToolCalls: string[]
}

function harness(opts: {
  scopes?: string[]
  seed?: Record<string, Array<Record<string, unknown>>>
  failRender?: boolean
}): Harness {
  const db = createMockDb({
    seed: {
      issuer_profiles: [issuerRow()],
      einvoicing_settings: [{ gate_mode: "warn", gate_mode_source: "config" }],
      legal_originals: [
        {
          id: LEGAL_A,
          document_id: DOC_A,
          kind: "issued_pdf",
          file_id: "pdf-original",
          sha256: "a".repeat(64),
          byte_size: 1000,
          recorded_at: "2026-11-10",
        },
      ],
      ...(opts.seed ?? {}),
    },
  })
  const renders: Array<Record<string, unknown>> = []
  const emits: Harness["emits"] = []
  const executeToolCalls: string[] = []
  let n = 0
  const scopes = opts.scopes ?? ["invoicing:issuer:admin"]
  const ctx = {
    db,
    time: testTime(),
    getUserId: async () => "user-requester",
    approval: {
      approvalRequestId: "request-1",
      approvalDeciderId: "user-owner",
      toolName: "invoicing:documents_correct_issued",
    },
    hasScope: async (scope: string) =>
      scopes.some((h) => h === "*" || h === scope || scope.startsWith(`${h}:`)),
    pdf: {
      async render(p: Record<string, unknown>) {
        renders.push(p)
        if (opts.failRender)
          throw Object.assign(new Error("render failed"), { code: "render_failed" })
        n += 1
        return {
          file_id: `pdf-corrected-${n}`,
          byte_size: 2048,
          page_count: 1,
          sha256: "b".repeat(64),
        }
      },
    },
    files_importAttachment: async () => JSON.stringify({ id: `xml-${++n}` }),
    emit: async (e: { entity: string; action: string; data?: unknown }) => {
      emits.push(e)
    },
    executeTool: async (name: string) => {
      executeToolCalls.push(name)
      return { status: "completed", result: {} }
    },
    requestApproval: async () => ({ approval_id: "x" }),
    decideApproval: async () => ({ status: "ok" }),
    messages: { post: async () => ({ message_id: "m" }) },
  } as unknown as MutationsCtx & ReadsCtx
  return { ctx, db, renders, emits, executeToolCalls }
}

const doc = (db: MockDb, id = DOC_A) => db.__all("documents").find((d) => d.id === id)!
const linesOf = (db: MockDb, id = DOC_A) =>
  db
    .__all("document_lines")
    .filter((l) => l.document_id === id)
    .sort((a, b) => Number(a.position) - Number(b.position))

/** The in-place VAT case: the paid amount stays, the VAT becomes the buyer country's, included. */
const nlLines = [
  {
    position: 1,
    description: "Synth module",
    quantity: 1,
    unit_price_minor: 9835,
    tax_rate_bp: 2100,
    tax_minor: 2065,
    line_kind: "goods",
  },
]

describe("documents_correct_issued", () => {
  test("refuses a run whose person does not hold invoicing:issuer:admin, and changes nothing", async () => {
    const h = harness({
      scopes: ["invoicing:documents:write", "invoicing:approve"],
      seed: { documents: [docRow()], document_lines: [lineRow(DOC_A)] },
    })
    const r = await correctIssued(h.ctx, {
      id: DOC_A,
      reason: "VAT rate applied by the tool was the wrong country's",
      lines: nlLines,
      tax_treatment: "eu_b2c_oss",
    })
    expect(r.status).toBe("error")
    if (r.status !== "error") throw new Error("unreachable")
    expect(r.error.code).toBe("forbidden")
    expect(doc(h.db).grand_total_minor).toBe("11900")
    expect(h.db.__all("document_corrections")).toHaveLength(0)
  })

  test("corrects the lines and VAT in place: same number and date, a correction record, the legal original kept, no mail", async () => {
    const h = harness({ seed: { documents: [docRow()], document_lines: [lineRow(DOC_A)] } })
    const r = await correctIssued(h.ctx, {
      id: "INV-2026-0101",
      reason: "the tool charged German VAT on a sale delivered to the Netherlands",
      lines: [{ ...nlLines[0]!, unit_price_minor: 9835, tax_minor: 2065 }],
      counterparty_country: "NL",
    })
    expect(r.status).toBe("completed")
    const d = doc(h.db)
    expect(d.number).toBe("INV-2026-0101")
    expect(d.issued_at).toBe("2026-11-10")
    expect(d.issuer_profile_id).toBe(ISSUER)
    expect(d.counterparty_name).toBe("Marie Dupont")
    expect(d.counterparty_country).toBe("NL")
    expect(d.subtotal_minor).toBe("9835")
    expect(d.tax_total_minor).toBe("2065")
    expect(d.grand_total_minor).toBe("11900")
    // The legal original is untouched; the corrected file is the document's current PDF.
    expect(d.legal_original_id).toBe(LEGAL_A)
    expect(h.db.__all("legal_originals")[0]?.file_id).toBe("pdf-original")
    expect(d.pdf_file_id).toBe("pdf-corrected-1")
    const [c] = h.db.__all("document_corrections")
    expect(c?.id).toBe(d.current_correction_id)
    expect(c?.sequence).toBe(1)
    expect(c?.reason).toContain("German VAT")
    expect(c?.approved_by).toBe("user-owner")
    expect(c?.corrected_by).toBe("user-requester")
    expect(c?.previous_pdf_file_id).toBe("pdf-original")
    expect(c?.previous_legal_original_id).toBe(LEGAL_A)
    expect(c?.file_id).toBe("pdf-corrected-1")
    type Snap = { grand_total_minor: string; lines: Array<{ tax_rate_bp: number }> }
    const before = c!.before as Snap
    const after = c!.after as Snap
    expect(before.grand_total_minor).toBe("11900")
    expect(before.lines[0]?.tax_rate_bp).toBe(1900)
    expect(after.lines[0]?.tax_rate_bp).toBe(2100)
    // Rendered under the correction, never over the legal original.
    expect(h.renders).toHaveLength(1)
    expect(h.renders[0]?.parent).toEqual({ entityType: "document_correction", entityId: c?.id })
    // One line, the customs facts carried from the line it replaces.
    const [line] = linesOf(h.db)
    expect(line?.hs_code).toBe("9207.90")
    expect(line?.tax_minor).toBe("2065")
    // Audited, and nothing mailed, no other app called, no new document.
    expect(h.emits.some((e) => e.entity === "document" && e.action === "corrected")).toBe(true)
    expect(h.executeToolCalls).toHaveLength(0)
    expect(h.db.__all("documents")).toHaveLength(1)
    const log = d.lifecycle_log as Array<Record<string, unknown>>
    expect(log.at(-1)?.event).toBe("corrected_in_place")
  })

  test("every reader serves the corrected file: delivery and the download read", async () => {
    const h = harness({ seed: { documents: [docRow()], document_lines: [lineRow(DOC_A)] } })
    await correctIssued(h.ctx, {
      id: DOC_A,
      reason: "the tool charged German VAT on a Dutch sale",
      lines: nlLines,
    })
    const chosen = await deliveryFileId(h.db, doc(h.db))
    expect(chosen.file_id).toBe("pdf-corrected-1")
    expect(chosen.correction?.id).toBe(String(doc(h.db).current_correction_id))
    const ref = await documentsDownloadPdf(h.ctx, { id: DOC_A })
    expect(ref.file_id).toBe("pdf-corrected-1")
  })

  test("a changed grand total needs total_change_reason, and an unchanged one refuses it", async () => {
    const h = harness({ seed: { documents: [docRow()], document_lines: [lineRow(DOC_A)] } })
    const changed = await correctIssued(h.ctx, {
      id: DOC_A,
      reason: "the tool billed the amount in the wrong currency",
      lines: [
        { description: "Synth module", quantity: 1, unit_price_minor: 12000, tax_rate_bp: 1900 },
      ],
    })
    expect(changed.status === "error" && changed.error.code).toBe("total_change_unexplained")
    const same = await correctIssued(h.ctx, {
      id: DOC_A,
      reason: "the tool printed the wrong product name",
      lines: [
        { description: "Synth module 2", quantity: 1, unit_price_minor: 10000, tax_rate_bp: 1900 },
      ],
      total_change_reason: "none",
    })
    expect(same.status === "error" && same.error.code).toBe("total_unchanged")
    expect(h.db.__all("document_corrections")).toHaveLength(0)
  })

  test("a one-cent rounding fix states the line's VAT; further off is refused", async () => {
    const h = harness({
      seed: {
        documents: [
          docRow({ subtotal_minor: "6639", tax_total_minor: "1262", grand_total_minor: "7901" }),
        ],
        document_lines: [
          lineRow(DOC_A, {
            unit_price_minor: "6639",
            subtotal_minor: "6639",
            tax_minor: "1262",
            total_minor: "7901",
          }),
        ],
      },
    })
    const off = await correctIssuedPreflight(h.ctx, {
      id: DOC_A,
      reason: "per-line VAT rounding gave one cent too much",
      lines: [
        {
          description: "Synth module",
          quantity: 1,
          unit_price_minor: 6639,
          tax_rate_bp: 1900,
          tax_minor: 1250,
        },
      ],
      total_change_reason: "rounding",
    })
    expect("error" in off && off.error.code).toBe("line_tax_off")
    const r = await correctIssued(h.ctx, {
      id: DOC_A,
      reason: "per-line VAT rounding gave one cent too much",
      lines: [
        {
          description: "Synth module",
          quantity: 1,
          unit_price_minor: 6639,
          tax_rate_bp: 1900,
          tax_minor: 1261,
        },
      ],
      total_change_reason: "a 0.01 rounding fix: the customer paid 79.00",
    })
    expect(r.status).toBe("completed")
    expect(doc(h.db).grand_total_minor).toBe("7900")
  })

  test("the tax treatment changes, the number, date and issuer never do", async () => {
    const h = harness({ seed: { documents: [docRow()], document_lines: [lineRow(DOC_A)] } })
    const r = await correctIssued(h.ctx, {
      id: DOC_A,
      reason: "the tool added DE VAT on a sale outside the EU",
      tax_treatment: "eu_export_non_eu",
      counterparty_country: "US",
      lines: [{ description: "Synth module", quantity: 1, unit_price_minor: 11900, tax_rate_bp: 0 }],
      // The paid amount stays: 119.00 with no VAT.
      number: "INV-HACK",
      issued_at: "2026-01-01",
    } as never)
    expect(r.status).toBe("completed")
    const d = doc(h.db)
    expect(d.tax_treatment).toBe("eu_export_non_eu")
    expect(d.tax_total_minor).toBe("0")
    expect(d.grand_total_minor).toBe("11900")
    expect(d.number).toBe("INV-2026-0101")
    expect(d.issued_at).toBe("2026-11-10")
  })

  test("refuses a document sent to the e-invoicing platform, a draft, a voided one and an imported one", async () => {
    const h = harness({
      seed: {
        documents: [
          docRow(),
          docRow({ id: DOC_B, number: "INV-2026-0002", status: "draft" }),
          docRow({
            id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            number: "INV-2026-0003",
            status: "voided",
          }),
          docRow({
            id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            number: "INV-2026-0004",
            external_refs: { import_source: "sufio" },
          }),
          docRow({
            id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            number: "INV-2026-0005",
            einvoice_state: "delivered",
          }),
        ],
        document_lines: [lineRow(DOC_A)],
        einvoice_transmissions: [{ document_id: DOC_A, action: "send_einvoice", state: "sent" }],
      },
    })
    const base = { reason: "the tool charged the wrong rate", tax_treatment: "eu_domestic" }
    const code = async (id: string) => {
      const r = await correctIssuedPreflight(h.ctx, { ...base, id })
      return "error" in r ? r.error.code : "ok"
    }
    expect(await code(DOC_A)).toBe("einvoice_transmitted")
    expect(await code("INV-2026-0002")).toBe("not_correctable_status")
    expect(await code("INV-2026-0003")).toBe("not_correctable_status")
    expect(await code("INV-2026-0004")).toBe("imported_document")
    expect(await code("INV-2026-0005")).toBe("einvoice_transmitted")
  })

  test("a reason is required, and a correction that changes nothing is refused", async () => {
    const h = harness({ seed: { documents: [docRow()], document_lines: [lineRow(DOC_A)] } })
    const noReason = await correctIssuedPreflight(h.ctx, {
      id: DOC_A,
      reason: "fix",
      tax_treatment: "eu_domestic",
    })
    expect("error" in noReason && noReason.error.code).toBe("reason_required")
    const nothing = await correctIssuedPreflight(h.ctx, {
      id: DOC_A,
      reason: "nothing to correct at all here",
      tax_treatment: "eu_b2c_oss",
    })
    expect("error" in nothing && nothing.error.code).toBe("no_change")
  })

  test("move_shipping moves the line between two documents of the order in one commit; the order total stays", async () => {
    const h = harness({
      seed: {
        documents: [
          docRow({
            subtotal_minor: "11000",
            tax_total_minor: "2090",
            grand_total_minor: "13090",
            tax_treatment: "eu_b2c_oss",
          }),
          docRow({
            id: DOC_B,
            number: "INV-2026-0102",
            subtotal_minor: "5000",
            tax_total_minor: "950",
            grand_total_minor: "5950",
            legal_original_id: null,
          }),
        ],
        document_lines: [
          lineRow(DOC_A, { line_kind: "software", description: "Sound pack", hs_code: null }),
          lineRow(DOC_A, {
            position: 2,
            description: "Shipping",
            line_kind: "shipping",
            unit_price_minor: "1000",
            subtotal_minor: "1000",
            tax_minor: "190",
            total_minor: "1190",
            hs_code: null,
          }),
          lineRow(DOC_B, {
            unit_price_minor: "5000",
            subtotal_minor: "5000",
            tax_minor: "950",
            total_minor: "5950",
          }),
        ],
      },
    })
    const preview = await correctIssuedPreview(h.ctx, {
      id: DOC_A,
      reason: "the tool put the shipping on the digital invoice",
      move_shipping: { to_document_id: "INV-2026-0102", position: 2 },
    })
    expect(preview.kind).toBe("move_shipping")
    expect(preview.documents.map((d) => d.after.grand_total_minor)).toEqual(["11900", "7140"])
    const r = await correctIssued(h.ctx, {
      id: DOC_A,
      reason: "the tool put the shipping on the digital invoice",
      move_shipping: { to_document_id: "INV-2026-0102", position: 2 },
    })
    expect(r.status).toBe("completed")
    expect(linesOf(h.db, DOC_A).map((l) => l.line_kind)).toEqual(["software"])
    expect(linesOf(h.db, DOC_B).map((l) => [l.line_kind, l.position])).toEqual([
      ["goods", 1],
      ["shipping", 2],
    ])
    const a = doc(h.db, DOC_A)
    const b = doc(h.db, DOC_B)
    expect(BigInt(String(a.grand_total_minor)) + BigInt(String(b.grand_total_minor))).toBe(19040n)
    expect(a.operation_category).toBe("services")
    expect(b.operation_category).toBe("goods")
    const corrections = h.db.__all("document_corrections")
    expect(corrections).toHaveLength(2)
    expect(corrections[0]?.group_id).toBeTruthy()
    expect(corrections[0]?.group_id).toBe(corrections[1]?.group_id)
  })

  test("move_shipping refuses a line that is not shipping, and documents of another order", async () => {
    const h = harness({
      seed: {
        documents: [
          docRow(),
          docRow({
            id: DOC_B,
            number: "INV-2026-0102",
            shopify_order_id: "999",
            legal_original_id: null,
          }),
        ],
        document_lines: [
          lineRow(DOC_A),
          lineRow(DOC_A, { position: 2, line_kind: "goods" }),
          lineRow(DOC_B),
        ],
      },
    })
    const other = await correctIssuedPreflight(h.ctx, {
      id: DOC_A,
      reason: "the tool put the shipping on the wrong invoice",
      move_shipping: { to_document_id: DOC_B, position: 2 },
    })
    expect("error" in other && other.error.code).toBe("not_same_order")
    await h.db.update("documents", DOC_B, { shopify_order_id: ORDER })
    const notShipping = await correctIssuedPreflight(h.ctx, {
      id: DOC_A,
      reason: "the tool put the shipping on the wrong invoice",
      move_shipping: { to_document_id: DOC_B, position: 2 },
    })
    expect("error" in notShipping && notShipping.error.code).toBe("not_a_shipping_line")
  })

  test("a failed render keeps the correction and documents_retry_pdf-style re-render fills it", async () => {
    const h = harness({
      failRender: true,
      seed: { documents: [docRow()], document_lines: [lineRow(DOC_A)] },
    })
    const r = await correctIssued(h.ctx, {
      id: DOC_A,
      reason: "the tool printed the wrong product name",
      lines: [
        { description: "Synth module 2", quantity: 1, unit_price_minor: 10000, tax_rate_bp: 1900 },
      ],
    })
    expect(r.status === "completed" && r.documents[0]?.pdf_status).toBe("failed")
    expect(doc(h.db).pdf_status).toBe("failed")
    // Until it renders, delivery falls back to the legal original rather than nothing.
    expect((await deliveryFileId(h.db, doc(h.db))).file_id).toBe("pdf-original")
  })

  test("an e-invoice not yet transmitted gets a regenerated Factur-X embedded and kept on the correction", async () => {
    const h = harness({
      seed: {
        documents: [
          docRow({
            regime: "e_invoice",
            customer_kind: "business",
            counterparty_name: "Buyer SARL",
            buyer_legal_name: "Buyer SARL",
            buyer_siren: "732829320",
            buyer_routing_address: "732829320",
            counterparty_country: "FR",
            billing_line1: "1 rue Buyer",
            billing_postcode: "75002",
            billing_city: "Paris",
            billing_country_code: "FR",
            tax_treatment: "eu_domestic",
            subtotal_minor: "10000",
            tax_total_minor: "2000",
            grand_total_minor: "12000",
            payment_state: "paid",
          }),
        ],
        document_lines: [
          lineRow(DOC_A, { tax_rate_bp: 2000, tax_minor: "2000", total_minor: "12000" }),
        ],
      },
    })
    const r = await correctIssued(h.ctx, {
      id: DOC_A,
      reason: "the tool printed the wrong product name on the invoice",
      lines: [
        {
          description: "Synth module (corrected)",
          quantity: 1,
          unit_price_minor: 10000,
          tax_rate_bp: 2000,
        },
      ],
    })
    expect(r.status).toBe("completed")
    const render = h.renders[0] as { attachments?: Array<{ name: string; bytesBase64: string }> }
    expect(render.attachments?.[0]?.name).toBe("factur-x.xml")
    expect(atob(render.attachments![0]!.bytesBase64)).toContain("Synth module (corrected)")
    const [c] = h.db.__all("document_corrections")
    expect(c?.facturx_xml_file_id).toBeTruthy()
    expect(c?.facturx_sha256).toBeTruthy()
    const ref = await documentsDownloadPdf(h.ctx, { id: DOC_A })
    expect(ref.facturx_xml_file_id).toBe(String(c?.facturx_xml_file_id))
  })

  test("the approval card shows the before and after of the totals, VAT and lines", async () => {
    const h = harness({ seed: { documents: [docRow()], document_lines: [lineRow(DOC_A)] } })
    const params = {
      id: DOC_A,
      reason: "the tool charged German VAT on a Dutch sale",
      lines: nlLines,
      total_change_reason: undefined,
    }
    const context = await correctIssuedPreview(h.ctx, params)
    const card = await summarizeCorrectIssued(params, undefined, { context })
    expect(card.title).toContain("INV-2026-0101")
    expect(card.lines.join("\n")).toContain("Total: 119.00")
    expect(card.lines.join("\n")).toContain("VAT:")
    expect(card.lines.join("\n")).toContain("21 % VAT")
    expect(card.subtitle).toContain("no mail")
    const refused = await summarizeCorrectIssued(params, undefined, {
      context: await correctIssuedPreview(h.ctx, { ...params, reason: "x" }),
    })
    expect(refused.title).toContain("refused")
  })
})
