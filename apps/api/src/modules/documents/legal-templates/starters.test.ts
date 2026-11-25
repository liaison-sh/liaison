// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The starter agreement templates: every one renders in the classic layout
// with a filled record and prints no blank, carries the proof clause, says it
// is a starting point to review with a lawyer, and claims no more than a
// simple electronic signature; the corporate acts stay out while their
// feature is off.
import { describe, expect, it } from "bun:test"
import { extractPdfText } from "~/modules/pdf/pdf-text"
import { freezeTextMatches, renderRichTextForFreeze } from "../rich-text"
import { assertValidBody } from "../service"
import { PROOF_CLAUSE } from "./common"
import {
  allLegalStarterTemplates,
  legalStarterTemplates,
  STARTER_RECORD_TYPE,
  STARTER_REVIEW_NOTE,
} from "./starters"

const company = (name: string) => ({
  name,
  form: "SAS",
  capital: "10 000 €",
  seat: "4 place du Marché, 69002 Lyon",
  rcs_city: "Lyon",
  rcs_number: "812 345 678",
  represented_by: "Claire Martin",
  capacity: "présidente",
})

/** One record that fills every placeholder of every starter. */
const FIXTURE: Record<string, unknown> = {
  client: company("Maison Ondine"),
  provider: { ...company("Maison Studio Nord"), represented_by: "Paul Durand", capacity: "gérant" },
  company: company("Maison Ondine"),
  signature: { place: "Lyon" },
  contract: {
    governing_law: "droit français",
    court: "Lyon",
    start_date: "1er décembre 2026",
    term_months: "12",
    nda_years: "3",
  },
  project: {
    name: "Refonte du site",
    start_date: "1er décembre 2026",
    end_date: "31 mars 2027",
    deliverables: "Maquettes, site en production, documentation.",
  },
  fees: {
    total: "24 000 €",
    deposit_share: "30 %",
    daily_rate: "650 €",
    estimate: "18 000 €",
  },
  retainer: { hours: "20", field: "maintenance", monthly_fee: "2 400 €", extra_rate: "120 €" },
  processing: { subjects: "clients du Client", data: "noms et emails", purposes: "support" },
  change: {
    contract_reference: "AGR-2026-0004",
    description: "ajout d'une page de contact",
    price: "1 200 €",
    new_date: "15 avril 2027",
  },
  meeting: {
    date: "20 novembre 2026",
    kind: "ordinaire",
    place: "Lyon",
    convened_by: "la présidente",
    chair: "Claire Martin",
    secretary: "Paul Durand",
    quorum: "100 %",
    agenda: "Approbation des comptes.",
  },
  resolutions: {
    first: "L'assemblée approuve les comptes de l'exercice.",
    first_vote: "l'unanimité",
    second_vote: "l'unanimité",
  },
  consultation: { sent_on: "10 novembre 2026", sent_by: "la présidente", days: "15" },
  grantor: { name: "Claire Martin", address: "4 place du Marché, 69002 Lyon" },
  attorney: { name: "Paul Durand", address: "8 quai Rambaud, 69002 Lyon" },
  power: { object: "signer le bail des locaux", until: "31 décembre 2026" },
}

// Words a starter must never use about the signature it offers.
const OVERCLAIMS = [
  /legally binding/i,
  /\bqualified\b/i,
  /\bequivalent\b/i,
  /\bpresumed\b/i,
  /eIDAS/i,
  /qualifiée/i,
  /équivalent/i,
  /juridiquement contraignant/i,
  /présumée?/i,
]

describe("starter agreement templates", () => {
  it("seven services starters and three corporate ones, each in English and French", () => {
    const all = allLegalStarterTemplates()
    expect(all).toHaveLength(20)
    expect(all.filter((t) => !t.corporate)).toHaveLength(14)
    expect(new Set(all.map((t) => t.key)).size).toBe(20)
    for (const lang of ["en", "fr"] as const)
      expect(all.filter((t) => t.lang === lang)).toHaveLength(10)
  })

  it("the three corporate ones are absent with the flag off, present with it on", () => {
    const off = legalStarterTemplates({ corporateTemplates: false })
    expect(off).toHaveLength(14)
    expect(off.some((t) => t.corporate)).toBe(false)
    const on = legalStarterTemplates({ corporateTemplates: true })
    expect(on).toHaveLength(20)
    expect(on.filter((t) => t.corporate).map((t) => t.starter)).toEqual([
      "general_meeting_minutes",
      "general_meeting_minutes",
      "written_consultation",
      "written_consultation",
      "power_of_attorney",
      "power_of_attorney",
    ])
  })

  for (const t of allLegalStarterTemplates()) {
    it(`${t.key} renders with a fixture and no blank, with the proof clause, in the legal layout`, async () => {
      expect(t.name).toContain(STARTER_REVIEW_NOTE[t.lang])
      expect(t.body.page).toMatchObject({ layout: "legal", lang: t.lang })
      assertValidBody(t.body)
      const out = await renderRichTextForFreeze({ body: t.body, record: FIXTURE, title: t.name })
      expect(out.blanks).toEqual([])
      expect(freezeTextMatches(out.sourceText, out.layoutText)).toBe(true)
      expect(out.tocMatches).toBe(true)
      const text = (await extractPdfText(out.bytes)).replace(/\s+/g, " ")
      expect(text).toContain(PROOF_CLAUSE[t.lang].text.slice(0, 40))
      expect(text).toContain(t.lang === "fr" ? "Signé électroniquement" : "Signed electronically")
      for (const word of OVERCLAIMS)
        expect({ key: t.key, hit: word.test(text) }).toEqual({ key: t.key, hit: false })
    })
  }

  it("the starters print from an agreement's source", () => {
    expect(STARTER_RECORD_TYPE).toBe("agreements:agreement")
  })
})
