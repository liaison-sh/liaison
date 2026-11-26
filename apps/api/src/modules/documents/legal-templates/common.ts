// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pieces every starter contract shares: the two parties, the proof clause,
// the signature page, and the builder that turns a list of clauses into a body
// in the classic legal layout (page.layout = "legal", legal-layout.ts).
//
// Every starter is a starting point to review with a lawyer, never a finished
// contract: its name says so, and nothing in it claims more than a simple
// electronic signature.

export type StarterLang = "en" | "fr"

/** One clause of a starter: a level-1 article, with its sub-clauses. */
export interface StarterClause {
  id: string
  heading: string
  text: string
  subs?: Array<{ id?: string; text: string; heading?: string; level?: 2 | 3 | 4 }>
}

export interface StarterContent {
  title: string
  recitals?: string[]
  clauses: StarterClause[]
  /** A contract's annex: a schedule of its own clauses or text. */
  annex?: { id: string; title: string; paragraphs: string[] }
  confidential?: boolean
}

/** The record fields a party block reads: `<who>.name`, `<who>.form` and the rest. */
function party(who: "client" | "provider", definedAs: string) {
  return {
    kind: "company",
    name: `{{${who}.name}}`,
    form: `{{${who}.form}}`,
    capital: `{{${who}.capital}}`,
    seat: `{{${who}.seat}}`,
    rcs_city: `{{${who}.rcs_city}}`,
    rcs_number: `{{${who}.rcs_number}}`,
    represented_by: `{{${who}.represented_by}}`,
    capacity: `{{${who}.capacity}}`,
    defined_as: definedAs,
  }
}

export const PARTY_TERMS: Record<StarterLang, { client: string; provider: string }> = {
  fr: { client: "le Client", provider: "le Prestataire" },
  en: { client: "the Client", provider: "the Provider" },
}

/** The two parties of a services contract, client first. */
export function partiesBlock(lang: StarterLang, terms = PARTY_TERMS[lang]) {
  return {
    type: "parties",
    groups: [
      { items: [party("client", terms.client)] },
      { items: [party("provider", terms.provider)] },
    ],
  }
}

/**
 * The proof clause every starter carries: the parties sign by simple electronic
 * signature and accept the evidence file as proof of the signature and its date.
 */
export const PROOF_CLAUSE: Record<StarterLang, StarterClause> = {
  en: {
    id: "signature_proof",
    heading: "Signature and proof",
    text: "The parties sign by simple electronic signature. Each receives the signed PDF and its proof of signature file by email, and accepts that file as proof of the signature and its date.",
  },
  fr: {
    id: "signature_proof",
    heading: "Signature et preuve",
    text: "Les parties signent par signature électronique simple. Chacune reçoit par email le PDF signé et son fichier de preuve de signature, et accepte ce fichier comme preuve de la signature et de sa date.",
  },
}

/** The signature page: place, each party, the person signing and their capacity. */
export function signatureBlock(lines: Array<{ who: "client" | "provider" }>) {
  return {
    type: "signature_block",
    place: "{{signature.place}}",
    lines: lines.map(({ who }) => ({
      party: `{{${who}.name}}`,
      name: `{{${who}.represented_by}}`,
      capacity: `{{${who}.capacity}}`,
    })),
  }
}

/** A starter contract between the client and the provider, in the classic layout. */
export function contractBody(lang: StarterLang, c: StarterContent): Record<string, unknown> {
  const blocks: unknown[] = [partiesBlock(lang)]
  if (c.recitals && c.recitals.length > 0) blocks.push({ type: "recitals", items: c.recitals })
  for (const clause of [...c.clauses, PROOF_CLAUSE[lang]]) {
    blocks.push({
      type: "article",
      id: clause.id,
      level: 1,
      heading: clause.heading,
      text: clause.text,
    })
    for (const sub of clause.subs ?? []) {
      blocks.push({
        type: "article",
        level: sub.level ?? 2,
        text: sub.text,
        ...(sub.id ? { id: sub.id } : {}),
        ...(sub.heading ? { heading: sub.heading } : {}),
      })
    }
  }
  if (c.annex) {
    blocks.push({
      type: "annex",
      id: c.annex.id,
      title: c.annex.title,
      blocks: c.annex.paragraphs.map((text) => ({ type: "paragraph", text })),
    })
  }
  blocks.push(signatureBlock([{ who: "client" }, { who: "provider" }]))
  return {
    page: {
      layout: "legal",
      lang,
      shortTitle: c.title,
      ...(c.confidential ? { confidential: true } : {}),
    },
    blocks,
  }
}
