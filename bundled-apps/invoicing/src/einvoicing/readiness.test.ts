// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `einvoicing_readiness`: every counterparty or draft that would stop an e-invoice, each with the
// one tool that fixes it. Its blocker codes are the issue gate's codes, and its actions are the
// gate's own fix tools, so a blocker listed here and the refusal an issue returns never disagree.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createMockDb } from "../test-db"
import { type BuyerFacts, GATE_BLOCKER_TOOLS, GATE_CODES, evaluateEinvoiceGate } from "./gate"
import { READINESS_TAXONOMY, einvoicingReadiness } from "./readiness"
import { FICTIONAL_SIRENS } from "./test-fixtures"

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "app.manifest.json"), "utf8")) as {
  tools: Record<string, { requiredScopes?: string[] }>
}

/** The issuer's own role (never admin). */
const CEO_ROLE_SCOPES = [
  "invoicing:documents:read",
  "invoicing:documents:write",
  "invoicing:contacts:read",
  "invoicing:contacts:write",
  "invoicing:settings:read",
  "invoicing:approve",
]

/** Hierarchical grant: `a:b` grants `a:b:c`. */
function granted(scope: string, held: readonly string[]): boolean {
  return held.some((h) => h === scope || scope.startsWith(`${h}:`))
}

const ISSUER = "00000000-0000-4000-8000-0000000a0001"
const C_OK = "00000000-0000-4000-8000-0000000a0011"
const C_NOSIREN = "00000000-0000-4000-8000-0000000a0012"
const C_UNCONF = "00000000-0000-4000-8000-0000000a0013"
const C_NOKIND = "00000000-0000-4000-8000-0000000a0014"
const C_MC = "00000000-0000-4000-8000-0000000a0015"
const C_DE = "00000000-0000-4000-8000-0000000a0016"
const C_NOBILL = "00000000-0000-4000-8000-0000000a0017"
const C_CEASED = "00000000-0000-4000-8000-0000000a0018"
const C_PARK = "00000000-0000-4000-8000-0000000a0019"

const billed = { billing_line1: "1 rue Test", billing_postcode: "75002", billing_city: "Paris", billing_country_code: "FR" }

function doc(id: string, contact: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    type: "invoice",
    status: "issued",
    issuer_profile_id: ISSUER,
    counterparty_contact_id: contact,
    counterparty_country: "FR",
    currency: "EUR",
    issued_at: "2026-09-01T00:00:00Z",
    external_refs: {},
    lifecycle_log: [],
    ...over,
  }
}

function confirmed(contact: string, siren: string, over: Record<string, unknown> = {}) {
  return { contact_id: contact, customer_kind: "business", siren, source: "registry", confirmed_via: "auto", registry_status: "A", registry_name: "EXEMPLE", ...over }
}

function world() {
  return createMockDb({
    seed: {
      issuer_profiles: [{ id: ISSUER, legal_name: "Emetteur Fictif SAS", country: "FR", vat_id: "FR68900000001" }],
      documents: [
        doc("00000000-0000-4000-8000-0000000d0011", C_OK, { counterparty_name: "Ok Fictif", ...billed }),
        doc("00000000-0000-4000-8000-0000000d0012", C_NOSIREN, { counterparty_name: "Sans Siren Fictif", ...billed, issued_at: "2026-10-01T00:00:00Z" }),
        doc("00000000-0000-4000-8000-0000000d0013", C_UNCONF, { counterparty_name: "Non Confirme Fictif", ...billed }),
        doc("00000000-0000-4000-8000-0000000d0014", C_NOKIND, { counterparty_name: "Sans Type Fictif", ...billed }),
        doc("00000000-0000-4000-8000-0000000d0015", C_MC, { counterparty_name: "Monaco Fictif", counterparty_country: "MC", billing_country_code: "MC" }),
        doc("00000000-0000-4000-8000-0000000d0016", C_DE, { counterparty_name: "Beispiel GmbH", counterparty_country: "DE" }),
        doc("00000000-0000-4000-8000-0000000d0017", C_NOBILL, { counterparty_name: "Sans Adresse Fictif" }),
        doc("00000000-0000-4000-8000-0000000d0018", C_CEASED, { counterparty_name: "Cesse Fictif", ...billed }),
        // An open draft of a confirmed buyer without its operation type.
        doc("00000000-0000-4000-8000-0000000d0019", C_OK, { status: "draft", issued_at: null, counterparty_name: "Ok Fictif", ...billed }),
      ],
      counterparty_identities: [
        confirmed(C_OK, FICTIONAL_SIRENS[0]),
        { contact_id: C_NOSIREN, customer_kind: "business", siren: null, source: "derived" },
        { contact_id: C_UNCONF, customer_kind: "business", siren: FICTIONAL_SIRENS[1], source: "derived", confirmed_via: null },
        { contact_id: C_DE, customer_kind: "business", source: "derived" },
        confirmed(C_NOBILL, FICTIONAL_SIRENS[2]),
        confirmed(C_CEASED, FICTIONAL_SIRENS[1], { registry_status: "C" }),
        { contact_id: C_MC, customer_kind: "business", source: "derived" },
      ],
      deferred_events: [
        {
          id: "park-1",
          event_id: "9001",
          event_payload_json: { id: "9001", customer: { contact_id: C_PARK, legal_name: "Commande Fictive SARL", billing: { company: "Commande Fictive SARL", postcode: "75003", city: "Paris", country_code: "FR" } } },
          status: "awaiting_data",
          reason: "einvoice_data_missing",
          blocked_on: { kind: "einvoice_identity", contact_id: C_PARK, code: "einvoice_data_missing" },
          retry_count: 1,
          contact_id: C_PARK,
        },
      ],
    },
  })
}

type Item = {
  subject: { contact_id?: string; document_id?: string; label?: string }
  blocker_code: string
  action: { tool: string; label?: string; params_hint?: Record<string, unknown> }
  last_document_date?: string | null
}

async function run(db = world(), input: Record<string, unknown> = {}) {
  return (await einvoicingReadiness({ db } as never, input)) as { status: string; items: Item[]; count: number; message?: string }
}

const forContact = (items: Item[], c: string) => items.filter((i) => i.subject.contact_id === c && !i.subject.document_id)

describe("readiness taxonomy", () => {
  test("readiness blocker codes ⊆ GATE_CODES and every gate code is a readiness code", () => {
    const codes = new Set(READINESS_TAXONOMY.map((t) => t.blocker_code))
    for (const c of codes) expect(GATE_CODES).toContain(c as never)
    for (const c of GATE_CODES) expect(codes.has(c)).toBe(true)
  })

  test("every gate (code, field, fix tool) is a readiness action, and each blocker type has exactly one tool", () => {
    for (const g of GATE_BLOCKER_TOOLS) {
      expect(READINESS_TAXONOMY).toContainEqual(
        expect.objectContaining({ key: g.key, blocker_code: g.code, field: g.field, tool: g.fix_tool }),
      )
    }
    const keys = READINESS_TAXONOMY.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  test("every readiness action names a tool the manifest declares", () => {
    const pending = READINESS_TAXONOMY.filter((t) => !(t.tool in manifest.tools)).map((t) => `${t.blocker_code}->${t.tool}`)
    expect(pending).toEqual([])
    expect("einvoicing_backfill_legacy_originals" in manifest.tools).toBe(true)
  })

  // red: point a blocker at a tool the issuer's role cannot call -> the readiness list shows a fix
  // the person reading it can never apply.
  test("every declared fix tool is callable with the issuer's own role scopes", () => {
    const outOfRole = READINESS_TAXONOMY.filter((t) => t.tool in manifest.tools).flatMap((t) =>
      (manifest.tools[t.tool]!.requiredScopes ?? []).filter((s) => !granted(s, CEO_ROLE_SCOPES)).map((s) => `${t.tool}:${s}`),
    )
    expect(outOfRole).toEqual([])
    expect(READINESS_TAXONOMY.filter((t) => t.tool in manifest.tools).length).toBeGreaterThan(3)
  })

  test("the gate's blockers carry their code and a fix tool from the taxonomy", () => {
    const buyer: BuyerFacts = {
      source: "identity",
      customerKind: "business",
      legalName: "X",
      siren: null,
      siret: null,
      vatId: null,
      sirenStatus: null,
      territoryTreatment: null,
      sirenConfirmed: false,
      confirmedVia: null,
      billing: { line1: null, line2: null, postcode: null, city: null, countryCode: "FR" },
    }
    const ev = evaluateEinvoiceGate({
      docType: "invoice",
      issuer: { country: "FR", vat_id: "FR68900000001" },
      buyer,
      lines: [],
      operationCategory: null,
      operationSource: null,
      paymentState: null,
      original: null,
      mode: "enforce",
    })
    expect(ev.blockers.length).toBe(ev.refusal!.missing.length)
    for (const b of ev.blockers) {
      expect(READINESS_TAXONOMY).toContainEqual(expect.objectContaining({ blocker_code: b.code, tool: b.item.fix_tool }))
    }
  })
})

describe("einvoicing_readiness", () => {
  test("lists each blocker with the gate's fix tool", async () => {
    const r = await run()
    expect(r.status).toBe("ok")
    const pick = (c: string) => forContact(r.items, c).map((i) => [i.blocker_code, i.action.tool])
    expect(pick(C_OK)).toEqual([])
    expect(pick(C_NOSIREN)).toEqual([["einvoice_data_missing", "counterparty_identity_lookup"]])
    expect(pick(C_UNCONF)).toEqual([["registry_unconfirmed", "counterparty_identity_lookup"]])
    expect(pick(C_NOKIND)).toEqual([["customer_kind_missing", "counterparty_identity_set"]])
    expect(pick(C_MC)).toEqual([["einvoice_needs_review", "counterparty_territory_set"]])
    expect(pick(C_DE)).toEqual([])
    expect(pick(C_NOBILL)).toEqual([["einvoice_data_missing", "drafts_update"]])
    expect(pick(C_CEASED)).toEqual([["siren_inactive", "counterparty_identity_lookup"]])
    // The parked order's buyer, known only from the park.
    expect(pick(C_PARK)).toEqual([["einvoice_data_missing", "counterparty_identity_lookup"]])
    expect(forContact(r.items, C_PARK)[0]!.subject.label).toBe("Commande Fictive SARL")
  })

  test("a draft's own gap is listed on the draft (operation type)", async () => {
    const r = await run()
    const draftItems = r.items.filter((i) => i.subject.document_id === "00000000-0000-4000-8000-0000000d0019")
    expect(draftItems.map((i) => [i.blocker_code, i.action.tool])).toEqual([["operation_category_missing", "drafts_update"]])
    expect(draftItems[0]!.action.params_hint).toMatchObject({ document_id: "00000000-0000-4000-8000-0000000d0019" })
  })

  test("items carry label, last document date, a params hint; sorted by last document date", async () => {
    const r = await run()
    const first = r.items[0]!
    expect(first.subject.contact_id).toBe(C_NOSIREN)
    expect(first.last_document_date).toBe("2026-10-01")
    expect(first.subject.label).toBe("Sans Siren Fictif")
    expect(first.action.params_hint).toMatchObject({ contact_id: C_NOSIREN })
    expect(typeof first.action.label).toBe("string")
    expect(r.count).toBe(r.items.length)
  })

  test("limit bounds the list, count stays the total", async () => {
    const r = await run(world(), { limit: 2 })
    expect(r.items).toHaveLength(2)
    expect(r.count).toBeGreaterThan(2)
  })

  test("empty -> a message saying nothing blocks", async () => {
    const db = createMockDb({
      seed: {
        issuer_profiles: [{ id: ISSUER, legal_name: "Emetteur Fictif SAS", country: "FR", vat_id: "FR68900000001" }],
        documents: [doc("00000000-0000-4000-8000-0000000d0031", C_OK, { counterparty_name: "Ok Fictif", ...billed })],
        counterparty_identities: [confirmed(C_OK, FICTIONAL_SIRENS[0])],
      },
    })
    const r = await run(db)
    expect(r.items).toEqual([])
    expect(r.count).toBe(0)
    expect(r.message).toContain("Nothing blocks e-invoicing")
  })
})
