// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import type { OperationCategory } from "./einvoicing/classify-operation"
import { readCibsSwitchDate } from "./einvoicing/mentions"
import {
  classify,
  DEFAULT_CIBS_SWITCH_DATE,
  EU_STANDARD_RATE_BP,
  FR_LEGAL_MENTIONS,
  legalMentionPeriod,
  operationLabel,
  resolveLegalMention,
  type TaxTreatment,
  VAT_ON_DEBITS_TEXT,
} from "./tax"

describe("tax regime classifier", () => {
  test.each<[{ issuer: string; counterparty: string; vat: boolean }, TaxTreatment]>([
    [{ issuer: "FR", counterparty: "FR", vat: false }, "eu_domestic"],
    [{ issuer: "FR", counterparty: "DE", vat: true }, "eu_reverse_charge"],
    [{ issuer: "FR", counterparty: "DE", vat: false }, "eu_b2c_oss"],
    [{ issuer: "FR", counterparty: "US", vat: false }, "eu_export_non_eu"],
    [{ issuer: "DE", counterparty: "DE", vat: false }, "eu_domestic"],
    [{ issuer: "DE", counterparty: "FR", vat: true }, "eu_reverse_charge"],
    [{ issuer: "DE", counterparty: "JP", vat: false }, "eu_export_non_eu"],
    [{ issuer: "GB", counterparty: "GB", vat: false }, "uk_domestic"],
    [{ issuer: "GB", counterparty: "DE", vat: false }, "uk_export_eu"],
    [{ issuer: "GB", counterparty: "JP", vat: false }, "uk_export_non_eu"],
    [{ issuer: "US", counterparty: "US", vat: false }, "us_domestic"],
    [{ issuer: "US", counterparty: "FR", vat: false }, "us_export"],
  ])("classifies issuer=%p → %p", ({ issuer, counterparty, vat }, expected) => {
    expect(
      classify({ issuer_country: issuer, counterparty_country: counterparty, has_vat_id: vat })
        .treatment,
    ).toBe(expected)
  })

  test("returns ambiguous when counterparty country is unknown", () => {
    expect(
      classify({ issuer_country: "FR", counterparty_country: "ZZ", has_vat_id: false }).treatment,
    ).toBe("ambiguous")
  })

  test("returns unconfigured when the issuer regime is not in v1 ship set", () => {
    expect(
      classify({ issuer_country: "ES", counterparty_country: "ES", has_vat_id: false }).treatment,
    ).toBe("unconfigured")
  })

  test("a MISSING country DEGRADES, never throws (was: toUpperCase-of-undefined aborted issuance → 422)", () => {
    // A counterparty contact (or issuer profile) can have no country — e.g. an agent-created
    // contact. classify must degrade like an UNKNOWN country, not crash the whole gated issuance.
    for (const cp of [null, undefined, ""] as const) {
      expect(() =>
        classify({ issuer_country: "FR", counterparty_country: cp, has_vat_id: false }),
      ).not.toThrow()
      expect(
        classify({ issuer_country: "FR", counterparty_country: cp, has_vat_id: false }).treatment,
      ).toBe("ambiguous")
    }
    for (const iss of [null, undefined, ""] as const) {
      expect(() =>
        classify({ issuer_country: iss, counterparty_country: "DE", has_vat_id: false }),
      ).not.toThrow()
      expect(
        classify({ issuer_country: iss, counterparty_country: "DE", has_vat_id: false }).treatment,
      ).toBe("unconfigured")
    }
  })

  test("default_rate_bp is over-collect (issuer domestic rate) under ambiguous", () => {
    expect(
      classify({ issuer_country: "FR", counterparty_country: "ZZ", has_vat_id: false })
        .default_rate_bp,
    ).toBe(2000)
  })

  test("eu_reverse_charge sets default_rate_bp to 0 (B2B VAT shifted to buyer)", () => {
    const r = classify({ issuer_country: "FR", counterparty_country: "DE", has_vat_id: true })
    expect(r.default_rate_bp).toBe(0)
  })

  test("eu_export_non_eu sets default_rate_bp to 0 (export, no VAT)", () => {
    const r = classify({ issuer_country: "FR", counterparty_country: "US", has_vat_id: false })
    expect(r.default_rate_bp).toBe(0)
  })

  test("requires_hs_code is true for non-EU exports (customs declaration needed)", () => {
    expect(
      classify({ issuer_country: "FR", counterparty_country: "US", has_vat_id: false })
        .requires_hs_code,
    ).toBe(true)
    expect(
      classify({ issuer_country: "GB", counterparty_country: "JP", has_vat_id: false })
        .requires_hs_code,
    ).toBe(true)
  })

  test("requires_hs_code is false for intra-EU and domestic flows", () => {
    expect(
      classify({ issuer_country: "FR", counterparty_country: "FR", has_vat_id: false })
        .requires_hs_code,
    ).toBe(false)
    expect(
      classify({ issuer_country: "DE", counterparty_country: "FR", has_vat_id: true })
        .requires_hs_code,
    ).toBe(false)
  })

  test("legal_mention_key identifies the templated mention to render", () => {
    const r = classify({ issuer_country: "FR", counterparty_country: "DE", has_vat_id: true })
    expect(r.legal_mention_key).toBe("eu_reverse_charge")
  })

  test("us_domestic ships at 0bp default (sales tax is per-line manual)", () => {
    const r = classify({ issuer_country: "US", counterparty_country: "US", has_vat_id: false })
    expect(r.default_rate_bp).toBe(0)
  })

  test("uk_domestic ships at the UK VAT default (2000bp / 20%)", () => {
    const r = classify({ issuer_country: "GB", counterparty_country: "GB", has_vat_id: false })
    expect(r.default_rate_bp).toBe(2000)
  })

  // The EU B2C OSS branch charges the DESTINATION's standard rate, never the issuer's. It used to
  // return the issuer's domestic rate as a "placeholder": a French issuer then charged an Italian
  // consumer 20% French VAT where 22% Italian VAT is owed.
  test("eu_b2c_oss charges the destination member state's standard rate", () => {
    const it = classify({ issuer_country: "FR", counterparty_country: "IT", has_vat_id: false })
    expect(it.treatment).toBe("eu_b2c_oss")
    expect(it.default_rate_bp).toBe(2200)
    expect(
      classify({ issuer_country: "FR", counterparty_country: "DE", has_vat_id: false })
        .default_rate_bp,
    ).toBe(1900)
    expect(
      classify({ issuer_country: "DE", counterparty_country: "FR", has_vat_id: false })
        .default_rate_bp,
    ).toBe(2000)
    expect(
      classify({ issuer_country: "FR", counterparty_country: "HU", has_vat_id: false })
        .default_rate_bp,
    ).toBe(2700)
  })

  test("every EU member state has a standard rate", () => {
    for (const cc of [
      "AT",
      "BE",
      "BG",
      "HR",
      "CY",
      "CZ",
      "DK",
      "EE",
      "FI",
      "FR",
      "DE",
      "GR",
      "HU",
      "IE",
      "IT",
      "LV",
      "LT",
      "LU",
      "MT",
      "NL",
      "PL",
      "PT",
      "RO",
      "SK",
      "SI",
      "ES",
      "SE",
    ]) {
      expect(EU_STANDARD_RATE_BP[cc]).toBeGreaterThan(0)
    }
  })
})

describe("tax regime classifier — a real country outside the trading-partner list", () => {
  // QUO-2026-0006 charged 20% French VAT to a customer in Yerevan. Armenia was
  // simply absent from a hand-curated ~45-country allowlist, so `classify` read
  // it as `ambiguous` and "safely" over-collected at the issuer's domestic
  // rate. Over-collecting VAT on an export is a real liability, and the
  // customer sees it on the document.
  test("treats Armenia as a non-EU export at 0%, not an ambiguous domestic sale", () => {
    const r = classify({ issuer_country: "FR", counterparty_country: "AM", has_vat_id: false })
    expect(r.treatment).toBe("eu_export_non_eu")
    expect(r.default_rate_bp).toBe(0)
    expect(r.requires_hs_code).toBe(true)
  })

  test("does the same for every other real country the old list happened to omit", () => {
    for (const cc of ["UA", "VN", "MA", "NG", "TH", "ID", "EG", "SA", "PE", "KZ", "GE", "RS"]) {
      const r = classify({ issuer_country: "FR", counterparty_country: cc, has_vat_id: false })
      expect(`${cc}:${r.treatment}`).toBe(`${cc}:eu_export_non_eu`)
      expect(`${cc}:${r.default_rate_bp}`).toBe(`${cc}:0`)
    }
  })

  test("still degrades to ambiguous when the code is not a country at all", () => {
    // The safe default is only defensible when we genuinely cannot tell.
    for (const bogus of ["XX", "ZZ", "EXPORT", ""]) {
      expect(
        classify({ issuer_country: "FR", counterparty_country: bogus, has_vat_id: false })
          .treatment,
      ).toBe("ambiguous")
    }
  })

  test("does not disturb the EU cases", () => {
    expect(
      classify({ issuer_country: "FR", counterparty_country: "FR", has_vat_id: false })
        .default_rate_bp,
    ).toBe(2000)
    expect(
      classify({ issuer_country: "FR", counterparty_country: "DE", has_vat_id: true }).treatment,
    ).toBe("eu_reverse_charge")
    expect(
      classify({ issuer_country: "FR", counterparty_country: "DE", has_vat_id: false }).treatment,
    ).toBe("eu_b2c_oss")
  })
})

describe("French legal mentions (dated table, accented)", () => {
  const GOODS = "Exonération de TVA, article 262 ter I du CGI"
  const SERVICES = "Autoliquidation : TVA due par le preneur (article 283-2 du CGI)"
  const EXPORT = "Exportation hors Union européenne : exonération de TVA (article 262 I du CGI)"
  const dates = ["2026-10-14", "2026-12-31", "2027-01-01", "2028-03-01"]

  test.each<[TaxTreatment, OperationCategory | null, string]>([
    ["eu_reverse_charge", "goods", GOODS],
    ["eu_reverse_charge", "services", SERVICES],
    ["eu_reverse_charge", "mixed", `${GOODS}. ${SERVICES}`],
    ["eu_reverse_charge", null, SERVICES],
    ["eu_export_non_eu", "goods", EXPORT],
    ["eu_export_non_eu", "services", EXPORT],
    ["eu_export_non_eu", "mixed", EXPORT],
    ["eu_export_non_eu", null, EXPORT],
    [
      "eu_b2c_oss",
      "goods",
      "TVA collectée dans le cadre du guichet unique OSS de l'Union européenne.",
    ],
    ["eu_domestic", "goods", ""],
    ["eu_domestic", "mixed", ""],
    ["ambiguous", null, "Traitement TVA en cours de vérification : consultez votre comptable."],
  ])("fr %s / %p -> %p, before and after the switch", (treatment, category, expected) => {
    for (const issueDate of dates) {
      expect(resolveLegalMention(treatment, "fr", { category, issueDate })).toBe(expected)
    }
  })

  test("no French mention carries an unaccented transliteration", () => {
    const all = Object.values(FR_LEGAL_MENTIONS.cgi).join(" ")
    expect(all).not.toMatch(/europeenne|exoneree|collectee|verification|a taux zero|etat;/)
    for (const t of [
      "eu_reverse_charge",
      "eu_b2c_oss",
      "eu_export_non_eu",
      "uk_export_eu",
      "uk_export_non_eu",
      "us_domestic",
      "us_export",
      "ambiguous",
    ] as TaxTreatment[]) {
      expect(resolveLegalMention(t, "fr")).not.toMatch(
        /europeenne|exoneree|collectee|verification|taux zero|Etats|etat;/,
      )
    }
  })

  test("English and German keep a goods/services split for reverse charge", () => {
    expect(resolveLegalMention("eu_reverse_charge", "en", { category: "goods" })).toContain(
      "262 ter I",
    )
    expect(resolveLegalMention("eu_reverse_charge", "en", { category: "services" })).toContain(
      "Article 196",
    )
    expect(resolveLegalMention("eu_reverse_charge", "de", { category: "services" })).toContain(
      "Reverse Charge",
    )
  })

  test("a mixed reverse charge joins goods and services with one period in every language", () => {
    for (const lang of ["en", "fr", "de"] as const) {
      const mixed = resolveLegalMention("eu_reverse_charge", lang, {
        category: "mixed",
        issueDate: "2026-11-02",
      })
      expect(mixed).not.toContain("..")
      expect(mixed).not.toMatch(/\.\s*\./)
      expect(mixed).toContain(
        resolveLegalMention("eu_reverse_charge", lang, { category: "services" }),
      )
    }
    expect(resolveLegalMention("eu_reverse_charge", "en", { category: "mixed" })).toBe(
      "Intra-Community supply of goods exempt from VAT (Article 262 ter I of the French Tax Code, CGI). " +
        "Reverse charge: VAT to be accounted for by the recipient (Article 196, Directive 2006/112/EC).",
    )
  })

  test("the goods exemption wording lives in the dated table, per period", () => {
    for (const period of ["cgi", "cibs"] as const) {
      const entry = FR_LEGAL_MENTIONS[period].eu_reverse_charge_goods
      expect(entry).toBeDefined()
      const issueDate = period === "cgi" ? "2026-11-02" : "2027-02-01"
      for (const lang of ["en", "fr", "de"] as const) {
        expect(
          resolveLegalMention("eu_reverse_charge", lang, { category: "goods", issueDate }),
        ).toBe((entry as Record<string, string>)[lang] as string)
      }
    }
  })

  test("the table is dated: both periods carry every key, CGI text repeated after the switch (OPEN-6)", () => {
    expect(Object.keys(FR_LEGAL_MENTIONS).sort()).toEqual(["cgi", "cibs"])
    expect(FR_LEGAL_MENTIONS.cibs).toEqual(FR_LEGAL_MENTIONS.cgi)
  })

  test("VAT on debits literal and operation labels", () => {
    expect(VAT_ON_DEBITS_TEXT).toBe("Option pour le paiement de la taxe d'après les débits")
    expect(operationLabel("goods", "fr")).toBe("Livraison de biens")
    expect(operationLabel("services", "fr")).toBe("Prestation de services")
    expect(operationLabel("mixed", "fr")).toBe("Livraison de biens et prestation de services")
    expect(operationLabel("goods", "en")).toBe("Delivery of goods")
    expect(operationLabel(null, "fr")).toBe("")
  })

  test("switch date read from settings: before/after both resolve", async () => {
    expect(DEFAULT_CIBS_SWITCH_DATE).toBe("2027-01-01")
    const withRow = { findMany: async () => [{ cibs_switch_date: "2026-09-01T00:00:00.000Z" }] }
    const empty = { findMany: async () => [] }
    const configured = await readCibsSwitchDate(withRow)
    expect(configured).toBe("2026-09-01")
    expect(await readCibsSwitchDate(empty)).toBe("2027-01-01")
    expect(legalMentionPeriod("2026-08-31", configured)).toBe("cgi")
    expect(legalMentionPeriod("2026-09-01", configured)).toBe("cibs")
    expect(legalMentionPeriod("2026-09-01", "2027-01-01")).toBe("cgi")
    expect(legalMentionPeriod(null, configured)).toBe("cgi")
    for (const issueDate of ["2026-08-31", "2026-09-01"]) {
      expect(
        resolveLegalMention("eu_reverse_charge", "fr", {
          category: "goods",
          issueDate,
          cibsSwitchDate: configured,
        }),
      ).toBe("Exonération de TVA, article 262 ter I du CGI")
    }
  })
})
