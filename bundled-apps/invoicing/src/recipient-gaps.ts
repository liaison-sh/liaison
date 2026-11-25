// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What an invoice's customer lacks for the invoice to issue, checked before anything is drafted:
// the planned vs done card's preview and the Create that follows it ask the same question the
// issue asks, so a customer missing an address, an email or a SIREN is named up front.

import { prepareEinvoiceGate } from "./einvoicing/issue-gate"
import { counterpartyFromRow } from "./mutations/lines"
import type { Recipient } from "./recipient"

/** A field the customer lacks. */
export type RecipientGap = "billing_address" | "email" | "siren"

/** The refusal of a Create whose customer lacks a field: its code, then the sentence. */
export const RECIPIENT_GAP_REFUSAL: Record<RecipientGap, [string, string]> = {
  billing_address: [
    "billing_address_missing",
    "the customer has no billing address, so no draft was made. Add it to the customer, then press Create invoice again.",
  ],
  email: [
    "customer_email_missing",
    "the customer has no email address, so no draft was made. Add it to the customer, then press Create invoice again.",
  ],
  siren: [
    "siren_missing",
    "the customer has no SIREN, so no draft was made. Add it to the customer, then press Create invoice again.",
  ],
}

const blank = (v: unknown) => typeof v !== "string" || v.trim() === ""

/**
 * What the customer lacks for its invoice to issue, checked as the issue checks it: a postal
 * address and an email on the recipient, and what the e-invoice gate refuses without (a French
 * business's SIREN, its structured billing address). Read only.
 */
export async function recipientGaps(
  ctx: unknown,
  issuer: { country: string; vat_id?: string | null; vat_on_debits_default?: boolean | null },
  contactId: string | null,
  recipient: Recipient,
): Promise<RecipientGap[]> {
  const gaps = new Set<RecipientGap>()
  if (blank(recipient.counterparty_address) || blank(recipient.counterparty_country))
    gaps.add("billing_address")
  if (blank(recipient.counterparty_email)) gaps.add("email")
  const counterparty = counterpartyFromRow(
    {
      counterparty_contact_id: contactId,
      counterparty_name: recipient.counterparty_name,
      counterparty_address: recipient.counterparty_address,
      counterparty_country: recipient.counterparty_country,
      counterparty_vat_id: recipient.counterparty_vat_id,
      counterparty_email: recipient.counterparty_email,
    },
    issuer,
  )
  const kinds = ["business", "individual", "public_entity", "non_registered_entity"] as const
  const kind = kinds.find((k) => k === recipient.customer_kind) ?? null
  const prepared = await prepareEinvoiceGate(
    ctx as never,
    {
      type: "invoice",
      issuer: {
        country: issuer.country,
        vat_id: issuer.vat_id ?? null,
        vat_on_debits_default: issuer.vat_on_debits_default ?? null,
      },
      counterparty: {
        ...counterparty,
        customer_kind: kind,
        billing_line1: recipient.billing_line1,
        billing_line2: recipient.billing_line2,
        billing_postcode: recipient.billing_postcode,
        billing_city: recipient.billing_city,
        billing_country_code: recipient.billing_country_code,
      },
      lines: [{ line_kind: "service" }],
      operation_category: "services",
    },
    { materialise: false },
  )
  const refusal = prepared.evaluation.refusal
  if (refusal && refusal.mode === "enforce") {
    for (const m of refusal.missing) {
      if (m.field.startsWith("buyer_sir")) gaps.add("siren")
      else if (m.field.startsWith("billing_")) gaps.add("billing_address")
    }
  }
  return [...gaps]
}
