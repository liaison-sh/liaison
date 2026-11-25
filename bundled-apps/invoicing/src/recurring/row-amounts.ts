// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a month-end row will bill, worked out the way issuing it does: each line at its own rate, or
// at the document's rate when the line has none (a row added by hand). The card, the run's page, the
// totals a tool answers and the amount an approval records all read it here, so a row is never
// shown without a tax its invoice then carries.
import { checkBuyerVat } from "../buyer-vat"
import { storedTaxCountry, taxCountryOf } from "../issue"
import type { MutationsCtx } from "../mutations/shared"
import { netLinesTotals } from "../tax-plan"

type Row = Record<string, unknown>

export interface RowAmounts {
  net: bigint
  vat: bigint
  total: bigint
}

function refs(raw: unknown): Row {
  if (typeof raw === "string") {
    try {
      return (JSON.parse(raw) as Row) ?? {}
    } catch {
      return {}
    }
  }
  return raw && typeof raw === "object" ? (raw as Row) : {}
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

function taxCountry(draft: Row, issuerCountry: string): string {
  return taxCountryOf({
    country: text(draft.counterparty_country) ?? issuerCountry,
    tax_country: storedTaxCountry({ external_refs: refs(draft.external_refs) }),
  })
}

/** The amounts from the draft, its lines and its issuer alone. Pure: what the content hash covers. */
export function plannedAmounts(
  draft: Row,
  lines: Row[],
  issuer: Row | null | undefined,
  hasVatId = text(draft.counterparty_vat_id) !== null,
): RowAmounts {
  const country = String(issuer?.country ?? "")
  const plan = netLinesTotals({
    issuerCountry: country,
    taxCountry: taxCountry(draft, country),
    hasVatId,
    lines: lines.map((l) => ({
      quantity: l.quantity,
      unit_price_minor: l.unit_price_minor,
      discount_minor: l.discount_minor,
      ...(l.tax_rate_bp === null || l.tax_rate_bp === undefined
        ? {}
        : { tax_rate_bp_override: Number(l.tax_rate_bp) }),
    })),
  })
  return { net: plan.subtotal_minor, vat: plan.tax_minor, total: plan.total_minor }
}

/** The amounts issuing the row would write, with the buyer's VAT number the issue would find. */
export async function rowAmounts(
  ctx: Pick<MutationsCtx, "db">,
  draft: Row,
  lines: Row[],
  issuer: Row | null | undefined,
): Promise<RowAmounts> {
  const country = String(issuer?.country ?? "")
  const destination = taxCountry(draft, country)
  if (text(draft.counterparty_vat_id) === null && country && destination !== country) {
    const found = await checkBuyerVat(ctx as MutationsCtx, {
      issuerCountry: country,
      taxCountry: destination,
      counterparty: {
        contact_id: text(draft.counterparty_contact_id),
        legal_name: text(draft.counterparty_name),
        email: text(draft.counterparty_email),
        address: text(draft.counterparty_address),
        vat_id: null,
        customer_kind: text(draft.customer_kind),
      },
      buyerIsConsumer: refs(draft.external_refs).buyer_is_consumer === true,
      excludeDocumentId: String(draft.id),
    }).catch(() => null)
    if (found?.ok && found.facts.vat_id) return plannedAmounts(draft, lines, issuer, true)
  }
  return plannedAmounts(draft, lines, issuer)
}
