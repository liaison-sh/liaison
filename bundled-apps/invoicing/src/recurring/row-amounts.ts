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

function minorOf(v: unknown): bigint | null {
  if (typeof v === "bigint") return v
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v)
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim())
  return null
}

/**
 * The draft's stored totals, when they price the same net as its lines: the draft tools write them
 * with the issuer's tax plan on every change (mutations/db-helpers.ts, writeDraftTotals). Null when
 * they are missing or stale.
 */
function storedAmounts(draft: Row, planned: RowAmounts): RowAmounts | null {
  const net = minorOf(draft.subtotal_minor)
  const vat = minorOf(draft.tax_total_minor)
  const total = minorOf(draft.grand_total_minor)
  if (net === null || vat === null || total === null) return null
  if (net !== planned.net || net + vat !== total) return null
  return { net, vat, total }
}

/** The amounts issuing the row would write, with the buyer's VAT number the issue would find. */
export async function rowAmounts(
  ctx: Pick<MutationsCtx, "db">,
  draft: Row,
  lines: Row[],
  issuer: Row | null | undefined,
): Promise<RowAmounts> {
  // A reader whose role cannot read issuer profiles gets no issuer here. Pricing the lines without
  // it would drop the VAT of every line that takes the issuer's rate, so one draft would show two
  // totals (the card's and this reader's). The draft's stored totals were priced with the issuer:
  // they are the answer whenever they cover the same lines.
  if (!issuer) {
    const planned = plannedAmounts(draft, lines, issuer)
    return storedAmounts(draft, planned) ?? planned
  }
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
