// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Every gated invoicing tool's approval card says what approving it does, in words a person
// can decide on: the document by number and type, the customer by name, money with its
// currency, the order by its store name, an edit as before -> after. No raw id, gid, JSON,
// snake_case field name or minor-unit amount; no dash punctuation.
//
// The card is built the way the kernel builds it: the tool's declared summarizer (manifest
// `summarizer`), fed the read its `summarizerContext` names; a tool that declares none gets
// the kernel's fallback, a "field: value" dump (replicated here from
// apps/api/src/modules/apps/approval-summarizers.ts defaultSummary), which these tests reject.

import { describe, expect, it } from "bun:test"
import manifest from "../app.manifest.json"
import * as summarizers from "./summarizers"

type Card = { kind: string; title: string; subtitle?: string; lines: string[]; links?: Array<{ label: string; entityId?: string }> }
type Tool = { gated?: boolean; summarizer?: string; summarizerContext?: { tool: string; params: Record<string, string> } }
const TOOLS = (manifest as unknown as { tools: Record<string, Tool> }).tools

/** The kernel's fallback card for a gated tool with no summarizer. */
function kernelFallback(toolName: string, params: Record<string, unknown>): Card {
  const compact = (v: unknown): string => {
    if (v === null || v === undefined) return "(none)"
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v)
    if (Array.isArray(v)) return v.length === 0 ? "(empty list)" : `${v.length} item${v.length === 1 ? "" : "s"}`
    return JSON.stringify(v)
  }
  return {
    kind: toolName,
    title: `invoicing:${toolName}`,
    subtitle: "Pending approval",
    lines: Object.entries(params).slice(0, 7).map(([k, v]) => `${k}: ${compact(v)}`.slice(0, 200)),
  }
}

async function cardFor(toolName: string, params: Record<string, unknown>, context: unknown = null): Promise<Card> {
  const tool = TOOLS[toolName]
  expect(tool).toBeDefined()
  const fn = tool!.summarizer ? (summarizers as Record<string, unknown>)[tool!.summarizer] : undefined
  if (typeof fn !== "function") return kernelFallback(toolName, params)
  return (await (fn as (p: unknown, c: unknown, m: unknown) => Promise<Card>)(params, undefined, { context })) as Card
}

function visible(card: Card): string {
  return [card.title, card.subtitle ?? "", ...card.lines, ...(card.links ?? []).map((l) => l.label)].join("\n")
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** The card reads as words: no handle, no JSON, no field names, no dash punctuation. */
function expectHuman(card: Card, rawMinor: string[] = []) {
  const t = visible(card)
  expect(t).not.toMatch(UUID)
  expect(t).not.toMatch(/gid:\/\//)
  expect(t).not.toMatch(/[{}"]|\[object/)
  expect(t).not.toMatch(/\b[a-z]+_[a-z_]+\b/) // snake_case field name
  expect(t).not.toMatch(/[–—]|--/)
  expect(t).not.toContain("Pending approval")
  for (const raw of rawMinor) expect(t).not.toMatch(new RegExp(`(?<![\\d.,])${raw}(?![\\d.,])`))
  expect(card.lines.length).toBeGreaterThan(0)
  expect(card.lines.length).toBeLessThanOrEqual(8)
  for (const l of card.lines) expect(l.length).toBeLessThanOrEqual(200)
}

const DOC_ID = "f620184e-1c7a-4d2b-9a51-3f0d2a9b7c11"
const ISSUER_ID = "0b9c3e1a-7d5f-4a8e-9c21-6e4f8a2d1b30"
const ORDER_GID = "gid://shopify/Order/6123456789012"

const proforma = {
  id: DOC_ID,
  type: "proforma",
  number: "PRO-2026-0029",
  status: "sent",
  currency: "USD",
  subtotal_minor: "0",
  tax_total_minor: "0",
  grand_total_minor: "0",
  payment_status: "unpaid",
  tax_treatment: "us_export",
  counterparty_name: "Thomas Raz",
  counterparty_email: "thomas@raz.example",
  counterparty_country: "US",
  shopify_order_id: ORDER_GID,
  shopify_order_number: "#3446",
  due_at: "2026-11-01",
  lines: [{ id: "a1b2c3d4-0000-4000-8000-000000000001", description: "Kestrel 6", quantity: "1", unit_price_minor: "0", discount_minor: "0" }],
}

const invoice = {
  ...proforma,
  type: "invoice",
  number: "INV-2026-3531",
  currency: "EUR",
  subtotal_minor: "34950",
  tax_total_minor: "6990",
  grand_total_minor: "41940",
  tax_treatment: "eu_domestic",
  counterparty_name: "Atelier Sonore",
  counterparty_email: "compta@ateliersonore.example",
  counterparty_country: "FR",
  shopify_order_number: "#3502",
}

const draft = { ...invoice, number: null, status: "draft", grand_total_minor: "41940" }

const issuers = { items: [{ id: ISSUER_ID, legal_name: "Resonant Audio Labs", default_currency: "EUR", iban: "FR7600000000000000000000001", invoice_approval_threshold_minor: "100000" }] }

describe("invoicing approval cards: edits", () => {
  it("documents_update names the document, the customer and the total before -> after", async () => {
    const card = await cardFor(
      "documents_update",
      { id: DOC_ID, lines: [{ description: "Kestrel 6", quantity: 1, unit_price_minor: 100 }] },
      proforma,
    )
    expect(card.title).toBe("Change proforma PRO-2026-0029 (Thomas Raz) total from 0.00 USD to 1.00 USD")
    expect(card.lines).toContain("Total: 0.00 USD -> 1.00 USD")
    expect(card.lines).toContain("Line 1: Kestrel 6 x 1 @ 0.00 USD -> Kestrel 6 x 1 @ 1.00 USD")
    expect(card.lines).toContain("Order: #3446")
    expect(card.lines).toContain("Customer: Thomas Raz")
    expect(card.links?.[0]?.label).toBe("Open proforma PRO-2026-0029")
    expectHuman(card, ["100"])
  })

  it("documents_update shows each changed field by name, before -> after, and skips unchanged ones", async () => {
    const card = await cardFor(
      "documents_update",
      { id: DOC_ID, counterparty_email: "billing@raz.example", due_at: "2026-12-01", counterparty_contact_id: ISSUER_ID, incoterm: undefined, notes: null, counterparty_name: "Thomas Raz" },
      proforma,
    )
    expect(card.title).toContain("Edit proforma PRO-2026-0029 (Thomas Raz)")
    expect(card.lines).toContain("Customer email: thomas@raz.example -> billing@raz.example")
    expect(card.lines).toContain("Due date: 2026-11-01 -> 2026-12-01")
    expect(card.lines).toContain("Linked contact: (none) -> (a contact)")
    expect(visible(card)).not.toContain("Customer name:")
    expectHuman(card)
  })

  it("documents_update with tax names the subtotal, never a guessed total", async () => {
    const card = await cardFor("documents_update", { id: DOC_ID, lines: [{ description: "Kestrel 6", quantity: 2, unit_price_minor: 34950 }] }, invoice)
    expect(card.title).toBe("Change invoice INV-2026-3531 (Atelier Sonore) subtotal from 349.50 EUR to 699.00 EUR")
    expectHuman(card, ["34950", "69900"])
  })

  it("documents_update still reads as words when the document could not be read", async () => {
    const card = await cardFor("documents_update", { id: DOC_ID, po_number: "PO 77", lines: [{ description: "Kestrel 6", quantity: 1, unit_price_minor: 100 }] })
    expect(card.lines).toContain("Customer PO number: set to PO 77")
    expectHuman(card, ["100"])
  })

  it("settings_issuer_profile_update shows each setting by its name, money formatted", async () => {
    const card = await cardFor(
      "settings_issuer_profile_update",
      { id: ISSUER_ID, iban: "FR7611111111111111111111111", invoice_approval_threshold_minor: 500000, require_two_eyes: true },
      issuers,
    )
    expect(card.title).toBe("Change issuer profile Resonant Audio Labs")
    expect(card.lines).toContain("IBAN: FR7600000000000000000000001 -> FR7611111111111111111111111")
    expect(card.lines).toContain("Invoice approval threshold: 1000.00 EUR -> 5000.00 EUR")
    expect(card.lines).toContain("Two people must approve: (empty) -> yes")
    expectHuman(card, ["500000", "100000"])
  })

  it("settings_issuer_profile_delete names the profile it deletes", async () => {
    const card = await cardFor("settings_issuer_profile_delete", { id: ISSUER_ID }, issuers)
    expect(card.title).toBe("Delete issuer profile Resonant Audio Labs")
    expectHuman(card)
  })
})

describe("invoicing approval cards: issuing", () => {
  it("proforma_create_and_issue: customer, amount and order in one sentence, from a JSON counterparty string", async () => {
    const card = await cardFor(
      "proforma_create_and_issue",
      {
        counterparty: JSON.stringify({ legal_name: "Thomas Raz", country: "US", email: "thomas@raz.example" }),
        items: [{ description: "Kestrel 6", quantity: 1, unit_price_minor: 100 }],
        reason: "Customs value for the replacement unit",
        declared_value_minor: 100,
        issuer_profile_id: ISSUER_ID,
        currency: "USD",
        shopify_order_id: ORDER_GID,
        shopify_order_number: "3446",
      },
      issuers,
    )
    expect(card.title).toBe("Issue proforma for Thomas Raz, 1.00 USD, order #3446")
    expect(card.lines).toContain("Customer: Thomas Raz")
    expect(card.lines).toContain("Order: #3446")
    expect(card.lines).toContain("Declared customs value: 1.00 USD")
    expect(card.lines).toContain("Line: Kestrel 6 x 1 @ 1.00 USD")
    expect(card.lines).toContain("Issued by: Resonant Audio Labs")
    expectHuman(card, ["100"])
  })

  it("invoice_create_and_issue names the customer and the lines total, many lines summarised", async () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ description: `Pad ${i + 1}`, quantity: 1, unit_price_minor: 1000 }))
    const card = await cardFor("invoice_create_and_issue", { counterparty: { legal_name: "Atelier Sonore", country: "FR" }, items, currency: "EUR" }, issuers)
    expect(card.title).toBe("Issue invoice for Atelier Sonore, 90.00 EUR")
    expect(card.lines.some((l) => /^and \d+ more lines$/.test(l))).toBe(true)
    expectHuman(card, ["1000", "9000"])
  })

  for (const [tool, type] of [["invoice_issue", "invoice"], ["quote_issue", "quote"], ["proforma_issue", "proforma"]] as const) {
    it(`${tool}: issues the saved draft for its customer, total and order, no draft id`, async () => {
      const card = await cardFor(tool, { draft_id: DOC_ID }, { ...draft, type })
      expect(card.title).toBe(`Issue ${type} for Atelier Sonore, 419.40 EUR, order #3502`)
      expect(card.lines).toContain(`Document: new ${type} from a saved draft (number assigned on issue)`)
      expect(card.lines).toContain("Total: 419.40 EUR")
      expectHuman(card, ["41940"])
    })
  }
})

describe("invoicing approval cards: money on issued documents", () => {
  it("documents_record_refund: amount, document and customer", async () => {
    const card = await cardFor("documents_record_refund", { document_id: DOC_ID, refund_amount_minor: 41940, refund_kind: "full" }, invoice)
    expect(card.title).toBe("Record a full refund of 419.40 EUR on invoice INV-2026-3531 (Atelier Sonore)")
    expect(card.lines).toContain("Order: #3502")
    expectHuman(card, ["41940"])
  })

  it("documents_mark_paid: document, customer and total", async () => {
    const card = await cardFor("documents_mark_paid", { document_id: DOC_ID, paid_date: "2026-10-15" }, invoice)
    expect(card.title).toBe("Mark invoice INV-2026-3531 (Atelier Sonore) as paid, 419.40 EUR")
    expect(card.lines).toContain("Paid on: 2026-10-15")
    expectHuman(card, ["41940"])
  })

  it("documents_convert_to_invoice: the quote it converts, for whom and how much", async () => {
    const card = await cardFor("documents_convert_to_invoice", { source_document_id: DOC_ID }, { ...invoice, type: "quote", number: "QUO-2026-0007", shopify_draft_order_name: "#D12" })
    expect(card.title).toBe("Convert quote QUO-2026-0007 (Atelier Sonore) into an invoice, 419.40 EUR")
    expect(card.lines).toContain("Shopify draft order #D12 is completed in Shopify with payment pending")
    expectHuman(card, ["41940"])
  })

  it("documents_send_to_customer: what is sent, to which address", async () => {
    const card = await cardFor("documents_send_to_customer", { document_id: DOC_ID }, invoice)
    expect(card.title).toBe("Email invoice INV-2026-3531 to compta@ateliersonore.example")
    expect(card.lines).toContain("Total: 419.40 EUR")
    expectHuman(card, ["41940"])
  })

  it("order_reissue_apply: the invoice it reverses and the order", async () => {
    const card = await cardFor(
      "order_reissue_apply",
      { original_document_id: DOC_ID, shopify_order_id: ORDER_GID, shopify_order_number: "#3502", billing_signature: "abc", dedupe_key: "k", currency: "EUR", items: [{ description: "Kestrel 6", quantity: 1, unit_price_minor: 30000 }] },
      invoice,
    )
    expect(card.title).toBe("Reissue invoice INV-2026-3531 for the edited order #3502")
    expectHuman(card, ["41940", "30000"])
  })
})

describe("invoicing approval cards: e-invoicing and customer settings", () => {
  it("einvoice_send names the invoice and its customer", async () => {
    const card = await cardFor("einvoice_send", { document_id: DOC_ID, legal_original_sha256: "ab".repeat(32), buyer_siren: "552100554", routing_address: "552100554_ROUTE" }, invoice)
    expect(card.title).toBe("Send invoice INV-2026-3531 (Atelier Sonore) as an e-invoice")
    expect(card.lines).toContain("Buyer SIREN: 552100554")
    expectHuman(card)
  })

  it("received_einvoice_set_status names the supplier invoice", async () => {
    const card = await cardFor(
      "received_einvoice_set_status",
      { received_id: DOC_ID, action: "refuse", reason: "DOUBLON" },
      { status: "ok", invoice: { supplier: { name: "Fournitures Martin" }, invoice_number: "FM-881", issue_date: "2026-10-02", currency: "EUR", totals: { total: "12000" } } },
    )
    expect(card.title).toBe("Refuse supplier invoice FM-881 from Fournitures Martin")
    expect(card.lines).toContain("Total: 120.00 EUR")
    expectHuman(card, ["12000"])
  })

  it("deferred_tax_override names the order and the tax source in words", async () => {
    const card = await cardFor("deferred_tax_override", { deferred_id: "77", mode: "shopify_reported" }, { items: [{ id: "77", order_number: "#3510", reason: "shopify_tax_mismatch" }] })
    expect(card.title).toBe("Issue the invoice for order #3510 with the tax Shopify reported on each line")
    expectHuman(card)
  })

  it("counterparty_territory_set names the customer and the treatment in words", async () => {
    const card = await cardFor("counterparty_territory_set", { contact_id: DOC_ID, treatment: "as_foreign", reason: "Ships to Geneva" }, { counterparty_name: "Atelier Sonore" })
    expect(card.title).toBe("Treat Atelier Sonore as a foreign customer (export or EU rules)")
    expectHuman(card)
  })

  it("einvoicing settings and backfills read as settings, not field names", async () => {
    const settings = await cardFor("einvoicing_settings_set", { gate_mode: "enforce", send_enabled: true, cutover_date: "2026-09-01", provider_app: "pennylane" })
    expect(settings.lines).toContain("Send e-invoices: on")
    expect(settings.lines).toContain("E-invoicing platform: Pennylane")
    expectHuman(settings)
    expectHuman(await cardFor("einvoicing_backfill_identities", { dry_run: false, limit: 50 }))
    expectHuman(await cardFor("einvoicing_backfill_legacy_originals", { dry_run: true }))
    expectHuman(await cardFor("einvoice_book_batch", { batch_id: DOC_ID }))
  })
})

describe("invoicing approval cards: coverage", () => {
  it("every gated invoicing tool declares an exported summarizer (no kernel field dump)", () => {
    const missing = Object.entries(TOOLS)
      .filter(([, t]) => t.gated === true)
      .filter(([, t]) => !t.summarizer || typeof (summarizers as Record<string, unknown>)[t.summarizer] !== "function")
      .map(([n]) => n)
    expect(missing).toEqual([])
  })

  it("every summarizer context names an ungated read of this app", () => {
    for (const [name, t] of Object.entries(TOOLS)) {
      if (!t.summarizerContext) continue
      const read = TOOLS[t.summarizerContext.tool]
      expect({ name, read: !!read, gated: read?.gated === true }).toEqual({ name, read: true, gated: false })
    }
  })
})

describe("invoicing approval cards: a quote staged before it is issued", () => {
  it("quote_create_and_issue states the customer, each line with its discount, the total, validity and customer ref", async () => {
    const card = await cardFor(
      "quote_create_and_issue",
      {
        issuer_profile_id: ISSUER_ID,
        counterparty: { legal_name: "Northwind Acoustics", country: "PT", email: "ines@northwind.example" },
        customer_reference: "CRM-1042",
        due_at: "2026-11-30",
        items: [{ description: "Kestrel 6", quantity: 40, unit_price_minor: 89900, discount_minor: 1366480 }],
      },
      issuers,
    )
    expectHuman(card, ["89900", "1366480"])
    expect(card.title).toContain("Issue quote for Northwind Acoustics")
    const t = visible(card)
    expect(t).toContain("Customer: Northwind Acoustics")
    expect(t).toMatch(/Line: Kestrel 6 x 40 @ .*899.*less .*13.?664/)
    expect(t).toMatch(/Lines total: .*22.?295/)
    expect(t).toContain("Customer ref: CRM-1042")
    expect(t).toContain("Valid until: 2026-11-30")
    expect(t).toContain("Issued by: Resonant Audio Labs")
  })
})

