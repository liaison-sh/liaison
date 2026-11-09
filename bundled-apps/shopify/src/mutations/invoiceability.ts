// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoiceability guard for draft order create and complete.
//
// With Invoicing installed and mapped to this shop, every completed draft order becomes an order
// that Invoicing's order-created auto-flow invoices. An order missing what that flow needs (the
// customer's email, a postal address, the VAT number of an intra-EU business buyer) is parked
// there and never invoiced. So before a draft order is created or completed, this asks Invoicing
// (`invoicing:orders_invoiceability_check`, which owns the rules) whether the order would be
// invoiced, with the facts the order will carry, and refuses with Invoicing's own message when it
// would not. Without Invoicing (not installed, not mapped to this shop, or unreachable) nothing
// changes: Shopify is useful on its own.

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient, resolveInstallMetadata } from "../lib/get-client"
import { buyerTaxIdFromNoteAttributes } from "../webhooks"
import { isUsableEmail } from "./draft-order-input"
import { isRec, makeMutationError } from "./shared"

type CrossAppEnvelope =
  | { status: "completed"; result: unknown }
  | { status: "pending_approval"; approval_id: string }
  | { status: "error"; error: { code: string; message: string } }

type CrossAppCtx = AppContext & {
  executeTool?: (target: string, args: Record<string, unknown>) => Promise<CrossAppEnvelope>
}

export const INVOICEABILITY_CHECK_TOOL = "invoicing:orders_invoiceability_check"

interface FactsAddress {
  name: string | null
  company: string | null
  address1: string | null
  address2: string | null
  zip: string | null
  city: string | null
  province: string | null
  country_code: string | null
}

/** The facts `invoicing:orders_invoiceability_check` takes (shop_id is added by the guard). */
export interface InvoiceabilityFacts {
  stage: "create" | "complete"
  draft_order_id: string | null
  customer_id: string | null
  email: string | null
  legal_name: string | null
  billing_address: FactsAddress | null
  shipping_address: FactsAddress | null
  customer_default_address: FactsAddress | null
  vat_id: string | null
  tax_exempt: boolean
  total_price: string | null
  total_tax: string | null
}

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)

/** A MailingAddressInput (countryCode) or a GraphQL MailingAddress (countryCodeV2). */
function toFactsAddress(a: unknown): FactsAddress | null {
  if (!isRec(a)) return null
  const name = s(a.name) ?? ([s(a.firstName), s(a.lastName)].filter(Boolean).join(" ") || null)
  return {
    name,
    company: s(a.company),
    address1: s(a.address1),
    address2: s(a.address2),
    zip: s(a.zip),
    city: s(a.city),
    province: s(a.province),
    country_code: (s(a.countryCodeV2) ?? s(a.countryCode))?.toUpperCase() ?? null,
  }
}

/** The VAT number the order will carry: a draft's custom attributes become the order's. */
function vatFromAttributes(attrs: unknown): string | null {
  if (!Array.isArray(attrs)) return null
  return buyerTaxIdFromNoteAttributes(
    attrs.filter(isRec).map((a) => ({
      name: typeof a.key === "string" ? a.key : typeof a.name === "string" ? a.name : null,
      value: typeof a.value === "string" ? a.value : null,
    })),
  )
}

interface CustomerNode {
  id?: string | null
  email?: string | null
  firstName?: string | null
  lastName?: string | null
  taxExempt?: boolean | null
  defaultAddress?: Record<string, unknown> | null
}

const ADDRESS_FIELDS = "name company address1 address2 zip city province countryCodeV2"
const CUSTOMER_FIELDS = `id email firstName lastName taxExempt defaultAddress { ${ADDRESS_FIELDS} }`

const customerName = (c: CustomerNode | null | undefined): string | null =>
  [s(c?.firstName), s(c?.lastName)].filter(Boolean).join(" ") || null

/** True only when the input itself makes the order free (the auto-flow skips a zero total). */
function obviouslyFree(input: Record<string, unknown>): boolean {
  const full = (d: unknown): boolean =>
    isRec(d) && d.valueType === "PERCENTAGE" && Number(d.value) >= 100
  if (full(input.appliedDiscount)) return true
  const lines = Array.isArray(input.lineItems) ? input.lineItems.filter(isRec) : []
  if (lines.length === 0) return false
  return lines.every((l) => {
    if (full(l.appliedDiscount)) return true
    const custom = l.originalUnitPriceWithCurrency
    return l.variantId == null && isRec(custom) && Number(custom.amount) === 0
  })
}

/** Facts for a draft about to be created, from its NORMALISED input plus its customer record. */
export async function invoiceabilityFactsForCreate(
  input: Record<string, unknown>,
  ctx: AppContext,
): Promise<InvoiceabilityFacts> {
  const customerId =
    isRec(input.purchasingEntity) && typeof input.purchasingEntity.customerId === "string"
      ? input.purchasingEntity.customerId
      : null
  let customer: CustomerNode | null = null
  if (customerId) {
    const client = await getShopifyClient(ctx)
    const data = await client.query<{ customer?: CustomerNode | null }>(
      `query InvoiceabilityCustomer($id: ID!) { customer(id: $id) { ${CUSTOMER_FIELDS} } }`,
      { id: customerId },
    )
    customer = data.customer ?? null
  }
  const defaultAddress = toFactsAddress(customer?.defaultAddress)
  const useDefault = input.useCustomerDefaultAddress === true
  const billing = toFactsAddress(input.billingAddress) ?? (useDefault ? defaultAddress : null)
  const shipping = toFactsAddress(input.shippingAddress) ?? (useDefault ? defaultAddress : null)
  return {
    stage: "create",
    draft_order_id: null,
    customer_id: customerId,
    // A linked customer's OWN record is what the order's customer carries; an unlinked draft's
    // email becomes its customer's.
    email: customerId ? s(customer?.email) : isUsableEmail(input.email) ? s(input.email) : null,
    legal_name: customerName(customer) ?? billing?.name ?? shipping?.name ?? null,
    billing_address: billing,
    shipping_address: shipping,
    customer_default_address: defaultAddress,
    vat_id: vatFromAttributes(input.customAttributes),
    tax_exempt: input.taxExempt === true || customer?.taxExempt === true,
    total_price: obviouslyFree(input) ? "0" : null,
    total_tax: null,
  }
}

const DRAFT_ORDER_INVOICEABILITY_QUERY = `
  query DraftOrderInvoiceability($id: ID!) {
    draftOrder(id: $id) {
      id email taxExempt
      totalPriceSet { presentmentMoney { amount } }
      totalTaxSet { presentmentMoney { amount } }
      customAttributes { key value }
      billingAddress { ${ADDRESS_FIELDS} }
      shippingAddress { ${ADDRESS_FIELDS} }
      customer { ${CUSTOMER_FIELDS} }
    }
  }
`

interface DraftOrderNode {
  id?: string
  email?: string | null
  taxExempt?: boolean | null
  totalPriceSet?: { presentmentMoney?: { amount?: string | null } | null } | null
  totalTaxSet?: { presentmentMoney?: { amount?: string | null } | null } | null
  customAttributes?: Array<{ key?: string | null; value?: string | null }> | null
  billingAddress?: Record<string, unknown> | null
  shippingAddress?: Record<string, unknown> | null
  customer?: CustomerNode | null
}

/** Facts for an existing draft about to be completed, read from Shopify. Null when it does not
 *  resolve (the completion itself then fails on Shopify's own error). */
export async function invoiceabilityFactsForDraft(
  draftOrderId: string,
  ctx: AppContext,
): Promise<InvoiceabilityFacts | null> {
  const client = await getShopifyClient(ctx)
  const data = await client.query<{ draftOrder?: DraftOrderNode | null }>(DRAFT_ORDER_INVOICEABILITY_QUERY, {
    id: draftOrderId,
  })
  const d = data.draftOrder
  if (!d) return null
  const customer = d.customer ?? null
  const billing = toFactsAddress(d.billingAddress)
  const shipping = toFactsAddress(d.shippingAddress)
  return {
    stage: "complete",
    draft_order_id: draftOrderId,
    customer_id: s(customer?.id),
    email: customer ? s(customer.email) : s(d.email),
    legal_name: customerName(customer) ?? billing?.name ?? shipping?.name ?? null,
    billing_address: billing,
    shipping_address: shipping,
    customer_default_address: toFactsAddress(customer?.defaultAddress),
    vat_id: vatFromAttributes(d.customAttributes),
    tax_exempt: d.taxExempt === true || customer?.taxExempt === true,
    total_price: s(d.totalPriceSet?.presentmentMoney?.amount),
    total_tax: s(d.totalTaxSet?.presentmentMoney?.amount),
  }
}

/**
 * Refuse (throw NOT_INVOICEABLE) when Invoicing says the order would not be invoiced. Returns
 * quietly when Invoicing does not apply: no cross-app dispatch, no shop domain, Invoicing absent
 * or not mapped to this shop, or the check itself unreachable.
 */
export async function assertDraftOrderInvoiceable(
  ctx: AppContext,
  buildFacts: () => Promise<InvoiceabilityFacts | null>,
): Promise<void> {
  const executeTool = (ctx as CrossAppCtx).executeTool
  if (typeof executeTool !== "function") return
  const meta = await resolveInstallMetadata(ctx).catch(() => null)
  const shopId = s(meta?.shopDomain)
  if (!shopId) return
  let facts: InvoiceabilityFacts | null
  try {
    facts = await buildFacts()
  } catch (err) {
    // A failed Shopify read is not a verdict: the mutation itself reports a real problem. Said in
    // the log, so a guard that stopped reading is seen.
    ctx.logger?.warn?.(
      `[shopify] invoiceability check skipped: ${err instanceof Error ? err.message : String(err)}`,
    )
    return
  }
  if (!facts) return
  let env: CrossAppEnvelope
  try {
    env = await executeTool.call(ctx, INVOICEABILITY_CHECK_TOOL, { shop_id: shopId, ...facts })
  } catch {
    return
  }
  if (env?.status !== "completed") return
  const result = env.result as
    | { applies?: boolean; problems?: Array<{ reason?: string; message?: string }>; message?: string }
    | null
    | undefined
  const problems = Array.isArray(result?.problems) ? result.problems : []
  if (result?.applies !== true || problems.length === 0) return
  const verb = facts.stage === "complete" ? "complete this draft order" : "create this draft order"
  throw makeMutationError(
    "NOT_INVOICEABLE",
    `Refusing to ${verb}: ` +
      (result.message ??
        `Invoicing would not invoice the order: ${problems.map((p) => p.message ?? p.reason).join("; ")}.`),
    400,
  )
}
