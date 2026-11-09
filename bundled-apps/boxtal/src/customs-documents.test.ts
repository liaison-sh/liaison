// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The order's papers (customs-documents.ts): the order print record before and after the label,
// generation by the document rules when the order enters To prepare, nothing reprinted while the
// record is unchanged, a reprint once the tracking number exists, the papers on the worklist row
// and in the print pack. Synthetic data only.
import { describe, expect, it } from "bun:test"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import {
  composeOrderRecord,
  dateText,
  generateOrderDocuments,
  moneyText,
  ORDER_RECORD_TYPE,
  orderDocumentsByRef,
  orderPrintRecordGet,
  type OrderDraftView,
  readOrderDocuments,
  recordFingerprint,
} from "./customs-documents"
import { buildPrintSnapshot } from "./print-record"
import { createMockDb } from "./test-db"

const REF = "11111111-1111-4111-8111-111111111111"
const TEMPLATE = { id: "22222222-2222-4222-8222-222222222222", name: "Metal declaration" }

const DRAFT: OrderDraftView = {
  document_number: "INV-T-0001",
  invoice_issued_at: "2026-11-01",
  order_name: "#5001",
  lineSummaries: [
    {
      line_id: "l1",
      external_id: "SKU-WIDGET",
      description: "Widget",
      line_kind: "goods",
      quantity: 2,
      unit_price_minor: 12345,
      currency: "USD",
      hs_code: "0000.00.0000",
      country_of_origin: "FR",
    },
    { line_id: "l2", external_id: null, description: "Shipping", line_kind: "shipping", quantity: 1, unit_price_minor: 900, currency: "USD" },
  ],
  customsArticles: [],
  recipient_address: {
    name: "Test Person",
    company: "Test Store",
    email: "buyer@example.com",
    phone: null,
    street: "1 Test Street",
    city: "Testville",
    postalCode: "00001",
    state: "TX",
    countryIsoCode: "US",
  },
  recipient_country: "US",
}

interface Harness {
  ctx: BoxtalToolCtx
  prints: Array<Record<string, unknown>>
  matches: Array<Record<string, unknown>>
}

const VARIANT = "gid://shopify/ProductVariant/111"

function harness(
  opts: {
    shipments?: Array<Record<string, unknown>>
    needs?: boolean
    /** Store variant id -> its SKU, as `shopify:variants_brief` answers; null = the call fails. */
    variants?: Record<string, string> | null
  } = {},
): Harness & { briefs: Array<Record<string, unknown>> } {
  const prints: Array<Record<string, unknown>> = []
  const matches: Array<Record<string, unknown>> = []
  const briefs: Array<Record<string, unknown>> = []
  let n = 0
  const executeTool = async (target: string, params: Record<string, unknown>): Promise<CrossAppEnvelope> => {
    if (target === "kernel:product_attributes_list") {
      const asked = new Set((params.skus as string[]) ?? [])
      return {
        status: "completed",
        result: {
          attributes: [
            { sku: "SKU-WIDGET", key: "metal", value: "aluminium" },
            { sku: "SKU-A", key: "metal", value: "steel" },
          ].filter((a) => asked.has(a.sku)),
        },
      }
    }
    if (target === "shopify:variants_brief") {
      briefs.push(params)
      if (opts.variants === null) return { status: "error", error: { code: "unavailable", message: "store down" } }
      const known = opts.variants ?? {}
      return {
        status: "completed",
        result: { variants: ((params.ids as string[]) ?? []).flatMap((id) => (known[id] ? [{ id, sku: known[id] }] : [])) },
      }
    }
    if (target === "invoicing:documents_get")
      return {
        status: "completed",
        result: { id: REF, number: "INV-T-0001", incoterm: "DAP", currency: "USD", counterparty_country: "US", status: "issued", external_refs: { po_number: "PO-T-1" } },
      }
    if (target === "kernel:document_rules_match") {
      matches.push(params)
      const records = (params.records as Array<{ id: string }>) ?? []
      return {
        status: "completed",
        result: {
          matches: opts.needs === false ? [] : records.map((r) => ({ recordId: r.id, rules: [{ id: "r1", name: "US" }], templates: [TEMPLATE] })),
        },
      }
    }
    if (target === "kernel:documents_print") {
      prints.push(params)
      n += 1
      return {
        status: "completed",
        result: {
          files: (params.templateIds as string[]).map((id) => ({
            templateId: id,
            templateName: TEMPLATE.name,
            fileId: `file-${n}`,
            filename: `${TEMPLATE.name} INV-T-0001.pdf`,
            blanks: [{ label: "Delivery phone" }],
          })),
        },
      }
    }
    if (target === "invoicing:documents_download_pdf") return { status: "completed", result: { file_id: "invoice-file" } }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  const ctx: BoxtalToolCtx = {
    orgId: "org_1",
    db: createMockDb({ seed: { shipment: opts.shipments ?? [], prep_state: [] } }),
    fetch: (async () => new Response("")) as unknown as BoxtalToolCtx["fetch"],
    connections: {},
    config: { get: async () => null, has: async () => false },
    executeTool: executeTool as BoxtalToolCtx["executeTool"],
  }
  return { ctx, prints, matches, briefs }
}

const readDraft = async () => DRAFT

describe("formatting", () => {
  it("writes dates and money the way paperwork reads", () => {
    expect(dateText("2026-11-09T10:00:00Z")).toBe("9 November 2026")
    expect(dateText(null)).toBeNull()
    expect(moneyText(1234.5, "USD")).toBe("USD 1,234.50")
    expect(moneyText(null, "USD")).toBeNull()
  })
})

describe("order print record", () => {
  it("before a label: the invoice, the delivery address and the goods lines, no carrier, no tracking", async () => {
    const { ctx } = harness()
    const rec = await orderPrintRecordGet(ctx, { document_ref: REF }, { today: "2026-11-09", readDraft })
    if ("error" in rec) throw new Error(rec.error.message)
    expect(rec.invoice).toEqual({ number: "INV-T-0001", date: "2026-11-01", date_text: "1 November 2026" })
    expect(rec.order.address_lines).toEqual(["Test Store", "1 Test Street", "Testville, TX 00001", "United States"])
    expect(rec.order.phone).toBeNull() // never invented
    expect(rec.order.po_number).toBe("PO-T-1")
    expect(rec.order.incoterm).toBe("DAP")
    expect(rec.shipment).toMatchObject({ has_label: false, carrier_name: null, tracking_number: null, reference: null })
    expect(rec.lines).toHaveLength(1) // goods only
    expect(rec.lines[0]).toMatchObject({
      sku: "SKU-WIDGET",
      unit_value_text: "USD 123.45",
      value_text: "USD 246.90",
      origin_name: "France",
      attributes: { metal: "aluminium" },
    })
    expect(rec.totals).toEqual({ value: 246.9, value_text: "USD 246.90", units: 2, articles: 1 })
    expect(rec.issued_on).toBe("9 November 2026")
    expect(rec.destination).toEqual({ iso2: "US", name: "United States" })
  })

  it("names countries without Intl (the app sandbox has none)", async () => {
    const original = Intl.DisplayNames
    ;(Intl as { DisplayNames: unknown }).DisplayNames = class {
      constructor() {
        throw new Error("no Intl in the sandbox")
      }
    }
    try {
      const { ctx } = harness()
      const rec = await orderPrintRecordGet(ctx, { document_ref: REF }, { today: "2026-11-09", readDraft })
      if ("error" in rec) throw new Error(rec.error.message)
      expect(rec.destination).toEqual({ iso2: "US", name: "United States" })
      expect(rec.lines[0]?.origin_name).toBe("France")
      expect(rec.order.address_lines.at(-1)).toBe("United States")
    } finally {
      ;(Intl as { DisplayNames: unknown }).DisplayNames = original
    }
  })

  it("a line keyed by a store variant id prints the variant's SKU and its product attributes", async () => {
    const h = harness({ variants: { [VARIANT]: "SKU-A" } })
    const draft = { ...DRAFT, lineSummaries: DRAFT.lineSummaries?.map((l) => (l.line_id === "l1" ? { ...l, external_id: VARIANT } : l)) }
    const rec = await orderPrintRecordGet(h.ctx, { document_ref: REF }, { today: "2026-11-09", readDraft: async () => draft })
    if ("error" in rec) throw new Error(rec.error.message)
    expect(h.briefs).toEqual([{ ids: [VARIANT] }]) // one call for every line
    expect(rec.lines[0]).toMatchObject({ sku: "SKU-A", attributes: { metal: "steel" } })

    // The rules match on the same SKU, so SKU and product-attribute rules find the order.
    const [r] = await generateOrderDocuments(h.ctx, [REF], { readDraft: async () => draft })
    expect(r?.error).toBeUndefined()
    expect((h.matches[0]?.records as Array<Record<string, unknown>>)[0]).toMatchObject({ skus: ["SKU-A"] })
  })

  it("a variant whose SKU cannot be read keeps its id and the record still reads", async () => {
    const h = harness({ variants: null })
    const draft = { ...DRAFT, lineSummaries: DRAFT.lineSummaries?.map((l) => (l.line_id === "l1" ? { ...l, external_id: VARIANT } : l)) }
    const rec = await orderPrintRecordGet(h.ctx, { document_ref: REF }, { today: "2026-11-09", readDraft: async () => draft })
    if ("error" in rec) throw new Error(rec.error.message)
    expect(rec.lines[0]).toMatchObject({ sku: VARIANT, attributes: {} })
  })

  it("the issue date does not make a record stale; a tracking number does", () => {
    const snapshot = buildPrintSnapshot(DRAFT, { offerCode: "FEDX-InternationalEconomy" })
    const base = { documentRef: REF, snapshot, invoice: null, attributes: new Map(), today: "2026-11-09" }
    const row = { id: "s1", offer_code: "FEDX-InternationalEconomy", created_at: "2026-11-10T08:00:00Z" }
    const a = composeOrderRecord({ ...base, shipment: { ...row, tracking_number: null } })
    const b = composeOrderRecord({ ...base, today: "2026-11-10", shipment: { ...row, tracking_number: null } })
    const c = composeOrderRecord({ ...base, shipment: { ...row, tracking_number: "TRK123" } })
    expect(recordFingerprint(a)).toBe(recordFingerprint(b))
    expect(recordFingerprint(a)).not.toBe(recordFingerprint(c))
    expect(c.shipment.reference).toBe("FedEx AWB TRK123")
    expect(c.shipment.shipped_on).toBe("10 November 2026")
  })
})

describe("generation", () => {
  it("prints the needed templates at To prepare, keeps them while nothing changes, reprints with the tracking number", async () => {
    const h = harness()
    // 1. To prepare: no label yet.
    const [first] = await generateOrderDocuments(h.ctx, [REF], { readDraft })
    expect(first).toMatchObject({ document_ref: REF, needed: [TEMPLATE.id], printed: [TEMPLATE.id] })
    expect(h.matches[0]).toMatchObject({ recordType: ORDER_RECORD_TYPE })
    expect((h.matches[0]?.records as Array<Record<string, unknown>>)[0]).toMatchObject({ id: REF, skus: ["SKU-WIDGET"], countryIso2: "US" })
    expect(h.prints[0]).toEqual({ app: "boxtal", entity: "order", recordId: REF, templateIds: [TEMPLATE.id] })
    let docs = (await orderDocumentsByRef(h.ctx, [REF])).get(REF) ?? []
    expect(docs.map((d) => [d.file_id, d.tracking_number, d.blanks])).toEqual([["file-1", null, ["Delivery phone"]]])

    // 2. Next pass, nothing changed: nothing reprinted.
    const [second] = await generateOrderDocuments(h.ctx, [REF], { readDraft, today: "2026-11-12" })
    expect(second).toMatchObject({ printed: [], unchanged: [TEMPLATE.id] })
    expect(h.prints).toHaveLength(1)

    // 3. The label is bought and the tracking number is known: printed again, the new file replaces the old.
    const snapshot = buildPrintSnapshot(DRAFT, {
      offerCode: "FEDX-InternationalEconomy",
      customer: { contact: { firstName: "Test", lastName: "Person" }, location: { countryIsoCode: "US", city: "Testville" } },
    })
    await h.ctx.db.insert("shipment", {
      id: "ship-1",
      document_ref: REF,
      offer_code: "FEDX-InternationalEconomy",
      tracking_number: "TRK123",
      order_status: "CONFIRMED",
      kind: "outbound",
      queue_facts: { print: snapshot },
      created_at: "2026-11-10T08:00:00Z",
    })
    const [third] = await generateOrderDocuments(h.ctx, [REF], { readDraft })
    expect(third?.printed).toEqual([TEMPLATE.id])
    expect((h.matches[2]?.records as Array<Record<string, unknown>>)[0]).toMatchObject({ carrier_family: "fedex" })
    docs = (await orderDocumentsByRef(h.ctx, [REF])).get(REF) ?? []
    expect(docs.map((d) => [d.file_id, d.tracking_number])).toEqual([["file-2", "TRK123"]])
  })

  it("prints nothing and keeps no paper when no rule asks for one", async () => {
    const h = harness({ needs: false })
    const [r] = await generateOrderDocuments(h.ctx, [REF], { readDraft })
    expect(r).toMatchObject({ needed: [], printed: [] })
    expect(h.prints).toHaveLength(0)
    expect((await orderDocumentsByRef(h.ctx, [REF])).size).toBe(0)
  })

  it("reports a print failure instead of throwing", async () => {
    const h = harness()
    const ctx = { ...h.ctx, executeTool: (async (target: string, params: Record<string, unknown>) =>
      target === "kernel:documents_print"
        ? { status: "error", error: { code: "template_invalid", message: "bad template" } }
        : h.ctx.executeTool(target, params)) as BoxtalToolCtx["executeTool"] }
    const [r] = await generateOrderDocuments(ctx, [REF], { readDraft })
    expect(r?.error).toContain("bad template")
  })

  it("reads stored papers defensively", () => {
    expect(readOrderDocuments(null)).toEqual([])
    expect(readOrderDocuments("not json")).toEqual([])
    expect(readOrderDocuments([{ template_id: "t" }, { template_id: "t", file_id: "f" }])).toHaveLength(1)
  })
})
