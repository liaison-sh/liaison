// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Factur-X conformance: every document the issue paths can produce validates against the pinned
// Factur-X 1.09.2 EN16931 XSD (xmllint) and has no blocking failed-assert under the CEN EN16931,
// FNFE Factur-X and FNFE BR-FR schematrons (SaxonJS) nor the profile's own asserts. The mutation
// suite proves each check can say no: every mutation fails with the rule named here.

import { describe, expect, test } from "bun:test"
import {
  type FailedAssert,
  type SchematronName,
  validateFacturxXml,
} from "../../../../tools/schematron/validate"
import { buildCii, FacturxBuildError } from "./cii"
import { conformanceMatrix, fxDocument } from "./fixtures"

const T = 240_000

function firing(asserts: FailedAssert[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const a of asserts) (out[a.schematron] ??= []).push(a.id)
  return out
}

describe("Factur-X conformance matrix", () => {
  for (const c of conformanceMatrix()) {
    test(
      `${c.name}: XSD valid, no blocking assert`,
      () => {
        const r = validateFacturxXml(buildCii(c.input))
        expect(r.xsd.errors).toEqual([])
        expect(firing(r.blocking)).toEqual({})
        expect(r.ok).toBe(true)
      },
      T,
    )
  }
})

const invoice = () => buildCii(fxDocument())
const creditNote = () =>
  buildCii(
    fxDocument({
      type: "credit_note",
      number: "AV-2026-0007",
      original: { number: "FA-2026-0042", issue_date: "2026-11-03" },
    }),
  )
const usd = () => buildCii(fxDocument({ currency: "USD", tax_total_eur_minor: 15000n }))
const paid = () =>
  buildCii(fxDocument({ payment_state: "paid", paid_date: "2026-11-02", due_date: null }))

interface Mutation {
  name: string
  base: () => string
  mutate: (xml: string) => string
  /** schematron → rule id that must fire. */
  expect: Partial<Record<SchematronName, string>>
  /** When set, ONLY these validators may fail (exclusive coverage). */
  only?: Array<SchematronName | "xsd">
}

const MUTATIONS: Mutation[] = [
  {
    name: "drop BT-47 (buyer SIREN)",
    base: invoice,
    mutate: (x) =>
      x.replace(
        /<ram:SpecifiedLegalOrganization><ram:ID schemeID="0002">356000000<\/ram:ID><\/ram:SpecifiedLegalOrganization>/,
        "",
      ),
    expect: { "fnfe-br-fr": "BR-FR-11_BT-47" },
    only: ["fnfe-br-fr"],
  },
  {
    name: "drop BT-23 (business process)",
    base: invoice,
    mutate: (x) =>
      x.replace(
        /<ram:BusinessProcessSpecifiedDocumentContextParameter>.*?<\/ram:BusinessProcessSpecifiedDocumentContextParameter>/,
        "",
      ),
    expect: { "fnfe-br-fr": "BR-FR-08_BT-23" },
  },
  {
    name: "drop the BAR note",
    base: invoice,
    mutate: (x) =>
      x.replace(
        "<ram:IncludedNote><ram:Content>B2B</ram:Content><ram:SubjectCode>BAR</ram:SubjectCode></ram:IncludedNote>",
        "",
      ),
    expect: { "liaison-profile": "LX-BAR-01" },
    only: ["liaison-profile"],
  },
  {
    name: "drop BT-49 (buyer routing address)",
    base: invoice,
    mutate: (x) =>
      x.replace(
        /<ram:URIUniversalCommunication><ram:URIID schemeID="0225">356000000<\/ram:URIID><\/ram:URIUniversalCommunication>/,
        "",
      ),
    expect: { "fnfe-br-fr": "BR-FR-12_BT-49" },
  },
  {
    name: "credit note typed 380",
    base: creditNote,
    mutate: (x) =>
      x.replace("<ram:TypeCode>381</ram:TypeCode>", "<ram:TypeCode>380</ram:TypeCode>"),
    expect: { "liaison-profile": "LX-BT3-02" },
    only: ["liaison-profile"],
  },
  {
    name: "credit note without BT-25",
    base: creditNote,
    mutate: (x) =>
      x.replace(/<ram:InvoiceReferencedDocument>.*?<\/ram:InvoiceReferencedDocument>/, ""),
    expect: { "fnfe-br-fr": "BR-FR-CO-05_BT-3", "liaison-profile": "LX-BT3-02" },
  },
  {
    name: "non-EUR invoice without BT-6",
    base: usd,
    mutate: (x) => x.replace("<ram:TaxCurrencyCode>EUR</ram:TaxCurrencyCode>", ""),
    expect: { "fnfe-br-fr": "BR-FR-CO-12_BT-5" },
  },
  {
    name: "already paid (B2) with an amount still due",
    base: paid,
    mutate: (x) =>
      x.replace(
        "<ram:DuePayableAmount>0.00</ram:DuePayableAmount>",
        "<ram:DuePayableAmount>10.00</ram:DuePayableAmount>",
      ),
    expect: { "fnfe-br-fr": "BR-FR-CO-09_BT-23-2", "cen-en16931": "BR-CO-16" },
  },
  {
    name: "BT-1 with spaces (French rules only)",
    base: invoice,
    mutate: (x) => x.replace("<ram:ID>FA-2026-0042</ram:ID>", "<ram:ID>FA 2026 0042</ram:ID>"),
    expect: { "fnfe-br-fr": "BR-FR-02_BT-1" },
    only: ["fnfe-br-fr"],
  },
  {
    name: "Factur-X guideline id not EN16931 (Factur-X schematron only)",
    base: invoice,
    mutate: (x) =>
      x.replace(
        "urn:cen.eu:en16931:2017</ram:ID>",
        "urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0</ram:ID>",
      ),
    expect: { "fnfe-facturx": "FX-SCH-A-000556" },
    only: ["fnfe-facturx"],
  },
  {
    name: "VAT total not the sum of the breakdown (EN16931)",
    base: invoice,
    mutate: (x) =>
      x.replace(
        /(<ram:TaxTotalAmount currencyID="EUR">)(\d+)\.(\d\d)/,
        (_m, a, b, c) => `${a}${Number(b) + 1}.${c}`,
      ),
    expect: { "cen-en16931": "BR-CO-14", "fnfe-facturx": "BR-CO-14" },
  },
  {
    name: "unknown unit code (EN16931 code list)",
    base: invoice,
    mutate: (x) => x.replace('unitCode="C62"', 'unitCode="ZZZQ"'),
    expect: { "cen-en16931": "BR-CL-23" },
  },
  {
    name: "element order swap (XSD only)",
    base: invoice,
    mutate: (x) =>
      x.replace(/(<ram:ID>FA-2026-0042<\/ram:ID>)(<ram:TypeCode>380<\/ram:TypeCode>)/, "$2$1"),
    expect: {},
    only: ["xsd"],
  },
]

describe("Factur-X mutation suite", () => {
  for (const m of MUTATIONS) {
    test(
      `${m.name} is refused`,
      () => {
        const base = m.base()
        const mutated = m.mutate(base)
        expect(mutated).not.toBe(base)
        const r = validateFacturxXml(mutated)
        expect(r.ok).toBe(false)
        const fired = firing(r.blocking)
        for (const [schematron, rule] of Object.entries(m.expect)) {
          expect(fired[schematron] ?? []).toContain(rule as string)
        }
        if (m.only) {
          const failing = [...Object.keys(fired), ...(r.xsd.ok ? [] : ["xsd"])].sort()
          expect(failing).toEqual([...m.only].sort())
        }
      },
      T,
    )
  }
})

describe("non-EUR without a stored rate (S5)", () => {
  test("the builder refuses rather than emitting a CII that BR-FR-CO-12 rejects", () => {
    expect(() => buildCii(fxDocument({ currency: "USD", tax_total_eur_minor: null }))).toThrow(
      FacturxBuildError,
    )
    try {
      buildCii(fxDocument({ currency: "USD", tax_total_eur_minor: null }))
    } catch (e) {
      expect((e as FacturxBuildError).code).toBe("facturx_fx_missing")
    }
  })
})
