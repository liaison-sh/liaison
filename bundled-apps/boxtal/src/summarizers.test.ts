// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { summarizeCancelShipment, summarizeClaimOpen, summarizeCreateShipment, summarizeSettleOrphanCreate } from "./summarizers"

describe("summarizeCreateShipment — outbound vs return, address completeness", () => {
  it("names the order, its document and the recipient in the title, never only the draft id", async () => {
    const s = await summarizeCreateShipment(
      { draft_id: "3f2a9c1e-0000-4000-8000-000000000001", offer_code: "UPSE-Standard", quoted_price_ttc: 18.4 },
      undefined,
      {
        connectionIdentifier: null,
        context: {
          draft_id: "3f2a9c1e-0000-4000-8000-000000000001",
          recipient: "Alice Example",
          order_name: "#3360",
          document_number: "INV-2026-0042",
          parcels: [{ length: 59, width: 38, height: 11, weight: 4.252 }],
        },
      },
    )
    expect(s.title).toBe("Buy label for order #3360 (INV-2026-0042), Alice Example, via UPSE-Standard")
    expect(s.title).not.toContain("3f2a9c1e")
  })

  it("lists every parcel of a multi-parcel purchase and carries the packing warnings", async () => {
    const s = await summarizeCreateShipment(
      { draft_id: "d-2", offer_code: "ups", quoted_price_ttc: 40 },
      undefined,
      {
        connectionIdentifier: null,
        context: {
          draft_id: "d-2",
          recipient: "Bob Example",
          order_name: "#3315",
          parcels: [
            { length: 60, width: 39, height: 38, weight: 21 },
            { length: 59, width: 38, height: 10, weight: 5.7 },
          ],
          packing_warnings: ["The 60x40x30 carton was used with an assumed tare of 0.5 kg."],
        },
      },
    )
    const joined = s.lines.join("\n")
    expect(joined).toContain("Package: 2 parcels, 26.70 kg total (60x39x38 cm 21 kg; 59x38x10 cm 5.7 kg)")
    expect(joined).toContain("Check the packing: The 60x40x30 carton was used with an assumed tare of 0.5 kg.")
  })

  it("names the draft, the chosen carrier offer, and the recipient when a full address is given", async () => {
    const s = await summarizeCreateShipment({
      draft_id: "draft-123",
      offer_code: "colissimo_domicile",
      recipient_address: {
        name: "Jane Doe",
        city: "Paris",
        countryIsoCode: "FR",
        street: "1 rue de Rivoli",
        postalCode: "75001",
      },
    })
    expect(s.title).toBe("Ship draft draft-123 via colissimo_domicile")
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Carrier: colissimo_domicile/)
    expect(joined).toMatch(/To: Jane Doe, 1 rue de Rivoli, 75001 Paris, FR/)
  })

  it("always shows the price line: quoted TTC when provided, a loud NOT PROVIDED otherwise", async () => {
    const withPrice = await summarizeCreateShipment({
      draft_id: "draft-123",
      offer_code: "FEDX-FedexRegionalEconomy",
      quoted_price_ttc: 25.27,
    })
    expect(withPrice.lines.join("\n")).toMatch(/Carrier: FEDX-FedexRegionalEconomy, 25\.27 EUR TTC/)
    const withoutPrice = await summarizeCreateShipment({
      draft_id: "draft-123",
      offer_code: "FEDX-FedexRegionalEconomy",
    })
    expect(withoutPrice.lines.join("\n")).toMatch(/Price: NOT PROVIDED/)
  })

  it("flags missing address fields instead of fabricating completeness", async () => {
    const s = await summarizeCreateShipment({
      draft_id: "draft-1",
      offer_code: "ups_express",
      recipient_address: { name: "Bob", city: "Lyon" },
    })
    expect(s.lines.join("\n")).toMatch(/still needed before the label is bought: street, postalCode, countryIsoCode/)
  })

  // Walk D47: the agent passed only the recipient's name and phone; the draft
  // carried the street, city and postal code, which the label buy uses (field
  // by field), yet the card listed them as still needed.
  it("reads each address field from the call, else from the draft, as the label buy does", async () => {
    const s = await summarizeCreateShipment(
      {
        draft_id: "doc-1097",
        offer_code: "UPSE-ExpressSaver",
        quoted_price_ttc: 66.6,
        recipient_address: { name: "Harborlight Audio KK", phone: "+81 45 100003" },
      },
      undefined,
      {
        context: {
          recipient: "Harborlight Audio KK",
          recipient_country: "JP",
          recipient_address: {
            name: "Harborlight Audio KK",
            street: "21 Yamashitacho",
            city: "Yokohama",
            postalCode: "231-0023",
            countryIsoCode: "JP",
            phone: null,
          },
        },
      },
    )
    const joined = s.lines.join("\n")
    expect(joined).not.toMatch(/still needed/)
    expect(joined).toMatch(/To: Harborlight Audio KK, 21 Yamashitacho, 231-0023 Yokohama, JP \(\+81 45 100003\)/)
  })

  it("is_return:true names it a reverse shipment and includes the return reason", async () => {
    const s = await summarizeCreateShipment({
      draft_id: "draft-9",
      offer_code: "chronopost",
      is_return: true,
      return_reason: "wrong item shipped",
    })
    expect(s.title).toBe("Stage return label for draft draft-9 via chronopost")
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/REVERSE shipment/)
    expect(joined).toMatch(/Return reason: wrong item shipped/)
  })

  it("never claims the shipment already happened", async () => {
    const s = await summarizeCreateShipment({ draft_id: "d1", offer_code: "ups" })
    expect(s.subtitle).toMatch(/Pending approval, nothing is shipped or bought yet/)
  })

  it("hydrates recipient, destination, package weight and customs flag from the draft context when no address param is given", async () => {
    const s = await summarizeCreateShipment(
      { draft_id: "draft-77", offer_code: "ups_express" },
      undefined,
      {
        connectionIdentifier: null,
        context: {
          draft_id: "draft-77",
          recipient: "Acme GmbH",
          recipient_country: "DE",
          recipient_address: { name: "Acme GmbH", city: "Berlin", countryIsoCode: "DE" },
          parcels: [{ weight: 2.5 }, { weight: 1.2 }],
          customs_required: true,
        },
      },
    )
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/To: Acme GmbH, Berlin, DE/)
    expect(joined).toMatch(/Package: 2 parcels, 3.70 kg total/)
    expect(joined).toMatch(/Customs declaration required \(export route\)/)
  })

  it("renders the rich card: From, To with phone, Contents, parcel dims, customs totals, invoice link", async () => {
    const s = await summarizeCreateShipment(
      { draft_id: "doc-42", offer_code: "FEDX-InternationalEconomy", quoted_price_ttc: 57.66, quoted_currency: "EUR" },
      undefined,
      {
        context: {
          draft_id: "doc-42",
          document_ref: "doc-42",
          recipient: "Stanley Fortson",
          recipient_country: "US",
          recipient_address: {
            name: "Stanley Fortson",
            street: "116 Chickasaw Dr.",
            city: "Crossville",
            postalCode: "38572",
            countryIsoCode: "US",
            phone: "+16155730921",
          },
          sender: {
            name: "Quinn Harper",
            company: "FABRIKAM",
            street: "81 rue des Exemples",
            city: "Paris",
            postalCode: "75018",
            countryIsoCode: "FR",
          },
          parcels: [{ length: 58, width: 38, height: 16, weight: 7.2 }],
          customs_required: true,
          customsArticles: [
            { quantity: "1.000", unitValue: { value: 899, currency: "USD" }, tariffNumber: "854370" },
            { quantity: "1.000", unitValue: { value: 99, currency: "USD" }, tariffNumber: "962000" },
          ],
          lineSummaries: [
            { label: "ET2", line_kind: "goods", quantity: 1 },
            { label: "MP", line_kind: "goods", quantity: 1 },
            { label: "SW", line_kind: "software", quantity: 1 },
          ],
          invoice_issued_at: "2026-07-09 00:00:00+00",
        },
      },
    )
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Carrier: FEDX-InternationalEconomy, 57\.66 EUR TTC/)
    expect(joined).toMatch(/From: FABRIKAM \/ Quinn Harper, 81 rue des Exemples, 75018 Paris, FR/)
    expect(joined).toMatch(/To: Stanley Fortson, 116 Chickasaw Dr\., 38572 Crossville, US \(\+16155730921\)/)
    expect(joined).toMatch(/Contents: 1x ET2, 1x MP/)
    expect(joined).not.toMatch(/1x SW/)
    expect(joined).toMatch(/Package: 1 parcel, 58x38x16 cm, 7\.20 kg total/)
    expect(joined).toMatch(/Invoice issued: 2026-07-09/)
    expect(joined).toMatch(/Customs export: 2 articles, declared 998\.00 USD, HS 854370, 962000/)
    expect(joined).not.toMatch(/still needed/)
    expect(s.lines.length).toBeLessThanOrEqual(8)
    expect(s.links).toEqual([{ label: "Open invoice", app: "invoicing", entityType: "detail", entityId: "doc-42" }])
  })

  it("falls back to the shipments-list link only when no draft id is known", async () => {
    const s = await summarizeCreateShipment({ offer_code: "ups" })
    expect(s.links?.[0]?.entityType).toBe("shipments")
  })

  it("prefers the params-supplied address over the hydrated draft context when both are present", async () => {
    const s = await summarizeCreateShipment(
      {
        draft_id: "draft-88",
        offer_code: "colissimo_domicile",
        recipient_address: { name: "Jane Doe", city: "Paris", countryIsoCode: "FR" },
      },
      undefined,
      {
        context: {
          recipient: "Someone Else",
          recipient_country: "ES",
        },
      },
    )
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/To: Jane Doe, Paris, FR/)
    expect(joined).not.toMatch(/Someone Else/)
  })

  it("degrades gracefully to params-only rendering when meta/context is absent", async () => {
    const s = await summarizeCreateShipment({ draft_id: "draft-99", offer_code: "chronopost" }, undefined, undefined)
    expect(s.title).toBe("Ship draft draft-99 via chronopost")
    expect(s.lines.join("\n")).toMatch(/taken from the source invoice/)
  })
})

describe("summarizeClaimOpen — claim type, amount, evidence count", () => {
  it("names the claim type, amount and evidence file count", async () => {
    const s = await summarizeClaimOpen({
      shipment_id: "ship-1",
      type: "lost",
      amount: 129.5,
      evidence_file_ids: ["f1", "f2"],
    })
    expect(s.title).toBe("Open lost claim for shipment ship-1")
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Claim type: lost/)
    expect(joined).toMatch(/Amount: 129.5/)
    expect(joined).toMatch(/Evidence files attached: 2/)
    expect(s.subtitle).toMatch(/no claim has been filed yet/)
  })

  it("hydrates the recipient and live tracking status from the shipment context", async () => {
    const s = await summarizeClaimOpen(
      { shipment_id: "ship-1", type: "lost", amount: 129.5, evidence_file_ids: ["f1"] },
      undefined,
      {
        context: {
          id: "ship-1",
          recipient_summary: "Jane Doe, Paris FR",
          tracking_status: "EXCEPTION",
        },
      },
    )
    expect(s.title).toBe("Open lost claim for shipment ship-1 (Jane Doe, Paris FR)")
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Recipient: Jane Doe, Paris FR/)
    expect(joined).toMatch(/Live tracking status: EXCEPTION/)
  })

  it("degrades gracefully when meta/context is absent", async () => {
    const s = await summarizeClaimOpen({ shipment_id: "ship-2", type: "damaged", amount: 40 })
    expect(s.title).toBe("Open damaged claim for shipment ship-2")
  })
})

describe("summarizeCancelShipment — names the shipment being stopped", () => {
  it("names the shipment id and clarifies cancellation is not a reship", async () => {
    const s = await summarizeCancelShipment({ id: "ship-42" })
    expect(s.title).toBe("Cancel shipment ship-42")
    expect(s.subtitle).toMatch(/no re-ship/)
  })

  it("hydrates the recipient and current status from the shipment context", async () => {
    const s = await summarizeCancelShipment({ id: "ship-42" }, undefined, {
      context: {
        id: "ship-42",
        recipient_summary: "Bob Smith, Lyon FR",
        order_status: "CONFIRMED",
      },
    })
    expect(s.title).toBe("Cancel shipment ship-42 (Bob Smith, Lyon FR)")
    const joined = s.lines.join("\n")
    expect(joined).toMatch(/Recipient: Bob Smith, Lyon FR/)
    expect(joined).toMatch(/Current status: CONFIRMED/)
  })

  it("degrades gracefully when meta/context is absent", async () => {
    const s = await summarizeCancelShipment({ id: "ship-43" }, undefined, undefined)
    expect(s.title).toBe("Cancel shipment ship-43")
  })
})

describe("summarizeSettleOrphanCreate: says which outcome the agent proposes", () => {
  it("release names the row and that the invoice is freed", async () => {
    const s = await summarizeSettleOrphanCreate({ id: "row-1", outcome: "release", note: "nothing in the dashboard" })
    expect(s.title).toBe("Release unfinished label purchase row-1")
    expect(s.subtitle).toMatch(/no label was bought/)
    expect(s.lines.join("\n")).toMatch(/Note: nothing in the dashboard/)
  })

  it("adopt names the Boxtal order", async () => {
    const s = await summarizeSettleOrphanCreate({ id: "row-1", outcome: "adopt", boxtal_order_id: "BX-9" })
    expect(s.title).toBe("Link unfinished label purchase row-1 to Boxtal order BX-9")
    expect(s.lines).toContain("Boxtal order: BX-9")
  })
})
