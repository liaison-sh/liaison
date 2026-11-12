// SPDX-License-Identifier: FSL-1.1-ALv2
//
// D3 — In-app numbering.
//
// Resolves the per-type prefix from the issuer profile and builds the
// `(issuer, type, year)` sequence spec that `ctx.db.batch` allocates in the
// same commit as the document it numbers (issue.ts): legal numbering stays
// gap-free and unique with no transaction held across the run.

export type DocumentType = "invoice" | "quote" | "proforma" | "purchase_order" | "credit_note"

export interface IssuerProfileForNumbering {
  id: string
  prefix_invoice?: string
  prefix_quote?: string
  prefix_proforma?: string
  prefix_po?: string
  prefix_credit_note?: string
}

export interface NumberingInput {
  issuer_profile: IssuerProfileForNumbering
  type: DocumentType
  year_of_issue: number
}

const PREFIX_KEY_BY_TYPE: Record<DocumentType, keyof IssuerProfileForNumbering> = {
  invoice: "prefix_invoice",
  quote: "prefix_quote",
  proforma: "prefix_proforma",
  purchase_order: "prefix_po",
  credit_note: "prefix_credit_note",
}

/** The number a batch allocates for one (issuer, type, year): `ctx.db.batch`'s `sequence`. */
export interface NumberingSequence {
  key: string
  format: { prefix: string; pad: number }
  unique: { entity: "documents"; field: "number_int"; where: Record<string, unknown> }
}

/**
 * The sequence spec that numbers a document inside the `ctx.db.batch` that writes it, so the
 * number and the document commit together (no gap when the write fails, no number shared by two
 * concurrent issues). The value is formatted as `formatNumberString` does: `{YYYY}` expanded, the
 * value zero-padded to 4 digits. A number a document of this (issuer, type, year) already holds
 * (an import, a migration, a seed) is stepped past, never reissued.
 */
export function numberingSequence({
  issuer_profile,
  type,
  year_of_issue,
}: NumberingInput): NumberingSequence {
  const prefixKey = PREFIX_KEY_BY_TYPE[type]
  const prefix = issuer_profile[prefixKey]
  if (typeof prefix !== "string" || prefix.length === 0) {
    throw new Error(
      `issuer_profile is missing ${prefixKey} (required to format ${type} numbers)`,
    )
  }
  return {
    key: `invoicing:doc_number:${issuer_profile.id}:${type}:${year_of_issue}`,
    format: { prefix: prefix.replace("{YYYY}", String(year_of_issue)), pad: 4 },
    unique: {
      entity: "documents",
      field: "number_int",
      where: { issuer_profile_id: issuer_profile.id, type, year_of_issue },
    },
  }
}
