// SPDX-License-Identifier: FSL-1.1-ALv2
//
// French overseas VAT (DOM-TOM): one row per line of the decision table
// (docs/apps/invoicing.md, "Overseas France and Monaco"). Pure.
import { describe, expect, test } from "bun:test"
import { classifyRegime } from "./einvoicing/classify"
import { vatBreakdown } from "./facturx/vat-breakdown"
import { lineSubtotal, lineTax } from "./money"
import { type OverseasLine, overseasLineTax } from "./overseas-tax"
import { classifySaleTax, type SaleLineKind } from "./sale-tax"
import { classify, resolveLegalMention, type TaxTreatment } from "./tax"
import { frTerritoryRateBp, territoryKind, vatTerritoryOf } from "./vat-territory"

type Kind = "goods" | "software" | "service" | "shipping"

interface Row {
  /** The seller's country (and postcode, for a French seller overseas). */
  seller: string
  sellerPc?: string
  buyer: string
  buyerPc?: string
  /** A business buyer (a VAT number); a consumer otherwise. */
  b2b: boolean
  kinds: Kind[]
  treatment: TaxTreatment
  /** The rate of each kind present, basis points. */
  rates: Partial<Record<Kind, number>>
}

const r = (
  seller: string,
  buyer: string,
  b2b: boolean,
  kinds: Kind[],
  treatment: TaxTreatment,
  rates: Partial<Record<Kind, number>>,
  extra: Partial<Row> = {},
): Row => ({ seller, buyer, b2b, kinds, treatment, rates, ...extra })

const DOM_VAT = ["GP", "MQ", "RE"]
const DOM_VAT_PC: Array<[string, string]> = [
  ["97110", "GP"],
  ["97200", "MQ"],
  ["97411", "RE"],
]
const DOM_NO_VAT = ["GF", "YT"]
const COM = ["BL", "MF", "PM", "WF", "PF", "NC", "TF"]

const ROWS: Row[] = [
  // Seller in metropolitan France, buyer in a DOM with VAT (ISO code or FR + postcode).
  ...DOM_VAT.flatMap((c) => [
    r("FR", c, false, ["goods"], "eu_export_non_eu", { goods: 0 }),
    r("FR", c, true, ["goods"], "eu_export_non_eu", { goods: 0 }),
    r("FR", c, false, ["goods", "shipping"], "eu_export_non_eu", { goods: 0, shipping: 0 }),
    r("FR", c, false, ["software"], "eu_domestic", { software: 850 }),
    r("FR", c, true, ["software"], "eu_domestic", { software: 850 }),
    r("FR", c, true, ["service"], "eu_domestic", { service: 850 }),
    // A non-electronic service to a consumer: the seller's place (CGI 259-2°).
    r("FR", c, false, ["service"], "eu_domestic", { service: 2000 }),
    r("FR", c, false, ["software", "shipping"], "eu_domestic", { software: 850, shipping: 0 }),
    r("FR", c, false, ["goods", "software"], "eu_domestic", { goods: 0, software: 850 }),
  ]),
  ...DOM_VAT_PC.flatMap(([pc]) => [
    r("FR", "FR", false, ["goods"], "eu_export_non_eu", { goods: 0 }, { buyerPc: pc }),
    r("FR", "FR", false, ["software"], "eu_domestic", { software: 850 }, { buyerPc: pc }),
    r("FR", "FR", true, ["service"], "eu_domestic", { service: 850 }, { buyerPc: pc }),
  ]),
  // Guyane, Mayotte: VAT not applicable (CGI 294-1).
  ...DOM_NO_VAT.flatMap((c) => [
    r("FR", c, false, ["goods"], "eu_export_non_eu", { goods: 0 }),
    r("FR", c, false, ["software"], "eu_export_non_eu", { software: 0 }),
    r("FR", c, true, ["software"], "eu_export_non_eu", { software: 0 }),
    r("FR", c, true, ["service"], "eu_export_non_eu", { service: 0 }),
  ]),
  r("FR", "FR", false, ["software"], "eu_export_non_eu", { software: 0 }, { buyerPc: "97300" }),
  r("FR", "FR", false, ["goods"], "eu_export_non_eu", { goods: 0 }, { buyerPc: "97600" }),
  // Overseas collectivities: third territories.
  ...COM.flatMap((c) => [
    r("FR", c, false, ["goods"], "eu_export_non_eu", { goods: 0 }),
    r("FR", c, false, ["software"], "eu_export_non_eu", { software: 0 }),
    r("FR", c, true, ["service"], "eu_export_non_eu", { service: 0 }),
  ]),
  ...["97133", "97150", "97500", "98600", "98700", "98800", "98400"].map((pc) =>
    r("FR", "FR", false, ["software"], "eu_export_non_eu", { software: 0 }, { buyerPc: pc }),
  ),
  // Monaco is France for VAT.
  r("FR", "MC", false, ["goods"], "eu_domestic", { goods: 2000 }),
  r("FR", "MC", false, ["software"], "eu_domestic", { software: 2000 }),
  // Metropolitan France itself is unchanged.
  r("FR", "FR", false, ["goods"], "eu_domestic", { goods: 2000 }, { buyerPc: "75011" }),
  r("FR", "FR", false, ["software"], "eu_domestic", { software: 2000 }, { buyerPc: "20000" }),
  // A seller in La Réunion (FR + 974 postcode, or RE).
  r("FR", "RE", false, ["goods"], "eu_domestic", { goods: 850 }, { sellerPc: "97400" }),
  r("RE", "RE", false, ["software"], "eu_domestic", { software: 850 }),
  r("FR", "FR", false, ["goods"], "eu_export_non_eu", { goods: 0 }, { sellerPc: "97400" }),
  r("FR", "FR", false, ["software"], "eu_domestic", { software: 2000 }, { sellerPc: "97400" }),
  r("FR", "FR", true, ["service"], "eu_domestic", { service: 2000 }, { sellerPc: "97400" }),
  r("FR", "FR", false, ["service"], "eu_domestic", { service: 850 }, { sellerPc: "97400" }),
  r("RE", "GP", false, ["goods"], "eu_export_non_eu", { goods: 0 }),
  r("RE", "GP", false, ["software"], "eu_domestic", { software: 850 }),
  r("RE", "GF", true, ["service"], "eu_export_non_eu", { service: 0 }),
  r("RE", "DE", false, ["goods"], "eu_export_non_eu", { goods: 0 }),
  r("RE", "US", true, ["service"], "eu_export_non_eu", { service: 0 }),
  // Guadeloupe and Martinique are one market: goods between them are domestic.
  r("GP", "MQ", false, ["goods"], "eu_domestic", { goods: 850 }),
  // Not built (UNCONFIRMED): a person decides.
  r("RE", "DE", false, ["software"], "unconfigured", {}),
  r("DE", "RE", false, ["software"], "unconfigured", {}),
  r("DE", "RE", true, ["service"], "unconfigured", {}),
  r("FR", "FR", false, ["goods"], "unconfigured", {}, { sellerPc: "97300" }),
  // A seller in another member state exports goods to a DOM, as before.
  r("DE", "RE", false, ["goods"], "eu_export_non_eu", { goods: 0 }),
]

const label = (row: Row) =>
  `${row.seller}${row.sellerPc ? ` ${row.sellerPc}` : ""} -> ${row.buyer}${row.buyerPc ? ` ${row.buyerPc}` : ""} ${row.b2b ? "B2B" : "B2C"} ${row.kinds.join("+")}`

describe("DOM-TOM decision table (classify)", () => {
  for (const row of ROWS) {
    test(label(row), () => {
      const c = classify({
        issuer_country: row.seller,
        issuer_postcode: row.sellerPc ?? null,
        counterparty_country: row.buyer,
        counterparty_postcode: row.buyerPc ?? null,
        has_vat_id: row.b2b,
        line_kinds: row.kinds,
      })
      expect(c.treatment).toBe(row.treatment)
      for (const k of row.kinds) {
        if (row.rates[k] === undefined) continue
        expect({ kind: k, rate: c.rate_bp_by_kind?.[k] ?? c.default_rate_bp }).toEqual({
          kind: k,
          rate: row.rates[k] as number,
        })
      }
    })
  }

  test("goods exported to a DOM need an HS code; services there do not", () => {
    const goods = classify({
      issuer_country: "FR",
      counterparty_country: "RE",
      has_vat_id: false,
      line_kinds: ["goods"],
    })
    expect(goods.requires_hs_code).toBe(true)
    const soft = classify({
      issuer_country: "FR",
      counterparty_country: "RE",
      has_vat_id: false,
      line_kinds: ["software"],
    })
    expect(soft.default_rate_bp).toBe(850)
  })

  test("without line kinds a DOM sale reads as goods, as before (export)", () => {
    const c = classify({ issuer_country: "FR", counterparty_country: "RE", has_vat_id: false })
    expect(c.treatment).toBe("eu_export_non_eu")
    expect(c.default_rate_bp).toBe(0)
  })
})

describe("territory detection", () => {
  test.each([
    ["FR", "97110", "GP"],
    ["FR", "97133", "BL"],
    ["FR", "97150", "MF"],
    ["FR", "97200", "MQ"],
    ["FR", "97320", "GF"],
    ["FR", "97411", "RE"],
    ["FR", "97500", "PM"],
    ["FR", "97600", "YT"],
    ["FR", "98600", "WF"],
    ["FR", "98714", "PF"],
    ["FR", "98800", "NC"],
    ["FR", "75011", "FR"],
    ["FR", null, "FR"],
    ["re", null, "RE"],
    ["DE", "97411", "DE"],
  ])("%s %s is %s", (country, pc, expected) => {
    expect(vatTerritoryOf(country, pc)).toBe(expected)
  })
  test("rates and kinds", () => {
    expect(frTerritoryRateBp("RE")).toBe(850)
    expect(frTerritoryRateBp("GF")).toBeNull()
    expect(territoryKind("YT")).toBe("dom_no_vat")
    expect(territoryKind("NC")).toBe("com")
    expect(territoryKind("MC")).toBe("fr_metro")
  })
})

describe("DOM-TOM legal mentions", () => {
  const at = "2026-12-01"
  const m = (
    treatment: TaxTreatment,
    category: "goods" | "services" | "mixed",
    taxTerritory: string,
    issuerTerritory = "FR",
    issueDate = at,
  ) => resolveLegalMention(treatment, "fr", { category, taxTerritory, issuerTerritory, issueDate })

  test("goods exported to a DOM cite 262 I and 294-2", () => {
    for (const c of [...DOM_VAT, ...DOM_NO_VAT]) {
      expect(m("eu_export_non_eu", "goods", c)).toBe(
        "Exportation : exonération de TVA (articles 262 I et 294-2 du CGI)",
      )
    }
  })
  test("goods to a COM keep the export outside the EU wording", () => {
    expect(m("eu_export_non_eu", "goods", "NC")).toBe(
      "Exportation hors Union européenne : exonération de TVA (article 262 I du CGI)",
    )
  })
  test("services to Guyane or Mayotte: not applicable, 294-1", () => {
    for (const c of DOM_NO_VAT) {
      expect(m("eu_export_non_eu", "services", c)).toBe("TVA non applicable, art. 294-1 du CGI")
    }
    expect(m("eu_export_non_eu", "mixed", "GF")).toBe(
      "Exportation : exonération de TVA (articles 262 I et 294-2 du CGI). TVA non applicable, art. 294-1 du CGI",
    )
  })
  test("services taxed in a DOM print no mention (domestic VAT)", () => {
    expect(m("eu_domestic", "services", "RE")).toBe("")
  })
  test("a mixed document to a DOM names the exempt goods", () => {
    expect(m("eu_domestic", "mixed", "RE")).toBe(
      "Livraison de biens exonérée (articles 262 I et 294-2 du CGI)",
    )
    // Domestic inside La Réunion: nothing exempt.
    expect(m("eu_domestic", "mixed", "RE", "RE")).toBe("")
  })
  test("a document issued before the rules keeps its wording", () => {
    expect(m("eu_export_non_eu", "goods", "RE", "FR", "2026-11-01")).toBe(
      "Exportation hors Union européenne : exonération de TVA (article 262 I du CGI)",
    )
  })
})

describe("DOM-TOM Factur-X categories", () => {
  test("8.5 % lines are S, exempt goods on the same document are E", () => {
    const groups = vatBreakdown(
      [
        { tax_rate_bp: 850, subtotal_minor: 10000n, tax_minor: 850n },
        { tax_rate_bp: 0, subtotal_minor: 2000n, tax_minor: 0n },
      ],
      "eu_domestic",
    )
    expect(groups.map((g) => [g.category, g.rate_bp])).toEqual([
      ["S", 850],
      ["E", 0],
    ])
  })
  test("goods exported to a DOM are G", () => {
    const [g] = vatBreakdown(
      [{ tax_rate_bp: 0, subtotal_minor: 10000n, tax_minor: 0n }],
      "eu_export_non_eu",
    )
    expect(g?.category).toBe("G")
  })
})

describe("DOM-TOM e-invoicing regime", () => {
  const base = {
    docType: "invoice",
    issuerCountry: "FR",
    issuerVatRegistered: true,
    vatId: null,
    buyerSiren: null,
    sirenStatus: null,
    territoryTreatment: null,
  } as const
  test("a consumer in a DOM with VAT is e-reporting, never held", () => {
    for (const [country, pc] of [
      ["RE", null],
      ["GP", null],
      ["MQ", null],
      ["FR", "97411"],
    ] as const) {
      const c = classifyRegime({
        ...base,
        customerKind: "individual",
        billingCountry: country,
        billingPostcode: pc,
      })
      expect(c.regime).toBe("e_reporting")
    }
  })
  test("a consumer in Guyane, Mayotte, a COM or Monaco is e-reporting too", () => {
    for (const country of ["GF", "YT", "NC", "BL", "MC"]) {
      const c = classifyRegime({
        ...base,
        customerKind: "individual",
        billingCountry: country,
        billingPostcode: null,
      })
      expect(c.regime).toBe("e_reporting")
    }
  })
  test("a business in a DOM with VAT and a SIREN is e-invoicing", () => {
    const c = classifyRegime({
      ...base,
      customerKind: "business",
      billingCountry: "RE",
      billingPostcode: "97400",
      buyerSiren: "732829320",
      sirenStatus: "A",
    })
    expect(c.regime).toBe("e_invoice")
  })
  test("a business in Guyane still waits for a territory decision", () => {
    const c = classifyRegime({
      ...base,
      customerKind: "business",
      billingCountry: "GF",
      billingPostcode: null,
    })
    expect(c.regime).toBe("needs_review")
  })
})

describe("DOM-TOM source reconciliation (Shopify and revenue streams)", () => {
  const line = (over: Partial<OverseasLine>): OverseasLine => ({
    description: "Plugin licence",
    quantity: "1",
    unit_price_minor: "10850",
    discount_minor: "0",
    line_kind: "software",
    ...over,
  })
  const run = (
    lines: OverseasLine[],
    opts: { territory?: string; consumer?: boolean; inclusive?: boolean } = {},
  ) => {
    const territory = opts.territory ?? "RE"
    const c = classify({
      issuer_country: "FR",
      counterparty_country: territory,
      has_vat_id: opts.consumer === false,
      line_kinds: lines.map((l) => l.line_kind ?? "goods"),
    })
    return overseasLineTax(lines, c, {
      territory,
      consumer: opts.consumer ?? true,
      pricesIncludeTax: opts.inclusive ?? true,
    })
  }
  const gross = (l: OverseasLine) =>
    lineSubtotal({ quantity: l.quantity, unit_price_minor: BigInt(l.unit_price_minor) }) -
    BigInt(l.discount_minor ?? "0")

  test("a consumer's digital line charged 0, tax inclusive: 8.5 % is extracted from the gross", () => {
    for (const rate of [0, undefined]) {
      const out = run([line({ tax_rate_bp: rate })])
      if (!out.ok) throw new Error(out.message)
      const l = out.lines[0] as OverseasLine
      expect(l.tax_rate_bp).toBe(850)
      expect(l.tax_from_gross).toBe(true)
      const net = gross(l)
      expect(net).toBe(10000n)
      expect(BigInt(l.shopify_tax_minor ?? "-1")).toBe(850n)
      expect(net + BigInt(l.shopify_tax_minor ?? "0")).toBe(10850n)
    }
  })
  test("the total stays the gross the buyer paid, quantity and discount included", () => {
    for (const [qty, unit, disc] of [
      ["3", "3333", "0"],
      ["2", "4999", "500"],
      ["1", "1", "0"],
      ["7", "1299", "0"],
    ] as const) {
      const src = line({ quantity: qty, unit_price_minor: unit, discount_minor: disc })
      const paid = gross(src)
      const out = run([src])
      if (!out.ok) throw new Error(out.message)
      const l = out.lines[0] as OverseasLine
      const net = gross(l)
      const tax = BigInt(l.shopify_tax_minor ?? "0")
      expect(net + tax).toBe(paid)
      const computed = lineTax({ subtotal_minor: net, tax_rate_bp: 850 })
      expect(computed > tax ? computed - tax : tax - computed).toBeLessThanOrEqual(1n)
    }
  })
  test("Monaco: the French 20 % is extracted, goods included", () => {
    const out = run([line({ unit_price_minor: "12000", line_kind: "goods" })], {
      territory: "MC",
    })
    if (!out.ok) throw new Error(out.message)
    const l = out.lines[0] as OverseasLine
    expect(l.tax_rate_bp).toBe(2000)
    expect(gross(l)).toBe(10000n)
  })
  test("Guyane and Mayotte stay at 0", () => {
    for (const t of DOM_NO_VAT) {
      const out = run([line({ tax_rate_bp: 0 })], { territory: t })
      if (!out.ok) throw new Error(out.message)
      expect(out.lines[0]?.tax_rate_bp).toBe(0)
      expect(out.lines[0]?.unit_price_minor).toBe("10850")
      expect(out.lines[0]?.tax_from_gross).toBeUndefined()
    }
  })
  test("physical goods to a DOM stay an export at 0", () => {
    const out = run([line({ line_kind: "goods", tax_rate_bp: 0 })])
    if (!out.ok) throw new Error(out.message)
    expect(out.lines[0]).toMatchObject({ tax_rate_bp: 0, unit_price_minor: "10850" })
  })
  test("a source that charged the DOM rate is kept as is", () => {
    const l = line({ unit_price_minor: "10000", tax_rate_bp: 850, shopify_tax_minor: "850" })
    const out = run([l])
    if (!out.ok) throw new Error(out.message)
    expect(out.lines[0]).toEqual(l)
  })
  test("a source that charged another rate parks with the reason", () => {
    const out = run([line({ unit_price_minor: "10000", tax_rate_bp: 2000 })])
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("overseas_tax_mismatch")
    expect(out.message).toContain("RE")
    expect(out.message).toContain("8.5%")
  })
  test("tax charged on goods exported to a DOM parks", () => {
    const out = run([line({ line_kind: "goods", unit_price_minor: "10000", tax_rate_bp: 2000 })])
    expect(out.ok).toBe(false)
  })
  test("a business buyer charged 0 parks: no extraction", () => {
    const out = run([line({ tax_rate_bp: 0 })], { consumer: false })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("overseas_tax_not_collected")
  })
  test("tax exclusive prices charged 0 park: the buyer paid no VAT on top", () => {
    const out = run([line({ tax_rate_bp: 0 })], { inclusive: false })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe("overseas_tax_not_collected")
  })
  test("a sale outside the overseas rules is untouched", () => {
    const l = line({ tax_rate_bp: 0 })
    const c = classify({
      issuer_country: "FR",
      counterparty_country: "US",
      has_vat_id: false,
      line_kinds: ["software"],
    })
    const out = overseasLineTax([l], c, { territory: "US", consumer: true, pricesIncludeTax: true })
    expect(out).toEqual({ ok: true, lines: [l], applied: false })
  })
})

describe("DOM-TOM revenue-stream classifier (classifySaleTax)", () => {
  const sale = (
    country: string,
    kinds: SaleLineKind[],
    opts: { vat?: boolean; postcode?: string; tax?: bigint | null } = {},
  ) =>
    classifySaleTax({
      issuer_country: "FR",
      buyer: {
        kind: opts.vat ? "company" : "individual",
        country,
        postcode: opts.postcode ?? null,
        vat_id: opts.vat ? "FR40303265045" : null,
        vat_id_valid: opts.vat ? true : null,
        tax_evidence: {
          billing_country: country,
          ip_country: vatTerritoryOf(country, opts.postcode),
        },
      },
      lines: kinds.map((kind) => ({
        kind,
        subtotal_minor: 10000n,
        source_tax_minor: opts.tax === undefined ? null : opts.tax,
      })),
    })

  test("digital to a Réunion consumer: 8.5 % where the consumer is", () => {
    for (const [country, postcode] of [
      ["RE", undefined],
      ["FR", "97411"],
    ] as const) {
      const out = sale(country, ["software"], { postcode })
      expect(out).toMatchObject({
        ok: true,
        treatment: "eu_domestic",
        line_rates_bp: [850],
        place_of_supply: { country: "RE", rule: "consumer_residence" },
      })
    }
  })
  test("goods to a DOM: an export at 0", () => {
    expect(sale("GP", ["goods", "shipping"])).toMatchObject({
      ok: true,
      treatment: "eu_export_non_eu",
      line_rates_bp: [0, 0],
    })
  })
  test("a business in Martinique: 8.5 %, no reverse charge", () => {
    expect(sale("MQ", ["software"], { vat: true })).toMatchObject({
      ok: true,
      treatment: "eu_domestic",
      line_rates_bp: [850],
    })
  })
  test("Guyane and Mayotte: not applicable", () => {
    for (const c of DOM_NO_VAT) {
      expect(sale(c, ["software"])).toMatchObject({
        ok: true,
        treatment: "eu_export_non_eu",
        line_rates_bp: [0],
      })
    }
  })
  test("a source that charged another tax parks as a mismatch", () => {
    expect(sale("RE", ["software"], { tax: 2000n })).toMatchObject({
      ok: false,
      park: "sale_tax_mismatch",
    })
  })
})
