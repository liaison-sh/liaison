// SPDX-License-Identifier: FSL-1.1-ALv2
// E-invoicing issue gate: classification + mandatory-data pass, gate mode, snapshot builders.
// Pure (no issue site calls these yet). Runs in `enforce` unless the test is named "warn".
import { describe, expect, test } from "bun:test"
import { createMockDb } from "../test-db"
import {
  type BuyerSnapshot,
  EinvoiceGateRefusal,
  GATE_CODE_STATUS,
  type GateInput,
  einvoiceGateError,
  evaluateEinvoiceGate,
  gateErrorEnvelope,
  gatePreflight,
  gateWarning,
  regimeSnapshot,
  resolveBuyerFacts,
  resolveGateMode,
} from "./gate"
import { FR_BUSINESS_CONFIRMED, FR_INDIVIDUAL, seedConfirmedIdentity } from "./test-fixtures"

const ISSUER = { country: "FR", vat_id: "FR00900000001", vat_on_debits_default: false }
const LINES_GOODS = [{ line_kind: "goods" }]

function input(over: Partial<GateInput> & Pick<GateInput, "buyer">): GateInput {
  return {
    docType: "invoice",
    issuer: ISSUER,
    lines: LINES_GOODS,
    operationCategory: "goods",
    operationSource: "explicit",
    paymentState: "due",
    original: null,
    mode: "enforce",
    ...over,
  }
}

/** Buyer facts for a snapshot. A registry-confirmed SIREN only ever comes from an identity row,
 *  so a fixture that stands for a confirmed buyer gets one, on a contact of its own. */
async function buyerFrom(snapshot: BuyerSnapshot, contact_id: string | null = null, seed = {}) {
  const db = createMockDb({ seed })
  let contact = contact_id
  if (!contact && snapshot.buyer_siren && snapshot.buyer_siren_confirmed_via) {
    contact = "c-confirmed"
    await seedConfirmedIdentity(db, {
      contact_id: contact,
      siren: snapshot.buyer_siren,
      name: snapshot.buyer_legal_name ?? "Exemple Industries SAS",
      postcode: snapshot.billing_postcode ?? "75002",
      city: snapshot.billing_city ?? "Paris",
    })
  }
  return resolveBuyerFacts(db, { docType: "invoice", contact_id: contact, snapshot })
}

describe("einvoiceGateError (enforce)", () => {
  test("business FR buyer without SIREN → einvoice_data_missing, fix lookup, retryable, 422", async () => {
    const buyer = await buyerFrom({ ...FR_BUSINESS_CONFIRMED, buyer_siren: null, buyer_siren_confirmed_via: null })
    const r = einvoiceGateError(input({ buyer }))
    expect(r?.code).toBe("einvoice_data_missing")
    expect(r?.status).toBe(422)
    expect(r?.missing.find((m) => m.field === "buyer_siren")?.fix_tool).toBe("counterparty_identity_lookup")
    const env = gateErrorEnvelope(r!)
    expect(env.status).toBe("error")
    expect(env.error.retryable).toBe(true)
    expect(env.error.status).toBe(422)
    expect(env.error.body.gate_mode).toBe("enforce")
    expect(env.error.body.missing.length).toBeGreaterThan(0)
    const pre = gatePreflight(r!)
    expect(pre.error.code).toBe("einvoice_data_missing")
    expect(pre.error.retryable).toBe(true)
    expect(pre.error.body.missing).toEqual(env.error.body.missing)
  })

  test("French buyer without a customer kind → customer_kind_missing", async () => {
    const buyer = await buyerFrom({ ...FR_INDIVIDUAL, customer_kind: null })
    const r = einvoiceGateError(input({ buyer }))
    expect(r?.code).toBe("customer_kind_missing")
    expect(r?.missing[0]?.field).toBe("customer_kind")
  })

  test("derived, unconfirmed SIREN → registry_unconfirmed", async () => {
    const db = createMockDb()
    await db.insert("counterparty_identities", {
      contact_id: "c-derived",
      customer_kind: "business",
      siren: "902000009",
      source: "derived",
    })
    const buyer = await resolveBuyerFacts(db, {
      docType: "invoice",
      contact_id: "c-derived",
      snapshot: { ...FR_BUSINESS_CONFIRMED, buyer_siren: null, buyer_siren_confirmed_via: null },
    })
    const r = einvoiceGateError(input({ buyer }))
    expect(r?.code).toBe("registry_unconfirmed")
    expect(r?.missing[0]?.fix_tool).toBe("counterparty_identity_lookup")
  })

  test("contactless snapshot SIREN without confirmation → registry_unconfirmed", async () => {
    const buyer = await buyerFrom({ ...FR_BUSINESS_CONFIRMED, buyer_siren_confirmed_via: null })
    expect(einvoiceGateError(input({ buyer }))?.code).toBe("registry_unconfirmed")
  })

  test("a caller-sourced snapshot never confirms a SIREN: registry_unconfirmed, and no confirmation is recorded", async () => {
    // Contactless: the confirmation can only be the caller's claim.
    const db = createMockDb()
    const buyer = await resolveBuyerFacts(db, { docType: "invoice", contact_id: null, snapshot: FR_BUSINESS_CONFIRMED })
    expect(buyer.sirenConfirmed).toBe(false)
    expect(buyer.confirmedVia).toBeNull()
    const gi = input({ buyer, mode: "warn" })
    const ev = evaluateEinvoiceGate(gi)
    expect(ev.refusal?.code).toBe("registry_unconfirmed")
    const s = regimeSnapshot({ evaluation: ev, input: gi, issuedAt: "2026-11-02", delivery: null })
    expect(s.buyer_siren).toBe("900000001")
    expect(s.buyer_siren_confirmed_via).toBeNull()
  })

  test("confirmed identity by contact passes", async () => {
    const db = createMockDb()
    const { snapshot } = await seedConfirmedIdentity(db, {
      contact_id: "c-ok",
      siren: "903000008",
      name: "Démo Conseil SARL",
      postcode: "33000",
      city: "Bordeaux",
    })
    const buyer = await resolveBuyerFacts(db, { docType: "invoice", contact_id: "c-ok", snapshot })
    expect(buyer.sirenConfirmed).toBe(true)
    expect(einvoiceGateError(input({ buyer }))).toBeNull()
    expect(evaluateEinvoiceGate(input({ buyer })).regime).toBe("e_invoice")
  })

  test("e_invoice without structured billing → billing_address missing", async () => {
    const buyer = await buyerFrom({ ...FR_BUSINESS_CONFIRMED, billing_postcode: null, billing_city: null })
    const r = einvoiceGateError(input({ buyer }))
    expect(r?.code).toBe("einvoice_data_missing")
    const item = r?.missing.find((m) => m.field === "billing_address")
    // The gate reads billing from the call / draft snapshot, not from the identity row.
    expect(item?.fix_tool).toBe("drafts_update")
    expect(item?.fix_hint).toContain("counterparty")
  })

  test("defaulted line kinds on a business FR buyer → operation_category_missing; explicit category passes", async () => {
    const buyer = await buyerFrom(FR_BUSINESS_CONFIRMED)
    const r = einvoiceGateError(input({ buyer, operationCategory: null, operationSource: null }))
    expect(r?.code).toBe("operation_category_missing")
    expect(r?.missing[0]?.field).toBe("operation_category")
    expect(r?.missing[0]?.fix_hint).toContain("operation_category")
    expect(einvoiceGateError(input({ buyer, operationCategory: "services", operationSource: "explicit" }))).toBeNull()
  })

  test("authoritative (Shopify) line kinds pass without an explicit category", async () => {
    const buyer = await buyerFrom(FR_BUSINESS_CONFIRMED)
    const ev = evaluateEinvoiceGate(
      input({ buyer, operationCategory: null, operationSource: "lines_authoritative", lines: [{ line_kind: "software" }] }),
    )
    expect(ev.refusal).toBeNull()
    expect(ev.operationCategory).toBe("services")
    expect(ev.operationSource).toBe("lines_authoritative")
  })

  test("Réunion buyer without a territory treatment → einvoice_needs_review", async () => {
    const buyer = await buyerFrom({ ...FR_BUSINESS_CONFIRMED, billing_postcode: "97400", billing_city: "Saint-Denis", billing_country_code: "RE" })
    const r = einvoiceGateError(input({ buyer }))
    expect(r?.code).toBe("einvoice_needs_review")
    expect(r?.regime).toBe("needs_review")
    const item = r?.missing.find((m) => m.field === "territory_treatment")
    expect(item?.fix_tool).toBe("counterparty_territory_set")
    expect(r?.message).toContain("counterparty_territory_set")
  })

  test("individual buyer in Germany → no refusal", async () => {
    const buyer = await buyerFrom({ ...FR_INDIVIDUAL, billing_country_code: "DE", billing_postcode: "10115", billing_city: "Berlin" })
    expect(einvoiceGateError(input({ buyer, operationCategory: null, operationSource: null }))).toBeNull()
  })

  test("credit note against an e_invoice original with null buyer_siren → einvoice_data_missing", async () => {
    const db = createMockDb()
    const original = {
      id: "doc-orig-1",
      regime: "e_invoice" as const,
      customer_kind: "business" as const,
      buyer_siren: null,
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
    }
    const buyer = await resolveBuyerFacts(db, { docType: "credit_note", contact_id: null, snapshot: {}, original })
    const r = einvoiceGateError(input({ docType: "credit_note", buyer, original: { id: original.id, regime: "e_invoice" } }))
    expect(r?.code).toBe("einvoice_data_missing")
    expect(r?.missing.some((m) => m.field === "buyer_siren")).toBe(true)
  })

  test("credit note ignores a later identity change (the original snapshot wins)", async () => {
    const db = createMockDb()
    await seedConfirmedIdentity(db, { contact_id: "c-cn", siren: "903000008", name: "Démo Conseil SARL", postcode: "33000", city: "Bordeaux" })
    const original = {
      id: "doc-orig-2",
      regime: "e_invoice" as const,
      counterparty_contact_id: "c-cn",
      customer_kind: "business" as const,
      buyer_siren: "900000001",
      buyer_siren_confirmed_via: null,
      billing_line1: "1 rue de l'Exemple",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
    }
    const buyer = await resolveBuyerFacts(db, { docType: "credit_note", contact_id: "c-cn", snapshot: {}, original })
    expect(buyer.source).toBe("original")
    expect(buyer.siren).toBe("900000001")
    const r = einvoiceGateError(input({ docType: "credit_note", buyer, original: { id: original.id, regime: "e_invoice" } }))
    expect(r).toBeNull()
  })

  test("credit note against a legacy original (no regime) uses the identity", async () => {
    const db = createMockDb()
    await seedConfirmedIdentity(db, { contact_id: "c-leg", siren: "903000008", name: "Démo Conseil SARL", postcode: "33000", city: "Bordeaux" })
    const original = { id: "doc-legacy", regime: null, counterparty_contact_id: "c-leg" }
    const buyer = await resolveBuyerFacts(db, {
      docType: "credit_note",
      contact_id: "c-leg",
      snapshot: { billing_postcode: "33000", billing_city: "Bordeaux", billing_country_code: "FR" },
      original,
    })
    expect(buyer.source).toBe("identity")
    expect(buyer.siren).toBe("903000008")
  })

  test("the message names every fix_tool", async () => {
    const buyer = await buyerFrom({ ...FR_BUSINESS_CONFIRMED, buyer_siren: null, buyer_siren_confirmed_via: null, billing_city: null })
    const r = einvoiceGateError(input({ buyer, operationCategory: null, operationSource: null }))!
    expect(r.missing.length).toBe(3)
    for (const m of r.missing) expect(r.message).toContain(m.fix_tool)
  })

  test("warn mode returns a warning, not an error", async () => {
    const buyer = await buyerFrom({ ...FR_BUSINESS_CONFIRMED, buyer_siren: null, buyer_siren_confirmed_via: null })
    const r = einvoiceGateError(input({ buyer, mode: "warn" }))
    expect(r?.mode).toBe("warn")
    const w = gateWarning(r!)
    expect(w.code).toBe("einvoice_data_missing")
    expect(w.missing.length).toBeGreaterThan(0)
    expect(() => gateErrorEnvelope(r!)).toThrow()
  })

  test.each([
    ["einvoice_data_missing", 422],
    ["customer_kind_missing", 422],
    ["siren_invalid", 422],
    ["siren_inactive", 422],
    ["einvoice_needs_review", 422],
    ["operation_category_missing", 422],
    ["registry_unconfirmed", 422],
    ["imported_original_missing", 409],
  ] as const)("GATE_CODE_STATUS: %s → %d", (code, status) => {
    expect(GATE_CODE_STATUS[code]).toBe(status)
  })

  test("GATE_CODE_STATUS covers exactly the eight gate codes", () => {
    expect(Object.keys(GATE_CODE_STATUS).sort()).toEqual(
      [
        "customer_kind_missing",
        "einvoice_data_missing",
        "einvoice_needs_review",
        "imported_original_missing",
        "operation_category_missing",
        "registry_unconfirmed",
        "siren_inactive",
        "siren_invalid",
      ].sort(),
    )
  })

  test("a missing-SIREN refusal says the buyer's kind is never the way past it", async () => {
    // red: without it a weak agent re-issued a French company as a non-registered entity.
    const buyer = await buyerFrom({ ...FR_BUSINESS_CONFIRMED, buyer_siren: null, buyer_siren_confirmed_via: null })
    const r = einvoiceGateError(input({ buyer }))!
    expect(r.message).toMatch(/never change it to get past this refusal/)
    const kindOnly = einvoiceGateError(input({ buyer: await buyerFrom({ ...FR_INDIVIDUAL, customer_kind: null }) }))!
    expect(kindOnly.message).not.toMatch(/never change it/)
  })

  test("EinvoiceGateRefusal carries the result", async () => {
    const buyer = await buyerFrom({ ...FR_INDIVIDUAL, customer_kind: null })
    const r = einvoiceGateError(input({ buyer }))!
    const e = new EinvoiceGateRefusal(r)
    expect(e).toBeInstanceOf(Error)
    expect(e.result.code).toBe("customer_kind_missing")
    expect(e.message).toBe(r.message)
  })
})

describe("regimeSnapshot", () => {
  test("e_invoice snapshot: regime, buyer, routing = SIREN, tax point = issue date, no delivery when same", async () => {
    const buyer = await buyerFrom(FR_BUSINESS_CONFIRMED)
    const gi = input({ buyer })
    const ev = evaluateEinvoiceGate(gi)
    const s = regimeSnapshot({ evaluation: ev, input: gi, issuedAt: "2026-11-02", delivery: null })
    expect(s.regime).toBe("e_invoice")
    expect(s.customer_kind).toBe("business")
    expect(s.buyer_siren).toBe("900000001")
    expect(s.buyer_routing_address).toBe("900000001")
    expect(s.buyer_siren_confirmed_via).toBe("auto")
    expect(s.billing_city).toBe("Paris")
    expect(s.operation_category).toBe("goods")
    expect(s.operation_category_source).toBe("explicit")
    expect(s.payment_state).toBe("due")
    expect(s.vat_on_debits).toBe(false)
    expect(s.tax_point_date).toBe("2026-11-02")
    expect(s.delivery_city).toBeUndefined()
    expect(Array.isArray(s.regime_reasons)).toBe(true)
  })

  test("delivery columns only when the delivery address differs", async () => {
    const buyer = await buyerFrom(FR_BUSINESS_CONFIRMED)
    const gi = input({ buyer })
    const ev = evaluateEinvoiceGate(gi)
    const s = regimeSnapshot({
      evaluation: ev,
      input: gi,
      issuedAt: "2026-11-02",
      delivery: { name: "Entrepôt", line1: "9 quai du Test", postcode: "13002", city: "Marseille", country_code: "FR" },
    })
    expect(s.delivery_city).toBe("Marseille")
    expect(s.delivery_name).toBe("Entrepôt")
  })

  test("EUR VAT total converts with the document currency's own minor-unit exponent", async () => {
    const buyer = await buyerFrom(FR_BUSINESS_CONFIRMED)
    const gi = input({ buyer })
    const ev = evaluateEinvoiceGate(gi)
    const snap = (currency: string, taxTotalMinor: bigint, rate: string) =>
      regimeSnapshot({
        evaluation: ev,
        input: gi,
        issuedAt: "2026-11-02",
        delivery: null,
        fx: { rate, rate_date: "2026-10-30" },
        taxTotalMinor,
        currency,
      })
    // JPY has no minor unit: 10000 JPY at 160 JPY/EUR is 62.50 EUR, i.e. 6250 EUR cents.
    const jpy = snap("JPY", 10000n, "160")
    expect(jpy.tax_total_eur_minor).toBe("6250")
    expect(jpy.fx_rate).toBe("160")
    expect(jpy.fx_rate_date).toBe("2026-10-30")
    expect(jpy.fx_source).toBe("ECB")
    // A two-decimal currency: 100.00 USD at 1.0850 is 92.17 EUR.
    expect(snap("USD", 10000n, "1.0850").tax_total_eur_minor).toBe("9217")
  })

  test("warn snapshot: unknown fields stay null, regime needs_review with gate_warning when the classifier had none", async () => {
    const buyer = await buyerFrom({ ...FR_INDIVIDUAL, customer_kind: null })
    const gi = input({ buyer, mode: "warn" })
    const ev = evaluateEinvoiceGate(gi)
    const s = regimeSnapshot({ evaluation: ev, input: gi, issuedAt: "2026-11-02", delivery: null })
    expect(s.regime).toBe("needs_review")
    expect(s.customer_kind).toBeNull()
    expect((s.regime_reasons as Array<{ code: string }>).some((r) => r.code === "gate_warning")).toBe(true)
  })

  test("warn snapshot keeps the classifier's verdict when it had one", async () => {
    const buyer = await buyerFrom(FR_BUSINESS_CONFIRMED)
    const gi = input({ buyer, mode: "warn", operationCategory: null, operationSource: null })
    const ev = evaluateEinvoiceGate(gi)
    const s = regimeSnapshot({ evaluation: ev, input: gi, issuedAt: "2026-11-02", delivery: null })
    expect(s.regime).toBe("e_invoice")
    expect(s.operation_category).toBeNull()
    expect((s.regime_reasons as Array<{ code: string }>).some((r) => r.code === "gate_warning")).toBe(true)
  })

  test("credit note snapshot links the original and flags an internal cancellation", async () => {
    const db = createMockDb()
    const original = {
      id: "doc-orig-3",
      regime: "e_invoice" as const,
      customer_kind: "business" as const,
      buyer_siren: "900000001",
      billing_postcode: "75002",
      billing_city: "Paris",
      billing_country_code: "FR",
    }
    const buyer = await resolveBuyerFacts(db, { docType: "credit_note", contact_id: null, snapshot: {}, original })
    const gi = input({ docType: "credit_note", buyer, original: { id: original.id, regime: "e_invoice", transmissionStatus: "rejected" } })
    const ev = evaluateEinvoiceGate(gi)
    const s = regimeSnapshot({ evaluation: ev, input: gi, issuedAt: "2026-11-03", delivery: null })
    expect(s.original_document_id).toBe("doc-orig-3")
    expect(s.internal_cancellation).toBe(true)
  })
})

describe("resolveGateMode", () => {
  test("pre-P1 issued documents → warn (materialised as upgrade_default)", async () => {
    const db = createMockDb({
      seed: { documents: [{ id: "d1", type: "invoice", status: "issued", number: "F-2026-0001", regime: null }] },
    })
    expect(await resolveGateMode(db, { materialise: true })).toBe("warn")
    const rows = db.__all("einvoicing_settings")
    expect(rows.length).toBe(1)
    expect(rows[0]?.gate_mode).toBe("warn")
    expect(rows[0]?.gate_mode_source).toBe("upgrade_default")
  })

  test("a pre-P1 issued invoice behind more than 2000 numberless drafts still → warn", async () => {
    const drafts = Array.from({ length: 2100 }, (_, i) => ({
      id: `dr${i}`,
      type: "invoice",
      status: "draft",
      number: null,
      regime: null,
    }))
    const db = createMockDb({
      seed: { documents: [...drafts, { id: "d-old", type: "invoice", status: "paid", number: "F-2025-0042", regime: null }] },
    })
    expect(await resolveGateMode(db, { materialise: false })).toBe("warn")
  })

  test("a numbered quote alone (never issued as an invoice status) → enforce", async () => {
    const db = createMockDb({
      seed: { documents: [{ id: "q1", type: "quote", status: "sent", number: "Q-2026-0001", regime: null }] },
    })
    expect(await resolveGateMode(db, { materialise: false })).toBe("enforce")
  })

  test("drafts without a number do not count as pre-P1 issued documents", async () => {
    const db = createMockDb({
      seed: { documents: [{ id: "d0", type: "invoice", status: "draft", number: null, regime: null }] },
    })
    expect(await resolveGateMode(db, { materialise: false })).toBe("enforce")
  })

  test("empty org → enforce (materialised as install_default)", async () => {
    const db = createMockDb()
    expect(await resolveGateMode(db, { materialise: true })).toBe("enforce")
    expect(db.__all("einvoicing_settings")[0]?.gate_mode_source).toBe("install_default")
  })

  test("an existing row wins", async () => {
    const db = createMockDb({
      seed: {
        einvoicing_settings: [{ id: "s1", gate_mode: "enforce", gate_mode_source: "config" }],
        documents: [{ id: "d1", type: "invoice", status: "issued", number: "F-2026-0001", regime: null }],
      },
    })
    expect(await resolveGateMode(db, { materialise: true })).toBe("enforce")
    expect(db.__all("einvoicing_settings").length).toBe(1)
  })

  test("the read path does not write", async () => {
    const db = createMockDb({
      seed: { documents: [{ id: "d1", type: "invoice", status: "issued", number: "F-2026-0001", regime: null }] },
    })
    expect(await resolveGateMode(db, { materialise: false })).toBe("warn")
    expect(db.__all("einvoicing_settings").length).toBe(0)
  })
})
