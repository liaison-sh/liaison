// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, test } from "bun:test"
import { classifySaleTax, type SaleTaxInput, saleTaxSettings, supplyDateOf } from "./sale-tax"
import { resolveLegalMention } from "./tax"

type Buyer = SaleTaxInput["buyer"]

function sale(buyer: Partial<Buyer>, lines?: SaleTaxInput["lines"]): SaleTaxInput {
  return {
    issuer_country: "FR",
    buyer: {
      kind: "individual",
      country: "DE",
      vat_id: null,
      vat_id_valid: null,
      tax_evidence: { billing_country: "DE", ip_country: "DE", card_country: "DE" },
      ...buyer,
    },
    lines: lines ?? [{ kind: "software", subtotal_minor: 10000n, source_tax_minor: 1900n }],
  }
}

describe("classifySaleTax: a consumer's electronic services", () => {
  test("EU consumer: OSS at the member state's rate, two pieces of evidence kept", () => {
    const r = classifySaleTax(sale({}))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.treatment).toBe("eu_b2c_oss")
    expect(r.operation_category).toBe("services")
    expect(r.line_rates_bp).toEqual([1900])
    expect(r.place_of_supply).toMatchObject({
      country: "DE",
      rule: "consumer_residence",
      agreeing: ["billing_country", "ip_country", "card_country"],
    })
  })

  test("two agreeing pieces suffice even when a third points elsewhere", () => {
    const r = classifySaleTax(
      sale({ tax_evidence: { billing_country: "DE", ip_country: "NL", card_country: "DE" } }),
    )
    expect(r.ok && r.place_of_supply.agreeing).toEqual(["billing_country", "card_country"])
  })

  test("one piece of evidence parks, unless the issuer may rely on one", () => {
    const one = sale({ tax_evidence: { billing_country: "DE", ip_country: "BE" } })
    const r = classifySaleTax(one)
    expect(r.ok ? null : r.park).toBe("place_of_supply_evidence")
    expect(classifySaleTax({ ...one, single_evidence_allowed: true }).ok).toBe(true)
  })

  test("a source rate other than the member state's parks as a mismatch", () => {
    const r = classifySaleTax(
      sale({}, [{ kind: "software", subtotal_minor: 10000n, source_tax_minor: 700n }]),
    )
    expect(r.ok ? null : r.park).toBe("sale_tax_mismatch")
  })

  test("French consumer: domestic 20 %", () => {
    const r = classifySaleTax(
      sale({ country: "FR", tax_evidence: { billing_country: "FR", ip_country: "FR" } }, [
        { kind: "software", subtotal_minor: 10000n, source_tax_minor: 2000n },
      ]),
    )
    expect(r.ok && [r.treatment, r.line_rates_bp]).toEqual(["eu_domestic", [2000]])
  })

  test("consumer outside the EU: outside French VAT at 0 %, in USD as any currency", () => {
    const r = classifySaleTax(
      sale({ country: "US", tax_evidence: { billing_country: "US", ip_country: "US" } }, [
        { kind: "software", subtotal_minor: 1999n, source_tax_minor: 0n },
      ]),
    )
    expect(r.ok && [r.treatment, r.line_rates_bp]).toEqual(["eu_export_non_eu", [0]])
  })

  test("tax collected abroad (a UK registration) is a person's call", () => {
    const r = classifySaleTax(
      sale({ country: "GB", tax_evidence: { billing_country: "GB", ip_country: "GB" } }, [
        { kind: "software", subtotal_minor: 1000n, source_tax_minor: 200n },
      ]),
    )
    expect(r.ok ? null : r.park).toBe("foreign_tax_collected")
  })

  test("a service that is not electronic, sold to a consumer abroad, parks", () => {
    const r = classifySaleTax(
      sale({}, [{ kind: "service", subtotal_minor: 5000n, source_tax_minor: null }]),
    )
    expect(r.ok ? null : r.park).toBe("service_place_of_supply_review")
  })
})

describe("classifySaleTax: the issuer profile's VAT settings", () => {
  test("the settings read off an issuer profile, both off by default", () => {
    expect(saleTaxSettings({})).toEqual({
      single_evidence_allowed: false,
      eu_b2c_below_threshold: false,
    })
    expect(
      saleTaxSettings({ vat_single_evidence: true, vat_eu_b2c_below_threshold: true }),
    ).toEqual({ single_evidence_allowed: true, eu_b2c_below_threshold: true })
  })

  test("small seller (art. 24b(d)): one piece of evidence is enough, still none is not", () => {
    const one = sale({ tax_evidence: { billing_country: "DE", ip_country: "BE" } })
    const small = { ...one, ...saleTaxSettings({ vat_single_evidence: true }) }
    const r = classifySaleTax(small)
    expect(r.ok && [r.treatment, r.place_of_supply.agreeing]).toEqual([
      "eu_b2c_oss",
      ["billing_country"],
    ])
    const none = { ...sale({ tax_evidence: { ip_country: "BE" } }), single_evidence_allowed: true }
    expect(classifySaleTax(none).ok ? null : (classifySaleTax(none) as { park: string }).park).toBe(
      "place_of_supply_evidence",
    )
  })

  test("setting off: one piece of evidence still parks (two needed)", () => {
    const one = sale({ tax_evidence: { billing_country: "DE", ip_country: "BE" } })
    const r = classifySaleTax({ ...one, ...saleTaxSettings({ vat_single_evidence: false }) })
    expect(r.ok ? null : r.park).toBe("place_of_supply_evidence")
  })

  test("under EUR 10,000 and not in the OSS (art. 59c): an EU consumer pays the French rate", () => {
    const r = classifySaleTax({
      ...sale({}, [{ kind: "software", subtotal_minor: 10000n, source_tax_minor: 2000n }]),
      eu_b2c_below_threshold: true,
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.treatment).toBe("eu_domestic")
    expect(r.line_rates_bp).toEqual([2000])
    expect(r.place_of_supply).toMatchObject({ country: "FR", rule: "seller_establishment" })
  })

  test("under the threshold, goods distance sales are French VAT too (CGI 258 A)", () => {
    const r = classifySaleTax({
      ...sale({ tax_evidence: null }, [
        { kind: "goods", subtotal_minor: 10000n, source_tax_minor: 2000n },
      ]),
      eu_b2c_below_threshold: true,
    })
    expect(r.ok && [r.treatment, r.line_rates_bp]).toEqual(["eu_domestic", [2000]])
  })

  test("an OSS-registered profile (setting off) never falls back to the French rate", () => {
    const r = classifySaleTax({
      ...sale({}, [{ kind: "software", subtotal_minor: 10000n, source_tax_minor: 2000n }]),
      ...saleTaxSettings({ vat_eu_b2c_below_threshold: false }),
    })
    // Stripe charged 20 % to a German consumer: under the OSS that is a mismatch, never FR VAT.
    expect(r.ok ? null : r.park).toBe("sale_tax_mismatch")
    const right = classifySaleTax(sale({}))
    expect(right.ok && [right.treatment, right.line_rates_bp]).toEqual(["eu_b2c_oss", [1900]])
  })

  test("the threshold changes nothing for businesses or consumers outside the EU", () => {
    const b2b = classifySaleTax({
      ...sale({ kind: "company", vat_id: "DE123456789", vat_id_valid: true }, [
        { kind: "software", subtotal_minor: 10000n, source_tax_minor: 0n },
      ]),
      eu_b2c_below_threshold: true,
    })
    expect(b2b.ok && b2b.treatment).toBe("eu_reverse_charge")
    const us = classifySaleTax({
      ...sale({ country: "US", tax_evidence: { billing_country: "US", ip_country: "US" } }, [
        { kind: "software", subtotal_minor: 1999n, source_tax_minor: 0n },
      ]),
      eu_b2c_below_threshold: true,
    })
    expect(us.ok && us.treatment).toBe("eu_export_non_eu")
  })
})

describe("classifySaleTax: UK and Swiss consumers with no tax collected", () => {
  for (const country of ["GB", "CH"]) {
    test(`${country}: outside French VAT at 0 %, not held`, () => {
      const r = classifySaleTax(
        sale({ country, tax_evidence: { billing_country: country, card_country: country } }, [
          { kind: "software", subtotal_minor: 2500n, source_tax_minor: 0n },
        ]),
      )
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.treatment).toBe("eu_export_non_eu")
      expect(r.customer_kind).toBe("individual")
      expect(r.operation_category).toBe("services")
      expect(r.line_rates_bp).toEqual([0])
      expect(
        resolveLegalMention(r.treatment, "fr", {
          category: r.operation_category,
          customerKind: r.customer_kind,
          issueDate: "2026-12-01",
        }),
      ).toBe("TVA non applicable, art. 259 B du CGI")
    })
  }
})

describe("classifySaleTax: businesses", () => {
  const be = (over: Partial<Buyer> = {}, tax = 0n) =>
    sale({ kind: "company", country: "BE", vat_id: "BE0123456789", vat_id_valid: true, ...over }, [
      { kind: "software", subtotal_minor: 10000n, source_tax_minor: tax },
    ])

  test("a valid EU VAT number with the source's reverse charge: reverse charge at 0 %", () => {
    const r = classifySaleTax(be({ tax_exempt: "reverse" }))
    expect(r.ok && [r.treatment, r.customer_kind, r.line_rates_bp]).toEqual([
      "eu_reverse_charge",
      "business",
      [0],
    ])
  })

  test("VAT the source charged on a reverse charge sale parks", () => {
    expect(classifySaleTax(be({}, 2100n))).toMatchObject({ ok: false, park: "sale_tax_mismatch" })
  })

  test("a VAT number not checked yet, or refused by VIES, never becomes a reverse charge", () => {
    expect(classifySaleTax(be({ vat_id_valid: null }))).toMatchObject({
      park: "buyer_vat_unverified",
    })
    expect(classifySaleTax(be({ vat_id_valid: false }))).toMatchObject({
      park: "buyer_vat_invalid",
    })
  })

  test("a reverse charge claimed with no VAT number parks", () => {
    expect(
      classifySaleTax(be({ vat_id: null, vat_id_valid: null, tax_exempt: "reverse" })),
    ).toMatchObject({ park: "buyer_vat_missing" })
  })

  test("a French business: domestic 20 %", () => {
    const r = classifySaleTax(
      sale({ kind: "company", country: "FR", vat_id: "FR40303265045", vat_id_valid: true }, [
        { kind: "software", subtotal_minor: 10000n, source_tax_minor: 2000n },
      ]),
    )
    expect(r.ok && r.treatment).toBe("eu_domestic")
  })

  test("a business outside the EU: outside the scope, no evidence needed", () => {
    const r = classifySaleTax(
      sale(
        {
          kind: "company",
          country: "CH",
          vat_id: "CHE123456789",
          vat_id_valid: true,
          tax_evidence: null,
        },
        [{ kind: "software", subtotal_minor: 10000n, source_tax_minor: 0n }],
      ),
    )
    expect(r.ok && [r.treatment, r.place_of_supply.rule]).toEqual([
      "eu_export_non_eu",
      "customer_establishment",
    ])
  })
})

describe("goods to consumers", () => {
  test("distance sale of goods: OSS without electronic-services evidence", () => {
    const r = classifySaleTax(
      sale({ country: "IT", tax_evidence: null }, [
        { kind: "goods", subtotal_minor: 10000n, source_tax_minor: 2200n },
        { kind: "shipping", subtotal_minor: 1000n, source_tax_minor: 220n },
      ]),
    )
    expect(r.ok && [r.treatment, r.operation_category, r.place_of_supply.rule]).toEqual([
      "eu_b2c_oss",
      "goods",
      "goods_arrival",
    ])
  })
})

describe("the mention of services supplied outside the EU", () => {
  test("services outside the EU no longer read as an export of goods, from the wording's date", () => {
    const services = resolveLegalMention("eu_export_non_eu", "fr", {
      category: "services",
      issueDate: "2026-12-01",
    })
    expect(services).toContain("259-1")
    expect(services).not.toContain("262 I")
    const mixed = resolveLegalMention("eu_export_non_eu", "en", {
      category: "mixed",
      issueDate: "2026-12-01",
    })
    expect(mixed).toContain("Article 146")
    expect(mixed).toContain("place of supply")
    // Documents issued before keep the wording they were issued with on every re-render.
    expect(
      resolveLegalMention("eu_export_non_eu", "fr", {
        category: "services",
        issueDate: "2026-11-20",
      }),
    ).toContain("262 I")
    expect(
      resolveLegalMention("eu_export_non_eu", "fr", { category: "goods", issueDate: "2026-12-01" }),
    ).toContain("262 I")
  })
})

describe("the mention of digital services to a consumer outside the EU", () => {
  test("art. 259 B in French and English, from its date", () => {
    const opts = {
      category: "services" as const,
      customerKind: "individual",
      issueDate: "2026-11-28",
    }
    expect(resolveLegalMention("eu_export_non_eu", "fr", opts)).toBe(
      "TVA non applicable, art. 259 B du CGI",
    )
    expect(resolveLegalMention("eu_export_non_eu", "en", opts)).toBe(
      "VAT not applicable, art. 259 B of the French Tax Code",
    )
  })

  test("documents issued before keep their wording", () => {
    expect(
      resolveLegalMention("eu_export_non_eu", "fr", {
        category: "services",
        customerKind: "individual",
        issueDate: "2026-11-27",
      }),
    ).toContain("262 I")
  })

  test("a business outside the EU keeps the B2B wording", () => {
    const b2b = resolveLegalMention("eu_export_non_eu", "fr", {
      category: "services",
      customerKind: "business",
      issueDate: "2026-12-01",
    })
    expect(b2b).toContain("259-1")
    expect(b2b).not.toContain("259 B")
  })

  test("a consumer's mixed sale prints the goods export and the 259 B mention", () => {
    const mixed = resolveLegalMention("eu_export_non_eu", "en", {
      category: "mixed",
      customerKind: "individual",
      issueDate: "2026-12-01",
    })
    expect(mixed).toContain("Article 146")
    expect(mixed).toContain("art. 259 B of the French Tax Code")
  })
})

// The services invoice of a split order carries the digital lines and the carriage of the goods
// shipped on the other invoice. Its mention follows each line's nature, never the art. 146
// export of goods mention the goods invoice prints.
describe("the mention of a services invoice that carries the carriage of exported goods", () => {
  const consumer = {
    category: "services" as const,
    customerKind: "individual",
    issueDate: "2026-11-28",
  }
  test("download + carriage to a consumer outside the EU: 259 B and the transport exemption", () => {
    const en = resolveLegalMention("eu_export_non_eu", "en", {
      ...consumer,
      lineKinds: ["software", "shipping"],
    })
    expect(en).toContain("art. 259 B of the French Tax Code")
    expect(en).toContain("art. 262 I 1°")
    expect(en).not.toContain("146")
    const fr = resolveLegalMention("eu_export_non_eu", "fr", {
      ...consumer,
      lineKinds: ["software", "shipping"],
    })
    expect(fr).toBe(
      "TVA non applicable, art. 259 B du CGI. Exonération de TVA, transport lié à l'exportation (article 262 I 1° du CGI)",
    )
  })
  test("carriage alone (an order of goods only): the transport exemption alone", () => {
    for (const category of ["goods", "services"] as const) {
      const fr = resolveLegalMention("eu_export_non_eu", "fr", {
        ...consumer,
        category,
        lineKinds: ["shipping"],
      })
      expect(fr).toBe("Exonération de TVA, transport lié à l'exportation (article 262 I 1° du CGI)")
    }
  })
  test("a business buyer: the B2B services wording and the transport exemption", () => {
    const fr = resolveLegalMention("eu_export_non_eu", "fr", {
      ...consumer,
      customerKind: "business",
      lineKinds: ["software", "shipping"],
    })
    expect(fr).toContain("259-1")
    expect(fr).toContain("262 I 1°")
    expect(fr).not.toContain("259 B")
  })
  test("an EU consumer: OSS covers the download and the carriage", () => {
    expect(
      resolveLegalMention("eu_b2c_oss", "en", { ...consumer, lineKinds: ["software", "shipping"] }),
    ).toBe("VAT collected under the EU One-Stop-Shop (OSS) scheme.")
  })
  test("a goods invoice with its carriage keeps the export of goods mention", () => {
    expect(
      resolveLegalMention("eu_export_non_eu", "en", {
        ...consumer,
        category: "goods",
        lineKinds: ["goods", "shipping"],
      }),
    ).toContain("Article 146")
  })
  test("documents issued before keep their wording", () => {
    expect(
      resolveLegalMention("eu_export_non_eu", "fr", {
        ...consumer,
        category: "goods",
        issueDate: "2026-11-27",
        lineKinds: ["shipping"],
      }),
    ).toBe("Exportation hors Union européenne : exonération de TVA (article 262 I du CGI)")
  })
})

describe("supplyDateOf", () => {
  const ctx = {
    time: {
      civil: async (p: { timezone?: string; at?: string | number }) => {
        // Europe/Paris in winter is UTC+1.
        const d = new Date(new Date(String(p.at)).getTime() + 3600_000)
        return { date: d.toISOString().slice(0, 10) } as never
      },
    },
  }
  test("the issuer's civil date of the payment instant", async () => {
    expect(await supplyDateOf(ctx, { timezone: "Europe/Paris" }, "2026-11-20T23:30:00Z")).toBe(
      "2026-11-21",
    )
    expect(await supplyDateOf(ctx, { timezone: "Europe/Paris" }, "2026-11-20")).toBe("2026-11-20")
    await expect(supplyDateOf(ctx, {}, "yesterday")).rejects.toThrow()
  })
})
