// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Would the order-created auto-flow invoice this order, or park it?
//
// The Shopify app asks this (cross-app `invoicing:orders_invoiceability_check`) before it stages a
// draft order create or a draft order complete, so an order that could only end up parked
// (awaiting_data, no invoice) is refused while the agent can still supply what is missing, instead
// of becoming a real order nobody invoices. The rules live here, next to the auto-flow they predict
// (`onShopifyOrderPaid` in handlers/shopify-order-paid.ts), and reuse its own pieces: the issuer
// mapping lookup, the address formatting, the tax classifier and the exempt-treatment set, and the
// recipient completeness rule.
//
// Covered (knowable before the order exists, cheap): the buyer email the invoice is addressed to,
// the postal address the recipient needs, an intra-EU sale that charges no VAT without the buyer's
// VAT number, and (once Shopify computed the draft's tax) VAT charged on an exempt treatment.
// Not covered: the issuer's own configuration (tax regime, time zone), Shopify's per-line tax
// reproduction, and the French e-invoicing identity of the buyer (registry lookups); those are
// settings or post-order facts, not something the order's author can fix on the draft.

import {
  findIssuerByShopId,
  formatEventAddress,
} from "./handlers/shopify-order-paid"
import { counterpartyCompletenessError } from "./issue"
import { EXEMPT_TREATMENTS, classify, isUntaxedIntraEuSaleWithoutVat } from "./tax"

/** A postal address as the Shopify app reports it (snake_case country code). */
export interface ProspectiveOrderAddress {
  name?: string | null
  company?: string | null
  address1?: string | null
  address2?: string | null
  zip?: string | null
  city?: string | null
  province?: string | null
  country_code?: string | null
}

/** What the order WILL carry once it exists, as the Shopify app knows it at staging time. */
export interface ProspectiveOrderFacts {
  /** The shop domain the auto-flow maps to an issuer profile (`issuer_profiles.shopify_shop_id`). */
  shop_id?: string | null
  /** "create" (a draft not made yet) or "complete" (an existing draft turning into an order). */
  stage?: string | null
  draft_order_id?: string | null
  /** The linked Shopify customer gid, when there is one. */
  customer_id?: string | null
  /** The email the order's CUSTOMER record will carry (the linked customer's own, else the draft's). */
  email?: string | null
  /** The buyer's display name (first + last name). */
  legal_name?: string | null
  billing_address?: ProspectiveOrderAddress | null
  shipping_address?: ProspectiveOrderAddress | null
  /** The linked customer's default address (the auto-flow's enrichment falls back to it). */
  customer_default_address?: ProspectiveOrderAddress | null
  /** The buyer's VAT number as the order will carry it (a VAT custom attribute). */
  vat_id?: string | null
  /** True when the draft or its customer is tax exempt: Shopify will charge no tax. */
  tax_exempt?: boolean | null
  /** Order total in major units; null or absent when not known yet. */
  total_price?: string | number | null
  /** Tax Shopify computed for the draft, major units; null or absent when not computed yet. */
  total_tax?: string | number | null
}

export interface InvoiceabilityProblem {
  /** The auto-flow park reason this predicts (or the closest one). */
  reason: string
  /** What is missing or wrong, for the caller to fix. */
  field: string
  message: string
}

export interface InvoiceabilityResult {
  /** False when no issuer profile is mapped to this shop: the auto-flow does not invoice it. */
  applies: boolean
  issuer_profile_id?: string
  problems: InvoiceabilityProblem[]
  /** One sentence per problem, ready to show to whoever asked. Absent when there is none. */
  message?: string
}

const blank = (v: unknown): boolean => typeof v !== "string" || v.trim() === ""
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)
const upper = (v: unknown): string | null => str(v)?.toUpperCase() ?? null

function amount(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v !== "string" || v.trim() === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * The problems that would make the auto-flow park this order, in the auto-flow's own order.
 * PURE: the issuer is passed in. An order with a zero total has none (the auto-flow skips it).
 */
export function invoiceabilityProblems(
  facts: ProspectiveOrderFacts,
  issuer: { country: string | null | undefined },
): InvoiceabilityProblem[] {
  const total = amount(facts.total_price)
  if (total === 0) return []
  const problems: InvoiceabilityProblem[] = []
  const customerId = str(facts.customer_id)
  const email = str(facts.email)

  if (!email) {
    problems.push({
      reason: "customer_email_missing",
      field: "email",
      message: customerId
        ? `the Shopify customer ${customerId} has no email, and Invoicing addresses the invoice to the ` +
          "customer record (an email on the draft order alone is not used): add it with " +
          "shopify customers_update {id, email}, then try again"
        : "the order has no buyer email: pass input.email, or link a Shopify customer that has an email " +
          "(purchasingEntity.customerId)",
    })
  }

  // The same address and country derivation as adaptShopifyOrderCreatedEvent + mergeCustomer.
  const billing = facts.billing_address ?? null
  const shipping = facts.shipping_address ?? null
  const fallback = facts.customer_default_address ?? null
  const address =
    formatEventAddress(billing ?? shipping) ?? formatEventAddress(shipping ?? fallback) ?? null
  const customerCountry =
    upper(shipping?.country_code) ?? upper(fallback?.country_code) ?? upper(billing?.country_code)
  const billingCountry =
    (billing ? upper(billing.country_code) : upper(shipping?.country_code)) ?? customerCountry
  const taxCountry = upper(shipping?.country_code) ?? customerCountry ?? billingCountry
  const counterpartyCountry = taxCountry ?? billingCountry ?? issuer.country ?? null

  const recipientGap = counterpartyCompletenessError({
    legal_name: str(facts.legal_name) ?? email ?? "",
    country: billingCountry ?? counterpartyCountry ?? "",
    address,
    // The email gap is reported on its own above.
    email: email ?? "-",
  })
  if (recipientGap && blank(address)) {
    problems.push({
      reason: "counterparty_incomplete",
      field: "address",
      message:
        "the invoice needs the buyer's postal address and the order has none: set billingAddress " +
        "(or shippingAddress) on the draft order, or useCustomerDefaultAddress: true with a customer " +
        "that has a saved address",
    })
  }

  const vatId = str(facts.vat_id)
  const classification = classify({
    issuer_country: issuer.country,
    counterparty_country: counterpartyCountry,
    has_vat_id: vatId != null,
  })
  const tax = amount(facts.total_tax)
  const chargesNoTax = facts.tax_exempt === true || (tax != null && tax === 0 && total !== 0)
  // The auto-flow classifies this as a consumer sale (OSS) with no tax and parks it for review
  // (buyer_vat_missing, or tax_rate_placeholder when Shopify reported no rate): neither is the
  // reverse charge invoice a business buyer needs.
  if (isUntaxedIntraEuSaleWithoutVat(classification.treatment, chargesNoTax)) {
    problems.push({
      reason: "buyer_vat_missing",
      field: "vat_id",
      message:
        `the buyer is in ${counterpartyCountry}, another EU member state, and the order charges no VAT` +
        `${facts.tax_exempt === true ? " (it is tax exempt)" : ""}. Invoicing invoices that as a ` +
        "reverse charge only with the buyer's VAT number, otherwise it parks the order. For a " +
        "business buyer add its VAT number to the draft order as a custom attribute, " +
        'customAttributes: [{key: "VAT number", value: "<number>"}] (draft_orders_update for an ' +
        "existing draft, order_update customAttributes once it is an order; check it with invoicing " +
        "vat_validate). For a consumer, remove the tax " +
        `exemption so Shopify charges ${counterpartyCountry} VAT`,
    })
  }
  if (EXEMPT_TREATMENTS.has(classification.treatment) && facts.tax_exempt !== true && tax != null && tax > 0) {
    problems.push({
      reason: "tax_on_exempt_treatment",
      field: "tax_exempt",
      message:
        `the sale is ${classification.treatment === "eu_reverse_charge" ? "a reverse charge (the buyer has a VAT number)" : "an export"}, ` +
        `so the invoice carries no VAT, but the draft order charges ${String(facts.total_tax)} of tax: ` +
        "set taxExempt: true on the draft order (draft_orders_update) so Shopify charges none, or " +
        "remove the VAT number if the buyer is not a business",
    })
  }
  return problems
}

/** `invoicing:orders_invoiceability_check`: read only. */
export async function ordersInvoiceabilityCheck(
  ctx: { db: Parameters<typeof findIssuerByShopId>[0] },
  input: ProspectiveOrderFacts,
): Promise<InvoiceabilityResult> {
  const shopId = str(input?.shop_id)
  if (!shopId) return { applies: false, problems: [] }
  const issuer = await findIssuerByShopId(ctx.db, shopId)
  if (!issuer) return { applies: false, problems: [] }
  const problems = invoiceabilityProblems(input, issuer)
  return {
    applies: true,
    issuer_profile_id: issuer.id,
    problems,
    ...(problems.length > 0
      ? {
          message:
            "Invoicing would not invoice this order (it would wait in the deferred list): " +
            problems.map((p, i) => `(${i + 1}) ${p.message}`).join("; ") +
            ". Fix it, then call the tool again: nothing was done.",
        }
      : {}),
  }
}
