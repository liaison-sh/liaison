// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pennylane adapter details beyond the conformance kit: customer upsert and routing outcomes,
// crash-window adoption, the send_to_pa answers, eligibility re-check, VAT-rate mapping, foreign
// currency booking amounts, and error mapping.
import { describe, expect, it } from "bun:test"
import { PennylaneClient } from "../lib/pennylane-client"
import { bookSale } from "./book"
import { ensureRoutingAddress, splitPersonName, upsertCustomer } from "./customers"
import { eligibilityProblems } from "./eligibility"
import { BUYER, BUYER_SIREN, bookingData, ciiXml } from "./fake/fixtures"
import { PennylaneFake } from "./fake/server"
import { advanceEinvoice, getEinvoiceStatus, submitEinvoice } from "./send"
import { pennylaneVatRate } from "./vat-rate"

function setup() {
  const fake = new PennylaneFake()
  fake.directory[BUYER_SIREN] = [BUYER_SIREN]
  const client = new PennylaneClient({ fetch: fake.sandboxFetch, apiToken: "tok" })
  return { fake, client }
}

let n = 0
function submitParams(fake: PennylaneFake, over: Record<string, unknown> = {}) {
  n += 1
  const number = `FA-9-${n}`
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  const sha = n.toString(16).padStart(64, "b")
  fake.files.set(id, { sha256: sha, invoice_number: number, date: "2026-11-03", buyer_siren: BUYER_SIREN, valid: true })
  return {
    document_ref: `doc-${n}`,
    invoice_number: number,
    issue_date: "2026-11-03",
    facturx_file_id: id,
    legal_original_sha256: sha,
    cii_xml: ciiXml({ number, date: "2026-11-03" }),
    buyer: BUYER,
    idempotency_key: `k-${n}`,
    ...over,
  }
}

describe("customers", () => {
  it("creates once, adopts on 'already been taken', updates only what changed (reg_no change clears the routing address)", async () => {
    const { fake, client } = setup()
    const input = { external_reference: "contact:1", kind: "company" as const, name: "Client SARL", reg_no: BUYER_SIREN, address: BUYER.address }
    const c1 = await upsertCustomer(client, input)
    const c2 = await upsertCustomer(client, input)
    expect(c2.id).toBe(c1.id)
    expect(fake.creates("customer")).toBe(1)
    expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(0)
    // A concurrent create: lookup misses, create answers 422 taken, lookup again adopts.
    fake.fail((c) => c.method === "GET" && c.path.startsWith("/customers?"), "replace", {
      status: 200,
      body: { items: [], has_more: false, next_cursor: null },
    })
    const c3 = await upsertCustomer(client, input)
    expect(c3.id).toBe(c1.id)
    await ensureRoutingAddress(client, c3, BUYER_SIREN)
    expect(fake.customers.get(c1.id)!.electronic_billing_address).toBe(BUYER_SIREN)
    const c4 = await upsertCustomer(client, { ...input, reg_no: "552100554" })
    expect(c4.electronic_billing_address).toBeNull()
  })

  it("splits a person's name for an individual and never sends a registration number", async () => {
    expect(splitPersonName({ external_reference: "x", kind: "individual", name: "Marie Claire Dupont", address: BUYER.address })).toEqual({
      first_name: "Marie Claire",
      last_name: "Dupont",
    })
    const { fake, client } = setup()
    await upsertCustomer(client, { external_reference: "doc:1", kind: "individual", name: "Alex Exemple", reg_no: "123", address: BUYER.address })
    const body = fake.calls.find((c) => c.method === "POST" && c.path === "/customers")!.json as Record<string, unknown>
    expect(body).toMatchObject({ customer_type: "individual", first_name: "Alex", last_name: "Exemple" })
    expect(body.reg_no).toBeUndefined()
  })

  it("routing: empty directory → not_in_directory; address not listed → routing_mismatch; 503 is retryable", async () => {
    const { fake, client } = setup()
    const p = submitParams(fake)
    fake.directory[BUYER_SIREN] = []
    expect(await submitEinvoice(client, p)).toMatchObject({ provider_ref: null, state: "not_in_directory", listed: [] })
    fake.directory[BUYER_SIREN] = [`${BUYER_SIREN}_SVC1`]
    expect(await submitEinvoice(client, p)).toMatchObject({ state: "routing_mismatch", listed: [`${BUYER_SIREN}_SVC1`] })
    fake.directoryDown = true
    expect(await submitEinvoice(client, p)).toMatchObject({ status: "error", error: { code: "provider_unavailable", retryable: true } })
    expect(fake.creates("einvoice_import")).toBe(0)
  })
})

describe("deposit and transmission", () => {
  it("crash after the import's 201: the next submit adopts the deposit by invoice number (one import)", async () => {
    const { fake, client } = setup()
    const p = submitParams(fake)
    fake.fail((c) => c.path === "/customer_invoices/e_invoices/imports", "after", undefined, new Error("socket closed"))
    expect(await submitEinvoice(client, p)).toMatchObject({ status: "error", error: { code: "provider_error" } })
    const again = (await submitEinvoice(client, p)) as { provider_ref: string; adopted: boolean }
    expect(again.adopted).toBe(true)
    expect(fake.creates("einvoice_import")).toBe(1)
    expect(fake.createdInvoices("einvoice")).toHaveLength(1)
  })

  it("passes invoice_options[customer_id] and send_to_pa=false, pins the file, tags the import with the key", async () => {
    const { fake, client } = setup()
    const p = submitParams(fake)
    const r = (await submitEinvoice(client, p)) as { provider_ref: string }
    const imp = fake.calls.find((c) => c.path === "/customer_invoices/e_invoices/imports")!
    expect(imp.parts!.map((x) => x.name)).toEqual(["file", "send_to_pa", "invoice_options[customer_id]"])
    expect(imp.parts!.find((x) => x.name === "send_to_pa")!.value).toBe("false")
    expect(imp.parts!.find((x) => x.name === "file")!.sha256).toBe(p.legal_original_sha256)
    expect(fake.invoices.get(Number(r.provider_ref))!.external_reference).toBe(p.idempotency_key)
  })

  it("the CII checked for eligibility is the one embedded in the uploaded file: a valid CII beside another invoice's PDF is refused before upload", async () => {
    const { fake, client } = setup()
    const p = submitParams(fake)
    const imp = () => fake.calls.filter((c) => c.path === "/customer_invoices/e_invoices/imports").length
    // The caller hands a CII for this invoice but the file is another one's legal original.
    const other = submitParams(fake)
    const r = await submitEinvoice(client, { ...p, facturx_file_id: other.facturx_file_id, legal_original_sha256: other.legal_original_sha256 })
    expect(r).toMatchObject({ status: "error", error: { code: "einvoice_cii_mismatch" } })
    expect(imp()).toBe(0)
    // The pin rides on the file part.
    await submitEinvoice(client, p)
    const part = fake.calls.find((c) => c.path === "/customer_invoices/e_invoices/imports")!.parts!.find((x) => x.name === "file")!
    expect(part).toBeTruthy()
    expect(imp()).toBe(1)
  })

  it("send_to_pa: 409 waits, 422 is 'sent' only when Pennylane shows the transmission, else still requested (never failed)", async () => {
    const { fake, client } = setup()
    const p = submitParams(fake)
    const { provider_ref } = (await submitEinvoice(client, p)) as { provider_ref: string }
    const adv = { provider_ref, invoice_number: p.invoice_number, issue_date: p.issue_date }
    fake.fail((c) => c.path.endsWith("/send_to_pa"), "replace", { status: 409, body: { status: 409, error: "processing" } })
    expect(await advanceEinvoice(client, adv)).toMatchObject({ state: "validation_pending" })
    fake.fail((c) => c.path.endsWith("/send_to_pa"), "replace", { status: 422, body: { status: 422, error: "Not eligible" } })
    // A 422 whose re-read does not (yet) show the transmission: unconfirmed, re-read later, never failed.
    expect(await advanceEinvoice(client, adv)).toMatchObject({ state: "send_requested", detail: { status: 422, unconfirmed: true } })
    // Crash after the 204: the next step sees the transmission and never sends twice.
    fake.fail((c) => c.path.endsWith("/send_to_pa"), "after", undefined, new Error("socket closed"))
    expect(await advanceEinvoice(client, adv)).toMatchObject({ status: "error" })
    expect(await advanceEinvoice(client, adv)).toMatchObject({ state: "sent" })
    expect(fake.calls.filter((c) => c.path.endsWith("/send_to_pa"))).toHaveLength(3)
    expect(fake.creates("send_to_pa")).toBe(3) // two refused by injection, one real
    expect([...fake.invoices.values()].filter((i) => i.e_invoicing)).toHaveLength(1)
  })

  it("an invalid schematron fails the deposit and is never sent", async () => {
    const { fake, client } = setup()
    const p = submitParams(fake)
    fake.files.get(p.facturx_file_id)!.valid = false
    const { provider_ref } = (await submitEinvoice(client, p)) as { provider_ref: string }
    expect(await advanceEinvoice(client, { provider_ref, invoice_number: p.invoice_number, issue_date: p.issue_date })).toMatchObject({
      state: "failed",
      detail: { reason: "schematron_invalid" },
    })
    expect(fake.calls.some((c) => c.path.endsWith("/send_to_pa"))).toBe(false)
  })

  it("a provider ref of another invoice is refused", async () => {
    const { fake, client } = setup()
    const p = submitParams(fake)
    const { provider_ref } = (await submitEinvoice(client, p)) as { provider_ref: string }
    expect(await advanceEinvoice(client, { provider_ref, invoice_number: "OTHER-1", issue_date: p.issue_date })).toMatchObject({
      status: "error",
      error: { code: "provider_ref_mismatch" },
    })
  })

  it("status before transmission is 'imported'; a rate limit is a retryable error with retry_at", async () => {
    const { fake, client } = setup()
    const p = submitParams(fake)
    const { provider_ref } = (await submitEinvoice(client, p)) as { provider_ref: string }
    expect(await getEinvoiceStatus(client, { provider_ref })).toMatchObject({ raw: null, mapped: "imported", e_invoicing: false })
    fake.remaining = 0
    const r = (await getEinvoiceStatus(client, { provider_ref })) as { error: { code: string; retryable: boolean; detail: { retry_at: string } } }
    expect(r.error.code).toBe("provider_rate_limited")
    expect(r.error.retryable).toBe(true)
    expect(Date.parse(r.error.detail.retry_at)).toBeGreaterThan(Date.now())
  })
})

describe("eligibility re-check from the CII", () => {
  const ok = { invoice_number: "FA-1", issue_date: "2026-11-03", buyer_siren: BUYER_SIREN }
  it("accepts a domestic B2B invoice and credit note", () => {
    expect(eligibilityProblems(ciiXml({ number: "FA-1", date: "2026-11-03" }), ok)).toEqual([])
    expect(eligibilityProblems(ciiXml({ number: "FA-1", date: "2026-11-03", typeCode: "381" }), ok)).toEqual([])
  })
  it.each([
    ["B2C note", { bar: "B2C" }, "BAR note is B2C"],
    ["another number", { number: "FA-2" }, "BT-1 FA-2 differs"],
    ["another date", { date: "2026-11-04" }, "BT-2 2026-11-04 differs"],
    ["another buyer", { buyerSiren: "552100554" }, "buyer SIREN 552100554 differs"],
    ["a foreign buyer", { buyerCountry: "DE" }, "buyer country is DE"],
    ["a quote", { typeCode: "325" }, "document type 325"],
  ])("refuses %s", (_label, over, msg) => {
    const xml = ciiXml({ number: "FA-1", date: "2026-11-03", ...(over as object) })
    expect(eligibilityProblems(xml, ok).join(" | ")).toContain(msg)
  })
  it("refuses a missing CII", () => {
    expect(eligibilityProblems("", ok)).toEqual(["the CII XML is missing"])
  })
})

describe("booking", () => {
  it.each([
    [{ tax_treatment: "eu_domestic", tax_rate_bp: 2000 }, "FR_200"],
    [{ tax_treatment: "eu_domestic", tax_rate_bp: 550 }, "FR_55"],
    [{ tax_treatment: "eu_domestic", tax_rate_bp: 210 }, "FR_21"],
    [{ tax_treatment: "eu_reverse_charge", tax_rate_bp: 0, operation_category: "goods" }, "crossborder"],
    [{ tax_treatment: "eu_reverse_charge", tax_rate_bp: 0, operation_category: "services" }, "crossborder"],
    [{ tax_treatment: "eu_export_non_eu", tax_rate_bp: 0 }, "extracom"],
    [{ tax_treatment: "eu_b2c_oss", tax_rate_bp: 1900, destination_country: "DE" }, "DE_190"],
  ])("maps %o to %s", (line, rate) => {
    expect(pennylaneVatRate({ label: "x", quantity: "1", unit_price_minor: 1, subtotal_minor: 1, tax_minor: 0, operation_category: "goods", ...line } as never)).toEqual({
      ok: true,
      vat_rate: rate,
    })
  })
  it.each([
    [{ tax_treatment: "eu_b2c_oss", tax_rate_bp: 2000, destination_country: "DE", rate_is_placeholder: true }],
    [{ tax_treatment: "unconfigured", tax_rate_bp: 2000 }],
    [{ tax_treatment: "ambiguous", tax_rate_bp: 2000 }],
    [{ tax_treatment: "eu_domestic", tax_rate_bp: 1700 }],
  ])("refuses %o", (line) => {
    expect(pennylaneVatRate({ label: "x", quantity: "1", unit_price_minor: 1, subtotal_minor: 1, tax_minor: 0, operation_category: "goods", ...line } as never).ok).toBe(false)
  })

  it("books a foreign-currency sale with the EUR amounts from the stored rate, an individual without reg_no, never as an e-invoice", async () => {
    const { fake, client } = setup()
    const id = "00000000-0000-4000-8000-00000000f001"
    fake.files.set(id, { sha256: "c".repeat(64), invoice_number: null, date: null, buyer_siren: null, valid: false })
    const r = await bookSale(client, {
      document_ref: "doc-usd",
      pdf_file_id: id,
      legal_original_sha256: "c".repeat(64),
      data: bookingData({ number: "FA-USD-1", currency: "USD", fx_rate: "1.1", treatment: "eu_export_non_eu", rate_bp: 0 }),
      idempotency_key: "book-usd",
    })
    expect(r).toMatchObject({ state: "booked", adopted: false })
    const body = fake.calls.find((c) => c.path === "/customer_invoices/import")!.json as Record<string, any>
    expect(body).toMatchObject({ currency: "USD", currency_amount: "100.00", amount: "90.91", tax: "0.00", external_reference: "book-usd" })
    expect(body.invoice_lines[0]).toMatchObject({ vat_rate: "extracom", amount: "90.91", raw_currency_unit_price: "100.00", unit: "piece" })
    expect(body.convert_to_e_invoice).toBeUndefined()
    expect(fake.calls.some((c) => c.path.endsWith("/send_to_pa") || c.path.includes("e_invoices"))).toBe(false)
    const cust = fake.calls.find((c) => c.path === "/customers" && c.method === "POST")!.json as Record<string, unknown>
    expect(cust.customer_type).toBe("individual")
    expect(cust.reg_no).toBeUndefined()
  })

  it("crash after the booking's 201: the replay adopts it by external_reference (one booking)", async () => {
    const { fake, client } = setup()
    const id = "00000000-0000-4000-8000-00000000f002"
    fake.files.set(id, { sha256: "d".repeat(64), invoice_number: null, date: null, buyer_siren: null, valid: false })
    const p = { document_ref: "doc-b", pdf_file_id: id, legal_original_sha256: "d".repeat(64), data: bookingData({ number: "FA-B-1" }), idempotency_key: "book-b" }
    fake.fail((c) => c.path === "/customer_invoices/import", "after", undefined, new Error("socket closed"))
    expect(await bookSale(client, p)).toMatchObject({ status: "error" })
    expect(await bookSale(client, p)).toMatchObject({ state: "booked", adopted: true })
    expect(fake.createdInvoices("booking")).toHaveLength(1)
  })

  it("a booking whose file is not the legal original is refused before upload", async () => {
    const { fake, client } = setup()
    const id = "00000000-0000-4000-8000-00000000f003"
    fake.files.set(id, { sha256: "e".repeat(64), invoice_number: null, date: null, buyer_siren: null, valid: false })
    const r = await bookSale(client, { document_ref: "d", pdf_file_id: id, legal_original_sha256: "a".repeat(64), data: bookingData({ number: "X-1" }), idempotency_key: "kx" })
    expect(r).toMatchObject({ status: "error", error: { code: "legal_original_mismatch" } })
    expect(fake.creates("booking")).toBe(0)
  })
})
