// SPDX-License-Identifier: FSL-1.1-ALv2
//
// When an invoice is due. One rule for every invoice, whatever made it: the date given on it, else
// the customer's payment terms, else the issuer's, counted from the day it is issued. A draft's
// customer terms are the ones its schedule bills under (`external_refs.due_days`, kept from the
// draft to the issue), else the days recorded for the customer. Nothing here touches a document
// already issued.

import { addDays } from "./recurring/schedule"

/** The days the issuer profile defaults to, when a row has none. */
export const DEFAULT_TERMS_DAYS = 30

type Row = Record<string, unknown>

interface TermsDb {
  findMany(entity: string, opts: Record<string, unknown>): Promise<unknown[]>
}

export interface PaymentTerms {
  days: number
  /** Whose terms these are. */
  from: "schedule" | "customer" | "issuer"
}

/** A whole number of days, 0 to 999, or null. */
export function termsDays(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= 999 ? n : null
}

/** The days a recurring schedule's own due rule gives. */
export function scheduleTermsDays(s: { due_rule?: unknown; due_days?: unknown }): number {
  if (s.due_rule === "on_issue") return 0
  if (s.due_rule === "days_n") return termsDays(s.due_days) ?? DEFAULT_TERMS_DAYS
  return DEFAULT_TERMS_DAYS
}

function refsOf(raw: unknown): Row {
  if (typeof raw === "string") {
    try {
      return (JSON.parse(raw) as Row) ?? {}
    } catch {
      return {}
    }
  }
  return raw && typeof raw === "object" ? (raw as Row) : {}
}

/** The payment terms an invoice without a due date of its own is issued under. */
export async function paymentTermsOf(
  db: TermsDb,
  draft: {
    issuer: { id: string; default_payment_terms_days?: unknown }
    contactId: string | null | undefined
    externalRefs?: unknown
  },
): Promise<PaymentTerms> {
  const own = termsDays(refsOf(draft.externalRefs).due_days)
  if (own !== null) return { days: own, from: "schedule" }
  if (draft.contactId) {
    const rows = (await db.findMany("counterparty_identities", {
      where: { contact_id: draft.contactId },
      limit: 1,
    })) as Row[]
    const customer = termsDays(rows[0]?.payment_terms_days)
    if (customer !== null) return { days: customer, from: "customer" }
  }
  let issuer = draft.issuer.default_payment_terms_days
  if (issuer === undefined) {
    const rows = (await db.findMany("issuer_profiles", {
      where: { id: draft.issuer.id },
      limit: 1,
    })) as Row[]
    issuer = rows[0]?.default_payment_terms_days
  }
  return { days: termsDays(issuer) ?? DEFAULT_TERMS_DAYS, from: "issuer" }
}

/** The due date of an invoice issued on `issuedOn` (its civil day) under `days` of terms. */
export function dueOn(issuedOn: string, days: number): string {
  return addDays(issuedOn.slice(0, 10), days)
}

/** The terms in words, for a card shown before the issue day is known. */
export function termsText(days: number): string {
  return days === 0 ? "on the day it is issued" : `${days} day${days === 1 ? "" : "s"} after issue`
}
