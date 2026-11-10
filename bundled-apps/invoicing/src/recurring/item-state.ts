// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Whether a month-end row can be approved as it stands: `ready`, or `needs_fix` with the reason a
// person reads on the row. One function, from facts already on the draft (who it bills, where, and
// its total), so the card's "Approve N" counts exactly the rows shown as ready.
import { draftTotals, type Row } from "./run-card"

export type RunItemState = { state: "ready" } | { state: "needs_fix"; reason: string; credit_note?: true }

export const NOTHING_TO_BILL = "Nothing to bill"
export const NEGATIVE_TOTAL = "A negative total is a credit note"
export const NO_ADDRESS = "No billing address"
export const NO_CUSTOMER = "No customer"
export const NO_EMAIL = "No customer email"
export const NO_COUNTRY = "No customer country"

function blank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === ""
}

export function runItemState(draft: Row, lines: Row[]): RunItemState {
  if (blank(draft.counterparty_name)) return { state: "needs_fix", reason: NO_CUSTOMER }
  if (blank(draft.counterparty_address) && blank(draft.billing_line1)) return { state: "needs_fix", reason: NO_ADDRESS }
  // What issuing requires of the recipient (an issued invoice is a legal record).
  if (blank(draft.counterparty_email)) return { state: "needs_fix", reason: NO_EMAIL }
  if (blank(draft.counterparty_country) && blank(draft.billing_country_code)) return { state: "needs_fix", reason: NO_COUNTRY }
  const { total } = draftTotals(lines)
  if (lines.length === 0 || total === 0n) return { state: "needs_fix", reason: NOTHING_TO_BILL }
  if (total < 0n) return { state: "needs_fix", reason: NEGATIVE_TOTAL, credit_note: true }
  return { state: "ready" }
}

/** The reasons `runItemState` writes into a row's note, so a fixed row loses them. */
export const STATE_REASONS = [NOTHING_TO_BILL, NEGATIVE_TOTAL, NO_ADDRESS, NO_CUSTOMER, NO_EMAIL, NO_COUNTRY]
